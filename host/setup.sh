#!/usr/bin/env bash
# Host-side setup: 1Password agent check, scoped SSH config, authorized_keys install.
# Idempotent. Run on the macOS host, not in the VM.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

VM_NAME=""
VM_HOST=""
VM_USER="admin"
ALIAS=""
USE_TART_IP=0

OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
SSH_CONFIG="$HOME/.ssh/config"

usage() {
  cat <<'EOF'
Usage: host/setup.sh [options]

  --vm-name NAME     Tart VM name. If omitted, a name is derived from your
                     GitHub login as <login>-tart-test-vm and you are asked
                     to confirm it.
  --vm-host HOST     DNS/mDNS name of the VM (default: <vm-name>.local)
  --alias NAME       SSH alias to create (default: --vm-name value)
  --user USER        VM username (default: admin)
  --tart-ip          Resolve the address via `tart ip` instead of DNS
  -h, --help         Show this help

Examples:
  host/setup.sh                                  # derive and confirm the name
  host/setup.sh --vm-name alice-tart-test-vm
  host/setup.sh --vm-name alice-tart-test-vm --tart-ip
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vm-name) VM_NAME="$2"; shift 2 ;;
    --vm-host) VM_HOST="$2"; shift 2 ;;
    --alias)   ALIAS="$2";   shift 2 ;;
    --user)    VM_USER="$2"; shift 2 ;;
    --tart-ip) USE_TART_IP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

step "Checking the 1Password SSH agent"
if [ -S "$OP_SOCK" ]; then
  say "socket present"
else
  die "1Password agent socket not found at:
    $OP_SOCK
  Enable it in 1Password: Settings -> Developer -> Use the SSH agent"
fi

if ! SSH_AUTH_SOCK="$OP_SOCK" ssh-add -l >/dev/null 2>&1; then
  die "agent reachable but holds no keys. Add an SSH key item in 1Password."
fi
SSH_AUTH_SOCK="$OP_SOCK" ssh-add -l | sed 's/^/  /'
# Everything below (including GitHub login detection) talks to the 1Password agent.
export SSH_AUTH_SOCK="$OP_SOCK"

step "Naming"
if [ -z "$VM_NAME" ]; then
  LOGIN="$(derive_github_login)"
  say "GitHub login detected: $LOGIN"
  VM_NAME="$(confirm_value 'VM name' "$(suggest_vm_name "$LOGIN")")"
fi
[ -n "$VM_NAME" ] || die "empty VM name"
[ -n "$ALIAS" ] || ALIAS="$VM_NAME"
if [ "$USE_TART_IP" -eq 0 ] && [ -z "$VM_HOST" ]; then
  VM_HOST="$VM_NAME.local"
fi
say "VM name:    $VM_NAME"
say "SSH alias:  $ALIAS"
say "address:    ${VM_HOST:-via tart ip}"

step "Writing SSH config block for '$ALIAS'"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
touch "$SSH_CONFIG"; chmod 600 "$SSH_CONFIG"

BEGIN="# >>> pi-kit-1pass-tart-macos: $ALIAS >>>"
END="# <<< pi-kit-1pass-tart-macos: $ALIAS <<<"

if [ "$USE_TART_IP" -eq 1 ]; then
  command -v tart >/dev/null || die "tart not found in PATH"
  TARGET="  ProxyCommand sh -c 'exec nc \$(tart ip $VM_NAME) %p'"
else
  TARGET="  HostName $VM_HOST"
fi

BLOCK="$BEGIN
# Two capability levels for the same VM. The default alias forwards nothing;
# use the -git alias only when the VM needs to reach GitHub.
Host $ALIAS
$TARGET
  User $VM_USER
  HostKeyAlias $ALIAS
  ForwardAgent no

Host ${ALIAS}-git
$TARGET
  User $VM_USER
  HostKeyAlias $ALIAS
  ForwardAgent yes
  IdentityAgent \"$OP_SOCK\"
$END"

if grep -qF "$BEGIN" "$SSH_CONFIG"; then
  # Replace the existing managed block, leave everything else untouched.
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" -v repl="$BLOCK" '
    index($0,b){skip=1; print repl; next}
    index($0,e){skip=0; next}
    !skip{print}
  ' "$SSH_CONFIG" > "$tmp"
  mv "$tmp" "$SSH_CONFIG"; chmod 600 "$SSH_CONFIG"
  say "updated existing block"
else
  printf '\n%s\n' "$BLOCK" >> "$SSH_CONFIG"
  say "appended new block"
fi

step "Installing your public key into the VM"
if [ "$USE_TART_IP" -eq 1 ]; then
  ADDR="$(tart ip "$VM_NAME")" || die "tart ip $VM_NAME failed - is the VM running?"
else
  ADDR="$VM_HOST"
fi
say "target: $VM_USER@$ADDR"
say "you will be prompted for the VM password (this is the last time)"

SSH_AUTH_SOCK="$OP_SOCK" ssh-add -L | \
  ssh "$VM_USER@$ADDR" \
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh &&
     touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys &&
     while read -r k; do grep -qxF "$k" ~/.ssh/authorized_keys || echo "$k" >> ~/.ssh/authorized_keys; done &&
     echo "  authorized_keys now has $(wc -l < ~/.ssh/authorized_keys | tr -d " ") key(s)"'

step "Verifying agent forwarding"
if ssh -o BatchMode=yes "${ALIAS}-git" 'ssh-add -l' 2>/dev/null | sed 's/^/  /'; then
  say "forwarding works via ${ALIAS}-git"
else
  die "could not list forwarded keys via '${ALIAS}-git'. Try: ssh -v ${ALIAS}-git"
fi

step "Verifying the default alias forwards nothing"
if ssh -o BatchMode=yes "$ALIAS" 'ssh-add -l' >/dev/null 2>&1; then
  say "WARNING: '$ALIAS' reached an agent - expected none"
else
  say "'$ALIAS' has no agent, as intended"
fi

cat <<EOF

Done. Two ways to connect:

  ssh $ALIAS        no credentials reach the VM (use this by default)
  ssh ${ALIAS}-git    agent forwarded, VM can reach GitHub for that session

Next:

  1. Add your public key to GitHub:  https://github.com/settings/keys
     (gh ssh-key add needs admin:public_key, which this kit removes)

  2. Provision the guest:
       rsync -a --exclude .git ./ ${ALIAS}-git:~/pi-kit-1pass-tart-macos/
       ssh ${ALIAS}-git
       cd pi-kit-1pass-tart-macos && ./guest/provision.sh --logout-gh

  3. Audit:
       ssh ${ALIAS}-git ./pi-kit-1pass-tart-macos/guest/verify.sh --network
EOF
