# Threat model

## What this protects against

The coding agent runs as a full root-capable user inside the VM. Assume it — or
anything it executes, including a compromised npm dependency — can read every
file and environment variable owned by that user. The design question is not
"how do we constrain the agent" but "what is reachable from inside the VM".

| Asset | Where it lives | Reachable from the VM? |
|---|---|---|
| SSH private key | host, inside 1Password | **No.** Only signatures cross, and only while a `-git` session is open. |
| SSH key passphrase | never materialises | **No.** |
| `gh` OAuth token | host only, after `provision.sh --logout-gh` | **No.** Run `gh` on the host with `-R owner/repo`. |
| Model provider token | `~/.pi/agent/auth.json`, plaintext | Yes, always. |
| Account password | hashed, `/etc/kcpassword` removed | No. |

## Residual risks, stated plainly

**Agent forwarding is session-scoped — but damage is not.** While you are
connected, any process running as your user in the VM can ask the forwarded
agent to sign. 1Password prompts once per *key*, not per *request*. The key
itself can never be exfiltrated, so no credential survives the session.

Do not over-read that. Bounded capability is not bounded damage: anything
pushed during an open window stays pushed. The session boundary protects the
*credential*, not the *repository*. Close the gap with per-repo deploy keys
(so the capability reaches one repo, not all of them) and branch protection
(so it cannot reach `main` unreviewed).

Mitigation in practice: connect with the non-forwarding alias by default, and
use the `-git` alias only when you intend to push.

**The `gh` token does not rotate.** GitHub lists OAuth app tokens (`gho_`) as
long-lived with manual revocation. Anything that reads it once has indefinite
access. Mitigations: keep scopes at the `repo`/`read:org`/`gist` floor (`gh auth
refresh --remove-scopes ...`), or replace it with a fine-grained PAT that has an
expiry date. Revoke at <https://github.com/settings/connections/applications/>.

**What a leaked `gh` token actually permits.** The floor scopes are not a small
blast radius. `repo` grants *"read/write access to code, commit statuses,
invitations, collaborators, adding team memberships, and deployment statuses for
public and private repositories and organizations"*, and is *"needed for all git
network operations"*. Tokens are accepted in place of a password for Git over
HTTPS, so a leak permits:

```bash
git clone https://<token>@github.com/you/private-repo   # read all code
git push  https://<token>@github.com/you/private-repo   # write all code
```

across every repository the account can reach, until manually revoked. It does
*not* permit deleting repositories (`delete_repo`), organisation administration
(`admin:org`), account or billing changes, or web UI sign-in.

Organisation OAuth app access policies can block the GitHub CLI app from org
repositories independently of these scopes; that is worth enabling if your org
supports it.

**`admin:public_key` is the scope that matters most.** With it, a stolen token
can add an attacker's SSH key to your account — persistence that survives
revoking the token. This kit removes it, at the cost of `gh ssh-key add`.
The practical effect is that **revocation becomes sufficient**: a leaked token
still exposes all your code until you notice, but it cannot leave anything
behind once you do.

**Model provider tokens cannot be brokered.** pi needs the token in-process, so
it must exist in the VM. Properly fixing this requires an intercepting proxy
that swaps a sentinel for the real credential at the boundary — which is what
Docker Sandboxes implements. Out of scope here.

**Transcripts are not secrets-aware.** Session logs under `~/.pi/agent/sessions`
record command output verbatim and are also transmitted to the model provider.
Never `cat` a key or token "just to check" — use fingerprints, lengths, or
`file`. Audit with:

```bash
grep -rlE 'gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|BEGIN OPENSSH PRIVATE KEY' ~/.pi/agent/sessions
```

**Clones inherit everything.** `tart clone` copies the disk: SSH host keys, the
login keychain, `auth.json`. Re-run `provision.sh` in any clone, and never
`tart push` a provisioned VM.

## Why the base images always need provisioning

This is not specific to one VM. The upstream cirruslabs images are built that
way on purpose, for CI convenience:

- The image templates describe `macos-{tahoe,sequoia,sonoma}-vanilla` as *"a
  vanilla macOS installation with helpful tweaks such as **auto-login**"*, and
  the `-base` images build on top of those.
- The Packer templates set `ssh_username = "admin"` and `ssh_password =
  "admin"`.

So every fresh clone starts with a known password, auto-login enabled, and
therefore `/etc/kcpassword` present — a world-readable file holding that
password XOR'd against a published key. It also starts with the SSH host keys
that were baked in at image build time, shared by every other clone of the same
image.

`guest/provision.sh` exists to undo exactly these three things. Running it is
not hardening-on-top-of-a-secure-default; it is the step that makes a
CI-oriented image safe to hold credentials.

## Verification, not assertion

Several assumptions in this setup turned out to be wrong when tested:

- `security find-generic-password` reports a false negative for SSH passphrases
  on macOS 12+, because ssh-agent uses the data-protection keychain. Test with
  `ssh-add --apple-load-keychain` instead.
- Tart's autologin does **not** unlock the login keychain.
- Environment variables *are* readable by other same-user processes
  (`ps -Eww`), so passing a token via the environment is a time boundary, not an
  access boundary.
- `ssh -T git@github.com` exits **1** on success.

`guest/verify.sh` encodes these as executable checks. Prefer running it over
reasoning about what the configuration ought to do.
