#!/usr/bin/env bash
# Shared helpers. Sourced by host/ and guest/ scripts.
# shellcheck shell=bash

say()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Refuse to run host-side scripts inside the guest. They modify ~/.ssh/config
# and push keys, so running them in the VM is both wrong and messy to undo.
# Override with PI_KIT_ALLOW_VM=1 if you really mean it.
assert_host() {
  case "$(sysctl -n hw.model 2>/dev/null)" in
    VirtualMac*)
      [ "${PI_KIT_ALLOW_VM:-0}" = "1" ] && return 0
      die "this is a host-side script, but you are running it inside a VM
  ($(sysctl -n hw.model 2>/dev/null)). Run it on your Mac instead.
  Set PI_KIT_ALLOW_VM=1 to override."
      ;;
  esac
}

# Lowercase, strip anything not [a-z0-9-], collapse and trim hyphens, cap at 50.
sanitise_label() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' \
    | cut -c1-50
}

# Resolve the operator's GitHub login, cheapest reliable source first.
#   1. gh, if installed and authenticated
#   2. the SSH agent - GitHub greets you by name over SSH ("Hi <login>!")
#   3. the local username
# Prints the login on stdout; never fails.
derive_github_login() {
  local login=""

  if command -v gh >/dev/null 2>&1; then
    login="$(gh api user --jq .login 2>/dev/null || true)"
  fi

  if [ -z "$login" ] && [ -n "${SSH_AUTH_SOCK:-}" ]; then
    # Exits 1 on success - GitHub refuses the shell but greets us first.
    login="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
               -o ConnectTimeout=8 -T git@github.com 2>&1 \
             | sed -n 's/^Hi \([^!]*\)!.*/\1/p' | head -1)"
  fi

  [ -n "$login" ] || login="${USER:-user}"
  sanitise_label "$login"
}

# Suggested VM name for a given login (default: derived).
suggest_vm_name() {
  local login="${1:-$(derive_github_login)}"
  printf '%s-tart-test-vm' "$login"
}

# Prompt with a default when interactive; accept the default otherwise.
#   confirm_value "VM name" "suggested-name"
confirm_value() {
  local prompt="$1" default="$2" reply=""
  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s [%s]: ' "$prompt" "$default" > /dev/tty
    IFS= read -r reply < /dev/tty || reply=""
  fi
  [ -n "$reply" ] || reply="$default"
  sanitise_label "$reply"
}
