#!/usr/bin/env node
/**
 * ServoSync PDM bridge — ships SolidWorks PDM exports (XML + PDF) from the legacy
 * network shares into ServoSync 2.0:
 *   XML → POST {API_BASE}/v1/pdm/import      (multipart: file, sourcePath)
 *   PDF → POST {API_BASE}/v1/pdm/pdf-import  (multipart: file, sourcePath)
 *
 * Single-shot process — scheduling is Windows Task Scheduler (see README.md),
 * NOT a resident service. Node >= 20.6, ZERO dependencies: built-in
 * fetch/FormData/Blob + node:fs / node:crypto / node:path.
 *
 * Modes (PDM_BRIDGE_MODE):
 *   passive (default) — NEVER moves or deletes files; the legacy 10-min scripts
 *     still own the folders. Duplicate sends are prevented by a local state file
 *     (see `loadState`). MANDATORY while the legacy pipeline is alive.
 *   active (cutover only) — after a definitive response the file is moved to
 *     Importovano/ (success) or Neuspelo/ (rejected), legacy PremestiXMLFile
 *     parity. Transient failures (network/5xx) are never moved — retried next run.
 *
 * Exit codes: 0 = OK, 1 = at least one file failed, 2 = login failed, 3 = bad config.
 * Usage: node --env-file=.env pdm-bridge.mjs   |   node pdm-bridge.mjs --smoke
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_TIMEOUT_MS = 120_000;
/** Backoff before transient retries (network error / HTTP 5xx): 1 try + up to 3 retries. */
const RETRY_BACKOFF_MS = [2_000, 8_000, 30_000];

class ConfigError extends Error {}
class AuthError extends Error {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Minimal .env fallback for runs started without `node --env-file=.env`
 * (Node < 20.6 flag missing, Task Scheduler without "Start in"…). Reads .env
 * NEXT TO THE SCRIPT and never overrides variables already in the environment.
 */
function loadEnvFallback() {
  const envPath = path.join(SCRIPT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

/** Relative state/log paths resolve against the script folder (Task Scheduler cwd is unreliable). */
function resolveFromScript(p) {
  return path.isAbsolute(p) ? p : path.resolve(SCRIPT_DIR, p);
}

function loadConfig() {
  const opt = (name, dflt = "") => {
    const v = (process.env[name] ?? "").trim();
    return v || dflt;
  };
  const req = (name) => {
    const v = opt(name);
    if (!v) throw new ConfigError(`Nedostaje obavezna env promenljiva ${name} (vidi .env.example)`);
    return v;
  };
  const num = (name, dflt) => {
    const raw = opt(name);
    if (!raw) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
      throw new ConfigError(`${name} mora biti nenegativan broj, dobijeno: "${raw}"`);
    return n;
  };

  const mode = opt("PDM_BRIDGE_MODE", "passive").toLowerCase();
  if (mode !== "passive" && mode !== "active")
    throw new ConfigError(`PDM_BRIDGE_MODE mora biti "passive" ili "active", dobijeno: "${mode}"`);

  const xmlDir = opt("PDM_BRIDGE_XML_DIR");
  const pdfDir = opt("PDM_BRIDGE_PDF_DIR");
  if (!xmlDir && !pdfDir)
    throw new ConfigError("Bar jedan od PDM_BRIDGE_XML_DIR / PDM_BRIDGE_PDF_DIR mora biti podešen");

  return {
    apiBase: req("PDM_BRIDGE_API_BASE").replace(/\/+$/, ""),
    email: req("PDM_BRIDGE_EMAIL"),
    password: req("PDM_BRIDGE_PASSWORD"),
    xmlDir,
    pdfDir,
    mode,
    // Overrides apply to the XML folder only (legacy F_PDM_XMLFolderImportovano/Neuspelo
    // parity); in active mode PDFs always go under {PDF_DIR}\Importovano|Neuspelo.
    importedDir: opt("PDM_BRIDGE_IMPORTED_DIR") || (xmlDir ? path.join(xmlDir, "Importovano") : ""),
    failedDir: opt("PDM_BRIDGE_FAILED_DIR") || (xmlDir ? path.join(xmlDir, "Neuspelo") : ""),
    minAgeS: num("PDM_BRIDGE_MIN_AGE_S", 30),
    maxBytes: num("PDM_BRIDGE_MAX_MB", 50) * 1024 * 1024,
    stateFile: resolveFromScript(opt("PDM_BRIDGE_STATE_FILE", "./pdm-bridge.state.json")),
    logFile: resolveFromScript(opt("PDM_BRIDGE_LOG_FILE", "./pdm-bridge.log")),
  };
}

/** Scan phases in the required order: XML first, then PDF. */
function phases(cfg) {
  const list = [];
  if (cfg.xmlDir)
    list.push({
      kind: "xml",
      dir: cfg.xmlDir,
      ext: ".xml",
      endpoint: "/v1/pdm/import",
      contentType: "application/xml",
      importedDir: cfg.importedDir,
      failedDir: cfg.failedDir,
    });
  if (cfg.pdfDir)
    list.push({
      kind: "pdf",
      dir: cfg.pdfDir,
      ext: ".pdf",
      endpoint: "/v1/pdm/pdf-import",
      contentType: "application/pdf",
      importedDir: path.join(cfg.pdfDir, "Importovano"),
      failedDir: path.join(cfg.pdfDir, "Neuspelo"),
    });
  return list;
}

// ---------------------------------------------------------------------------
// Logging (append to file + console mirror)
// ---------------------------------------------------------------------------

function createLogger(logFile) {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
    (level === "ERROR" ? console.error : console.log)(line);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        // Log file unwritable must never kill the run — console mirror remains.
      }
    }
  };
  return {
    info: (msg) => write("INFO", msg),
    warn: (msg) => write("WARN", msg),
    error: (msg) => write("ERROR", msg),
  };
}

