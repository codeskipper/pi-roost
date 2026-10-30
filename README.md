# pi-kit-1pass-tart-macos

Reproducible setup for running the **pi** coding agent inside a **Tart** macOS
VM, with GitHub credentials held in **1Password** on the host and never written
into the VM.

The name spells out the four fixed assumptions: pi as the agent, 1Password as
the credential store, Tart as the hypervisor, macOS as both host and guest.
Swap any of those and the scripts need changes.

The agent runs with full root inside the VM. That is fine — the security comes
from what is *not* reachable from in there, not from constraining the agent.
This is the same model Docker Sandboxes uses: the VM is the trust boundary, and
credentials live on the other side of it.

## Why 1Password specifically

The kit depends on the 1Password SSH agent rather than `ssh-agent` plus the
macOS keychain, for two reasons:

- The private key never exists as a file on any machine, so there is nothing
  for the VM to read even in principle.
- The stock OpenSSH agent lets *any* process use *any* loaded key with no
  prompt. 1Password requires explicit approval per key, with biometrics.

The key still signs for anything running in the VM during an authorised
session — see [docs/SECURITY.md](docs/SECURITY.md) — but it can never be
copied out.

## What it gives you

| | Without this kit | With this kit |
|---|---|---|
| SSH private key | on the VM disk | on the host, in 1Password |
| Key passphrase | VM login keychain | never exists |
| Agent can *use* the key | yes, silently | yes, but only while you are connected |
| Agent can *steal* the key | yes | no — key never crosses the boundary |
| `gh` token | VM keychain, long-lived | VM keychain, minimum scopes |
| Autologin password | `/etc/kcpassword`, world-readable | removed |
| SSH host keys | baked into base image, shared by clones | unique per VM |

## Requirements

- macOS host with [Tart](https://tart.run) and a macOS guest VM
  (`brew install cirruslabs/cli/tart`)
- 1Password with the SSH agent enabled (Settings → Developer → Use the SSH agent)
- `nc` (ships with macOS)

## Usage

Clone on the **host**:

```bash
git clone <this-repo> && cd pi-kit-1pass-tart-macos
```

### 0. Create the VM (optional)

If you don't have one yet:

```bash
host/create-vm.sh
```

Defaults to `ghcr.io/cirruslabs/macos-tahoe-base:latest` (macOS 26 Tahoe).
Pass `--from` for a different image — `macos-tahoe-vanilla` for a bare install,
`macos-tahoe-xcode` if you need Xcode, or swap `tahoe` for `sequoia`/`sonoma`.

It suggests a name derived from your GitHub login — `alice-tart-test-vm` —
and asks you to confirm. Clones, boots, and waits for an address.

### 1. Host side

```bash
host/setup.sh                      # derives and confirms the VM name
host/setup.sh --vm-name my-vm      # or name it explicitly
```

This verifies the 1Password agent, adds an SSH config block with
`ForwardAgent yes` scoped to that host only, and installs your public key into
the VM's `authorized_keys`.

### 2. Guest side

Copy the **whole repo** (the scripts share `lib/`):

```bash
rsync -a --exclude .git ./ <vm-alias>:~/pi-kit-1pass-tart-macos/
ssh <vm-alias>
cd pi-kit-1pass-tart-macos && ./guest/provision.sh
```

`provision.sh` derives the same `<login>-tart-test-vm` name, or takes
`--hostname NAME`. It renames the VM, regenerates host keys, removes any local
SSH key and its keychain entry, strips autologin, and writes a `~/.ssh/config`
that works with a forwarded agent.

### 3. Verify

```bash
./guest/verify.sh            # add --network to test GitHub auth
```

Prints a PASS/WARN/FAIL audit of the whole posture. Read-only; run it any time.

## Naming

The VM name defaults to `<github-login>-tart-test-vm`, resolved in this order:

1. `gh api user --jq .login`, if `gh` is installed and authenticated
2. the SSH agent — GitHub greets you by login over SSH, so this works with
   only 1Password configured
3. `$USER`

The result is lowercased and stripped to `[a-z0-9-]`. You are always shown the
suggestion and can override it; non-interactive runs accept the default.

## Add the public key to GitHub

`gh ssh-key add` needs the `admin:public_key` scope, which this kit
deliberately removes. Add the key at <https://github.com/settings/keys> instead —
copy it from 1Password, or `ssh-add -L` on the host.

## Known limitations

- **Model-provider credentials stay in the VM.** pi holds its Copilot/API token
  in `~/.pi/agent/auth.json` in plaintext, because it needs it in-process.
  Brokering that requires an intercepting proxy (what Docker Sandboxes builds).
  Rotate it if the VM is ever shared or imaged.
- **Agent forwarding is session-scoped, not per-command.** While you are
  connected, anything running as your user in the VM can ask the agent to sign.
  1Password requires approval per *key*, not per *request*.
- **Do not `tart push` a provisioned VM.** Re-run `provision.sh` in any clone,
  or it inherits this VM's host keys.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.
