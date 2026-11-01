# Daily workflow and setup

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
  git push          # your agent prompts for Touch ID
  exit              # capability ends here
```

With 1Password the prompt appears once per key per session, so a long session
leaves a standing capability — push and disconnect if you want it tight. With
Secretive every signature prompts, so there is no standing capability at all.

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

For whether to let the agent open PRs itself, see [PR-OPTIONS.md](PR-OPTIONS.md).

## Usage

Clone on the **host**:

```bash
git clone <this-repo> && cd pi-roost
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

This verifies your SSH agent, adds an SSH config block with
`ForwardAgent yes` scoped to that host only, and installs your public key into
the VM's `authorized_keys`.

### 2. Guest side

Copy the **whole repo** (the scripts share `lib/`):

```bash
rsync -a --exclude .git ./ <vm-alias>:~/pi-roost/
ssh <vm-alias>
cd pi-roost && ./guest/macos/provision.sh
```

`provision.sh` derives the same `<login>-tart-test-vm` name, or takes
`--hostname NAME`. It renames the VM, regenerates host keys, removes any local
SSH key and its keychain entry, strips autologin, and writes a `~/.ssh/config`
that works with a forwarded agent.

### 3. Verify

```bash
./guest/macos/verify.sh            # add --network to test GitHub auth
```

Prints a PASS/WARN/FAIL audit of the whole posture. Read-only; run it any time.

## Naming

The VM name defaults to `<github-login>-tart-test-vm`, resolved in this order:

1. `gh api user --jq .login`, if `gh` is installed and authenticated
2. the SSH agent — GitHub greets you by login over SSH, so this works with
   only an agent configured, before `gh` is installed
3. `$USER`

The result is lowercased and stripped to `[a-z0-9-]`. You are always shown the
suggestion and can override it; non-interactive runs accept the default.

## Add the public key to GitHub

`gh ssh-key add` needs the `admin:public_key` scope, which this kit
deliberately removes. Add the key at <https://github.com/settings/keys> instead —
copy it from your agent's UI (1Password or Secretive), or run `ssh-add -L` on
the host.
