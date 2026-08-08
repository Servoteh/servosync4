/**
 * One-off data migration: sy15 (1.0) REVERSI + LOKACIJE -> 3.0 app-owned tabele.
 *
 * Korak 3 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje + runbook u
 * docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md. Obrazac: scripts/migrate-odrzavanje-sy15.ts.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI dok ne padne odluka. Podrazumevani režim je
 * --dry-run (ništa se ne piše). Skripta ČITA sy15 (samo SELECT) i PIŠE u onu bazu
 * na koju pokazuje DATABASE_URL — proveri gde pokazuje pre `--apply`.
 *
 * ── ZAŠTO SU DVA DOMENA U JEDNOJ SKRIPTI ────────────────────────────────────────
 * Izmereno 07.08.2026: `rev_issue_reversal` / `rev_confirm_return` u ISTOM COMMIT-u
 * pišu `rev_document_lines` I `loc_location_movements`. `rev_document_lines`
 * ima FK na `loc_location_movements` (40 + 1 popunjenih), `rev_documents` na
 * `loc_locations` (27/27), `rev_cutting_tool_stock` na `loc_locations`. Dve odvojene
 * skripte bi značile prozor u kome jedna strana šava postoji, a druga ne.
 *
 * ── ŠTA PRENOSI (21 tabela, FK redosledom — v. `TABLES`) ────────────────────────
 * loc: locations, location_movements (dva prolaza), item_placements,
 *      sync_outbound_events, sync_alerts_outbox, sync_worker_heartbeat,
 *      bigtehn_ingest_state
 * rev: inventory_groups -> subgroups -> subsubgroups, tools, cutting_tool_catalog,
 *      cutting_tool_stock, recipient_locations, documents -> document_lines ->
 *      document_cutting_assignees, machine_heads, tool_batteries, tool_service_log,
 *      tool_stock_ledger
 *
 * ── ŠTA NAMERNO NE PRENOSI ──────────────────────────────────────────────────────
 *  • `rev_api_idempotency`. Prefiks LAŽE: od 680 redova samo **2** su reversi
 *    (`reversi.issue`, `reversi.return`), **0** lokacije; ostalo je kadrovska (368),
 *    sastanci, PB, profil, održavanje. To je registar `Sy15Service.runIdempotent`,
 *    dakle infrastruktura CELE sy15 veze. Prenos bi domenima koji OSTAJU u sy15
 *    polomio idempotenciju (dupli klik na „odobri godišnji" = dva odobrenja).
 *  • `bigtehn_work_orders_cache` (40.758 redova). `max(synced_at)` = 2026-07-14 —
 *    mrtav snimak; 3.0 `work_orders` (41.173) ga zamenjuje, i pokriva TAČNO isti
 *    podskup ključeva (302/702, isti broj kao i mrtvi keš).
 *  • 51 RLS politika, 20 trigera, 59 funkcija, 16 `v_rev_*`/`v_loc_*` view-ova —
 *    to se prepisuje u NestJS (runbook §7).
 *
 * ── KLJUČNE ODLUKE PRESLIKAVANJA (izmerene) ─────────────────────────────────────
 *  • UUID PK-ovi se ZADRŽAVAJU 1:1 -> prenos je egzaktno idempotentan (upsert po
 *    ključu). Ponovno pokretanje ažurira u mestu, nikad ne duplira. Bez toga bi
 *    `client_event_uuid` idempotencija sa mobilne i unakrsne rev<->loc veze pukle.
 *  • Kolone koje su u sy15 gađale `auth.users` (uuid) -> 3.0 `users.id` (Int) po
 *    mejlu. Izmereno: domen koristi **13** naloga, **13/13** ima parnjaka u 3.0.
 *    Nerazrešeno -> NULL + prijava; kod NOT NULL kolona (`rev_documents.issued_by`,
 *    `loc_location_movements.moved_by`) -> BLOKADA, red se NE upisuje. Nema tihog
 *    podmetanja tuđeg naloga i nema tihog gubljenja reda.
 *  • `employees.id` (uuid) se prenosi DOSLOVNO kao meka veza bez FK — kadrovska je
 *    zamrznuta i `employees` ostaje u sy15 (20 referenciranih, 13/20 u
 *    `worker_employee_map`).
 *  • PG enumi su u 3.0 String + CHECK; vrednosti se prenose DOSLOVNO (isti skup).
 *  • SVE se čita kao `::text` i upisuje uz eksplicitan `::<tip>` cast. Time se
 *    izbegava JS zaokruživanje `numeric` i pomeranje `timestamptz` kroz `Date`.
 *
 * ── DVA PROLAZA ZA `loc_location_movements` ─────────────────────────────────────
 * `correction_of_movement_id` je FK NA SAMU SEBE. Prolaz 1 upisuje sve redove sa
 * `correction_of_movement_id = NULL`, prolaz 2 ga UPDATE-uje. Sortiranje po vremenu
 * bi „obično" bilo dovoljno, ali oslanjanje na redosled je klasa greške koja se ne
 * vidi dok ne pukne (v. memoriju „FOR UPDATE hvata samo postojeće redove").
 * Isto važi i za `loc_locations.parent_id` — tamo je prolaz uređen po `depth`.
 *
 * KONEKCIJE (iz backend/.env):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client, sirovi SELECT)
 *   - odrediste   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts            # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts --apply    # plan + upis
 *   ... --verify-only     # broj redova + otisak skupa kljuceva (izlazni kod 1 na neslaganje)
 *   ... --show-columns    # ispiši mapu kolona po tabeli i izađi (revizija mapiranja)
 *
 * `--apply` UVEK prvo izvede plan prolaz (cita, razresava identitet, NE pise). Ako iko
 * prijavi BLOKADU, upis se ne pokrece i odrediste ostaje netaknuto (izlazni kod 1).
 * Sve tri komande vracaju != 0 kad nesto ne valja — da runbook korak ne prodje tiho.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import { buildUserMaps, type UserMaps } from "./lib/sy15-identity";
import { keysetSql } from "./lib/keyset-checksum";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao migrate-odrzavanje-sy15.
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = resolve(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const APPLY = process.argv.includes("--apply");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const SHOW_COLUMNS = process.argv.includes("--show-columns");

/**
 * Koliko redova ide u jedan `INSERT … VALUES (…), (…)`.
 *
 * Nije podešavanje performansi nego POUZDANOSTI: red-po-red je 5.700 round-trip-ova,
 * a veza ka produkciji ide preko VPN-a koji ume da padne usred posla (P1017,
 * „Server has closed the connection" — dogodilo se 07.08. na 171. redu od 1.562).
 * Skripta je idempotentna, pa se posle pada samo ponovo pokrene; grupisanje smanjuje
 * prozor u kome pad uopšte može da se desi. 200 × ~30 kolona = ~6.000 parametara,
 * daleko ispod PostgreSQL granice od 65.535 po naredbi.
 */
