# Credentials

What this kit protects, where each credential lives, and how to choose an
SSH agent.

## Choosing an SSH agent

`host/setup.sh` auto-detects, preferring 1Password, then Secretive, then
`$SSH_AUTH_SOCK`. Override with `--identity-agent PATH`.

| | 1Password | Secretive | ssh-agent + keychain |
|---|---|---|---|
| Key custody | 1Password process | **Secure Enclave hardware** | file in `~/.ssh` |
| Exportable | no, by policy | **no, by hardware design** | yes — copy the file |
| Approval | per key, **per session** | **per signature** | none after unlock |
| Access notifications | no | **yes** | no |
| Key types | Ed25519, RSA, ECDSA | **ECDSA P-256 only** | any |
| Survives hardware loss | yes, vault syncs | **no — keys cannot be exported** | yes, if backed up |
| Cost | subscription | free (MIT) | free |

**1Password** suits multiple machines and tolerable friction: you approve a key
once per session. The gap is that an authorised session is a standing
capability — anything running as you in the VM can sign until you disconnect.

**Secretive** closes that gap. Its FAQ is explicit about forwarding: *"any use
of one of your SSH keys on the remote host must be authenticated through
Secretive."* Every `git push` from the VM raises a Touch ID prompt on your Mac,
so the agent cannot push silently even mid-session. The costs are real: keys
are `ecdsa-sha2-nistp256` only, they **cannot be backed up or migrated** (*"for
any new computer, you should just create a new set of keys"*), and per-use
prompts make unattended operation impossible by design.

**Plain `ssh-agent` + keychain** works and needs nothing extra, but gives no
per-use consent and leaves an exportable key file on the host. Acceptable if
the host is your trusted workstation and you want zero dependencies.

> If you choose Secretive, register a **second key** on GitHub (1Password, or a
> hardware token) as a recovery path. A dead Mac means that key is gone
> permanently.

## Three credentials, only one of them held on the host

Be precise about this, because "credentials stay on the host" is only true of
one row:

| Credential | Used for | Where it lives | Required? |
|---|---|---|---|
| SSH key | `git clone/push/pull`, `ssh -T git@github.com` | host, in your chosen agent | **yes** |
| `gh` OAuth token | GitHub **API** calls — PRs, issues, releases | host only, or nowhere | **optional** |
| Model provider token | pi's calls to the LLM API | VM, plaintext `~/.pi/agent/auth.json` | yes, for pi |

**The SSH key is solved completely.** It is never a file in the VM, never
enters it, and cannot be copied out — only signatures cross the boundary. Since
day-to-day work is almost entirely git over SSH, that is the credential you
expose most often and the one now fully protected.

Only the provider token still lives in the VM, because pi needs it in-process;
[BROKERING.md](BROKERING.md) surveys fixes and none are implemented. The `gh`
token is removed from the VM by `provision.sh --logout-gh`, and kept on the
host only if you want it at all.

## The `gh` token is optional

Nothing in the git workflow needs it. `clone`, `push`, `pull` and `fetch` all
run over SSH through the forwarded agent, with no token involved. `gh` is only
needed for **API** work: opening PRs, filing issues, cutting releases — all of
which are also available in the browser, where your existing session is the
credential.

So a git-plus-browser workflow needs no `gh` token anywhere: not in the VM, not
on the host.

| | Keep `gh` on the host | Go `gh`-free |
|---|---|---|
| Permanent credential on your Mac | one | **none** |
| Scripted PRs, releases, issue triage | yes | browser only |
| `gh repo create` | yes | web UI |
| CI/CD pipelines | unaffected — Actions mints its own ephemeral `GITHUB_TOKEN` | unaffected |

Going `gh`-free removes a credential that never expires and grants read/write
to every repository your account can reach. If you rarely script GitHub
operations, it costs little. See [PR-OPTIONS.md](PR-OPTIONS.md) for how PR
creation works in each case.

> **If you do keep a `gh` token, do not under-read it.** Even at the minimum
> scopes, `repo`
> grants *"read/write access to code, commit statuses, invitations,
> collaborators, adding team memberships, and deployment statuses"* across every
> repository your account can reach, and a token works as a git password over
> HTTPS. A leak means an attacker can clone and push code — not just file
> issues — permanently, until you revoke it. What the kit removes is
> *persistence beyond revocation*: without `admin:public_key`, a leaked token
> can no longer plant an SSH key that survives cleanup.

## Why a brokered agent beats a key file

- The private key never exists as a file the VM could read. With a key in
  `~/.ssh/` you are relying on encryption at rest plus a keychain that stays
  unlocked for the whole session.
- The stock OpenSSH agent lets *any* process use *any* loaded key with no
  prompt. 1Password requires approval per key; Secretive requires it per
  signature.

The honest limit for 1Password: once you approve a key for a session, anything
running as your user in the VM can make it sign until you disconnect.
Authorisation is per key, not per request. Secretive does not have this
limitation; plain `ssh-agent` has no gate at all.

## What the kit changes

| | Without this kit | With this kit |
|---|---|---|
| SSH private key | on the VM disk | on the host, in your chosen agent |
| Key passphrase | VM login keychain | never exists |
| Agent can *use* the key | yes, silently | only while you are connected, after approval |
| Agent can *steal* the key | yes | no — key never crosses the boundary |
| `gh` token scopes | `admin:public_key` + more | `repo`, `read:org`, `gist` floor |
| `gh` token storage | sometimes plaintext `hosts.yml` | system keyring |
| Autologin password | `/etc/kcpassword`, world-readable | removed |
| SSH host keys | baked into base image, shared by clones | unique per VM |

For the threat model and what is *not* contained, see [SECURITY.md](SECURITY.md).
