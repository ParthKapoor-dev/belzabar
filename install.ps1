# install.ps1 — One-line installer for the wi-impl CLI (Windows x64).
#
#   irm https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.ps1 | iex
#
# Default (binary install): downloads wi-impl-windows-x64.exe from the release, checks it against the
# release's SHA256SUMS, installs it to %LOCALAPPDATA%\wi-impl\bin\wi-impl.exe (added to your user PATH;
# `belz`, its name before the rename, runs it too)
# and records a binary install, which keeps itself up to date (a background check at most once a
# day). On a first install it then runs `wi-impl onboard`.
#
# Options (environment variables, since `irm | iex` takes no arguments):
#   WI_IMPL_VERSION=x.y.z      Install that release instead of the latest.
#   WI_IMPL_INSTALL_DIR=<dir>  Where wi-impl.exe goes.
#   WI_IMPL_NO_SETUP=1         Skip the first-run `wi-impl onboard` (scripts, CI, coding agents).
#   WI_IMPL_FROM_SOURCE=1      Clone into %USERPROFILE%\.wi-impl\src and build with bun instead.
#
# Credentials, sessions and caches in %USERPROFILE%\.wi-impl are never touched. An install from
# before the rename is updated where it is (%LOCALAPPDATA%\belz\bin) and its %USERPROFILE%\.belz is
# moved to .wi-impl. Variables are also read under their names before the rename (BELZ_*).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = "ParthKapoor-dev/belzabar"
# Each WI_IMPL_* option also reads its name before the rename (BELZ_*).
foreach ($n in "UPDATE_BASE_URL", "INSTALL_DIR", "HOME", "VERSION", "NO_SETUP", "FROM_SOURCE", "REPO_URL", "SRC_DIR") {
  if (-not (Test-Path "Env:\WI_IMPL_$n") -and (Test-Path "Env:\BELZ_$n")) { Set-Item "Env:\WI_IMPL_$n" (Get-Item "Env:\BELZ_$n").Value }
}
$Releases = if ($env:WI_IMPL_UPDATE_BASE_URL) { $env:WI_IMPL_UPDATE_BASE_URL.TrimEnd('/') } else { "https://github.com/$Repo/releases" }
$LegacyDir = Join-Path $env:LOCALAPPDATA "belz\bin"
# A pre-rename install (belz.exe in the old default dir) is updated where it is: its PATH entry stays.
$InstallDir = if ($env:WI_IMPL_INSTALL_DIR) { $env:WI_IMPL_INSTALL_DIR } elseif (Test-Path (Join-Path $LegacyDir "belz.exe")) { $LegacyDir } else { Join-Path $env:LOCALAPPDATA "wi-impl\bin" }
$BelzDir = if ($env:WI_IMPL_HOME) { $env:WI_IMPL_HOME } else { Join-Path $env:USERPROFILE ".wi-impl" }

function Info($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host " ok  $m" -ForegroundColor Green }

# ── Before the rename: move .belz to .wi-impl (the binary does the same on its first run) ──
$LegacyHome = Join-Path $env:USERPROFILE ".belz"
if (-not $env:WI_IMPL_HOME -and -not (Test-Path (Join-Path $env:USERPROFILE ".wi-impl")) -and (Test-Path $LegacyHome)) {
  Move-Item $LegacyHome (Join-Path $env:USERPROFILE ".wi-impl")
  Ok "Moved .belz to .wi-impl (the CLI was renamed from belz to wi-impl)"
}

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
if (-not [Environment]::Is64BitOperatingSystem) { throw "wi-impl ships a 64-bit Windows binary only." }
$Asset = "wi-impl-windows-x64.exe"
$LegacyAsset = "belz-windows-x64.exe" # what releases before the rename ship
$Base = if ($env:WI_IMPL_VERSION) { "$Releases/download/v$($env:WI_IMPL_VERSION.TrimStart('v'))" } else { "$Releases/latest/download" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("wi-impl-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")
  if (-not (Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -eq $Asset })) { $Asset = $LegacyAsset }
  Info "Downloading $Asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset)

  $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -eq $Asset } | Select-Object -First 1
  if (-not $Line) { throw "SHA256SUMS has no entry for $Asset" }
  $Expected = ($Line -split '\s+')[0].ToLower()
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp $Asset)).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset (expected $Expected, got $Actual). Nothing was installed." }
  Ok "Checksum verified"

  $FirstRun = -not (Test-Path (Join-Path $BelzDir "config.json"))
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir "wi-impl.exe"
  if (Test-Path $Target) {
    # A running wi-impl.exe can be renamed aside but not overwritten.
    Remove-Item -Force "$Target.prev" -ErrorAction SilentlyContinue
    Move-Item -Force $Target "$Target.prev"
  }
  Move-Item -Force (Join-Path $Tmp $Asset) $Target
  # `belz` (the name before the rename) runs the same binary; a pre-rename belz.exe is moved aside.
  $Legacy = Join-Path $InstallDir "belz.exe"
  if (Test-Path $Legacy) {
    Remove-Item -Force "$Legacy.prev" -ErrorAction SilentlyContinue
    Move-Item -Force $Legacy "$Legacy.prev"
  }
  Set-Content -Encoding ASCII -Path (Join-Path $InstallDir "belz.cmd") -Value '@"%~dp0wi-impl.exe" %*'

  # An explicit WI_IMPL_VERSION is pinned (config.json "update.pin"); the installer's own runs never
  # start an update check. (Also under the names before the rename, for a pre-rename version.)
  $env:WI_IMPL_RECORD_INSTALL = "binary"; $env:BELZ_RECORD_INSTALL = "binary"
  $env:WI_IMPL_RECORD_PIN = if ($env:WI_IMPL_VERSION) { $env:WI_IMPL_VERSION.TrimStart('v') } else { "" }
  $env:BELZ_RECORD_PIN = $env:WI_IMPL_RECORD_PIN
  & $Target
  Remove-Item Env:\WI_IMPL_RECORD_INSTALL, Env:\WI_IMPL_RECORD_PIN, Env:\BELZ_RECORD_INSTALL, Env:\BELZ_RECORD_PIN -ErrorAction SilentlyContinue
  $env:WI_IMPL_NO_UPDATE = "1"; $env:BELZ_NO_UPDATE = "1"
  Ok "Installed $(& $Target --version) to $Target (alias: belz)"
  if ($env:WI_IMPL_VERSION) { Write-Host "Pinned to v$($env:WI_IMPL_VERSION): auto-update is off until you remove `"update.pin`" from config.json." }

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to your user PATH (restart your shell to pick it up)."
  }

  if ($FirstRun -and $env:WI_IMPL_NO_SETUP -eq "1") {
    Write-Host "No config yet (WI_IMPL_NO_SETUP=1): run 'wi-impl onboard' to add your environments."
  } elseif ($FirstRun) {
    Info "No config found: running 'wi-impl onboard'"
    & $Target onboard
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  # `irm | iex` runs in the caller's session: leave no installer variables behind.
  Remove-Item Env:\WI_IMPL_NO_UPDATE, Env:\WI_IMPL_RECORD_INSTALL, Env:\WI_IMPL_RECORD_PIN, Env:\BELZ_NO_UPDATE, Env:\BELZ_RECORD_INSTALL, Env:\BELZ_RECORD_PIN -ErrorAction SilentlyContinue
}

Write-Host ""
Ok "Done. Try: wi-impl --help"
Write-Host "Updates install themselves (at most one check a day); run 'wi-impl update' to update now."
