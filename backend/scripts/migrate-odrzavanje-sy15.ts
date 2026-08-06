/**
 * One-off data migration: sy15 (1.0) ODRŽAVANJE (CMMS) -> 3.0 app-owned tabele.
 *
 * Korak 2 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje + runbook u
 * docs/SEOBA_ODRZAVANJA_2026-08-06.md. Obrazac: scripts/migrate-sastanci-pb-sy15.ts.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI dok ne padne odluka. Podrazumevani režim je
 * --dry-run (ništa se ne piše). Skripta ČITA sy15 (samo SELECT) i PIŠE u onu bazu
 * na koju pokazuje DATABASE_URL — proveri gde pokazuje pre `--apply`.
 *
 * ŠTA PRENOSI: 34 tabele, redosledom koji poštuje FK (v. `TABLES` niže).
 *
 * 🔴 TABELA KOJU „SPISAK PO MODELIMA" PROMAŠI:
 *   `maint_wo_number_counter` — BROJAČ RADNIH NALOGA (year -> last_value).
 *   Nema je u `prisma/sy15.prisma` (deny-all RLS, upis samo kroz trigger), pa je
 *   spisak izveden iz sy15 modela ne vidi. Izmereno na produkciji: year=2026,
 *   last_value=134, i svih 134 naloga ima broj. Bez prenosa ovog JEDNOG reda
 *   numeracija posle preklopa kreće od `WO-2026-00001` i sudara se sa postojećim
 *   brojevima (parcijalni unique nad `wo_number` bi to pretvorio u 500-ku).
 *
 * ŠTA NE PRENOSI
 *   - Fajlove iz storage-a (`maint-machine-files`, 59 objekata / 469 MB). Prenose
 *     se SAMO putanje (`storage_path`); URL-ovi ka sy15 gateway-u ostaju važeći.
 *   - `rev_api_idempotency` (registar idempotencije CELE aplikacije, 663 reda od
 *     čega 21 `odrzavanje.*`). 3.0 ima svoj generički `api_idempotency`
 *     (`common/idempotency/`); stari ključevi se NE prenose — registar je
 *     kratkotrajan po prirodi (v. SEOBA_SASTANCI_PB §7e).
 *   - 102 RLS politike, 43 `maint_*` DEFINER funkcije, 13 `v_maint_*` view-ova i
 *     11 „logika" trigera — to se prepisuje u NestJS (v. runbook §6).
 *
 * KLJUČNE ODLUKE PRESLIKAVANJA (izmerene, ne pretpostavljene):
 *   - UUID PK-ovi se ZADRŽAVAJU 1:1 -> prenos je egzaktno idempotentan (upsert po
 *     ključu), bez remap tabele. Ponovno pokretanje ažurira u mestu, nikad ne duplira.
 *   - 46 kolona sa FK na `auth.users` -> 3.0 `users.id` po mejlu. Izmereno: domen
 *     koristi 21 različit nalog, SVIH 21 ima parnjaka u 3.0 (21/21).
 *     Nerazrešeno -> NULL + prijava; kod NOT NULL kolona -> BLOKADA (nema tihog
 *     podmetanja tuđeg naloga, i nema tihog gubljenja reda).
 *   - 23 PG enuma su u 3.0 String + CHECK; vrednosti se prenose DOSLOVNO (isti skup).
 *   - `maint_user_profiles.user_id` je PK I FK na `auth.users` — u 3.0 postaje
 *     `users.id` (Int). Nerazrešen profil je BLOKADA: bez njega korisnik gubi
 *     maint rolu, a to se ne vidi dok neko ne otvori ekran i ne dobije 403.
 *
 * ZAŠTO SE KOLONE VUKU IZ DMMF-a, A NE PREPISUJU RUČNO
 *   34 tabele nose ~500 kolona. Ručni prepis te veličine nosi rizik TIHE greške
 *   (promašeno ime kolone = kolona se ne prenese, a brojevi redova se i dalje
 *   poklapaju — verifikacija po `count(*)` to NE bi uhvatila). Zato se spisak
 *   kolona izvodi iz Prisma DMMF-a ciljnog modela: za svako skalarno polje uzima
 *   se `dbName ?? name`, i tačno ta kolona se čita iz sy15. Ako kolona u sy15 ne
 *   postoji, `SELECT` pukne ODMAH i glasno (a ne tiho preskoči).
 *   Dry-run ISPISUJE svaku kolonu koju će čitati — spisak je time proverljiv.
 *
 * KONEKCIJE (iz backend/.env, kao migrate-sastanci-pb-sy15.ts):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client, sirovi SELECT)
 *   - odredište   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-odrzavanje-sy15.ts            # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-odrzavanje-sy15.ts --apply    # upis
 *   ... --verify-only     # samo uporedi brojeve izvor/odredište
 *   ... --show-columns    # ispiši mapu kolona po tabeli i izađi (revizija mapiranja)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import { buildUserMaps, type UserMaps } from "./lib/sy15-identity";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao migrate-sastanci-pb.
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

interface StepReport {
  read: number;
  written: number;
  skipped: number;
  inserted: number;
  updated: number;
  unresolved: Record<string, string[]>;
}
const report: Record<string, StepReport> = {};
const blockers: string[] = [];

function step(name: string): StepReport {
  const s: StepReport = {
    read: 0,
    written: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    unresolved: {},
  };
  report[name] = s;
  return s;
}
function note(s: StepReport, category: string, key: string): void {
  (s.unresolved[category] ??= []).push(key);
}

// ---------------------------------------------------------------------------
// Spisak tabela — redosled poštuje FK (roditelj pre deteta).
// ---------------------------------------------------------------------------

interface TableSpec {
  /** Tabela u sy15 (ista je i u 3.0 — imena se ne menjaju). */
  table: string;
  /** Ime Prisma modela u 3.0 (`Prisma.dmmf` + delegate ključ). */
  model: string;
  /** Kolone koje čine ključ upserta (imena KOLONA, ne polja). */
  key: string[];
  /** Kolone koje se NE prenose (generisane/izvedene). Prazno za ceo ovaj domen. */
  skip?: string[];
  /**
   * Kolone koje se u PRVOM prolazu upisuju kao NULL, pa se postavljaju u drugom
   * (`fixIncidentWorkOrderLinks`). Služi samo za KRUŽNU FK vezu — bez toga bi
   * upis pao na „insert or update violates foreign key constraint".
   */
  defer?: string[];
  /** `ORDER BY` za tabele sa FK na SAMU SEBE (roditelj mora pre deteta). */
  orderBy?: string;
}

