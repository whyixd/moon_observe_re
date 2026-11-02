<#
.SYNOPSIS
  Install, verify and activate one Moon Observe release on Windows 10/11 (Windows PowerShell 5.1).

.DESCRIPTION
  Normally started by bootstrap.ps1. Steps: get the release zip (GitHub Release or -ArtifactPath),
  verify SHA-256, unpack to <InstallRoot>\releases\<Version>, create the Python environment with
  uv sync --frozen, validate the existing config with the new release, stop the service, switch the
  <InstallRoot>\current junction, start the service and run the health check. When the health check
  fails, the previous release is reactivated. Re-running with an installed version reactivates it
  without downloading (this is also the rollback command).

  This file must stay ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-release.ps1 -Version v0.2.0

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-release.ps1 -Version v0.2.0 `
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
    [int]$KeepReleases = 3,
    [int]$HealthTimeout = 30,
    [int]$Port = 8765
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Keep identical to VERSION_PATTERN in build_release.py and bootstrap.ps1.
$VersionPattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z][0-9A-Za-z.]*)?$'
$App = 'moon-observe'
$ServiceName = 'MoonObserve'
$FirewallRule = 'MoonObserve-TCP-8765'
$CompleteMarker = '.install-complete'
# Well-known SIDs, so the ACLs work on every Windows display language.
$SidSystem = '*S-1-5-18'
$SidAdministrators = '*S-1-5-32-544'
$SidLocalService = '*S-1-5-19'
$SidUsers = '*S-1-5-32-545'

function Fail([string]$Message) { throw "install-release: $Message" }
function Log([string]$Message) { Write-Host "==> $Message" }

# Native commands may write progress to stderr; with ErrorActionPreference=Stop Windows PowerShell 5.1
# would turn that into a terminating error, so run them with Continue and check the exit code.
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

function Assert-Native([string]$FilePath, [string[]]$Arguments, [string]$What) {
    $code = Invoke-Native $FilePath $Arguments
    if ($code -ne 0) { Fail "$What failed (exit code $code)" }
}

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-SamePath([string]$Left, [string]$Right) {
    if (-not $Left -or -not $Right) { return $false }
    return [string]::Equals((Get-FullPath $Left), (Get-FullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Read-Utf8([string]$Path) {
    return [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false)))
}

function Write-Utf8([string]$Path, [string]$Text) {
    # No BOM: tomllib rejects one.
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------------------------
# Arguments and environment

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'run from an elevated PowerShell (Run as administrator)'
}
if ($Version -cnotmatch $VersionPattern) { Fail "invalid version: $Version (expected v1.2.3 or v1.2.3-rc.1)" }
foreach ($root in @($InstallRoot, $DataRoot)) {
    if (-not [IO.Path]::IsPathRooted($root) -or $root -match '["<>&|%]') {
        Fail "install and data roots must be absolute paths without quotes or <>&|%: $root"
    }
}
if ($KeepReleases -lt 1) { Fail '-KeepReleases must be at least 1' }
if ($HealthTimeout -lt 5) { Fail '-HealthTimeout must be at least 5 seconds' }
if ($ArtifactPath -and -not $SumsPath) { Fail '-ArtifactPath needs -SumsPath (the SHA256SUMS of the same release)' }
$InstallRoot = Get-FullPath $InstallRoot
$DataRoot = Get-FullPath $DataRoot

$Top = "$App-$Version"
$ZipName = "$Top-windows.zip"
$Releases = Join-Path $InstallRoot 'releases'
$ReleaseDir = Join-Path $Releases $Version
$Current = Join-Path $InstallRoot 'current'
$ServiceDir = Join-Path $InstallRoot 'service'
$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"
$Uv = Join-Path $InstallRoot 'bin\uv.exe'
$Config = Join-Path $DataRoot 'config.toml'
$PresetDir = Join-Path $DataRoot 'preset'
$LogDir = Join-Path $DataRoot 'logs'
$TokenFile = Join-Path $DataRoot 'github-token'
$HealthUrl = "http://127.0.0.1:$Port/api/state"
$PageUrl = "http://127.0.0.1:$Port/"

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------------------------------------------------------------------------------------
# Folders and permissions

function Set-Folder([string]$Path, [string[]]$Grants) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
    $arguments = @($Path, '/inheritance:r', '/grant:r') + $Grants + @('/Q')
    Assert-Native 'icacls.exe' $arguments "setting permissions on $Path"
}

function Initialize-Folders {
    # Code: only administrators write; the service and users read.
    Set-Folder $InstallRoot @("${SidSystem}:(OI)(CI)F", "${SidAdministrators}:(OI)(CI)F",
        "${SidLocalService}:(OI)(CI)RX", "${SidUsers}:(OI)(CI)RX")
    foreach ($dir in @($Releases, (Join-Path $InstallRoot 'bin'), $ServiceDir,
            (Join-Path $InstallRoot '.uv-cache'), (Join-Path $InstallRoot '.uv-python'))) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    }
    # Data: the service reads config.toml and may only write preset\ and logs\.
    Set-Folder $DataRoot @("${SidSystem}:(OI)(CI)F", "${SidAdministrators}:(OI)(CI)F",
        "${SidLocalService}:(OI)(CI)RX", "${SidUsers}:(OI)(CI)RX")
    foreach ($dir in @($PresetDir, $LogDir)) {
        Set-Folder $dir @("${SidSystem}:(OI)(CI)F", "${SidAdministrators}:(OI)(CI)F",
            "${SidLocalService}:(OI)(CI)M", "${SidUsers}:(OI)(CI)RX")
    }
}

# ---------------------------------------------------------------------------------------------
# Download and verification

function Get-Token {
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN.Trim() }
    if (Test-Path -LiteralPath $TokenFile) { return (Read-Utf8 $TokenFile).Trim() }
    return ''
}

function Save-ReleaseAssets([string]$WorkDir) {
    $token = Get-Token
    $zip = Join-Path $WorkDir $ZipName
    $sums = Join-Path $WorkDir 'SHA256SUMS'
    if (-not $token) {
        # Public repository: plain release download URLs, no token.
        $base = "https://github.com/$Repository/releases/download/$Version"
        Log "Downloading $ZipName from $Repository"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$ZipName" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    } else {
        # Private repository: release assets through the API with the token.
        $headers = @{ 'Authorization' = "Bearer $token"; 'X-GitHub-Api-Version' = '2022-11-28' }
        Log "Looking up release $Version in $Repository (with token)"
        $release = Invoke-RestMethod -UseBasicParsing -Headers ($headers + @{ 'Accept' = 'application/vnd.github+json' }) `
            -Uri "https://api.github.com/repos/$Repository/releases/tags/$Version"
        foreach ($name in @($ZipName, 'SHA256SUMS')) {
            $asset = @($release.assets | Where-Object { $_.name -ceq $name })
            if ($asset.Count -ne 1) { Fail "release $Version has no asset $name" }
            Log "Downloading $name"
            Invoke-WebRequest -UseBasicParsing -Headers ($headers + @{ 'Accept' = 'application/octet-stream' }) `
                -Uri "https://api.github.com/repos/$Repository/releases/assets/$($asset[0].id)" `
                -OutFile (Join-Path $WorkDir $name)
        }
    }
    return @($zip, $sums)
}

