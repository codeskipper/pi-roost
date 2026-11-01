#!/usr/bin/env bash
# Read-only posture audit. Run INSIDE the VM. Exits non-zero if any check FAILs.
set -uo pipefail

PASS=0; WARN=0; FAIL=0
NETWORK=0
[ "${1:-}" = "--network" ] && NETWORK=1

ok()   { printf '  [ PASS ]  %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  [ WARN ]  %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  [ FAIL ]  %s\n' "$*"; FAIL=$((FAIL+1)); }
sec()  { printf '\n%s\n' "$*"; }

printf 'pi-roost posture audit  (%s)\n' "$(date '+%Y-%m-%d %H:%M')"

sec "Identity"
HN="$(scutil --get LocalHostName 2>/dev/null || echo '?')"
case "$HN" in
  *Virtual-Machine*|*virtual-machine*) warn "hostname is still the image default: $HN" ;;
  '?') bad "could not read LocalHostName" ;;
  *) ok "hostname: $HN" ;;
esac

if [ -f /etc/ssh/.pi-roost-hostkeys-regenerated ]; then
  ok "SSH host keys regenerated for this VM ($(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}'))"
else
  warn "host keys may be inherited from the base image - clones could impersonate this VM"
fi

sec "Local credential material"
LOCALKEYS=0
for k in "$HOME"/.ssh/id_*; do
  case "$k" in *.pub|*'id_*') continue ;; esac
  [ -f "$k" ] || continue
  LOCALKEYS=$((LOCALKEYS+1))
  if ssh-keygen -y -P "" -f "$k" >/dev/null 2>&1; then
    bad "$(basename "$k") has NO passphrase (plaintext private key)"
  else
    warn "$(basename "$k") present and encrypted - prefer forwarding the host agent"
  fi
done
[ "$LOCALKEYS" -eq 0 ] && ok "no private SSH keys on this VM"

if grep -qiE '^[[:space:]]*IdentitiesOnly[[:space:]]+yes' "$HOME/.ssh/config" 2>/dev/null; then
  bad "~/.ssh/config sets IdentitiesOnly yes - this blocks forwarded agent keys"
else
  ok "~/.ssh/config does not set IdentitiesOnly"
fi

sec "Agent"
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  ssh-add -l >/dev/null 2>&1; rc=$?
  case "$rc" in
    0) ok "agent reachable with $(ssh-add -l 2>/dev/null | wc -l | tr -d ' ') key(s)"
       ssh-add -l 2>/dev/null | sed 's/^/            /' ;;
    1) warn "agent reachable but holds no keys (unlock 1Password on the host?)" ;;
    *) warn "no agent reachable (connect with ForwardAgent, or run via ssh)" ;;
  esac
else
  warn "SSH_AUTH_SOCK unset - not an agent-forwarded session"
fi

sec "Host access"
if [ -s "$HOME/.ssh/authorized_keys" ]; then
  ok "authorized_keys present ($(wc -l < "$HOME/.ssh/authorized_keys" | tr -d ' ') key(s))"
else
  warn "authorized_keys missing/empty - password is the only way in"
fi

PWAUTH="$(sudo -n sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
case "$PWAUTH" in
  no)  ok "sshd password authentication disabled" ;;
  yes) warn "sshd password authentication enabled" ;;
  *)   warn "could not read sshd config (needs sudo)" ;;
esac

if dscl . -authonly "$(id -un)" admin >/dev/null 2>&1; then
  bad "account password is still the Tart default 'admin'"
else
  ok "account password is not the Tart default"
fi

sec "Autologin"
if [ -f /etc/kcpassword ]; then
  bad "/etc/kcpassword exists - account password recoverable (XOR with a published key)"
else
  ok "/etc/kcpassword absent"
fi
if sudo -n defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1; then
  warn "autologin is enabled - keychain unlocks without a human"
else
  ok "autologin disabled"
fi

sec "Keychain"
if security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  SET="$(security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" 2>&1)"
  case "$SET" in
    *no-timeout*) warn "login keychain unlocked, no idle timeout" ;;
    *)            ok "login keychain unlocked with a timeout" ;;
  esac
else
  ok "login keychain locked"
fi

sec "GitHub CLI"
if ! command -v gh >/dev/null 2>&1; then
  ok "gh not installed"
elif ! security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  # A locked keychain makes 'gh auth status' fail for the same reason as a
  # missing credential. Do not read that as absence.
  warn "login keychain is locked - cannot tell whether a gh credential is resident"
elif gh auth status >/dev/null 2>&1; then
  warn "a gh credential is resident in this VM - prefer 'gh auth logout' and run gh on the host"
  if [ -f "$HOME/.config/gh/hosts.yml" ] && grep -q oauth_token "$HOME/.config/gh/hosts.yml" 2>/dev/null; then
    bad "gh token stored in PLAINTEXT in ~/.config/gh/hosts.yml"
  else
    ok "gh token not in hosts.yml (keyring)"
  fi
  SCOPES="$(gh auth status 2>&1 | sed -n "s/.*Token scopes: //p")"
  if [ -n "$SCOPES" ]; then
    case "$SCOPES" in
      *admin:public_key*) bad "gh token has admin:public_key - it can add SSH keys to your account" ;;
      *) ok "gh scopes: $SCOPES" ;;
    esac
  fi
else
  ok "no resident gh credential (git works via the forwarded agent)"
  if security find-generic-password -s "gh:github.com" >/dev/null 2>&1; then
    bad "but a 'gh:github.com' keychain item still exists - remove it"
  fi
fi

sec "Agent runtime credentials"
PIAUTH="$HOME/.pi/agent/auth.json"
if [ -f "$PIAUTH" ]; then
  PERM="$(stat -f '%Lp' "$PIAUTH")"
  [ "$PERM" = "600" ] && ok "pi auth.json mode 600" || bad "pi auth.json mode $PERM (want 600)"
  warn "pi auth.json holds provider tokens in plaintext - unavoidable, rotate if VM is shared/imaged"
else
  ok "no pi auth.json"
fi

if [ "$NETWORK" -eq 1 ]; then
  sec "Connectivity"
  ssh-add -l >/dev/null 2>&1; agent_rc=$?
  if [ "$agent_rc" -eq 2 ]; then
    warn "no agent in this session - connect with the -git alias before testing GitHub"
  elif [ "$agent_rc" -eq 1 ]; then
    warn "agent reachable but holds no keys - is your password manager unlocked?"
  else
    OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1)"
    case "$OUT" in
      *successfully\ authenticated*) ok "GitHub SSH authentication works" ;;
      *Permission\ denied*) bad "agent has a key but GitHub rejected it - register the public key at https://github.com/settings/keys" ;;
      *) warn "could not reach GitHub: $(printf '%s' "$OUT" | head -1)" ;;
    esac
  fi
fi

printf '\n-------------------------------------------\n'
printf '  PASS %d   WARN %d   FAIL %d\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
