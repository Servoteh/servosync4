# =============================================================================
# setup-scada-vm.ps1 - SVE za SCADA na bridge VM (192.168.64.24)
# =============================================================================
# Za masinu na kojoj VEC radi "Servoteh Bridge" (BigTehn sync) - ovaj skript
# NE dira BigTehn jobove. Podize:
#   1. scada-app  (PLC drajveri + lokalni API, port 3000) kao Windows servis
#      "Kotlarnica SCADA"
#   2. SCADA relay u postojecem bridge servisu (poziva scripts\setup-scada.ps1)
#
# Pokretanje (Administrator, iz repo root-a):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-scada-vm.ps1
#
# PRE POKRETANJA (jednom): u scada-app\.env upisati kredencijale uredjaja
# (LOXONE_PASS, BLUELOG_PASS, SIGEN_APP_KEY/SECRET, S7_USER/PASS...) - kopirati
# postojeci .env sa masine gde je SCADA app do sada radila. Tajne NISU u git-u.
# =============================================================================
param(
  [switch]$SkipPreflight
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scadaDir = Join-Path $root 'scada-app'
Write-Host "== SCADA na bridge VM ==" -ForegroundColor Cyan

# --- 0. preflight: da li VM uopste vidi uredjaje na 192.168.75.x ------------
if (-not $SkipPreflight) {
  Write-Host "`n== preflight: mrezni pristup uredjajima =="
  $targets = @(
    @{ n = 'Siemens S7 (kot2)'; ip = '192.168.75.12'; port = 443 },
    @{ n = 'Loxone (kot3)';     ip = '192.168.75.130'; port = 80 },
    @{ n = "blue'Log (KACO)";   ip = '192.168.75.15'; port = 80 },
    @{ n = 'Unitronics (kot1)'; ip = '192.168.75.25'; port = 502 }
  )
  $reachable = 0
  foreach ($t in $targets) {
    $ok = (Test-NetConnection -ComputerName $t.ip -Port $t.port -WarningAction SilentlyContinue).TcpTestSucceeded
    if ($ok) { $reachable++; Write-Host "[OK] $($t.n) $($t.ip):$($t.port)" -ForegroundColor Green }
    else { Write-Host "[!] $($t.n) $($t.ip):$($t.port) NEDOSTUPAN" -ForegroundColor Yellow }
  }
  if ($reachable -eq 0) {
    Write-Host "NIJEDAN uredjaj nije dostupan sa ove masine (75.x mreza nije rutirana?)." -ForegroundColor Red
    Write-Host "SCADA app ovde nema smisla - proveri mrezu ili je instaliraj na masini u 75.x mrezi." -ForegroundColor Red
    exit 1
  }
  if ($reachable -lt 3) {
    Write-Host "[UPOZORENJE] deo uredjaja nedostupan (kot1 Unitronics je ionako u kvaru) - nastavljam." -ForegroundColor Yellow
  }
}

# --- 1. scada-app ------------------------------------------------------------
Write-Host "`n== scada-app (PLC drajveri, port 3000) =="
Set-Location $scadaDir
if (-not (Test-Path (Join-Path $scadaDir '.env'))) {
  Copy-Item (Join-Path $scadaDir '.env.example') (Join-Path $scadaDir '.env')
  Write-Host "[UPOZORENJE] scada-app\.env je tek kreiran iz primera - UPISI KREDENCIJALE" -ForegroundColor Yellow
  Write-Host "             (LOXONE_PASS, BLUELOG_PASS, SIGEN_*, S7_*) pa pokreni skript ponovo." -ForegroundColor Yellow
  exit 1
}
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "scada-app npm ci nije uspeo" }

$scadaSvc = $null
try { $scadaSvc = Get-Service -Name 'kotlarnicascada.exe' -ErrorAction Stop } catch {}
if ($null -eq $scadaSvc) { $scadaSvc = Get-Service | Where-Object { $_.DisplayName -like '*otlarnica*' } | Select-Object -First 1 }
if ($null -eq $scadaSvc) {
  Write-Host "instaliram Windows servis 'Kotlarnica SCADA'..."
  npm run service:install
  Start-Sleep -Seconds 8
} else {
  Write-Host "servis '$($scadaSvc.DisplayName)' postoji - restartujem"
  Restart-Service -InputObject $scadaSvc -Force
  Start-Sleep -Seconds 5
}

# probaj API
$ok = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/state' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 3 }
}
if ($ok) { Write-Host "[OK] scada-app odgovara na http://127.0.0.1:3000" -ForegroundColor Green }
else { Write-Host "[GRESKA] scada-app ne odgovara - proveri servis 'Kotlarnica SCADA' / logove" -ForegroundColor Red; exit 1 }

# --- 2. bridge SCADA relay (postojeca instalacija, BigTehn jobovi netaknuti) --
Set-Location $root
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\setup-scada.ps1') -ScadaBaseUrl 'http://127.0.0.1:3000'
if ($LASTEXITCODE -ne 0) { throw "setup-scada.ps1 (bridge deo) nije uspeo" }

Write-Host "`n== SVE GOTOVO == Otvori ServoSync -> Energetika/SCADA i proveri da su sistemi zeleni." -ForegroundColor Cyan
Write-Host "Napomena: iskljuci privremeni laptop relay ako jos radi (Nenadov laptop) - jedna instanca scada-app!" -ForegroundColor Yellow