function Assert-Checksum([string]$Zip, [string]$Sums) {
    $expected = @()
    foreach ($line in (Read-Utf8 $Sums) -split "`n") {
        $fields = $line.Trim() -split '\s+'
        if ($fields.Count -eq 2 -and ($fields[1] -ceq $ZipName -or $fields[1] -ceq "*$ZipName")) { $expected += $fields[0] }
    }
    if ($expected.Count -ne 1) { Fail "SHA256SUMS must list $ZipName exactly once" }
    if ($expected[0] -cnotmatch '^[0-9a-f]{64}$') { Fail "malformed checksum for $ZipName" }
    $actual = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $expected[0]) { Fail "SHA-256 mismatch for $ZipName" }
    Log 'SHA-256 verified'
}

function Assert-ZipLayout([string]$Zip) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith("$Top/", [StringComparison]::Ordinal) -or $name -match '(^|/)\.\.(/|$)' -or $name.Contains(':')) {
                Fail "archive has an entry outside $Top/: $($entry.FullName)"
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Install-Release([string]$WorkDir) {
    if (-not (Test-Path -LiteralPath $Uv)) { Fail "uv not found at $Uv; run bootstrap.ps1 first" }
    if ($ArtifactPath) {
        $zip = (Resolve-Path -LiteralPath $ArtifactPath).Path
        $sums = (Resolve-Path -LiteralPath $SumsPath).Path
        if ([IO.Path]::GetFileName($zip) -cne $ZipName) { Fail "-ArtifactPath must be named $ZipName" }
        Log "Using local $zip"
    } else {
        $paths = Save-ReleaseAssets $WorkDir
        $zip = $paths[0]
        $sums = $paths[1]
    }
    Assert-Checksum $zip $sums
    Assert-ZipLayout $zip

    $staging = Join-Path $Releases ".staging-$Version"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    $script:IncompleteRelease = $ReleaseDir
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    Move-Item -LiteralPath (Join-Path $staging $Top) -Destination $ReleaseDir
    Remove-Item -LiteralPath $staging -Recurse -Force
    if ((Read-Utf8 (Join-Path $ReleaseDir 'VERSION')).Trim() -cne $Version) { Fail "VERSION file does not match $Version" }
    if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir 'frontend\index.html'))) { Fail "$ZipName has no built frontend" }

    Log 'Creating Python environment (uv sync --frozen)'
    $env:UV_CACHE_DIR = Join-Path $InstallRoot '.uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $InstallRoot '.uv-python'
    $env:UV_NO_CONFIG = '1'
    Assert-Native $Uv @('sync', '--managed-python', '--frozen', '--no-dev', '--compile-bytecode', '--project', $ReleaseDir) 'uv sync'
    New-Item -ItemType File -Path (Join-Path $ReleaseDir $CompleteMarker) -Force | Out-Null
    $script:IncompleteRelease = ''
}

