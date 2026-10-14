# install.ps1 — One-line installer for the belz CLI (Windows x64).
#
#   irm https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.ps1 | iex
#
# Default (binary install): downloads belz-windows-x64.exe from the release, checks it against the
# release's SHA256SUMS, installs it to %LOCALAPPDATA%\belz\bin\belz.exe (added to your user PATH)
# and records a binary install, which keeps itself up to date (a background check at most once a
# day). On a first install it then runs `belz onboard`.
#
# Options (environment variables, since `irm | iex` takes no arguments):
#   WI_IMPL_VERSION=x.y.z      Install that release instead of the latest.
#   WI_IMPL_INSTALL_DIR=<dir>  Where belz.exe goes.
#   WI_IMPL_NO_SETUP=1         Skip the first-run `belz onboard` (scripts, CI, coding agents).
#   WI_IMPL_FROM_SOURCE=1      Clone into %USERPROFILE%\.wi-impl\src and build with bun instead.
#
# Credentials, sessions and caches in %USERPROFILE%\.wi-impl are never touched.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = "ParthKapoor-dev/belzabar"
$Releases = if ($env:WI_IMPL_UPDATE_BASE_URL) { $env:WI_IMPL_UPDATE_BASE_URL.TrimEnd('/') } else { "https://github.com/$Repo/releases" }
$InstallDir = if ($env:WI_IMPL_INSTALL_DIR) { $env:WI_IMPL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "belz\bin" }
$BelzDir = if ($env:WI_IMPL_HOME) { $env:WI_IMPL_HOME } else { Join-Path $env:USERPROFILE ".wi-impl" }

function Info($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host " ok  $m" -ForegroundColor Green }

# ── From source (developers) ────────────────────────────────────────────────
if ($env:WI_IMPL_FROM_SOURCE -eq "1") {
  $RepoUrl = if ($env:WI_IMPL_REPO_URL) { $env:WI_IMPL_REPO_URL } else { "https://github.com/$Repo.git" }
  $SrcDir = if ($env:WI_IMPL_SRC_DIR) { $env:WI_IMPL_SRC_DIR } else { Join-Path $env:USERPROFILE ".wi-impl\src" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required: https://git-scm.com/download/win" }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Info "Installing bun via https://bun.sh/install.ps1"
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  }
  if (Test-Path (Join-Path $SrcDir ".git")) {
    git -C $SrcDir fetch --quiet origin main
    git -C $SrcDir reset --hard origin/main
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SrcDir) | Out-Null
    git clone --depth 1 $RepoUrl $SrcDir
  }
  Push-Location $SrcDir; bun install --silent --ignore-scripts; Pop-Location
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SrcDir "apps\cli\scripts\install.ps1") -InstallDir $InstallDir
  return
}

# ── Binary install ──────────────────────────────────────────────────────────
if (-not [Environment]::Is64BitOperatingSystem) { throw "belz ships a 64-bit Windows binary only." }
$Asset = "belz-windows-x64.exe"
$Base = if ($env:WI_IMPL_VERSION) { "$Releases/download/v$($env:WI_IMPL_VERSION.TrimStart('v'))" } else { "$Releases/latest/download" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("belz-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  Info "Downloading $Asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")

  $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -eq $Asset } | Select-Object -First 1
  if (-not $Line) { throw "SHA256SUMS has no entry for $Asset" }
  $Expected = ($Line -split '\s+')[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Asset)).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset (expected $Expected, got $Actual). Nothing was installed." }
  Ok "Checksum verified"

  $FirstRun = -not (Test-Path (Join-Path $BelzDir "config.json"))
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir "belz.exe"
  if (Test-Path $Target) {
    # A running belz.exe can be renamed aside but not overwritten.
    Remove-Item -Force "$Target.prev" -ErrorAction SilentlyContinue
    Move-Item -Force $Target "$Target.prev"
  }
  Move-Item -Force (Join-Path $Tmp $Asset) $Target

  # An explicit WI_IMPL_VERSION is pinned (config.json "update.pin"); the installer's own runs never
  # start an update check.
  $env:WI_IMPL_RECORD_INSTALL = "binary"
  $env:WI_IMPL_RECORD_PIN = if ($env:WI_IMPL_VERSION) { $env:WI_IMPL_VERSION.TrimStart('v') } else { "" }
  & $Target
  Remove-Item Env:\WI_IMPL_RECORD_INSTALL, Env:\WI_IMPL_RECORD_PIN -ErrorAction SilentlyContinue
  $env:WI_IMPL_NO_UPDATE = "1"
  Ok "Installed $(& $Target --version) to $Target"
  if ($env:WI_IMPL_VERSION) { Write-Host "Pinned to v$($env:WI_IMPL_VERSION): auto-update is off until you remove `"update.pin`" from config.json." }

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your user PATH (restart your shell to pick it up)."
  }

  if ($FirstRun -and $env:WI_IMPL_NO_SETUP -eq "1") {
    Write-Host "No config yet (WI_IMPL_NO_SETUP=1): run 'belz onboard' to add your environments."
  } elseif ($FirstRun) {
    Info "No config found: running 'belz onboard'"
    & $Target onboard
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  # `irm | iex` runs in the caller's session: leave no installer variables behind.
  Remove-Item Env:\WI_IMPL_NO_UPDATE, Env:\WI_IMPL_RECORD_INSTALL, Env:\WI_IMPL_RECORD_PIN -ErrorAction SilentlyContinue
}

Write-Host ""
Ok "Done. Try: belz --help"
Write-Host "Updates install themselves (at most one check a day); run 'belz update' to update now."
