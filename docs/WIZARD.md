# Wizard design plan

A plan for a host-side provisioning and launch wizard with the look and feel
of the pi coding agent. It guides the user to the best-fit options for
provisioning and launching the pi VM, and lets them pick.

**Status: design, nothing built.** The plan is worked out one feature at a
time. Step 1 is designed below. Later steps are listed but not designed.

The claims about Secretive come from its README, FAQ, issue tracker and
source. The OpenSSH options were checked against the man pages. Nothing has
been run. The [spikes](#spikes-before-building) list what has to be confirmed
first, and [WIZARD-SPIKE.md](WIZARD-SPIKE.md) is the plan for running them.

## Steps

| Step | Feature | State |
|---|---|---|
| 1 | Limit GitHub access to chosen repositories with per-repository deploy keys | designed below |
| later | VM creation and provisioning, model-token gateway, egress policy, per-task VMs | not designed |

## Runtime and launcher

The wizard uses pi's own TUI library, `@earendil-works/pi-tui`, so the look is
pi's and not an imitation. The library is an MIT-licensed Node package. Version
1.5.2 needs Node 22.19 or later and has three direct dependencies, pinned to
exact versions. The kit is bash-only today, so Node is new on the host.

Node is optional. The wizard is a front end over the `host/*.sh` scripts, and
an operator who does not want Node runs those scripts directly.

The wizard needs Node to start, so a small bash launcher runs first, with
plain-text prompts. The pi look begins once the wizard itself is running.

### Assumed on the host

The Xcode Command Line Tools and Homebrew are assumed to be installed. The
launcher checks for both. If one is missing it says so, suggests how to
install it, and stops. It does not install either itself.

| Missing | Suggestion |
|---|---|
| Command Line Tools | `xcode-select --install` |
| Homebrew | the `Homebrew.pkg` installer from <https://github.com/Homebrew/brew/releases/latest> |

### Finding or installing Node

1. **Look for Node.** On the `PATH`, or installed globally. It counts as found
   only if it is 22.19 or later. An older Node is treated as not found and is
   left untouched.
2. **If found, use it.**
3. **If not found, ask the operator** to choose:
   - **System-wide:** `brew install node`.
   - **Private:** a pinned Node in a folder pi-roost owns, not on the `PATH`.
     The download is verified against its published checksum. Deleting the
     folder removes it.
   - **Neither:** stop, and point to the `host/*.sh` scripts.
4. **Remember the answer,** so the launcher does not ask on every run.

In every case the wizard's npm packages go in pi-roost's own folder, installed
from a lockfile with install scripts disabled. Nothing is installed with
`npm install -g`. The operator's choice is only about where the runtime lives.
The wizard needs no network access for its packages once they are installed.

The cost of using an existing Node: the wizard runs on whatever version each
host has, above the minimum.

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

Secretive has protection levels, fixed when a key is created. The plan uses
two of them:

- **Notify:** signs without authentication and shows a notification.
- **Require Authentication:** each signature needs Touch ID, an Apple Watch or
  the password. After authenticating, the notification offers to leave the key
  unlocked for a set time.

A third level, **Current Biometrics**, accepts Touch ID only, with no password
fallback. The key becomes unusable if the enrolled fingerprints change. It is
not used in this plan.

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
- **Secretive must hold deploy keys only.** The route depends on the login
  agent and the forwarded agent being different. If a user keeps a personal
  GitHub key in Secretive, or uses Secretive to log in to the VM, that key is
  on the forwarded socket and in reach of the VM, gated only by its own
  protection level. The wizard has to detect this and warn or refuse.
- **`setup.sh` prefers Secretive as the login agent** when 1Password is absent.
  On such a host, installing Secretive for deploy keys and re-running
  `setup.sh` would make it the login agent too. The wizard has to set the
  login agent explicitly.

If these are not acceptable, the stricter design is in
[Alternatives](#alternatives).

### Wizard flow

1. **Check prerequisites.** The launcher has already checked the Command Line
   Tools, Homebrew and Node. Here: Secretive installed and its agent running,
   `gh` signed in on the host, the VM reachable. Also: the login agent is not
   Secretive, and Secretive holds no keys other than pi-roost's deploy keys.
2. **Pick repositories.** A searchable list from `gh`. Each repository cycles
   through none, read and write. Public repositories offer none and write only.
   A repository can be marked sensitive. Repositories without admin rights are
   greyed out, because adding a deploy key needs admin.
3. **Check write targets.** For each write choice, check branch protection on
   the default branch and warn if it is missing.
4. **Create keys.** One or two keys per repository in Secretive, named so the
   repository and access level are readable in a prompt, for example
   `pi-roost owner/repo write`. The source shows no way to create a key
   outside the app, so the wizard tells the user what to create, waits, and
   picks up the new public key file.
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
  The finding for spike 7 bears on this: a Notify key raises a time-sensitive
  notification on every fetch.
- [ ] Run [WIZARD-SPIKE.md](WIZARD-SPIKE.md) on the host and record the
  results.

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

#### Findings from Secretive's source

Read from the main branch on 18 October 2026. The latest release is v4.0.0,
from September 2026; which release contains each behaviour was not checked.
These are readings of code, to be confirmed on the host.

| # | Finding |
|---|---|
| 2 | Yes. The Touch ID prompt reads *sign a request from "app" using secret "name"*. The notification is titled *Signed Request from app* with *Using secret name*. |
| 3 | No way found. There is no command-line tool, URL scheme or automation hook. |
| 4 | Not settled. The level is recorded with the key, and may read as unknown. Public key files are named by fingerprint, not by secret name. |
| 5 | Per key. Unlocks are stored per secret, for 5 minutes, 1 hour or 24 hours. |
| 6 | The app at the top of the requesting process chain on the host, such as the terminal app. A process in the VM cannot be identified. |
| 7 | No. Every signature raises a notification at the time-sensitive level, for every protection level. Turning Secretive's notifications off would also hide the "Leave Unlocked" offer, which is in the notification. |

Also found: the prompt and notification can name the destination, as in *to
connect to "target"*. Whether that works for a forwarded request is part of
the spike plan. Secretive now offers more than one key type, so the wizard
has to ask for the 256-bit ECDSA type.

Spikes 1, 8 and 9 can only be answered on the host.

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

- Secretive's source, main branch at commit `164aacc` (18 October 2026):
  `AuthenticationHandler.swift`, `Notifier.swift`, `CreationOptions.swift`,
  `SigningRequestProvenance.swift`, `URLs.swift` and the localised strings.
- Secretive [README](https://github.com/maxgoedjen/secretive) and
  [FAQ](https://github.com/maxgoedjen/secretive/blob/main/FAQ.md): Secure
  Enclave storage, Touch ID, notifications, agent forwarding, public key files,
  256-bit EC keys only.
- Secretive issues [#251](https://github.com/maxgoedjen/secretive/issues/251)
  and [#572](https://github.com/maxgoedjen/secretive/issues/572), and
  discussion [#474](https://github.com/maxgoedjen/secretive/discussions/474):
  the "leave unlocked" window, and the two protection levels being fixed at
  creation.
- pi's TUI library, `@earendil-works/pi-tui` 1.5.2: its `package.json` for the
  Node version and dependencies, read from the copy installed with pi.
- `man ssh_config`, `ForwardAgent`: "an explicit path to an agent socket".
- [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys),
  as cited in GITHUB-ACCESS-SCOPE.md; not re-read for this plan.
