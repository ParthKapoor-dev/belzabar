# install.ps1 — Install or update the wi-impl CLI on Windows.
#
# Windows counterpart of apps/cli/scripts/install.sh:
#   - Rebuilds the wi-impl.exe binary and installs it to a per-user location.
#   - Records install metadata, and runs `wi-impl onboard` on first install.
#   - `belz` (the name before the rename) runs it too (belz.cmd).
#   - No admin required — installs to %LOCALAPPDATA%\wi-impl\bin and edits the
#     per-user PATH only.
#
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-EnvFile <path>] [-InstallDir <dir>]

param(
  [string]$EnvFile = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\wi-impl\bin"
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..\..")
$BelzConfigDir = Join-Path $env:USERPROFILE ".wi-impl"

# Before the rename the data lived in .belz: move it (once).
$LegacyHome = Join-Path $env:USERPROFILE ".belz"
if (-not (Test-Path $BelzConfigDir) -and (Test-Path $LegacyHome)) {
  Move-Item $LegacyHome $BelzConfigDir
  Write-Host "Moved .belz to .wi-impl (the CLI was renamed from belz to wi-impl)"
}

# Decide "first run" now: step 6 (record-install) creates config.json.
$FirstRun = -not (Test-Path (Join-Path $BelzConfigDir "config.json"))

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

# ── 3. Build the binary ───────────────────────────────────────────────────────
Write-Host "Building wi-impl binary..."
Push-Location (Join-Path $RepoRoot "apps\cli")
bun build --compile --minify --sourcemap .\bin\cli.ts --outfile wi-impl.exe
Pop-Location
$BuiltExe = Join-Path $RepoRoot "apps\cli\wi-impl.exe"

# ── 4. Install the binary ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Target = Join-Path $InstallDir "wi-impl.exe"
if (Test-Path $Target) {
  try {
    Move-Item -Force -Path $BuiltExe -Destination $Target -ErrorAction Stop
    Write-Host "wi-impl installed to $Target"
  } catch {
    # The binary is in use (e.g. `wi-impl update` is running) — stage + defer.
    $New = "$Target.new"
    Move-Item -Force -Path $BuiltExe -Destination $New
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $ScriptDir "swap-binary.ps1"),
      "-NewPath", $New, "-TargetPath", $Target
    )
    Write-Host "wi-impl is currently running — the new binary will swap in when it exits."
  }
} else {
  Move-Item -Force -Path $BuiltExe -Destination $Target
  Write-Host "wi-impl installed to $Target"
}

# `belz` (the name before the rename) runs the same binary; a pre-rename belz.exe is moved aside.
$Legacy = Join-Path $InstallDir "belz.exe"
if (Test-Path $Legacy) {
  Remove-Item -Force "$Legacy.prev" -ErrorAction SilentlyContinue
  Move-Item -Force $Legacy "$Legacy.prev" -ErrorAction SilentlyContinue
}
Set-Content -Encoding ASCII -Path (Join-Path $InstallDir "belz.cmd") -Value '@"%~dp0wi-impl.exe" %*'

# ── 5. Record install metadata ────────────────────────────────────────────────
$RepoUrl = (git -C $RepoRoot remote get-url origin 2>$null)
$RepoVersion = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
bun (Join-Path $ScriptDir "record-install.mjs") `
  "$RepoRoot" "$InstallDir" "$RepoUrl" "$RepoVersion"

# ── 6. PATH (per-user) ────────────────────────────────────────────────────────
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  Write-Host "Added $InstallDir to your user PATH (restart your shell to pick it up)."
}

# ── 7. First-time setup ───────────────────────────────────────────────────────
if ($FirstRun) {
  if ($EnvFile) {
    Write-Host "No config found - running 'wi-impl setup --env-file'..."
    & $Target setup --env-file $EnvFile
  } else {
    Write-Host "No config found - running 'wi-impl onboard'..."
    & $Target onboard
  }
}

Write-Host ""
Write-Host "Done! Try: wi-impl --help"
