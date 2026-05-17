# install.ps1 — Install or update the belz CLI on Windows.
#
# Windows counterpart of cli/scripts/install.sh:
#   - Rebuilds the belz.exe binary and installs it to a per-user location.
#   - Builds + installs the Next.js web app to %USERPROFILE%\.belz\web.
#   - Records install metadata, and runs `belz onboard` on first install.
#   - No admin required — installs to %LOCALAPPDATA%\belz\bin and edits the
#     per-user PATH only.
#
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-EnvFile <path>] [-InstallDir <dir>]

param(
  [string]$EnvFile = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\belz\bin"
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$BelzConfigDir = Join-Path $env:USERPROFILE ".belz"

# ── 1. Check bun ──────────────────────────────────────────────────────────────
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "bun is not installed. Install it first: https://bun.sh"
  exit 1
}
Write-Host "bun found: $(bun --version)"

# ── 2. Install dependencies ───────────────────────────────────────────────────
Write-Host "Installing dependencies..."
Push-Location $RepoRoot
bun install --ignore-scripts
Pop-Location

# ── 3. Build and install the web app ──────────────────────────────────────────
Write-Host "Building web app..."
$WebSrc = Join-Path $RepoRoot "web"
$WebDest = Join-Path $BelzConfigDir "web"

Push-Location $WebSrc
bun install --ignore-scripts
bun run build
Pop-Location

Write-Host "Installing web app to $WebDest..."
if (Test-Path $WebDest) { Remove-Item -Recurse -Force $WebDest }
New-Item -ItemType Directory -Force -Path $WebDest | Out-Null
# Copy the whole standalone tree (preserves the root/web nesting Next.js needs).
Copy-Item -Recurse -Force (Join-Path $WebSrc ".next\standalone\*") $WebDest
New-Item -ItemType Directory -Force -Path (Join-Path $WebDest "web\.next") | Out-Null
Copy-Item -Recurse -Force (Join-Path $WebSrc ".next\static") (Join-Path $WebDest "web\.next\static")
if (Test-Path (Join-Path $WebSrc "public")) {
  Copy-Item -Recurse -Force (Join-Path $WebSrc "public") (Join-Path $WebDest "web\public")
}
Write-Host "Web app installed to $WebDest"

# ── 4. Build the binary ───────────────────────────────────────────────────────
Write-Host "Building belz binary..."
Push-Location (Join-Path $RepoRoot "cli")
bun run generate
bun build --compile --minify --sourcemap .\bin\cli-build.ts --outfile belz.exe
Pop-Location
$BuiltExe = Join-Path $RepoRoot "cli\belz.exe"

# ── 5. Install the binary ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Target = Join-Path $InstallDir "belz.exe"
if (Test-Path $Target) {
  try {
    Move-Item -Force -Path $BuiltExe -Destination $Target -ErrorAction Stop
    Write-Host "belz installed to $Target"
  } catch {
    # The binary is in use (e.g. `belz update` is running) — stage + defer.
    $New = "$Target.new"
    Move-Item -Force -Path $BuiltExe -Destination $New
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $ScriptDir "swap-binary.ps1"),
      "-NewPath", $New, "-TargetPath", $Target
    )
    Write-Host "belz is currently running — the new binary will swap in when it exits."
  }
} else {
  Move-Item -Force -Path $BuiltExe -Destination $Target
  Write-Host "belz installed to $Target"
}

# ── 6. Record install metadata ────────────────────────────────────────────────
$RepoUrl = (git -C $RepoRoot remote get-url origin 2>$null)
$RepoVersion = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
bun (Join-Path $RepoRoot "cli\scripts\record-install.mjs") `
  "$RepoRoot" "$InstallDir" "$RepoUrl" "$RepoVersion"

# ── 7. PATH (per-user) ────────────────────────────────────────────────────────
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  Write-Host "Added $InstallDir to your user PATH (restart your shell to pick it up)."
}

# ── 8. First-time setup ───────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $BelzConfigDir "config.json"))) {
  if ($EnvFile) {
    Write-Host "No config found - running 'belz setup --env-file'..."
    & $Target setup --env-file $EnvFile
  } else {
    Write-Host "No config found - running 'belz onboard'..."
    & $Target onboard
  }
}

Write-Host ""
Write-Host "Done! Try: belz --help"
