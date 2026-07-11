<#
.SYNOPSIS
  ServoSync BigBit bridge - one-shot sync of BigBit ERP (Access .mdb with ULS
  workgroup security) master tables into ServoSync 2.0 PostgreSQL cache tables.

.DESCRIPTION
  Runs on the Windows server Srv-all.servoteh.local (192.168.64.27) once a day
  (Task Scheduler, 05:30 - see install-task.ps1). Decision (Nenad, 2026-07-11):
  the script reads BigBit directly and writes DIRECTLY to PG over LAN; NO XML
  files and NO NestJS sync module (backend/docs/migration/BB_T_26_ANALIZA_I_PLAN.md
  section 7.3).

  Pipeline per run:
    1. Copy the BigBit .mdb + BIGBIT.MDW from the UNC share into a local temp
       folder. The ORIGINAL is NEVER opened: the BigBit application keeps it open
       all day, and attaching to a live Jet database from another process is the
       kind of interference we must not risk. Reading a COPY also freezes one
       snapshot; Jet has no online-backup API, so a copy of an open .mdb can in
       theory be torn mid-write - the 05:30 nightly slot (nobody works) is what
       minimizes that risk. A torn copy fails loudly at open/read time (exit 2)
       and the next night retries.
    2. Open the COPY via ACE OLEDB (Microsoft.ACE.OLEDB.16.0, fallback 12.0) with
       "Jet OLEDB:System Database"=<BIGBIT.MDW copy> + ULS User ID/Password.
       STARTUP CHECK: SELECT COUNT(*) on the first allow-listed table. The ULS
       account MUST have READ rights - admin/telefon has NO read; the application
       account is "Slavisa". Failure = clear message + exit 2.
    3. For each table in $TableMaps (declarative allow-list): read rows, write a
       UTF-8 (no BOM) CSV into temp, then run psql.exe with a generated script:
       \copy into a TEMP staging table + INSERT ... ON CONFLICT ... DO UPDATE.
       UPSERT is a decision - insert-only was rejected because it freezes later
       edits (e.g. renamed descriptions would never propagate). Everything runs
       in ONE transaction per table; a failed table never leaves partial rows.
       Rows present in PG but missing from BigBit are NEVER deleted - only
       counted and logged (missing_in_source), per plan section 7.3.
    4. Append per-table counters (read / inserted / updated / unchanged /
       missing_in_source, duration) to bigbit-bridge.log; exit code != 0 on any
       failure so Task Scheduler "Last Run Result" shows it.

  Machine prerequisites (see README.md): Microsoft Access Database Engine x64
  redistributable (ACE OLEDB) + PostgreSQL client tools (psql.exe). Nothing else.

.PARAMETER ConfigFile
  Path to the env-style config file (default: bigbit-bridge.env next to this
  script). See bigbit-bridge.env.example. Process environment variables with the
  same names override values from the file.

.PARAMETER Only
  Sync a single table - the value matches either the Access source name (e.g.
  R_Grupa) or the PG target name (e.g. item_groups). For pilot/debug runs.

.PARAMETER DryRun
  Full end-to-end run (copy, ULS read, CSV, psql staging + upsert with real
  counters) but the final COMMIT is replaced by ROLLBACK - nothing persists.

.PARAMETER KeepTemp
  Keep the per-run temp folder (copied .mdb, CSV, SQL) even on success.
  On failure the folder is always kept for diagnostics.

.NOTES
  PowerShell 5.1 compatible (Windows Server 2019) - no PS7 syntax, no external
  modules; OLEDB via System.Data.OleDb from the .NET Framework.

  Exit codes (Task Scheduler "Last Run Result"):
    0 = OK
    1 = at least one table failed to sync (details in bigbit-bridge.log)
    2 = BigBit read failed (ULS login rejected / no READ right / unreadable copy)
    3 = configuration invalid or prerequisite missing (ACE provider, psql.exe)
    4 = snapshot copy failed (UNC share unreachable)
    5 = PostgreSQL unreachable (startup SELECT 1 failed)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\bigbit-bridge.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$ConfigFile = "",
  [string]$Only = "",
  [switch]$DryRun,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$EXIT_OK = 0
