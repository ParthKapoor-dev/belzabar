#!/usr/bin/env bash
# cloud/setup.sh — bootstrap belz inside a Claude Code *cloud* session.
# (published into belz-sandbox as cloud-setup.sh by cloud/publish.sh)
#
# IMPORTANT: cloud "Environment variables" are NOT exported to the pre-launch
# "Setup script" field — only to the running session. So this script must run
# IN-SESSION, not in the Setup script field. belz-sandbox wires it up two ways:
#   • a SessionStart hook (.claude/settings.json) runs it automatically, and
#   • CLAUDE.md tells the agent to run it first as a fallback.
# Both run where WI_IMPL_ENV_* / WI_IMPL_SANDBOX_TOKEN are available.
#
# It (1) installs the prebuilt belz Linux binary from the belz-sandbox release
# (private repo → no belzabar access), and (2) writes ~/.wi-impl/config.json via
# `belz setup --from-env`. It is idempotent — safe to re-run on every SessionStart.
#
# Env it reads (set on the cloud environment's Environment variables field):
#   WI_IMPL_ENV_<NAME>_URL/_USER/_PASSWORD[/_PROJECT]  — one set per env
#   Optional: WI_IMPL_JENKINS_*, TEAMWORK_*
#   WI_IMPL_SANDBOX_REPO   owner/belz-sandbox (else derived from this repo's origin)
#   WI_IMPL_SANDBOX_TOKEN  token to download the release if gh isn't authenticated
#   WI_IMPL_RELEASE_TAG    release tag (default: latest)
# (Each is also read under its name before the rename, BELZ_*.)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Repo: prefer the env var; otherwise derive from this clone's git origin.
REPO="${WI_IMPL_SANDBOX_REPO:-${BELZ_SANDBOX_REPO:-}}"
if [ -z "$REPO" ]; then
  origin="$(git -C "$HERE" remote get-url origin 2>/dev/null || true)"
  REPO="$(printf '%s' "$origin" | sed -E 's#^(https?://[^/]+/|git@[^:]+:)##; s#\.git$##')"
fi
[ -n "$REPO" ] || { echo "cloud-setup: cannot determine belz-sandbox repo (set WI_IMPL_SANDBOX_REPO)"; exit 0; }

TAG="${WI_IMPL_RELEASE_TAG:-${BELZ_RELEASE_TAG:-latest}}"
ASSET="belz-linux-x64"
BIN="$HOME/.local/bin/belz"
TOKEN="${WI_IMPL_SANDBOX_TOKEN:-${BELZ_SANDBOX_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}}"
mkdir -p "$HOME/.local/bin"

# 1. Install belz (skip the download if it's already here — SessionStart re-fires).
if [ ! -x "$BIN" ]; then
  echo "→ installing belz from ${REPO}@${TAG}…"
  if [ -f "$HERE/$ASSET" ]; then
    install -m 0755 "$HERE/$ASSET" "$BIN"
  elif command -v gh >/dev/null 2>&1; then
    [ -n "$TOKEN" ] && export GH_TOKEN="$TOKEN"
    gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --output "$BIN" --clobber
  elif [ -n "$TOKEN" ]; then
    api="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
    asset_url="$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$api" \
      | grep -o '"url": *"[^"]*releases/assets/[0-9]*"' | sed -E 's/.*"(https[^"]+)"/\1/' | head -1)"
    [ -n "$asset_url" ] && curl -fSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" "$asset_url" -o "$BIN"
  fi
  [ -x "$BIN" ] || chmod +x "$BIN" 2>/dev/null || true
fi
if [ ! -x "$BIN" ]; then
  echo "cloud-setup: could not install belz — set WI_IMPL_SANDBOX_TOKEN (read-only on $REPO)." >&2
  exit 0
fi

ln -sf "$BIN" /usr/local/bin/belz 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"

# 2. Write ~/.wi-impl/config.json from the session's environment variables.
echo "→ writing ~/.wi-impl/config.json from environment…"
if "$BIN" setup --from-env --force --llm >/dev/null 2>&1; then
  echo "✓ belz ready. Configured envs:"; "$BIN" envs 2>/dev/null || true
else
  echo "⚠ 'belz setup --from-env' wrote no envs — check the WI_IMPL_ENV_* variables." >&2
fi