const BATCH = 200;

// ---------------------------------------------------------------------------
// Izveštaj
// ---------------------------------------------------------------------------
interface StepReport {
  read: number;
  written: number;
  skipped: number;
  unresolved: Record<string, string[]>;
}
const report: Record<string, StepReport> = {};
const blockers: string[] = [];

/** Briše izveštaj i blokade između dva prolaza (plan → upis). */
function resetReport(): void {
  for (const k of Object.keys(report)) delete report[k];
  blockers.length = 0;
}

function step(name: string): StepReport {
  const s: StepReport = { read: 0, written: 0, skipped: 0, unresolved: {} };
  report[name] = s;
  return s;
}
function note(s: StepReport, category: string, key: string): void {
  (s.unresolved[category] ??= []).push(key);
}

// ---------------------------------------------------------------------------
// Mapa kolona
// ---------------------------------------------------------------------------

/** Kako se sy15 kolona pretvara u 3.0 kolonu. */
type Kind =
  /** Doslovno, uz `::<pg>` cast na odredištu. */
  | "copy"
  /** sy15 uuid `auth.users.id` -> 3.0 `users.id` (Int). NULL ako se ne razreši. */
  | "userNullable"
  /** Isto, ali kolona je NOT NULL — nerazrešeno je BLOKADA (red se preskače). */
  | "userRequired";

interface ColSpec {
  /** Ime kolone u sy15. */
  from: string;
  /** Ime kolone u 3.0 (podrazumevano isto). */
  to?: string;
  kind: Kind;
  /** PG tip za cast na odredištu (`text` kad nije naveden). */
  pg?: string;
}

function c(from: string, pg?: string, to?: string): ColSpec {
  return { from, to, kind: "copy", pg };
}
function u(from: string, to: string): ColSpec {
  return { from, to, kind: "userNullable", pg: "int4" };
}
function uReq(from: string, to: string): ColSpec {
  return { from, to, kind: "userRequired", pg: "int4" };
}