# ---------------------------------------------------------------------------------------------
# Persistent data (only seeded when missing; upgrades never overwrite it)

function Initialize-Data([string]$Release) {
    $seeded = $false
    if (-not (Test-Path -LiteralPath $Config)) {
        # The service can only write preset\, so every file the control page saves lives there.
        $text = Read-Utf8 (Join-Path $Release 'config.example.toml')
        $options = [Text.RegularExpressions.RegexOptions]::Multiline
        $text = [regex]::Replace($text, '^preset = .*$', 'preset = "preset/preset.json"', $options)
        $text = [regex]::Replace($text, '^sequence = .*$', 'sequence = "preset/sequence.json"', $options)
        $text = [regex]::Replace($text, '^# palette = "palette.json"', '# palette = "preset/palette.json"', $options)
        foreach ($line in @('preset = "preset/preset.json"', 'sequence = "preset/sequence.json"')) {
            if (-not $text.Contains($line)) { Fail "could not set '$line' in the seeded config" }
        }
        Write-Utf8 $Config $text
        $seeded = $true
        Log "Seeded $Config from config.example.toml"
    }
    $preset = Join-Path $PresetDir 'preset.json'
    if (-not (Test-Path -LiteralPath $preset)) {
        Copy-Item -LiteralPath (Join-Path $Release 'preset.example.json') -Destination $preset
        Log "Seeded $preset from preset.example.json"
    }
    if (Test-Path -LiteralPath $TokenFile) {
        Assert-Native 'icacls.exe' @($TokenFile, '/inheritance:r', '/grant:r', "${SidSystem}:F", "${SidAdministrators}:F", '/Q') 'protecting the token file'
    }
    return $seeded
}

