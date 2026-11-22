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
# Launcher for the pi-roost wizard. Checks what the wizard needs, finds or
# installs Node, installs the wizard's packages, and starts it.
# Run on the macOS host, not in the VM. The design is in docs/WIZARD.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

WIZARD_DIR="$(cd "$SCRIPT_DIR/../wizard" && pwd)"
ROOST_HOME="${PI_ROOST_HOME:-$HOME/.pi-roost}"

# The wizard's TUI library needs Node 22.19 or later.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19

# The private copy. The checksum is the one published in
# https://nodejs.org/dist/v24.22.3/SHASUMS256.txt for the file below.
NODE_PIN="24.22.3"
NODE_PIN_NAME="node-v$NODE_PIN-darwin-arm64"
NODE_PIN_SHA256="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"

usage() {
  cat <<EOF
Usage: host/wizard.sh

Starts the pi-roost wizard, which gives the VM access to one GitHub
repository through deploy keys held in Secretive.

The wizard needs Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR or later. If none is found, this script
offers to install a private copy in $ROOST_HOME, or Node from Homebrew.
Without Node, use the host/*.sh scripts directly.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; usage; exit 2 ;;
esac

assert_host

# Succeeds when "$1" is a Node that is new enough and can run the wizard's
# TypeScript files directly.
node_ok() {
  local node="$1" version major rest minor
  [ -n "$node" ] && [ -x "$node" ] || return 1
  version="$("$node" --version 2>/dev/null)" || return 1
  version="${version#v}"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -lt "$NODE_MIN_MAJOR" ]; then return 1; fi
  if [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; then return 1; fi
  "$node" --input-type=module -e 'await import(process.argv[1])' "$WIZARD_DIR/src/keys.ts" >/dev/null 2>&1
}

# Prints the first usable Node: on the PATH, installed globally, or the
# private copy from an earlier run.
find_node() {
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$ROOST_HOME/node/bin/node"; do
    if node_ok "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

install_private_node() {
  local tmp got
  [ "$(uname -m)" = "arm64" ] || die "the private copy is for Apple silicon only.
  Install Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR or later yourself, then run this again."
  tmp="$(mktemp -d)"
  say "downloading Node v$NODE_PIN from nodejs.org"
  if ! curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v$NODE_PIN/$NODE_PIN_NAME.tar.gz"; then
    rm -rf "$tmp"
    die "the download failed."
  fi
  got="$(shasum -a 256 "$tmp/node.tar.gz" | awk '{print $1}')"
  if [ "$got" != "$NODE_PIN_SHA256" ]; then
    rm -rf "$tmp"
    die "the download does not match the pinned checksum. Nothing was installed.
  expected $NODE_PIN_SHA256
  got      $got"
  fi
  say "checksum matches"
  mkdir -p "$ROOST_HOME"
  chmod 700 "$ROOST_HOME"
  rm -rf "${ROOST_HOME:?}/$NODE_PIN_NAME"
  tar -xzf "$tmp/node.tar.gz" -C "$ROOST_HOME"
  rm -rf "$tmp"
  ln -sfn "$NODE_PIN_NAME" "$ROOST_HOME/node"
  say "installed in $ROOST_HOME/node"
}

choose_node_install() {
  local reply=""
  say "The wizard needs Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR or later, and none was found."
  say ""
  say "  1) A private copy for pi-roost (default)"
  say "     Node v$NODE_PIN in $ROOST_HOME, not on your PATH."
  say "     Deleting that folder removes it."
  say "  2) Node for the whole system, with Homebrew"
  say "     Runs: brew install node"
  say "  3) Neither. Use the host/*.sh scripts without the wizard."
  say ""
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    die "no terminal to ask on. Run this from Terminal."
  fi
  printf '  Choice [1]: ' > /dev/tty
  IFS= read -r reply < /dev/tty || reply=""
  case "${reply:-1}" in
    1) install_private_node ;;
    2) say "running: brew install node"
       brew install node || die "brew install node failed." ;;
    3) say "Nothing was installed."
       exit 0 ;;
    *) die "not a choice: $reply" ;;
  esac
}

step "Checking the host"
xcode-select -p >/dev/null 2>&1 || die "the Xcode Command Line Tools are missing.
  Install them with: xcode-select --install"
say "Xcode Command Line Tools found"
command -v brew >/dev/null 2>&1 || die "Homebrew is missing.
  Install it with the Homebrew.pkg installer from
  https://github.com/Homebrew/brew/releases/latest"
say "Homebrew found"

if ! NODE="$(find_node)"; then
  choose_node_install
  NODE="$(find_node)" || die "Node still cannot be found, or cannot run the wizard."
fi
say "Node $("$NODE" --version) at $NODE"

# The wizard's packages live in its own folder. They are installed from the
# lockfile, with install scripts disabled, and again whenever it changes.
NODE_BIN="$(dirname "$NODE")"
LOCK_SUM="$(shasum -a 256 "$WIZARD_DIR/package-lock.json" | awk '{print $1}')"
STAMP="$WIZARD_DIR/node_modules/.pi-roost-lock"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$LOCK_SUM" ]; then
  step "Installing the wizard's packages"
  [ -x "$NODE_BIN/npm" ] || die "npm was not found next to $NODE."
  (cd "$WIZARD_DIR" && PATH="$NODE_BIN:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier) \
    || die "npm could not install the wizard's packages."
  printf '%s' "$LOCK_SUM" > "$STAMP"
fi

exec "$NODE" --disable-warning=ExperimentalWarning "$WIZARD_DIR/src/main.ts"
