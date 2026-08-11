# リリースEXEとWindowsインストーラーをreleaseフォルダへ生成する。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$tsRsExportDir = Join-Path ([System.IO.Path]::GetTempPath()) "wasabipad-ts-rs-build-$PID"
$previousTsRsExportDir = $env:TS_RS_EXPORT_DIR
$env:TS_RS_EXPORT_DIR = $tsRsExportDir
cargo test --workspace --locked
$testExitCode = $LASTEXITCODE
if ($null -eq $previousTsRsExportDir) {
    Remove-Item Env:TS_RS_EXPORT_DIR -ErrorAction SilentlyContinue
} else {
    $env:TS_RS_EXPORT_DIR = $previousTsRsExportDir
}
if (Test-Path -LiteralPath $tsRsExportDir) {
    Remove-Item -LiteralPath $tsRsExportDir -Recurse -Force
}
if ($testExitCode -ne 0) { exit $testExitCode }

cargo check --workspace --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run tauri build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot "scripts\collect-release.ps1") -OpenOutput
