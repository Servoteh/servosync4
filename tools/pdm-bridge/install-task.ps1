<#
.SYNOPSIS
  Registers (or re-registers) the "ServoSync PDM Bridge" Windows Task Scheduler task.

.DESCRIPTION
  Automates the whole Task Scheduler section of README.md without the manual GUI step:
    - action  = node.exe --env-file=.env pdm-bridge.mjs, WorkingDirectory = script folder
                (the schtasks "Start in" problem solved via Register-ScheduledTask);
    - trigger = every N minutes (default 5), indefinitely, StartWhenAvailable;
    - settings: "Do not start a new instance" (runs must not overlap) + stop after 1 hour;
    - principal: given user, LogonType=Password ("Run whether user is logged on or not").
  The account password is entered INTERACTIVELY by a human (never stored anywhere).
  Idempotent: re-running overwrites the existing task (-Force re-register).

  NOTE: this script provisions NOTHING remotely - run it ON the target Windows machine,
  from an elevated (admin) PowerShell. PowerShell 5.1 compatible.

.PARAMETER RunAsUser
  Windows account that runs the task (DOMAIN\name or MACHINE\name). Must have READ on
  both UNC shares from .env (active mode later also needs write/move) and the
  "Log on as a batch job" right.

.PARAMETER NodeExe
  Full path to node.exe. Default: auto-detect (Get-Command node.exe), then
  "%ProgramFiles%\nodejs\node.exe".

.PARAMETER ScriptDir
  Folder with pdm-bridge.mjs and .env. Default: the folder of this script.

.PARAMETER IntervalMinutes
  Repeat interval in minutes (default 5 - the P4 cadence next to the legacy 10-min scripts).

.PARAMETER TaskName
  Scheduled task name. Default "ServoSync PDM Bridge". Keep the default unless you
  intentionally run a second instance against different shares.

.PARAMETER Password
  Password of RunAsUser as SecureString. Omit it - the script prompts interactively.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1 -RunAsUser SERVOTEH\pdmbridge
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RunAsUser,

  [string]$NodeExe = "",

  [string]$ScriptDir = $PSScriptRoot,

  [ValidateRange(1, 60)]
  [int]$IntervalMinutes = 5,

  [string]$TaskName = "ServoSync PDM Bridge",

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

# --- Resolve and validate the script folder (pdm-bridge.mjs + .env must exist). ---
if (-not $ScriptDir) { Fail "ScriptDir nije poznat - prosledi -ScriptDir <folder sa pdm-bridge.mjs>." }
$ScriptDir = (Resolve-Path -LiteralPath $ScriptDir).Path
$bridgeMjs = Join-Path $ScriptDir "pdm-bridge.mjs"
$envFile = Join-Path $ScriptDir ".env"
if (-not (Test-Path -LiteralPath $bridgeMjs)) { Fail "Nema pdm-bridge.mjs u $ScriptDir." }
if (-not (Test-Path -LiteralPath $envFile)) {
  # Hard requirement: the action uses --env-file=.env, so a missing .env means every run dies.
  Fail "Nema .env u $ScriptDir - prvo: copy .env.example .env pa popuni vrednosti (vidi README)."
}

# --- Resolve and validate node.exe (>= 20.6 for --env-file + built-in fetch/FormData). ---
if (-not $NodeExe) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
  else { $NodeExe = Join-Path $env:ProgramFiles "nodejs\node.exe" }
}
if (-not (Test-Path -LiteralPath $NodeExe)) {
  Fail "node.exe nije nadjen ($NodeExe) - instaliraj Node.js 22 LTS ili prosledi -NodeExe."
}
$nodeVersion = (& $NodeExe --version).Trim()
if ($nodeVersion -match "^v(\d+)\.(\d+)") {
  $maj = [int]$Matches[1]
  $min = [int]$Matches[2]
  if (-not ($maj -gt 20 -or ($maj -eq 20 -and $min -ge 6))) {
    Fail "Node $nodeVersion je prestar - potreban je >= 20.6 (preporuka: 22 LTS)."
  }
} else {
  Fail "Ne mogu da procitam verziju Node-a iz '$nodeVersion' ($NodeExe)."
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
$action = New-ScheduledTaskAction `
  -Execute $NodeExe `
  -Argument "--env-file=.env pdm-bridge.mjs" `
  -WorkingDirectory $ScriptDir

# Once + indefinite repetition = the schtasks "/SC MINUTE /MO N" equivalent.
$trigger = New-ScheduledTaskTrigger `
  -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

# IgnoreNew = GUI "Do not start a new instance"; 1h limit = hung-run guard (README).
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[INFO] Task '$TaskName' vec postoji - bice pregazen (idempotentan re-register)."
}

try {
  # -User + -Password => LogonType Password = "Run whether user is logged on or not".
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
Write-Host "     Node:        $NodeExe ($nodeVersion)"
Write-Host "     Start in:    $ScriptDir"
Write-Host "     Interval:    na $IntervalMinutes min (Do not start a new instance; stop posle 1h)"
Write-Host ""
Write-Host "Sledeci koraci:"
Write-Host "  1. Odmah probaj:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "  2. Rezultat:      Get-ScheduledTaskInfo -TaskName `"$TaskName`"  (LastTaskResult: 0=OK,"
Write-Host "                    1=bar jedan fajl pao, 2=login/permisija, 3=konfiguracija - vidi README)"
Write-Host "  3. Log:           $ScriptDir\pdm-bridge.log"
Write-Host "  4. Pauza/uklanjanje: uninstall-task.ps1 [-DisableOnly]"
exit 0
