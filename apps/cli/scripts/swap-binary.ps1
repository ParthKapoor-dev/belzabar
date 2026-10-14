# swap-binary.ps1 — deferred binary swap for `wi-impl update` on Windows.
#
# Windows cannot overwrite a running .exe. When `wi-impl update` rebuilds the
# binary, the new file is staged as `wi-impl.exe.new` and this script is launched
# detached. It waits for the old binary to be released (the running wi-impl
# process to exit), then moves the new binary into place.
#
# Usage: swap-binary.ps1 -NewPath <wi-impl.exe.new> -TargetPath <wi-impl.exe>

param(
  [Parameter(Mandatory = $true)][string]$NewPath,
  [Parameter(Mandatory = $true)][string]$TargetPath
)

$ErrorActionPreference = 'SilentlyContinue'

# Poll for up to ~60s for the target to become writable, then swap.
for ($i = 0; $i -lt 120; $i++) {
  try {
    Move-Item -Force -Path $NewPath -Destination $TargetPath -ErrorAction Stop
    Write-Host "wi-impl updated."
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Write-Error "Could not replace $TargetPath — it stayed locked. Run: Move-Item -Force '$NewPath' '$TargetPath'"
exit 1