interface TableSpec {
  /** Tabela (isto ime u sy15 i u 3.0). */
  table: string;
  /** Kolone koje čine ključ za `ON CONFLICT`. */
  key: string[];
  cols: ColSpec[];
  /** `ORDER BY` na izvoru — bitno tamo gde tabela ima FK na samu sebe. */
  orderBy?: string;
  /**
   * Kolone koje se u prvom prolazu upisuju kao NULL, pa se u drugom prolazu
   * UPDATE-uju (FK na samu sebe).
   */
  deferred?: string[];
}

const TS = "timestamptz";

const TABLES: TableSpec[] = [
  // ── LOKACIJE ───────────────────────────────────────────────────────────────
  {
    // FK na samu sebe (`parent_id`) — zato `ORDER BY depth`: roditelj uvek pre deteta.
    table: "loc_locations",
    key: ["id"],
    orderBy: "depth ASC, created_at ASC",
    cols: [
      c("id", "uuid"),
      c("location_code"),
      c("name"),
      c("location_type"),
      c("parent_id", "uuid"),
      c("path_cached"),
      c("depth", "int2"),
      c("is_active", "bool"),
      c("capacity_note"),
      c("notes"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
      c("updated_at", TS),
      u("updated_by", "updated_by_user_id"),
    ],
  },
  {
    // FK na samu sebe (`correction_of_movement_id`) — dva prolaza, v. zaglavlje.
    table: "loc_location_movements",
    key: ["id"],
    orderBy: "created_at ASC",
    deferred: ["correction_of_movement_id"],
    cols: [
      c("id", "uuid"),
      c("item_ref_table"),
      c("item_ref_id"),
      c("from_location_id", "uuid"),
      c("to_location_id", "uuid"),
      c("movement_type"),
      c("movement_reason"),
      c("note"),
      c("moved_at", TS),
      uReq("moved_by", "moved_by_user_id"),
      u("approved_by", "approved_by_user_id"),
      c("approved_at", TS),
      c("correction_of_movement_id", "uuid"),
      c("sync_status"),
      c("created_at", TS),
      c("quantity", "numeric"),
      c("order_no"),
      c("drawing_no"),
      c("source"),
      c("client_event_uuid", "uuid"),
    ],
  },
  {
    table: "loc_item_placements",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("item_ref_table"),
      c("item_ref_id"),
      c("location_id", "uuid"),
      c("placement_status"),
      c("last_movement_id", "uuid"),
      c("placed_at", TS),
      u("placed_by", "placed_by_user_id"),
      c("notes"),
      c("updated_at", TS),
      c("quantity", "numeric"),
      c("order_no"),
      c("drawing_no"),
    ],
  },
  {
    table: "loc_sync_outbound_events",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("source_table"),
      c("source_record_id", "uuid"),
      c("target_procedure"),
      c("payload", "jsonb"),
      c("status"),
      c("attempts", "int2"),
      c("last_error"),
      c("locked_by_worker"),
      c("locked_at", TS),
      c("next_retry_at", TS),
      c("created_at", TS),
      c("synced_at", TS),
    ],
  },
  {
    table: "loc_sync_alerts_outbox",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("kind"),
      c("dedup_key"),
      c("recipient_email"),
      c("subject"),
      c("body_text"),
      c("payload", "jsonb"),
      c("status"),
      c("scheduled_at", TS),
      c("next_attempt_at", TS),
      c("last_attempt_at", TS),
      c("attempts", "int4"),
      c("max_attempts", "int4"),
      c("error"),
      c("created_at", TS),
      c("sent_at", TS),
    ],
  },
  {
    table: "loc_sync_worker_heartbeat",
    key: ["worker_id"],
    cols: [
      c("worker_id"),
      c("last_seen", TS),
      c("details", "jsonb"),
      c("created_at", TS),
    ],
  },
  {
    table: "loc_bigtehn_ingest_state",
    key: ["worker_id"],
    cols: [
      c("worker_id"),
      c("last_processed_signal_id", "int8"),
      c("armed", "bool"),
      c("last_run_at", TS),
      c("last_run_summary", "jsonb"),
      c("created_at", TS),
      c("updated_at", TS),
    ],
  },

  // ── REVERSI ────────────────────────────────────────────────────────────────
  {
    table: "rev_inventory_groups",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("code"),
      c("label"),
      c("applies_to"),
      c("display_order", "int4"),
      c("icon"),
      c("is_seeded", "bool"),
      c("napomena"),
      c("created_at", TS),
      c("updated_at", TS),
    ],
  },
  {
    table: "rev_inventory_subgroups",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("group_id", "uuid"),
      c("code"),
      c("label"),
      c("display_order", "int4"),
      c("is_seeded", "bool"),
      c("napomena"),
      c("created_at", TS),
      c("updated_at", TS),
    ],
  },
  {
    table: "rev_inventory_subsubgroups",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("subgroup_id", "uuid"),
      c("code"),
      c("label"),
      c("display_order", "int4"),
      c("is_seeded", "bool"),
      c("napomena"),
      c("created_at", TS),
      c("updated_at", TS),
    ],
  },
  {
    // `barcode` i `loc_item_ref_id` se prenose EKSPLICITNO — u sy15 ih kuju trigeri
    // (`rev_tools_set_barcode`, `rev_tools_set_item_ref`) kojih u 3.0 nema. Da se
    // prepuste podrazumevanoj vrednosti, veza sa Lokacijama (47/47) bi pukla.
    table: "rev_tools",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("oznaka"),
      c("naziv"),
      c("serijski_broj"),
      c("datum_kupovine", "date"),
      c("status"),
      c("napomena"),
      c("loc_item_ref_id"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
      c("updated_at", TS),
      c("bigtehn_sifra_artikla", "int4"),
      c("barcode"),
      c("subgroup_id", "uuid"),
      c("is_quantity", "bool"),
      c("total_qty", "int4"),
      c("is_consumable", "bool"),
      c("min_stock_qty", "int4"),
      c("max_stock_qty", "int4"),
      c("subsubgroup_id", "uuid"),
      c("garancija_do", "date"),
      c("garancija_napomena"),
      c("ima_punjac", "bool"),
      c("punjac_serijski"),
      c("otpis_datum", "date"),
      c("otpis_razlog"),
      u("otpis_by", "otpis_by_user_id"),
      c("nabavna_vrednost", "numeric"),
    ],
  },
  {
    table: "rev_cutting_tool_catalog",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("barcode"),
      c("oznaka"),
      c("naziv"),
      c("compatible_machine_codes", "text[]"),
      c("unit"),
      c("status"),
      c("napomena"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
      c("updated_at", TS),
      c("bigtehn_sifra_artikla", "int4"),
      c("min_stock_qty", "int4"),
      c("subgroup_id", "uuid"),
      c("max_stock_qty", "int4"),
    ],
  },
  {
    table: "rev_cutting_tool_stock",
    key: ["catalog_id", "location_id"],
    cols: [
      c("catalog_id", "uuid"),
      c("location_id", "uuid"),
      c("on_hand_qty", "numeric"),
      c("updated_at", TS),
    ],
  },
  {
    table: "rev_recipient_locations",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("recipient_type"),
      c("recipient_key"),
      c("recipient_label"),
      c("loc_location_id", "uuid"),
      c("created_at", TS),
    ],
  },
  {
    table: "rev_documents",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("doc_number"),
      c("doc_type"),
      c("recipient_type"),
      // Meki uuid ka sy15 `employees` — bez FK (kadrovska je zamrznuta).
      c("recipient_employee_id", "uuid"),
      c("recipient_employee_name"),
      c("recipient_department"),
      c("recipient_company_name"),
      c("recipient_company_pib"),
      c("recipient_loc_id", "uuid"),
      c("expected_return_date", "date"),
      c("issued_at", TS),
      uReq("issued_by", "issued_by_user_id"),
      c("status"),
      u("return_confirmed_by", "return_confirmed_by_user_id"),
      c("return_confirmed_at", TS),
      c("return_notes"),
      c("pdf_storage_path"),
      c("pdf_generated_at", TS),
      c("napomena"),
      c("created_at", TS),
      c("updated_at", TS),
      c("recipient_machine_code"),
      c("issued_to_employee_id", "uuid"),
      c("issued_to_employee_name"),
      c("bulk_import_legacy_key"),
    ],
  },
  {
    table: "rev_document_lines",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("document_id", "uuid"),
      c("sort_order", "int4"),
      c("line_type"),
      c("tool_id", "uuid"),
      c("drawing_no"),
      // U sy15 `work_order_id`; u 3.0 `work_order_ref_id` da se ne pomeša sa
      // pravim FK-om na `work_orders` (izmereno 0/42 popunjenih).
      c("work_order_id", "uuid", "work_order_ref_id"),
      c("part_name"),
      c("quantity", "numeric"),
      c("unit"),
      c("napomena"),
      c("issue_movement_id", "uuid"),
      c("returned_quantity", "numeric"),
      c("return_movement_id", "uuid"),
      c("line_status"),
      c("created_at", TS),
      c("cutting_tool_catalog_id", "uuid"),
    ],
  },
  {
    table: "rev_document_cutting_assignees",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("document_id", "uuid"),
      c("employee_id", "uuid"),
      c("role"),
      c("created_at", TS),
    ],
  },
  {
    table: "rev_machine_heads",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("machine_code"),
      c("oznaka"),
      c("naziv"),
      c("tip"),
      c("serijski_broj"),
      c("status"),
      c("napomena"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
      c("updated_at", TS),
    ],
  },
  {
    table: "rev_tool_batteries",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("tool_id", "uuid"),
      c("serijski_broj"),
      c("kapacitet"),
      c("datum_nabavke", "date"),
      c("status"),
      c("napomena"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
    ],
  },
  {
    table: "rev_tool_service_log",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("tool_id", "uuid"),
      c("datum", "date"),
      c("tip"),
      c("opis"),
      c("izvrsilac"),
      c("trosak", "numeric"),
      c("status"),
      c("napomena"),
      c("created_at", TS),
      u("created_by", "created_by_user_id"),
    ],
  },
  {
    table: "rev_tool_stock_ledger",
    key: ["id"],
    cols: [
      c("id", "uuid"),
      c("tool_id", "uuid"),
      c("delta", "int4"),
      c("reason"),
      c("balance_after", "int4"),
      c("ref_doc_id", "uuid"),
      c("ref_line_id", "uuid"),
      c("note"),
      u("created_by", "created_by_user_id"),
      c("created_at", TS),
    ],
  },
];

