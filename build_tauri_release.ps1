# Tauri版のリリースEXEとWindowsインストーラーを生成する。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $PSScriptRoot "src-tauri\target\release\petapad-tauri.exe"
$installer = Get-ChildItem (Join-Path $PSScriptRoot "src-tauri\target\release\bundle\nsis\*.exe") |
    Select-Object -First 1

Write-Host "EXE: $exe"
if ($installer) {
    Write-Host "Installer: $($installer.FullName)"
}

Invoke-Item (Split-Path $exe)
