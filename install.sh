#!/usr/bin/env bash
# install.sh — One-line installer for the belz CLI.
#
# Public command:
#
#   curl -fsSL https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.sh | bash
#
# What it does:
#   1. Ensures `bun` is available (offers to install it via the official
#      bun installer if missing).
#   2. Clones (or pulls) the repo into $BELZ_SRC_DIR (default ~/.belz/src).
#   3. Runs `bun install` to hydrate workspaces.
#   4. Hands off to cli/scripts/install.sh, which builds the binary,
#      installs it to ~/.local/bin/belz, and (on first install) walks
#      through credential setup.
#
# Flags forwarded to cli/scripts/install.sh:
#   --env-file <path>      Non-interactive credentials.
#   --install-dir <dir>    Override the binary install dir.
#
# Set BELZ_SRC_DIR to clone somewhere other than ~/.belz/src.

set -euo pipefail

REPO_URL="${BELZ_REPO_URL:-https://github.com/ParthKapoor-dev/belzabar.git}"
SRC_DIR="${BELZ_SRC_DIR:-${HOME}/.belz/src}"

# ── Pretty logging ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi
log()  { printf "%s==>%s %s\n" "$BLUE" "$RESET" "$*"; }
ok()   { printf "%s ok%s  %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%swarn%s %s\n" "$YELLOW" "$RESET" "$*" >&2; }
err()  { printf "%serr%s  %s\n" "$RED"   "$RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

need git
need curl

# ── Bun ───────────────────────────────────────────────────────────────────────
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun $(bun --version) already installed"
    return
  fi
  log "Installing bun via https://bun.sh/install"
  curl -fsSL https://bun.sh/install | bash
  # Refresh PATH for the rest of this script — bun installer drops itself in ~/.bun/bin
  export PATH="${HOME}/.bun/bin:${PATH}"
  command -v bun >/dev/null 2>&1 || die "bun install succeeded but bun is not on PATH. Add ~/.bun/bin to PATH and re-run."
  ok "bun $(bun --version) installed"
}

ensure_bun

# ── Clone or update ───────────────────────────────────────────────────────────
if [[ -d "$SRC_DIR/.git" ]]; then
  log "Updating existing checkout at $SRC_DIR"
  git -C "$SRC_DIR" fetch --quiet origin main
  git -C "$SRC_DIR" reset --hard origin/main
  ok "Synced to origin/main ($(git -C "$SRC_DIR" rev-parse --short HEAD))"
else
  log "Cloning $REPO_URL into $SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --depth 1 "$REPO_URL" "$SRC_DIR"
  ok "Cloned to $SRC_DIR"
fi

# ── Hydrate workspaces ────────────────────────────────────────────────────────
log "Hydrating workspaces (bun install)"
( cd "$SRC_DIR" && bun install --silent )
ok "Workspaces ready"

# ── Build + install binary + first-run setup ──────────────────────────────────
log "Building and installing the belz binary"
bash "$SRC_DIR/cli/scripts/install.sh" "$@"

# ── Friendly tail ─────────────────────────────────────────────────────────────
echo
ok "Installed. Try:"
echo "    belz --help"
echo "    belz setup       ${DIM}# (re-run credential walkthrough if needed)${RESET}"
echo "    belz ad show <uuid>"
echo "    belz pd show <name-or-id> --open"
echo
echo "Updates: re-run the same one-liner anytime."
