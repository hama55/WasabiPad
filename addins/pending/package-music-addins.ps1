param(
    [string]$ReleaseTag = 'music-addins-v1.0.0'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$abcCommit = 'ebd5724f5d334b5b6347562b0044f75e16df90b7'
$abcRepo = 'educandu/abcjs-soundfonts'
$lilyCommit = '871c8ce2002e8b3c198f532fdb4fbcce7914f951'
$lilyRepo = 'musescore/MuseScore'
$expectedAbcSampleCount = 89
$expectedAbcSampleBytes = 19606163L
$expectedLilySoundFontBytes = 14563174L
$expectedLilySoundFontBlob = '555bf79687570ad7ea9d4aba6cb5bfbc1724cdb2'
$expectedLilyLicenseBlob = 'c23a3f3f6fe9307338eba8ee096f3823699eedb7'
$abcSamplePrefix = 'FluidR3_Salamander_GM/acoustic_grand_piano-mp3/'
$abcAttributionPaths = @(
    'LICENSE',
    'README.md',
    'SalamanderGrandPianoV3_44.1khz16bit/README'
)

if ($ReleaseTag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw 'ReleaseTag must be a single safe path segment.'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $repoRoot 'artifacts/music-addins'
$catalogPath = Join-Path $repoRoot 'addins/catalog.json'
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workRoot = Join-Path $temporaryRoot ("wasabipad-music-addins-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))

function Assert-UnderTemporaryRoot([string]$PathToCheck) {
    $resolved = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $root = [System.IO.Path]::GetFullPath($temporaryRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use or delete a path outside the dedicated TEMP directory: $resolved"
    }
    return $resolved
}

function Invoke-NpmBuild([string]$ScriptName) {
    Write-Host "Running npm run $ScriptName"
    Push-Location $repoRoot
    try {
        & npm.cmd run $ScriptName
        if ($LASTEXITCODE -ne 0) {
            throw "npm run $ScriptName failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Get-GitBlobSha1([string]$FilePath) {
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    $header = [System.Text.Encoding]::ASCII.GetBytes("blob $($bytes.LongLength)`0")
    $payload = [byte[]]::new($header.Length + $bytes.Length)
    [System.Buffer]::BlockCopy($header, 0, $payload, 0, $header.Length)
    [System.Buffer]::BlockCopy($bytes, 0, $payload, $header.Length, $bytes.Length)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        return ([System.BitConverter]::ToString($sha1.ComputeHash($payload))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha1.Dispose()
    }
}

function Get-Sha256Hex([string]$FilePath) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash([System.IO.File]::ReadAllBytes($FilePath)))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-EncodedRepositoryPath([string]$Path) {
    return (($Path -split '/') | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join '/'
}

function Download-VerifiedGitBlob(
    [string]$Repository,
    [string]$Commit,
    [string]$Path,
    [string]$ExpectedBlob,
    [long]$ExpectedSize,
    [string]$Destination
) {
    $uriPath = Get-EncodedRepositoryPath $Path
    $uri = "https://raw.githubusercontent.com/$Repository/$Commit/$uriPath"
    Invoke-WebRequest -Uri $uri -OutFile $Destination -Headers @{ 'User-Agent' = 'WasabiPad-music-addin-packager' } -TimeoutSec 120
    $actualSize = (Get-Item -LiteralPath $Destination).Length
    if ($actualSize -ne $ExpectedSize) {
        throw "Unexpected size for $Path. Expected $ExpectedSize bytes, received $actualSize."
    }
    $actualBlob = Get-GitBlobSha1 $Destination
    if ($actualBlob -ne $ExpectedBlob) {
        throw "Git blob SHA-1 mismatch for $Path. Expected $ExpectedBlob, received $actualBlob."
    }
}

function Copy-LocalLicense([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required bundled-library license is missing: $Source"
    }
    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Assert-Archive([string]$ArchivePath, [string]$AddonId) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($archive.Entries)
        $names = @($entries | ForEach-Object { $_.FullName })
        foreach ($required in @('addon.json', 'dist/entry.js')) {
            if ($names -notcontains $required) {
                throw "Archive $ArchivePath is missing $required at its root."
            }
        }
        if (-not ($names | Where-Object { $_ -like 'licenses/*' })) {
            throw "Archive $ArchivePath has no license files."
        }
        if (-not ($names | Where-Object { $_ -like 'soundfont/*' })) {
            throw "Archive $ArchivePath has no soundfont assets."
        }
        if ($AddonId -eq 'abc') {
            $samples = @($entries | Where-Object { $_.FullName -like 'soundfont/acoustic_grand_piano-mp3/*.mp3' })
            $sampleBytes = ($samples | Measure-Object -Property Length -Sum).Sum
            if ($samples.Count -ne $expectedAbcSampleCount -or $sampleBytes -ne $expectedAbcSampleBytes) {
                throw "ABC archive sample check failed: $($samples.Count) files, $sampleBytes bytes."
            }
        }
        if ($AddonId -eq 'lilypond') {
            $soundFont = $entries | Where-Object { $_.FullName -eq 'soundfont/FluidR3Mono_GM.sf3' }
            if (-not $soundFont -or $soundFont.Length -ne $expectedLilySoundFontBytes) {
                throw 'LilyPond archive is missing the verified FluidR3Mono_GM.sf3.'
            }
        }
        return $entries
    }
    finally {
        $archive.Dispose()
    }
}

try {
    Invoke-NpmBuild 'build:abc-addon'
    Invoke-NpmBuild 'build:lilypond-addon'

    [void](Assert-UnderTemporaryRoot $workRoot)
    New-Item -ItemType Directory -Path $workRoot | Out-Null

    $abcStage = Join-Path $workRoot 'abc'
    $lilyStage = Join-Path $workRoot 'lilypond'
    New-Item -ItemType Directory -Path $abcStage, $lilyStage | Out-Null

    foreach ($item in @(
        @{ Id = 'abc'; Stage = $abcStage },
        @{ Id = 'lilypond'; Stage = $lilyStage }
    )) {
        $sourceRoot = Join-Path $repoRoot "addins/$($item.Id)"
        foreach ($required in @('addon.json', 'dist/entry.js')) {
            $source = Join-Path $sourceRoot $required
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "Required add-in build output is missing: $source"
            }
        }
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'addon.json') -Destination $item.Stage
        $stageDist = Join-Path $item.Stage 'dist'
        New-Item -ItemType Directory -Path $stageDist | Out-Null
        foreach ($distItem in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'dist') -Force) {
            Copy-Item -LiteralPath $distItem.FullName -Destination $stageDist -Recurse -Force
        }
    }

    $abcMetadata = Get-Content -LiteralPath (Join-Path $abcStage 'addon.json') -Raw | ConvertFrom-Json
    $lilyMetadata = Get-Content -LiteralPath (Join-Path $lilyStage 'addon.json') -Raw | ConvertFrom-Json
    if ($abcMetadata.id -ne 'abc' -or $lilyMetadata.id -ne 'lilypond') {
        throw 'Add-on metadata IDs do not match the official package IDs.'
    }
    foreach ($metadata in @($abcMetadata, $lilyMetadata)) {
        if ($metadata.version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or
            $metadata.minimumAppVersion -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
            throw "Unsafe version in add-on metadata: $($metadata.id)"
        }
    }

    $abcTreeUri = "https://api.github.com/repos/$abcRepo/git/trees/$abcCommit`?recursive=1"
    $abcTree = Invoke-RestMethod -Uri $abcTreeUri -Headers @{ 'User-Agent' = 'WasabiPad-music-addin-packager' } -TimeoutSec 120
    if ($abcTree.truncated) {
        throw 'The fixed ABC soundfont GitHub tree response was truncated.'
    }
    $abcSamples = @($abcTree.tree | Where-Object {
        $_.path.StartsWith($abcSamplePrefix, [System.StringComparison]::Ordinal) -and
        $_.path.EndsWith('.mp3', [System.StringComparison]::OrdinalIgnoreCase) -and
        $_.type -eq 'blob'
    })
    $abcSampleBytes = ($abcSamples | Measure-Object -Property size -Sum).Sum
    if ($abcSamples.Count -ne $expectedAbcSampleCount -or $abcSampleBytes -ne $expectedAbcSampleBytes) {
        throw "Fixed ABC soundfont tree mismatch: $($abcSamples.Count) MP3 files, $abcSampleBytes bytes."
    }

    $abcSoundfontRoot = Join-Path $abcStage 'soundfont/acoustic_grand_piano-mp3'
    New-Item -ItemType Directory -Path $abcSoundfontRoot -Force | Out-Null
    foreach ($sample in $abcSamples) {
        $relativePath = $sample.path.Substring($abcSamplePrefix.Length)
        if ($relativePath.Contains('/') -or $relativePath.Contains('\')) {
            throw "Unexpected nested ABC sample path: $($sample.path)"
        }
        $destination = Join-Path $abcSoundfontRoot $relativePath
        Download-VerifiedGitBlob $abcRepo $abcCommit $sample.path $sample.sha ([long]$sample.size) $destination
    }

    $abcProvenanceRoot = Join-Path $abcStage 'licenses/FluidR3_Salamander_GM'
    foreach ($path in $abcAttributionPaths) {
        $entry = $abcTree.tree | Where-Object { $_.path -eq $path -and $_.type -eq 'blob' } | Select-Object -First 1
        if (-not $entry) {
            throw "Fixed ABC soundfont attribution file is missing: $path"
        }
        $destination = Join-Path $abcProvenanceRoot ($path -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Download-VerifiedGitBlob $abcRepo $abcCommit $path $entry.sha ([long]$entry.size) $destination
    }
    Copy-LocalLicense (Join-Path $repoRoot 'addins/abc/node_modules/abcjs/LICENSE.md') (Join-Path $abcStage 'licenses/javascript/abcjs/LICENSE.md')

    $lilySoundFontPath = 'share/sound/FluidR3Mono_GM.sf3'
    $lilyLicensePath = 'share/sound/FluidR3Mono_License.md'
    $lilySoundFontDestination = Join-Path $lilyStage 'soundfont/FluidR3Mono_GM.sf3'
    $lilyLicenseDestination = Join-Path $lilyStage 'licenses/FluidR3Mono_License.md'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lilySoundFontDestination), (Split-Path -Parent $lilyLicenseDestination) | Out-Null
    Download-VerifiedGitBlob $lilyRepo $lilyCommit $lilySoundFontPath $expectedLilySoundFontBlob $expectedLilySoundFontBytes $lilySoundFontDestination
    $lilyLicenseMetadata = Invoke-RestMethod -Uri "https://api.github.com/repos/$lilyRepo/contents/$lilyLicensePath`?ref=$lilyCommit" -Headers @{ 'User-Agent' = 'WasabiPad-music-addin-packager' } -TimeoutSec 60
    if ($lilyLicenseMetadata.sha -ne $expectedLilyLicenseBlob) {
        throw "Fixed LilyPond soundfont license blob mismatch: $($lilyLicenseMetadata.sha)"
    }
    Download-VerifiedGitBlob $lilyRepo $lilyCommit $lilyLicensePath $expectedLilyLicenseBlob ([long]$lilyLicenseMetadata.size) $lilyLicenseDestination

    Copy-LocalLicense (Join-Path $repoRoot 'addins/lilypond/node_modules/spessasynth_lib/LICENSE') (Join-Path $lilyStage 'licenses/javascript/spessasynth_lib/LICENSE')
    Copy-LocalLicense (Join-Path $repoRoot 'addins/lilypond/node_modules/spessasynth_core/LICENSE') (Join-Path $lilyStage 'licenses/javascript/spessasynth_core/LICENSE')
    Copy-LocalLicense (Join-Path $repoRoot 'addins/lilypond/node_modules/stb-vorbis/LICENSE') (Join-Path $lilyStage 'licenses/javascript/stb-vorbis/LICENSE')

    $packageDefinitions = @(
        @{ Id = 'abc'; Metadata = $abcMetadata; Stage = $abcStage },
        @{ Id = 'lilypond'; Metadata = $lilyMetadata; Stage = $lilyStage }
    )
    $catalogAddons = [System.Collections.Generic.List[object]]::new()
    $outputZips = [System.Collections.Generic.List[object]]::new()
    foreach ($definition in $packageDefinitions) {
        $id = $definition.Id
        $version = [string]$definition.Metadata.version
        $zipName = "wasabipad-$id-$version.zip"
        $temporaryZip = Join-Path $workRoot $zipName
        Compress-Archive -Path (Join-Path $definition.Stage '*') -DestinationPath $temporaryZip -CompressionLevel Optimal -Force
        $entries = Assert-Archive $temporaryZip $id
        $sha256 = Get-Sha256Hex $temporaryZip
        $archiveUrl = "https://github.com/hama55/WasabiPad/releases/download/$ReleaseTag/$zipName"
        $catalogAddons.Add([ordered]@{
            id = $id
            version = $version
            minimumAppVersion = [string]$definition.Metadata.minimumAppVersion
            archiveUrl = $archiveUrl
            sha256 = $sha256
        })
        $outputZips.Add([pscustomobject]@{ Name = $zipName; Path = $temporaryZip; Sha256 = $sha256; Entries = $entries })
    }

    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    foreach ($zip in $outputZips) {
        Copy-Item -LiteralPath $zip.Path -Destination (Join-Path $outputRoot $zip.Name) -Force
        $copiedSha256 = Get-Sha256Hex (Join-Path $outputRoot $zip.Name)
        if ($copiedSha256 -ne $zip.Sha256) {
            throw "Copied package SHA-256 mismatch: $($zip.Name)"
        }
    }

    $catalog = [ordered]@{ schema = 1; addons = @($catalogAddons.ToArray()) }
    $catalogJson = ConvertTo-Json -InputObject $catalog -Depth 8
    [System.IO.File]::WriteAllText($catalogPath, $catalogJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $catalogCheck = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
    if ($catalogCheck.schema -ne 1 -or $catalogCheck.addons.Count -ne 2) {
        throw 'Generated add-in catalog failed its schema/count self-check.'
    }
    foreach ($item in $catalogCheck.addons) {
        $zipPath = Join-Path $outputRoot ("wasabipad-{0}-{1}.zip" -f $item.id, $item.version)
        $actualSha256 = Get-Sha256Hex $zipPath
        if ($actualSha256 -ne $item.sha256 -or $item.archiveUrl -notlike "*/$ReleaseTag/*") {
            throw "Catalog package entry failed its SHA/tag self-check: $($item.id)"
        }
    }

    foreach ($zip in $outputZips) {
        $outputPath = Join-Path $outputRoot $zip.Name
        Write-Host ("{0}: {1:N0} bytes SHA256 {2}" -f $zip.Name, (Get-Item -LiteralPath $outputPath).Length, $zip.Sha256)
    }
    Write-Host "ABC samples: $($abcSamples.Count) MP3 files, $abcSampleBytes bytes; every Git blob SHA-1 verified."
    Write-Host "LilyPond soundfont: $expectedLilySoundFontBytes bytes; Git blob SHA-1 $expectedLilySoundFontBlob verified."
    Write-Host "Catalog: addins/catalog.json (ReleaseTag $ReleaseTag)"
}
finally {
    if (Test-Path -LiteralPath $workRoot) {
        $resolvedWorkRoot = (Resolve-Path -LiteralPath $workRoot).Path
        [void](Assert-UnderTemporaryRoot $resolvedWorkRoot)
        Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force
    }
}
