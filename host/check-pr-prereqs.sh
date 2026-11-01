#!/usr/bin/env bash
# Check whether a repository has the branch protection that makes an
# agent-held PR token safe. Read-only. Exits 0 only on a clear PASS.
#
# Why this exists: `pull_requests: write` includes merging, so a token that can
# open a PR can also merge it. Required reviews are the control that separates
# the two. This gate refuses to assume that control exists.
set -uo pipefail

REPO=""
BRANCH=""
APP_SLUG=""
QUIET=0

usage() {
  cat <<'EOF'
Usage: host/check-pr-prereqs.sh --repo OWNER/NAME [options]

  --repo OWNER/NAME   Repository to check (required)
  --branch NAME       Branch to check (default: the repo's default branch)
  --app-slug SLUG     Also fail if this GitHub App can bypass the rules
  --quiet             Only print the verdict line
  -h, --help          Show this help

Exit codes:
  0  PASS         protection requiring review is in effect
  1  UNPROTECTED  no such protection
  2  UNAVAILABLE  the plan does not offer it for this repository
  3  UNVERIFIABLE could not determine (no admin rights, auth, or network)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --app-slug) APP_SLUG="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 3 ;;
  esac
done
[ -n "$REPO" ] || { echo "error: --repo is required" >&2; usage; exit 3; }

say()  { [ "$QUIET" -eq 1 ] || printf '  %s\n' "$*"; }
step() { [ "$QUIET" -eq 1 ] || printf '\n==> %s\n' "$*"; }
verdict() { printf '%s  %s\n' "$1" "$2"; }

command -v gh >/dev/null || { verdict UNVERIFIABLE "gh not installed"; exit 3; }
gh auth status >/dev/null 2>&1 || {
  verdict UNVERIFIABLE "gh is not authenticated; cannot read protection settings"; exit 3; }

step "Repository"
META="$(gh api "repos/$REPO" 2>&1)" || {
  verdict UNVERIFIABLE "cannot read $REPO: $(printf '%s' "$META" | head -1)"; exit 3; }
IS_ADMIN="$(printf '%s' "$META" | gh api --method GET /rate_limit >/dev/null 2>&1; \
            printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("permissions",{}).get("admin",False))' 2>/dev/null)"
[ -n "$BRANCH" ] || BRANCH="$(printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)["default_branch"])' 2>/dev/null)"
say "$REPO, branch $BRANCH"

# Protection settings are only visible to admins. Without that, a 404 means
# "no permission" and "no protection" indistinguishably - so do not guess.
if [ "$IS_ADMIN" != "True" ]; then
  verdict UNVERIFIABLE "you are not an admin of $REPO; protection settings are not readable"
  exit 3
fi

step "Rulesets"
RULES="$(gh api "repos/$REPO/rules/branches/$BRANCH" 2>&1)"
if printf '%s' "$RULES" | grep -q "Upgrade to GitHub Pro"; then
  verdict UNAVAILABLE "branch protection is not available for this repository on its current plan"
  say ""
  say "GitHub Free includes rulesets for public repositories only."
  say "Options: make the repository public, upgrade the plan, or do not give"
  say "the agent a token that can merge (see docs/PR-OPTIONS.md options 1-2)."
  exit 2
fi

REVIEWS=0
if printf '%s' "$RULES" | grep -q '"type"'; then
  TYPES="$(printf '%s' "$RULES" | python3 -c 'import json,sys;print(",".join(r["type"] for r in json.load(sys.stdin)))' 2>/dev/null)"
  say "active rules: ${TYPES:-none}"
  REVIEWS="$(printf '%s' "$RULES" | python3 -c '
import json,sys
n=0
for r in json.load(sys.stdin):
    if r.get("type")=="pull_request":
        n=max(n, r.get("parameters",{}).get("required_approving_review_count",0))
print(n)' 2>/dev/null || echo 0)"
fi

if [ "${REVIEWS:-0}" -lt 1 ]; then
  step "Classic branch protection"
  PROT="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1)"
  if printf '%s' "$PROT" | grep -q '"required_pull_request_reviews"'; then
    REVIEWS="$(printf '%s' "$PROT" | python3 -c '
import json,sys
d=json.load(sys.stdin).get("required_pull_request_reviews") or {}
print(d.get("required_approving_review_count",0))' 2>/dev/null || echo 0)"
    ENFORCE="$(printf '%s' "$PROT" | python3 -c '
import json,sys;print(json.load(sys.stdin).get("enforce_admins",{}).get("enabled",False))' 2>/dev/null)"
    say "required approving reviews: $REVIEWS"
    [ "$ENFORCE" = "True" ] || say "NOTE: admins can bypass ('Do not allow bypassing the above settings' is off)"
  else
    say "none"
  fi
fi

if [ "${REVIEWS:-0}" -lt 1 ]; then
  verdict UNPROTECTED "$BRANCH does not require an approving review"
  say ""
  say "A token with pull_requests:write could open AND merge a PR."
  say "Enable required reviews, or use docs/PR-OPTIONS.md options 1-2."
  exit 1
fi

if [ -n "$APP_SLUG" ]; then
  step "Bypass actors"
  IDS="$(gh api "repos/$REPO/rulesets" --jq '.[].id' 2>/dev/null)"
  for id in $IDS; do
    if gh api "repos/$REPO/rulesets/$id" --jq '.bypass_actors[]?.actor_id' 2>/dev/null | grep -q .; then
      say "ruleset $id has bypass actors - verify '$APP_SLUG' is not among them"
    fi
  done
fi

verdict PASS "$BRANCH requires $REVIEWS approving review(s)"
exit 0
