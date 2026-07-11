<#
.SYNOPSIS
  Pre-flight check for the BigBit bridge on the TARGET machine (Srv-all).
  Writes NOTHING to PG and never touches the original .mdb.

.DESCRIPTION
  Verifies everything install-task.ps1 and the first real run depend on:
    1. 64-bit PowerShell (the ACE x64 provider is invisible to a 32-bit process);
    2. config file (bigbit-bridge.env) present, required variables set;
    3. ACE OLEDB provider registered (Microsoft.ACE.OLEDB.16.0 or 12.0, x64);
    4. psql.exe found (config path, PATH, or Program Files\PostgreSQL\*\bin);
    5. UNC paths (.mdb + .MDW) reachable under the CURRENT user;
    6. PostgreSQL reachable as bb_sync: SELECT 1, then per-table privileges
       (SELECT/INSERT/UPDATE on item_groups/item_subgroups/item_origins) and the
       TEMP privilege on the database (staging tables) - read-only catalog queries;
    7. ULS READ test: copies .mdb + .MDW to local temp (the original is NEVER
       opened - same rule as the bridge itself), opens via ACE with the ULS
       account and runs SELECT COUNT(*) on each allow-listed table.
       WARNING in advance: admin/telefon has NO read right - the application
       account is "Slavisa". Skip this (large copy!) with -SkipUlsTest.

  NOTE: UNC checks run under the user running THIS script; the task may run under
  a different account (-RunAsUser) - for a definitive answer re-run logged in as
  that account. PowerShell 5.1 compatible. Exit 0 = all checks passed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\smoke-check.ps1
#>
[CmdletBinding()]
param(
  [string]$ScriptDir = $PSScriptRoot,
  [string]$ConfigFile = "",
  [switch]$SkipUlsTest,
  [switch]$SkipPg
)

$ErrorActionPreference = "Stop"

# Keep in sync with $TableMaps in bigbit-bridge.ps1 (v0 allow-list).
$SourceTables = @("R_Grupa", "R_Podgrupa", "R_Poreklo")
$TargetTables = @("item_groups", "item_subgroups", "item_origins")

$script:failCount = 0
$script:warnCount = 0
function Ok([string]$msg) { Write-Host "  [OK]      $msg" -ForegroundColor Green }
function Bad([string]$msg) { Write-Host "  [GRESKA]  $msg" -ForegroundColor Red; $script:failCount++ }
function Warn([string]$msg) { Write-Host "  [PAZNJA]  $msg" -ForegroundColor Yellow; $script:warnCount++ }
function Info([string]$msg) { Write-Host "  [INFO]    $msg" }

Write-Host "ServoSync BigBit bridge - provera preduslova (nista se ne upisuje)`n"

# ---------------------------------------------------------------- 1. Proces
Write-Host "1. PowerShell proces"
if ([Environment]::Is64BitProcess) {
  Ok "64-bitni PowerShell $($PSVersionTable.PSVersion) - ACE x64 provider je vidljiv."
} else {
  Bad "32-bitni PowerShell - ACE x64 provider NIJE vidljiv; pokreni 64-bitni powershell.exe."
}

