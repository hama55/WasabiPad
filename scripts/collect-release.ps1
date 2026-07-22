param([switch]$OpenOutput)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root "target\release"
$output = Join-Path $root "release"
$builtExe = Join-Path $target "wasabipad.exe"
$config = Get-Content -LiteralPath (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$installerPattern = "$($config.productName)_$($config.version)_*-setup.exe"

if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
    throw "Release executable not found: $builtExe"
}

$installers = @(Get-ChildItem -Path (Join-Path $target "bundle\nsis") -Filter $installerPattern -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer matching '$installerPattern', found $($installers.Count)"
}

New-Item -ItemType Directory -Force $output | Out-Null
# release は配布専用。bookmark等の非生成ファイルは残し、古い実行ファイルだけ除去する。
Get-ChildItem -LiteralPath $output -Filter "*.exe" -File | Remove-Item -Force
$exeOutput = Join-Path $output "wasabipad.exe"
$installerOutput = Join-Path $output $installers[0].Name
Copy-Item -LiteralPath $builtExe -Destination $exeOutput -Force
Copy-Item -LiteralPath $installers[0].FullName -Destination $installerOutput -Force

Write-Host "EXE: $exeOutput"
Write-Host "Installer: $installerOutput"
if ($OpenOutput) {
    Invoke-Item $output
}