$EXIT_TABLE_FAILED = 1
$EXIT_BIGBIT_READ = 2
$EXIT_CONFIG = 3
$EXIT_SNAPSHOT = 4
$EXIT_PG = 5

# ---------------------------------------------------------------------------
# Declarative table maps (v0 allow-list) - ADD NEW TABLES HERE, nothing else
# needs to change. Enforcement of the deny-list (EXCLUDE-TVRDO in F3) is simply
# "not being listed here" - the script never SELECTs anything outside this list.
#
# Map shape:
#   Source     - Access table name (log label)
#   SelectSql  - exact SELECT against the copy; list columns EXPLICITLY (never *)
#                so a schema drift in BigBit fails loudly instead of silently
#                shifting columns. This is also where sensitive columns are kept
#                out (e.g. future Prodavci: NEVER select [Password] - plain-text).
#   Target     - PG table (must be covered by the bb_sync role GRANT, see README)
#   KeyColumns - PG primary-key column(s) used as the ON CONFLICT target
#   Columns    - ordered list; Name = PG column, PgType = staging column type,
#                Source = Access column from SelectSql, Default = value used when
#                the Access cell is NULL (omit Default -> genuine SQL NULL).
#                numeric/decimal PgType values are formatted with the invariant
#                culture ("1.5", never "1,5" - Serbian locale trap).
#
# v0 = pilot: 3 item classifier tables (models exist in 2.0, were never synced -
# Item.groupCode/subgroupCode/originCode were codes without names, F1 gap).
#
# Expansion phases (see README.md "Faze prosirenja"):
#   phase 2 - Komitenti, Predmeti, R_Artikli, Cenovnik, Magacini, Prodavci
#             (Prodavci.Password is NEVER copied - plain-text passwords!).
#             BLOCKED until the ID-space decision (items.id: QBigTehn key vs
#             BigBit code - BB_T_26_ANALIZA_I_PLAN.md sections 7.2/7.3).
#   phase 3 - the rest of the KEEP-SYNC list from
#             backend/docs/migration/BB_T_26-analiza-F3-inventar-207-tabela.md
# ---------------------------------------------------------------------------
$TableMaps = @(
  @{
    Source     = "R_Grupa"
    SelectSql  = "SELECT [Grupa], [Opis] FROM [R_Grupa]"
    Target     = "item_groups"
    KeyColumns = @("code")
    Columns    = @(
      @{ Name = "code";        PgType = "varchar(10)"; Source = "Grupa" },
      @{ Name = "description"; PgType = "varchar(50)"; Source = "Opis"; Default = "" }   # target is NOT NULL -> COALESCE(Opis,'')
    )
  },
  @{
    Source     = "R_Podgrupa"
    SelectSql  = "SELECT [Podgrupa], [Opis], [GrupaVeza] FROM [R_Podgrupa]"
    Target     = "item_subgroups"
    KeyColumns = @("code")
    Columns    = @(
      @{ Name = "code";         PgType = "varchar(10)"; Source = "Podgrupa" },
      @{ Name = "description";  PgType = "varchar(50)"; Source = "Opis";      Default = "" },
      @{ Name = "parent_group"; PgType = "varchar(10)"; Source = "GrupaVeza"; Default = "0" }
    )
  },
  @{
    Source     = "R_Poreklo"
    SelectSql  = "SELECT [Poreklo], [Opis], [PodgrupaVeza], [PopustProc] FROM [R_Poreklo]"
    Target     = "item_origins"
    KeyColumns = @("code")
    Columns    = @(
      @{ Name = "code";             PgType = "varchar(5)";    Source = "Poreklo" },
      @{ Name = "description";      PgType = "varchar(50)";   Source = "Opis";         Default = "" },
      @{ Name = "subgroup_code";    PgType = "varchar(10)";   Source = "PodgrupaVeza"; Default = "0" },
      @{ Name = "discount_percent"; PgType = "numeric(19,4)"; Source = "PopustProc";   Default = "0" }  # Access Currency; commercial discount, matters for 4.0 sales
    )
  }
)

