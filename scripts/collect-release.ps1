param([switch]$OpenOutput)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root "target\release"
$output = Join-Path $root "release"
$builtExe = Join-Path $target "petapad.exe"

if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
    throw "Release executable not found: $builtExe"
}

$installers = @(Get-ChildItem -Path (Join-Path $target "bundle\nsis") -Filter "*-setup.exe" -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer, found $($installers.Count)"
}

New-Item -ItemType Directory -Force $output | Out-Null
$exeOutput = Join-Path $output "petapad.exe"
$installerOutput = Join-Path $output $installers[0].Name
Copy-Item -LiteralPath $builtExe -Destination $exeOutput -Force
Copy-Item -LiteralPath $installers[0].FullName -Destination $installerOutput -Force

Write-Host "EXE: $exeOutput"
Write-Host "Installer: $installerOutput"
if ($OpenOutput) {
    Invoke-Item $output
}
