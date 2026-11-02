# Limiting the agent's GitHub access

Status: options for investigation; no credential or configuration changes implemented by this document.

## Goal

The host-held credential migration limits **when** the VM can use GitHub credentials. The next step is to limit **which repositories and actions** it can access.

Forwarding a personal GitHub SSH key exposes the repositories that identity can access for the duration of the forwarded session. The default and `-git` aliases control availability, not repository scope.

SSH password authentication into the VM is a separate choice. Retaining it does not prevent repository-scoped GitHub access.

## Options at a glance

| Option | Repository scope | Write access | Operational fit |
|---|---|---|---|
| No GitHub credentials in VM | No authenticated private-repository access | Publish from host only | Strongest separation |
| Read-only deploy key | One repository per key | No | Clone and fetch only |
| Write-enabled deploy key | One repository per key | Yes | Smallest change to current SSH workflow |
| Dedicated bot account | Repositories granted to that account | According to role | Several repositories under one identity |
| Fine-grained personal access token | Selected repositories under one resource owner | Configurable permissions | HTTPS Git and GitHub API |
| GitHub App | Selected repositories and installation permissions | Configurable permissions | Short-lived automation; more setup |

Public repositories remain publicly readable without credentials. These controls do not block anonymous network access.

## 1. Keep publishing on the host

Run the coding agent without any forwarded agent or GitHub token. Transfer changes using patches, Git bundles, or a separate host checkout, then review and push from the host.

A useful variation gives the VM read-only deploy keys so it can fetch private repositories, while all publishing remains on the host.

**Choose this when:** the agent should produce code but never publish independently.

## 2. Per-repository SSH deploy keys

A deploy key is attached to a repository rather than a personal GitHub account.

- Read-only by default; write access can be enabled explicitly.
- Use a separate key for each repository; GitHub does not allow reusing one deploy key across multiple repositories.
- Keep private keys on the host, not in the VM.
- Forward only the key or keys needed for the current project.
- Deploy keys do not expire automatically; plan rotation and revocation.

### Critical boundary: the forwarded socket

Use a dedicated host-side SSH agent/socket containing only the allowed project keys, or another mechanism that verifiably restricts which identities the forwarded socket exposes.

If the forwarded socket also exposes a personal account key, the VM can still authenticate as that broader identity. Merely adding a deploy key does not reduce access.

`IdentityFile`, `IdentitiesOnly`, repository remote URLs, and guest SSH aliases help select keys during normal operation. They are **not security boundaries against the coding agent**, which can change its own SSH invocation or configuration.

Do not assume that choosing an `IdentityAgent` for inbound authentication restricts the forwarded identity set. Verify which socket is actually forwarded and what it exposes. With OpenSSH, `ForwardAgent` can select an explicit agent socket; the final configuration should be tested against the host's installed SSH version and chosen agent.

With 1Password or Secretive, investigate supported identity filtering or a dedicated agent arrangement before settling on an implementation. Do not copy a host-managed non-exportable key into a different agent merely to simplify setup.

**Choose this when:** keeping the current SSH Git workflow is desirable, but access should be confined to particular projects.

## 3. Dedicated GitHub bot account

Use a separate account with access only to the required repositories. Keep its SSH key on the host and expose it through an isolated agent.

Advantages:

- One identity can cover several repositories.
- Repository roles control its permissions.
- Actions are separated from the personal account.

Trade-offs:

- Account administration and potentially organization seat costs.
- Account-level privileges must remain minimal.
- Branch protections are still needed to constrain writes.
- Forwarding a personal key alongside the bot key defeats the intended isolation.

**Choose this when:** managing several repositories through one dedicated identity is simpler than maintaining deploy keys per repository.

## 4. Fine-grained personal access token

A fine-grained PAT can restrict access to:

- A single resource owner.
- Selected repositories.
- Specific permissions, such as contents read/write or pull-request access.
- An expiration date.

Tokens support Git over **HTTPS**, not SSH authentication. Organization policies, approval requirements, and endpoint support can affect usability.

For this VM's host-held credential model, prefer keeping the token on the host. Passing it to the VM makes it readable by the agent, including when supplied through environment variables. A scoped token limits damage but does not become secret from the process using it.

