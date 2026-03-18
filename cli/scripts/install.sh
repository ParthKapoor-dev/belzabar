#!/usr/bin/env bash
# install.sh — Install or update the belz CLI
#
# Behaviour:
#   • If belz is already installed: rebuilds the binary only.
#     Your credentials, sessions, and cache in ~/.belz/ are untouched.
#   • If belz is not yet installed: runs first-time setup — prompts for
#     credentials and writes ~/.belz/config.json before building.
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
IS_UPDATE=false
if [[ -f "$INSTALL_DIR/belz" ]]; then
  IS_UPDATE=true
  echo ""
  echo "📦 Existing installation detected at $INSTALL_DIR/belz"
  echo "   Updating binary — your credentials and sessions in ~/.belz/ are untouched."
fi

# ── 3. First-time setup: load / prompt credentials ───────────────────────────
if [[ "$IS_UPDATE" == false ]]; then
  echo ""
  echo "🆕 No existing installation found. Running first-time setup..."

  declare -A ENV_URLS=(
    [nsm-dev]="https://nsm-dev.nc.verifi.dev"
    [nsm-qa]="https://nsm-qa.nc.verifi.dev"
    [nsm-uat]="https://nsm-uat.nc.verifi.dev"
  )

  declare -A ENV_USERS
  declare -A ENV_PASS_B64

  # Prompt for .env file path if not already provided via --env-file
  if [[ -z "$ENV_FILE" ]]; then
    echo ""
    read -rp "📂 Path to .env credentials file (leave blank to enter manually): " _env_file_input
    if [[ -n "$_env_file_input" ]]; then
      ENV_FILE="$_env_file_input"
    fi
  fi

  _maybe_encode() {
    local val="$1"
    if [[ -z "$val" ]]; then echo ""; return; fi
    if echo "$val" | base64 -d &>/dev/null 2>&1; then
      echo "$val"
    else
      echo -n "$val" | base64
    fi
  }

  if [[ -n "$ENV_FILE" ]]; then
    echo "📂 Loading credentials from: $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a

    ENV_USERS[nsm-dev]="${NSM_DEV_USER:-}"
    ENV_USERS[nsm-qa]="${NSM_QA_USER:-}"
    ENV_USERS[nsm-uat]="${NSM_UAT_USER:-}"

    ENV_PASS_B64[nsm-dev]="$(_maybe_encode "${NSM_DEV_PASSWORD:-}")"
    ENV_PASS_B64[nsm-qa]="$(_maybe_encode "${NSM_QA_PASSWORD:-}")"
    ENV_PASS_B64[nsm-uat]="$(_maybe_encode "${NSM_UAT_PASSWORD:-}")"
  else
    echo "🔑 Enter credentials for each environment (leave blank to skip)."
    for env in nsm-dev nsm-qa nsm-uat; do
      echo ""
      echo "  Environment: $env (${ENV_URLS[$env]})"
      read -rp "    Username: " ENV_USERS[$env]
      read -rsp "    Password: " _plain_pass
      echo ""
      if [[ -n "$_plain_pass" ]]; then
        ENV_PASS_B64[$env]="$(echo -n "$_plain_pass" | base64)"
      else
        ENV_PASS_B64[$env]=""
      fi
    done
  fi

  # Write ~/.belz/config.json
  mkdir -p "$BELZ_CONFIG_DIR"

  _env_entry() {
    local env="$1"
    local url="${ENV_URLS[$env]}"
    local user="${ENV_USERS[$env]:-}"
    local pass="${ENV_PASS_B64[$env]:-}"
    echo "    \"$env\": {"
    echo "      \"url\": \"$url\""
    [[ -n "$user" ]] && echo "      ,\"user\": \"$user\""
    [[ -n "$pass" ]] && echo "      ,\"password\": \"$pass\""
    echo "    }"
  }

  CONFIG_JSON="$(cat <<EOF
{
  "environments": {
$(_env_entry nsm-dev),
$(_env_entry nsm-qa),
$(_env_entry nsm-uat)
  }
}
EOF
)"

  echo "$CONFIG_JSON" > "$BELZ_CONFIG_DIR/config.json"
  chmod 600 "$BELZ_CONFIG_DIR/config.json"
  echo "✅ Config written to $BELZ_CONFIG_DIR/config.json"

  # Migrate old sessions (copy only, never delete)
  OLD_SESSIONS="${HOME}/.belzabar-cli/sessions"
  NEW_SESSIONS="${BELZ_CONFIG_DIR}/sessions"
  if [[ -d "$OLD_SESSIONS" ]]; then
    echo "📦 Migrating sessions from $OLD_SESSIONS → $NEW_SESSIONS"
    mkdir -p "$NEW_SESSIONS"
    cp -n "$OLD_SESSIONS"/*.json "$NEW_SESSIONS/" 2>/dev/null || true
    echo "   (old directory preserved at $OLD_SESSIONS)"
  fi
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

# ── 7. PATH check ─────────────────────────────────────────────────────────────
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "⚠️  Warning: $INSTALL_DIR is not on your PATH."
  echo "   Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "   export PATH=\"\$PATH:$INSTALL_DIR\""
fi

echo ""
if [[ "$IS_UPDATE" == true ]]; then
  echo "🎉 Done! belz has been updated. Try: belz --help"
else
  echo "🎉 Done! belz is installed. Try: belz --help"
fi
