#!/usr/bin/env bash
# Create and boot a Tart macOS VM, named after your GitHub login by default.
# Run on the macOS host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

BASE="ghcr.io/cirruslabs/macos-tahoe-base:latest"
VM_NAME=""
CPU=""
MEMORY=""
START=1

usage() {
  cat <<'EOF'
Usage: host/create-vm.sh [options]

  --from IMAGE    Base image to clone.
                  Default: ghcr.io/cirruslabs/macos-tahoe-base:latest (macOS 26)
                  Other variants:
                    ghcr.io/cirruslabs/macos-tahoe-vanilla:latest  (no extras)
                    ghcr.io/cirruslabs/macos-tahoe-xcode:latest    (+ Xcode, large)
                  Older: swap 'tahoe' for 'sequoia' or 'sonoma'.
  --name NAME     VM name (default: <github-login>-tart-test-vm, confirmed)
  --cpu N         vCPUs to assign
  --memory MB     Memory in MB
  --no-start      Clone only, do not boot
  -h, --help      Show this help

The cirruslabs images ship with auto-login enabled and the password 'admin'.
guest/provision.sh removes both - run it on every fresh clone.

After it boots, run:
  host/setup.sh --vm-name <name>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from)   BASE="$2"; shift 2 ;;
    --name)   VM_NAME="$2"; shift 2 ;;
    --cpu)    CPU="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

command -v tart >/dev/null || die "tart not found. Install it: brew install cirruslabs/cli/tart"
[ -n "$BASE" ] || { echo "error: --from cannot be empty" >&2; usage; exit 2; }
say "base image: $BASE"

step "Naming"
if [ -z "$VM_NAME" ]; then
  LOGIN="$(derive_github_login)"
  say "GitHub login detected: $LOGIN"
  VM_NAME="$(confirm_value 'VM name' "$(suggest_vm_name "$LOGIN")")"
fi
[ -n "$VM_NAME" ] || die "empty VM name"
say "VM name: $VM_NAME"

if tart list 2>/dev/null | awk '{print $2}' | grep -qx "$VM_NAME"; then
  say "VM '$VM_NAME' already exists, skipping clone"
else
  step "Cloning $BASE -> $VM_NAME"
  tart clone "$BASE" "$VM_NAME"
fi

if [ -n "$CPU" ] || [ -n "$MEMORY" ]; then
  step "Applying resources"
  # Non-fatal: flag names vary between tart releases.
  set +e
  [ -n "$CPU" ]    && tart set "$VM_NAME" --cpu "$CPU"       && say "cpu=$CPU"
  [ -n "$MEMORY" ] && tart set "$VM_NAME" --memory "$MEMORY" && say "memory=${MEMORY}MB"
  set -e
fi

if [ "$START" -eq 1 ]; then
  step "Booting (background)"
  nohup tart run "$VM_NAME" --no-graphics >/tmp/tart-$VM_NAME.log 2>&1 &
  say "log: /tmp/tart-$VM_NAME.log"

  printf '  waiting for an address'
  ADDR=""
  for _ in $(seq 1 60); do
    ADDR="$(tart ip "$VM_NAME" 2>/dev/null || true)"
    [ -n "$ADDR" ] && break
    printf '.'; sleep 2
  done
  printf '\n'
  [ -n "$ADDR" ] || die "VM did not get an address; check /tmp/tart-$VM_NAME.log"
  say "address: $ADDR"
fi

cat <<EOF

Next:

  host/setup.sh --vm-name $VM_NAME

That configures the 1Password agent forwarding and installs your key.
EOF
