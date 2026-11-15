# Wizard spike plan

Hands-on checks for step 1 of [WIZARD.md](WIZARD.md): per-repository deploy
keys held in Secretive, with Secretive's socket forwarded to the VM.

The question: **can a VM session use deploy keys held in Secretive, and only
those, with Touch ID on pushes and no more prompts than expected?**

Run the phases in order. Each has a pass condition. Record what you see even
when it passes, because several phases ask for the exact wording of a prompt.
A negative result is a valid outcome.

The plan was run once, on a test Mac, on 15 November 2026. The outcome is in
[Results](#results-15-november-2026). The steps below include the corrections
that run produced.

Phases 0 to 4 run on the **host Mac**. Phases 5 and 6 run in the VM.

## Where to run this

A separate test Mac with the whole kit set up is the better place, if one is
available. The plan can also run on your everyday host.

On a test Mac:

- Nothing on your everyday host is touched.
- You see what a new user sees: no Secretive and no existing SSH
  configuration.
- It needs Apple silicon, for Tart, and a Touch ID sensor. Without a sensor
  Secretive falls back to the password, and the prompts cannot be judged.
- It needs the kit set up end to end: Tart, a provisioned VM, the SSH aliases
  and `gh` signed in.
- For logging in to the VM, use a throwaway key in the plain `ssh-agent` that
  macOS already runs. 1Password is not needed. This tests the same two-agent
  mechanism, but not the 1Password and Secretive pairing; the repeat of phase
  4 on your everyday host covers that.
- Do not use Secretive as the login agent as well. The login key would then
  sit on the forwarded socket, and phase 4 could not show that the two agents
  are kept apart.

The steps for a test Mac, including the login key, are in
[Preparing a fresh test Mac](#preparing-a-fresh-test-mac).

A pass on a test Mac shows the design works. Phase 4 also depends on the
host's own SSH configuration, so **repeat phase 4 on your everyday host**
once Secretive is installed there. It is one `ssh` command with its options on
the command line, and it changes nothing.

On your everyday host, the plan:

- installs Secretive, which adds a background agent that starts at login;
- creates three keys in the Secure Enclave, two test repositories on GitHub
  and one working folder;
- uses no `sudo`, and does not change 1Password, your existing keys, your
  `~/.ssh/config` or the kit's aliases.

Two things could disrupt it:

- **Secretive's setup offering to edit your shell or SSH configuration.**
  Accepting makes Secretive the default SSH agent, and `git` and `ssh` stop
  using your current one until it is reverted. Skip that step.
- **`GIT_SSH_COMMAND` left set** after phase 3. The phase ends by unsetting it.

Throughout, replace `OWNER` with your GitHub login and `VM` with the kit's
non-forwarding alias for the VM.

## Preparing a fresh test Mac

Skip this section on a host where the kit is already set up. It takes a Mac
with nothing installed to the point where phase 0 begins. The kit's own steps
are described in [WORKFLOW.md](WORKFLOW.md); this is the same sequence with
the choices the spike needs.

**1. Command Line Tools and Homebrew.**

```bash
xcode-select --install
```

Install Homebrew with the `Homebrew.pkg` installer from
<https://github.com/Homebrew/brew/releases/latest>, then open a new terminal.

**2. Tart and the GitHub CLI.**

```bash
brew tap openai/tools
brew trust --formula openai/tools/softnet
brew install openai/tools/tart gh
gh auth login
```

Homebrew 6 and later load a formula from a non-official tap only if it is
trusted. Naming `openai/tools/tart` in the install command trusts that formula,
but not `softnet`, which it depends on and which comes from the same tap. The
`brew trust` line covers it. Trusting the one formula is narrower than
`brew trust openai/tools`, which accepts everything the tap publishes now and
later.

**If Homebrew is managed by Workbrew,** `brew` runs as a `workbrew` service
account and the Mac has one trust store shared by all its users. `brew trust`
is then limited to administrators, and there is no `~/.homebrew` folder in
your home. Run the trust command from an administrator account, or have the
tap added to an Allowed Taps policy in Workbrew, which trusts it as well. See
[How Workbrew handles Homebrew Tap trust](https://workbrew.com/docs/how-workbrew-handles-homebrew-tap-trust).

`gh` is not one of the kit's requirements, but the spike uses it on the host
to create the test repositories and register the deploy keys.

**3. The kit.**

```bash
git clone https://github.com/codeskipper/pi-roost.git && cd pi-roost
```

**4. The VM.** This clones the base image and boots it. The first run
downloads the image, which is large.

```bash
host/create-vm.sh
```

**5. A throwaway login key,** in the `ssh-agent` that macOS already runs. Do
not add this key to GitHub. It only opens the VM.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/pi-roost-spike-login -C pi-roost-spike-login
ssh-add ~/.ssh/pi-roost-spike-login
```

**6. Host-side setup.** It asks once for the VM's password, which is `admin`
on the Cirrus Labs base images.

```bash
host/setup.sh --identity-agent "$SSH_AUTH_SOCK" --tart-ip
```

Pass `--identity-agent` explicitly. Without it, `setup.sh` prefers Secretive's
socket over the plain agent whenever Secretive is installed.

Pass `--tart-ip` on a VM that has not been provisioned yet. Without it,
`setup.sh` connects to `<vm-name>.local`, a name the VM only takes when
`provision.sh` renames it in step 7. The script then waits at "Installing your
public key into the VM" with no password prompt.

**7. Provision and verify the VM.** Replace `VM` with the alias from step 6.

```bash
rsync -a --exclude .git ./ VM:~/pi-roost/
ssh VM 'cd pi-roost && ./guest/macos/provision.sh --hostname VM && ./guest/macos/verify.sh'
ssh-keygen -R VM
ssh VM          # accept the new host key
```

Pass `--hostname` explicitly. Without it, `provision.sh` derives the name from
your GitHub login through `gh` or a forwarded agent, and neither can supply it
here: the throwaway login key is not on GitHub.

`provision.sh` regenerates the VM's SSH host keys, so the host's saved key for
the alias no longer matches. `ssh-keygen -R` removes the old one.

`setup.sh` ends by suggesting that you add your public key to GitHub and run
`verify.sh --network`. Skip both for the spike. The login key should only open
the VM, and the network check would test GitHub access with it.

`verify.sh` reports one FAIL on a fresh VM: the account password is still the
base image's default, `admin`. It does not affect the spike, and for a
throwaway test VM it can be left. [WORKFLOW.md](WORKFLOW.md#3-verify) says how
to change it.

**Ready when:** `verify.sh` shows no other FAIL, `ssh VM` opens a session
without a password, and in it `ssh-add -l` reports that no agent is reachable.

After the spike, `ssh-add -d ~/.ssh/pi-roost-spike-login` removes the login
key from the agent.

## Phase 0 — Set up

On the host:

```bash
brew install secretive
open -a Secretive          # work through its setup window, as below
gh repo create pi-roost-spike-a --private --add-readme
gh repo create pi-roost-spike-b --private --add-readme

SOCK="$HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"
ls -l "$SOCK"
SSH_AUTH_SOCK="$SOCK" ssh-add -l
```

Secretive's setup window has three steps, and its Done button stays disabled
until all three are complete:

| Step | What to do |
|---|---|
| Setup Agent | Click **Install**. This installs Secret Agent, the helper that holds the socket and signs requests. Allow notifications when macOS asks. |
| Updates | Click **OK**. It is a notice that Secretive checks GitHub for new releases. |
| Configure Integrations | Click **Configure**, then close that screen with its own **Done** button. Do not copy anything from it into your shell or SSH configuration. |

The integrations screen only shows instructions, and the step counts as
complete once the screen has been opened and closed.

**Pass:** the socket exists and `ssh-add -l` answers, with no identities or
with ones you already had. Record Secretive's version.

The plan always names Secretive's socket explicitly. Secretive does not need
to become your default SSH agent, and the kit's login agent stays as it is.

## Phase 1 — Create three keys (spikes 3 and 4)

In the Secretive app, create three secrets. Choose the 256-bit ECDSA key type
for each.

| Name | Protection level | For |
|---|---|---|
| `spike a read` | Notify | reading repository A |
| `spike a write` | Require Authentication | pushing to repository A |
| `spike b write` | Require Authentication | repository B, to test that an unlock is per key |

Then:

```bash
SSH_AUTH_SOCK="$SOCK" ssh-add -L
ls -l "$HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/PublicKeys/"
```

Copy each secret's public key file, from the "Public Key Path" shown in the
app, to a working folder:

```bash
mkdir -p ~/pi-roost-spike
cp "<path for spike a read>"  ~/pi-roost-spike/a-read.pub
cp "<path for spike a write>" ~/pi-roost-spike/a-write.pub
cp "<path for spike b write>" ~/pi-roost-spike/b-write.pub
```

**Record:**

- Spike 3: whether you found any way to create a key without the app.
- Spike 4: whether the secret's name or protection level appears in
  `ssh-add -L`, in the public key file, or in its file name.

**Pass:** three public key files, each matched to a secret.

## Phase 2 — Register the deploy keys (spike 8)

```bash
cd ~/pi-roost-spike
gh repo deploy-key add a-read.pub  -R OWNER/pi-roost-spike-a --title "spike a read"
gh repo deploy-key add a-write.pub -R OWNER/pi-roost-spike-a --title "spike a write" --allow-write
gh repo deploy-key add b-write.pub -R OWNER/pi-roost-spike-b --title "spike b write" --allow-write
gh repo deploy-key list -R OWNER/pi-roost-spike-a
```

**Pass:** GitHub accepts all three, and the list shows one read-only and one
read-write key on repository A.

## Phase 3 — Prompts on the host, without the VM (spikes 2, 6 and 7)

```bash
cd ~/pi-roost-spike
use() { GIT_SSH_COMMAND="ssh -o IdentityAgent=$SOCK -o IdentitiesOnly=yes -i $PWD/$1"; export GIT_SSH_COMMAND; }

use a-read.pub
git ls-remote git@github.com:OWNER/pi-roost-spike-a.git

use a-write.pub
git ls-remote git@github.com:OWNER/pi-roost-spike-a.git

unset GIT_SSH_COMMAND      # so later git commands in this shell use your normal agent
```

**Expected:** the first command needs no authentication and raises a
notification. The second raises a Touch ID prompt.

**Record:**

- Spike 2: the exact wording of the Touch ID prompt and of the notification.
  Does each name the secret?
- Spike 6: what each shows as the requesting app.
- Whether either names the destination, such as `github.com`.
- Spike 7: in System Settings, Notifications, Secretive, whether there is any
  way to quieten the notification from the Notify key while keeping the one
  that offers "Leave Unlocked".

**Pass:** both commands list the repository's refs, and the prompt names the
secret.

## Phase 4 — Forward Secretive's socket only (spike 1)

Open a session with the forwarded agent set on the command line. The alias
keeps its own login agent from the kit's SSH configuration.

```bash
ssh -o ControlPath=none -o ForwardAgent="$SOCK" VM
```

In that session, in the VM:

```bash
ssh-add -l
```

**Pass:** exactly the three spike keys are listed. **Fail:** your personal key,
the login key or any other key is listed. If so, stop: the route does not work
as planned.

Leave this session open for phase 5.

## Phase 5 — Fetch and push from the VM (spikes 5 and 9)

In the forwarded session in the VM, write the public key files from the
forwarded agent. Each file should have one line.

```bash
mkdir -p ~/.ssh/spike
ssh-add -L | grep ' spike-a-read@'  > ~/.ssh/spike/a-read.pub
ssh-add -L | grep ' spike-a-write@' > ~/.ssh/spike/a-write.pub
ssh-add -L | grep ' spike-b-write@' > ~/.ssh/spike/b-write.pub
wc -l ~/.ssh/spike/*.pub
```

Then add the routing:

```bash
echo '# >>> pi-roost spike' >> ~/.ssh/config
for k in a-read a-write b-write; do
  printf 'Host gh-spike-%s\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/spike/%s.pub\n  IdentitiesOnly yes\n' "$k" "$k" >> ~/.ssh/config
done
echo '# <<< pi-roost spike' >> ~/.ssh/config

cd ~ && git clone gh-spike-a-read:OWNER/pi-roost-spike-a.git spike-a && cd spike-a
git remote set-url --push origin gh-spike-a-write:OWNER/pi-roost-spike-a.git
```

Run each test and count the Touch ID prompts and notifications on the host.

| # | In the VM | Expected |
|---|---|---|
| a | the `git clone` above | no Touch ID; one notification naming `spike a read` |
| b | `git fetch` | no Touch ID; one notification |
| c | `git -c user.name=spike -c user.email=spike@example.invalid commit --allow-empty -m spike && git push origin HEAD:spike-1` | one Touch ID prompt naming `spike a write`; the push succeeds |
| d | repeat the push to `spike-2`, and press **Deny** | the push fails |
| e | repeat the push to `spike-2` and approve; then choose **Leave Unlocked**, 5 minutes, in the notification, and authenticate again if asked | the push succeeds |
| f | `git push origin HEAD:spike-3` within 5 minutes | no Touch ID |
| g | `git ls-remote gh-spike-b-write:OWNER/pi-roost-spike-b.git` within the same 5 minutes | a Touch ID prompt naming `spike b write` |
| h | `git ls-remote gh-spike-a-read:OWNER/pi-roost-spike-b.git` | refused; repository A's key cannot read repository B |
| i | `git push gh-spike-a-read:OWNER/pi-roost-spike-a.git HEAD:spike-4` | refused; the key is read-only |
| j | `ssh -T git@github.com` | record how many prompts appear, and for which secrets |

**Record:**

- Spike 5: the result of test g. A prompt means the unlock is per key.
- Spike 9: any test that raised more prompts or notifications than expected.
- Spikes 2 and 6 again, through forwarding: the wording of the prompt in test
  c, the requesting app it shows, and whether it names the destination.
- Test j shows the cost of a request with no routing.

**Pass:** tests a to i behave as expected.

## Phase 6 — End of session

Close the forwarded session. Open a normal one and check:

```bash
ssh VM 'ssh-add -l; ssh -T -o BatchMode=yes git@github.com'
```

**Pass:** no agent is reachable and GitHub refuses the connection.

## Clean up

This removes what the spike created. It leaves the VM, Tart and Secretive in
place.

**1. In the VM.** The `sed` line deletes the routing block between its two
markers. The `grep` should print `0`.

```bash
ssh VM
sed -i '' '/^# >>> pi-roost spike$/,/^# <<< pi-roost spike$/d' ~/.ssh/config
rm -rf ~/.ssh/spike ~/spike-a
grep -c 'gh-spike' ~/.ssh/config
exit
```

**2. On GitHub.** Deleting a repository removes its deploy keys and branches
with it. `gh` needs the `delete_repo` scope for this; the alternative is to
delete each repository on github.com, under Settings.

```bash
gh auth refresh -h github.com -s delete_repo
gh repo delete OWNER/pi-roost-spike-a --yes
gh repo delete OWNER/pi-roost-spike-b --yes
gh repo list OWNER --limit 20 | grep spike      # should print nothing
```

**3. In Secretive.** Delete the test secrets in the app, then check that the
agent holds none:

```bash
SSH_AUTH_SOCK="$SOCK" ssh-add -l
```

**4. On the host.**

```bash
unset GIT_SSH_COMMAND
rm -r ~/pi-roost-spike
```

Optional:

- Remove the extra scope again:
  `gh auth refresh -h github.com --remove-scopes delete_repo`.
- Leave the `pi-roost-spike-login` key in place for as long as the VM is in
  use. It is what opens it.

## Recording the result

Add a dated results section like the one below for each run. The answers
decide whether step 1 stays on the Secretive route or falls back to the
per-session agent described in [WIZARD.md](WIZARD.md#alternatives).

## Results, 15 November 2026

**Outcome: the Secretive route works.** No phase failed, and nothing found
calls for the fallback.

Setup: a separate test Mac with Touch ID. Homebrew managed by Workbrew, Tart
2.41.1, the Tahoe base image, Secretive 4.0.0. Login to the VM with a
throwaway key in the plain `ssh-agent`. Secretive's socket forwarded.

| Spike | Question | Result |
|---|---|---|
| 1 | Only Secretive's keys visible in the VM? | **Yes.** `ssh-add -l` in the VM listed the three spike keys and not the login key. |
| 2 | Prompt and notification name the secret? | **Yes for the prompt:** *SecretAgent is trying to sign a request from "Terminal" using secret "spike a write". Touch ID or enter your password to allow.* **Yes for the notification:** *Signed Request from Terminal* / *Using secret spike a read connecting to git@github.com*. |
| 3 | Key creation without the app? | **No.** In the app, the "+" button, the File menu's New Secret item and its keyboard shortcut all open the same window. Secretive 4.0.0 registers no URL scheme, declares no AppleScript support, and ships no scripting definition or Shortcuts actions. |
| 4 | Protection level readable from outside the app? | **No.** The secret's name is readable: it is the key comment in `ssh-add -L`, with spaces as dashes, as in `spike-a-write@secretive.<hostname>.local`. The level appears nowhere. |
| 5 | "Leave Unlocked" per key? | **Yes.** With `spike a write` unlocked, `spike b write` still asked for Touch ID. |
| 6 | Requester shown, directly and through forwarding? | **"Terminal" in both cases.** A process in the VM is not identified. The notification names the destination, `git@github.com`; the Touch ID prompt does not. The recorded notification came from a request made in the VM, so the destination survives forwarding. |
| 7 | Notify notifications separately quietable? | **No.** System Settings lists one entry, "SecretAgent", so all of Secretive's notifications are switched together. The panel has no time-sensitive switch. |
| 8 | GitHub accepts the keys as deploy keys? | **Yes,** as `ecdsa-sha2-nistp256`, read-only and read-write. |
| 9 | Prompts and notifications as expected for fetch and push? | **Yes** for tests a to i. Counted afterwards in a forwarded session: one notification for each of two fetches; one Touch ID prompt and one notification for a push. Notification Centre put the two read notifications in one group and the write notification in another. |
| 1, repeated | Phase 4 on the everyday host | Not yet run. |

Phase 5 tests:

| # | Result |
|---|---|
| a to c | As expected. The push raised one Touch ID prompt naming `spike a write`. |
| d | Deny failed the push. |
| e | "Leave Unlocked" was easy to find in the notification. Choosing 5 minutes raised a second Touch ID prompt. |
| f | No prompt within the 5 minutes. |
| g | A prompt naming `spike b write`. |
| h | *ERROR: Repository not found.* |
| i | *ERROR: The key you are authenticating with has been marked as read only.* |
| j | Authenticated as `OWNER/pi-roost-spike-a` with no Touch ID prompt. Most likely `spike a write`, the first key in the agent, still unlocked from test e. |

Phase 6: after the forwarded session closed, the VM reached no agent and
GitHub answered *Permission denied (publickey)*.

Findings beyond the nine questions:

- **A slow approval fails the command.** While the Touch ID prompt waited,
  GitHub closed the connection (*Received disconnect ... Bye Bye*). The same
  command succeeded when approved promptly.
- **An unlocked write key is open to any request.** Test j used a write key
  with no prompt and no routing. For the length of an unlock, Touch ID does not
  gate that key.
- **The key comment carries the Mac's hostname** into the VM. Secretive's Key
  Attribution field can set that text.
- **The setup steps needed five corrections,** now in the plan: the Tart tap
  and Homebrew trust, `--tart-ip`, `--hostname`, Secretive's setup window, and
  writing the routing without a heredoc.

Follow-up on the same day, on naming: a secret named `rare.saker/test` was
accepted. The Touch ID prompt showed the name in full: *SecretAgent is trying
to sign a request from "Terminal" using secret "rare.saker/test".* The key
comment was `rare.saker/test@secretive.<hostname>.local`. The test used
`ssh-keygen -Y sign` against Secretive's socket, with no GitHub access. The
prompt's wording was the same as for an SSH login; it did not say that this
was a file signature. A
secret's name can therefore carry the host and repository into the prompt,
which does not show the destination itself.

Still open:

- Phase 4 on the everyday host.

The clean-up was run on the test Mac the same day, without the optional
steps, so that `gh` login still has the `delete_repo` scope.