function targetName(col: ColSpec): string {
  return col.to ?? col.from;
}

// ---------------------------------------------------------------------------
// Prenos
// ---------------------------------------------------------------------------

type Row = Record<string, string | null>;

/** SELECT sa izvora — SVE kao `text`, da `numeric`/`timestamptz` ne prođu kroz JS tipove. */
function selectSql(spec: TableSpec): string {
  const cols = spec.cols
    .map((col) => `"${col.from}"::text AS "${col.from}"`)
    .join(", ");
  const order = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : "";
  return `SELECT ${cols} FROM public."${spec.table}"${order}`;
}

async function transferTable(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
  spec: TableSpec,
  maps: UserMaps,
  /**
   * `false` = plan prolaz (čita, razrešava identitet, skuplja BLOKADE, NE piše).
   * 🔴 Ovo NIJE isto što i `--dry-run` prekidač: pod `--apply` se plan prolaz izvodi
   * PRVI, i ako iko prijavi blokadu upis se uopšte ne pokreće (v. `main`). Ranije se
   * blokada otkrivala TOKOM pisanja, pa je blokiran `rev_documents` red obarao
   * sledeći batch na FK i ostavljao delimično popunjenu bazu.
   */
  write: boolean,
): Promise<void> {
  const s = step(spec.table);
  const rows = await sy15.$queryRawUnsafe<Row[]>(selectSql(spec));
  s.read = rows.length;

  const deferred = new Set(spec.deferred ?? []);
  // Prvi prolaz preskače odložene kolone; drugi ih UPDATE-uje.
  const insertCols = spec.cols.filter((col) => !deferred.has(col.from));
  const targets = insertCols.map(targetName);
  const updateSet = targets
    .filter((t) => !spec.key.includes(t))
    .map((t) => `"${t}" = EXCLUDED."${t}"`)
    .join(", ");
  const colList = targets.map((t) => `"${t}"`).join(", ");
  const conflict = spec.key.map((k) => `"${k}"`).join(", ");

  /** INSERT sa `n` grupa VALUES — jedan round-trip po grupi umesto po redu. */
  function insertSqlFor(n: number): string {
    const groups: string[] = [];
    for (let g = 0; g < n; g += 1) {
      const base = g * insertCols.length;
      groups.push(
        `(${insertCols
          .map((col, i) => `$${base + i + 1}::${col.pg ?? "text"}`)
          .join(", ")})`,
      );
    }
    return (
      `INSERT INTO "${spec.table}" (${colList}) VALUES ${groups.join(", ")} ` +
      `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSet}`
    );
  }

  const deferredRows: { key: string[]; values: (string | null)[] }[] = [];
  /** Nagomilani redovi tekuće grupe (v. `flush`). */
  let batch: (string | null)[][] = [];

  /**
   * 🔴 `loc_locations` ima FK na SAMU SEBE (`parent_id`), a redovi su sortirani po
   * `depth`. Roditelj i dete SMEJU biti u istoj grupi (Postgres proverava FK na
   * kraju naredbe), ali grupa NE SME preskočiti nivo — zato se grupiše redom,
   * nikad se ne preuređuje.
   */
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    if (write) {
      await prisma.$executeRawUnsafe(
        insertSqlFor(batch.length),
        ...batch.flat(),
      );
    }
    batch = [];
  }

  for (const row of rows) {
    const values: (string | null)[] = [];
    let blocked = false;

    for (const col of insertCols) {
      const raw = row[col.from] ?? null;
      if (col.kind === "copy") {
        values.push(raw);
        continue;
      }
      const uid =
        raw === null ? undefined : maps.byAuthUuid.get(raw.toLowerCase());
      if (uid === undefined) {
        if (col.kind === "userRequired") {
          // NOT NULL kolona: ne izmišljamo nalog i ne gubimo red u tišini.
          blockers.push(
            `${spec.table}.${col.from}: nerazrešen nalog ${raw ?? "NULL"} ` +
              `(red id=${row[spec.key[0]] ?? "?"}) — red NIJE upisan.`,
          );
          note(s, `nerazrešen ${col.from} (BLOKADA)`, raw ?? "NULL");
          blocked = true;
          break;
        }
        if (raw !== null) note(s, `nerazrešen ${col.from} -> NULL`, raw);
        values.push(null);
        continue;
      }
      values.push(String(uid));
    }

    if (blocked) {
      s.skipped += 1;
      continue;
    }

    batch.push(values);
    if (batch.length >= BATCH) await flush();
    s.written += 1;

    if (deferred.size > 0) {
      const hasDeferred = [...deferred].some((d) => (row[d] ?? null) !== null);
      if (hasDeferred) {
        deferredRows.push({
          key: spec.key.map((k) => row[k] ?? ""),
          values: [...deferred].map((d) => row[d] ?? null),
        });
      }
    }
  }
  await flush();

  // Drugi prolaz: odložene kolone (FK na samu sebe) — sada svi redovi postoje.
  if (deferredRows.length > 0) {
    const dcols = [...deferred];
    const dspecs = dcols.map(
      (d) => spec.cols.find((col) => col.from === d) as ColSpec,
    );
    const setSql = dcols
      .map((d, i) => `"${d}" = $${i + 1}::${dspecs[i].pg ?? "text"}`)
      .join(", ");
    const whereSql = spec.key
      .map((k, i) => {
        const kspec = spec.cols.find(
          (col) => targetName(col) === k || col.from === k,
        );
        return `"${k}" = $${dcols.length + i + 1}::${kspec?.pg ?? "text"}`;
      })
      .join(" AND ");
    const sql = `UPDATE "${spec.table}" SET ${setSql} WHERE ${whereSql}`;
    for (const d of deferredRows) {
      if (write) await prisma.$executeRawUnsafe(sql, ...d.values, ...d.key);
    }
    note(s, "drugi prolaz (FK na samu sebe)", String(deferredRows.length));
  }
}

