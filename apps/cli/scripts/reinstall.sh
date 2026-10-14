#!/usr/bin/env bash
# reinstall.sh — Wipe all wi-impl data and run a clean fresh install
#
# ⚠️  WARNING: This permanently deletes:
#     • ~/.wi-impl/        (all credentials, sessions, and cache)
#     • The existing wi-impl binary
#
# Use this only when you want a completely clean slate.
# To update the binary while keeping your credentials, use install.sh instead.
#
# Usage: ./reinstall.sh [--env-file <path>] [--install-dir <dir>] [--yes]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BELZ_CONFIG_DIR="${HOME}/.wi-impl"
INSTALL_DIR="${HOME}/.local/bin"
ENV_FILE=""
SKIP_CONFIRM=false

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
    --yes|-y)
      SKIP_CONFIRM=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--env-file <path>] [--install-dir <dir>] [--yes]" >&2
      exit 1
      ;;
  esac
done

# ── 1. Warn and confirm ───────────────────────────────────────────────────────
echo ""
echo "⚠️  WARNING: Clean reinstall will permanently delete the following:"
echo ""
echo "   📁 ${BELZ_CONFIG_DIR}/"
echo "      credentials (config.json), sessions/, cache/, and any other data"
if [[ -e "$INSTALL_DIR/wi-impl" || -e "$INSTALL_DIR/belz" ]]; then
  echo "   🗑️  $INSTALL_DIR/wi-impl and its belz alias  (existing binary)"
fi
echo ""
echo "   Your credentials will need to be re-entered."
echo ""

if [[ "$SKIP_CONFIRM" == false ]]; then
  read -rp "   Continue with clean reinstall? [y/N] " _confirm
  echo ""
  if [[ "$_confirm" != "y" && "$_confirm" != "Y" ]]; then
    echo "Aborted. Nothing was changed."
    exit 0
  fi
fi

# ── 2. Wipe existing data ─────────────────────────────────────────────────────
if [[ -d "$BELZ_CONFIG_DIR" ]]; then
  rm -rf "$BELZ_CONFIG_DIR"
  echo "🗑️  Deleted $BELZ_CONFIG_DIR"
fi
# The data dir before the rename (a directory, or the symlink left after the move).
if [[ -e "$HOME/.belz" || -L "$HOME/.belz" ]]; then
  rm -rf "$HOME/.belz"
  echo "🗑️  Deleted $HOME/.belz"
fi

for f in wi-impl belz wi-impl.prev belz.prev; do
  if [[ -e "$INSTALL_DIR/$f" || -L "$INSTALL_DIR/$f" ]]; then
    rm -f "$INSTALL_DIR/$f"
    echo "🗑️  Deleted $INSTALL_DIR/$f"
  fi
done

echo ""

# ── 3. Run fresh install ──────────────────────────────────────────────────────
# Delegate to install.sh — with no existing binary it will run first-time setup.
INSTALL_ARGS=("--install-dir" "$INSTALL_DIR")
[[ -n "$ENV_FILE" ]] && INSTALL_ARGS+=("--env-file" "$ENV_FILE")

exec bash "$SCRIPT_DIR/install.sh" "${INSTALL_ARGS[@]}"
