param(
    [string]$InputPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InputPath) -or
    [string]::IsNullOrWhiteSpace($OutputPath) -or
    $args.Count -ne 0) {
    [Console]::Error.WriteLine('Usage: render-preview.ps1 <inputPath> <outputPath>')
    exit 2
}

try {
    $template = [System.IO.File]::ReadAllText(
        (Join-Path $PSScriptRoot 'template.html'),
        [System.Text.Encoding]::UTF8
    )
    $sourceText = [System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8)
    $fileName = [System.Net.WebUtility]::HtmlEncode([System.IO.Path]::GetFileName($InputPath))
    $content = [System.Net.WebUtility]::HtmlEncode($sourceText)
    $replaceToken = [System.Text.RegularExpressions.MatchEvaluator] {
        param($match)
        if ($match.Groups[1].Value -eq 'FILE_NAME') { $fileName } else { $content }
    }
    $output = [System.Text.RegularExpressions.Regex]::Replace(
        $template,
        '\{\{(FILE_NAME|CONTENT)\}\}',
        $replaceToken
    )
    [System.IO.File]::WriteAllText(
        $OutputPath,
        $output,
        [System.Text.UTF8Encoding]::new($false)
    )
} catch {
    [Console]::Error.WriteLine("Preview generation failed: $($_.Exception.Message)")
    exit 1
}
