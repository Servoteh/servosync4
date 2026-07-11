<#
.SYNOPSIS
  Pre-flight check for the PDM bridge on the TARGET Windows machine. Sends NO files.

.DESCRIPTION
  Verifies everything install-task.ps1 and the first real run depend on:
    1. Node.js present and >= 20.6 (built-in fetch/FormData + --env-file);
    2. .env next to the script: required variables set, PDM_BRIDGE_MODE=passive (P4c);
    3. UNC shares from .env visible under the CURRENT user (+ file counts, informative);
    4. script folder writable (state + log files live there);
    5. backend API reachable: GET {API_BASE}/health, database "up";
    6. login with the service account (POST {API_BASE}/auth/login);
    7. pdm.import permission probe WITHOUT uploading anything:
       POST {API_BASE}/v1/pdm/import with the token and NO file
         -> HTTP 400 ("Nedostaje XML fajl") = permission OK (guard passed, no log row is
            written - the backend rejects before any processing);
         -> HTTP 403 = role without pdm.import;
         -> HTTP 401 = token problem.

  NOTE: shares are checked under the user running THIS script; the task may run under a
  different account (-RunAsUser) - re-run the check logged in as that account for a
  definitive answer. PowerShell 5.1 compatible. Exit 0 = all checks passed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-check.ps1
#>
[CmdletBinding()]
param(
  [string]$ScriptDir = $PSScriptRoot,
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
# PS 5.1 defaults may exclude TLS 1.2 (needed for the Cloudflare tunnel endpoint).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$script:failCount = 0
$script:warnCount = 0
function Ok([string]$msg) { Write-Host "  [OK]      $msg" -ForegroundColor Green }
function Bad([string]$msg) { Write-Host "  [GRESKA]  $msg" -ForegroundColor Red; $script:failCount++ }
function Warn([string]$msg) { Write-Host "  [PAZNJA]  $msg" -ForegroundColor Yellow; $script:warnCount++ }
function Info([string]$msg) { Write-Host "  [INFO]    $msg" }

function Get-HttpStatus($err) {
  try { return [int]$err.Exception.Response.StatusCode } catch { return 0 }
}

function Read-ErrorBody($err) {
  try {
    $stream = $err.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } catch { return "" }
}

Write-Host "ServoSync PDM bridge - provera preduslova (nista se ne salje)`n"

# ---------------------------------------------------------------- 1. Node
Write-Host "1. Node.js"
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCmd) {
  Bad "node nije na PATH-u - instaliraj Node.js 22 LTS (https://nodejs.org)."
} else {
  $nodeVersion = (& $nodeCmd.Source --version).Trim()
  if ($nodeVersion -match "^v(\d+)\.(\d+)") {
    $maj = [int]$Matches[1]
    $min = [int]$Matches[2]
    if ($maj -gt 20 -or ($maj -eq 20 -and $min -ge 6)) {
      Ok "node $nodeVersion ($($nodeCmd.Source))"
    } else {
      Bad "node $nodeVersion je prestar - potreban >= 20.6 (preporuka: 22 LTS)."
    }
  } else {
    Bad "ne mogu da procitam verziju node-a ('$nodeVersion')."
  }
}

# ---------------------------------------------------------------- 2. .env
Write-Host "2. Konfiguracija (.env)"
if (-not $EnvFile) {
  if (-not $ScriptDir) { $ScriptDir = "." }
  $EnvFile = Join-Path $ScriptDir ".env"
}
$cfg = @{}
if (-not (Test-Path -LiteralPath $EnvFile)) {
  Bad "$EnvFile ne postoji - copy .env.example .env pa popuni vrednosti."
} else {
  # Same parse semantics as the bridge's own .env fallback (loadEnvFallback).
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $m = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
    if (-not $m.Success) { continue }
    $val = $m.Groups[2].Value
    $q = [regex]::Match($val, "^([`"'])(.*)\1$")
    if ($q.Success) { $val = $q.Groups[2].Value }
    $cfg[$m.Groups[1].Value] = $val
  }
  foreach ($name in @("PDM_BRIDGE_API_BASE", "PDM_BRIDGE_EMAIL", "PDM_BRIDGE_PASSWORD")) {
    if (-not $cfg[$name]) { Bad "obavezna promenljiva $name nije postavljena u .env." }
    else { Ok "$name postavljen." }
  }
  if (-not $cfg["PDM_BRIDGE_XML_DIR"] -and -not $cfg["PDM_BRIDGE_PDF_DIR"]) {
    Bad "bar jedan od PDM_BRIDGE_XML_DIR / PDM_BRIDGE_PDF_DIR mora biti podesen."
  }
  $mode = $cfg["PDM_BRIDGE_MODE"]
  if (-not $mode) { $mode = "passive" }
  if ($mode.ToLower() -eq "passive") {
    Ok "PDM_BRIDGE_MODE=passive (obavezno dok legacy skripte zive)."
  } else {
    Warn "PDM_BRIDGE_MODE=$mode - za P4c (paralelni rad sa legacy) mora biti 'passive'!"
  }
}

# ---------------------------------------------------------------- 3. Share-ovi
Write-Host "3. Vidljivost share-ova (pod nalogom: $env:USERDOMAIN\$env:USERNAME)"
$shareChecks = @(
  @{ Name = "PDM_BRIDGE_XML_DIR"; Ext = "*.xml" },
  @{ Name = "PDM_BRIDGE_PDF_DIR"; Ext = "*.pdf" }
)
foreach ($sc in $shareChecks) {
  $dir = $cfg[$sc.Name]
  if (-not $dir) { Info "$($sc.Name) nije podesen - preskacem."; continue }
  if (Test-Path -LiteralPath $dir) {
    try {
      $count = (Get-ChildItem -LiteralPath $dir -Filter $sc.Ext -File -ErrorAction Stop | Measure-Object).Count
      Ok "$($sc.Name) dostupan: $dir ($count x $($sc.Ext) zateceno)"
    } catch {
      Bad "$($sc.Name): folder postoji ali listanje pada ($($_.Exception.Message))."
    }
  } else {
    Bad "$($sc.Name) nedostupan: $dir - proveri UNC putanju i prava naloga."
  }
}