# ---------------------------------------------------------------- 2. Konfiguracija
Write-Host "2. Konfiguracija (bigbit-bridge.env)"
if (-not $ConfigFile) {
  if (-not $ScriptDir) { $ScriptDir = "." }
  $ConfigFile = Join-Path $ScriptDir "bigbit-bridge.env"
}
$cfg = @{}
if (-not (Test-Path -LiteralPath $ConfigFile)) {
  Bad "$ConfigFile ne postoji - copy bigbit-bridge.env.example bigbit-bridge.env pa popuni vrednosti."
} else {
  # Same parse semantics as the bridge itself.
  foreach ($line in Get-Content -LiteralPath $ConfigFile) {
    $m = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
    if (-not $m.Success) { continue }
    $val = $m.Groups[2].Value
    $q = [regex]::Match($val, "^([`"'])(.*)\1$")
    if ($q.Success) { $val = $q.Groups[2].Value }
    $cfg[$m.Groups[1].Value] = $val
  }
  foreach ($name in @("BB_BRIDGE_MDB_UNC", "BB_BRIDGE_MDW_UNC", "BB_BRIDGE_ULS_USER",
      "BB_BRIDGE_ULS_PASSWORD", "BB_BRIDGE_PG_HOST", "BB_BRIDGE_PG_PASSWORD")) {
    if (-not $cfg[$name]) { Bad "obavezna promenljiva $name nije postavljena." }
    else { Ok "$name postavljen." }
  }
  if ($cfg["BB_BRIDGE_ULS_USER"] -and $cfg["BB_BRIDGE_ULS_USER"] -ieq "admin") {
    Bad "BB_BRIDGE_ULS_USER=admin - 'admin' NEMA READ pravo u ULS-u; aplikativni nalog je 'Slavisa'."
  }
}
if (-not $cfg["BB_BRIDGE_PG_PORT"]) { $cfg["BB_BRIDGE_PG_PORT"] = "5432" }
if (-not $cfg["BB_BRIDGE_PG_DB"]) { $cfg["BB_BRIDGE_PG_DB"] = "servosync" }
if (-not $cfg["BB_BRIDGE_PG_USER"]) { $cfg["BB_BRIDGE_PG_USER"] = "bb_sync" }

# ---------------------------------------------------------------- 3. ACE provider
Write-Host "3. ACE OLEDB provider (x64)"
$aceProvider = $null
try {
  $elements = (New-Object System.Data.OleDb.OleDbEnumerator).GetElements()
  $aceNames = @()
  foreach ($row in $elements.Rows) {
    $n = [string]$row["SOURCES_NAME"]
    if ($n -match '^Microsoft\.ACE\.OLEDB\.\d+\.0$') { $aceNames += $n }
  }
  $aceNames = @($aceNames | Sort-Object -Unique -Descending)
  if ($aceNames.Count -gt 0) {
    $aceProvider = $aceNames[0]
    Ok "registrovan: $($aceNames -join ', ') (koristi se $aceProvider)."
  } else {
    Bad ("nijedan Microsoft.ACE.OLEDB provider nije registrovan - instaliraj " +
      "'Microsoft Access Database Engine 2016 Redistributable' X64 (accessdatabaseengine_X64.exe).")
  }
} catch {
  Bad "enumeracija OLEDB providera pala: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- 4. psql
Write-Host "4. psql.exe (PostgreSQL client tools)"
$psqlExe = $null
if ($cfg["BB_BRIDGE_PSQL_EXE"]) {
  if (Test-Path -LiteralPath $cfg["BB_BRIDGE_PSQL_EXE"]) { $psqlExe = $cfg["BB_BRIDGE_PSQL_EXE"] }
  else { Bad "BB_BRIDGE_PSQL_EXE pokazuje na nepostojecu putanju: $($cfg['BB_BRIDGE_PSQL_EXE'])" }
} else {
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command psql -ErrorAction SilentlyContinue }
  if ($cmd) { $psqlExe = $cmd.Source }
  else {
    $guesses = @(Get-ChildItem -Path (Join-Path $env:ProgramFiles "PostgreSQL\*\bin\psql.exe") -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending)
    if ($guesses.Count -gt 0) { $psqlExe = $guesses[0].FullName }
  }
}
if ($psqlExe) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $ver = (& $psqlExe --version 2>&1 | Out-String).Trim()
  $ErrorActionPreference = $prevEap
  Ok "$psqlExe ($ver)"
} elseif (-not $cfg["BB_BRIDGE_PSQL_EXE"]) {
  Bad "psql.exe nije nadjen (PATH / Program Files\PostgreSQL) - instaliraj PostgreSQL client tools ili postavi BB_BRIDGE_PSQL_EXE."
}