function Test-ConfigWith([string]$Release) {
    $python = Join-Path $Release '.venv\Scripts\python.exe'
    $code = Invoke-Native $python @('-B', (Join-Path $Release 'run.py'), '--check', '--config', $Config)
    return ($code -eq 0)
}

# ---------------------------------------------------------------------------------------------
# Service, junction and health

function Get-MoonService { return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }

function Stop-MoonService {
    $service = Get-MoonService
    if ($null -ne $service -and $service.Status -ne 'Stopped') {
        Log "Stopping $ServiceName (LEDs off, motors stop)"
        Stop-Service -Name $ServiceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}

# GetAttributes does not follow the junction, so a junction whose release was deleted is still found
# (Test-Path follows it and would report nothing there).
function Test-CurrentLink {
    try {
        $attributes = [IO.File]::GetAttributes($Current)
    } catch {
        return $false
    }
    if (-not ($attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "$Current exists but is not a junction" }
    return $true
}

function Get-CurrentTarget {
    if (-not (Test-CurrentLink)) { return '' }
    try {
        $target = @((Get-Item -LiteralPath $Current -Force).Target)[0]
    } catch {
        return ''
    }
    if (-not $target -or -not (Test-Path -LiteralPath $target)) { return '' }
    return [string]$target
}

function Set-ServiceFiles([string]$Release) {
    Copy-Item -LiteralPath (Join-Path $Release 'deploy\winsw\WinSW.exe') -Destination $ServiceExe -Force
    $xml = (Read-Utf8 (Join-Path $Release 'deploy\moon-observe.xml')).Replace('@INSTALL_ROOT@', $InstallRoot).Replace(
        '@DATA_ROOT@', $DataRoot).Replace('@PORT@', [string]$Port)
    if ($xml.Contains('@')) { Fail 'service template has an unreplaced placeholder' }
    Write-Utf8 (Join-Path $ServiceDir "$ServiceName.xml") $xml
    if ($null -eq (Get-MoonService)) {
        Log "Registering service $ServiceName"
        Assert-Native $ServiceExe @('install') 'WinSW install'
    }
    # LocalService: no password, no interactive logon, network access as the computer account.
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
    $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
        StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
    if ($result.ReturnValue -ne 0) { Fail "setting the service account failed (Win32_Service.Change returned $($result.ReturnValue))" }
    Assert-Native 'sc.exe' @('config', $ServiceName, 'start=', 'delayed-auto') 'setting delayed automatic start'
}

function Set-Active([string]$Release) {
    Stop-MoonService
    if (Test-CurrentLink) {
        # Directory.Delete without recursion removes the junction itself, never the release behind it.
        [IO.Directory]::Delete($Current)
    }
    New-Item -ItemType Junction -Path $Current -Value $Release | Out-Null
    Set-ServiceFiles $Release
    (Get-Item -LiteralPath (Join-Path $Release $CompleteMarker)).LastWriteTime = Get-Date
    Log "Active release: $(Split-Path -Leaf $Release)"
}

function Get-ServiceProcessId {
    return (Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'").ProcessId
}

function Test-Responding {
    $service = Get-MoonService
    if ($null -eq $service -or $service.Status -ne 'Running') { return $false }
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $HealthUrl | Out-Null
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $PageUrl | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Healthy = service running, API and page answering, and no automatic restart for 3 more seconds.
function Test-Healthy {
    $deadline = (Get-Date).AddSeconds($HealthTimeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-Responding) {
            $processId = Get-ServiceProcessId
            Start-Sleep -Seconds 3
            if ((Test-Responding) -and (Get-ServiceProcessId) -eq $processId) { return $true }
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Start-AndCheck([string]$Release) {
    Log "Starting $ServiceName"
    Start-Service -Name $ServiceName
    return (Test-Healthy)
}

function Remove-OldReleases([string]$Previous) {
    $markers = @(Get-ChildItem -LiteralPath $Releases -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName $CompleteMarker) } |
        Sort-Object { (Get-Item -LiteralPath (Join-Path $_.FullName $CompleteMarker)).LastWriteTime } -Descending)
    $count = 0
    foreach ($dir in $markers) {
        $count += 1
        if ($count -le $KeepReleases -or (Test-SamePath $dir.FullName $ReleaseDir) -or (Test-SamePath $dir.FullName $Previous)) { continue }
        Log "Removing old release $($dir.Name)"
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force
    }
}

function Add-FirewallRule {
    if ($null -eq (Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue)) {
        # Private profile only: the gateway-less Art-Net Ethernet is Public, the venue Wi-Fi is Private.
        New-NetFirewallRule -Name $FirewallRule -DisplayName "Moon Observe control page (TCP $Port)" `
            -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow | Out-Null
        Log "Firewall: TCP $Port allowed on the Private profile"
    }
}

# ---------------------------------------------------------------------------------------------
# Main (every helper above writes to the host only, so Invoke-Main returns just the exit code)

function Invoke-Main([string]$WorkDir) {
    Initialize-Folders
    $previous = Get-CurrentTarget
    if (Test-SamePath $previous $ReleaseDir) {
        Log "$Version is already active; restart it with: Restart-Service $ServiceName"
        return 0
    }

    if (Test-Path -LiteralPath (Join-Path $ReleaseDir $CompleteMarker)) {
        Log "$Version is already installed; reactivating without download"
    } else {
        if (Test-Path -LiteralPath $ReleaseDir) {
            Log "Removing incomplete earlier attempt at $ReleaseDir"
            Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
        }
        Install-Release $WorkDir
    }

    $newConfig = Initialize-Data $ReleaseDir
    if (-not $newConfig) {
        Log "Validating $Config with $Version"
        if (-not (Test-ConfigWith $ReleaseDir)) { Fail "$Version rejects the current config; active release unchanged" }
    }
    Add-FirewallRule
    Set-Active $ReleaseDir

    if ($newConfig) {
        Write-Host ''
        Write-Host 'First install: the service is registered but NOT started. Check the Art-Net settings first:'
        Write-Host "  notepad $Config"
        Write-Host "  Start-Service $ServiceName"
        Write-Host "  Get-Content $LogDir\$ServiceName.out.log -Wait"
        return 0
    }

    if (Start-AndCheck $ReleaseDir) {
        Log "$ServiceName is healthy on $Version"
        Remove-OldReleases $previous
        return 0
    }

    Write-Warning "install-release: health check failed for $Version; see $LogDir"
    if ($previous -and (Test-Path -LiteralPath (Join-Path $previous $CompleteMarker))) {
        Log "Rolling back to $(Split-Path -Leaf $previous)"
        Set-Active $previous
        if (Start-AndCheck $previous) {
            Log "Rollback to $(Split-Path -Leaf $previous) is healthy"
        } else {
            Write-Warning "install-release: the rollback release is unhealthy too; see $LogDir"
        }
    }
    return 1
}

$script:IncompleteRelease = ''
$workDir = Join-Path ([IO.Path]::GetTempPath()) ("moon-observe-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
$exitCode = 1
try {
    $exitCode = [int](Invoke-Main $workDir)
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $exitCode = 1
} finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($script:IncompleteRelease) {
        Write-Warning "install-release: removing incomplete $script:IncompleteRelease"
        Remove-Item -LiteralPath $script:IncompleteRelease -Recurse -Force -ErrorAction SilentlyContinue
    }
}
exit $exitCode