// ---------------------------------------------------------------------------
// Provera
// ---------------------------------------------------------------------------
/**
 * 🔴 ZAŠTO BROJ REDOVA NIJE DOKAZ (protivnička provera 08.08.2026, NALAZ 4)
 *
 * Skripta je čist UPSERT — NIKAD ne briše. A `loc_item_placements` se u sy15 BRIŠE
 * kad količina padne na 0 (triger `loc_after_movement_insert`, runbook §4.3). Znači:
 * ako se između dva `--apply` desi jedno premeštanje (nestane red A, nastane red B),
 * 3.0 zadrži fantomski red A — i `count(*)` se SAVRŠENO POKLOPI, a baze se raziđu.
 *
 * Zato uz broj ide i otisak SKUPA KLJUČEVA — `keysetSql` (v. `scripts/lib/keyset-checksum.ts`,
 * izdvojen tamo da bi mogao da se testira; ovaj fajl je van `jest rootDir: src`).
 *
 * ⚠️ ŠTA OVO NE DOKAZUJE (namerno, da izveštaj ne obećava više nego što meri):
 * poklapanje SADRŽAJA neključnih kolona. Otisak preko svih kolona nije moguć jer se
 * kolone identiteta (`auth.users` uuid → `users.id` Int) po definiciji razlikuju
 * između baza. Sadržaj se i dalje dokazuje ciljanim zbirovima iz runbook-a §5.2
 * (`sum(quantity)`, `max(moved_at)`).
 */
