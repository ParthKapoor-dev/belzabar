#!/usr/bin/env bash
# install.sh — One-line installer for the belz CLI (Linux, macOS).
#
#   curl -fsSL https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.sh | bash
#
# Default (binary install): downloads the release binary for this OS/CPU, checks it against the
# release's SHA256SUMS, installs it to ~/.local/bin/belz and records a binary install, which
# keeps itself up to date (a background check at most once a day; see `belz update --help`).
# On a first install it then runs `belz onboard` (or `belz setup --env-file`).
#
# Flags (after `bash -s --` when piped):
#   --version <x.y.z>      Install that release instead of the latest.
#   --install-dir <dir>    Where the binary goes (default ~/.local/bin).
#   --env-file <path>      Non-interactive credentials for the first setup.
#   --no-setup             Skip the first-run `belz onboard` (scripts, CI, coding agents; also
#                          WI_IMPL_NO_SETUP=1). Run `belz onboard` / `belz setup` later.
#   --from-source          Clone the repo into $WI_IMPL_SRC_DIR (default ~/.wi-impl/src) and build it
#                          with bun instead (developers; updates via `belz update` + git).
#
# Credentials, sessions and caches in ~/.wi-impl/ are never touched.

set -euo pipefail

REPO="ParthKapoor-dev/belzabar"
RELEASES="${WI_IMPL_UPDATE_BASE_URL:-https://github.com/${REPO}/releases}"
RELEASES="${RELEASES%/}"
REPO_URL="${WI_IMPL_REPO_URL:-https://github.com/${REPO}.git}"
SRC_DIR="${WI_IMPL_SRC_DIR:-${HOME}/.wi-impl/src}"
WI_IMPL_DIR="${WI_IMPL_HOME:-${HOME}/.wi-impl}"

VERSION=""
INSTALL_DIR="${HOME}/.local/bin"
ENV_FILE=""
FROM_SOURCE=0
NO_SETUP="${WI_IMPL_NO_SETUP:-0}"
FORWARD=()

