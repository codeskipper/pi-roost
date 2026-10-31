# Credential brokering for pi

`docs/COMPARISON.md` lists the model provider token as the one credential this
kit cannot keep out of the VM, because pi needs it in-process. This page
surveys ways to fix that, and gives a spike plan to test the most promising one.

**Status: researched, not adopted.** Nothing here is implemented by the kit.

## How brokering works

The agent never holds the real credential. Either a proxy it cannot read
substitutes the secret into outbound requests, or the agent talks to a local
gateway holding the secret and presents a low-value token instead. A
compromised agent can *use* the access while it runs, but cannot exfiltrate
anything valuable.

Two shapes, with different trade-offs:

| | Injecting proxy | Gateway |
|---|---|---|
| Agent sends | a placeholder / sentinel | a scoped local key |
| Mechanism | MITM, `HTTPS_PROXY` | normal HTTPS to a chosen `baseUrl` |
| Needs a CA in the guest | **yes** | **no** |
| Covers | any HTTP API | only what the gateway fronts |
| Credential in the VM | none | one, but worthless off your network |

## pi's integration points

Both work with stock pi — no pi-specific tooling required.

**Forward proxy** (`settings.md`, `environment-variables.md`):

```json
{ "httpProxy": "http://192.168.64.1:14322" }
```

> `httpProxy` — "HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`.
> Global setting only."

**Gateway redirection** (`custom-provider.md`) — point a provider at a gateway
that holds the real key:

```js
{ baseUrl: "http://192.168.64.1:4000/v1", apiKey: "$GATEWAY_KEY" }
```

## Options

