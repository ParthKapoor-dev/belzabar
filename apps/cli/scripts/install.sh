#!/usr/bin/env bash
# install.sh — Install or update the wi-impl CLI
#
# Behaviour:
#   • Always rebuilds the binary and installs it to $INSTALL_DIR as `wi-impl`, with `belz`
#     (its name before the rename) as an alias.
#   • If ~/.wi-impl/config.json does not yet exist, runs `wi-impl setup` at the end
#     to walk through interactive credential entry (or consumes --env-file).
#   • Existing credentials, sessions, and cache in ~/.wi-impl/ are never touched
#     by this script.
#
# Usage: ./install.sh [--env-file <path>] [--install-dir <dir>]
#
# For a clean wipe + fresh install, use reinstall.sh instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BELZ_CONFIG_DIR="${HOME}/.wi-impl"
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

# Before the rename the data lived in ~/.belz: move it (once), leaving ~/.belz pointing at it.
if [[ ! -e "$HOME/.wi-impl" && -d "$HOME/.belz" && ! -L "$HOME/.belz" ]]; then
  mv "$HOME/.belz" "$HOME/.wi-impl"
  ln -s .wi-impl "$HOME/.belz" 2>/dev/null || true
  echo "📁 Moved ~/.belz to ~/.wi-impl (the CLI was renamed from belz to wi-impl)"
fi

# Decide "first run" now: step 6b (record-install) creates config.json, so
# testing for it at step 8 would never see a first run.
FIRST_RUN=0
[[ -f "$BELZ_CONFIG_DIR/config.json" ]] || FIRST_RUN=1

# ── 1. Check bun ─────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "❌ bun is not installed. Please install bun first: https://bun.sh" >&2
  exit 1
fi

echo "✅ bun found: $(bun --version)"

# ── 2. Detect existing installation ──────────────────────────────────────────
if [[ -f "$INSTALL_DIR/wi-impl" || -f "$INSTALL_DIR/belz" ]]; then
  echo ""
  echo "📦 Existing installation detected in $INSTALL_DIR"
  echo "   Updating binary — your credentials and sessions in ~/.wi-impl/ are untouched."
fi

# ── 3. Install dependencies ───────────────────────────────────────────────────
echo ""
echo "📦 Installing dependencies..."
cd "$REPO_ROOT"
bun install --ignore-scripts

# ── 4. Build the binary ───────────────────────────────────────────────────────
echo ""
echo "🔨 Building wi-impl binary..."
cd "$REPO_ROOT/apps/cli"
bun build --compile --minify --sourcemap ./bin/cli.ts --outfile wi-impl

# ── 5. Install the binary ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
mv wi-impl "$INSTALL_DIR/wi-impl"
# `belz` (the name before the rename) runs the same binary; it replaces a pre-rename binary.
ln -sfn wi-impl "$INSTALL_DIR/belz"
rm -f "$INSTALL_DIR/belz.prev"
echo ""
echo "✅ wi-impl installed to $INSTALL_DIR/wi-impl (alias: belz)"

# ── 6. Record install metadata (source path, etc.) for `wi-impl update` ─────────
REPO_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"
REPO_VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")"
bun "$SCRIPT_DIR/record-install.mjs" \
  "$REPO_ROOT" "$INSTALL_DIR" "$REPO_URL" "$REPO_VERSION" || true

# ── 7. PATH check ─────────────────────────────────────────────────────────────
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "⚠️  Warning: $INSTALL_DIR is not on your PATH."
  echo "   Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "   export PATH=\"\$PATH:$INSTALL_DIR\""
fi

# ── 8. First-time setup ──────────────────────────────────────────────────────
# With --env-file, run `wi-impl setup` non-interactively. Otherwise run the guided
# `wi-impl onboard` flow (credentials).
if [[ "$FIRST_RUN" == 1 ]]; then
  echo ""
  if [[ -n "$ENV_FILE" ]]; then
    echo "🆕 No config found — running 'wi-impl setup --env-file'…"
    if ! "$INSTALL_DIR/wi-impl" setup --env-file "$ENV_FILE"; then
      echo "❌ Setup aborted. Re-run 'wi-impl setup' any time to finish configuration." >&2
      exit 1
    fi
  else
    echo "🆕 No config found — running 'wi-impl onboard'…"
    if ! "$INSTALL_DIR/wi-impl" onboard; then
      echo "❌ Onboarding aborted. Re-run 'wi-impl onboard' any time to finish setup." >&2
      exit 1
    fi
  fi
fi

echo ""
echo "🎉 Done! Try: wi-impl --help"