async function verify(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
): Promise<number> {
  console.log("\n── PROVERA (broj redova + otisak skupa ključeva) ──");
  let mismatch = 0;
  for (const spec of TABLES) {
    const [src] = await sy15.$queryRawUnsafe<{ n: bigint; ck: string }[]>(
      keysetSql(spec, "public."),
    );
    let dstN = -1n;
    let dstCk = "";
    try {
      const [dst] = await prisma.$queryRawUnsafe<{ n: bigint; ck: string }[]>(
        keysetSql(spec, ""),
      );
      dstN = dst.n;
      dstCk = dst.ck;
    } catch {
      // tabela još ne postoji u 3.0 (migracija nije primenjena)
    }
    const brojOk = src.n === dstN;
    const otisakOk = brojOk && src.ck === dstCk;
    if (!otisakOk) mismatch += 1;
    // 🟠 = brojevi se poklapaju ALI ključevi ne — tačno onaj tihi slučaj zbog kog
    // otisak i postoji (fantomski red iz ranijeg `--apply`, koji je u sy15 obrisan).
    const znak = otisakOk ? "🟢" : brojOk ? "🟠" : "🔴";
    console.log(
      `  ${znak} ${spec.table.padEnd(32)} ${String(src.n).padStart(6)} -> ${
        dstN < 0n ? "(nema tabele)" : String(dstN).padStart(6)
      }${brojOk && !otisakOk ? "  ⚠️ ISTI BROJ, DRUGI KLJUČEVI (fantomski/nedostajući red)" : ""}`,
    );
  }

  // Šavovi rev <-> loc: ovo je razlog zbog kog domeni idu zajedno, pa se meri posebno.
  console.log("\n── ŠAVOVI rev <-> loc (moraju biti isti u obe baze) ──");
  const seams: { naziv: string; sql: string }[] = [
    {
      naziv: "rev_tools.loc_item_ref_id -> loc_item_placements",
      sql: `SELECT count(*)::bigint AS n FROM rev_tools t JOIN loc_item_placements p ON p.item_ref_table='rev_tools' AND p.item_ref_id=t.loc_item_ref_id`,
    },
    {
      naziv: "rev_document_lines.issue_movement_id -> loc_location_movements",
      sql: `SELECT count(*)::bigint AS n FROM rev_document_lines l JOIN loc_location_movements m ON m.id=l.issue_movement_id`,
    },
    {
      naziv: "rev_document_lines.return_movement_id -> loc_location_movements",
      sql: `SELECT count(*)::bigint AS n FROM rev_document_lines l JOIN loc_location_movements m ON m.id=l.return_movement_id`,
    },
    {
      naziv: "rev_documents.recipient_loc_id -> loc_locations",
      sql: `SELECT count(*)::bigint AS n FROM rev_documents d JOIN loc_locations l ON l.id=d.recipient_loc_id`,
    },
  ];
  for (const seam of seams) {
    const [src] = await sy15.$queryRawUnsafe<{ n: bigint }[]>(seam.sql);
    let dstN = -1n;
    try {
      const [dst] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(seam.sql);
      dstN = dst.n;
    } catch {
      /* tabele još ne postoje */
    }
    const ok = src.n === dstN;
    if (!ok) mismatch += 1;
    console.log(
      `  ${ok ? "🟢" : "🔴"} ${seam.naziv.padEnd(58)} ${String(src.n).padStart(4)} -> ${
        dstN < 0n ? "(nema)" : String(dstN).padStart(4)
      }`,
    );
  }

  console.log(
    mismatch === 0
      ? "\n🟢 Sve se poklapa (broj redova I skup ključeva)."
      : `\n🔴 ${mismatch} neslaganja — NE preklapati prekidač.`,
  );
  return mismatch;
}