# ---------------------------------------------------------------- 5. UNC putanje
Write-Host "5. UNC putanje (pod nalogom: $env:USERDOMAIN\$env:USERNAME)"
foreach ($pair in @(
    @{ Name = "BB_BRIDGE_MDB_UNC"; Label = ".mdb" },
    @{ Name = "BB_BRIDGE_MDW_UNC"; Label = ".MDW" })) {
  $p = $cfg[$pair.Name]
  if (-not $p) { Info "$($pair.Name) nije podesen - preskacem."; continue }
  if (Test-Path -LiteralPath $p) {
    $mb = [math]::Round(((Get-Item -LiteralPath $p).Length / 1MB), 1)
    Ok "$($pair.Label) dostupan: $p ($mb MB)"
  } else {
    Bad "$($pair.Label) nedostupan: $p - proveri UNC putanju i prava naloga."
  }
}

# ---------------------------------------------------------------- 6. PostgreSQL
function Invoke-PsqlCheck {
  param([string]$Sql)
  $psqlArgs = @("-h", $cfg["BB_BRIDGE_PG_HOST"], "-p", $cfg["BB_BRIDGE_PG_PORT"],
    "-d", $cfg["BB_BRIDGE_PG_DB"], "-U", $cfg["BB_BRIDGE_PG_USER"],
    "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", $Sql)
  $prevEap = $ErrorActionPreference
  $prevPw = $env:PGPASSWORD
  $env:PGPASSWORD = $cfg["BB_BRIDGE_PG_PASSWORD"]
  try {
    $ErrorActionPreference = "Continue"
    $raw = & $psqlExe @psqlArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    $env:PGPASSWORD = $prevPw
  }
  $text = ""
  if ($null -ne $raw) { $text = (@($raw | ForEach-Object { $_.ToString() }) -join "`n").Trim() }
  return @{ ExitCode = $code; Output = $text }
}

Write-Host "6. PostgreSQL ($($cfg['BB_BRIDGE_PG_HOST']):$($cfg['BB_BRIDGE_PG_PORT'])/$($cfg['BB_BRIDGE_PG_DB']) kao $($cfg['BB_BRIDGE_PG_USER']))"
if ($SkipPg) {
  Info "preskoceno (-SkipPg)."
} elseif (-not $psqlExe -or -not $cfg["BB_BRIDGE_PG_HOST"] -or -not $cfg["BB_BRIDGE_PG_PASSWORD"]) {
  Info "preskacem (psql ili PG podesavanja nekompletna)."
} else {
  $r = Invoke-PsqlCheck "SELECT 1"
  if ($r.ExitCode -ne 0) {
    Bad ("konekcija pala: $($r.Output) - podsetnik: 5432 na ubuntusrv jos NIJE izlozen na LAN " +
      "(vidi README, compose ports + ufw samo za 192.168.64.27).")
  } else {
    Ok "konekcija OK (SELECT 1)."
    $privSql = "SELECT c.relname || '=' || has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE') " +
      "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'public' AND c.relname IN ('" + ($TargetTables -join "','") + "') ORDER BY c.relname"
    $r = Invoke-PsqlCheck $privSql
    if ($r.ExitCode -ne 0) {
      Bad "provera privilegija pala: $($r.Output)"
    } else {
      $lines = @($r.Output -split "`n" | Where-Object { $_.Trim() })
      foreach ($t in $TargetTables) {
        $hit = $lines | Where-Object { $_ -eq "$t=t" }
        $miss = $lines | Where-Object { $_ -eq "$t=f" }
        if ($hit) { Ok "tabela $t : SELECT/INSERT/UPDATE dodeljeno." }
        elseif ($miss) { Bad "tabela $t : rola $($cfg['BB_BRIDGE_PG_USER']) NEMA SELECT/INSERT/UPDATE - vidi GRANT SQL u README." }
        else { Bad "tabela $t NE POSTOJI u bazi - Prisma migracije nisu primenjene?" }
      }
    }
    $r = Invoke-PsqlCheck "SELECT has_database_privilege(current_database(), 'TEMP')"
    if ($r.ExitCode -eq 0 -and $r.Output -eq "t") { Ok "TEMP privilegija na bazi (staging tabele) OK." }
    elseif ($r.ExitCode -eq 0) { Bad "rola nema TEMP privilegiju na bazi - GRANT TEMPORARY ON DATABASE ... (vidi README)." }
    else { Warn "provera TEMP privilegije pala: $($r.Output)" }
  }
}

