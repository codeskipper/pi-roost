# Credential brokering for pi

`docs/COMPARISON.md` lists the model provider token as the one credential this
kit cannot keep out of the VM, because pi needs it in-process. That conclusion
is now out of date: credential-brokering proxies for AI agents have become a
real category, and pi has the hooks to use them.

This page surveys the options, records how pi integrates, and gives a spike
plan to test whether it actually works end to end.

**Status: researched, not adopted.** Nothing here is implemented by the kit.

## How brokering works

The agent never holds the credential. It sends a request with a placeholder or
a capability token; a proxy the agent cannot read substitutes the real secret
and forwards the request. A compromised agent can *use* the access while it is
running, but cannot exfiltrate anything reusable.

This is the same mechanism Docker Sandboxes uses, where the sandbox "sees only
a sentinel value".

## pi's integration points

Both styles work with stock pi \u2014 no pi-specific tooling required.

**Forward proxy** (`settings.md`, `environment-variables.md`):

```json
{ "httpProxy": "http://192.168.64.1:14322" }
```

> `httpProxy` \u2014 "HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`.
> Global setting only."

**Gateway redirection** (`custom-provider.md`) \u2014 point a provider at a gateway
that holds the real key:

```js
{ baseUrl: "https://ai-gateway.corp.com/google", headers: { ... } }
```

## Options