/**
 * 34 tabele. Redosled je izveden iz FK grafa žive sy15 (37 unutrašnjih FK-ova):
 * `maint_locations` -> `maint_assets` -> (machines/details/planovi/nalozi) ->
 * incidenti -> dokumenti/tragovi. `maint_work_orders` i `maint_incidents` imaju
 * KRUŽNU vezu (`wo.source_incident_id` <-> `incident.work_order_id`) — zato se
 * incidenti upisuju posle naloga, pa se `work_order_id` popravlja u drugom prolazu
 * (v. `fixIncidentWorkOrderLinks`).
 */
const TABLES: TableSpec[] = [
  // Samoreferentni FK (`parent_location_id`) — roditelji moraju pre dece.
  {
    table: "maint_locations",
    model: "MaintLocation",
    key: ["location_id"],
    orderBy: "parent_location_id NULLS FIRST",
  },
  { table: "maint_assets", model: "MaintAsset", key: ["asset_id"] },
  { table: "maint_machines", model: "MaintMachine", key: ["machine_code"] },
  { table: "maint_vehicle_owners", model: "MaintVehicleOwner", key: ["owner_id"] },
  { table: "maint_drivers", model: "MaintDriver", key: ["driver_id"] },
  { table: "maint_vehicle_details", model: "MaintVehicleDetails", key: ["asset_id"] },
  { table: "maint_it_asset_details", model: "MaintItAssetDetails", key: ["asset_id"] },
  // 🔴 `cadastral_parcels` se NE ČITA — te kolone u živoj sy15 NEMA (izmereno
  // `pg_attribute`: tabela ima 14 kolona, bez nje), iako je `prisma/sy15.prisma`
  // deklariše i `odrzavanje.service.ts` je upisuje. Posledica na produkciji je
  // opisana u runbook-u (§ nalaz „Objekti"): svaki upis detalja objekta pada sa
  // 42703. Kolona u 3.0 POSTOJI (FE je ima) i biće prazna — nema šta da se prenese.
  {
    table: "maint_facility_details",
    model: "MaintFacilityDetails",
    key: ["asset_id"],
    skip: ["cadastral_parcels"],
  },
  { table: "maint_suppliers", model: "MaintSupplier", key: ["supplier_id"] },
  { table: "maint_parts", model: "MaintPart", key: ["part_id"] },
  { table: "maint_part_vehicles", model: "MaintPartVehicle", key: ["asset_id", "part_id"] },
  { table: "maint_asset_service_plan", model: "MaintAssetServicePlan", key: ["plan_id"] },
  { table: "maint_vehicle_service_plan", model: "MaintVehicleServicePlan", key: ["plan_id"] },
  { table: "maint_tasks", model: "MaintTask", key: ["id"] },
  { table: "maint_checks", model: "MaintCheck", key: ["id"] },
  // 🔴 BROJAČ — mora pre naloga: trigger `trg_maint_wo_assign_number` čita ovu
  // tabelu, pa upis naloga sa praznim brojem inače kreće od 1.
  { table: "maint_wo_number_counter", model: "MaintWoNumberCounter", key: ["year"] },
  // 🔴 `source_incident_id` gađa `maint_incidents` koji se upisuju TEK POSLE —
  // odlaže se u drugi prolaz (kružna veza, v. `fixIncidentWorkOrderLinks`).
  {
    table: "maint_work_orders",
    model: "MaintWorkOrder",
    key: ["wo_id"],
    defer: ["source_incident_id"],
  },
  { table: "maint_incidents", model: "MaintIncident", key: ["id"] },
  { table: "maint_incident_events", model: "MaintIncidentEvent", key: ["id"] },
  { table: "maint_wo_events", model: "MaintWoEvent", key: ["id"] },
  { table: "maint_wo_labor", model: "MaintWoLabor", key: ["id"] },
  { table: "maint_wo_parts", model: "MaintWoPart", key: ["id"] },
  { table: "maint_part_stock_movements", model: "MaintPartStockMovement", key: ["movement_id"] },
  { table: "maint_documents", model: "MaintDocument", key: ["document_id"] },
  { table: "maint_machine_files", model: "MaintMachineFile", key: ["id"] },
  { table: "maint_machine_notes", model: "MaintMachineNote", key: ["id"] },
  { table: "maint_machine_status_override", model: "MaintMachineStatusOverride", key: ["machine_code"] },
  { table: "maint_machines_deletion_log", model: "MaintMachineDeletionLog", key: ["id"] },
  { table: "maint_vehicle_tires", model: "MaintVehicleTire", key: ["tire_set_id"] },
  { table: "maint_vehicle_bookings", model: "MaintVehicleBooking", key: ["booking_id"] },
  { table: "maint_user_profiles", model: "MaintUserProfile", key: ["user_id"] },
  { table: "maint_notification_rules", model: "MaintNotificationRule", key: ["rule_id"] },
  { table: "maint_notification_log", model: "MaintNotificationLog", key: ["id"] },
  { table: "maint_settings", model: "MaintSettings", key: ["id"] },
];

