# Brokering spike plan

A timeboxed test of the approach chosen in [BROKERING.md](BROKERING.md).

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

Configure the gateway's `github_copilot` provider on the host first and
complete its device-code login there, so the `ghu_` lives on the host. Then in
the VM configure a custom provider in pi with `baseUrl` set to the gateway and
the gateway key as `apiKey`. Send one trivial prompt.

**Pass:** pi works, and the Copilot OAuth now belongs to the gateway rather
than the VM. **Fail:** capture the error — if the gateway cannot serve Copilot
models, fall back to a direct API-key provider (Anthropic/OpenAI) fronted by
the gateway, which should broker cleanly, and record that Copilot needs the
direct route.

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
