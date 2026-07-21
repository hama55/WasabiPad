# リリースEXEとWindowsインストーラーをreleaseフォルダへ生成する。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outputDir = Join-Path $PSScriptRoot "release"
New-Item -ItemType Directory -Force $outputDir | Out-Null

$builtExe = Join-Path $PSScriptRoot "target\release\petapad.exe"
$exe = Join-Path $outputDir "petapad.exe"
Copy-Item $builtExe $exe -Force

$installer = Get-ChildItem (Join-Path $PSScriptRoot "target\release\bundle\nsis\*.exe") |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

Write-Host "EXE: $exe"
if ($installer) {
    $installerOutput = Join-Path $outputDir $installer.Name
    Copy-Item $installer.FullName $installerOutput -Force
    Write-Host "Installer: $installerOutput"
}

Invoke-Item $outputDir