# ---------------------------------------------------------------- 7. ULS read test
Write-Host "7. ULS READ test (kopija .mdb u temp, original se NE otvara)"
if ($SkipUlsTest) {
  Info "preskoceno (-SkipUlsTest)."
} elseif (-not $aceProvider) {
  Info "preskacem (nema ACE providera iz koraka 3)."
} elseif (-not $cfg["BB_BRIDGE_MDB_UNC"] -or -not (Test-Path -LiteralPath $cfg["BB_BRIDGE_MDB_UNC"]) `
    -or -not $cfg["BB_BRIDGE_MDW_UNC"] -or -not (Test-Path -LiteralPath $cfg["BB_BRIDGE_MDW_UNC"])) {
  Info "preskacem (UNC putanje nedostupne iz koraka 5)."
} elseif (-not $cfg["BB_BRIDGE_ULS_USER"] -or -not $cfg["BB_BRIDGE_ULS_PASSWORD"]) {
  Info "preskacem (ULS kredencijali nepotpuni)."
} else {
  $tmpDir = Join-Path $env:TEMP ("bigbit-bridge\smoke-" + [Guid]::NewGuid().ToString("N"))
  $conn = $null
  try {
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    Info "kopiram .mdb/.MDW u $tmpDir (moze potrajati za veliku bazu)..."
    $mdbCopy = Join-Path $tmpDir "smoke.mdb"
    $mdwCopy = Join-Path $tmpDir "smoke.mdw"
    Copy-Item -LiteralPath $cfg["BB_BRIDGE_MDB_UNC"] -Destination $mdbCopy -Force
    Copy-Item -LiteralPath $cfg["BB_BRIDGE_MDW_UNC"] -Destination $mdwCopy -Force

    $b = New-Object System.Data.OleDb.OleDbConnectionStringBuilder
    $b["Provider"] = $aceProvider
    $b["Data Source"] = $mdbCopy
    $b["Jet OLEDB:System Database"] = $mdwCopy
    $b["User ID"] = $cfg["BB_BRIDGE_ULS_USER"]
    $b["Password"] = $cfg["BB_BRIDGE_ULS_PASSWORD"]
    $conn = New-Object System.Data.OleDb.OleDbConnection $b.ConnectionString
    try {
      $conn.Open()
      Ok "ULS login OK (nalog: $($cfg['BB_BRIDGE_ULS_USER']), provider: $aceProvider)."
    } catch {
      $msg = $_.Exception.Message
      if ($msg -match "valid account name|account name or password|lozink") {
        Bad ("ULS login ODBIJEN za '$($cfg['BB_BRIDGE_ULS_USER'])': $msg - aplikativni nalog je 'Slavisa' " +
          "(lozinka od Negovana); admin/telefon NEMA read.")
      } else {
        Bad "otvaranje kopije palo: $msg"
      }
      throw
    }
    foreach ($t in $SourceTables) {
      try {
        $cmdO = $conn.CreateCommand()
        $cmdO.CommandText = "SELECT COUNT(*) FROM [$t]"
        $n = [int]$cmdO.ExecuteScalar()
        Ok "READ $t : $n redova."
      } catch {
        Bad ("READ $t PAO: $($_.Exception.Message) - nalog nema READ pravo u ULS-u? " +
          "(admin/telefon NEMA read; koristi 'Slavisa').")
      }
    }
  } catch {
    # Failure details already reported above via Bad.
  } finally {
    if ($conn) { $conn.Dispose() }
    if (Test-Path -LiteralPath $tmpDir) {
      Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# ---------------------------------------------------------------- Rezime
Write-Host ""
if ($script:failCount -eq 0) {
  Write-Host "REZIME: sve provere prosle ($script:warnCount upozorenja). Sledece: probni run 'bigbit-bridge.ps1 -DryRun', pa install-task.ps1" -ForegroundColor Green
  exit 0
} else {
  Write-Host "REZIME: $script:failCount provera PALO, $script:warnCount upozorenja - vidi [GRESKA] redove gore." -ForegroundColor Red
  exit 1
}