/**
 * 46 kolona koje su u sy15 imale FK na `auth.users(id)` (uuid) — u 3.0 su `users.id`
 * (Int). Spisak je IZMEREN (`pg_constraint` nad živom sy15), ne pogađan po imenu:
 * `maint_it_asset_details.assigned_to` je npr. SLOBODAN TEKST i NIJE ovde, iako
 * ime sugeriše nalog. Ključ je `tabela.kolona`.
 */
const USER_COLUMNS = new Set<string>([
  "maint_asset_service_plan.created_by",
  "maint_asset_service_plan.updated_by",
  "maint_assets.archived_by",
  "maint_assets.responsible_user_id",
  "maint_assets.updated_by",
  "maint_checks.performed_by",
  "maint_checks.updated_by",
  "maint_documents.uploaded_by",
  "maint_drivers.auth_user_id",
  "maint_drivers.created_by",
  "maint_drivers.updated_by",
  "maint_facility_details.updated_by",
  "maint_incident_events.actor",
  "maint_incidents.assigned_to",
  "maint_incidents.reported_by",
  "maint_incidents.updated_by",
  "maint_it_asset_details.updated_by",
  "maint_machine_files.uploaded_by",
  "maint_machine_notes.author",
  "maint_machine_status_override.set_by",
  "maint_machines.responsible_user_id",
  "maint_machines.updated_by",
  "maint_machines_deletion_log.deleted_by",
  "maint_notification_log.recipient_user_id",
  "maint_notification_rules.updated_by",
  "maint_part_stock_movements.created_by",
  "maint_part_vehicles.created_by",
  "maint_part_vehicles.updated_by",
  "maint_parts.updated_by",
  "maint_settings.updated_by",
  "maint_suppliers.updated_by",
  "maint_tasks.created_by",
  "maint_tasks.updated_by",
  "maint_user_profiles.user_id",
  "maint_vehicle_bookings.created_by",
  "maint_vehicle_bookings.updated_by",
  "maint_vehicle_details.updated_by",
  "maint_vehicle_owners.updated_by",
  "maint_vehicle_service_plan.created_by",
  "maint_vehicle_service_plan.updated_by",
  "maint_vehicle_tires.updated_by",
  "maint_wo_events.actor",
  "maint_wo_labor.technician_id",
  "maint_work_orders.assigned_to",
  "maint_work_orders.reported_by",
  "maint_work_orders.updated_by",
]);

