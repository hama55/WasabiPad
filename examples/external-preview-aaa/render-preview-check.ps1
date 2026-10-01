# Feature: AAA input is rendered as an HTML preview.
# Scenario: The renderer writes escaped input to the explicitly chosen output path.
# Given: A temporary .aaa file contains HTML-like unsafe text.
# When: The renderer CLI receives that input and an output path.
# Then: The chosen output contains HTML with the unsafe text escaped.
$ErrorActionPreference = 'Stop'
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "wasabipad external preview aaa check $([guid]::NewGuid().ToString('N'))"
$exitCode = 0

try {
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $inputPath = Join-Path $temporaryDirectory 'unsafe.aaa'
    $outputPath = Join-Path $temporaryDirectory 'chosen-preview.html'
    [System.IO.File]::WriteAllText(
        $inputPath,
        "<script>alert('x')</script> &",
        [System.Text.UTF8Encoding]::new($false)
    )

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'render-preview.ps1') $inputPath $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "Renderer failed with exit code $LASTEXITCODE."
    }

    $html = [System.IO.File]::ReadAllText($outputPath, [System.Text.Encoding]::UTF8)
    if (-not $html.Contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp;")) {
        throw 'Expected escaped HTML was not found.'
    }
    if ($html.Contains("<script>alert('x')</script>")) {
        throw 'The input was not escaped as HTML.'
    }

    Write-Host 'Scenario passed: escaped input was written to the chosen HTML output.'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $exitCode = 1
} finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

exit $exitCode
