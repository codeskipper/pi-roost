# pi-roost

**A safe roost for the pi coding agent** — run it in a Tart VM on your Mac,
with credentials kept on the host and never written into the VM.

The agent runs with full root inside the VM. That is fine: the security comes
from what is *not* reachable from in there, not from constraining the agent.
The VM is the trust boundary and credentials live on the other side of it —
the same model Docker Sandboxes uses, applied to the one platform `sbx` cannot
serve.

macOS host is a fixed assumption. The credential store (1Password, Secretive,
or a plain `ssh-agent`) and the guest OS (macOS today, Linux planned) are not.

## Project status

pi-roost is a **practical research project**. The host-held SSH credential
workflow is functional and has been tested successfully with **1Password**,
including migration of an existing macOS VM to a forwarded host agent.

Other supported agent options and research proposals should not be read as
having the same validation: Secretive and plain `ssh-agent` have not been
validated in this test, and model-provider credential brokering remains
unimplemented. See the limitations below before relying on the setup.

**Next priority: limit the scope of the agent's GitHub access.** Forwarding a
personal SSH key currently makes every repository that key can access reachable
during the session. The next step is to restrict access to the repositories
and permissions each project actually needs, starting with investigating
per-repository deploy keys and isolated agent forwarding. This is not yet
implemented; see [GitHub access scoping](docs/GITHUB-ACCESS-SCOPE.md) for options
and a verification checklist.

## Requirements

- macOS host with [Tart](https://tart.run) — `brew install cirruslabs/cli/tart`
- An SSH agent on the host: **1Password** (Settings → Developer),
  **Secretive** (`brew install secretive`), or a plain `ssh-agent` with a key
- `nc` (ships with macOS)

## Quick start

```bash
# on the host
host/create-vm.sh                 # clone + boot a Tahoe VM, named from your GitHub login
host/setup.sh                     # detect agent, write SSH aliases, install your key

# add the public key at https://github.com/settings/keys

# in the VM
rsync -a --exclude .git ./ <alias>-git:~/pi-roost/
ssh <alias>-git 'cd pi-roost && ./guest/macos/provision.sh --logout-gh && ./guest/macos/verify.sh'
```

Then connect with two capability levels:

```bash
ssh my-vm          # no credentials reach the VM  ← default
ssh my-vm-git      # agent forwarded, GitHub reachable for this session
```

## Documentation

| Read | For |
|---|---|
| [CREDENTIALS.md](docs/CREDENTIALS.md) | what is protected, where each credential lives, choosing an SSH agent |
| [WORKFLOW.md](docs/WORKFLOW.md) | daily use, the two aliases, full setup steps |
| [MIGRATION.md](docs/MIGRATION.md) | moving an existing VM to host-held credentials |
| [GITHUB-ACCESS-SCOPE.md](docs/GITHUB-ACCESS-SCOPE.md) | options for restricting the agent to specific repositories and permissions |
| [PR-OPTIONS.md](docs/PR-OPTIONS.md) | whether to let the agent open pull requests, and the risks |
| [APP-TOKEN.md](docs/APP-TOKEN.md) | design for a gated, short-lived PR token |
| [SECURITY.md](docs/SECURITY.md) | threat model, residual risks, what is *not* contained |
| [COMPARISON.md](docs/COMPARISON.md) | honest scorecard against Docker Sandboxes |
| [BROKERING.md](docs/BROKERING.md) | keeping the model-provider token out of the VM |
| [BROKERING-SPIKE.md](docs/BROKERING-SPIKE.md) | the test plan for that, when you want to try it |
| [ROADMAP.md](docs/ROADMAP.md) | Linux guests, and the three unimplemented gaps |

## Audit

`guest/macos/verify.sh` is read-only and prints a PASS/WARN/FAIL report of the
whole posture. Run it any time; it encodes the checks rather than the prose.

## Known limitations

- **Model-provider credentials stay in the VM.** pi holds its token in
  `~/.pi/agent/auth.json` in plaintext because it needs it in-process.
  [BROKERING.md](docs/BROKERING.md) surveys fixes; none are implemented.
- **Agent forwarding is session-scoped, not per-command** — unless you use
  Secretive, which approves each signature.
- **A `gh` token is optional.** Git over SSH needs none; it is only for API
  work, which the browser also covers. See
  [CREDENTIALS.md](docs/CREDENTIALS.md).
- **Do not `tart push` a provisioned VM.** Re-run `provision.sh` in any clone,
  or it inherits this VM's host keys.

> Not affiliated with the pi project, Apple, 1Password, Infisical or Cirrus
> Labs. "pi" refers to the coding agent this kit runs; macOS and Mac are
> trademarks of Apple Inc.