# ── Pretty logging ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi
log()  { printf "%s==>%s %s\n" "$BLUE" "$RESET" "$*"; }
ok()   { printf "%s ok%s  %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%swarn%s %s\n" "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf "%serr%s  %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     [[ $# -ge 2 ]] || die "--version needs a value"; VERSION="${2#v}"; shift 2 ;;
    --install-dir) [[ $# -ge 2 ]] || die "--install-dir needs a value"; INSTALL_DIR="$2"; FORWARD+=("$1" "$2"); shift 2 ;;
    --env-file)    [[ $# -ge 2 ]] || die "--env-file needs a value"; ENV_FILE="$2"; FORWARD+=("$1" "$2"); shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --no-setup)    NO_SETUP=1; shift ;;
    *) die "Unknown argument: $1 (see the header of install.sh)" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "Required command not found: curl"

# ── From source (developers) ──────────────────────────────────────────────────
if [[ "$FROM_SOURCE" == 1 ]]; then
  command -v git >/dev/null 2>&1 || die "Required command not found: git"
  if ! command -v bun >/dev/null 2>&1; then
    log "Installing bun via https://bun.sh/install"
    curl -fsSL https://bun.sh/install | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 || die "bun installed but is not on PATH. Add ~/.bun/bin to PATH and re-run."
  fi
  if [[ -d "$SRC_DIR/.git" ]]; then
    log "Updating existing checkout at $SRC_DIR"
    git -C "$SRC_DIR" fetch --quiet origin main
    git -C "$SRC_DIR" reset --hard origin/main
  else
    log "Cloning $REPO_URL into $SRC_DIR"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --depth 1 "$REPO_URL" "$SRC_DIR"
  fi
  ( cd "$SRC_DIR" && bun install --silent --ignore-scripts )
  log "Building and installing the belz binary"
  bash "$SRC_DIR/apps/cli/scripts/install.sh" ${FORWARD[@]+"${FORWARD[@]}"}
  exit 0
fi

# ── Binary install ────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "Unsupported OS $(uname -s). On Windows use install.ps1; elsewhere use --from-source." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "Unsupported CPU $(uname -m); use --from-source." ;;
esac
# An x64 shell under Rosetta on Apple Silicon still gets the native arm64 binary.
if [[ "$OS" == darwin && "$ARCH" == x64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == 1 ]]; then
  ARCH=arm64
fi
ASSET="belz-${OS}-${ARCH}"

if [[ -n "$VERSION" ]]; then
  URL_BASE="${RELEASES}/download/v${VERSION}"
else
  URL_BASE="${RELEASES}/latest/download"
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading $ASSET (${VERSION:+v$VERSION}${VERSION:-latest})"
curl -fSL --progress-bar -o "$TMP/$ASSET" "$URL_BASE/$ASSET" || die "Download failed: $URL_BASE/$ASSET"
curl -fsSL -o "$TMP/SHA256SUMS" "$URL_BASE/SHA256SUMS" || die "Download failed: $URL_BASE/SHA256SUMS"

EXPECTED="$(awk -v f="$ASSET" '$2 == f { print $1 }' "$TMP/SHA256SUMS")"
[[ -n "$EXPECTED" ]] || die "SHA256SUMS has no entry for $ASSET"
ACTUAL="$(sha256_of "$TMP/$ASSET")"
[[ "$EXPECTED" == "$ACTUAL" ]] || die "Checksum mismatch for $ASSET (expected $EXPECTED, got $ACTUAL). Nothing was installed."
ok "Checksum verified"

# Decide "first install" before recording the install creates config.json.
FIRST_RUN=0
[[ -f "$WI_IMPL_DIR/config.json" ]] || FIRST_RUN=1

mkdir -p "$INSTALL_DIR"
chmod 755 "$TMP/$ASSET"
mv -f "$TMP/$ASSET" "$INSTALL_DIR/belz.new"
mv -f "$INSTALL_DIR/belz.new" "$INSTALL_DIR/belz"
# An explicit --version is pinned (config.json "update.pin") so auto-update keeps it; a latest
# install clears any pin. The installer's own runs never start an update check.
WI_IMPL_RECORD_INSTALL=binary WI_IMPL_RECORD_PIN="$VERSION" "$INSTALL_DIR/belz" \
  || warn "Could not record the install in $WI_IMPL_DIR/config.json (auto-update stays off)."
export WI_IMPL_NO_UPDATE=1
ok "Installed $("$INSTALL_DIR/belz" --version) to $INSTALL_DIR/belz"
[[ -n "$VERSION" ]] && warn "Pinned to v$VERSION: auto-update is off until you remove \"update.pin\" from $WI_IMPL_DIR/config.json."

if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  warn "$INSTALL_DIR is not on your PATH. Add to your shell profile:"
  echo "    export PATH=\"\$PATH:$INSTALL_DIR\""
fi

if [[ "$FIRST_RUN" == 1 && "$NO_SETUP" == 1 ]]; then
  warn "No config yet (--no-setup): run 'belz onboard' in a terminal to add your environments."
elif [[ "$FIRST_RUN" == 1 ]]; then
  if [[ -n "$ENV_FILE" ]]; then
    log "No config found: running 'belz setup --env-file'"
    "$INSTALL_DIR/belz" setup --env-file "$ENV_FILE" || die "Setup aborted. Re-run 'belz setup' any time."
  elif ( exec < /dev/tty ) 2>/dev/null; then   # a terminal that can really be opened
    log "No config found: running 'belz onboard'"
    "$INSTALL_DIR/belz" onboard < /dev/tty || die "Onboarding aborted. Re-run 'belz onboard' any time."
  else
    warn "No config found and no terminal: run 'belz onboard' to add your environments."
  fi
fi

echo
ok "Done. Try: belz --help"
echo "Updates install themselves (at most one check a day); run 'belz update' to update now."
