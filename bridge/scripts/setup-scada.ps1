# =============================================================================
# setup-scada.ps1 - ukljucivanje SCADA relay-a na postojecoj bridge masini
# =============================================================================
# Pokrenuti kao ADMINISTRATOR iz repo root-a (ili bilo gde - skripta se sama
# pozicionira). Radnje:
#   1. npm ci                       (osvezi zavisnosti posle git pull)
#   2. .env                        (doda SCADA blok ako ne postoji)
#   3. smoke test                  (jedan scada snapshot pass -> Supabase)
#   4. restart Windows servisa     (Servoteh Bridge / servotehbridge)
#
# Parametri:
#   -ScadaBaseUrl  URL lokalne SCADA aplikacije (default http://127.0.0.1:3000;
#                  ako scada-app radi na drugoj masini: http://192.168.75.x:3000)
#   -NoRestart     preskoci restart servisa (samo priprema + smoke)
# =============================================================================
param(
  [string]$ScadaBaseUrl = 'http://127.0.0.1:3000',
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "== Servoteh Bridge - SCADA setup ==" -ForegroundColor Cyan
Write-Host "Repo: $root"
Write-Host "SCADA app: $ScadaBaseUrl"

# --- 0. provera da SCADA app odgovara -------------------------------------
try {
  $r = Invoke-WebRequest -Uri "$ScadaBaseUrl/api/state" -UseBasicParsing -TimeoutSec 8
  Write-Host "[OK] SCADA app odgovara na $ScadaBaseUrl/api/state (HTTP $($r.StatusCode))" -ForegroundColor Green
} catch {
  Write-Host "[UPOZORENJE] SCADA app ne odgovara na $ScadaBaseUrl - proveri servis 'Kotlarnica SCADA' ili prosledi -ScadaBaseUrl http://<ip>:3000" -ForegroundColor Yellow
}

# --- 1. zavisnosti ----------------------------------------------------------
Write-Host "`n== npm ci =="
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci nije uspeo" }

# --- 2. .env dopuna ---------------------------------------------------------
$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) { throw ".env ne postoji u $root - ovo nije konfigurisana bridge instalacija" }
$envRaw = Get-Content $envPath -Raw
if ($envRaw -match 'SCADA_ENABLED') {
  Write-Host "[OK] .env vec ima SCADA blok - ne diram (proveri SCADA_ENABLED=true)" -ForegroundColor Green
} else {
  $block = @"

# ---- SCADA relay (Energetika) - dodato setup-scada.ps1 ----
SCADA_ENABLED=true
SCADA_BASE_URL=$ScadaBaseUrl
# kill-switch: false zaustavlja IZVRSAVANJE komandi (nadzor radi dalje)
SCADA_CONTROL=true
SCADA_SNAPSHOT_MS=5000
SCADA_HISTORY_MS=60000
SCADA_CMD_POLL_MS=2000
SCADA_CMD_RATE_PER_MIN=10
SCADA_HISTORY_RETENTION_DAYS=90
"@
  [System.IO.File]::AppendAllText($envPath, $block.Replace("`n", [Environment]::NewLine))
  Write-Host "[OK] SCADA blok dodat u .env" -ForegroundColor Green
}

# --- 3. smoke test (jedan snapshot pass, pise u Supabase + bridge_sync_log) --
Write-Host "`n== smoke: sync:scada (one-shot) =="
node src/index.js --job=scada --once
if ($LASTEXITCODE -ne 0) { throw "scada smoke test nije prosao - vidi log iznad" }
Write-Host "[OK] snapshot upisan u Supabase (proveri modul Energetika/SCADA)" -ForegroundColor Green

# --- 4. restart servisa -------------------------------------------------------
if ($NoRestart) {
  Write-Host "`n-NoRestart: preskacem restart servisa. Uradi rucno: Restart-Service 'Servoteh Bridge'" -ForegroundColor Yellow
  exit 0
}
Write-Host "`n== restart servisa =="
$candidates = @('servotehbridge', 'Servoteh Bridge', 'servotehbridge.exe')
$svc = $null
foreach ($name in $candidates) {
  try { $svc = Get-Service -Name $name -ErrorAction Stop; break } catch {}
}
if ($null -eq $svc) {
  $svc = Get-Service | Where-Object { $_.DisplayName -like '*ervoteh*ridge*' } | Select-Object -First 1
}
if ($null -eq $svc) {
  Write-Host "[UPOZORENJE] Ne nalazim bridge servis - restartuj rucno, ili instaliraj: npm run service:install" -ForegroundColor Yellow
} else {
  Restart-Service -InputObject $svc -Force
  Start-Sleep -Seconds 3
  $svc.Refresh()
  Write-Host "[OK] Servis '$($svc.DisplayName)' status: $($svc.Status)" -ForegroundColor Green
}

Write-Host "`n== GOTOVO == SCADA petlje rade u okviru bridge servisa (log: logs\bridge-*.log, trazi '[scada] starting loops')" -ForegroundColor Cyan
