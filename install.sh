#!/usr/bin/env bash
# install.sh — Build and install the unified belz CLI
# Usage: ./install.sh [--env-file <path>] [--install-dir <dir>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# ── 2. Load / prompt credentials ─────────────────────────────────────────────
declare -A ENV_URLS=(
  [nsm-dev]="https://nsm-dev.nc.verifi.dev"
  [nsm-qa]="https://nsm-qa.nc.verifi.dev"
  [nsm-uat]="https://nsm-uat.nc.verifi.dev"
)

declare -A ENV_USERS
declare -A ENV_PASS_B64

if [[ -n "$ENV_FILE" ]]; then
  echo "📂 Loading credentials from: $ENV_FILE"
  # Source the env file in a subshell to pick up variables
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  ENV_USERS[nsm-dev]="${NSM_DEV_USER:-}"
  ENV_USERS[nsm-qa]="${NSM_QA_USER:-}"
  ENV_USERS[nsm-uat]="${NSM_UAT_USER:-}"

  # Passwords may already be base64 (from NSM_*_PASSWORD env vars convention)
  # Accept plaintext too: if value looks like base64 try decoding it to validate,
  # otherwise base64-encode the plaintext.
  _maybe_encode() {
    local val="$1"
    if [[ -z "$val" ]]; then
      echo ""
      return
    fi
    # If it decodes without error and re-encodes identically, treat as already encoded
    if echo "$val" | base64 -d &>/dev/null 2>&1; then
      echo "$val"
    else
      echo -n "$val" | base64
    fi
  }

  ENV_PASS_B64[nsm-dev]="$(_maybe_encode "${NSM_DEV_PASSWORD:-}")"
  ENV_PASS_B64[nsm-qa]="$(_maybe_encode "${NSM_QA_USER:-}")"
  ENV_PASS_B64[nsm-uat]="$(_maybe_encode "${NSM_UAT_PASSWORD:-}")"

  # Use more reliable per-env password vars if present
  [[ -n "${NSM_DEV_PASSWORD:-}" ]]  && ENV_PASS_B64[nsm-dev]="$(_maybe_encode "${NSM_DEV_PASSWORD}")"
  [[ -n "${NSM_QA_PASSWORD:-}" ]]   && ENV_PASS_B64[nsm-qa]="$(_maybe_encode "${NSM_QA_PASSWORD}")"
  [[ -n "${NSM_UAT_PASSWORD:-}" ]]  && ENV_PASS_B64[nsm-uat]="$(_maybe_encode "${NSM_UAT_PASSWORD}")"
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

# ── 3. Write ~/.belz/config.json ─────────────────────────────────────────────
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

# ── 4. Migrate old sessions (copy only, never delete) ────────────────────────
OLD_SESSIONS="${HOME}/.belzabar-cli/sessions"
NEW_SESSIONS="${BELZ_CONFIG_DIR}/sessions"

if [[ -d "$OLD_SESSIONS" ]]; then
  echo "📦 Migrating sessions from $OLD_SESSIONS → $NEW_SESSIONS"
  mkdir -p "$NEW_SESSIONS"
  # Copy only — do not delete old directory
  cp -n "$OLD_SESSIONS"/*.json "$NEW_SESSIONS/" 2>/dev/null || true
  echo "   (old directory preserved at $OLD_SESSIONS)"
fi

# ── 5. Install dependencies ───────────────────────────────────────────────────
echo ""
echo "📦 Installing dependencies..."
cd "$SCRIPT_DIR"
bun install

# ── 6. Build the binary ───────────────────────────────────────────────────────
echo ""
echo "🔨 Building belz binary..."
cd "$SCRIPT_DIR/apps/automation-designer"
bun run generate
bun build --compile --minify --sourcemap ./bin/cli-build.ts --outfile belz

# ── 7. Install the binary ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
mv belz "$INSTALL_DIR/belz"
echo ""
echo "✅ belz installed to $INSTALL_DIR/belz"

# ── 8. PATH check ─────────────────────────────────────────────────────────────
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "⚠️  Warning: $INSTALL_DIR is not on your PATH."
  echo "   Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "   export PATH=\"\$PATH:$INSTALL_DIR\""
fi

echo ""
echo "🎉 Done! Try: belz --help"
