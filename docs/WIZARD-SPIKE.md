# Wizard spike plan

Hands-on checks for step 1 of [WIZARD.md](WIZARD.md): per-repository deploy
keys held in Secretive, with Secretive's socket forwarded to the VM.

The question: **can a VM session use deploy keys held in Secretive, and only
those, with Touch ID on pushes and no more prompts than expected?**

Run the phases in order. Each has a pass condition. Record what you see even
when it passes, because several phases ask for the exact wording of a prompt.
A negative result is a valid outcome.

This plan has not been run. The paths and prompt wording come from Secretive's
source (main branch, 18 October 2026) and may differ in the release you
install.

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
brew install cirruslabs/cli/tart gh
gh auth login
```

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
host/setup.sh --identity-agent "$SSH_AUTH_SOCK"
```

Pass `--identity-agent` explicitly. Without it, `setup.sh` prefers Secretive's
socket over the plain agent whenever Secretive is installed. If the VM's name
does not resolve, add `--tart-ip`.

**7. Provision and verify the VM.** Replace `VM` with the alias from step 6.

```bash
rsync -a --exclude .git ./ VM:~/pi-roost/
ssh VM 'cd pi-roost && ./guest/macos/provision.sh && ./guest/macos/verify.sh'
```

**Ready when:** `ssh VM` opens a session without a password, and in it
`ssh-add -l` reports that no agent is reachable.

After the spike, `ssh-add -d ~/.ssh/pi-roost-spike-login` removes the login
key from the agent.

## Phase 0 — Set up

On the host:

```bash
brew install secretive
open -a Secretive          # allow notifications; skip any step that edits your shell or SSH configuration
gh repo create pi-roost-spike-a --private --add-readme
gh repo create pi-roost-spike-b --private --add-readme

SOCK="$HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"
ls -l "$SOCK"
SSH_AUTH_SOCK="$SOCK" ssh-add -l
```

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

From a second terminal on the host, copy the public keys in:

```bash
ssh VM 'mkdir -p ~/.ssh/spike'
scp ~/pi-roost-spike/*.pub VM:.ssh/spike/
```

In the forwarded session in the VM, add the routing:

```bash
cat >> ~/.ssh/config <<'EOF'
# >>> pi-roost spike
Host gh-spike-a-read
  HostName github.com
  User git
  IdentityFile ~/.ssh/spike/a-read.pub
  IdentitiesOnly yes
Host gh-spike-a-write
  HostName github.com
  User git
  IdentityFile ~/.ssh/spike/a-write.pub
  IdentitiesOnly yes
Host gh-spike-b-write
  HostName github.com
  User git
  IdentityFile ~/.ssh/spike/b-write.pub
  IdentitiesOnly yes
# <<< pi-roost spike
EOF

cd ~ && git clone gh-spike-a-read:OWNER/pi-roost-spike-a.git spike-a && cd spike-a
git remote set-url --push origin gh-spike-a-write:OWNER/pi-roost-spike-a.git
```

Run each test and count the Touch ID prompts and notifications on the host.

| # | In the VM | Expected |
|---|---|---|
| a | the `git clone` above | no Touch ID; one notification naming `spike a read` |
| b | `git fetch` | no Touch ID; one notification |
| c | `git commit --allow-empty -m spike && git push origin HEAD:spike-1` | one Touch ID prompt naming `spike a write`; the push succeeds |
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

On the host:

```bash
gh repo deploy-key list -R OWNER/pi-roost-spike-a     # note the IDs
gh repo deploy-key delete <id> -R OWNER/pi-roost-spike-a
gh repo deploy-key list -R OWNER/pi-roost-spike-b
gh repo deploy-key delete <id> -R OWNER/pi-roost-spike-b
rm -r ~/pi-roost-spike
```

Delete the two test repositories on GitHub, and the three secrets in the
Secretive app.

In the VM, remove the block between `# >>> pi-roost spike` and
`# <<< pi-roost spike` from `~/.ssh/config`, then:

```bash
rm -rf ~/.ssh/spike ~/spike-a
```

## Recording the result

Fill in the table and append it to this file. The answers decide whether step
1 stays on the Secretive route or falls back to the per-session agent
described in [WIZARD.md](WIZARD.md#alternatives).

| Spike | Question | Result |
|---|---|---|
| 1 | Only Secretive's keys visible in the VM? | |
| 2 | Prompt and notification name the secret? | |
| 3 | Key creation without the app? | |
| 4 | Protection level readable from outside the app? | |
| 5 | "Leave Unlocked" per key? | |
| 6 | Requester shown, directly and through forwarding? | |
| 7 | Notify notifications separately quietable? | |
| 8 | GitHub accepts the keys as deploy keys? | |
| 9 | Prompts and notifications as expected for fetch and push? | |
| 1, repeated | Phase 4 on the everyday host, if the plan ran on a test Mac | |