# ---------------------------------------------------------------------------
# Logging (console mirror + append to log file, never fails the run)
# ---------------------------------------------------------------------------
$script:LogFile = $null

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "{0} {1,-5} {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  if ($Level -eq "ERROR") { Write-Host $line -ForegroundColor Red }
  elseif ($Level -eq "WARN") { Write-Host $line -ForegroundColor Yellow }
  else { Write-Host $line }
  if ($script:LogFile) {
    try {
      [System.IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false)))
    } catch { }  # unwritable log must never kill the run - console mirror remains
  }
}

# ---------------------------------------------------------------------------
# Config (env-style file; process environment overrides the file)
# ---------------------------------------------------------------------------
function Read-BridgeConfig {
  param([string]$Path)

  $raw = @{}
  if (Test-Path -LiteralPath $Path) {
    # Same parse semantics as pdm-bridge: KEY=value, optional quotes, # comments skipped.
    foreach ($line in Get-Content -LiteralPath $Path) {
      $m = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
      if (-not $m.Success) { continue }
      $val = $m.Groups[2].Value
      $q = [regex]::Match($val, "^([`"'])(.*)\1$")
      if ($q.Success) { $val = $q.Groups[2].Value }
      $raw[$m.Groups[1].Value] = $val
    }
  }

  # Environment overrides (never logged) - handy for one-off tests.
  $known = @(
    "BB_BRIDGE_MDB_UNC", "BB_BRIDGE_MDW_UNC",
    "BB_BRIDGE_ULS_USER", "BB_BRIDGE_ULS_PASSWORD",
    "BB_BRIDGE_PG_HOST", "BB_BRIDGE_PG_PORT", "BB_BRIDGE_PG_DB",
    "BB_BRIDGE_PG_USER", "BB_BRIDGE_PG_PASSWORD",
    "BB_BRIDGE_PSQL_EXE", "BB_BRIDGE_TEMP_DIR", "BB_BRIDGE_LOG_FILE"
  )
  foreach ($name in $known) {
    $envVal = [Environment]::GetEnvironmentVariable($name)
    if ($envVal) { $raw[$name] = $envVal }
  }

  if ($raw.Count -eq 0) {
    throw ("Konfiguracija nije nadjena: '$Path' ne postoji, a nijedna BB_BRIDGE_* promenljiva " +
      "nije u okruzenju. Uradi: copy bigbit-bridge.env.example bigbit-bridge.env pa popuni (vidi README.md).")
  }

  function Get-Req([hashtable]$h, [string]$name) {
    if (-not $h[$name]) { throw "Nedostaje obavezna promenljiva $name (vidi bigbit-bridge.env.example)." }
    return $h[$name]
  }
  function Get-Opt([hashtable]$h, [string]$name, [string]$default) {
    if ($h[$name]) { return $h[$name] }
    return $default
  }

  $tempDefault = Join-Path $env:TEMP "bigbit-bridge"
  $logDefault = Join-Path $ScriptDir "bigbit-bridge.log"

  $cfg = @{
    MdbUnc      = Get-Req $raw "BB_BRIDGE_MDB_UNC"
    MdwUnc      = Get-Req $raw "BB_BRIDGE_MDW_UNC"
    UlsUser     = Get-Req $raw "BB_BRIDGE_ULS_USER"
    UlsPassword = Get-Req $raw "BB_BRIDGE_ULS_PASSWORD"
    PgHost      = Get-Req $raw "BB_BRIDGE_PG_HOST"
    PgPort      = Get-Opt $raw "BB_BRIDGE_PG_PORT" "5432"
    PgDb        = Get-Opt $raw "BB_BRIDGE_PG_DB" "servosync"
    PgUser      = Get-Opt $raw "BB_BRIDGE_PG_USER" "bb_sync"
    PgPassword  = Get-Req $raw "BB_BRIDGE_PG_PASSWORD"
    PsqlExeRaw  = Get-Opt $raw "BB_BRIDGE_PSQL_EXE" ""
    TempDir     = Get-Opt $raw "BB_BRIDGE_TEMP_DIR" $tempDefault
    LogFile     = Get-Opt $raw "BB_BRIDGE_LOG_FILE" $logDefault
  }
  return $cfg
}

function Resolve-PsqlExe {
  param([string]$Configured)
  if ($Configured) {
    if (Test-Path -LiteralPath $Configured) { return (Resolve-Path -LiteralPath $Configured).Path }
    throw "BB_BRIDGE_PSQL_EXE pokazuje na nepostojecu putanju: $Configured"
  }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command psql -ErrorAction SilentlyContinue }
  if ($cmd) { return $cmd.Source }
  # Common install location of "PostgreSQL Command Line Tools" (newest version first).
  $guesses = @(Get-ChildItem -Path (Join-Path $env:ProgramFiles "PostgreSQL\*\bin\psql.exe") -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending)
  if ($guesses.Count -gt 0) { return $guesses[0].FullName }
  throw ("psql.exe nije nadjen ni na PATH-u ni u '$env:ProgramFiles\PostgreSQL\*\bin' - instaliraj " +
    "PostgreSQL client tools (vidi README.md) ili postavi BB_BRIDGE_PSQL_EXE.")
}

