<#
.SYNOPSIS
  Stop and remove the Moon Observe service, its firewall rule and <InstallRoot>.

.DESCRIPTION
  Stopping the service first sends the all-zero frame (LEDs off, motors stop). The data folder
  (config.toml, preset\, logs\) is kept unless -RemoveData is given.

  This file must stay ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\MoonObserve\current\deploy\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\MoonObserve',
    [string]$DataRoot = 'C:\ProgramData\MoonObserve',
    [switch]$RemoveData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ServiceName = 'MoonObserve'
$FirewallRule = 'MoonObserve-TCP-8765'

function Log([string]$Message) { Write-Host "==> $Message" }

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'uninstall: run from an elevated PowerShell (Run as administrator)'
    }
    # The script may live inside InstallRoot (current\deploy); run it from elsewhere.
    Set-Location -LiteralPath ([IO.Path]::GetTempPath())

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $service) {
        if ($service.Status -ne 'Stopped') {
            Log "Stopping $ServiceName (LEDs off, motors stop)"
            Stop-Service -Name $ServiceName -Force
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
        Log "Removing service $ServiceName"
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & sc.exe delete $ServiceName | Out-Host
        $ErrorActionPreference = $saved
        if ($LASTEXITCODE -ne 0) { throw "uninstall: sc.exe delete failed (exit code $LASTEXITCODE)" }
    }

    if ($null -ne (Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue)) {
        Remove-NetFirewallRule -Name $FirewallRule
        Log "Removed firewall rule $FirewallRule"
    }

    $current = Join-Path $InstallRoot 'current'
    if (Test-Path -LiteralPath $current) {
        # Remove the junction itself first, so the recursive delete below never follows it.
        [IO.Directory]::Delete($current)
    }
    if (Test-Path -LiteralPath $InstallRoot) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        Log "Removed $InstallRoot"
    }
    if ($RemoveData) {
        if (Test-Path -LiteralPath $DataRoot) {
            Remove-Item -LiteralPath $DataRoot -Recurse -Force
            Log "Removed $DataRoot"
        }
    } else {
        Log "Kept $DataRoot (config.toml, preset, logs); pass -RemoveData to delete it"
    }
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
