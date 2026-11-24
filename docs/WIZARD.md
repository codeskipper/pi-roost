# Wizard design plan

A plan for a host-side provisioning and launch wizard with the look and feel
of the pi coding agent. It guides the user to the best-fit options for
provisioning and launching the pi VM, and lets them pick.

**Status: a first slice of step 1 is built and has had one run on a host.**
See [The first slice](#the-first-slice). The plan is worked out one feature at
a time. Step 1 is designed below, and its route was confirmed by a spike on a
test Mac on 15 November 2026. Later steps are listed but not designed.

The claims about Secretive come from its README, FAQ, issue tracker and
source, and from that spike. The OpenSSH options were checked against the man
pages. The [spikes](#spikes-before-building) list the questions, and
[WIZARD-SPIKE.md](WIZARD-SPIKE.md) has the test plan and its results.

## Steps

| Step | Feature | State |
|---|---|---|
| 1 | Limit GitHub access to chosen repositories with per-repository deploy keys | designed below; [first slice](#the-first-slice) built |
| later | VM creation and provisioning, model-token gateway, egress policy, per-task VMs | not designed |

## Runtime and launcher

The wizard uses pi's own TUI library, `@earendil-works/pi-tui`, so the look is
pi's and not an imitation. The library is an MIT-licensed Node package. Version
1.6.0 needs Node 22.19 or later and has three direct dependencies, pinned to
exact versions. The kit was bash-only before the wizard, so Node is new on the
host.

The wizard is written in TypeScript, and Node runs the `.ts` files directly by
stripping the type annotations. There is no build step. The type checker is a
development tool only and is not installed on the host. TypeScript was chosen
over JavaScript because the wizard cannot be run where it is developed: it
needs the host's Secretive, `gh` and Touch ID, so a checker that finds
mistakes without running the code shortens each round of testing.

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

Homebrew may be managed, for example by Workbrew. There `brew` runs as a
service account, tap trust is shared by the whole Mac, and only administrators
can change it. A standard user may be unable to trust the tap that Tart comes
from, or to install Node system-wide. The launcher has to detect a managed
Homebrew and say what an administrator needs to do, not fail on a permission
error. Found while preparing a test Mac; the detection is not designed yet.

### Finding or installing Node

1. **Look for Node.** On the `PATH`, or installed globally, or a private copy
   from an earlier run. It counts as found only if it is 22.19 or later and
   can load one of the wizard's TypeScript files. An older Node is treated as
   not found and is left untouched.
2. **If found, use it.**
3. **If not found, ask the operator** to choose. Pressing Return takes the
   first:
   - **Private (the default):** a pinned Node in `~/.pi-roost`, not on the
     `PATH`. The download is checked against a SHA-256 pinned in the launcher,
     taken from nodejs.org's published checksums. Deleting the folder removes
     it. It takes about 200 MB.
   - **System-wide:** `brew install node`.
   - **Neither:** stop, and point to the `host/*.sh` scripts.
4. **No answer is stored.** An installed Node is found on the next run, so the
   launcher does not ask again.

In every case the wizard's npm packages go in the `wizard/` folder of the
pi-roost checkout, installed from a lockfile with install scripts disabled. Nothing is installed with
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
the Secure Enclave. The session forwards Secretive's socket. Logging in to the
VM uses a different agent and a key of its own, so neither the login key nor a
personal GitHub key is on the forwarded socket. See
[A separate key for logging in](#a-separate-key-for-logging-in).

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

### A separate key for logging in

**Decided, not built or tested.** Logging in to the VM uses a key made for
that purpose. It is not registered on GitHub or anywhere else.

The problem it solves: `setup.sh` installs every key the login agent holds
into the VM's `authorized_keys`. On a host where that agent holds a personal
GitHub key, the same key opens the VM and reaches GitHub. Seen on the everyday
host: 1Password asks for the GitHub key on each connection to the VM.

- The operator cannot tell a VM login from a GitHub operation in the prompt,
  and can approve git access by mistake.
- The kit's `-git` alias forwards the login agent, so the personal key is in
  reach of the VM for that session.

The design uses two kinds of key, on two agents:

| Key | Opens | Held in | Forwarded to the VM |
|---|---|---|---|
| Login key | the VM only | the login agent | never |
| Deploy keys | one repository each | the git agent | yes |

The operator chooses both agents in the wizard:

- **Git agent:** Secretive is the recommended choice and the one tested. The
  other choice is the per-session agent in [Alternatives](#alternatives),
  which is not designed in detail.
- **Login agent:** 1Password, or the plain `ssh-agent` with a key file, as
  used on the test Mac. Not Secretive when Secretive is the git agent, because
  the login key would then be on the forwarded socket.

A personal GitHub key is not part of this design. It stays wherever the
operator keeps it, for their own use on the host, and the wizard does not move
it. It must not be in the git agent.

What the wizard does:

1. Creates the login key in the chosen agent, named for the VM, for example
   `pi-roost login <vm-name>`.
2. Installs only that public key in the VM's `authorized_keys`, and removes
   any other key found there after asking.
3. Pins the VM's SSH alias to that key, with `IdentityFile` pointing at its
   public key and `IdentitiesOnly yes`, so the agent is asked for that key and
   no other.
4. Replaces the `-git` alias. The forwarded agent becomes the git agent's
   socket, never the login agent.

To confirm before building:

- With 1Password, that pinning the alias makes the prompt name the login key
  and not the GitHub key.
- With 1Password, whether approving the login key also covers other keys for
  that terminal session.
- Whether the 1Password CLI can create the key, or the operator creates it in
  the app.
- That `setup.sh` can install one named key. Today it installs all of them.

### Known limits of this route

- **Notify keys are open to every session.** Any session can read any
  repository whose read key is at Notify, whether or not it was chosen for that
  session. The notification is the only signal. Marking a repository sensitive
  closes this for that repository, at the cost of prompts.
- **The per-repository limit on writes is the user's attention.** A process can
  request a signature for repository B's write key while the user expects a
  prompt for repository A.
- **A write key can push to any unprotected branch.**
- **The prompt does not say what is being signed.** It reads the same for an
  SSH login and for a file signature made with `ssh-keygen -Y sign`, and it
  shows no destination. A process in the VM can ask a key to sign arbitrary
  data behind a prompt that looks like a push. For a deploy key the exposure
  is small: such a signature only counts where that key is registered as a
  signing key.
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
   Secretive, Secretive holds no keys other than pi-roost's deploy keys, and
   the VM's login key is not registered on GitHub. If the VM is opened by a
   GitHub key, set up [a separate login key](#a-separate-key-for-logging-in)
   first.
2. **Pick repositories.** A searchable list from `gh`. Each repository cycles
   through none, read and write. Public repositories offer none and write only.
   A repository can be marked sensitive. Repositories without admin rights are
   greyed out, because adding a deploy key needs admin.
3. **Check write targets.** For each write choice, check branch protection on
   the default branch and warn if it is missing.
4. **Create keys.** One or two keys per repository in Secretive, named so the
   host, repository and access level are readable in the Touch ID prompt, for
   example `github.com owner/repo write`. The prompt shows the name and not
   the destination, so the name carries it. There is no way to create a key
   outside the app, so the wizard tells the user what to create, including
   the three settings under Advanced (protection level, `ecdsa-256`, and the
   attribution), waits, and picks up the new key by comparing the agent's key
   list before and after. An edit to a secret does not reach the agent in
   4.0.0, so the settings have to be right at creation.
5. **Register keys.** Add each public key to its repository with
   `gh repo deploy-key add`, with write allowed only on write keys.
6. **Write guest routing.** Public keys, one host alias per key, and the fetch
   and push URL rewrites. These are routing, not a security boundary.
7. **Launch.** Connect with the login agent and its dedicated login key, and
   the forwarded agent set to Secretive's socket.
8. **Verify.** In the session: only deploy keys are listed; a chosen private
   repository can be fetched; a push to a read-only repository is refused; a
   push to a protected branch is refused.

The wizard also needs a way to list and remove keys, on GitHub and in
Secretive. Deploy keys do not expire.

### The first slice

Built on 22 November 2026: `host/wizard.sh` and the `wizard/` folder. It gives
one VM access to one repository, and can be run again to add another.

Run it on the host, from the pi-roost checkout:

```bash
host/wizard.sh
```

What it does, in order:

1. **Launcher:** checks for the Command Line Tools and Homebrew, finds or
   installs Node, and installs the wizard's packages on the first run.
2. **Checks the host:** Secretive's agent answers, `gh` is signed in, a VM
   alias from `host/setup.sh` exists and answers, and the VM is not opened by
   a key held in Secretive. It lists keys in Secretive made outside the
   wizard, as a note: every key there is in reach of the VM. It warns when the
   VM is opened by a key that is also on the GitHub account.
3. **Keys that are gone:** recorded keys that Secretive no longer holds are
   listed, with an offer to remove them. Removing one deletes its deploy key on
   GitHub, found by the key itself and not by its title, drops it from
   `state.json`, and rewrites the VM's routing. Leaving them is the default. A
   repository whose deploy keys cannot be listed keeps its entries, to try
   again later.
4. **Repository and access:** a list from `gh` that narrows as you type. A
   private repository offers read, or read and write. A public one offers
   write. For write, it warns when the default branch is not protected.
5. **Keys:** the write key is settled before the read key. For each key, it
   first offers the keys in Secretive that were made outside the wizard,
   ranked by whether their label names the repository, so a key made by hand
   can be taken over. When the write key was taken over, it can also serve
   for reading, at the cost of Touch ID on every fetch. Otherwise it shows the
   four values to enter in Secretive and
   waits, with a menu that can open Secretive and copy the name and the key
   attribution to the clipboard. The menu closes by itself when the new key
   appears; the wizard finds it by comparing the agent's key list before and
   after. For a write key it asks for a test signature and tells the user to
   press Deny. A signature that comes back anyway means the key does not
   require authentication, and the wizard refuses it. It also shows the name
   the Touch ID prompt should carry and asks whether it matched, because the
   agent exposes the attribution and not the name. For a key taken over, it
   asks only whether the name clearly identifies the repository.
6. **Registers** each key as a deploy key with `gh repo deploy-key add`,
   unless it is on the repository already. A key there read-only, when write
   was chosen, is replaced after asking.
7. **Writes the routing in the VM,** over the non-forwarding alias.
8. **Checks from inside the VM,** with Secretive's socket forwarded: the keys
   are visible, the login key is not, and the read key can read. Testing the
   write key is offered, since it needs Touch ID.
9. **Finishes** by printing the command for a session with the deploy keys in
   reach, and offers to open it.

It can be interrupted. Each key is recorded as soon as it exists, so a second
run carries on where the first stopped.

What it leaves on the host, all in `~/.pi-roost`:

- `state.json`: the repositories and public keys per VM. No secrets.
- `node`: the private copy of Node, if that was chosen.

What it writes in the VM:

- `~/.ssh/pi-roost/`: one public key file and one `Host` block per key.
- `~/.config/pi-roost/gitconfig`: URL rewrites, so the usual GitHub addresses
  reach the right key. Fetches use the read key and pushes the write key. A
  public repository is fetched over HTTPS with no key.
- One `Include` line at the top of `~/.ssh/config`, one `include.path` entry
  in the global git configuration, and GitHub's host key in `known_hosts` if
  it is missing.

Both generated files are rewritten from `state.json` on every run. They are
routing, not a security boundary.

Limits of this slice:

- **Addresses must end in `.git`.** Git matches rewrite rules by prefix, so a
  rule without the suffix would also catch a repository whose name starts the
  same.
- **A remote with its own push URL is not sent to the write key.** Git ignores
  the push rewrite for such a remote. Remove the separate push URL with
  `git config --unset remote.<name>.pushurl`. Found on the first host run: a
  clone in the VM had one, set by hand earlier.
- **It only removes keys that are gone.** Removing a repository whose keys are
  still in Secretive is done by hand: delete the keys in Secretive, then run
  the wizard to clean up the rest.
- **Your own repositories only.** Organisation repositories are not listed.
- **No separate login key,** and no handling for a managed Homebrew.

How it was tested, and what was not:

- **Type-checked** with strict settings, and 16 unit tests pass. One of them
  runs the generated install script against a scratch home folder and asks
  real `git` where each address would go.
- **Run end to end in the development VM** against stand-ins for `gh`, `ssh`,
  `ssh-add`, `ssh-keygen` and `open`: the full path for a private repository,
  a second run that resumes, a write key at Notify, Escape and Ctrl+C. The
  stand-ins are not in the repository.
- **The launcher's private Node install** was run in the VM: the download
  matched the pinned checksum and that Node ran the wizard's TypeScript.
- **Not tested on Node 22.** Only Node 24 was available.

First run on a host, 22 November 2026, on the everyday host: a public
repository with write access, from the launcher to the check inside the VM.

- The launcher found no Node, installed the private copy and the packages,
  and started the wizard.
- The host checks, the repository list, key creation and the pick-up of the
  new key all worked. The warnings for the two hand-made keys and for the
  GitHub key that opens the VM appeared as intended.
- **The test signature works.** After Deny, `ssh-keygen` reports *agent
  refused operation*. The wizard now passes the check only on that message,
  and treats any other failure as a check that did not finish.
- The key was registered, the routing was written, and the VM saw the keys
  through the forwarded socket. The files in the VM were inspected afterwards
  and match what the unit test expects.
- The write-key test at the end passed: GitHub recognised the key after
  Touch ID.

Second run, the same day: a private repository with read access.

- The read key was created at Notify, registered read-only, and the check
  inside the VM read the repository. Secretive showed a notification and no
  Touch ID prompt.
- Checked afterwards from a session in the VM: the SSH and HTTPS addresses
  ending in `.git` both resolve to the read key, the address without `.git`
  is left alone, and a real `git ls-remote` of the HTTPS address returned the
  repository's head.

Third run, the same day: the private repository again, now with read and
write, and the write key left at Notify on purpose.

- The wizard recognised the read key from the second run and went straight to
  the write key. A run that resumes with an existing key therefore works.
- **A write key at Notify is caught.** The key signed with no Touch ID prompt,
  and the wizard refused it before registering anything.

Fourth run: the write key recreated with Require Authentication.

- The Touch ID prompt showed a wrong name: the intended name followed by the
  attribution text three times. The key's attribution itself was correct, so
  the extra text was in the Name field only. The likeliest cause is the
  attribution being pasted into Name. The wizard could not see this, since the
  agent exposes the attribution and not the name.
- Two changes came out of it, both run against stand-ins only: the clipboard
  menu, and the question after Deny about the name in the prompt.

Changed after these runs:

- **Taking over a key made by hand.** In the first run the wizard listed the
  hand-made pi-roost key as "not set up by this wizard" and asked for a new
  one. That key worked, but the wizard could not use it, so it was deleted and
  replaced. The wizard now offers such keys before asking for a new one, runs
  the same Deny check for a write key, and finds a key already registered on
  GitHub instead of adding it twice. The message about these keys was
  reworded, since it read like a fault.
- **Stale keys are listed** at the start.

Both were run against stand-ins only.

Fifth run, the same day, with those changes: the private repository with read
and write, completed.

- The read key from the second run was reused. A new write key was created
  with the clipboard menu, passed the Deny check and the name question, was
  registered, and passed the write-key test at the end.
- Checked afterwards from a session in the VM: the VM sees the new write key,
  and for this repository a fetch address resolves to the read key and a push
  to the write key.
- The list of recorded keys that are gone from Secretive was not looked at.

Sixth run, the same day: taking over the secretive-notes key, which was made
by hand, for that private repository with read and write.

- The wizard offered the key, but for the read key, since it asked for the
  read key first. The key was taken as the read key, and the wizard then
  asked for a new write key. After cancelling, the key was no longer offered,
  because the wizard now counted it as its own. The question named the role,
  but it was easy to miss.

Changed after that run, and run against stand-ins only:

- The write key is asked for first, and the question explains what each key
  is for.
- When choosing the write key, the repository's recorded read key is offered
  too. That undoes the mix-up above on the next run.
- When the write key was taken over, the read key can be the same key.
- A read key that may ask for Touch ID is tested only after asking.

Seventh run, the same day, with those changes: secretive-notes again, read and
write.

- The key recorded as the read key was offered for the write key, passed the
  Deny check and the name question, and was found already registered on
  GitHub. It was then chosen for reading too. Every step succeeded, and no
  deploy key was added.
- The session the wizard opened at the end was used to continue working in
  the VM. From there, the VM saw the key, and fetch and push addresses for the
  repository both resolved to it.
- The VM's hand-made route for this repository was then removed. The notes
  clone now uses the usual GitHub address and the wizard's routing. Nothing
  made by hand is left in the VM's SSH configuration.

The list of keys gone from Secretive appeared at the start of that run.
Removing them was added afterwards, on a branch of its own, and run on the
everyday host the same day: the deploy key for the fork was removed from
GitHub, and the VM's routing for it was gone afterwards. The confusing part
was the deploy key's title, "pi-roost pi-roost write": an early title format
that names the VM, which is also called pi-roost, so it read as if it belonged
to the pi-roost repository. The wizard's messages now lead with the repository
and the key's role, and give the title only as an aside. Its
entries were not all read. The one noticed was most likely the deleted write
key for the public fork, `codeskipper/secretive`, which reads much like
secretive-notes. The entries now read as "owner/name, write key".

Changed after that run: the deploy key's title on GitHub, which read "pi-roost
pi-roost write" for a VM named pi-roost, is now "pi-roost wizard, VM <name>,
<access>".

### To do

- [ ] Run the first slice on the everyday host and record what needs changing.
  Seven runs done on 22 November 2026. Every path of the first slice has now
  run on a host.
- [ ] Confirm the four open points for
  [a separate login key](#a-separate-key-for-logging-in), then move the
  everyday host's VM off the personal GitHub key.
- [ ] Decide the default gate for private reads, notification only or Touch
  ID, after initial testing. See
  [the balance](#the-balance-notify-for-routine-touch-id-for-significant).
  The finding for spike 7 bears on this: a Notify key raises a time-sensitive
  notification on every fetch.
- [x] Run [WIZARD-SPIKE.md](WIZARD-SPIKE.md) and record the results. Done on a
  test Mac, 15 November 2026.
- [x] Repeat phase 4 of the spike on the everyday host, with 1Password as the
  login agent. Passed on 15 November 2026.
- [x] Test whether the wizard can confirm a write key's protection level with
  a test signature. It can, for a key that requires authentication: Deny gives
  *agent refused operation*, and a key at Notify signs with no prompt. Both
  shown on the everyday host on 22 November 2026.
- [x] Fill the gaps in the spike results. Done on 15 November 2026.

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

Also found:

- **The destination is shown in the notification, not in the Touch ID
  prompt.** The prompt's text is fixed in the code and has no setting. A
  string that would add *to connect to "target"* exists but nothing uses it.
  The host name comes from `~/.ssh/known_hosts` on the Mac running Secretive;
  without an entry it reads as an unknown host.
- **Secretive now offers more than one key type,** so the wizard has to ask
  for the 256-bit ECDSA type.

#### Results of the spike

Run on a test Mac on 15 November 2026 with Secretive 4.0.0. The full record is
in [WIZARD-SPIKE.md](WIZARD-SPIKE.md#results-15-november-2026).

| # | Result |
|---|---|
| 1 | Confirmed. Only Secretive's keys were visible in the VM. Tested on a test Mac with a plain `ssh-agent` as the login agent, and on the everyday host with 1Password. |
| 2 | Confirmed. The Touch ID prompt and the notification both name the secret. |
| 4 | The secret's name is readable from the key comment. The protection level is not. |
| 5 | Confirmed. An unlock covers one key. |
| 6 | Confirmed. The requester shows as "Terminal", also through forwarding. The notification names the destination, `git@github.com`, including for a request made in the VM; the Touch ID prompt does not. |
| 8 | Confirmed. GitHub accepts the keys as deploy keys. |
| 9 | Confirmed. Fetch and push used the intended keys. A fetch raises one notification; a push raises one Touch ID prompt and one notification. |

Spikes 3 and 7 were checked afterwards on the installed app. There is no way
to create a key outside the app's own window. System Settings has one
notification entry for Secretive, "SecretAgent", with no time-sensitive
switch, so read notifications cannot be quietened on their own.

What the run adds to the design:

- **The key comment shows the secret's name,** which is useful for display.
  It is not a safe way to find a key: it changes with the attribution, and an
  edit does not reach the agent in 4.0.0. See
  [Upstream to watch](#upstream-to-watch).
- **The wizard cannot check that a write key requires authentication,** so it
  has to tell the user which level to choose and trust the answer.
- **A slow approval fails the git command.** GitHub closes the connection
  while the prompt waits. An agent that retries raises another prompt.
- **An unlock removes the gate for that key.** During the window, any process
  in the VM can use the key, with or without the routing aliases. Choosing a
  duration also costs a second Touch ID.
- **The key comment carries the Mac's hostname** into the VM, unless a Key
  Attribution is set. A custom attribution replaces the whole comment, name
  included. The wizard should ask for the attribution to be the secret's name,
  with dashes for spaces. That keeps a readable label and leaves the hostname
  out. A space typed in the attribution is kept as a space.
- **The default protection level is Notify.** Level, key type and attribution
  are under Advanced in the creation window, with defaults of Notify,
  `ecdsa-256` and no attribution. A write key created without opening Advanced
  pushes with no Touch ID, and the wizard cannot read the level to catch it.
- **A test signature might catch it. Not tested.** After a write key is
  created, the wizard asks it to sign something and tells the user to press
  Deny. A signature that returns at once, with no prompt, means the key is at
  Notify, and the wizard rejects it.
- **The secret's name can stand in for the destination.** A name with a dot
  and a slash, `rare.saker/test`, was accepted, shown in full in the Touch ID
  prompt, and kept as-is in the key comment. Only spaces change, to dashes. A
  deploy key serves one repository, so a name such as
  `github.com owner/repo write` says more than the destination would. It is a
  label the user typed, not something Secretive verified.

### Upstream to watch

Items in Secretive's repository that bear on this design. Read on 15, 21 and
22 November 2026. The maintainer's one comment on a command-line tool is from
March 2023: *"You could plausibly expose API to create new keys."*

| Item | State | Effect here |
|---|---|---|
| [Issue #328](https://github.com/maxgoedjen/secretive/issues/328), a command-line interface | open since January 2022 | none until something is merged |
| [Issue #854](https://github.com/maxgoedjen/secretive/issues/854), the requesting command and folder in the approval prompt | open since October 2026 | would help: the prompt would say more about what is asking |
| [Issue #789](https://github.com/maxgoedjen/secretive/issues/789), edits to a secret not taking effect | open; fixed on `main` by [PR #834](https://github.com/maxgoedjen/secretive/pull/834) on 18 November 2026, not yet released | affects 4.0.0, below |
| [PR #797](https://github.com/maxgoedjen/secretive/pull/797), `create-secret` and other commands on the app's binary | closed unmerged, 18 November 2026 | none |
| [PR #862](https://github.com/maxgoedjen/secretive/pull/862), a `secretive` tool with key management on the agent's socket | closed unmerged, 18 November 2026 | none; a lesson, below |

Both pull requests were closed as appearing to be AI-generated. Secretive's
contributing guide says code generated with AI tools is not accepted, so no
command-line tool is coming from either. Keys are created by hand in the app.

**Edits do not reach the agent in 4.0.0.** After a secret's name or
attribution is edited in the app, the change is stored, but SecretAgent goes
on serving the old key comment until it is restarted. Seen on the everyday
host on 22 November 2026: a corrected attribution did not show in
`ssh-add -L`. A comment on issue #789 gives the cause: the store compares
secrets by ID only, so an edit does not count as a change and the agent is
not told to reload. For this design:

- The attribution has to be right when the key is created.
- The wizard should not find a new key by its comment. It compares the
  agent's key list before and after the user creates the key, and takes the
  one that appeared.

**The lesson from PR #862.** It put key management on the agent's socket,
which is the socket this design forwards to the VM. Its code was read on 21
November 2026, and not run. Creating and renaming a key were guarded only by
comparing the caller's user ID with the agent's, with no authentication. A
forwarded request reaches the socket through the user's own `ssh` process, so
it would pass. A process in the VM could have renamed a key, and this design
relies on the name shown in the Touch ID prompt. Any future release that adds
management operations to the agent's socket needs this check before its
socket is forwarded.

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
- Secretive issues [#328](https://github.com/maxgoedjen/secretive/issues/328),
  [#789](https://github.com/maxgoedjen/secretive/issues/789) and
  [#854](https://github.com/maxgoedjen/secretive/issues/854), and pull requests
  [#797](https://github.com/maxgoedjen/secretive/pull/797),
  [#834](https://github.com/maxgoedjen/secretive/pull/834) and
  [#862](https://github.com/maxgoedjen/secretive/pull/862): descriptions and
  comments, and the agent code on #862's branch, for the upstream items.
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
