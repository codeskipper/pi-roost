# Comparison with Docker Sandboxes

The obvious question for this kit is "why not just use Docker Sandboxes
(`sbx`)?" This page answers it honestly, including where `sbx` is better.

## The constraint that frames everything

**`sbx` cannot run a macOS guest.** On Apple silicon it uses Apple's
Virtualization framework to launch Arm Linux (Ubuntu) microVMs; sandboxes boot
from OCI images and there is no macOS equivalent. macOS guests require
`VZMacOSVirtualMachine`, which Apple restricts to Apple hardware and caps at two
macOS VMs per host.

So if the work genuinely needs macOS — Xcode, macOS-specific testing, native
tooling — this is not a choice between two options. It is this kit or nothing
comparable. If the work does *not* need macOS, `sbx` on the host is the better
choice, and the two can coexist on the same machine.

## Axis by axis

| Axis | Docker Sandboxes | This kit | Winner |
|---|---|---|---|
| Isolation boundary | microVM, own kernel | Tart VM, own kernel | tie |
| Agent privilege inside | full root | full root | tie |
| Guest OS | Linux only | **macOS** | kit (only option) |
| SSH/git credential | host agent forwarded | host agent forwarded, **+ per-key biometric approval** | kit, slightly |
| `gh` token | proxy-injected; sandbox sees a sentinel | **absent** from VM; `gh` runs on the host | kit, narrowly |
| Model provider token | proxy-injected, never in the VM | **plaintext in the VM** | **sbx, decisively** |
| Network egress policy | all TCP via host proxy, policy-enforced | none | **sbx** |
| Ephemerality | disposable per task | long-lived pet VM | **sbx** |
| Runtime observability | logs connections and secrets touched | static audit only (`verify.sh`) | **sbx** |
| Setup cost | one command | scripts you maintain | **sbx** |

## Where this kit matches or beats sbx

**Credential theft.** Docker keeps credentials on the host and shows the
sandbox a sentinel value, so a compromised sandbox cannot read them. But the
*capability* stays permanently available — the sandbox can make authenticated
requests through the proxy whenever it likes. This kit removes the capability
except in windows you deliberately open (`ssh <vm>-git`). For the `gh` token,
"absent and unreachable" is a stronger position than "present but obscured".

**SSH.** The 1Password agent adds per-key approval with biometrics, which plain
agent forwarding into a sandbox does not provide.

## Where this kit is behind

**The model provider token.** `~/.pi/agent/auth.json` is plaintext, readable by
any process in the VM, and survives reboots. Docker's proxy injection makes
exactly this class of credential unreadable from inside the sandbox. This is
the one axis where `sbx` is categorically better, and this kit documents it as
accepted residual risk rather than solving it. A third-party credential broker
could close it — see [BROKERING.md](BROKERING.md).

**No egress control.** Docker routes all outbound TCP through a host proxy and
enforces network policy on it. This VM can reach anything its network can.
For prompt-injection scenarios — an agent talked into POSTing your source
somewhere — that is a meaningful difference.

**Not ephemeral.** Each `sbx` task gets a clean rootfs, so a compromise does not
persist. This VM is a pet that accumulates state indefinitely; a compromise
lasts until noticed.

## Verdict

**For containing credential blast radius: good enough.** On the `gh` token and
the SSH key this kit is arguably ahead, because it removes capability rather
than hiding values.

**As a general agent sandbox: not equivalent.** Egress control, ephemerality
and the provider token are three real gaps. None are currently implemented,
but all three now have identified paths — see
[What would close the gaps](#what-would-close-the-gaps). The difference from
`sbx` is therefore integration and maintenance rather than capability: `sbx`
ships these assembled, here you would own the result.

The defensible claim is therefore narrower than "an alternative to Docker
Sandboxes". It is:

> the credential-isolation half of the `sbx` model, applied to the one platform
> `sbx` cannot serve.

## What would close the gaps

Ranked by feasibility, none currently implemented or tested. All three are
**host-side**, so they would carry over unchanged to a Linux guest.

1. **Ephemerality — very achievable.** `tart clone` a provisioned golden image
   per task, work, then `tart delete`. `provision.sh` already makes a clean
   image reproducible and `create-vm.sh` is most of the plumbing. Highest value
   for the least new code.
2. **Egress control — moderate.** Put the VM on an isolated network and force
   traffic through a host proxy, or allowlist with `pf` on the host. Coarser
   than per-request policy, but enough to stop naive exfiltration.
3. **Provider token — off-the-shelf options exist.** The simplest is a
   self-hosted LLM gateway holding the real key, which pi can use natively via
   `custom-provider`'s `baseUrl` — no MITM certificate in the guest. It leaves
   a low-value gateway key in the VM rather than nothing, but collapses the
   blast radius from "bills your provider account from anywhere" to "works only
   against a service on your Mac". An injecting proxy would cover all HTTP
   APIs instead of just the LLM endpoint, at the cost of trusting a CA in the
   guest. See [BROKERING.md](BROKERING.md) for the survey and a spike plan.
   Not yet tested.

## Sources

- Docker Sandboxes, credential management and isolation layers:
  <https://docs.docker.com/ai/sandboxes/configuration/credentials/>,
  <https://docs.docker.com/ai/sandboxes/security/isolation/>
- Docker Sandboxes security model ("The agent has full control inside the VM,
  including sudo access"): <https://docs.docker.com/ai/sandboxes/security/>
- Guest OS on Apple silicon (Arm Linux/Ubuntu microVMs):
  <https://learn.arm.com/install-guides/sbx/>
- Apple Virtualization framework, macOS guest requirements:
  <https://developer.apple.com/documentation/virtualization>