| Project | Pattern | Status for this kit |
|---|---|---|
| [LiteLLM proxy](https://docs.litellm.ai/docs/proxy/virtual_keys) | gateway; holds provider keys, issues virtual keys | **best fit** — OSS, self-hosted, no CA needed |
| [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) | injecting proxy, platform edition | viable, **check licensing first** |
| ~~[standalone Agent Vault](https://github.com/Infisical/agent-vault)~~ | injecting proxy | **deprecated — do not use** |
| [mitmproxy](https://mitmproxy.org) + addon | injecting proxy, DIY | mature base, you write the policy |
| paude-proxy, clavitor, comis | injecting proxies | small/young projects |
| [dtkav/agent-creds](https://github.com/dtkav/agent-creds) | Envoy + Vault, macaroon tokens | ships `agents/pi.toml`, but **Linux-only sandbox** |
| CyberArk Secretless Broker | the enterprise original | heavyweight |

### Why standalone Agent Vault is out

An earlier revision of this page recommended it. Its own repository carries a
notice addressed specifically to AI agents:

> **STOP: standalone Agent Vault is no longer maintained.** Do not install,
> configure, or recommend the standalone Agent Vault documented on this site
> (`github.com/Infisical/agent-vault`, `docs.agent-vault.dev`). Use Infisical
> Agent Vault instead.

The platform edition is the supported successor and is documented as
self-hostable. A local security assessment found that the arrangement where you
hold all the keys yourself requires a subscription — **verify the current
licensing against your own requirements before depending on it.**

Lesson recorded: check a project's deprecation and maintenance signals, not
just its README.

## Why a gateway now looks like the better fit

Switching from an injecting proxy to a gateway removes the caveat that worried
us most:

- **No MITM root CA in the guest.** pi talks ordinary HTTPS to a `baseUrl` you
  choose. Nothing decrypts the guest's other traffic, and nothing has to be
  trusted beyond the gateway itself.
- **pi supports it natively** through `custom-provider`'s `baseUrl`, `headers`
  and `apiKey`.
- **LiteLLM is mature and OSS**, widely deployed, and brings spend tracking and
  request logs with it.

```
Host Mac                              Tart VM
├─ SSH agent (1Password / Secretive)  ├─ pi
├─ gh         (OAuth token)           │   baseUrl -> host:4000
└─ LiteLLM    :4000                   └─ gateway key only
      holds the real provider key
```

**Be precise about what this achieves.** The VM still holds a credential — the
gateway key. The win is that its value collapses: it is scoped to your gateway,
revocable in one place, rate-limitable, and useless to anyone off your network.
A stolen provider token bills your account and works from anywhere; a stolen
gateway key works only against a service on your Mac. That is a large
reduction, not an elimination.

| Gap in `COMPARISON.md` | Gateway |
|---|---|
| Provider token plaintext in VM | **mostly closed** — only a low-value gateway key remains |
| No egress control | unchanged — a gateway is not a firewall |
| No runtime observability | improved — request and spend logs for LLM traffic |
| Not ephemeral | unchanged |

An injecting proxy would cover *all* HTTP APIs rather than just the LLM
endpoint, at the cost of a CA in the guest. If you later want `gh` brokered
too, revisit that trade.

## Caveats to settle

1. **Coverage is narrower.** A gateway fronts the LLM endpoint only. Anything
   else the VM calls is unaffected.
2. **Does pi's Copilot provider work through a gateway?** pi's `github-copilot`
   provider has its own OAuth exchange rather than a static key. Pointing it at
   a gateway may not work at all; the clean path is to configure pi with a
   direct API-key provider that the gateway fronts. **This is the open question
   the spike exists to answer.**
3. **Virtual keys need Postgres.** LiteLLM's full key management does; a single
   static key in `config.yaml` does not, and is enough to keep the provider key
   off the VM.
4. **The gateway becomes a dependency.** If it is down, pi cannot reach a model.

## Does this replace your SSH agent?

No — not as currently configured. The two work at different layers. 1Password
and Secretive speak the SSH agent protocol: a signing oracle with approval per
key or per signature. A gateway or proxy handles HTTP. SSH authentication is a
challenge-response, not a header, so neither has anything to inject.

There is an architecture where you drop it. Move git from SSH to HTTPS and an
injecting proxy can broker a `GITHUB_PAT` instead. That gains **per-repo
scope** — git-over-HTTPS puts the repository in the URL path, so path
allowlisting can restrict the VM to specific repos, which an account-wide SSH
key cannot. It costs the **human gate**: injection is unattended by design, so
the VM can push whenever it likes, and the `<alias>` / `<alias>-git` split
becomes meaningless because there is no agent to forward.

| | Git auth | Human gate | Per-repo scope | Egress governed |
|---|---|---|---|---|
| **A. As shipped** | SSH + agent | yes | no | no |
| **B. HTTP only** | HTTPS + injecting proxy | no | yes | only with `pf` |
| **C. Scoped SSH** | SSH + per-repo deploy keys | yes | yes | no |

Note what does *not* change in B. Inbound SSH from host to VM stays — that is
the control channel, and no proxy sees it. Outbound SSH to GitHub is not
blocked either; it simply becomes useless, because no key and no forwarded
agent remain in the VM. The capability disappears with the credential, not with
a firewall rule.

Your SSH agent stays useful under every option: it holds the key used to reach
the VM itself and your non-agent secrets. So the real question is not "keep or
drop it" but "does git authentication move from the SSH layer to the HTTP
layer".

This is decidable without the spike — it is an architecture choice. The spike
only answers whether pi's provider traffic can be brokered at all.

---

# Spike plan

Timeboxed test of one question: **can pi in the VM reach a model with no
provider credential on its disk?**

Run phases in order. Each has an explicit pass condition. Stop at the first
failure and record it — a negative result is a valid outcome.

> **Before starting:** pi runs in this VM. If you break its auth mid-spike you
> lose the agent until you restore. Phase 0 backs it up; keep a second terminal
> open.

## Phase 0 — Baseline and backup

In the VM:

```bash
cp ~/.pi/agent/auth.json ~/.pi/agent/auth.json.prespike
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.prespike
netstat -rn | awk '/^default/{print $2; exit}'   # host address, e.g. 192.168.64.1
```

**Pass:** backups exist and you know the host IP from inside the VM.

## Phase 1 — Run the gateway on the host

On the **host Mac**, with a `config.yaml` holding the real provider key and a
single static gateway key. Bind to an interface the VM can reach, not
loopback:

```bash
litellm --config config.yaml --host 0.0.0.0 --port 4000
lsof -nP -iTCP:4000 -sTCP:LISTEN
```

**Pass:** port 4000 listening on `0.0.0.0` or the `192.168.64.1` interface.

## Phase 2 — Prove reachability from the VM

```bash
curl -sS http://192.168.64.1:4000/health -o /dev/null -w '%{http_code}\n'
```

**Pass:** a response. **Fail:** connection refused means bind address or
firewall — fix before continuing.

## Phase 3 — Prove a completion works, outside pi

```bash
curl -sS http://192.168.64.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-group>","messages":[{"role":"user","content":"ping"}]}'
```

**Pass:** a model reply, while the VM only ever sent the gateway key. This
proves the mechanism independently of pi.

## Phase 4 — Point pi at the gateway

Configure a custom provider in pi with `baseUrl` set to the gateway and the
gateway key as `apiKey`. Send one trivial prompt.

**Pass:** pi works. **Fail:** capture the error — if it is the Copilot OAuth
exchange (caveat 2), switch pi to a direct API-key provider and retry before
concluding.

## Phase 5 — Remove the provider credential

```bash
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home()/'.pi/agent/auth.json'
d = json.loads(p.read_text())
d.pop('github-copilot', None)        # or blank the provider you brokered
p.write_text(json.dumps(d, indent=1))
EOF
```

Restart pi and send a prompt.

**Pass:** pi works with no provider credential on the VM disk.

## Phase 6 — Verify the negative

Two checks, both falsifiable:

```bash
grep -rIoE '\b(sk-|gho_|ghu_)[A-Za-z0-9_-]{16,}' ~/.pi ~/.config 2>/dev/null \
  || echo "no provider tokens in VM"
```

Then **revoke or change the gateway key on the host** and confirm pi stops
working. If it keeps working, it is not using the gateway and the result is
void.

**Rollback if abandoning:**

```bash
cp ~/.pi/agent/auth.json.prespike ~/.pi/agent/auth.json
cp ~/.pi/agent/settings.json.prespike ~/.pi/agent/settings.json
```

No CA to remove — one of the reasons to prefer the gateway shape.

## Recording the result

Append the outcome of Phases 4–5 to this file. The answer determines whether
the kit grows a `--broker` path or keeps documenting the provider token as
residual risk.