| Project | Pattern | Fit here |
|---|---|---|
| [Infisical Agent Vault](https://github.com/Infisical/agent-vault) | MITM forward proxy; substitutes `__anthropic_api_key__` placeholders or rewrites auth headers | **best fit** |
| [dtkav/agent-creds](https://github.com/dtkav/agent-creds) | Envoy + Vault, macaroon capability tokens | ships `agents/pi.toml`, but **Linux-only sandbox runtimes** |
| [LiteLLM AI Gateway](https://docs.litellm.ai/docs/proxy/virtual_keys) | virtual keys; gateway holds the provider key | good for LLM traffic only |
| paude-proxy, clavitor, comis | credential-injecting HTTPS proxies | same pattern, smaller |
| sesame, crebro, phantom-secrets | wrapper / reference substitution | less transparent |
| CyberArk Secretless Broker | the enterprise original | heavyweight |

`agent-creds` deserves a note: it supports pi as a first-class agent
(`agent = "claude"  # "codex" or "pi" also work`). But it sandboxes with
`bwrap`/gVisor/runc, which "currently targets Linux", so it cannot be used with
a macOS guest. Worth watching.

## Why Agent Vault fits this kit

Its deployment model matches the host/VM split already in place:

> "By design, Agent Vault is meant to be deployed on a separate machine from
> your AI agents so your AI agents cannot directly access the credentials
> within Agent Vault."

```
Host Mac                              Tart VM
\u251c\u2500 1Password  (SSH key)                \u251c\u2500 pi
\u251c\u2500 gh         (OAuth token)            \u2502   httpProxy -> host:14322
\u2514\u2500 Agent Vault :14321 UI/API           \u2514\u2500 no provider token on disk
               :14322 MITM proxy
               holds provider key, GITHUB_PAT
```

It would close three of the four gaps in `COMPARISON.md`:

| Gap | Agent Vault |
|---|---|
| Provider token plaintext in VM | closed \u2014 brokered |
| No egress control | closed \u2014 egress filtering, `unmatched_host_policy=deny` |
| No runtime observability | closed \u2014 request logging |
| Not ephemeral | unchanged |

## Caveats to settle before adopting

1. **MITM requires trusting a CA in the VM.** You install a root certificate
   that can decrypt all TLS from the guest. That is the mechanism, not a flaw,
   but it is a real trust decision and it raises the value of the host as a
   target.
2. **pi's Copilot auth may not broker cleanly.** Brokering fits static keys.
   pi's `github-copilot` provider stores a `ghu_` refresh token and exchanges
   it at `api.github.com/copilot_internal/v2/token` for a short-lived `tid=`
   token that it then writes to `auth.json`. Best case the durable `ghu_` stays
   on the host and only the expiring token lands in the VM. **This is the open
   question the spike exists to answer.** A direct API-key provider would
   broker trivially.
3. **Young project.** Infisical steers production users to the commercial
   version; the OSS binary is the self-contained one.

---

# Spike plan

Timeboxed test to answer one question: **can pi in the VM work with no provider
credential on its disk?**

Run phases in order. Each has an explicit pass condition. Stop at the first
failure and record it \u2014 a negative result is a valid outcome.

> **Before starting:** pi runs in this VM. If you break its auth mid-spike you
> lose the agent until you restore. Phase 0 backs it up; keep a second terminal
> open.

## Phase 0 \u2014 Baseline and backup

In the VM:

```bash
cp ~/.pi/agent/auth.json ~/.pi/agent/auth.json.prespike
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.prespike
python3 -c "import json;d=json.load(open('$HOME/.pi/agent/auth.json'));print(list(d.keys()))"
ipconfig getifaddr en0           # VM address
netstat -rn | awk '/^default/{print $2; exit}'   # host address, e.g. 192.168.64.1
```

**Pass:** you have backups and know the host IP from inside the VM.

## Phase 1 \u2014 Install Agent Vault on the host

On the **host Mac** (never in the VM \u2014 that would defeat the point):

```bash
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://get.agent-vault.dev | sh
agent-vault server          # set a master password when prompted
```

Confirm it listens on an interface the VM can reach, not just `127.0.0.1`.
Check the server flags for a bind address; the VM cannot reach host loopback.

```bash
lsof -nP -iTCP:14322 -sTCP:LISTEN
```

**Pass:** port 14322 is listening on `0.0.0.0` or the `192.168.64.1` interface.

## Phase 2 \u2014 Prove plain proxying works

From the **VM**, with no credentials involved:

```bash
curl -x http://192.168.64.1:14322 -sS -o /dev/null -w '%{http_code}\n' http://example.com
```

**Pass:** `200`. **Fail:** connection refused means a bind-address or firewall
problem \u2014 fix before continuing.

## Phase 3 \u2014 Install the CA and prove HTTPS interception

Export the CA on the host (`agent-vault ca`), copy it to the VM, then:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/agent-vault-ca.pem
curl -x http://192.168.64.1:14322 -sS https://example.com -o /dev/null -w '%{http_code}\n'
```

**Pass:** `200` with no TLS error. **Record this**: you have now added a root CA
to the VM, which Phase 7 must undo if you abandon the spike.

## Phase 4 \u2014 Prove credential injection, outside pi

Store a throwaway credential in Agent Vault \u2014 use a GitHub PAT with no scopes,
not your real token \u2014 and define a service for `api.github.com`. Then from the
VM:

```bash
curl -x http://192.168.64.1:14322 -sS https://api.github.com/user \
  -H "Authorization: Bearer __github_token__"
```

**Pass:** a real API response, while the VM only ever sent the placeholder.
This proves the whole mechanism independently of pi. If it fails, the problem
is Agent Vault configuration, not pi.

## Phase 5 \u2014 Point pi at the proxy, credentials unchanged

In the VM, edit `~/.pi/agent/settings.json`:

```json
{ "httpProxy": "http://192.168.64.1:14322" }
```

Start pi and send one trivial prompt.

**Pass:** pi works normally. This isolates CA/TLS problems from brokering
problems \u2014 the token is still local, so only transport changed.
**Fail:** pi cannot reach the provider through the proxy; capture the error and
stop. Brokering cannot work if transport does not.

## Phase 6 \u2014 The decisive test: remove the credential

Put the real provider credential into Agent Vault on the host. Then in the VM:

```bash
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home()/'.pi/agent/auth.json'
d = json.loads(p.read_text())
d['github-copilot']['refresh'] = '__copilot_refresh_token__'
d['github-copilot']['access']  = ''
d['github-copilot']['expires'] = 0
p.write_text(json.dumps(d, indent=1))
EOF
```

Restart pi and send a prompt.

**Pass:** pi works with no real credential on the VM disk. Brokering is viable;
the gap in `COMPARISON.md` can be closed.

**Partial:** pi re-authenticates and writes a fresh `tid=` token to
`auth.json`, but the durable `ghu_` never appears. Still a win \u2014 the permanent
credential stays on the host and only a ~24h token lands in the VM. Record
exactly what ends up in `auth.json`.

**Fail:** pi cannot start the Copilot exchange through a placeholder. Expected
outcome for caveat 2. Fall back to testing a direct API-key provider
(Anthropic/OpenAI) with a dummy key, which should broker cleanly.

## Phase 7 \u2014 Verify the negative, then decide

Prove the VM genuinely cannot obtain the secret:

```bash
grep -rIoE '\b(sk-|gho_|ghu_)[A-Za-z0-9_-]{16,}' ~/.pi ~/.config 2>/dev/null || echo "no real tokens in VM"
curl -x http://192.168.64.1:14322 -sS https://example.org -o /dev/null -w '%{http_code}\n'   # egress policy
```

Then set `unmatched_host_policy=deny` and confirm unlisted hosts return 403.

**Rollback if abandoning:**

```bash
cp ~/.pi/agent/auth.json.prespike ~/.pi/agent/auth.json
cp ~/.pi/agent/settings.json.prespike ~/.pi/agent/settings.json
sudo security delete-certificate -c "Agent Vault" /Library/Keychains/System.keychain
```

The CA removal matters most \u2014 leaving a trusted MITM root in the VM for an
abandoned experiment is worse than the problem you set out to fix.

## Recording the result

Whatever happens, append the outcome of Phase 6 to this file. The open question
is narrow and factual, and the answer determines whether the kit grows a
`--broker` path or keeps documenting the provider token as residual risk.