// ---------------------------------------------------------------------------
function maskUrl(u: string | undefined): string {
  if (!u) return "(nije postavljen)";
  return u.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

function showColumns(): void {
  for (const spec of TABLES) {
    console.log(`\n${spec.table}  (ključ: ${spec.key.join(", ")})`);
    for (const col of spec.cols) {
      const kind =
        col.kind === "copy"
          ? ""
          : col.kind === "userRequired"
            ? "  [auth.users -> users.id, NOT NULL — nerazrešeno = BLOKADA]"
            : "  [auth.users -> users.id, NULL kad se ne razreši]";
      const tgt = targetName(col);
      const rename = tgt === col.from ? "" : ` -> ${tgt}`;
      console.log(`  ${col.from}${rename}  ::${col.pg ?? "text"}${kind}`);
    }
  }
}

function printReport(): void {
  console.log("\n── IZVEŠTAJ ──");
  for (const [table, s] of Object.entries(report)) {
    console.log(
      `  ${table.padEnd(32)} pročitano ${String(s.read).padStart(5)}  upisano ${String(
        s.written,
      ).padStart(5)}  preskočeno ${String(s.skipped).padStart(3)}`,
    );
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      const uniq = [...new Set(keys)];
      console.log(
        `      ${cat}: ${uniq.length} (${uniq.slice(0, 5).join(", ")}${uniq.length > 5 ? ", …" : ""})`,
      );
    }
  }
}