A host-side broker could perform allowed operations without handing the token to the VM, but that is additional infrastructure and is not implemented by pi-roost. If implemented, the broker must enforce repository and action restrictions itself.

A PAT acts as its owner, so account privileges and applicable branch-protection bypass rules matter.

**Choose this when:** granular API permissions or HTTPS Git are needed and the token-handling trade-off is acceptable.

## 5. GitHub App

Install a GitHub App on selected repositories and issue narrowly permissioned installation tokens.

- Keep the App private key on the host.
- Installation tokens expire after one hour.
- Token creation can narrow repositories and permissions within the installation's grants.
- The VM receives only the short-lived token if direct API access is necessary; it can still copy and use that token until expiry or revocation.
- The App is a separate identity rather than the personal account.

**Important:** pull-request write access can permit merging. "Can open a PR" does not automatically mean "cannot merge a PR." Required reviews and applicable rules without bypass are essential.

**Choose this when:** automated PR/API operations justify more setup and short-lived, repository-scoped credentials are desirable.

See [PR-OPTIONS.md](PR-OPTIONS.md) and [APP-TOKEN.md](APP-TOKEN.md) for the repository's existing discussion and design.

## Protect writes within an allowed repository

Repository-scoped credentials limit which project is reachable; they do not make writes to that project safe.

Use GitHub rulesets or branch protection where available on the repository's plan:

- Require pull requests and approving reviews for `main` and other sensitive branches.
- Require status checks.
- Block force pushes and branch deletion.
- Verify that the agent's actual identity cannot bypass the relevant rules.
- Review workflow-file changes and other automation that can access repository secrets.

Test the rules using the exact credential intended for the agent. Do not infer enforcement from the rule's existence alone.

## Credential scope is not an exfiltration firewall

An agent allowed to read private code can copy it elsewhere if unrestricted network access remains available. Similarly, host files shared into the VM remain reachable regardless of GitHub permissions.

Egress control, shared-folder minimization, and treatment of sensitive code are separate concerns. GitHub access restrictions also do not relocate Pi's model-provider token; see [BROKERING.md](BROKERING.md).

## Recommended path for this setup

Start with per-repository deploy keys while preserving host-held credentials:

1. Inventory repositories the agent actually needs.
2. Decide whether each needs fetch-only or push access.
3. Create one deploy key per repository, preferably read-only initially.
4. Store private keys on the host.
5. Establish a dedicated forwarding socket that exposes only the intended project identity set.
6. Keep the default VM alias non-forwarding.
7. Use short forwarded sessions for repository operations.
8. For write-enabled keys, protect sensitive branches and leave PR creation/review on the host initially.
9. Revoke unnecessary existing access only after the replacement is tested.

This changes the effective grant from **"my GitHub account during this session"** to **"these repositories during this session."**

## Investigation and acceptance checklist

- [ ] List required repositories and minimum operations for each.
- [ ] Choose read-only deploy keys, write-enabled deploy keys, or another option above.
- [ ] Confirm host-agent support for a restricted forwarding socket.
- [ ] Check effective host SSH configuration, including wildcard settings and connection multiplexing.
- [ ] In a fresh forwarded VM session, inspect `ssh-add -l` and confirm only intended identities are exposed.
- [ ] Verify access to an allowed private repository.
- [ ] Verify denial for a controlled private repository outside the allowlist. Public repositories are not a useful negative test.
- [ ] For read-only credentials, verify that pushing is rejected, using a safe test repository/branch.
- [ ] For write-enabled credentials, verify branch protections reject prohibited operations using a safe test.
- [ ] In a fresh default/non-forwarding session, verify there is no usable GitHub agent capability or resident token.
- [ ] Disconnect the forwarding session and verify its capability is no longer available. Account for other open sessions and multiplexed SSH connections.
- [ ] Document key ownership, repository mapping, rotation, and revocation procedures.

Avoid printing private keys or tokens into terminal output or agent session logs during testing.

## Sources and related documentation

GitHub documentation consulted when preparing these options; re-check current details before implementation:

- [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Generating GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

Related pi-roost docs:

- [CREDENTIALS.md](CREDENTIALS.md)
- [SECURITY.md](SECURITY.md)
- [PR-OPTIONS.md](PR-OPTIONS.md)
- [APP-TOKEN.md](APP-TOKEN.md)
- [BROKERING.md](BROKERING.md)
