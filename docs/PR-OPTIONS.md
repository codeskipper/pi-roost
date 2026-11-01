# Letting the agent open pull requests

With the default setup the agent can write and push code, but cannot call the
GitHub API. This page lays out the options so you can decide whether to change
that. **The kit does not pick for you**, and nothing here is implemented.

## What the agent can and cannot do by default

| Action | Credential needed | Default |
|---|---|---|
| Edit, build, test, `git commit` | none | ✅ |
| `git push` a branch | SSH key via forwarded agent | ✅ in a `-git` session |
| Open a PR, comment, label, release | GitHub API token | ❌ |

So the agent produces a branch; opening the PR is a separate step. The question
is where that step happens.

## Four options

### 1. Open the PR in the browser

Every push prints a ready-made link:

```
remote: Create a pull request for 'feature-x' on GitHub by visiting:
remote:   https://github.com/you/repo/pull/new/feature-x
```

No token anywhere — your browser session is the credential. If your plan
includes Copilot PR summaries, the description can be generated there, though
it is written from the diff and will not know *why* a change was made.

**Cost:** a browser step. **Risk added:** none.

### 2. `gh` on the host, description from the commits

```bash
gh pr create -R you/repo --head feature-x --base main --fill-verbose
```

`--fill-verbose` builds the description from the commit messages, so the
agent's reasoning travels with the push. A richer body can be piped over SSH:

```bash
ssh my-vm cat ~/work/repo/.pr-body.md \
  | gh pr create -R you/repo --head feature-x --base main --title "..." --body-file -
```

**Cost:** a `gh` token on the host. **Risk added:** none in the VM.

### 3. Fine-grained PAT, passed per session

Scope it to one repo with pull-request permission and a short expiry, then pass
it only for the session:

```sshconfig
# host ~/.ssh/config
SendEnv GH_TOKEN
# VM /etc/ssh/sshd_config.d/
AcceptEnv GH_TOKEN
```

**Cost:** a token exists in the VM while connected. Environment variables are
readable by any same-user process (`ps -Eww`), so this is a time-and-scope
bound, not an access bound.

**Important:** a PAT acts as *you*. If you are a repository admin, it
**inherits your bypass of branch protection** unless "Do not allow bypassing
the above settings" is enabled.

### 4. GitHub App installation token

The same mechanism GitHub Actions uses — `GITHUB_TOKEN` is an App installation
token. The host holds the App private key and mints a token per session:

- expires **one hour** after creation
- permissions chosen at mint time, e.g. `pull_requests: write` plus
  `contents: read`, so the token **cannot write code**
- acts as the App, not as you, so branch protection applies to it and PRs are
  attributed to the app rather than to your account

**Cost:** creating and installing a GitHub App; re-minting on long sessions.
**Risk added:** smallest of the token options.

## Risks of letting the agent open PRs

**`pull_requests: write` includes merging.** GitHub's own description: *"the
level of permission to grant for pull requests and related comments,
assignees, labels, milestones, **and merges**"*. The permission that lets an
agent propose a change also lets it merge one. Branch protection with required
review is what separates the two.

**Prompt injection.** An agent reading untrusted content — issues, dependency
docs, fetched pages — can be induced to act. PRs are visible and revertible, so
the damage is bounded *provided* they cannot self-merge.

**Token theft.** Any token in the VM is readable by same-user processes. This
is why lifetime and scope matter more than secrecy: a one-hour, single-repo,
PR-only token is a small prize.

**Perspective.** The agent can already push code in a `-git` session. PR
creation adds proposal mechanics on top of a write capability you have already
granted — and with `contents: read` the new token cannot touch code at all. The
meaningful question is not "is opening a PR risky" but "can anything merge
without review".

## Prerequisite: branch protection, and whether you have it

Required reviews are the control that makes options 3 and 4 safe. Check before
relying on it:

```bash
gh api repos/OWNER/REPO/rulesets
```

A `403` with *"Upgrade to GitHub Pro or make this repository public to enable
this feature"* means **branch protection is not available** on that repository.
GitHub Free includes it for public repositories but not private ones.

If you get that error, your choices are: make the repository public, upgrade
the plan, or stay with options 1–2, which need no protection because no token
exists for the agent to misuse.

Two settings to check if protection *is* available:

- **"Do not allow bypassing the above settings"** — otherwise admins, and any
  PAT acting as an admin, ignore the rule.
- **Bypass actors** — do not add the agent's App to the bypass list.

## Choosing

| If | Then |
|---|---|
| You want zero added risk | **Option 1** — browser |
| You want scripted PRs, token on the host only | **Option 2** |
| The agent must open PRs and you have branch protection | **Option 4**, then 3 |
| The agent must open PRs and you have **no** branch protection | Reconsider — the self-merge risk is unmitigated |

Options 1 and 2 are the defaults the kit assumes. Options 3 and 4 are
deliberate changes with a prerequisite, not drop-in upgrades.
