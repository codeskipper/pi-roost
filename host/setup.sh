#!/usr/bin/env bash
# Copyright 2026 codeskipper
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
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
IDENTITY_AGENT=""

OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
SECRETIVE_SOCK="$HOME/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"
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
  --identity-agent PATH
                     SSH agent socket holding your key. Auto-detected:
                     1Password, then Secretive, then $SSH_AUTH_SOCK.
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
    --identity-agent) IDENTITY_AGENT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

assert_host

step "Locating an SSH agent"
if [ -n "$IDENTITY_AGENT" ]; then
  [ -S "$IDENTITY_AGENT" ] || die "no socket at: $IDENTITY_AGENT"
  AGENT_NAME="specified"
elif [ -S "$OP_SOCK" ]; then
  IDENTITY_AGENT="$OP_SOCK"; AGENT_NAME="1Password"
elif [ -S "$SECRETIVE_SOCK" ]; then
  IDENTITY_AGENT="$SECRETIVE_SOCK"; AGENT_NAME="Secretive (Secure Enclave)"
elif [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK:-}" ]; then
  IDENTITY_AGENT="$SSH_AUTH_SOCK"; AGENT_NAME="ssh-agent from the environment"
else
  die "no SSH agent found. Enable one of:
    1Password  -> Settings > Developer > Use the SSH agent
    Secretive  -> brew install secretive, then create a key
  or pass --identity-agent PATH"
fi
say "using $AGENT_NAME"
say "$IDENTITY_AGENT"

if ! SSH_AUTH_SOCK="$IDENTITY_AGENT" ssh-add -l >/dev/null 2>&1; then
  die "agent reachable but holds no keys. Add or create a key first."
fi
SSH_AUTH_SOCK="$IDENTITY_AGENT" ssh-add -l | sed 's/^/  /'
# Everything below (including GitHub login detection) talks to that agent.
export SSH_AUTH_SOCK="$IDENTITY_AGENT"

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

BEGIN="# >>> pi-roost: $ALIAS >>>"
END="# <<< pi-roost: $ALIAS <<<"

if [ "$USE_TART_IP" -eq 1 ]; then
  command -v tart >/dev/null || die "tart not found in PATH"
  TARGET="  ProxyCommand sh -c 'exec nc \$(tart ip $VM_NAME) %p'"
else
  TARGET="  HostName $VM_HOST"
fi

BLOCK="$BEGIN
# Two capability levels for the same VM.
#   IdentityAgent  - which agent THIS machine uses to authenticate (both).
#   ForwardAgent   - whether the VM may use that agent (-git only).
Host $ALIAS
$TARGET
  User $VM_USER
  HostKeyAlias $ALIAS
  IdentityAgent \"$IDENTITY_AGENT\"
  ForwardAgent no

Host ${ALIAS}-git
$TARGET
  User $VM_USER
  HostKeyAlias $ALIAS
  IdentityAgent \"$IDENTITY_AGENT\"
  ForwardAgent yes
$END"

# Idempotent: drop any existing managed block, then append a fresh one.
# The multi-line $BLOCK is never passed through awk -v, which cannot hold
# newlines - that failed on every second run.
NBEGIN="$(grep -cF "$BEGIN" "$SSH_CONFIG" || true)"
NEND="$(grep -cF "$END" "$SSH_CONFIG" || true)"

if [ "$NBEGIN" != "$NEND" ]; then
  die "$SSH_CONFIG has $NBEGIN start and $NEND end markers for '$ALIAS'.
  Refusing to edit a half-written block. Remove the lines between
    $BEGIN
    $END
  by hand, then re-run."
fi

