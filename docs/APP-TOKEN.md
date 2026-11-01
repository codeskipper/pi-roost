# GitHub App token for agent PRs

Design for option 4 in [PR-OPTIONS.md](PR-OPTIONS.md): the agent opens pull
requests using a short-lived, narrowly-scoped token, the same mechanism GitHub
Actions uses.

**Status:** the prerequisite gate (`host/check-pr-prereqs.sh`) is implemented.
Token minting is **not** — this is a design, not a feature.

## Why a gate, not a warning

`pull_requests: write` includes merging. A token that opens a PR can also merge
it, so required reviews are what separates "propose" from "decide". Documenting
that is not enough — warnings get skipped, and plans change after setup.

So the design makes the check a **runtime precondition of minting**, re-run
every time. If protection cannot be confirmed, no token is issued.

## The gate

```bash
host/check-pr-prereqs.sh --repo OWNER/NAME [--branch main] [--app-slug SLUG]
```

| Exit | Verdict | Meaning |
|---|---|---|
| 0 | PASS | the branch requires an approving review |
| 1 | UNPROTECTED | no such rule |
| 2 | UNAVAILABLE | the plan does not offer protection for this repo |
| 3 | UNVERIFIABLE | not an admin, not authenticated, or unreachable |

**It fails closed.** Only exit 0 permits minting. `UNVERIFIABLE` is treated as
failure, because protection settings are visible only to admins and a `404`
from the API means "no permission" and "no protection" indistinguishably.

It checks rulesets first (`/rules/branches/{branch}`), then classic protection,
and reports when admins can bypass. With `--app-slug` it also flags rulesets
that have bypass actors, since adding the agent's App there would void the
control.

## Design of the mint

```
host/mint-app-token.sh --repo OWNER/NAME --app-id N --installation-id N
  1. check-pr-prereqs.sh --repo OWNER/NAME   → abort unless exit 0
  2. read the App private key                → 1Password, keychain, or file
  3. build an RS256 JWT                      → openssl, no dependencies
  4. POST /app/installations/{id}/access_tokens
       { "repositories": ["NAME"],
         "permissions": { "pull_requests": "write", "contents": "read" } }
  5. print the token and its expiry (1 hour)
```

Narrowing at step 4 matters: by default the token inherits **all** of the
installation's repositories and permissions. With `contents: read` the token
cannot write code at all — pushing stays with the SSH key behind its human
gate.

```
host/with-pr-token.sh --alias my-vm-git --repo OWNER/NAME
  → mint, then: ssh my-vm-git with GH_TOKEN set for that session
```

### Where the private key lives

The App key mints tokens indefinitely, so it is the real secret.

| Storage | Gate on minting |
|---|---|
| file, `0600` | none |
| macOS keychain | keychain unlock |
| **1Password item** | **Touch ID per mint** |

The 1Password route makes minting human-gated, mirroring how the SSH key
already works.

### Escape hatch

`--i-accept-unprotected-merge-risk` skips the gate. Deliberately awkward, logged
loudly, and never the default — people who need it will otherwise patch the
script, which is worse.

## What would change in the kit

```
host/check-pr-prereqs.sh   done   the gate
host/mint-app-token.sh     todo   JWT + mint, gated
host/with-pr-token.sh      todo   mint, then open a session with GH_TOKEN
guest/macos/provision.sh   todo   --accept-gh-token adds AcceptEnv to sshd
guest/macos/verify.sh      todo   report GH_TOKEN presence, type and expiry
```

Roughly half a day, once the prerequisite holds.

## Open questions

1. **Exact permissions `gh pr create` needs** — read the
   `X-Accepted-GitHub-Permissions` response header rather than guessing.
2. **Does `gh` accept a `ghs_` installation token** for `pr create`? Needs a
   live test.
3. **Session teardown** — `DELETE /installation/token` revokes immediately;
   expiry covers it otherwise.

## One-time setup, when you get there

1. Create a GitHub App on your account: **Pull requests: Read & write**,
   **Contents: Read-only**, Metadata: Read. "Only on this account".
2. Generate a private key; store it per the table above.
3. Install the App on **specific repositories**, not all of them.
4. Note the App ID; find the installation ID via `GET /app/installations`.
5. Confirm `check-pr-prereqs.sh` returns PASS for those repositories.

Step 5 is the one that currently fails on free private repositories. The gate
will say so.