# ---------------------------------------------------------------------------
# psql wrapper - the ONLY write path to PG. Password goes through PGPASSWORD
# for the child process only (never on the command line, never in the log).
# ---------------------------------------------------------------------------
function Invoke-Psql {
  param([hashtable]$Cfg, [string[]]$Arguments)
  $baseArgs = @(
    "-h", $Cfg.PgHost, "-p", $Cfg.PgPort, "-d", $Cfg.PgDb, "-U", $Cfg.PgUser,
    "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"
  )
  $prevEap = $ErrorActionPreference
  $prevPw = $env:PGPASSWORD
  $prevEnc = $env:PGCLIENTENCODING
  $env:PGPASSWORD = $Cfg.PgPassword
  $env:PGCLIENTENCODING = "UTF8"
  try {
    # PS 5.1: native stderr under ErrorActionPreference=Stop + redirection throws
    # NativeCommandError - relax it just around the call and use LASTEXITCODE.
    $ErrorActionPreference = "Continue"
    $raw = & $Cfg.PsqlExe @baseArgs @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    $env:PGPASSWORD = $prevPw
    $env:PGCLIENTENCODING = $prevEnc
  }
  $text = ""
  if ($null -ne $raw) {
    $text = (@($raw | ForEach-Object { $_.ToString() }) -join "`n").Trim()
  }
  return @{ ExitCode = $code; Output = $text }
}

# ---------------------------------------------------------------------------
# Snapshot copy (UNC -> local temp). The original .mdb/.MDW are read-shared by
# the BigBit app; Copy-Item works against open Jet files. We copy the MDW too so
# even the workgroup file is never touched by our OLEDB session.
# ---------------------------------------------------------------------------
function Copy-Snapshot {
  param([hashtable]$Cfg, [string]$RunDir)
  $files = @(
    @{ Src = $Cfg.MdbUnc; Dest = (Join-Path $RunDir "bigbit-copy.mdb"); Label = "MDB" },
    @{ Src = $Cfg.MdwUnc; Dest = (Join-Path $RunDir "bigbit-copy.mdw"); Label = "MDW" }
  )
  foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f.Src)) {
      throw "$($f.Label) nedostupan na UNC putanji: $($f.Src) - proveri share i prava naloga koji pokrece task."
    }
  }
  foreach ($f in $files) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Copy-Item -LiteralPath $f.Src -Destination $f.Dest -Force
    $sw.Stop()
    $mb = [math]::Round(((Get-Item -LiteralPath $f.Dest).Length / 1MB), 1)
    Write-Log "INFO" ("Snapshot {0}: {1} -> {2} ({3} MB, {4:N1}s)" -f $f.Label, $f.Src, $f.Dest, $mb, $sw.Elapsed.TotalSeconds)
  }
  return @{ Mdb = $files[0].Dest; Mdw = $files[1].Dest }
}