if [ "$NBEGIN" -gt 0 ]; then
  tmp="$(mktemp)"
  # One pass: drop the managed block, collapse runs of blank lines to one,
  # and strip trailing blanks so repeated runs cannot grow the file.
  awk -v b="$BEGIN" -v e="$END" '
    index($0,b){skip=1; next}
    skip && index($0,e){skip=0; next}
    skip{next}
    {lines[++n]=$0}
    END{
      out=0; prevblank=0
      for(i=1;i<=n;i++){
        if(lines[i]==""){ if(prevblank) continue; prevblank=1 } else prevblank=0
        buf[++out]=lines[i]
      }
      while(out>0 && buf[out]=="") out--
      for(i=1;i<=out;i++) print buf[i]
    }
  ' "$SSH_CONFIG" > "$tmp"
  mv "$tmp" "$SSH_CONFIG"
  say "replaced existing block for '$ALIAS'"
else
  say "adding block for '$ALIAS'"
fi

printf '\n%s\n' "$BLOCK" >> "$SSH_CONFIG"
chmod 600 "$SSH_CONFIG"

step "Installing your public key into the VM"
if [ "$USE_TART_IP" -eq 1 ]; then
  ADDR="$(tart ip "$VM_NAME")" || die "tart ip $VM_NAME failed - is the VM running?"
else
  ADDR="$VM_HOST"
fi
say "target: $ALIAS ($VM_USER@$ADDR)"
say "you will be prompted for the VM password (this is the last time)"

# Connect via the alias so the known_hosts entry is written under HostKeyAlias.
# Using the raw address records it under a different name, and the BatchMode
# check below then fails on an unknown host key.
ssh-add -L | \
  ssh -o StrictHostKeyChecking=accept-new "$ALIAS" \
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh &&
     touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys &&
     while read -r k; do grep -qxF "$k" ~/.ssh/authorized_keys || echo "$k" >> ~/.ssh/authorized_keys; done &&
     echo "  authorized_keys now has $(wc -l < ~/.ssh/authorized_keys | tr -d " ") key(s)"'

step "Verifying agent forwarding"
set +e
FWD_OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${ALIAS}-git" 'ssh-add -l' 2>&1)"
FWD_RC=$?
set -e
case "$FWD_RC" in
  0) printf '%s\n' "$FWD_OUT" | sed 's/^/  /'; say "forwarding works via ${ALIAS}-git" ;;
  1) die "the agent was forwarded but holds no identities.
  Is $AGENT_NAME unlocked, and does it hold an SSH key?" ;;
  2) die "no agent reached the VM. Check that 'ForwardAgent yes' is present for
  ${ALIAS}-git in $SSH_CONFIG, then try: ssh -v ${ALIAS}-git" ;;
  255) die "could not connect to '${ALIAS}-git':
$(printf '%s' "$FWD_OUT" | sed 's/^/  /')" ;;
  *) die "unexpected failure (rc=$FWD_RC):
$(printf '%s' "$FWD_OUT" | sed 's/^/  /')" ;;
esac

step "Verifying the default alias forwards nothing"
set +e
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ALIAS" 'ssh-add -l' >/dev/null 2>&1
PLAIN_RC=$?
set -e
if [ "$PLAIN_RC" -eq 2 ] || [ "$PLAIN_RC" -eq 255 ]; then
  say "'$ALIAS' has no agent, as intended"
else
  say "WARNING: '$ALIAS' reached an agent (rc=$PLAIN_RC) - expected none"
fi

cat <<EOF

Done. Two ways to connect:

  ssh $ALIAS        no credentials reach the VM (use this by default)
  ssh ${ALIAS}-git    agent forwarded, VM can reach GitHub for that session

Next:

  1. Add your public key to GitHub:  https://github.com/settings/keys
     (gh ssh-key add needs admin:public_key, which this kit removes)

  2. Provision the guest:
       rsync -a --exclude .git ./ ${ALIAS}-git:~/pi-roost/
       ssh ${ALIAS}-git
       cd pi-roost && ./guest/macos/provision.sh --logout-gh

  3. Audit:
       ssh ${ALIAS}-git ./pi-roost/guest/macos/verify.sh --network
EOF
