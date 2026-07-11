<#
.SYNOPSIS
  Disables or removes the "ServoSync BigBit Bridge" Task Scheduler task (rollback).

.DESCRIPTION
  -DisableOnly  = pause: the task stays registered (settings, account, trigger preserved),
                  re-enable with:  Enable-ScheduledTask -TaskName "ServoSync BigBit Bridge"
  (default)     = full removal (Unregister-ScheduledTask).

  Rollback is production-safe on BOTH sides:
    - BigBit side: the bridge only ever COPIED the .mdb/.MDW - the originals were
      never opened, moved or modified;
    - PG side: item_groups / item_subgroups / item_origins are filled ONLY by this
      bridge (they were empty before it), so if the data itself must go too:
        DELETE FROM item_origins; DELETE FROM item_subgroups; DELETE FROM item_groups;
      (see README "Rollback" - safe, nothing else writes these tables).
  Idempotent: a missing task is reported as such and exits 0.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-task.ps1 -DisableOnly
#>
[CmdletBinding()]
param(
  [string]$TaskName = "ServoSync BigBit Bridge",
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
Write-Host "     PG podaci (item_groups/item_subgroups/item_origins) NISU dirani - po potrebi DELETE po README-u."
exit 0
