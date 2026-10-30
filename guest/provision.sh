#!/usr/bin/env bash
# Guest-side provisioning. Run INSIDE the Tart macOS VM.
# Idempotent: safe to re-run. Destructive steps are opt-out, not silent.
set -euo pipefail

HOSTNAME_NEW=""
REGEN_HOST_KEYS=1
REMOVE_LOCAL_KEYS=1
STRIP_AUTOLOGIN=1
DISABLE_PASSWORD_AUTH=0
SETUP_GIT_SIGNING=0
SIGNING_KEY=""

usage() {
  cat <<'EOF'
Usage: guest/provision.sh --hostname NAME [options]

  --hostname NAME          Set LocalHostName/ComputerName/HostName (required)
  --keep-host-keys         Do NOT regenerate /etc/ssh host keys
  --keep-local-keys        Do NOT remove ~/.ssh private keys + keychain entries
  --keep-autologin         Do NOT disable autologin / remove /etc/kcpassword
  --disable-password-auth  Turn off sshd password auth (needs authorized_keys!)
  --git-signing PUBKEY     Configure git commit signing with this public key
  -h, --help               Show this help

Run guest/verify.sh afterwards to audit the result.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
    --keep-host-keys)        REGEN_HOST_KEYS=0; shift ;;
    --keep-local-keys)       REMOVE_LOCAL_KEYS=0; shift ;;
    --keep-autologin)        STRIP_AUTOLOGIN=0; shift ;;
    --disable-password-auth) DISABLE_PASSWORD_AUTH=1; shift ;;
    --git-signing) SETUP_GIT_SIGNING=1; SIGNING_KEY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$HOSTNAME_NEW" ] || { echo "error: --hostname is required" >&2; usage; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { echo "error: this must run on macOS" >&2; exit 1; }

say()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

step "Setting hostname to '$HOSTNAME_NEW'"
sudo scutil --set LocalHostName "$HOSTNAME_NEW"
sudo scutil --set ComputerName  "$HOSTNAME_NEW"
sudo scutil --set HostName      "$HOSTNAME_NEW.local"
say "mDNS name: $HOSTNAME_NEW.local"

if [ "$REGEN_HOST_KEYS" -eq 1 ]; then
  step "Regenerating SSH host keys"
  # Base images ship identical host keys; every clone would be impersonatable.
  sudo rm -f /etc/ssh/ssh_host_*
  sudo ssh-keygen -A >/dev/null
  echo "regenerated $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | sudo tee /etc/ssh/.codeskipper-hostkeys-regenerated >/dev/null
  sudo launchctl kickstart -k system/com.openssh.sshd >/dev/null 2>&1 || true
  say "new fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
  say "NOTE: hosts connecting here will see a new fingerprint once (expected)"
fi

if [ "$REMOVE_LOCAL_KEYS" -eq 1 ]; then
  step "Removing local SSH private keys (the host's agent provides them)"
  found=0
  for k in "$HOME"/.ssh/id_*; do
    case "$k" in *.pub|*'id_*') continue ;; esac
    [ -f "$k" ] || continue
    found=1
    ssh-add --apple-use-keychain -d "$k" >/dev/null 2>&1 || true   # drop passphrase from keychain
    rm -f "$k" "$k.pub"
    say "removed $(basename "$k")"
  done
  [ "$found" -eq 1 ] || say "none present"
  pkill -f "ssh-agent -s -a $HOME/.ssh/agent.sock" 2>/dev/null || true
  rm -f "$HOME/.ssh/agent.sock"
fi

step "Writing ~/.ssh/config"
# IdentitiesOnly must NOT be set: it makes ssh ignore forwarded agent identities
# once no local key file exists, which silently breaks GitHub auth.
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
cat > "$HOME/.ssh/config" <<'EOF'
Host github.com
  HostName github.com
  User git
EOF
chmod 600 "$HOME/.ssh/config"
say "no IdentityFile / IdentitiesOnly - forwarded agent supplies the key"

step "Keeping forwarded agent usable in tmux/screen"
cat > "$HOME/.ssh/rc" <<'EOF'
#!/bin/sh
# Stable path for the forwarded agent socket; tmux keeps working after reattach.
if [ -n "$SSH_AUTH_SOCK" ] && [ "$SSH_AUTH_SOCK" != "$HOME/.ssh/ssh_auth_sock" ]; then
  ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/ssh_auth_sock"
fi
EOF
chmod 700 "$HOME/.ssh/rc"
say "~/.ssh/ssh_auth_sock -> current forwarded socket"

if [ "$STRIP_AUTOLOGIN" -eq 1 ]; then
  step "Disabling autologin"
  # /etc/kcpassword is the account password XOR'd with a published key, mode 0644.
  if [ -f /etc/kcpassword ]; then
    sudo rm -f /etc/kcpassword; say "removed /etc/kcpassword"
  else
    say "/etc/kcpassword already absent"
  fi
  if sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1; then
    sudo defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser
    say "cleared autoLoginUser"
  else
    say "autoLoginUser already unset"
  fi
fi

if [ "$SETUP_GIT_SIGNING" -eq 1 ]; then
  step "Configuring git commit signing"
  git config --global gpg.format ssh
  git config --global commit.gpgsign true
  git config --global user.signingkey "$SIGNING_KEY"
  say "signing with the forwarded key"
fi

if [ "$DISABLE_PASSWORD_AUTH" -eq 1 ]; then
  step "Disabling sshd password authentication"
  if [ ! -s "$HOME/.ssh/authorized_keys" ]; then
    echo "  REFUSING: ~/.ssh/authorized_keys is missing or empty." >&2
    echo "  Run host/setup.sh first, or you will lock yourself out." >&2
    exit 1
  fi
  sudo tee /etc/ssh/sshd_config.d/99-codeskipper-harden.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  sudo launchctl kickstart -k system/com.openssh.sshd >/dev/null 2>&1 || true
  say "password auth off - keep a Screen Sharing session open until you retest"
fi

printf '\nDone. Audit with: ./guest/verify.sh\n'
