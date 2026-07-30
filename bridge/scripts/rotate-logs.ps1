# =============================================================================
# Servoteh Bridge - log rotation
# =============================================================================
# Brise log fajlove starije od $RetentionDays dana iz $LogDir.
#
# Upotreba (rucno):
#   .\scripts\rotate-logs.ps1
#   .\scripts\rotate-logs.ps1 -RetentionDays 14 -LogDir "C:\Servoteh\servoteh-bridge\logs"
#
# Setup kao Windows Scheduled Task (jednom, kao Administrator):
#   Register-ScheduledTask `
#     -TaskName "Servoteh Bridge - rotate logs" `
#     -Action (New-ScheduledTaskAction `
#                -Execute "powershell.exe" `
#                -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Servoteh\servoteh-bridge\scripts\rotate-logs.ps1") `
#     -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) `
#     -User "SYSTEM" `
#     -RunLevel Highest
#
# Provera:
#   Get-ScheduledTask "Servoteh Bridge - rotate logs"
#   Start-ScheduledTask "Servoteh Bridge - rotate logs"   # rucno pokrenuti
# =============================================================================

[CmdletBinding()]
param(
  [int]$RetentionDays = 30,
  [string]$LogDir = "",
  [string]$Pattern = "bridge-*.log"
)

$ErrorActionPreference = "Stop"

# Ako -LogDir nije prosledjen, odredi ga relativno na skriptu.
# $PSScriptRoot moze biti prazan kad se skripta pokrene preko `powershell.exe -File`
# (zavisi od verzije), pa koristimo i fallback na $MyInvocation.MyCommand.Path.
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $scriptDir = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    Write-Host "[rotate-logs] Ne mogu da odredim putanju skripte; prosledi -LogDir eksplicitno." -ForegroundColor Red
    exit 1
  }
  $LogDir = Join-Path $scriptDir "..\logs"
}

$resolvedLogDir = Resolve-Path -ErrorAction SilentlyContinue $LogDir
if (-not $resolvedLogDir) {
  Write-Host "[rotate-logs] LogDir does not exist: $LogDir" -ForegroundColor Yellow
  exit 0
}

$cutoff = (Get-Date).AddDays(-$RetentionDays)
Write-Host "[rotate-logs] Brisem fajlove $Pattern starije od $($cutoff.ToString('yyyy-MM-dd')) iz $resolvedLogDir"

$candidates = Get-ChildItem -Path $resolvedLogDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
              Where-Object { $_.LastWriteTime -lt $cutoff }

if (-not $candidates) {
  Write-Host "[rotate-logs] Nista za brisanje (svi fajlovi mladji od $RetentionDays dana)."
  exit 0
}

$totalBytes = ($candidates | Measure-Object -Property Length -Sum).Sum
$totalMb = [math]::Round($totalBytes / 1MB, 2)

foreach ($f in $candidates) {
  Write-Host "[rotate-logs] Brisem: $($f.Name)  ($([math]::Round($f.Length/1MB, 2)) MB, age $((Get-Date) - $f.LastWriteTime | Select-Object -ExpandProperty Days)d)"
  Remove-Item -Path $f.FullName -Force
}

Write-Host "[rotate-logs] Obrisano $($candidates.Count) fajl(a), oslobodjeno $totalMb MB."