// ---------------------------------------------------------------------------
// Local send-state (duplicate-send guard for passive mode; crash idempotency
// between send and move for active mode)
// ---------------------------------------------------------------------------

/**
 * Shape: { version: 1, files: { "<absolute file path>": {
 *   size, mtimeMs, sha256, sentAt, result: "success"|"skipped"|"failed",
 *   statusMessage, transient?: true } } }
 * `transient: true` marks an UNSETTLED failure (network/5xx) — the next run
 * retries it; settled results are never re-sent for unchanged content.
 */
function loadState(file, log) {
  try {
    if (!fs.existsSync(file)) return { version: 1, files: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object" || parsed.files === null)
      throw new Error("neispravan oblik");
    return parsed;
  } catch (err) {
    log.warn(
      `State fajl ${file} neupotrebljiv (${err.message}) — krećem sa praznim state-om ` +
        "(bezbedno: backend dedup-uje već uvezen sadržaj)",
    );
    return { version: 1, files: {} };
  }
}

/** Atomic save (tmp + rename) — called after EVERY file so a crash mid-run never re-sends. */
function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Drop entries whose file is gone (legacy script or active mode moved it away),
 * but ONLY under directories that scanned successfully this run — an offline
 * share must not wipe its half of the state.
 */
function pruneState(state, scannedDirs) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const dirs = new Set(scannedDirs.map(norm));
  let pruned = 0;
  for (const key of Object.keys(state.files)) {
    if (!dirs.has(norm(path.dirname(key)))) continue;
    if (!fs.existsSync(key)) {
      delete state.files[key];
      pruned++;
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function login(cfg, log) {
  log.info(`Login na ${cfg.apiBase} kao ${cfg.email}…`);
  let res;
  try {
    res = await fetch(`${cfg.apiBase}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.email, password: cfg.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthError(`Login nije uspeo — API nedostupan: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    throw new AuthError(`Login odbijen: ${msg}`);
  }
  const token = body?.accessToken ?? body?.data?.accessToken;
  if (!token) throw new AuthError("Login odgovor nema accessToken");
  return token;
}

/**
 * POST one file. Returns { result: "success"|"failed", transient, statusMessage }.
 *  - network error / 5xx → retried per RETRY_BACKOFF_MS, then a TRANSIENT failure
 *    (not settled in state → the next run retries it);
 *  - 401 → ONE re-login, then the request is repeated (does not consume a retry);
 *  - repeated 401 / 403 → AuthError aborts the WHOLE run (exit 2) WITHOUT
 *    settling the file: auth outcome is not a function of file content, so it
 *    must never bind to sha256 (a later permission fix must re-send everything);
 *  - other 4xx → definitive failure for this file, the run continues;
 *  - 2xx → data.success decides; success:false = business rejection, NO retry
 *    (the same content would fail again — a new re-export changes the hash).
 */
async function sendWithRetry(cfg, auth, phase, filePath, buf, log) {
  const fileName = path.basename(filePath);
  let transientTries = 0;
  let reloginDone = false;
  for (;;) {
    let res;
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: phase.contentType }), fileName);
      form.append("sourcePath", filePath);
      res = await fetch(`${cfg.apiBase}${phase.endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (transientTries < RETRY_BACKOFF_MS.length) {
        const wait = RETRY_BACKOFF_MS[transientTries++];
        log.warn(`${fileName}: mrežna greška (${err.message}) — novi pokušaj za ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      return {
        result: "failed",
        transient: true,
        statusMessage: `mrežna greška posle ${transientTries + 1} pokušaja: ${err.message}`,
      };
    }

    if (res.status === 401 && !reloginDone) {
      reloginDone = true;
      log.warn(`${fileName}: HTTP 401 — token istekao, ponovni login…`);
      auth.token = await login(cfg, log); // AuthError propagates → exit 2
      continue;
    }
    if (res.status >= 500) {
      if (transientTries < RETRY_BACKOFF_MS.length) {
        const wait = RETRY_BACKOFF_MS[transientTries++];
        log.warn(`${fileName}: HTTP ${res.status} — novi pokušaj za ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      return {
        result: "failed",
        transient: true,
        statusMessage: `HTTP ${res.status} posle ${transientTries + 1} pokušaja`,
      };
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body?.error?.message ?? body?.message ?? "";
      // Auth/authz (403; ili ponovljen 401 posle re-logina) NIJE svojstvo
      // sadržaja fajla — ne sme da se settle-uje uz sha256 (kasnija dodela
      // permisije ne bi ništa re-poslala). Prekid celog run-a → exit 2.
      if (res.status === 401 || res.status === 403)
        throw new AuthError(
          `HTTP ${res.status}${msg ? `: ${msg}` : ""} — servisni nalog nema pdm.import? Run prekinut, nijedan fajl nije settle-ovan.`,
        );
      // Ostali 4xx: definitivno za ovaj fajl — fail fast, run nastavlja.
      return { result: "failed", transient: false, statusMessage: `HTTP ${res.status}${msg ? `: ${msg}` : ""}` };
    }
    const data = body?.data ?? body ?? {};
    if (data.success === true) {
      return { result: "success", transient: false, statusMessage: String(data.statusMessage ?? "OK") };
    }
    return {
      result: "failed",
      transient: false,
      statusMessage: String(data.statusMessage ?? "import odbijen (success=false)"),
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-file pipeline
// ---------------------------------------------------------------------------

/** Oldest first — parents/older exports go in before newer ones, like the legacy script. */
function scanDir(dir, ext) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(ext))
    .map((d) => {
      const filePath = path.join(dir, d.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((f) => f.filePath);
}

/** A state entry that must never be re-sent for unchanged content. */
function isSettled(entry) {
  return (
    !!entry &&
    entry.transient !== true &&
    (entry.result === "success" || entry.result === "failed" || entry.result === "skipped")
  );
}

async function processFile(ctx, phase, filePath) {
  const { cfg, state, log, counters } = ctx;
  const fileName = path.basename(filePath);
  const st = fs.statSync(filePath);
  const prev = state.files[filePath];

  // Fast path: identical (size, mtime) footprint of a settled record → skip without reading.
  if (isSettled(prev) && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    counters.skipped++;
    if (cfg.mode === "active" && prev.result !== "skipped") {
      // Crash recovery: sent in an earlier run but the move did not happen — finish it now.
      moveProcessed(ctx, phase, filePath, prev.result);
    }
    return;
  }

  // Too fresh — the exporter may still be writing it; leave for the next run.
  const ageS = (Date.now() - st.mtimeMs) / 1000;
  if (ageS < cfg.minAgeS) {
    log.info(`${phase.kind} ${fileName}: mlađi od ${cfg.minAgeS}s (možda se još piše) — preskačem ovaj run`);
    counters.skipped++;
    return;
  }

  // Oversize guard — settled as "skipped" so it does not spam the log every run.
  if (st.size > cfg.maxBytes) {
    log.warn(
      `${phase.kind} ${fileName}: ${(st.size / 1024 / 1024).toFixed(1)} MB preko limita — ` +
        "trajno preskačem (po potrebi povećaj PDM_BRIDGE_MAX_MB i obriši state zapis)",
    );
    state.files[filePath] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: null,
      sentAt: new Date().toISOString(),
      result: "skipped",
      statusMessage: "preko limita PDM_BRIDGE_MAX_MB",
    };
    saveState(cfg.stateFile, state);
    counters.skipped++;
    return;
  }

  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  // Same content already settled (file merely touched / re-copied) → refresh the
  // footprint, do NOT resend. A business "failed" stays failed until a NEW
  // re-export actually changes the content hash.
  if (isSettled(prev) && prev.sha256 === sha256) {
    state.files[filePath] = { ...prev, size: st.size, mtimeMs: st.mtimeMs };
    saveState(cfg.stateFile, state);
    counters.skipped++;
    log.info(
      `${phase.kind} ${fileName}: isti sadržaj već ${prev.result === "success" ? "poslat" : "odbijen"} ` +
        `(${prev.sentAt}) — preskačem`,
    );
    if (cfg.mode === "active") moveProcessed(ctx, phase, filePath, prev.result);
    return;
  }

  const outcome = await ctx.send(phase, filePath, buf);
  state.files[filePath] = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256,
    sentAt: new Date().toISOString(),
    result: outcome.result,
    statusMessage: outcome.statusMessage,
    ...(outcome.transient ? { transient: true } : {}),
  };
  saveState(cfg.stateFile, state);

  if (outcome.result === "success") {
    counters.sent++;
    log.info(`${phase.kind} ${fileName}: OK — ${outcome.statusMessage}`);
  } else {
    counters.failed++;
    log.error(
      `${phase.kind} ${fileName}: NEUSPEH${outcome.transient ? " (privremen — sledeći run pokušava ponovo)" : ""} — ` +
        outcome.statusMessage,
    );
  }
  if (cfg.mode === "active" && !outcome.transient) {
    moveProcessed(ctx, phase, filePath, outcome.result);
  }
}

/**
 * Active mode only — legacy PremestiXMLFile parity: success → Importovano\,
 * definitive failure → Neuspelo\; name collision → `_yyyyMMdd_HHmmss` suffix.
 */
function moveProcessed(ctx, phase, filePath, result) {
  const { log } = ctx;
  const destDir = result === "success" ? phase.importedDir : phase.failedDir;
  const fileName = path.basename(filePath);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    let dest = path.join(destDir, fileName);
    if (fs.existsSync(dest)) {
      const ext = path.extname(fileName);
      const base = ext ? fileName.slice(0, -ext.length) : fileName;
      dest = path.join(destDir, `${base}_${timestampSuffix()}${ext}`);
    }
    try {
      fs.renameSync(filePath, dest);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      fs.copyFileSync(filePath, dest); // cross-volume fallback
      fs.unlinkSync(filePath);
    }
    log.info(`${phase.kind} ${fileName} → premešten u ${dest}`);
  } catch (err) {
    // File stays put; the state entry keeps idempotency, next run re-attempts the move.
    log.warn(`${phase.kind} ${fileName}: premeštanje nije uspelo (${err.message}) — fajl ostaje na mestu`);
  }
}

function timestampSuffix(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(cfg, log, send) {
  const startedAt = Date.now();
  const state = loadState(cfg.stateFile, log);
  const counters = { found: 0, sent: 0, skipped: 0, failed: 0 };
  const ctx = { cfg, state, log, counters, send };
  const scannedDirs = [];

  for (const phase of phases(cfg)) {
    let files;
    try {
      files = scanDir(phase.dir, phase.ext);
    } catch (err) {
      log.error(`${phase.kind}: folder nedostupan (${phase.dir}): ${err.message}`);
      counters.failed++;
      continue;
    }
    scannedDirs.push(phase.dir);
    log.info(`${phase.kind}: ${files.length} fajlova u ${phase.dir}`);
    counters.found += files.length;

    for (const filePath of files) {
      try {
        await processFile(ctx, phase, filePath);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err?.code === "ENOENT") {
          // Normal in passive mode: the legacy 10-min script moved it between scan and send.
          log.info(`${path.basename(filePath)}: nestao tokom run-a (legacy skripta ga premestila?) — preskačem`);
          counters.skipped++;
        } else {
          log.error(`${path.basename(filePath)}: neočekivana greška: ${err.message}`);
          counters.failed++;
        }
      }
    }
  }

  const pruned = pruneState(state, scannedDirs);
  if (pruned > 0) {
    saveState(cfg.stateFile, state);
    log.info(`State: očišćeno ${pruned} zapisa za fajlove koji više ne postoje`);
  }
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.info(
    `REZIME: nađeno=${counters.found} poslato=${counters.sent} ` +
      `preskočeno=${counters.skipped} palo=${counters.failed} (${elapsedS}s)`,
  );
  return counters;
}

async function main() {
  loadEnvFallback();
  const cfg = loadConfig();
  const log = createLogger(cfg.logFile);
  log.info(`=== PDM bridge start — mod=${cfg.mode}, api=${cfg.apiBase} ===`);
  try {
    const auth = { token: await login(cfg, log) };
    const send = (phase, filePath, buf) => sendWithRetry(cfg, auth, phase, filePath, buf, log);
    const counters = await run(cfg, log, send);
    return counters.failed > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof AuthError) {
      log.error(err.message);
      return 2; // visible in Task Scheduler "Last Run Result" (0x2)
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Smoke test (`npm run smoke` / `node pdm-bridge.mjs --smoke`) — dry-run over a
// generated fixture folder, fake transport, no network, no DB, no .env needed.
// ---------------------------------------------------------------------------

async function smoke() {
  console.log("PDM bridge smoke test (dry-run, bez mreže i baze)\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdm-bridge-smoke-"));
  const xmlDir = path.join(root, "XML");
  const pdfDir = path.join(root, "PDF");
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.mkdirSync(pdfDir, { recursive: true });

  // Fixture modeled on the real export (§2.8): UTF-8 without XML declaration,
  // <xml><transactions> root, attribute names with spaces, non-numeric ids.
  const sampleXml = (id) =>
    `<xml><transactions><transaction date="1783676510" type="wf_export_document_attributes" ` +
    `vaultname="Servoteh"><document id="${id}" idattribute="Number"><configuration name="Default" ` +
    `quantity="1"><attribute name="Revision" value="B"/><attribute name="State" value="ODOBRENO"/>` +
    `<attribute name="Approved by" value="Igor Voštić"/></configuration></document></transaction>` +
    `</transactions></xml>`;
  // Write + backdate: NTFS sub-ms mtimes can land "after" Date.now() and trip the
  // min-age guard nondeterministically — fixtures always pretend to be 60s old.
  const writeFixture = (filePath, content, ageMs = 60_000) => {
    fs.writeFileSync(filePath, content);
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, stamp, stamp);
  };
  writeFixture(path.join(xmlDir, "1126982_B.xml"), sampleXml("1126982"));
  writeFixture(path.join(xmlDir, "K00693_A.xml"), sampleXml("K00693"));
  writeFixture(path.join(xmlDir, "odbijen.xml"), sampleXml("REJECT-ME"));
  writeFixture(path.join(pdfDir, "1126982_B.pdf"), "%PDF-1.4\n% smoke fixture\n%%EOF\n");

  const cfg = {
    apiBase: "http://smoke.invalid/api",
    email: "smoke",
    password: "smoke",
    xmlDir,
    pdfDir,
    mode: "passive",
    importedDir: path.join(xmlDir, "Importovano"),
    failedDir: path.join(xmlDir, "Neuspelo"),
    minAgeS: 0,
    maxBytes: 50 * 1024 * 1024,
    stateFile: path.join(root, "state.json"),
    logFile: path.join(root, "smoke.log"),
  };
  const log = createLogger(cfg.logFile);

  const sentNames = [];
  const fakeSend = async (_phase, filePath) => {
    const name = path.basename(filePath);
    sentNames.push(name);
    return name.startsWith("odbijen")
      ? { result: "failed", transient: false, statusMessage: "simulirana poslovna validacija (success=false)" }
      : { result: "success", transient: false, statusMessage: "simuliran uvoz" };
  };

  const failures = [];
  let checksTotal = 0;
  const check = (cond, msg) => {
    checksTotal++;
    console.log(`  ${cond ? "OK  " : "FAIL"} ${msg}`);
    if (!cond) failures.push(msg);
  };

  // Pass 1: everything is sent (3 XML + 1 PDF); business rejection lands as failed.
  let c = await run(cfg, log, fakeSend);
  check(sentNames.length === 4, `1. prolaz šalje sva 4 fajla (poslato zahteva: ${sentNames.length})`);
  check(c.sent === 3 && c.failed === 1, `1. prolaz: poslato=3 palo=1 (dobijeno: poslato=${c.sent} palo=${c.failed})`);

  // Pass 2: state fast-path skips everything — including the rejected file (no retry of same content).
  sentNames.length = 0;
  c = await run(cfg, log, fakeSend);
  check(sentNames.length === 0, `2. prolaz ne šalje ništa (fast-path; poslato zahteva: ${sentNames.length})`);
  check(
    c.skipped === 4 && c.failed === 0,
    `2. prolaz: preskočeno=4 palo=0 (dobijeno: preskočeno=${c.skipped} palo=${c.failed})`,
  );

  // Pass 3: touch without content change → sha256 match keeps it skipped.
  // (Past timestamp — a future mtime would hit the min-age guard instead of the hash path.)
  const touched = path.join(xmlDir, "1126982_B.xml");
  const past = new Date(Date.now() - 45_000);
  fs.utimesSync(touched, past, past);
  sentNames.length = 0;
  await run(cfg, log, fakeSend);
  check(sentNames.length === 0, "3. prolaz: touch bez izmene sadržaja se NE šalje (sha256 match)");

  // Pass 4: changed content (new re-export) → exactly that file is resent.
  writeFixture(touched, sampleXml("1126982-REV-C"), 30_000);
  sentNames.length = 0;
  await run(cfg, log, fakeSend);
  check(
    sentNames.length === 1 && sentNames[0] === "1126982_B.xml",
    `4. prolaz: izmenjen sadržaj se šalje ponovo (poslato: ${sentNames.join(", ") || "ništa"})`,
  );

  // Pass 5: active mode — success → Importovano/, rejection → Neuspelo/.
  const xmlDirActive = path.join(root, "XML-active");
  fs.mkdirSync(xmlDirActive);
  writeFixture(path.join(xmlDirActive, "ok.xml"), sampleXml("OK-1"));
  writeFixture(path.join(xmlDirActive, "odbijen.xml"), sampleXml("REJECT-ME"));
  const cfgActive = {
    ...cfg,
    mode: "active",
    xmlDir: xmlDirActive,
    pdfDir: "",
    importedDir: path.join(xmlDirActive, "Importovano"),
    failedDir: path.join(xmlDirActive, "Neuspelo"),
    stateFile: path.join(root, "state-active.json"),
  };
  sentNames.length = 0;
  await run(cfgActive, log, fakeSend);
  check(
    fs.existsSync(path.join(xmlDirActive, "Importovano", "ok.xml")),
    "5. prolaz (active): uspešan fajl premešten u Importovano/",
  );
  check(
    fs.existsSync(path.join(xmlDirActive, "Neuspelo", "odbijen.xml")),
    "5. prolaz (active): odbijen fajl premešten u Neuspelo/",
  );

  // Pass 6: auth/authz tok — 403 (nalog bez pdm.import) prekida CEO run kao
  // AuthError (exit 2) i NE settle-uje nijedan fajl u state (kasnija dodela
  // permisije mora sve ponovo da pošalje).
  const xmlDirAuth = path.join(root, "XML-auth");
  fs.mkdirSync(xmlDirAuth);
  writeFixture(path.join(xmlDirAuth, "bez-permisije.xml"), sampleXml("AUTH-1"));
  const cfgAuth = {
    ...cfg,
    xmlDir: xmlDirAuth,
    pdfDir: "",
    importedDir: path.join(xmlDirAuth, "Importovano"),
    failedDir: path.join(xmlDirAuth, "Neuspelo"),
    stateFile: path.join(root, "state-auth.json"),
  };
  let authThrown = null;
  try {
    await run(cfgAuth, log, async () => {
      throw new AuthError("HTTP 403: Forbidden");
    });
  } catch (err) {
    authThrown = err;
  }
  check(authThrown instanceof AuthError, "6. prolaz: 403 prekida run kao AuthError (exit 2)");
  const authState = fs.existsSync(cfgAuth.stateFile)
    ? JSON.parse(fs.readFileSync(cfgAuth.stateFile, "utf8"))
    : { files: {} };
  check(
    Object.keys(authState.files).length === 0,
    "6. prolaz: 403 NE settle-uje fajl u state (ponovo se šalje kad permisija stigne)",
  );

  // Pass 7: sendWithRetry nad STVARNIM oblicima odgovora (fetch stub, bez mreže).
  const realFetch = globalThis.fetch;
  const jsonRes = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  const pdfPhase = phases(cfg).find((p) => p.kind === "pdf");
  try {
    // Stvarni PDF 2xx odgovor backenda (pdm-import.service.importPdf) — success flag je ugovor.
    globalThis.fetch = async () =>
      jsonRes(201, {
        data: {
          importId: 7,
          fileName: "1126982_B.pdf",
          success: true,
          statusMessage: "PDF: 1126982 rev B, 3 KB",
          drawingNumber: "1126982",
          revision: "B",
          sizeKb: 3,
          replaced: false,
          drawingExists: true,
        },
      });
    const okOutcome = await sendWithRetry(
      cfg,
      { token: "smoke" },
      pdfPhase,
      path.join(pdfDir, "1126982_B.pdf"),
      Buffer.from("%PDF-1.4"),
      log,
    );
    check(
      okOutcome.result === "success" && okOutcome.statusMessage.startsWith("PDF:"),
      `7. prolaz: PDF 2xx sa success:true → success (dobijeno: ${okOutcome.result})`,
    );

    globalThis.fetch = async () => jsonRes(403, { error: { message: "Forbidden" } });
    let auth403 = null;
    try {
      await sendWithRetry(
        cfg,
        { token: "smoke" },
        pdfPhase,
        path.join(pdfDir, "1126982_B.pdf"),
        Buffer.from("%PDF-1.4"),
        log,
      );
    } catch (err) {
      auth403 = err;
    }
    check(auth403 instanceof AuthError, "7. prolaz: HTTP 403 iz sendWithRetry → AuthError");
  } finally {
    globalThis.fetch = realFetch;
  }

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`\nSMOKE: PALO ${failures.length}/${checksTotal} provera.`);
    return 1;
  }
  console.log(`\nSMOKE: svih ${checksTotal} provera prošlo.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "ServoSync PDM bridge\n" +
      "  node --env-file=.env pdm-bridge.mjs   pokreni jedan run (vidi README.md)\n" +
      "  node pdm-bridge.mjs --smoke           samotest bez mreže/baze\n" +
      "Exit kodovi: 0 = OK, 1 = bar jedan fajl pao, 2 = login neuspešan, 3 = konfiguracija neispravna",
  );
  process.exit(0);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`Node ${process.versions.node} je prestar — potreban je Node >= 20.6 (preporuka: 22 LTS).`);
  process.exit(3);
}

try {
  process.exitCode = argv.includes("--smoke") ? await smoke() : await main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`KONFIGURACIJA: ${err.message}`);
    process.exitCode = 3;
  } else if (err instanceof AuthError) {
    console.error(`LOGIN: ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
