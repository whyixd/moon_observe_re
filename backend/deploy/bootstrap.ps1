<#
.SYNOPSIS
  Windows entry point: install the pinned uv, then fetch install-release.ps1 of the same tag and run it.

.DESCRIPTION
  Run from an elevated Windows PowerShell 5.1. The repository is public, so no GitHub token is needed;
  -PromptToken stores one (Contents: Read) in <DataRoot>\github-token in case it becomes private.
  With -ArtifactPath/-SumsPath the release zip is used from disk: its checksum is verified here and the
  installer is taken from inside it. uv still downloads Python and the Python packages on first install.

  This file must stay ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Version v0.2.0

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Version v0.2.0 `
    -ArtifactPath .\moon-observe-v0.2.0-windows.zip -SumsPath .\SHA256SUMS
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ArtifactPath = '',
    [string]$SumsPath = '',
    [string]$Repository = 'whyixd/moon_observe_re',
    [string]$InstallRoot = 'C:\MoonObserve',
    [string]$DataRoot = 'C:\ProgramData\MoonObserve',
    [switch]$PromptToken
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep identical to VERSION_PATTERN in build_release.py and install-release.ps1.
$VersionPattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$'
# Pinned uv for Windows x64; the digest is the one published next to the release asset.
$UvVersion = '0.12.23'
$UvSha256 = '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90'
$UvUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"

function Fail([string]$Message) { throw "bootstrap: $Message" }
function Log([string]$Message) { Write-Host "==> $Message" }

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail 'run from an elevated PowerShell (Run as administrator)'
    }
    if ($Version -cnotmatch $VersionPattern) { Fail "invalid version: $Version (expected v1.2.3 or v1.2.3-rc.1)" }
    if ($ArtifactPath -and -not $SumsPath) { Fail '-ArtifactPath needs -SumsPath (the SHA256SUMS of the same release)' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $bin = Join-Path $InstallRoot 'bin'
    $uv = Join-Path $bin 'uv.exe'
    $workDir = Join-Path ([IO.Path]::GetTempPath()) ("moon-observe-bootstrap-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir | Out-Null
    try {
        foreach ($dir in @($InstallRoot, $bin)) {
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        }

        $installed = ''
        if (Test-Path -LiteralPath $uv) { $installed = (& $uv --version) -join ' ' }
        if ($installed -notlike "uv $UvVersion*") {
            Log "Installing uv $UvVersion to $bin"
            $uvZip = Join-Path $workDir 'uv.zip'
            Invoke-WebRequest -UseBasicParsing -Uri $UvUrl -OutFile $uvZip
            $actual = (Get-FileHash -LiteralPath $uvZip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -cne $UvSha256) { Fail "SHA-256 mismatch for uv $UvVersion" }
            $uvDir = Join-Path $workDir 'uv'
            [IO.Compression.ZipFile]::ExtractToDirectory($uvZip, $uvDir)
            Get-ChildItem -LiteralPath $uvDir -Recurse -Filter '*.exe' | Copy-Item -Destination $bin -Force
            if (-not (Test-Path -LiteralPath $uv)) { Fail "uv.exe missing after unpacking $UvUrl" }
        }

        $tokenFile = Join-Path $DataRoot 'github-token'
        if ($PromptToken) {
            if (-not (Test-Path -LiteralPath $DataRoot)) { New-Item -ItemType Directory -Path $DataRoot | Out-Null }
            $secure = Read-Host -AsSecureString "GitHub fine-grained token (Contents: Read on $Repository)"
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
            if (-not $plain) { Fail 'empty token' }
            [IO.File]::WriteAllText($tokenFile, $plain.Trim(), (New-Object Text.UTF8Encoding($false)))
            $plain = $null
            Log "Stored the token in $tokenFile (install-release.ps1 restricts it to administrators)"
        }

        $installer = Join-Path $workDir 'install-release.ps1'
        if ($ArtifactPath) {
            $zipName = "moon-observe-$Version-windows.zip"
            $zip = (Resolve-Path -LiteralPath $ArtifactPath).Path
            if ([IO.Path]::GetFileName($zip) -cne $zipName) { Fail "-ArtifactPath must be named $zipName" }
            $expected = @()
            foreach ($line in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $SumsPath).Path)) {
                $fields = $line.Trim() -split '\s+'
                if ($fields.Count -eq 2 -and ($fields[1] -ceq $zipName -or $fields[1] -ceq "*$zipName")) { $expected += $fields[0] }
            }
            if ($expected.Count -ne 1) { Fail "SHA256SUMS must list $zipName exactly once" }
            if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[0]) {
                Fail "SHA-256 mismatch for $zipName"
            }
            $archive = [IO.Compression.ZipFile]::OpenRead($zip)
            try {
                $entry = $archive.GetEntry("moon-observe-$Version/deploy/install-release.ps1")
                if ($null -eq $entry) { Fail "$zipName has no deploy/install-release.ps1" }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $installer)
            } finally {
                $archive.Dispose()
            }
            Log "Using install-release.ps1 from $zipName"
        } else {
            $headers = @{}
            $token = ''
            if ($env:GITHUB_TOKEN) { $token = $env:GITHUB_TOKEN.Trim() }
            elseif (Test-Path -LiteralPath $tokenFile) { $token = ([IO.File]::ReadAllText($tokenFile)).Trim() }
            if ($token) {
                $headers['Authorization'] = "Bearer $token"
                $headers['Accept'] = 'application/vnd.github.raw+json'
                $headers['X-GitHub-Api-Version'] = '2022-11-28'
                $url = "https://api.github.com/repos/$Repository/contents/backend/deploy/install-release.ps1?ref=$Version"
            } else {
                $url = "https://raw.githubusercontent.com/$Repository/$Version/backend/deploy/install-release.ps1"
            }
            Log "Fetching install-release.ps1 at $Version"
            Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $url -OutFile $installer
        }

        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Version', $Version,
            '-Repository', $Repository, '-InstallRoot', $InstallRoot, '-DataRoot', $DataRoot)
        if ($ArtifactPath) {
            $arguments += @('-ArtifactPath', (Resolve-Path -LiteralPath $ArtifactPath).Path,
                '-SumsPath', (Resolve-Path -LiteralPath $SumsPath).Path)
        }
        & powershell.exe @arguments
        $code = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit $code
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