/**
 * Kolone sa FK na `auth.users` koje su NOT NULL. Nerazrešen nalog tu NE sme da
 * postane NULL (pao bi upis) niti da se zameni tuđim — to je BLOKADA.
 */
const USER_COLUMNS_REQUIRED = new Set<string>([
  "maint_checks.performed_by",
  "maint_incidents.reported_by",
  "maint_machine_notes.author",
  "maint_machine_status_override.set_by",
  "maint_user_profiles.user_id",
  "maint_work_orders.reported_by",
]);

// ---------------------------------------------------------------------------
// Mapa kolona iz DMMF-a ciljnog modela
// ---------------------------------------------------------------------------

interface FieldMap {
  /** Ime kolone u bazi (isto u sy15 i u 3.0). */
  column: string;
  /** Ime polja u Prisma modelu. */
  field: string;
  /** Prisma tip (`String`, `Int`, `DateTime`, `Decimal`, `BigInt`, `Json`, `Boolean`). */
  type: string;
  isList: boolean;
  /** `true` ako je kolona bila FK na `auth.users` (prevodi se u `users.id`). */
  isUser: boolean;
  /** `true` ako je NOT NULL user kolona (nerazrešeno = blokada). */
  isUserRequired: boolean;
}

function fieldMapsFor(spec: TableSpec): FieldMap[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === spec.model);
  if (!model) {
    throw new Error(
      `Model ${spec.model} ne postoji u DMMF-u — schema.prisma i ova skripta su se razišle.`,
    );
  }
  const skip = new Set(spec.skip ?? []);
  return model.fields
    .filter((f) => f.kind === "scalar" || f.kind === "enum")
    .map((f) => {
      const column = f.dbName ?? f.name;
      return {
        column,
        field: f.name,
        type: f.type,
        isList: f.isList,
        isUser: USER_COLUMNS.has(`${spec.table}.${column}`),
        isUserRequired: USER_COLUMNS_REQUIRED.has(`${spec.table}.${column}`),
      };
    })
    .filter((f) => !skip.has(f.column));
}

