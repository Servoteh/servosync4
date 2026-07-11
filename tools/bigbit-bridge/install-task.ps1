<#
.SYNOPSIS
  Registers (or re-registers) the "ServoSync BigBit Bridge" Windows Task Scheduler
  task: daily run of bigbit-bridge.ps1 at 05:30.

.DESCRIPTION
  Automates the whole Task Scheduler setup via Register-ScheduledTask - including
  the WorkingDirectory ("Start in") that plain schtasks cannot set (the known
  pdm-bridge trap: without Start in the working folder is System32 and the config
  file next to the script is never found).
    - action   = powershell.exe -NoProfile -ExecutionPolicy Bypass -NonInteractive
                 -File <abs path>\bigbit-bridge.ps1, WorkingDirectory = script folder
                 (absolute -File path, so the task works even if Start in is lost);
    - trigger  = DAILY at -At (default 05:30 - nightly slot: BigBit idle, snapshot
                 copy risk minimal, see README);
    - settings = "Do not start a new instance", stop after 2 hours,
                 StartWhenAvailable (missed 05:30 run fires when the machine wakes);
    - principal: -RunAsUser with LogonType=Password ("Run whether user is logged
                 on or not") - Password logon is REQUIRED because the task reads
                 UNC shares (S4U/ServiceAccount tokens have no network credentials).

  The scheduled task itself runs fully non-interactively (-NonInteractive; the
  bridge script never prompts). This INSTALLER is the only interactive moment:
  the account password is typed by a human (or passed via -Password SecureString
  for scripted installs) and is never written to any file.

  Idempotent: re-running overwrites the existing task (-Force re-register).
  NOTE: provisions NOTHING remotely - run it ON Srv-all, from an elevated
  (admin) PowerShell. PowerShell 5.1 compatible.

.PARAMETER RunAsUser
  Windows account that runs the task (DOMAIN\name or MACHINE\name). Must have
  READ on the BigBit UNC share and the "Log on as a batch job" right.

.PARAMETER At
  Daily start time, HH:mm (default "05:30").

.PARAMETER ScriptDir
  Folder with bigbit-bridge.ps1 and bigbit-bridge.env. Default: this script's folder.

.PARAMETER TaskName
  Scheduled task name. Default "ServoSync BigBit Bridge".

.PARAMETER Password
  Password of RunAsUser as SecureString. Omit it - the script prompts interactively.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1 -RunAsUser SERVOTEH\bbsync
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RunAsUser,

  [ValidatePattern('^\d{2}:\d{2}$')]
  [string]$At = "05:30",

  [string]$ScriptDir = $PSScriptRoot,

  [string]$TaskName = "ServoSync BigBit Bridge",

  [System.Security.SecureString]$Password
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
  Write-Host "[GRESKA] $msg" -ForegroundColor Red
  exit 1
}

# --- Elevation: registering a Password-logon task for another account needs admin. ---
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "Pokreni iz PowerShell-a podignutog kao administrator (Run as administrator)."
}

# --- Resolve and validate the script folder (bigbit-bridge.ps1 + config must exist). ---
if (-not $ScriptDir) { Fail "ScriptDir nije poznat - prosledi -ScriptDir <folder sa bigbit-bridge.ps1>." }
$ScriptDir = (Resolve-Path -LiteralPath $ScriptDir).Path
$bridgePs1 = Join-Path $ScriptDir "bigbit-bridge.ps1"
$cfgFile = Join-Path $ScriptDir "bigbit-bridge.env"
if (-not (Test-Path -LiteralPath $bridgePs1)) { Fail "Nema bigbit-bridge.ps1 u $ScriptDir." }
if (-not (Test-Path -LiteralPath $cfgFile)) {
  # Hard requirement: the bridge reads bigbit-bridge.env next to itself.
  Fail "Nema bigbit-bridge.env u $ScriptDir - prvo: copy bigbit-bridge.env.example bigbit-bridge.env pa popuni (vidi README)."
}

# --- Parse the daily time. ---
try {
  $atTime = [datetime]::ParseExact($At, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
  Fail "-At '$At' nije validno vreme (ocekivano HH:mm, npr. 05:30)."
}

# --- Password: typed by a HUMAN at install time; converted only transiently, never persisted. ---
if (-not $Password) {
  Write-Host "[COVEK] Unesi lozinku Windows naloga '$RunAsUser'" -ForegroundColor Yellow
  Write-Host "        (koristi se samo za registraciju taska, ne cuva se ni u jednom fajlu):" -ForegroundColor Yellow
  $Password = Read-Host -AsSecureString
}
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $plainPassword) { Fail "Prazna lozinka - prekid." }

# --- Build the task definition. ---
$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction `
  -Execute $psExe `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + $bridgePs1 + '"') `
  -WorkingDirectory $ScriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At $atTime

# IgnoreNew = GUI "Do not start a new instance"; 2h limit = hung-run guard
# (a full .mdb copy over LAN + upsert normally finishes in minutes).
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[INFO] Task '$TaskName' vec postoji - bice pregazen (idempotentan re-register)."
}

try {
  # -User + -Password => LogonType Password = "Run whether user is logged on or not"
  # (mandatory here: UNC read needs real network credentials).
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -User $RunAsUser `
    -Password $plainPassword `
    -RunLevel Limited `
    -Force | Out-Null
} catch {
  $msg = $_.Exception.Message
  if ($msg -match "0x80070569" -or $msg -match "batch") {
    Fail ("Registracija odbijena ($msg). Nalogu '$RunAsUser' najverovatnije fali pravo " +
      "'Log on as a batch job': secpol.msc -> Local Policies -> User Rights Assignment.")
  }
  Fail "Registracija taska nije uspela: $msg"
} finally {
  # Do not keep the plaintext password in session memory longer than needed.
  $plainPassword = $null
  Remove-Variable plainPassword -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[OK] Task '$TaskName' registrovan." -ForegroundColor Green
Write-Host "     Nalog:       $RunAsUser (run whether user is logged on or not)"
Write-Host "     Akcija:      powershell -NonInteractive -File $bridgePs1"
Write-Host "     Start in:    $ScriptDir"
Write-Host "     Raspored:    svaki dan u $At (Do not start a new instance; stop posle 2h)"
Write-Host ""
Write-Host "Sledeci koraci:"
Write-Host "  1. Odmah probaj:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "  2. Rezultat:      Get-ScheduledTaskInfo -TaskName `"$TaskName`"  (LastTaskResult: 0=OK,"
Write-Host "                    1=tabela pala, 2=BigBit/ULS read, 3=konfiguracija, 4=UNC kopija,"
Write-Host "                    5=PG nedostupan - vidi README)"
Write-Host "  3. Log:           $ScriptDir\bigbit-bridge.log"
Write-Host "  4. Pauza/uklanjanje: uninstall-task.ps1 [-DisableOnly]"
exit 0
