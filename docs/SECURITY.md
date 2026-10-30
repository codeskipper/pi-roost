# Threat model

## What this protects against

The coding agent runs as a full root-capable user inside the VM. Assume it — or
anything it executes, including a compromised npm dependency — can read every
file and environment variable owned by that user. The design question is not
"how do we constrain the agent" but "what is reachable from inside the VM".

| Asset | Where it lives | Reachable from the VM? |
|---|---|---|
| SSH private key | host, inside 1Password | **No.** Only signatures cross the boundary. |
| SSH key passphrase | never materialises | **No.** |
| `gh` OAuth token | VM login keychain | Yes, while the keychain is unlocked. |
| Model provider token | `~/.pi/agent/auth.json`, plaintext | Yes, always. |
| Account password | hashed, `/etc/kcpassword` removed | No. |

## Residual risks, stated plainly

**Agent forwarding is session-scoped.** While you are connected, any process
running as your user in the VM can ask the forwarded agent to sign. 1Password
prompts once per *key*, not per *request*. Mitigation: connect only when you
need it; disconnect when you don't. The key itself can never be exfiltrated, so
a capture does not outlive the session.

**The `gh` token does not rotate.** GitHub lists OAuth app tokens (`gho_`) as
long-lived with manual revocation. Anything that reads it once has indefinite
access. Mitigations: keep scopes at the `repo`/`read:org`/`gist` floor (`gh auth
refresh --remove-scopes ...`), or replace it with a fine-grained PAT that has an
expiry date. Revoke at <https://github.com/settings/connections/applications/>.

**`admin:public_key` is the scope that matters most.** With it, a stolen token
can add an attacker's SSH key to your account — persistence that survives
revoking the token. This kit removes it, at the cost of `gh ssh-key add`.

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
