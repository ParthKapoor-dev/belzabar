#!/usr/bin/env bash
# cloud/publish.sh — build the belz Linux binary and publish the cloud bundle
# to the belz-sandbox repo (the repo Claude Code cloud sessions connect to).
#
# belzabar stays private and is NEVER attached to a cloud session. Instead this
# script pushes everything a cloud session needs OUT to belz-sandbox:
#   • belz-linux-x64   → a rolling GitHub Release (tag: latest) on belz-sandbox
#   • .claude/skills/  ← agents/*/  (committed, so the cloud session loads them)
#   • CLAUDE.md        ← cloud/sandbox-CLAUDE.md (the "use belz, don't commit" rules)
#   • cloud-setup.sh   ← the session bootstrap script (committed for reference)
#
# Run locally (with your own gh auth) or from CI (.github/workflows/belz-cloud-release.yml).
#
# Requires: bun, git, and gh authenticated with contents:write on $SANDBOX_REPO
#           (in CI, set GH_TOKEN to a fine-grained PAT scoped to belz-sandbox only).
# Usage:    SANDBOX_REPO=owner/belz-sandbox bash cloud/publish.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_REPO="${SANDBOX_REPO:?set SANDBOX_REPO=owner/belz-sandbox}"
RELEASE_TAG="${RELEASE_TAG:-latest}"
ASSET="belz-linux-x64"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. Build the Linux binary ────────────────────────────────────────────────
echo "🔨 building $ASSET…"
cd "$REPO_ROOT"
# --ignore-scripts: we only need workspace deps for the compile.
# --frozen-lockfile with no fallback: the cloud binary must be built from the
# committed dependency set; a stale bun.lock fails the publish (CORE-R7).
bun install --frozen-lockfile --ignore-scripts
# Same Bun as CI (the CORE-1 stdout-flush workaround is Bun-1.2-specific).
EXPECTED_BUN="1.2.20"
if [[ "$(bun --version)" != "$EXPECTED_BUN" ]]; then
  echo "❌ cloud/publish.sh builds with Bun $EXPECTED_BUN (found $(bun --version)); see .github/workflows/ci.yml" >&2
  exit 1
fi
cd "$REPO_ROOT/apps/cli"
bun build --compile --minify --target=bun-linux-x64 ./bin/cli.ts --outfile "$WORK/$ASSET"

# ── 2. Refresh belz-sandbox tracked content (skills + rules + setup script) ──
# Make plain `git push` use gh's token (CI sets GH_TOKEN; locally uses your auth).
gh auth setup-git
echo "📥 cloning $SANDBOX_REPO…"
gh repo clone "$SANDBOX_REPO" "$WORK/sandbox" -- --depth=1
SB="$WORK/sandbox"

rm -rf "$SB/.claude/skills"
mkdir -p "$SB/.claude/skills"
for d in "$REPO_ROOT"/agents/*/; do
  [ -f "$d/SKILL.md" ] || continue
  name="$(basename "$d")"
  mkdir -p "$SB/.claude/skills/$name"
  cp -R "$d." "$SB/.claude/skills/$name/"
done
cp "$SCRIPT_DIR/sandbox-CLAUDE.md" "$SB/CLAUDE.md"
cp "$SCRIPT_DIR/setup.sh" "$SB/cloud-setup.sh"
# SessionStart hook that runs cloud-setup.sh in-session (where env vars exist).
mkdir -p "$SB/.claude"
cp "$SCRIPT_DIR/sandbox-settings.json" "$SB/.claude/settings.json"

# ── 3. Commit + push the content (only if it changed) ────────────────────────
cd "$SB"
git add -A
if git diff --cached --quiet; then
  echo "↔︎  skills/rules unchanged — no commit."
else
  SRC_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git -c user.name="belz-cloud-bot" -c user.email="belz-cloud-bot@users.noreply.github.com" \
    commit -m "chore(cloud): sync belz skills + rules (belzabar@${SRC_SHA})"
  # `-u origin HEAD` handles the first push into a brand-new empty repo.
  git push -u origin HEAD
  echo "⬆️  pushed skills/rules to $SANDBOX_REPO"
fi

# ── 4. Publish the binary as the rolling release ─────────────────────────────
gh release create "$RELEASE_TAG" --repo "$SANDBOX_REPO" \
  --title "belz (rolling)" --notes "Latest belz build, published by belzabar CI." 2>/dev/null || true
gh release upload "$RELEASE_TAG" "$WORK/$ASSET" --repo "$SANDBOX_REPO" --clobber
echo "✅ published $ASSET to $SANDBOX_REPO @ $RELEASE_TAG"
