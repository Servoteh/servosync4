import 'dotenv/config';

function reqStr(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`[config] Nedostaje obavezna env varijabla: ${name}`);
  }
  return String(v).trim();
}

function optStr(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v).trim();
}

function optInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function optBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/* Enable/disable grupa jobova po instanci. BigTehn mašina: sve true, SCADA
   false. SCADA (Win2019 VM u kotlarnici): ENABLE_JOB_CATALOGS=false,
   ENABLE_JOB_PRODUCTION=false, SCADA_ENABLED=true — ista codebase, dva .env-a. */
const jobsFlags = Object.freeze({
  catalogs: optBool('ENABLE_JOB_CATALOGS', true),
  production: optBool('ENABLE_JOB_PRODUCTION', true),
  /* Katze (evidencija radnog vremena, 192.168.64.10) — default false;
     uključiti samo na instanci koja vidi taj server. */
  katze: optBool('ENABLE_JOB_KATZE', false),
});

/* BigTehn SQL varijable su obavezne samo ako je bar jedan BigTehn job aktivan —
   na SCADA mašini nema SQL Servera pa ne smeju da obaraju startup. */
const bigtehnNeeded = jobsFlags.catalogs || jobsFlags.production;
const bigtehnStr = (name) => (bigtehnNeeded ? reqStr(name) : optStr(name, ''));

/* Katze SQL varijable obavezne samo ako je job uključen (isti obrazac).
   One-shot --job=katze radi i bez flaga ako su varijable prisutne. */
const katzeStr = (name) => (jobsFlags.katze ? reqStr(name) : optStr(name, ''));

