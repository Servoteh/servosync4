#!/usr/bin/env node
/**
 * ServoSync cutover verification report (P4 spec §7.3, runbook 17 step 4).
 *
 * Compares the QBigTehn chain tables between the legacy MSSQL and ServoSync
 * 2.0 Postgres AFTER the final force/full sync (runbook step 3):
 *
 *   A. COUNT + MAX(id) per chain table (legacy vs 2.0, 1:1 id policy)
 *   B. Derived drawing_handovers (tRN.IDPrimopredaje > 0 vs legacy_rn_id)
 *   C. MAX RN ordinal per project (IdentBroj tail after the last '/')
 *   D. Soft-FK orphans on the 2.0 side (batch-resolve chain)
 *   E. PDF blob counts (PDM_PDFCrtezi vs drawing_pdfs)
 *   F. Handover status distribution 0/1/2/3 (legacy vs derived)
 *
 * Output: Markdown to stdout — attach it to runbook step 4 (`node
 * cutover-verify.mjs > report.md`). Discrepancies in STRICT sections must be
 * resolved BEFORE continuing the cutover.
 *
 * NO NEW dependencies: reuses `mssql` and `@prisma/client` that the backend
 * already ships (run from a backend checkout after `npm ci` + `npx prisma
 * generate` — see README.md). Connection env matches the backend exactly:
 * `DATABASE_URL` + `BIGBIT_DB_*` (src/modules/sync/mssql.client.ts); a
 * `.env` next to backend/package.json is picked up as a fallback.
 *
 * Exit codes: 0 = parity, 1 = discrepancies in strict sections, 2 = run error.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Env (same fallback pattern as tools/pdm-bridge: never override real env)
// ---------------------------------------------------------------------------

function loadEnvFallback() {
  const envPath = path.join(BACKEND_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      line,
    );
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Chain table pairs: legacy source, legacy PK column, 2.0 table.
// Derived from sync-map.generated.ts (isId columns) + the §5.3 temporary
// syncers; cross-checked with QBIGTEHN_CHAIN_ENTITIES in
// src/modules/sync/table-ownership.ts. `info: true` = parity NOT expected
// (native 2.0 rows legitimately exist) — reported, never fails the run.
// ---------------------------------------------------------------------------

const CHAIN_TABLES = [
  // PDM
  { legacy: "PDMCrtezi", pk: "IDCrtez", pg: "drawings" },
  { legacy: "KomponentePDMCrteza", pk: "IDKomponenteCrteza", pg: "drawing_components" },
  { legacy: "SklopoviPDMCrteza", pk: "IDSklopoviCrteza", pg: "drawing_assemblies" },
  {
    legacy: "PDMXMLImportLog", pk: "IDLog", pg: "drawing_import_log",
    info: "nativni 2.0 intake piše sopstvene redove — paritet nije očekivan",
  },
  {
    legacy: "PDM_PDFCrtezi", pk: null, pg: "drawing_pdfs",
    info: "nativni PDF upload (upsert po broj+revizija) — 2.0 ≥ legacy; bez MAX(id), composite PK",
  },
  { legacy: "PDM_Planiranje", pk: "IDPlan", pg: "drawing_plans" },
  { legacy: "PDM_PlaniranjeStavke", pk: "IDPlanStavka", pg: "drawing_plan_items" },
  // nacrti / primopredaje (drawing_handovers je posebna sekcija B — derivacija)
  { legacy: "NacrtPrimopredaje", pk: "IDNacrtPrim", pg: "handover_drafts" },
  { legacy: "NacrtPrimopredajeStavke", pk: "IDNacrtStavka", pg: "handover_draft_items" },
  {
    legacy: "PrimopredajaPDFCrteza", pk: "ID", pg: "drawing_handover_pdfs",
    info: "očekivano prazna; ne-prazan izvor se NAMERNO ne uvozi (id-jevi nemapirljivi — vidi drawing-handover-pdf.syncer.ts)",
  },
  // radni nalozi
  { legacy: "tRN", pk: "IDRN", pg: "work_orders" },
  { legacy: "tStavkeRN", pk: "IDStavkeRN", pg: "work_order_operations" },
  { legacy: "tStavkeRNSlike", pk: "ID", pg: "work_order_operation_images" },
  { legacy: "tLansiranRN", pk: "IDLansiran", pg: "work_order_launches" },
  { legacy: "tSaglasanRN", pk: "IDSaglasan", pg: "work_order_approvals" },
  { legacy: "tPDM", pk: "IDStavkePDM", pg: "work_order_machined_parts" },
  { legacy: "tPLP", pk: "IDStavkePLP", pg: "work_order_blanks" },
  { legacy: "tPND", pk: "IDStavkePND", pg: "work_order_nonstandard_parts" },
  { legacy: "tRNKomponente", pk: "IDKomponente", pg: "work_order_components" },
  { legacy: "tRNNDKomponente", pk: "IDNDKomponente", pg: "work_order_item_components" },
  // tehnološki postupci
  { legacy: "tTehPostupak", pk: "IDPostupka", pg: "tech_processes" },
  { legacy: "tTehPostupakDokumentacija", pk: "ID", pg: "tech_process_documents" },
  // nalepnice / lokacije
  { legacy: "Nalepnice", pk: "ID", pg: "labels" },
  { legacy: "tLokacijeDelova", pk: "IDLokacije", pg: "part_locations" },
  // šifarnici (jednokratno seed-ovani — posle cutover-a ServoSync vlasništvo)
  { legacy: "tRadnici", pk: "SifraRadnika", pg: "workers" },
  { legacy: "tVrsteRadnika", pk: "IDVrsteRadnika", pg: "worker_types" },
  { legacy: "tOperacije", pk: "IDOperacije", pg: "operations" },
  { legacy: "tRadneJedinice", pk: "ID", pg: "work_units" },
  { legacy: "tPozicije", pk: "IDPozicije", pg: "positions" },
  { legacy: "tVrsteKvalitetaDelova", pk: "IDVrstaKvaliteta", pg: "part_quality_types" },
  { legacy: "tPristupMasini", pk: "IDPristupMasini", pg: "machine_access" },
  { legacy: "tR_Grupa", pk: "ID", pg: "production_item_groups" },
  { legacy: "T_Planer", pk: "ID", pg: "planner_entries" },
  { legacy: "T_PlanerGrupeUsera", pk: "ID", pg: "planner_user_groups" },
];

// Soft-FK orphan checks on the 2.0 side (legacy-read batch-resolve chain).
// `nonZero: true` — 0 is the legacy "none" sentinel, not a reference.
const ORPHAN_CHECKS = [
  { table: "work_orders", col: "project_id", ref: "projects", refCol: "id", nonZero: true },
  { table: "work_orders", col: "worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "work_orders", col: "handover_worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "work_orders", col: "drawing_id", ref: "drawings", refCol: "id", nonZero: true },
  { table: "work_orders", col: "drawing_handover_id", ref: "drawing_handovers", refCol: "id", nonZero: true },
  { table: "work_orders", col: "quality_type_id", ref: "part_quality_types", refCol: "id", nonZero: true },
  { table: "work_order_operations", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_operations", col: "worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "work_order_operations", col: "work_center_code", ref: "operations", refCol: "work_center_code", text: true },
  { table: "work_order_launches", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_approvals", col: "work_order_id", ref: "work_orders", refCol: "id" },
  // Meke reference radnika iz tSaglasanRN (SifraRadnikaUnos/Ispravka) — uvoze
  // se doslovno bez requireRef (vidi work-order-approval.syncer.ts), pa ih
  // report proverava kao soft-FK orfane.
  { table: "work_order_approvals", col: "created_by_worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "work_order_approvals", col: "updated_by_worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "work_order_machined_parts", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_blanks", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_nonstandard_parts", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_components", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_components", col: "component_work_order_id", ref: "work_orders", refCol: "id" },
  { table: "work_order_item_components", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "handover_drafts", col: "project_id", ref: "projects", refCol: "id", nonZero: true },
  { table: "handover_drafts", col: "designer_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "handover_draft_items", col: "draft_id", ref: "handover_drafts", refCol: "id" },
  { table: "handover_draft_items", col: "drawing_id", ref: "drawings", refCol: "id" },
  { table: "drawing_handovers", col: "drawing_id", ref: "drawings", refCol: "id" },
  { table: "drawing_handovers", col: "technologist_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "drawing_handovers", col: "handover_worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "drawing_components", col: "parent_drawing_id", ref: "drawings", refCol: "id" },
  { table: "drawing_components", col: "child_drawing_id", ref: "drawings", refCol: "id" },
  { table: "drawing_plan_items", col: "plan_id", ref: "drawing_plans", refCol: "id" },
  { table: "drawing_plan_items", col: "procurement_drawing_id", ref: "drawings", refCol: "id" },
  { table: "drawing_handover_pdfs", col: "handover_id", ref: "drawing_handovers", refCol: "id" },
  { table: "tech_processes", col: "worker_id", ref: "workers", refCol: "id", nonZero: true },
  { table: "labels", col: "work_order_id", ref: "work_orders", refCol: "id" },
  { table: "labels", col: "tech_process_id", ref: "tech_processes", refCol: "id" },
  { table: "part_locations", col: "work_order_id", ref: "work_orders", refCol: "id", nonZero: true },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const n = (v) => (v === null || v === undefined ? null : Number(v));
const fmt = (v) => (v === null || v === undefined ? "—" : String(v));

function mdTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(fmt).join(" | ")} |`),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnvFallback();

  if (!process.env.DATABASE_URL) {
    console.error("GREŠKA: DATABASE_URL nije postavljen (vidi README.md).");
    process.exit(2);
  }

  // Reuse the backend's own dependencies (no new installs).
  const sql = require("mssql");
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  // Same config shape as src/modules/sync/mssql.client.ts (read-only SELECTs).
  const pool = new sql.ConnectionPool({
    server: process.env.BIGBIT_DB_HOST ?? "localhost",
    port: Number(process.env.BIGBIT_DB_PORT) || 1433,
    database: process.env.BIGBIT_DB_NAME ?? "QBigTehn",
    user: process.env.BIGBIT_DB_USER,
    password: process.env.BIGBIT_DB_PASSWORD,
    requestTimeout: Number(process.env.BIGBIT_DB_REQUEST_TIMEOUT_MS) || 120000,
    connectionTimeout: 15000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: process.env.BIGBIT_DB_ENCRYPT === "true",
      trustServerCertificate: process.env.BIGBIT_DB_TRUST_SERVER_CERT !== "false",
    },
  });
  await pool.connect();

  const ms = async (text) => (await pool.request().query(text)).recordset;
  const pg = (text) => prisma.$queryRawUnsafe(text);

  let strictDiffs = 0;
  const out = [];
  out.push("# Cutover verifikacioni report (runbook 17, korak 4)");
  out.push("");
  out.push(`Generisano: ${new Date().toISOString()}`);
  out.push(`Legacy: ${process.env.BIGBIT_DB_HOST}:${process.env.BIGBIT_DB_PORT}/${process.env.BIGBIT_DB_NAME}`);
  out.push("");

  // --- A. COUNT + MAX(id) per chain table ---------------------------------
  const rowsA = [];
  for (const t of CHAIN_TABLES) {
    const [lRow] = await ms(
      t.pk
        ? `SELECT COUNT_BIG(*) AS cnt, MAX([${t.pk}]) AS max_id FROM [dbo].[${t.legacy}]`
        : `SELECT COUNT_BIG(*) AS cnt, NULL AS max_id FROM [dbo].[${t.legacy}]`,
    );
    const [pRow] = await pg(
      t.pk
        ? `SELECT COUNT(*)::bigint AS cnt, MAX(id) AS max_id FROM "${t.pg}"`
        : `SELECT COUNT(*)::bigint AS cnt, NULL::int AS max_id FROM "${t.pg}"`,
    );
    const lCnt = n(lRow.cnt);
    const pCnt = n(pRow.cnt);
    const lMax = n(lRow.max_id);
    const pMax = n(pRow.max_id);
    const countOk = lCnt === pCnt;
    const maxOk = t.pk ? lMax === pMax : true;
    let status;
    if (t.info) status = countOk && maxOk ? "OK (info)" : "INFO";
    else if (countOk && maxOk) status = "OK";
    else {
      status = "**DIFF**";
      strictDiffs++;
    }
    rowsA.push([
      `${t.legacy} → ${t.pg}`,
      lCnt, pCnt, countOk ? "=" : pCnt - lCnt,
      lMax, pMax, maxOk ? "=" : "≠",
      status + (t.info ? ` — ${t.info}` : ""),
    ]);
  }
  out.push("## A. COUNT + MAX(id) po tabeli lanca (legacy vs 2.0)");
  out.push("");
  out.push(mdTable(
    ["Tabela (legacy → 2.0)", "COUNT leg", "COUNT 2.0", "Δ", "MAX(id) leg", "MAX(id) 2.0", "Δ", "Status"],
    rowsA,
  ));
  out.push("");

  // --- B. Derived drawing_handovers ----------------------------------------
  const [bLeg] = await ms(
    "SELECT COUNT_BIG(*) AS cnt FROM [dbo].[tRN] WHERE [IDPrimopredaje] > 0",
  );
  const [bPg] = await pg(`
    SELECT COUNT(*) FILTER (WHERE legacy_rn_id IS NOT NULL) AS derived,
           COUNT(*) FILTER (WHERE legacy_rn_id IS NULL) AS native
    FROM "drawing_handovers"`);
  const bDerivedOk = n(bLeg.cnt) === n(bPg.derived);
  if (!bDerivedOk) strictDiffs++;
  out.push("## B. Derivirane primopredaje (tRN atributi → drawing_handovers)");
  out.push("");
  out.push(mdTable(
    ["Izvor", "Redova", "Status"],
    [
      ["tRN sa IDPrimopredaje > 0 (legacy)", n(bLeg.cnt), ""],
      ["drawing_handovers, legacy_rn_id IS NOT NULL (derivirano)", n(bPg.derived), bDerivedOk ? "OK" : "**DIFF**"],
      ["drawing_handovers, legacy_rn_id IS NULL (nativni redovi)", n(bPg.native), "info"],
    ],
  ));
  out.push("");
  out.push("> MAX(id) se za drawing_handovers NE poredi: derivirani redovi nose nativni autoincrement id (ključ je `legacy_rn_id`).");
  out.push("");

  // --- C. MAX RN ordinal per project ---------------------------------------
  // LEFT(tail, PATINDEX(...)-1) yields ONLY the leading digits (may be ''),
  // so a plain CAST is safe ('' casts to 0) — no TRY_CAST (SQL Server 2012+)
  // needed.
  const legOrd = await ms(`
    SELECT IDPredmet AS project_id,
           MAX(CAST(LEFT(tail, PATINDEX('%[^0-9]%', tail + 'X') - 1) AS int)) AS max_ordinal
    FROM (
      SELECT IDPredmet,
             CASE WHEN CHARINDEX('/', IdentBroj) > 0
                  THEN RIGHT(IdentBroj, CHARINDEX('/', REVERSE(IdentBroj)) - 1)
                  ELSE IdentBroj END AS tail
      FROM [dbo].[tRN]
    ) t
    GROUP BY IDPredmet`);
  const pgOrd = await pg(`
    SELECT project_id,
           MAX(COALESCE(NULLIF((regexp_match(split_part(ident_number, '/', -1), '^\\d+'))[1], '')::int, 0)) AS max_ordinal
    FROM "work_orders"
    GROUP BY project_id`);
  const legMap = new Map(legOrd.map((r) => [Number(r.project_id), n(r.max_ordinal) ?? 0]));
  const pgMap = new Map(pgOrd.map((r) => [Number(r.project_id), n(r.max_ordinal) ?? 0]));
  const ordDiffs = [];
  for (const [projectId, legMax] of legMap) {
    const pgMax = pgMap.get(projectId);
    if (pgMax !== legMax) ordDiffs.push([projectId, legMax, pgMax ?? "—"]);
  }
  for (const [projectId, pgMax] of pgMap) {
    if (!legMap.has(projectId)) ordDiffs.push([projectId, "—", pgMax]);
  }
  if (ordDiffs.length > 0) strictDiffs++;
  out.push("## C. MAX RN ordinal po predmetu (IdentBroj deo posle poslednjeg '/')");
  out.push("");
  out.push(`Predmeta sa RN: legacy ${legMap.size}, 2.0 ${pgMap.size}. Neslaganja: **${ordDiffs.length}**${ordDiffs.length ? "" : " — OK (nativna numeracija nastavlja legacy niz)"}.`);
  if (ordDiffs.length) {
    out.push("");
    out.push(mdTable(
      ["project_id", "MAX ordinal legacy", "MAX ordinal 2.0"],
      ordDiffs.slice(0, 30),
    ));
    if (ordDiffs.length > 30) out.push(`\n… i još ${ordDiffs.length - 30}.`);
  }
  out.push("");

  // --- D. Soft-FK orphans (2.0 side) ---------------------------------------
  const rowsD = [];
  for (const c of ORPHAN_CHECKS) {
    const guard = c.nonZero ? `t."${c.col}" <> ${c.text ? "''" : "0"} AND ` : "";
    const [row] = await pg(`
      SELECT COUNT(*)::bigint AS cnt
      FROM "${c.table}" t
      WHERE ${guard}t."${c.col}" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "${c.ref}" r WHERE r."${c.refCol}" = t."${c.col}")`);
    const cnt = n(row.cnt);
    if (cnt > 0) rowsD.push([`${c.table}.${c.col}`, `${c.ref}.${c.refCol}`, cnt]);
  }
  out.push("## D. Meki-FK orfani (2.0 strana, batch-resolve lanac)");
  out.push("");
  if (rowsD.length === 0) {
    out.push("Nema orfana. ✔");
  } else {
    out.push(mdTable(["Kolona", "Referencira", "Orfana"], rowsD));
    out.push("");
    out.push("> Orfani NE obaraju exit kod (legacy podaci ih istorijski imaju; read putanje ih batch-resolve tolerišu) — proceniti ručno pre nastavka.");
  }
  out.push("");

  // --- E. PDF blobs ---------------------------------------------------------
  const [eLeg] = await ms(
    "SELECT COUNT_BIG(*) AS total, SUM(CASE WHEN [PDFBinary] IS NOT NULL THEN 1 ELSE 0 END) AS with_blob FROM [dbo].[PDM_PDFCrtezi]",
  );
  const [ePg] = await pg(
    'SELECT COUNT(*)::bigint AS total, COUNT(pdf_binary)::bigint AS with_blob FROM "drawing_pdfs"',
  );
  const blobOk = n(eLeg.with_blob ?? 0) <= n(ePg.with_blob ?? 0);
  if (!blobOk) strictDiffs++;
  out.push("## E. PDF blobovi (PDM_PDFCrtezi vs drawing_pdfs)");
  out.push("");
  out.push(mdTable(
    ["", "Redova", "Sa blobom"],
    [
      ["legacy PDM_PDFCrtezi", n(eLeg.total), n(eLeg.with_blob ?? 0)],
      ["2.0 drawing_pdfs", n(ePg.total), n(ePg.with_blob ?? 0)],
    ],
  ));
  out.push("");
  out.push(
    blobOk
      ? "> 2.0 mora imati ≥ blobova od legacy-ja (nativni upload dodaje) — OK."
      : "> **DIFF**: 2.0 ima MANJE blobova od legacy-ja — finalni uvoz PDF-ova nije kompletan.",
  );
  out.push("");

  // --- F. Handover status distribution -------------------------------------
  const fLeg = await ms(
    "SELECT [IDStatusPrimopredaje] AS status, COUNT_BIG(*) AS cnt FROM [dbo].[tRN] WHERE [IDPrimopredaje] > 0 GROUP BY [IDStatusPrimopredaje]",
  );
  const fPg = await pg(
    'SELECT status_id AS status, COUNT(*)::bigint AS cnt FROM "drawing_handovers" WHERE legacy_rn_id IS NOT NULL GROUP BY status_id',
  );
  const fLegMap = new Map(fLeg.map((r) => [Number(r.status), n(r.cnt)]));
  const fPgMap = new Map(fPg.map((r) => [Number(r.status), n(r.cnt)]));
  const statuses = [...new Set([...fLegMap.keys(), ...fPgMap.keys()])].sort((a, b) => a - b);
  const STATUS_NAMES = { 0: "U obradi", 1: "Saglasan", 2: "Odbijeno", 3: "Lansiran" };
  const rowsF = [];
  let statusOk = true;
  for (const s of statuses) {
    const l = fLegMap.get(s) ?? 0;
    const p = fPgMap.get(s) ?? 0;
    if (l !== p) statusOk = false;
    rowsF.push([`${s} (${STATUS_NAMES[s] ?? "?"})`, l, p, l === p ? "OK" : "**DIFF**"]);
  }
  if (!statusOk) strictDiffs++;
  out.push("## F. Statusna distribucija primopredaja 0/1/2/3 (legacy vs derivirano)");
  out.push("");
  out.push(mdTable(["Status", "legacy (tRN)", "2.0 (derivirano)", "Δ"], rowsF));
  out.push("");

  // --- Summary --------------------------------------------------------------
  out.push("## Zaključak");
  out.push("");
  out.push(
    strictDiffs === 0
      ? "**PARITET 1:1** u svim striktnim sekcijama — nastaviti sa runbook korakom 5 (setval)."
      : `**${strictDiffs} striktnih odstupanja** — rešiti PRE nastavka cutover-a (runbook korak 4).`,
  );

  console.log(out.join("\n"));

  await prisma.$disconnect();
  await pool.close();
  // exitCode (not process.exit) — a hard exit can truncate piped stdout.
  process.exitCode = strictDiffs === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`GREŠKA: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
