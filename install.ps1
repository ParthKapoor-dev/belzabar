# install.ps1 — One-line installer for the belz CLI on Windows.
#
# Public command (PowerShell):
#
#   irm https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.ps1 | iex
#
# What it does:
#   1. Ensures `git` and `bun` are available (installs bun if missing).
#   2. Clones (or updates) the repo into $env:BELZ_SRC_DIR
#      (default %USERPROFILE%\.belz\src).
#   3. Runs `bun install` to hydrate workspaces.
#   4. Hands off to cli\scripts\install.ps1, which builds belz.exe, installs
#      the web app, and (on first install) runs `belz onboard`.
#
# Set $env:BELZ_SRC_DIR to clone somewhere other than %USERPROFILE%\.belz\src.

$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:BELZ_REPO_URL) { $env:BELZ_REPO_URL } else { "https://github.com/ParthKapoor-dev/belzabar.git" }
$SrcDir = if ($env:BELZ_SRC_DIR) { $env:BELZ_SRC_DIR } else { Join-Path $env:USERPROFILE ".belz\src" }

function Info($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host " ok  $m" -ForegroundColor Green }

# ── Preflight ─────────────────────────────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git is required. Install Git for Windows: https://git-scm.com/download/win"
  exit 1
}

# ── Bun ───────────────────────────────────────────────────────────────────────
if (Get-Command bun -ErrorAction SilentlyContinue) {
  Ok "bun $(bun --version) already installed"
} else {
  Info "Installing bun via https://bun.sh/install.ps1"
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun installed but is not on PATH. Add %USERPROFILE%\.bun\bin to PATH and re-run."
    exit 1
  }
  Ok "bun $(bun --version) installed"
}

# ── Clone or update ───────────────────────────────────────────────────────────
if (Test-Path (Join-Path $SrcDir ".git")) {
  Info "Updating existing checkout at $SrcDir"
  git -C $SrcDir fetch --quiet origin main
  git -C $SrcDir reset --hard origin/main
  Ok "Synced to origin/main ($(git -C $SrcDir rev-parse --short HEAD))"
} else {
  Info "Cloning $RepoUrl into $SrcDir"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SrcDir) | Out-Null
  git clone --depth 1 $RepoUrl $SrcDir
  Ok "Cloned to $SrcDir"
}

# ── Hydrate workspaces ────────────────────────────────────────────────────────
Info "Hydrating workspaces (bun install)"
Push-Location $SrcDir
bun install --silent
Pop-Location
Ok "Workspaces ready"

# ── Build + install + first-run ───────────────────────────────────────────────
Info "Building and installing the belz binary"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SrcDir "cli\scripts\install.ps1") @args

Write-Host ""
Ok "Installed. Try:"
Write-Host "    belz --help"
Write-Host "    belz onboard"
Write-Host ""
Write-Host "Updates: run 'belz update' (or re-run this one-liner) any time."