# ---------------------------------------------------------------------------
# ACE OLEDB connection to the COPY (16.0 -> 12.0 fallback) + ULS read probe
# ---------------------------------------------------------------------------
function Open-BigBitConnection {
  param([hashtable]$Cfg, [string]$MdbPath, [string]$MdwPath)
  $providers = @("Microsoft.ACE.OLEDB.16.0", "Microsoft.ACE.OLEDB.12.0")
  foreach ($provider in $providers) {
    # Builder escapes special characters in values (password!) correctly.
    $b = New-Object System.Data.OleDb.OleDbConnectionStringBuilder
    $b["Provider"] = $provider
    $b["Data Source"] = $MdbPath
    $b["Jet OLEDB:System Database"] = $MdwPath
    $b["User ID"] = $Cfg.UlsUser
    $b["Password"] = $Cfg.UlsPassword
    $conn = New-Object System.Data.OleDb.OleDbConnection $b.ConnectionString
    try {
      $conn.Open()
      Write-Log "INFO" "ACE OLEDB provider: $provider (ULS nalog: $($Cfg.UlsUser))"
      return $conn
    } catch {
      $conn.Dispose()
      $msg = $_.Exception.Message
      if ($msg -match "not registered|nije registrovan") { continue }  # try the older provider
      if ($msg -match "valid account name|account name or password|lozink") {
        throw ("ULS login ODBIJEN za nalog '$($Cfg.UlsUser)': $msg " +
          "- proveri BB_BRIDGE_ULS_USER/BB_BRIDGE_ULS_PASSWORD. Aplikativni nalog je 'Slavisa' " +
          "(lozinka se nabavlja od Negovana); 'admin'/'telefon' NIJE upotrebljiv (nema READ pravo).")
      }
      throw "Otvaranje BigBit kopije nije uspelo ($provider): $msg"
    }
  }
  throw ("Nijedan ACE OLEDB provider nije registrovan (probano: $($providers -join ', ')). " +
    "Instaliraj 'Microsoft Access Database Engine 2016 Redistributable' x64 " +
    "(accessdatabaseengine_X64.exe) - vidi README.md. PowerShell proces je 64-bitni, " +
    "pa 32-bitni ACE NE pomaze.")
}

function Test-UlsRead {
  # Startup check required by design: the ULS account must have READ. Without it
  # the connection OPENS fine but every SELECT fails (Access error 3112) - so we
  # probe explicitly and fail with an actionable message instead of a per-table mess.
  param($Conn, [string]$Table, [string]$UlsUser)
  $cmd = $Conn.CreateCommand()
  $cmd.CommandText = "SELECT COUNT(*) FROM [$Table]"
  try {
    return [int]$cmd.ExecuteScalar()
  } catch {
    throw ("ULS READ provera PALA na tabeli '$Table': $($_.Exception.Message) " +
      "- nalog '$UlsUser' nema READ pravo u ULS workgroup-u (BIGBIT.MDW). " +
      "PAZNJA: 'admin' (lozinka 'telefon') NEMA read - koristi aplikativni nalog 'Slavisa' " +
      "(lozinku nabaviti od Negovana).")
  }
}

