#!/usr/bin/env bash
# install.sh — Install or update the belz CLI
#
# Behaviour:
#   • Always rebuilds the binary and installs it to $INSTALL_DIR.
#   • If ~/.belz/config.json does not yet exist, runs `belz setup` at the end
#     to walk through interactive credential entry (or consumes --env-file).
#   • Existing credentials, sessions, and cache in ~/.belz/ are never touched
#     by this script.
#
# Usage: ./install.sh [--env-file <path>] [--install-dir <dir>]
#
# For a clean wipe + fresh install, use reinstall.sh instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BELZ_CONFIG_DIR="${HOME}/.belz"
INSTALL_DIR="${HOME}/.local/bin"
ENV_FILE=""

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--env-file <path>] [--install-dir <dir>]" >&2
      exit 1
      ;;
  esac
done

# ── 1. Check bun ─────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "❌ bun is not installed. Please install bun first: https://bun.sh" >&2
  exit 1
fi

echo "✅ bun found: $(bun --version)"

# ── 2. Detect existing installation ──────────────────────────────────────────
if [[ -f "$INSTALL_DIR/belz" ]]; then
  echo ""
  echo "📦 Existing installation detected at $INSTALL_DIR/belz"
  echo "   Updating binary — your credentials and sessions in ~/.belz/ are untouched."
fi

# ── 3. Migrate legacy sessions (non-destructive copy only) ───────────────────
OLD_SESSIONS="${HOME}/.belzabar-cli/sessions"
NEW_SESSIONS="${BELZ_CONFIG_DIR}/sessions"
if [[ -d "$OLD_SESSIONS" && ! -d "$NEW_SESSIONS" ]]; then
  echo "📦 Migrating sessions from $OLD_SESSIONS → $NEW_SESSIONS"
  mkdir -p "$NEW_SESSIONS"
  cp -n "$OLD_SESSIONS"/*.json "$NEW_SESSIONS/" 2>/dev/null || true
  echo "   (old directory preserved at $OLD_SESSIONS)"
fi

# ── 4. Install dependencies ───────────────────────────────────────────────────
echo ""
echo "📦 Installing dependencies..."
cd "$REPO_ROOT"
bun install --ignore-scripts

# ── 4b. Build and install the web app ─────────────────────────────────────────
echo ""
echo "🌐 Building web app..."
WEB_SRC="$REPO_ROOT/web"
WEB_DEST="$BELZ_CONFIG_DIR/web"

cd "$WEB_SRC"
bun install --ignore-scripts
bun run build

echo "📦 Installing web app to $WEB_DEST..."
rm -rf "$WEB_DEST"

# In a Bun monorepo Next.js standalone output nests the app one level deep:
#   .next/standalone/
#     node_modules/          ← shared monorepo deps (must stay one level above server.js)
#     web/
#       server.js            ← the actual Next.js server
#       node_modules/        ← app-level deps
#       .next/               ← server-side build
# We copy the whole standalone tree so relative paths between root and web/ are preserved.
cp -r "$WEB_SRC/.next/standalone/." "$WEB_DEST/"

# Static assets must live next to server.js in the web/ subdirectory
mkdir -p "$WEB_DEST/web/.next"
cp -r "$WEB_SRC/.next/static" "$WEB_DEST/web/.next/static"

# Public directory likewise
if [[ -d "$WEB_SRC/public" ]]; then
  cp -r "$WEB_SRC/public" "$WEB_DEST/web/public"
fi

echo "✅ Web app installed to $WEB_DEST"

# ── 5. Build the binary ───────────────────────────────────────────────────────
echo ""
echo "🔨 Building belz binary..."
cd "$REPO_ROOT/cli"
bun run generate
bun build --compile --minify --sourcemap ./bin/cli-build.ts --outfile belz

# ── 6. Install the binary ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
mv belz "$INSTALL_DIR/belz"
echo ""
echo "✅ belz installed to $INSTALL_DIR/belz"

# ── 6b. Record install metadata (source path, etc.) for `belz update` ─────────
REPO_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"
REPO_VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")"
bun "$REPO_ROOT/cli/scripts/record-install.mjs" \
  "$REPO_ROOT" "$INSTALL_DIR" "$REPO_URL" "$REPO_VERSION" || true

# ── 7. PATH check ─────────────────────────────────────────────────────────────
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "⚠️  Warning: $INSTALL_DIR is not on your PATH."
  echo "   Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "   export PATH=\"\$PATH:$INSTALL_DIR\""
fi

# ── 8. First-time setup ──────────────────────────────────────────────────────
# With --env-file, run `belz setup` non-interactively. Otherwise run the guided
# `belz onboard` flow (credentials + extension + web autostart).
if [[ ! -f "$BELZ_CONFIG_DIR/config.json" ]]; then
  echo ""
  if [[ -n "$ENV_FILE" ]]; then
    echo "🆕 No config found — running 'belz setup --env-file'…"
    if ! "$INSTALL_DIR/belz" setup --env-file "$ENV_FILE"; then
      echo "❌ Setup aborted. Re-run 'belz setup' any time to finish configuration." >&2
      exit 1
    fi
  else
    echo "🆕 No config found — running 'belz onboard'…"
    if ! "$INSTALL_DIR/belz" onboard; then
      echo "❌ Onboarding aborted. Re-run 'belz onboard' any time to finish setup." >&2
      exit 1
    fi
  fi
fi

echo ""
echo "🎉 Done! Try: belz --help"
