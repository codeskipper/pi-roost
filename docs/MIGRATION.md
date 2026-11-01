# Migrating an existing VM to host-held credentials

A checklist for moving a VM that currently holds its own SSH key and `gh`
token over to a forwarded agent on the host. Nothing is destroyed until the
gate in step 5 passes.

Run `guest/macos/verify.sh` first; if it already reports *no private SSH keys*
and *no resident gh credential*, you are done.

## Find your values

In the VM:

```bash
scutil --get LocalHostName                      # VM_NAME
ssh-keygen -lf ~/.ssh/id_ed25519.pub            # the key to retire later
```

Substitute those for `VM_NAME` and `OLD_KEY` below. Pick any short `ALIAS`.

---

## 1 — Host: enable the 1Password agent

- [ ] 1Password → Settings → **Developer** → *Use the SSH agent*
- [ ] **New Item → SSH Key** → generate Ed25519
- [ ] Add to `~/.ssh/config` on the host:

```sshconfig
Host *
  IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

- [ ] Verify:

```bash
SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ssh-add -l
```

> **`ssh-add` ignores `IdentityAgent`** — it reads only `$SSH_AUTH_SOCK`, so a
> bare `ssh-add -l` will say *"The agent has no identities"* even when the setup
> is correct. Use the explicit form above. If it is still empty: is 1Password
> unlocked, is the item really of type *SSH Key*, and does
> `~/.config/1Password/ssh/agent.toml` restrict vaults? To restart the agent,
> toggle the Developer setting off and on, or quit and reopen 1Password.
>
> The wildcard is optional — `Host github.com` works too, since `setup.sh`
> writes `IdentityAgent` into both VM aliases. `IdentityAgent` only selects
> which local agent you use and grants nothing to remote hosts; that is
> `ForwardAgent`, which must stay scoped.

## 2 — Host: register the key with GitHub

- [ ] Copy the public key (1Password, or `ssh-add -L`)
- [ ] Add it at <https://github.com/settings/keys>
- [ ] Verify — Touch ID should prompt:

```bash
ssh -T git@github.com        # "Hi <you>!"
```

`gh ssh-key add` will not work; this kit removes the `admin:public_key` scope.

## 3 — Host: clone the kit

```bash
git clone git@github.com:OWNER/pi-roost.git && cd pi-roost
```

Succeeding here also proves step 2.

## 4 — Host: run setup

```bash
./host/setup.sh --vm-name VM_NAME --alias ALIAS
```

Writes two SSH aliases, installs your public key into the VM's
`authorized_keys` (prompts for the VM password — the last time), and checks
that `ALIAS-git` forwards while `ALIAS` does not.

---

## 5 — Gate: do not skip

```bash
ssh ALIAS-git
# inside the VM:
ssh-add -l                 # MUST show the 1Password key, not OLD_KEY
ssh -T git@github.com      # Touch ID prompts on the host
```

**If `ssh-add -l` is empty, stop.** The next step deletes the VM's only key.

---

## 6 — VM: remove the local credentials

Still inside that `ALIAS-git` session:

```bash
cd ~/dev/pi-roost && git pull
./guest/macos/provision.sh --hostname VM_NAME --keep-host-keys --logout-gh
```

Removes `id_ed25519`, deletes its passphrase from the VM keychain, stops the
local agent, and logs `gh` out. `--keep-host-keys` preserves host keys you have
already rotated.

## 7 — Verify

```bash
./guest/macos/verify.sh --network
```

Expect:

```
[ PASS ]  no private SSH keys on this VM
[ PASS ]  no resident gh credential (git works via the forwarded agent)
[ PASS ]  GitHub SSH authentication works
```

## 8 — Retire the old key

- [ ] Delete `OLD_KEY` at <https://github.com/settings/keys>

It now exists nowhere, so leaving it is pure liability.

## 9 — Optional: close password authentication

```bash
./guest/macos/provision.sh --hostname VM_NAME \
    --keep-host-keys --keep-local-keys --disable-password-auth
```

Refuses if `authorized_keys` is empty. Keep a Screen Sharing session open while
you test a fresh `ssh ALIAS`.

---

## Afterwards

```bash
ssh ALIAS          # no credentials reach the VM  ← default
ssh ALIAS-git      # agent forwarded, push works for this session
```

Two things in the VM become unnecessary once step 6 is done, since neither the
SSH passphrase nor the `gh` token lives in the keychain any more:

- the `unlock-pi` helper
- the ssh-agent bootstrap block in `~/.zshrc` (harmless to keep as a fallback)

API work moves to the host or the browser — see [PR-OPTIONS.md](PR-OPTIONS.md).