# ---------------------------------------------------------------------------
# Row extraction -> CSV (UTF-8 WITHOUT BOM: Access stores Unicode; a BOM would
# leak into the first field of the header line; \copy runs WITH ENCODING 'UTF8')
# ---------------------------------------------------------------------------
function Convert-CellValue {
  param($Raw, [hashtable]$Col)
  if ($null -eq $Raw -or $Raw -is [System.DBNull]) {
    if ($Col.ContainsKey("Default")) { return $Col.Default }
    return $null  # genuine SQL NULL (unquoted empty CSV field)
  }
  if ($Col.PgType -match "^(numeric|decimal|int|bigint|smallint|double|real)") {
    # Serbian locale writes decimals as "1,5" - PG needs invariant "1.5".
    return ([decimal]$Raw).ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Raw -is [datetime]) {
    return $Raw.ToString("yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Raw -is [bool]) {
    if ($Raw) { return "t" }
    return "f"
  }
  return [string]$Raw
}

function Write-TableCsv {
  param($Reader, [hashtable]$Map, [string]$CsvPath)
  $enc = New-Object System.Text.UTF8Encoding($false)
  $writer = New-Object System.IO.StreamWriter($CsvPath, $false, $enc)
  $rows = 0
  try {
    $names = @()
    foreach ($c in $Map.Columns) { $names += $c.Name }
    $writer.WriteLine(($names -join ","))  # HEADER true in \copy skips this line
    while ($Reader.Read()) {
      $cells = @()
      foreach ($c in $Map.Columns) {
        $v = Convert-CellValue -Raw $Reader[$c.Source] -Col $c
        if ($null -eq $v) {
          $cells += ""  # unquoted empty = NULL for COPY csv
        } else {
          $cells += ('"' + ([string]$v).Replace('"', '""') + '"')
        }
      }
      $writer.WriteLine(($cells -join ","))
      $rows++
    }
  } finally {
    $writer.Dispose()
  }
  return $rows
}

# ---------------------------------------------------------------------------
# Generated per-table psql script: staging \copy + UPSERT, one transaction.
# The trailing SELECT emits "staged|inserted|updated|missing_in_source" which
# the caller parses for the log. The IS DISTINCT FROM guard skips no-op updates
# (no row churn / table bloat on daily runs; "unchanged" = staged - ins - upd).
# ---------------------------------------------------------------------------
function New-UpsertSql {
  param([hashtable]$Map, [string]$CsvPath, [bool]$RollbackInsteadOfCommit)

  $colDefs = @()
  $colNames = @()
  foreach ($c in $Map.Columns) {
    $colDefs += ("{0} {1}" -f $c.Name, $c.PgType)
    $colNames += $c.Name
  }
  $keys = @($Map.KeyColumns)
  $nonKeys = @()
  foreach ($n in $colNames) { if ($keys -notcontains $n) { $nonKeys += $n } }

  if ($nonKeys.Count -gt 0) {
    $setList = @()
    $distinctLeft = @()
    $distinctRight = @()
    foreach ($n in $nonKeys) {
      $setList += ("{0} = EXCLUDED.{0}" -f $n)
      $distinctLeft += ("{0}.{1}" -f $Map.Target, $n)
      $distinctRight += ("EXCLUDED.{0}" -f $n)
    }
    $conflictClause = ("  ON CONFLICT ({0}) DO UPDATE SET {1}" -f ($keys -join ", "), ($setList -join ", ")) + "`r`n" +
      ("    WHERE ({0}) IS DISTINCT FROM ({1})" -f ($distinctLeft -join ", "), ($distinctRight -join ", "))
  } else {
    $conflictClause = ("  ON CONFLICT ({0}) DO NOTHING" -f ($keys -join ", "))
  }

  $keyJoin = @()
  foreach ($k in $keys) { $keyJoin += ("s.{0} = t.{0}" -f $k) }

  $csvPg = $CsvPath.Replace("\", "/")  # psql on Windows accepts forward slashes
  $finalStmt = "COMMIT;"
  if ($RollbackInsteadOfCommit) { $finalStmt = "ROLLBACK; -- dry-run" }

  $lines = @(
    "-- generated by bigbit-bridge.ps1 - do not edit",
    "BEGIN;",
    ("CREATE TEMP TABLE bb_stage ({0}) ON COMMIT DROP;" -f ($colDefs -join ", ")),
    ("\copy bb_stage FROM '{0}' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')" -f $csvPg),
    "WITH upserted AS (",
    ("  INSERT INTO {0} ({1})" -f $Map.Target, ($colNames -join ", ")),
    ("  SELECT {0} FROM bb_stage" -f ($colNames -join ", ")),
    $conflictClause,
    "  RETURNING (xmax = 0) AS was_insert",
    ")",
    "SELECT (SELECT count(*) FROM bb_stage) || '|' ||",
    "       count(*) FILTER (WHERE was_insert) || '|' ||",
    "       count(*) FILTER (WHERE NOT was_insert) || '|' ||",
    ("       (SELECT count(*) FROM {0} t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE {1}))" -f $Map.Target, ($keyJoin -join " AND ")),
    "FROM upserted;",
    $finalStmt
  )
  return (($lines -join "`r`n") + "`r`n")
}

function Sync-Table {
  param([hashtable]$Cfg, $Conn, [hashtable]$Map, [string]$RunDir, [bool]$IsDryRun)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $csvPath = Join-Path $RunDir ($Map.Target + ".csv")
  $sqlPath = Join-Path $RunDir ($Map.Target + ".sql")
  try {
    # 1. Read from the Access copy.
    $cmd = $Conn.CreateCommand()
    $cmd.CommandText = $Map.SelectSql
    $reader = $cmd.ExecuteReader()
    try {
      $rowsRead = Write-TableCsv -Reader $reader -Map $Map -CsvPath $csvPath
    } finally {
      $reader.Close()
    }
    if ($rowsRead -eq 0) {
      Write-Log "WARN" "$($Map.Source): izvor vratio 0 redova - sumnjivo za sifarnik; upsert svejedno ide (nista se ne brise)."
    }

    # 2. Stage + upsert through psql, one transaction.
    $sql = New-UpsertSql -Map $Map -CsvPath $csvPath -RollbackInsteadOfCommit:$IsDryRun
    [System.IO.File]::WriteAllText($sqlPath, $sql, (New-Object System.Text.UTF8Encoding($false)))
    $res = Invoke-Psql -Cfg $Cfg -Arguments @("-f", $sqlPath)
    if ($res.ExitCode -ne 0) {
      throw "psql exit $($res.ExitCode): $($res.Output)"
    }

    # 3. Parse the counters line (last matching line of psql output).
    $counts = $null
    foreach ($l in ($res.Output -split "`n")) {
      if ($l.Trim() -match '^(\d+)\|(\d+)\|(\d+)\|(\d+)$') {
        $counts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
      }
    }
    if ($null -eq $counts) {
      throw "psql je prosao, ali u izlazu nema brojaca (ocekivano 'staged|inserted|updated|missing'): '$($res.Output)'"
    }
    $staged = $counts[0]
    $inserted = $counts[1]
    $updated = $counts[2]
    $missing = $counts[3]
    $unchanged = $staged - $inserted - $updated
    if ($staged -ne $rowsRead) {
      Write-Log "WARN" "$($Map.Source): procitano $rowsRead a stage-ovano $staged - proveri CSV u $RunDir."
    }

    $sw.Stop()
    $tag = ""
    if ($IsDryRun) { $tag = " [DRY-RUN, ROLLBACK]" }
    Write-Log "INFO" ("{0} -> {1}: read={2} inserted={3} updated={4} unchanged={5} missing_in_source={6} ({7:N1}s){8}" -f `
      $Map.Source, $Map.Target, $rowsRead, $inserted, $updated, $unchanged, $missing, $sw.Elapsed.TotalSeconds, $tag)
    if ($missing -gt 0) {
      Write-Log "WARN" "$($Map.Target): $missing red(ova) postoji u PG a NEMA ih vise u BigBit izvoru - NIKAD se ne brisu automatski (odluka 7.3); proveri rucno."
    }
    return @{ Ok = $true; Read = $rowsRead; Inserted = $inserted; Updated = $updated }
  } catch {
    $sw.Stop()
    Write-Log "ERROR" "$($Map.Source) -> $($Map.Target): NEUSPEH ($($_.Exception.Message)) - transakcija po tabeli, nista nije delimicno upisano."
    return @{ Ok = $false; Read = 0; Inserted = 0; Updated = 0 }
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if (-not $ConfigFile) { $ConfigFile = Join-Path $ScriptDir "bigbit-bridge.env" }

try {
  $cfg = Read-BridgeConfig -Path $ConfigFile
  $cfg.PsqlExe = Resolve-PsqlExe -Configured $cfg.PsqlExeRaw
} catch {
  Write-Host "[KONFIGURACIJA] $($_.Exception.Message)" -ForegroundColor Red
  exit $EXIT_CONFIG
}

$script:LogFile = $cfg.LogFile
$runStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$modeTag = "upsert"
if ($DryRun) { $modeTag = "DRY-RUN" }
Write-Log "INFO" "=== BigBit bridge start - mod=$modeTag, pg=$($cfg.PgHost):$($cfg.PgPort)/$($cfg.PgDb) as $($cfg.PgUser), psql=$($cfg.PsqlExe) ==="

# Temp housekeeping: kept-on-failure run folders must not accumulate forever.
try {
  if (Test-Path -LiteralPath $cfg.TempDir) {
    $old = @(Get-ChildItem -LiteralPath $cfg.TempDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "run-*" -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) })
    foreach ($d in $old) {
      Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Write-Log "INFO" "Ociscen stari run folder: $($d.FullName)"
    }
  }
} catch { }

# PG reachability first - if PG is down, do not even copy the (potentially large) .mdb.
$pgProbe = Invoke-Psql -Cfg $cfg -Arguments @("-c", "SELECT 1")
if ($pgProbe.ExitCode -ne 0) {
  $pgMsg = ("PostgreSQL nedostupan ({0}:{1}/{2} kao {3}): {4} - proveri LAN izlaganje 5432 na ubuntusrv " +
    "(vidi README.md, jos NIJE izlozeno po defaultu) i bb_sync lozinku.") -f $cfg.PgHost, $cfg.PgPort, $cfg.PgDb, $cfg.PgUser, $pgProbe.Output
  Write-Log "ERROR" $pgMsg
  exit $EXIT_PG
}
Write-Log "INFO" "PostgreSQL dostupan (SELECT 1 OK)."

# Snapshot copy.
$runDir = Join-Path $cfg.TempDir ("run-" + $runStamp)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
try {
  $snap = Copy-Snapshot -Cfg $cfg -RunDir $runDir
} catch {
  Write-Log "ERROR" $_.Exception.Message
  exit $EXIT_SNAPSHOT
}

# Open the copy + mandatory ULS READ probe.
$conn = $null
try {
  $conn = Open-BigBitConnection -Cfg $cfg -MdbPath $snap.Mdb -MdwPath $snap.Mdw
  $probeCount = Test-UlsRead -Conn $conn -Table $TableMaps[0].Source -UlsUser $cfg.UlsUser
  Write-Log "INFO" "ULS READ provera OK ($($TableMaps[0].Source): $probeCount redova u snapshotu)."
} catch {
  Write-Log "ERROR" $_.Exception.Message
  if ($conn) { $conn.Dispose() }
  if ($_.Exception.Message -match "nije registrovan") { exit $EXIT_CONFIG }
  exit $EXIT_BIGBIT_READ
}

# Per-table sync (each in its own PG transaction; one failure does not stop the rest).
$maps = $TableMaps
if ($Only) {
  $maps = @($TableMaps | Where-Object { $_.Source -eq $Only -or $_.Target -eq $Only })
  if ($maps.Count -eq 0) {
    Write-Log "ERROR" "-Only '$Only' ne odgovara nijednoj mapi (Source/Target). Dostupno: $(($TableMaps | ForEach-Object { $_.Source }) -join ', ')."
    $conn.Dispose()
    exit $EXIT_CONFIG
  }
}

$okCount = 0
$failCount = 0
$totalRead = 0
$totalInserted = 0
$totalUpdated = 0
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($map in $maps) {
  $r = Sync-Table -Cfg $cfg -Conn $conn -Map $map -RunDir $runDir -IsDryRun:([bool]$DryRun)
  if ($r.Ok) {
    $okCount++
    $totalRead += $r.Read
    $totalInserted += $r.Inserted
    $totalUpdated += $r.Updated
  } else {
    $failCount++
  }
}

$conn.Dispose()
$swTotal.Stop()

# Temp cleanup: success removes the run folder; any failure keeps it for diagnostics.
if ($failCount -eq 0 -and -not $KeepTemp) {
  try {
    Remove-Item -LiteralPath $runDir -Recurse -Force
  } catch {
    Write-Log "WARN" "Ciscenje temp foldera nije uspelo ($($_.Exception.Message)): $runDir"
  }
} else {
  Write-Log "INFO" "Temp folder ZADRZAN (dijagnostika/KeepTemp): $runDir"
}

$tag = ""
if ($DryRun) { $tag = " [DRY-RUN - nista nije upisano]" }
Write-Log "INFO" ("REZIME: tabele OK={0} palo={1}, read={2} inserted={3} updated={4} ({5:N1}s){6}" -f `
  $okCount, $failCount, $totalRead, $totalInserted, $totalUpdated, $swTotal.Elapsed.TotalSeconds, $tag)

if ($failCount -gt 0) { exit $EXIT_TABLE_FAILED }
exit $EXIT_OK
