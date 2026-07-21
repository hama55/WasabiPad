# リリースEXEとWindowsインストーラーをreleaseフォルダへ生成する。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot "scripts\collect-release.ps1") -OpenOutput
