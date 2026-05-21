#!/usr/bin/env bash
# cloud-setup.sh — Claude Code *cloud* session bootstrap for the belz CLI.
#
# Paste this into a cloud environment's "Setup script" field (or call it from
# the belz-sandbox clone — it is committed there by cli/scripts/cloud-publish.sh).
# It runs once, before Claude Code launches, and:
#   1. downloads the latest prebuilt belz Linux binary from the belz-sandbox
#      GitHub Release (so the cloud never needs the private belzabar repo), and
#   2. writes ~/.belz/config.json from the environment variables you configured
#      on the cloud environment (`belz setup --from-env`).
#
# The belz SKILLS are not installed here — they ride along in the belz-sandbox
# repo's .claude/skills/ (cloud loads skills from the cloned repo).
#
# Required environment variables (set on the cloud environment):
#   BELZ_SANDBOX_REPO   owner/belz-sandbox — the repo holding the belz release.
#   BELZ_ENV_<NAME>_URL / _USER / _PASSWORD [/ _PROJECT]  — one set per env, e.g.
#       BELZ_ENV_NSM_DEV_USER, BELZ_ENV_NSM_DEV_PASSWORD   (URL auto-filled)
#       BELZ_ENV_YS_QA_URL, BELZ_ENV_YS_QA_USER, BELZ_ENV_YS_QA_PASSWORD
#   Optional: BELZ_JENKINS_URL/_USER/_PASSWORD/_JOB, TEAMWORK_EMAIL/_PASSWORD
# Optional:
#   BELZ_RELEASE_TAG    release tag to pull (default: latest)
#   BELZ_SANDBOX_TOKEN  a read-only token for the release if `gh` isn't already
#                       authenticated (exported to gh as GH_TOKEN).
set -euo pipefail

REPO="${BELZ_SANDBOX_REPO:?set BELZ_SANDBOX_REPO=owner/belz-sandbox on the cloud environment}"
TAG="${BELZ_RELEASE_TAG:-latest}"
ASSET="belz-linux-x64"
BIN="$HOME/.local/bin/belz"
mkdir -p "$HOME/.local/bin"

echo "→ installing belz from ${REPO}@${TAG}…"
if command -v gh >/dev/null 2>&1; then
  [ -n "${BELZ_SANDBOX_TOKEN:-}" ] && export GH_TOKEN="$BELZ_SANDBOX_TOKEN"
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --output "$BIN" --clobber
elif [ -f "./$ASSET" ]; then
  # Fallback: a binary committed alongside this script in the clone.
  install -m 0755 "./$ASSET" "$BIN"
else
  echo "ERROR: need the GitHub CLI (gh) with access to $REPO, or a ./$ASSET in the clone." >&2
  exit 1
fi
chmod +x "$BIN"

# Make belz reachable from the session shell (cloud setup runs as root).
ln -sf "$BIN" /usr/local/bin/belz 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"

echo "→ writing ~/.belz/config.json from environment variables…"
belz setup --from-env --force --llm >/dev/null

echo "✓ belz ready — $("$BIN" --version 2>/dev/null || echo installed). Configured envs:"
belz envs 2>/dev/null || true
