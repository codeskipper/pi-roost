#!/usr/bin/env bash
# Host-side setup: 1Password agent check, scoped SSH config, authorized_keys install.
# Idempotent. Run on the macOS host, not in the VM.
set -euo pipefail

VM_NAME=""
VM_HOST=""
VM_USER="admin"
ALIAS=""
USE_TART_IP=0

OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
SSH_CONFIG="$HOME/.ssh/config"

usage() {
  cat <<'EOF'
Usage: host/setup.sh --vm-name NAME [options]

  --vm-name NAME     Tart VM name (required)
  --vm-host HOST     mDNS/DNS name of the VM, e.g. my-vm.local
                     If omitted, --tart-ip is implied.
  --alias NAME       SSH alias to create (default: --vm-name value)
  --user USER        VM username (default: admin)
  --tart-ip          Resolve the address via `tart ip` instead of DNS
  -h, --help         Show this help

Examples:
  host/setup.sh --vm-name codeskipper-test-vm --vm-host codeskipper-test-vm.local
  host/setup.sh --vm-name codeskipper-test-vm --tart-ip
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

[ -n "$VM_NAME" ] || { echo "error: --vm-name is required" >&2; usage; exit 2; }
[ -n "$ALIAS" ] || ALIAS="$VM_NAME"
[ -n "$VM_HOST" ] || USE_TART_IP=1

say()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

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

step "Writing SSH config block for '$ALIAS'"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
touch "$SSH_CONFIG"; chmod 600 "$SSH_CONFIG"

BEGIN="# >>> codeskipper-vm-kit: $ALIAS >>>"
END="# <<< codeskipper-vm-kit: $ALIAS <<<"

if [ "$USE_TART_IP" -eq 1 ]; then
  command -v tart >/dev/null || die "tart not found in PATH"
  TARGET="  ProxyCommand sh -c 'exec nc \$(tart ip $VM_NAME) %p'"
else
  TARGET="  HostName $VM_HOST"
fi

BLOCK="$BEGIN
# IdentityAgent is global on purpose; ForwardAgent is scoped to this host only.
Host $ALIAS
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
if ssh -o BatchMode=yes "$ALIAS" 'ssh-add -l' 2>/dev/null | sed 's/^/  /'; then
  say "forwarding works"
else
  die "could not list forwarded keys via '$ALIAS'. Try: ssh -v $ALIAS"
fi

cat <<EOF

Done. Next:

  1. Add your public key to GitHub:  https://github.com/settings/keys
     (gh ssh-key add needs admin:public_key, which this kit removes)

  2. Provision the guest:
       scp -r guest $ALIAS:~/ && ssh $ALIAS
       ./guest/provision.sh --hostname $VM_NAME

  3. Audit:
       ssh $ALIAS ./guest/verify.sh

  Connect with:  ssh $ALIAS
EOF