function printBlockers(): void {
  if (blockers.length === 0) {
    console.log("\n🟢 Nema blokada.");
    return;
  }
  console.log(
    `\n🔴 BLOKADE (${blockers.length}) — moraju se rešiti pre --apply:`,
  );
  for (const b of blockers.slice(0, 30)) console.log(`  • ${b}`);
  if (blockers.length > 30) console.log(`  … i još ${blockers.length - 30}`);
}

async function main(): Promise<void> {
  loadEnv();

  if (SHOW_COLUMNS) {
    showColumns();
    return;
  }

  if (!process.env.SY15_DATABASE_URL) {
    throw new Error("SY15_DATABASE_URL nije postavljen — nema izvora. Prekid.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nije postavljen — nema odredišta. Prekid.");
  }

  const prisma = new PrismaClient();
  const sy15 = new Sy15PrismaClient();

  console.log(`izvor  (sy15): ${maskUrl(process.env.SY15_DATABASE_URL)}`);
  console.log(`odredište    : ${maskUrl(process.env.DATABASE_URL)}`);
  console.log(
    APPLY
      ? "režim: --apply (PIŠE u odredište)"
      : "režim: dry-run (ništa se ne piše; za upis dodaj --apply)",
  );

  try {
    if (VERIFY_ONLY) {
      const mismatch = await verify(prisma, sy15);
      // Izlazni kod, ne samo tekst: runbook §6 korak 3/4 se izvodi iz skripte i
      // 🔴 ne sme da prođe neprimećeno ako operater ne gleda u ekran.
      if (mismatch > 0) process.exitCode = 1;
      return;
    }

    const maps = await buildUserMaps(prisma, sy15);
    console.log(
      `\nmapa identiteta: ${maps.byAuthUuid.size} sy15 naloga razrešeno u 3.0 ` +
        `users; ${maps.unmatchedAuthUuids.length} bez parnjaka.`,
    );

    // ── PLAN PROLAZ (uvek, i pod --apply) ────────────────────────────────────
    // Čita ceo izvor i razrešava identitet, ali NE PIŠE. Tek ako je čist, kreće upis.
    for (const spec of TABLES) {
      await transferTable(prisma, sy15, spec, maps, false);
    }

    printReport();
    printBlockers();

    if (!APPLY) {
      console.log(
        "\n(dry-run — pokreni sa --apply pa onda --verify-only za potvrdu brojeva)",
      );
      return;
    }

    // 🔴 ODBIJANJE UPISA UZ BLOKADE (protivnička provera 08.08.2026, NALAZ 4).
    // Blokiran red se ne upisuje, ali redovi koji na njega pokazuju obaraju sledeći
    // batch na FK — i baza ostaje delimično popunjena. Ranije se to otkrivalo TOKOM
    // pisanja; sada `--apply` ne dodirne odredište dok blokada postoji.
    if (blockers.length > 0) {
      console.log(
        `\n🔴 --apply ODBIJEN: ${blockers.length} blokada (nerazrešeni nalozi nad NOT NULL ` +
          `kolonama identiteta). Ništa nije upisano. Reši blokade pa pokreni ponovo.`,
      );
      process.exitCode = 1;
      return;
    }

    // ── UPIS ────────────────────────────────────────────────────────────────
    console.log("\n🟢 Plan prolaz bez blokada — kreće upis.");
    resetReport();
    for (const spec of TABLES) {
      await transferTable(prisma, sy15, spec, maps, true);
    }
    printReport();

    const mismatch = await verify(prisma, sy15);
    if (mismatch > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error("\nPAD:", e);
  process.exitCode = 1;
});
