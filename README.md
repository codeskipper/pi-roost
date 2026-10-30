# pi-kit-1pass-tart-macos

Reproducible setup for running the **pi** coding agent inside a **Tart** macOS
VM, with the **SSH key** held in **1Password** on the host and never written
into the VM.

The name spells out the four fixed assumptions: pi as the agent, 1Password as
the credential store, Tart as the hypervisor, macOS as both host and guest.
Swap any of those and the scripts need changes.

The agent runs with full root inside the VM. That is fine — the security comes
from what is *not* reachable from in there, not from constraining the agent.
This is the same model Docker Sandboxes uses: the VM is the trust boundary, and
credentials live on the other side of it. Docker Sandboxes cannot run a macOS
guest, so this kit applies that model where `sbx` does not reach — see
[docs/COMPARISON.md](docs/COMPARISON.md) for an honest scorecard, including the
three axes where `sbx` is better.

## Three credentials, only one of them solved by 1Password

Be precise about this, because the repo name invites the wrong conclusion:

| Credential | Used for | Where it lives | In 1Password? |
|---|---|---|---|
| SSH key | `git clone/push/pull`, `ssh -T git@github.com` | host, inside 1Password | **yes** |
| `gh` OAuth token | `gh` API calls, **and** full read/write to code over HTTPS | **host only** — `gh auth logout` in the VM | no |
| Model provider token | pi's calls to the LLM API | VM, plaintext `~/.pi/agent/auth.json` | no |

**1Password solves the first row completely.** The key is never a file, never
enters the VM, and cannot be copied out of it — only signatures cross the
boundary. Since day-to-day work is almost entirely git over SSH, that is the
credential you expose most often and the one now fully protected.

The other two still live in the VM, because `gh` and pi need them in-process.
The kit reduces rather than removes that exposure: it strips the `gh` token to
the minimum scopes GitHub allows, keeps it out of plaintext `hosts.yml`, and
documents the provider token as an accepted residual risk. Properly fixing
those needs an intercepting proxy, which is out of scope — see
[docs/SECURITY.md](docs/SECURITY.md).

> **Do not under-read the `gh` token.** Even at the minimum scopes, `repo`
> grants *"read/write access to code, commit statuses, invitations,
> collaborators, adding team memberships, and deployment statuses"* across every
> repository your account can reach, and a token works as a git password over
> HTTPS. A leak means an attacker can clone and push code — not just file
> issues — permanently, until you revoke it. What the kit removes is
> *persistence beyond revocation*: without `admin:public_key`, a leaked token
> can no longer plant an SSH key that survives cleanup.

## Why the 1Password agent beats ssh-agent + keychain

- The private key never exists as a file on any machine, so there is nothing
  for the VM to read even in principle. With `ssh-agent` the key sits in
  `~/.ssh/`, encrypted at best, and its passphrase sits in a keychain that is
  unlocked for the whole session.
- The stock OpenSSH agent lets *any* process use *any* loaded key with no
  prompt. 1Password requires explicit approval per key, with biometrics.

The honest limit: once you approve a key for a session, anything running as
your user in the VM can make it sign for as long as you stay connected.
Authorisation is per key, not per request. What you gain is that a captured
session cannot outlive itself — there is no key material to steal.

## What the kit changes

| | Without this kit | With this kit |
|---|---|---|
| SSH private key | on the VM disk | on the host, in 1Password |
| Key passphrase | VM login keychain | never exists |
| Agent can *use* the key | yes, silently | only while you are connected, after approval |
| Agent can *steal* the key | yes | no — key never crosses the boundary |
| `gh` token scopes | `admin:public_key` + more | `repo`, `read:org`, `gist` floor |
| `gh` token storage | sometimes plaintext `hosts.yml` | system keyring |
| Autologin password | `/etc/kcpassword`, world-readable | removed |
| SSH host keys | baked into base image, shared by clones | unique per VM |

## Daily workflow: two capability levels

`host/setup.sh` writes two SSH aliases for the same VM. The default forwards
nothing; repo access is an explicit opt-in, so the dangerous mode is never the
accident.

```bash
ssh tart-vm          # no credentials reach the VM  ← use this by default
ssh tart-vm-git      # agent forwarded, GitHub reachable for this session
```

### Most sessions — no repo access

```bash
ssh tart-vm
  ssh-add -l        # Error connecting to agent - nothing forwarded
  pi                # edit, build, test, run
  git commit -m ... # works: commits are local, need no credential
  git push          # fails: nothing to authenticate with
```

An unattended agent session produces reviewable commits while having no way to
reach GitHub at all. Reading, editing, building, testing and committing need no
credential — only network operations do.

### When you need to publish

```bash
ssh tart-vm-git
  git push          # 1Password prompts for Touch ID, first use this session
  exit              # capability ends here
```

1Password prompts once per *key per session*, not per push, so a long session
leaves a standing capability. Push and disconnect if you want it tight.

### API work runs on the host

With no `gh` credential in the VM, PRs and releases run from your Mac. `-R`
means you do not need a clone there:

```bash
gh pr create -R owner/repo --head feature-x --base main --title "..."
gh release create -R owner/repo v1.2.3
```

| | `ssh tart-vm` | `ssh tart-vm-git` | host |
|---|---|---|---|
| Edit, build, test | yes | yes | — |
| `git commit` (local) | yes | yes | — |
| `git push` / `pull` | no | yes, session-bound | yes |
| `gh pr` / `release` | no | no | yes |
| Persistent credential in VM | none | none | — |

`ssh -a tart-vm-git` disables forwarding for one connection if you picked the
wrong alias; command-line options beat the config file.

## The trade-off, stated plainly

This design contains the credential in **time**, not in **scope**.

**What it contains.** There is no persistent GitHub credential in the VM. The
property that made the `gh` token dangerous — one read grants permanent access —
is gone. The SSH key can never be copied out, and its usability ends when you
disconnect.

**What it does not contain.** During an open `-git` session, the VM can push to
any repository your key reaches. Bounded *capability* is not bounded *damage*:
commits pushed during that window persist afterwards. For a coding agent that
is the realistic risk — not a dramatic token theft, but a bad commit landing on
`main` while a window was open.

**Closing the scope axis** (recommended, not automated by this kit):

- **Per-repo deploy keys.** Keep a deploy key per project in 1Password instead
  of your account key. Then even mid-session the VM reaches exactly one
  repository. Strongest remaining improvement.
- **Branch protection / required review.** Makes "agent pushes to `main`"
  structurally impossible. Pairs naturally with this flow: the agent pushes a
  branch, you open the PR from the host.
- **Fine-grained PAT** for the host-side `gh`, scoped to specific repos with an
  expiry date, replacing the long-lived `gho_` token.

Time containment plus scope containment is where to stop. Either alone leaves
an obvious gap. For how this compares with Docker Sandboxes — including
egress control, ephemerality and the provider token, where it loses — see
[docs/COMPARISON.md](docs/COMPARISON.md).

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
