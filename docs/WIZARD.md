# Wizard design plan

A plan for a host-side provisioning and launch wizard with the look and feel
of the pi coding agent. It guides the user to the best-fit options for
provisioning and launching the pi VM, and lets them pick.

**Status: design, nothing built.** The plan is worked out one feature at a
time. Step 1 is designed below. Later steps are listed but not designed.

The claims about Secretive come from its README, FAQ and issue tracker. The
OpenSSH options were checked against the man pages. Nothing has been run. The
[spikes](#spikes-before-building) list what has to be confirmed first.

## Steps

| Step | Feature | State |
|---|---|---|
| 1 | Limit GitHub access to chosen repositories with per-repository deploy keys | designed below |
| later | VM creation and provisioning, model-token gateway, egress policy, per-task VMs | not designed |

The TUI stack is also undecided. pi's TUI library is an MIT-licensed Node
package, so matching the look means Node on the host. The kit is bash-only
today.

## Step 1: GitHub access per repository

The priority from the README: forwarding a personal SSH key makes every
repository that key can reach available during a session. This step replaces
it with one deploy key per repository, held on the host. Background and the
other options are in [GITHUB-ACCESS-SCOPE.md](GITHUB-ACCESS-SCOPE.md).

### Decision: Secretive first

Deploy keys live in [Secretive](https://github.com/maxgoedjen/secretive), in
the Secure Enclave. The session forwards Secretive's socket. 1Password stays as
the agent for logging in to the VM, so the personal key is never on the
forwarded socket.

Why this route first:

- Keys cannot be exported, even by the host.
- Touch ID can gate individual signatures.
- No new infrastructure: `ForwardAgent` accepts an explicit socket path.

What it does not do: Secretive's socket offers every key it holds. A session
can list all deploy keys and ask for a signature from any of them. The
repositories chosen for a session set up routing in the guest; they do not
restrict the socket.

### The balance: notify for routine, Touch ID for significant

Secretive has two protection levels, fixed when a key is created:

- **Notify:** signs without authentication and shows a notification.
- **Require Authentication:** each signature needs Touch ID, an Apple Watch or
  the password. After authenticating, the notification offers to leave the key
  unlocked for a set time.

The plan uses both, so that prompts are rare and mean something:

| Action | Gate | Reason |
|---|---|---|
| Clone or fetch a public repository | none | needs no key |
| Clone or fetch a private repository | notification only | frequent and low-stakes; the agent was given this code |
| Clone or fetch a repository marked sensitive | Touch ID | the user chose to gate reads |
| Push | Touch ID | changes something outside the VM |
| Push to a protected branch | refused by GitHub | a rule, not a prompt |
| Create, register or remove a key | done by the wizard on the host | never from the VM |

This needs **two deploy keys for a repository with write access**: a read-only
key at Notify and a write key at Require Authentication. Git in the guest
fetches with the first and pushes with the second, using a separate push URL.
A read-only repository has the one key.

The target for a normal session: no Touch ID until the first push.

**To do: decide the default gate for private reads.** The table above assumes
notification only, with Touch ID as the per-repository opt-in. The other
choice is Touch ID by default, with notification only as the opt-out. The
decision is deferred until after initial testing.

Keeping prompts down:

- **Exact routing in the guest.** GitHub accepts any deploy key it knows, then
  refuses the repository. A wrong key therefore costs a signature, and a
  prompt. Each repository gets its own host alias pinned to its key.
- **No background fetches** in the guest.
- **Short unlock windows** for write keys, for a burst of pushes.
- **Branch protection** carries the weight for `main`, so the push prompt does
  not have to.

### Known limits of this route

- **Notify keys are open to every session.** Any session can read any
  repository whose read key is at Notify, whether or not it was chosen for that
  session. The notification is the only signal. Marking a repository sensitive
  closes this for that repository, at the cost of prompts.
- **The per-repository limit on writes is the user's attention.** A process can
  request a signature for repository B's write key while the user expects a
  prompt for repository A.
- **A write key can push to any unprotected branch.**
- **Read access is not an exfiltration limit.** The VM has no egress policy.

If these are not acceptable, the stricter design is in
[Alternatives](#alternatives).

### Wizard flow

1. **Check prerequisites.** Secretive installed and its agent running, `gh`
   signed in on the host, the VM reachable.
2. **Pick repositories.** A searchable list from `gh`. Each repository cycles
   through none, read and write. Public repositories offer none and write only.
   A repository can be marked sensitive. Repositories without admin rights are
   greyed out, because adding a deploy key needs admin.
3. **Check write targets.** For each write choice, check branch protection on
   the default branch and warn if it is missing.
4. **Create keys.** One or two keys per repository in Secretive, named so the
   repository and access level are readable in a prompt, for example
   `pi-roost owner/repo write`.
5. **Register keys.** Add each public key to its repository with
   `gh repo deploy-key add`, with write allowed only on write keys.
6. **Write guest routing.** Public keys, one host alias per key, and the fetch
   and push URL rewrites. These are routing, not a security boundary.
7. **Launch.** Connect with the login agent set to 1Password and the forwarded
   agent set to Secretive's socket.
8. **Verify.** In the session: only deploy keys are listed; a chosen private
   repository can be fetched; a push to a read-only repository is refused; a
   push to a protected branch is refused.

The wizard also needs a way to list and remove keys, on GitHub and in
Secretive. Deploy keys do not expire.

### To do

- [ ] Decide the default gate for private reads, notification only or Touch
  ID, after initial testing. See
  [the balance](#the-balance-notify-for-routine-touch-id-for-significant).

### Spikes before building

Each of these can change the design. They are in order of impact.

| # | Question | If the answer is no |
|---|---|---|
| 1 | Does forwarding Secretive's socket, with 1Password as the login agent, show only Secretive's keys in the VM? | the route does not work as planned |
| 2 | Does the Touch ID prompt or notification name the key? | the user cannot tell which repository they are approving |
| 3 | Can a key be created without the Secretive app, at a chosen protection level? | the wizard walks the user through the app and picks up the new public key file |
| 4 | Can the wizard read a key's protection level? | it cannot confirm that write keys require authentication |
| 5 | Does "leave unlocked" apply to one key or to all? | an unlock for one repository opens the others |
| 6 | What does the prompt show as the requester for a forwarded request? | expected to be the host's `ssh`, which tells the user little |
| 7 | Can Notify notifications be kept quiet without hiding the Touch ID ones? | reads are noisy, or the signal is lost |
| 8 | Does GitHub accept the Secure Enclave's 256-bit EC keys as deploy keys? | the route does not work |
| 9 | Do fetch and push use the intended key with the URL rewrites, with no extra signatures? | spurious prompts |

### Alternatives

- **Per-session agent.** The wizard starts an empty `ssh-agent` for each
  session, loads only the chosen keys and forwards its socket. The limit is
  structural, not a matter of attention. The keys must be exportable, so they
  cannot be in the Secure Enclave; 1Password could hold them. The gate is at
  session start, and use within the session is silent. This is the fallback if
  spike 1, 2 or 8 fails.
- **Filtering proxy in front of Secretive.** Passes through only the chosen
  keys, which would give both the structural limit and Secure Enclave keys. No
  existing tool has been looked for; it may need building.

## Sources

- Secretive [README](https://github.com/maxgoedjen/secretive) and
  [FAQ](https://github.com/maxgoedjen/secretive/blob/main/FAQ.md): Secure
  Enclave storage, Touch ID, notifications, agent forwarding, public key files,
  256-bit EC keys only.
- Secretive issues [#251](https://github.com/maxgoedjen/secretive/issues/251)
  and [#572](https://github.com/maxgoedjen/secretive/issues/572), and
  discussion [#474](https://github.com/maxgoedjen/secretive/discussions/474):
  the "leave unlocked" window, and the two protection levels being fixed at
  creation.
- `man ssh_config`, `ForwardAgent`: "an explicit path to an agent socket".
- [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys),
  as cited in GITHUB-ACCESS-SCOPE.md; not re-read for this plan.