export const config = Object.freeze({
  jobs: jobsFlags,
  bigtehn: Object.freeze({
    server: bigtehnStr('BIGTEHN_SQL_SERVER'),
    port: optInt('BIGTEHN_SQL_PORT', 1433),
    database: bigtehnStr('BIGTEHN_SQL_DATABASE'),
    user: bigtehnStr('BIGTEHN_SQL_USER'),
    password: bigtehnStr('BIGTEHN_SQL_PASSWORD'),
    encrypt: optBool('BIGTEHN_SQL_ENCRYPT', false),
    trustServerCertificate: optBool('BIGTEHN_SQL_TRUST_SERVER_CERTIFICATE', true),
    requestTimeout: optInt('BIGTEHN_SQL_REQUEST_TIMEOUT_MS', 60_000),
    connectionTimeout: optInt('BIGTEHN_SQL_CONNECTION_TIMEOUT_MS', 15_000),
    poolMin: optInt('BIGTEHN_SQL_POOL_MIN', 0),
    poolMax: optInt('BIGTEHN_SQL_POOL_MAX', 4),
  }),
  /* Katze (KatzeReports) — evidencija radnog vremena. Baza `Servoteh` je ŽIVA
     (KR7_Calc je kopija za proračun — ne čitati iz nje!). */
  katze: Object.freeze({
    server: katzeStr('KATZE_SQL_SERVER'),
    port: optInt('KATZE_SQL_PORT', 1433),
    database: optStr('KATZE_SQL_DATABASE', 'Servoteh'),
    user: katzeStr('KATZE_SQL_USER'),
    password: katzeStr('KATZE_SQL_PASSWORD'),
    encrypt: optBool('KATZE_SQL_ENCRYPT', false),
    trustServerCertificate: optBool('KATZE_SQL_TRUST_SERVER_CERTIFICATE', true),
    requestTimeout: optInt('KATZE_SQL_REQUEST_TIMEOUT_MS', 120_000),
    connectionTimeout: optInt('KATZE_SQL_CONNECTION_TIMEOUT_MS', 15_000),
    poolMin: optInt('KATZE_SQL_POOL_MIN', 0),
    poolMax: optInt('KATZE_SQL_POOL_MAX', 2),
  }),
  supabase: Object.freeze({
    url: reqStr('SUPABASE_URL').replace(/\/+$/, ''),
    serviceRoleKey: reqStr('SUPABASE_SERVICE_ROLE_KEY'),
  }),
  scheduler: Object.freeze({
    enabled: optBool('SCHEDULER_ENABLED', true),
    catalogsCron: optStr('SCHEDULE_CATALOGS_CRON', '0 6 * * *'),
    productionCron: optStr('SCHEDULE_PRODUCTION_CRON', '*/15 * * * *'),
    /* F.5a: BigTehn crteži — default jednom dnevno u 7:00 (30 min posle catalogs).
       Crteži se retko menjaju, nema potrebe za češćim sync-om. */
    drawingsCron: optStr('SCHEDULE_DRAWINGS_CRON', '0 7 * * *'),
    /* Katze prolazi — na 10 min (kolektor upisuje kontinuirano, prisustvo
       u Servosync-u treba da bude sveže). */
    katzeCron: optStr('SCHEDULE_KATZE_CRON', '*/10 * * * *'),
    timezone: optStr('TZ', 'Europe/Belgrade'),
  }),
  logger: Object.freeze({
    level: optStr('LOG_LEVEL', 'info'),
    dir: optStr('LOG_DIR', 'logs'),
    pretty: optBool('LOG_PRETTY', false),
  }),
  alerts: Object.freeze({
    telegramBotToken: optStr('ALERT_TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: optStr('ALERT_TELEGRAM_CHAT_ID', ''),
    webhookUrl: optStr('ALERT_WEBHOOK_URL', ''),
  }),
  instanceName: optStr('BRIDGE_INSTANCE_NAME', 'servoteh-bridge'),
  /* F.5a: Folder na BigBit serveru sa PDF crtežima (npr. C:\PDMExport\PDFImportovano).
     Ako je prazno, syncBigtehnDrawings job se preskoči (nije fail). */
  bigtehnDrawingsDir: optStr('BIGTEHN_DRAWINGS_DIR', ''),
  /* SCADA relay — čita lokalni HTTP API Scada_PLC aplikacije (ista mašina) i
     upisuje snapshot/istoriju/alarme u Supabase + izvršava scada_commands.
     Dizajn: docs/scada/energetika-scada-integration.md (repo plan-montaze). */
  scada: Object.freeze({
    enabled: optBool('SCADA_ENABLED', false),
    baseUrl: optStr('SCADA_BASE_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    snapshotMs: Math.max(2_000, optInt('SCADA_SNAPSHOT_MS', 5_000)),
    /* min 60 s: history ts se poravnava na minut (PK dedup), pa bi finiji
       interval samo prepisivao isti bucket bez efekta (nalaz N8) */
    historyMs: Math.max(60_000, optInt('SCADA_HISTORY_MS', 60_000)),
    cmdPollMs: Math.max(1_000, optInt('SCADA_CMD_POLL_MS', 2_000)),
    httpTimeoutMs: optInt('SCADA_HTTP_TIMEOUT_MS', 8_000),
    /* kill-switch: false trenutno zaustavlja IZVRŠAVANJE komandi (nadzor radi dalje) */
    control: optBool('SCADA_CONTROL', true),
    cmdRatePerMin: optInt('SCADA_CMD_RATE_PER_MIN', 10),
    /* Retencija istorije. POD `SCADA_IZVOR=3.0` OVO VIŠE NE RADI RELEJ nego 3.0
       scheduler (posao `scada-retention`, isti rok od 90 dana) — v. runbook §5.
       Vrednost ostaje ovde zbog sy15 putanje i povratka. */
    historyRetentionDays: optInt('SCADA_HISTORY_RETENTION_DAYS', 90),
    /* 🔴 PREKIDAČ IZVORA — gde relej UPISUJE scada_* podatke.
         sy15 (podrazumevano, i za svaku neprepoznatu vrednost) — PostgREST na
              `SUPABASE_URL`, tačno kao do sada.
         3.0                                                    — direktan Postgres
              upis u glavnu bazu (`SCADA_PG_URL`).
       Neprepoznata vrednost NIKAD ne sme da se protumači kao `3.0`: preklop u
       pogrešnom smeru razilazi dve baze i to se ne vidi dok se brojevi ne raziđu
       (isto pravilo kao `IzvorPrekidac` u backendu).
       Parnjak u backendu je `SCADA_IZVOR` (ScadaSourceService) — OBA moraju da se
       preklope, relej PRVI. Detalji: docs/SEOBA_SCADA_2026-08-07.md §4. */
    izvor: /^3\.0$/.test(optStr('SCADA_IZVOR', 'sy15')) ? '3.0' : 'sy15',
    /* Konekcija ka 3.0 bazi — obavezna SAMO kad je `SCADA_IZVOR=3.0` (v. niže).
       Bridge se ovde kači kao običan Postgres klijent; 3.0 nema PostgREST. */
    pgUrl: optStr('SCADA_PG_URL', ''),
    pgPoolMax: optInt('SCADA_PG_POOL_MAX', 4),
  }),
});

/* Kad je relej preklopljen na 3.0, konekcija MORA postojati — inače bi proces
   startovao „uspešno" i tek na prvom upisu počeo da baca greške, a snapshotovi bi
   tiho stajali (upravo stanje koje watchdog prijavljuje kao BRIDGE_STALE).
   Bolje pasti odmah, na startu, sa jasnim razlogom. */
if (config.scada.enabled && config.scada.izvor === '3.0' && !config.scada.pgUrl) {
  throw new Error(
    '[config] SCADA_IZVOR=3.0 zahteva SCADA_PG_URL (konekcija ka 3.0 bazi). ' +
      'Povratak: SCADA_IZVOR=sy15 + restart.',
  );
}

export function describeConfig() {
  return {
    instance: config.instanceName,
    bigtehn: {
      server: config.bigtehn.server,
      port: config.bigtehn.port,
      database: config.bigtehn.database,
      user: config.bigtehn.user,
      encrypt: config.bigtehn.encrypt,
    },
    supabase: {
      url: config.supabase.url,
      serviceKeyLen: config.supabase.serviceRoleKey.length,
    },
    scheduler: { ...config.scheduler },
    logger: { level: config.logger.level, dir: config.logger.dir, pretty: config.logger.pretty },
  };
}
