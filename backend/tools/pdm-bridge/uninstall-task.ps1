<#
.SYNOPSIS
  Disables or removes the "ServoSync PDM Bridge" Task Scheduler task (rollback).

.DESCRIPTION
  -DisableOnly  = pause: the task stays registered (settings, account, trigger preserved),
                  re-enable with:  Enable-ScheduledTask -TaskName "ServoSync PDM Bridge"
  (default)     = full removal (Unregister-ScheduledTask).

  Rollback is production-safe: in PASSIVE mode the bridge never moved or deleted anything
  on the shares, so the legacy 10-min pipeline continues untouched. The local state file
  (pdm-bridge.state.json) is intentionally kept - re-enabling continues without re-sending.
  Idempotent: a missing task is reported as such and exits 0.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-task.ps1 -DisableOnly
#>
[CmdletBinding()]
param(
  [string]$TaskName = "ServoSync PDM Bridge",
  [switch]$DisableOnly
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "[GRESKA] Pokreni iz PowerShell-a podignutog kao administrator." -ForegroundColor Red
  exit 1
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "[INFO] Task '$TaskName' ne postoji - nema sta da se radi."
  exit 0
}

if ($DisableOnly) {
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Write-Host "[OK] Task '$TaskName' PAUZIRAN (ostaje registrovan)." -ForegroundColor Green
  Write-Host "     Ponovno ukljucivanje:  Enable-ScheduledTask -TaskName `"$TaskName`""
} else {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[OK] Task '$TaskName' UKLONJEN." -ForegroundColor Green
  Write-Host "     Ponovna instalacija:  install-task.ps1 -RunAsUser DOMEN\nalog"
}
Write-Host "     State fajl (pdm-bridge.state.json) je namerno ostavljen - nastavak ne salje ponovo vec poslato."
exit 0