// ---------------------------------------------------------------------------
// Konverzije tipova (pg -> Prisma)
// ---------------------------------------------------------------------------

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function convert(f: FieldMap, raw: unknown): unknown {
  if (raw == null) return null;
  if (f.isList) {
    // pg driver vraća nizove kao JS niz; `text[]` ostaje niz stringova.
    return Array.isArray(raw) ? raw : [raw];
  }
  switch (f.type) {
    case "Int":
      return typeof raw === "number" ? raw : Number(raw);
    case "BigInt":
      return typeof raw === "bigint" ? raw : BigInt(String(raw));
    case "Boolean":
      return Boolean(raw);
    case "DateTime":
      return toDate(raw);
    case "Decimal":
      // Prisma prima string — bez prolaska kroz Number (gubitak preciznosti).
      return new Prisma.Decimal(String(raw));
    case "Json":
      return raw as Prisma.InputJsonValue;
    default:
      return String(raw);
  }
}

/** `auth.users` uuid -> 3.0 `users.id`. Nerazrešeno -> NULL + prijava (ili BLOKADA). */
function mapUser(
  s: StepReport,
  users: UserMaps,
  f: FieldMap,
  raw: unknown,
  table: string,
  rowId: string,
): number | null {
  if (raw == null) return null;
  const uuid = String(raw).toLowerCase();
  const id = users.byAuthUuid.get(uuid);
  if (id === undefined) {
    note(s, "nalog-nerazresen", `${rowId}.${f.column} -> ${uuid}`);
    if (f.isUserRequired) {
      blockers.push(
        `${table}.${f.column} (red ${rowId}) pokazuje na auth.users ${uuid} koji NEMA ` +
          `parnjaka u 3.0 users — kolona je NOT NULL, red se ne može preneti bez ` +
          `podmetanja tuđeg naloga. Napravi nalog ili odluči šta sa redom.`,
      );
    }
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Generički upsert (idempotentan: isti podaci u create i update)
// ---------------------------------------------------------------------------

interface AnyDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown>;
  count(): Promise<number>;
}

function delegateFor(prisma: PrismaClient, model: string): AnyDelegate {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const d = (prisma as unknown as Record<string, AnyDelegate>)[key];
  if (!d) throw new Error(`Prisma delegate za model ${model} ne postoji.`);
  return d;
}

/**
 * Ključ upserta. Za jednu kolonu Prisma traži `{ polje: vrednost }`, a za složen
 * ključ `{ poljeA_poljeB: { poljeA, poljeB } }` — isti oblik kao kod sastanaka.
 */
function whereFor(
  spec: TableSpec,
  maps: FieldMap[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const parts = spec.key.map((col) => {
    const f = maps.find((m) => m.column === col);
    if (!f) throw new Error(`Ključna kolona ${spec.table}.${col} nije u modelu.`);
    return f.field;
  });
  if (parts.length === 1) return { [parts[0]]: data[parts[0]] };
  const compound: Record<string, unknown> = {};
  for (const p of parts) compound[p] = data[p];
  return { [parts.join("_")]: compound };
}

// ---------------------------------------------------------------------------

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

  const mode = VERIFY_ONLY ? "VERIFY-ONLY" : APPLY ? "APPLY (PIŠE!)" : "DRY-RUN";
  console.log(`\n=== migrate-odrzavanje-sy15 :: ${mode} ===`);
  console.log(`izvor  (sy15): ${maskUrl(process.env.SY15_DATABASE_URL)}`);
  console.log(`odredište    : ${maskUrl(process.env.DATABASE_URL)}\n`);

  try {
    if (VERIFY_ONLY) {
      await verify(prisma, sy15);
      printBlockers();
      return;
    }

    // --- Korak 0: mapa identiteta -------------------------------------------
    const users = await buildUserMaps(prisma, sy15);
    console.log("--- MAPA IDENTITETA (korak 0) ---");
    console.log(`  3.0 users (po mejlu)          : ${users.byEmail.size}`);
    console.log(`  sy15 auth.users -> users.id   : ${users.byAuthUuid.size}`);
    console.log(`  sy15 auth.users BEZ parnjaka  : ${users.unmatchedAuthUuids.length}`);

    // Koliko naloga OVAJ domen stvarno koristi i da li su svi pokriveni —
    // merenje pre upisa, ne posle. (Izmereno 06.08.2026 na produkciji: 21/21.)
    const domainUsers = await domainUserIds(sy15);
    const missing = domainUsers.filter((u) => !users.byAuthUuid.has(u.toLowerCase()));
    console.log(`  naloga koje DOMEN koristi     : ${domainUsers.length}`);
    console.log(`  od toga bez parnjaka u 3.0    : ${missing.length}`);
    if (missing.length > 0) {
      for (const m of missing) console.log(`    ! ${m}`);
    }
    console.log("");

    await transfer(prisma, sy15, users);
    await fixIncidentWorkOrderLinks(prisma, sy15);
    printReport();

    if (APPLY) {
      console.log("\n--- VERIFIKACIJA POSLE UPISA ---");
      await verify(prisma, sy15);
    }
    printBlockers();
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

function maskUrl(u: string | undefined): string {
  if (!u) return "(prazno)";
  return u.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

/** `--show-columns`: revizija mapiranja bez ijedne konekcije. */
function showColumns(): void {
  console.log("\n=== MAPA KOLONA (izvedena iz DMMF-a ciljnog modela) ===\n");
  let total = 0;
  for (const spec of TABLES) {
    const maps = fieldMapsFor(spec);
    total += maps.length;
    const userCols = maps.filter((m) => m.isUser).map((m) => m.column);
    console.log(`${spec.table}  (${maps.length} kolona, ključ: ${spec.key.join("+")})`);
    console.log(`  ${maps.map((m) => m.column).join(", ")}`);
    if (userCols.length > 0) {
      console.log(`  -> users.id: ${userCols.join(", ")}`);
    }
    console.log("");
  }
  console.log(`UKUPNO: ${TABLES.length} tabela, ${total} kolona.`);
  const declared = USER_COLUMNS.size;
  const seen = TABLES.flatMap((spec) =>
    fieldMapsFor(spec).filter((m) => m.isUser).map((m) => `${spec.table}.${m.column}`),
  );
  console.log(`USER kolona: deklarisano ${declared}, nađeno u modelima ${seen.length}.`);
  if (declared !== seen.length) {
    const missing = [...USER_COLUMNS].filter((c) => !seen.includes(c));
    console.log(`🔴 NE POKLAPA SE. Nema u modelima: ${missing.join(", ")}`);
  }
}

/** Koje `auth.users` naloge domen STVARNO koristi (svih 46 kolona). */
async function domainUserIds(sy15: Sy15PrismaClient): Promise<string[]> {
  const parts = [...USER_COLUMNS].map((tc) => {
    const [table, col] = tc.split(".");
    return `SELECT DISTINCT ${col}::text AS u FROM public.${table} WHERE ${col} IS NOT NULL`;
  });
  const rows = await sy15.$queryRawUnsafe<{ u: string }[]>(
    `SELECT DISTINCT u FROM (${parts.join(" UNION ")}) q`,
  );
  return rows.map((r) => r.u);
}

// ===========================================================================
// PRENOS
// ===========================================================================

async function transfer(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
  users: UserMaps,
): Promise<void> {
  for (const spec of TABLES) {
    const s = step(spec.table);
    const maps = fieldMapsFor(spec);
    const cols = maps
      .map((m) => (m.type === "DateTime" ? `"${m.column}"` : `"${m.column}"`))
      .join(", ");

    // Ako kolona u sy15 ne postoji, ovo pukne ODMAH i glasno — namerno.
    const rows = await sy15.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${cols} FROM public.${spec.table}` +
        (spec.orderBy ? ` ORDER BY ${spec.orderBy}` : ""),
    );
    s.read = rows.length;

    const delegate = delegateFor(prisma, spec.model);
    const defer = new Set(spec.defer ?? []);

    for (const raw of rows) {
      const rowId = spec.key.map((k) => String(raw[k])).join("/");
      const data: Record<string, unknown> = {};
      for (const f of maps) {
        if (defer.has(f.column)) {
          data[f.field] = null; // kružna veza — postavlja je drugi prolaz
          continue;
        }
        // 🔴 Prisma NE UME `null` u skalarnom nizu (`String[]` je uvek non-null u
        // klijentu), a pg kolona `maint_drivers.drivers_license_categories` JESTE
        // nullable — i to je jedina takva u domenu (izmereno: 30/30 redova NULL,
        // ostale 4 array kolone su NOT NULL sa `DEFAULT '{}'`).
        // Zamena NULL -> `[]` NIJE opcija: CHECK `maint_drivers_license_cats_nonempty`
        // izričito zabranjuje prazan niz (`IS NULL OR cardinality > 0`), pa bi upis
        // pao. Zato se polje IZOSTAVLJA iz upisa — kolona ostaje NULL, kao u izvoru.
        if (f.isList && raw[f.column] == null) continue;
        data[f.field] = f.isUser
          ? mapUser(s, users, f, raw[f.column], spec.table, rowId)
          : convert(f, raw[f.column]);
      }

      // NOT NULL user kolona bez parnjaka: red se PRESKAČE (blokada je već
      // prijavljena u `mapUser`). Tiho podmetanje tuđeg naloga ne dolazi u obzir.
      const missingRequired = maps.some(
        (f) => f.isUserRequired && data[f.field] == null,
      );
      if (missingRequired) {
        s.skipped += 1;
        continue;
      }

      if (!APPLY) {
        s.written += 1;
        continue;
      }
      const where = whereFor(spec, maps, data);
      const before = await delegate.findUnique({ where });
      await delegate.upsert({ where, create: data, update: data });
      if (before === null) s.inserted += 1;
      else s.updated += 1;
      s.written += 1;
    }
  }
}

/**
 * Kružna veza nalog <-> incident.
 *
 * `maint_work_orders.source_incident_id` -> `maint_incidents.id` i
 * `maint_incidents.work_order_id` -> `maint_work_orders.wo_id` pokazuju jedan na
 * drugi. Nalozi se upisuju PRVI, pa im `source_incident_id` u tom trenutku gađa
 * incident koji još ne postoji. Zato se ta kolona u prvom prolazu ostavlja kakva
 * jeste (FK je `SET NULL`, ali bi upis pao), a ovde se POSTAVLJA u drugom prolazu.
 *
 * ⚠️ Izmereno na produkciji 06.08.2026: `maint_work_orders.source_incident_id`
 * popunjeno u 12/134 reda, `maint_incidents.work_order_id` u 12/21. Ako se ovaj
 * prolaz preskoči, veza „incident -> nalog" tiho nestaje na oba ekrana.
 */
async function fixIncidentWorkOrderLinks(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
): Promise<void> {
  const s = step("(2. prolaz) veze nalog<->incident");
  const woRows = await sy15.$queryRawUnsafe<{ wo_id: string; source_incident_id: string }[]>(
    `SELECT wo_id::text, source_incident_id::text FROM public.maint_work_orders
      WHERE source_incident_id IS NOT NULL`,
  );
  const incRows = await sy15.$queryRawUnsafe<{ id: string; work_order_id: string }[]>(
    `SELECT id::text, work_order_id::text FROM public.maint_incidents
      WHERE work_order_id IS NOT NULL`,
  );
  s.read = woRows.length + incRows.length;

  if (!APPLY) {
    s.written = s.read;
    return;
  }
  for (const r of woRows) {
    await prisma.maintWorkOrder.update({
      where: { woId: r.wo_id },
      data: { sourceIncidentId: r.source_incident_id },
    });
    s.updated += 1;
    s.written += 1;
  }
  for (const r of incRows) {
    await prisma.maintIncident.update({
      where: { id: r.id },
      data: { workOrderId: r.work_order_id },
    });
    s.updated += 1;
    s.written += 1;
  }
}

// ===========================================================================
// VERIFIKACIJA
// ===========================================================================

async function verify(prisma: PrismaClient, sy15: Sy15PrismaClient): Promise<void> {
  let ok = 0;
  let bad = 0;
  for (const spec of TABLES) {
    const srcRows = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public.${spec.table}`,
    );
    const src = Number(srcRows[0]?.n ?? 0);
    const dst = await delegateFor(prisma, spec.model).count();
    const mark = src === dst ? "OK  " : "!!! ";
    if (src === dst) ok += 1;
    else bad += 1;
    console.log(
      `${mark}${spec.table.padEnd(32)} sy15=${String(src).padStart(5)}  3.0=${String(dst).padStart(5)}`,
    );
  }
  console.log(`\n  poklapa se: ${ok}/${TABLES.length}${bad > 0 ? `  RAZLIKA: ${bad}` : ""}`);
  if (bad > 0) {
    blockers.push(`Verifikacija: ${bad} tabela se NE poklapa po broju redova.`);
  }

  // Kontrola koju `count(*)` ne hvata: brojač naloga i kružne veze.
  const cnt = await prisma.maintWoNumberCounter.findMany();
  const srcCnt = await sy15.$queryRawUnsafe<{ year: number; last_value: number }[]>(
    `SELECT year, last_value FROM public.maint_wo_number_counter ORDER BY year`,
  );
  const same =
    cnt.length === srcCnt.length &&
    srcCnt.every((r) => cnt.some((c) => c.year === r.year && c.lastValue === r.last_value));
  console.log(
    `${same ? "OK  " : "!!! "}brojač naloga                    ` +
      `sy15=${srcCnt.map((r) => `${r.year}:${r.last_value}`).join(",") || "(prazno)"}  ` +
      `3.0=${cnt.map((c) => `${c.year}:${c.lastValue}`).join(",") || "(prazno)"}`,
  );
  if (!same) {
    blockers.push(
      "Brojač radnih naloga (`maint_wo_number_counter`) se ne poklapa — numeracija " +
        "bi posle preklopa krenula od nule i sudarila se sa postojećim brojevima.",
    );
  }

  const woLinks = await prisma.maintWorkOrder.count({
    where: { sourceIncidentId: { not: null } },
  });
  const incLinks = await prisma.maintIncident.count({ where: { workOrderId: { not: null } } });
  const srcWo = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public.maint_work_orders WHERE source_incident_id IS NOT NULL`,
  );
  const srcInc = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public.maint_incidents WHERE work_order_id IS NOT NULL`,
  );
  const linksOk =
    woLinks === Number(srcWo[0]?.n ?? 0) && incLinks === Number(srcInc[0]?.n ?? 0);
  console.log(
    `${linksOk ? "OK  " : "!!! "}veze nalog<->incident            ` +
      `sy15=${Number(srcWo[0]?.n ?? 0)}/${Number(srcInc[0]?.n ?? 0)}  3.0=${woLinks}/${incLinks}`,
  );
  if (!linksOk) {
    blockers.push("Kružne veze nalog<->incident nisu prenete (2. prolaz nije prošao).");
  }
}

function printReport(): void {
  console.log("\n=== IZVEŠTAJ ===");
  let read = 0;
  let written = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const [name, s] of Object.entries(report)) {
    read += s.read;
    written += s.written;
    inserted += s.inserted;
    updated += s.updated;
    skipped += s.skipped;
    const det = APPLY ? ` ins=${s.inserted} upd=${s.updated}` : "";
    console.log(
      `  ${name.padEnd(32)} read=${String(s.read).padStart(4)} write=${String(s.written).padStart(4)}${det}${
        s.skipped > 0 ? ` SKIP=${s.skipped}` : ""
      }`,
    );
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      console.log(
        `      ${cat}: ${keys.length} (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""})`,
      );
    }
  }
  console.log(
    `\n  UKUPNO read=${read} write=${written}${APPLY ? ` ins=${inserted} upd=${updated}` : ""}${
      skipped > 0 ? ` skip=${skipped}` : ""
    }`,
  );
}

function printBlockers(): void {
  console.log("\n=== BLOKADE ===");
  if (blockers.length === 0) {
    console.log("  (nema) — sekcija mora biti prazna pre `--apply` na produkciji.");
  } else {
    for (const b of blockers) console.log(`  🔴 ${b}`);
  }
}

main().catch((e: unknown) => {
  console.error("\nPAD:", e);
  process.exitCode = 1;
});
