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

## Across all four

This table adds cplt and the IDE extension baseline to the `sbx` comparison.
It covers the Mac and developer-laptop options in one place. The IDE column
is not a sandbox; it shows what a Copilot extension in VS Code or PyCharm can
reach by default, for comparison.

Sources: `sbx` and pi-roost columns as above and in the sections of this
file. cplt column from its README (`navikt/cplt`), not tested here. IDE column
from [LANDSCAPE.md](LANDSCAPE.md#ide-extensions-copilot-in-vs-code-and-pycharm).

| Axis | Docker Sandboxes (`sbx`) | pi-roost | cplt | IDE extension (VS Code / PyCharm) |
|---|---|---|---|---|
| Isolation boundary | microVM, own kernel | Tart VM, own kernel | per-process: Seatbelt (macOS), Landlock + seccomp (Linux); shared kernel | none; runs in the IDE process as the user |
| Agent privilege | full root inside | full root inside | runs as the user; restrictions apply to it and every child | user's full privileges |
| Credentials in reach | sentinel values; real keys stay on host | host-held; forwarded only during `-git` session | `~/.ssh`, `~/.aws`, `~/.kube`, `~/.gnupg`, etc. denied; env filtered; macOS Keychain grant is all-or-nothing | everything the user can read |
| Model provider token | proxy-injected, not in sandbox | plaintext inside VM, always readable | not covered in cplt's README | readable by the extension, in the user's profile |
| Network egress | all TCP through policy proxy | none | outbound 443 only; domain allow/block via proxy; audit log | unrestricted beyond the extension's own traffic |
| GitHub actions | proxy-injected credentials | SSH agent forwarded per session | `git push` to default branch and `gh` merge/delete/release blocked | tool approvals only, if enabled |
| File scope | per-mount | whole VM | project directory writable; `.env*`, keys, `.git/hooks` protected | whole user account |
| Policy location | sandbox configuration | scripts and docs in repo | `.cplt.toml` in repo, trust-approved | workspace trust settings, org content exclusions |
| Ephemerality | disposable per task | long-lived | long-lived (host) | long-lived |
| Platform | Linux guests on Apple silicon | macOS host; macOS guest today | macOS, Linux; Windows via WSL2 | VS Code or PyCharm on any OS |
| Setup | one command | scripts to maintain | `brew install`, `cplt doctor` | install extension |
| Runtime observability | logs connections and secrets touched | static audit (`verify.sh`) | outbound audit log | extension logs only |

Reading across the table: `sbx` and pi-roost are the strongest on credential
isolation, with pi-roost having an edge on keeping the GitHub token entirely
off the VM. cplt gives the most useful per-action guards and sensible file
scoping on a laptop, but its boundary is weaker than a VM. The IDE extension
is the weakest case: it has the same reach as the user, and its protection is
mostly workspace trust and approval settings.

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