# ---------------------------------------------------------------- 4. Upis u folder skripte
Write-Host "4. Upis u folder skripte (state/log)"
if ($ScriptDir -and (Test-Path -LiteralPath $ScriptDir)) {
  $probe = Join-Path $ScriptDir (".smoke-write-probe-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    Set-Content -LiteralPath $probe -Value "probe" -Encoding ASCII
    Remove-Item -LiteralPath $probe -Force
    Ok "folder $ScriptDir je upisiv (pdm-bridge.state.json / pdm-bridge.log)."
  } catch {
    Bad "folder $ScriptDir nije upisiv: $($_.Exception.Message)"
  }
} else {
  Bad "folder skripte '$ScriptDir' ne postoji."
}

# ---------------------------------------------------------------- 5-7. API
$apiBase = $cfg["PDM_BRIDGE_API_BASE"]
if ($apiBase) { $apiBase = $apiBase -replace "/+$", "" }

Write-Host "5. API health"
$apiUp = $false
if (-not $apiBase) {
  Bad "PDM_BRIDGE_API_BASE nije postavljen - preskacem API provere."
} else {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$apiBase/health" -TimeoutSec 20
    $body = $null
    try { $body = $resp.Content | ConvertFrom-Json } catch {}
    $db = $null
    if ($body) {
      if ($body.PSObject.Properties["data"]) { $db = $body.data.database }
      if (-not $db -and $body.PSObject.Properties["database"]) { $db = $body.database }
    }
    if ($db -eq "up") {
      Ok "$apiBase/health -> HTTP $($resp.StatusCode), database=up"
      $apiUp = $true
    } elseif ($db) {
      Bad "$apiBase/health odgovara, ali database=$db."
    } else {
      Warn "$apiBase/health -> HTTP $($resp.StatusCode), ali odgovor nema 'database' polje."
      $apiUp = $true
    }
  } catch {
    Bad "$apiBase/health nedostupan: $($_.Exception.Message)"
  }
}

Write-Host "6. Login servisnim nalogom"
$token = $null
if ($apiUp -and $cfg["PDM_BRIDGE_EMAIL"] -and $cfg["PDM_BRIDGE_PASSWORD"]) {
  $loginJson = @{ email = $cfg["PDM_BRIDGE_EMAIL"]; password = $cfg["PDM_BRIDGE_PASSWORD"] } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$apiBase/auth/login" `
      -ContentType "application/json" -Body ([Text.Encoding]::UTF8.GetBytes($loginJson)) -TimeoutSec 20
    $body = $resp.Content | ConvertFrom-Json
    # Same token extraction as the bridge (envelope {data:{accessToken}} or flat).
    if ($body.PSObject.Properties["accessToken"]) { $token = $body.accessToken }
    if (-not $token -and $body.PSObject.Properties["data"]) { $token = $body.data.accessToken }
    if ($token) { Ok "login OK za $($cfg['PDM_BRIDGE_EMAIL']) (accessToken dobijen)." }
    else { Bad "login prosao, ali odgovor nema accessToken - proveri API verziju." }
  } catch {
    $status = Get-HttpStatus $_
    if ($status -eq 401) { Bad "login odbijen (401) - pogresan email/lozinka servisnog naloga." }
    elseif ($status -gt 0) { Bad "login pao: HTTP $status - $(Read-ErrorBody $_)" }
    else { Bad "login pao: $($_.Exception.Message)" }
  }
} else {
  Info "preskacem (API nedostupan ili kredencijali nepotpuni)."
}

Write-Host "7. Permisija pdm.import (proba BEZ fajla)"
if ($token) {
  # POST /v1/pdm/import without a 'file' part: PermissionsGuard runs FIRST (403 = no
  # pdm.import); with the permission the backend answers 400 "Nedostaje XML fajl"
  # BEFORE any processing - no file is sent, no drawing_import_log row is written.
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$apiBase/v1/pdm/import" `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20 | Out-Null
    Warn "POST /v1/pdm/import bez fajla je prosao (2xx) - neocekivano; proveri backend rucno."
  } catch {
    $status = Get-HttpStatus $_
    if ($status -eq 400) {
      Ok "servisni nalog IMA pdm.import (backend trazi fajl -> 400, nista nije poslato)."
    } elseif ($status -eq 403) {
      Bad "servisni nalog NEMA pdm.import (403) - dodeli rolu po README (Servisni nalog / P4c korak 1)."
    } elseif ($status -eq 401) {
      Bad "token odbijen (401) na /v1/pdm/import - neocekivano posle uspesnog logina."
    } elseif ($status -gt 0) {
      Bad "neocekivan odgovor HTTP $status - $(Read-ErrorBody $_)"
    } else {
      Bad "proba permisije pala: $($_.Exception.Message)"
    }
  }
} else {
  Info "preskacem (nema tokena iz koraka 6)."
}

# ---------------------------------------------------------------- Rezime
Write-Host ""
if ($script:failCount -eq 0) {
  Write-Host "REZIME: sve provere prosle ($script:warnCount upozorenja). Sledece: install-task.ps1" -ForegroundColor Green
  exit 0
} else {
  Write-Host "REZIME: $script:failCount provera PALO, $script:warnCount upozorenja - vidi [GRESKA] redove gore." -ForegroundColor Red
  exit 1
}
