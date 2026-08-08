/**
 * One-off prenos podataka: sy15 (1.0) KADROVSKA -> 3.0 app-owned tabele.
 *
 * Korak „kadrovska" iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje i runbook u
 * docs/SEOBA_KADROVSKE_PRENOS_2026-08-08.md. Obrazac: scripts/migrate-odrzavanje-sy15.ts.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI. Podrazumevani režim je dry-run (ništa se ne piše).
 * Skripta ČITA izvor (samo SELECT) i PIŠE u bazu na koju pokazuje DATABASE_URL —
 * proveri gde pokazuje pre `--apply`. Dokaz je vožen na probnoj bazi
 * (`kadr_probna_src` / `kadr_probna_dst`, v. scripts/prep-kadrovska-probna.sh).
 *
 * ============================================================================
 * ZAŠTO OVA SKRIPTA NIJE PISANA PO DMMF-u (razlika od održavanja)
 * ============================================================================
 * `migrate-odrzavanje-sy15.ts` vuče spisak kolona iz Prisma DMMF-a ciljnog modela.
 * Za kadrovsku to NE MOŽE, jer ciljni modeli u `prisma/schema.prisma` još NE POSTOJE
 * (izmereno 08.08.2026 na 3.0 produkciji: 313 tabela u `public`, od kadrovske samo
 * `kadr_grid_day_locks` i `worker_employee_map`). Prisma šema kadrovske je ZASEBAN
 * posao (druga grana istog temelja) — da je ovde napravim, dve grane bi se sudarile
 * u istom fajlu.
 *
 * Zato je spisak kolona izveden iz `information_schema` ODREDIŠTA u trenutku
 * pokretanja, a zatim UPOREĐEN sa izvorom:
 *   - kolona ima u odredištu a nema u izvoru  -> BLOKADA (ne piše se ništa u tu tabelu)
 *   - kolona ima u izvoru a nema u odredištu  -> BLOKADA (podatak bi se tiho izgubio)
 * Time se čuva ono zbog čega je DMMF i biran: promašeno ime kolone pukne GLASNO, a ne
 * tiho (verifikacija po `count(*)` promašaj kolone NE bi uhvatila — zato uz count ide
 * i checksum, v. `--verify-only`).
 *
 * ============================================================================
 * ŠTA PRENOSI — 65 tabela (a NE 19)
 * ============================================================================
 * 🔴 NALAZ: mapa domena koju smo dobili navodi „19 tabela (prefiks `kadr` / `hr_` +
 * employees, work_hours, makeup_requests, vacation_bonus_days, attendance_events,
 * salaries)". Taj broj je ARTEFAKT FILTERA PO IMENU, ne domen. Izmereno 08.08.2026
 * nad živom sy15:
 *   - filter po imenu daje TAČNO tih 19 tabela (i `salaries` MEĐU NJIMA NEMA — ta
 *     tabela u sy15 ne postoji; plate stoje u `salary_payroll` + `salary_terms`),
 *   - a domen po FK grafu i po RLS/funkcijama ima 65 tabela: 43 tabele imaju FK na
 *     `employees`, plus roditelji (`departments`, `sub_departments`, `job_positions`)
 *     i satelitski registri (kompetencije, ciklusi ocenjivanja, allowlist-e, praznici).
 *   Da smo se držali „19", tiho bi ostalo u sy15: `vacation_requests` (134),
 *   `vacation_entitlements` (132), `vacation_history` (447), `vacation_go_days` (5.269),
 *   `salary_terms` (143), `paid_leave_requests`, `nop_requests`, `absences` (134),
 *   `contracts` (17), svi `employee_*` PII registri, ocenjivanje, kompetencije
 *   (`competence_levels` 570) — ukupno ~7.900 redova i CELA istorija odsustava.
 *
 * Redosled u `TABLES` poštuje FK graf (roditelj pre deteta) — izveden iz `pg_constraint`
 * nad živom sy15, ne pogađan.
 *
 * ============================================================================
 * ŠTA NE PRENOSI
 * ============================================================================
 *   - Fajlove iz storage-a. Prenose se SAMO putanje; URL-ovi ka sy15 gateway-u ostaju.
 *   - 73 DEFINER funkcije, 49 RLS politika, okidače (`attendance_fill_event_ts`,
 *     `salary_payroll_compute_totals`, `vacation_requests_no_overlap`, …) — to se
 *     prepisuje u NestJS, zaseban posao.
 *   - `auth.users` / `user_roles` — identitet je već preseljen; ovde se samo MAPIRA.
 *
 * ============================================================================
 * IDENTITET (izmereno 08.08.2026, ne pretpostavljeno)
 * ============================================================================
 * Kadrovska naloge drži na DVA načina, i to je bitno razlikovati:
 *   1. 6 `uuid` kolona sa FK na `auth.users` -> u 3.0 postaju `users.id` (Int).
 *      Spisak je izmeren iz `pg_constraint`, plus JEDNA koja FK NEMA a jeste nalog
 *      (`kadr_audit_log.actor_user_id`, 395/1239 popunjeno, 0 bez parnjaka) — isti
 *      obrazac kao `maint_it_asset_details.assigned_to` u održavanju, samo obrnut.
 *   2. 40 TEKST kolona koje drže MEJL (`submitted_by`, `reviewed_by`, `level1_by`,
 *      `last_edited_by`, `actor_email`, …). One se prenose DOSLOVNO (ostaju tekst) —
 *      ali se PROVERAVA da svaki mejl ima nalog u 3.0. Izmereno: 49 različitih
 *      mejlova, 49/49 ima parnjaka u 3.0 `users`.
 *      🔴 U tim kolonama postoji i 9 vrednosti koje NISU mejl, već pečat sistemskog
 *      upisa (`auto:kapija`, `backfill:grid_canon`, `import-jun-2026`,
 *      `sistematizacija-v53-import`, `Nenad — naknadni unos 30.06`, …). One se NE
 *      prijavljuju kao blokada (nisu nalozi) ali se ISPISUJU — da se ne pomeša
 *      „nema naloga" sa „nije nalog".
 * Nerazrešen nalog u `uuid` koloni -> NULL + prijava; u NOT NULL koloni -> BLOKADA
 * (nema tihog podmetanja tuđeg naloga i nema tihog gubljenja reda).
 *
 * ============================================================================
 * 🔴 attendance_events — 491.268 redova / 140 MB, i KAPIJA PIŠE U NJU UŽIVO
 * ============================================================================
 * Izmereno `count(*)` (ne `n_live_tup`): 491.268 u 10:27, pa 491.271 dvadeset minuta
 * kasnije — Katze most (bridge/src/jobs/syncKatze.js) upisuje na 10 min i NE GASI SE.
 * Zato:
 *   - prenos ide u PAKETIMA po `id` (keyset kursor), sa merenjem vremena i procenom,
 *   - upis je `INSERT … ON CONFLICT (pk) DO UPDATE … WHERE red JESTE RAZLIČIT`, nikad
 *     `INSERT` naslepo — pa ponovni prolaz ne dira ništa (0 izmena) i može posle
 *     prekida da se NASTAVI (`--resume`, kursor u `kadr_seoba.prenos_stanje`),
 *   - jedan prolaz NIJE snapshot: red koji se u izvoru IZMENI ispod kursora (npr.
 *     `employee_id` se popuni kad se kartica upari) biće preuzet tek u SLEDEĆEM
 *     prolazu. Zato je runbook-om propisano: preklop = prolaz, pa još jedan prolaz,
 *     pa `--verify-only`; poslednji prolaz u kratkom prozoru dok je most stao.
 *   - 139.955/491.268 redova (28%) ima `employee_id IS NULL` — kartica bez parnjaka.
 *     To je ZATEČENO STANJE i prenosi se kakvo jeste (v. izveštaj, ne popravlja se).
 *
 * ============================================================================
 * 🔴 SEKVENCE — tiha zamka koju je održavanje platilo brojačem naloga
 * ============================================================================
 * 12 kolona u domenu je vezano na sekvencu (`attendance_events.id` je najveća,
 * `last_value=491.276`). Ako se posle prenosa sekvenca ne pomeri, PRVI upis u 3.0
 * kreće od 1 i pada na `duplicate key` — isto kao `maint_wo_number_counter`.
 * `--apply` na kraju radi `setval` na `max(pk)`, a `--verify-only` to PROVERAVA.
 *
 * ============================================================================
 * KONEKCIJE (iz backend/.env)
 * ============================================================================
 *   - izvor sy15  : SY15_DATABASE_URL  (sirovi SELECT, samo čitanje)
 *   - odredište   : DATABASE_URL
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-kadrovska-sy15.ts             # dry-run
 *   ... --apply                    # upis (idempotentan upsert)
 *   ... --apply --resume           # nastavi posle prekida, od zapamćenog kursora
 *   ... --verify-only              # count + checksum po tabeli + sekvence + nalozi
 *   ... --verify-only --detalji    # uz razliku ispiši i KOJI ključevi se ne poklapaju
 *   ... --show-columns             # revizija mape kolona (bez upisa)
 *   ... --only=attendance_events   # ograniči na tabele (zapeta razdvaja)
 *   ... --batch=5000               # veličina paketa (podrazumevano po tabeli)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import { buildUserMaps, normEmail, type UserMaps } from "./lib/sy15-identity";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao ostale seobe.
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
const RESUME = process.argv.includes("--resume");
const DETALJI = process.argv.includes("--detalji");

function argVal(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p?.slice(name.length + 3);
}
const ONLY = (argVal("only") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const BATCH_OVERRIDE = argVal("batch") ? Number(argVal("batch")) : undefined;

// ---------------------------------------------------------------------------
// Spisak tabela — redosled poštuje FK graf žive sy15 (roditelj pre deteta).
// ---------------------------------------------------------------------------

interface TableSpec {
  table: string;
  /** Veličina paketa. Podrazumevano 2000; velika tabela dobija svoj broj. */
  batch?: number;
  /**
   * Kolone koje se NE prenose, uz obavezan razlog. Prazno za ceo ovaj domen —
   * postoji da se izuzetak ne bi krio u kodu nego stajao ovde, sa objašnjenjem.
   */
  skip?: Record<string, string>;
}

/**
 * 65 tabela. Redosled je topološki nad izmerenim FK grafom (`pg_constraint`,
 * 08.08.2026): `departments`/`sub_departments` -> `job_positions` -> `employees`
 * -> sve što visi o zaposlenom. `makeup_requests` MORA pre `vacation_bonus_days`
 * (FK `makeup_request_id`), `vacation_requests` pre `vacation_change_requests`,
 * `employee_talks` pre `corrective_plans` (FK `talk_id` i `closing_talk_id`),
 * `development_plans` pre `employee_talks`/`assessments`/`employee_expectations`.
 */
const TABLES: TableSpec[] = [
  // --- organizacija (roditelji svega) ---
  { table: "departments" },
  { table: "sub_departments" },
  { table: "job_positions" },
  { table: "employees" },
  { table: "company_profile" },
  { table: "kadr_holidays" },
  // --- kompetencije (roditelji ocenjivanja I profila radnih mesta) ---
  { table: "competence_groups" },
  { table: "competences" },
  { table: "competence_levels" },
  { table: "competence_questions" },
  { table: "competence_profiles" },
  // 🔴 `profile_groups` i `profile_positions` MORAJU posle kompetencija: gađaju
  // `competence_groups` / `competence_profiles`. Prva verzija ovog spiska ih je
  // stavila uz organizaciju (po imenu „profile") i prenos je pao na
  // `23503 profile_groups_group_id_fkey`. Zato `proveriRedosled()` sada NE VERUJE
  // ovom spisku nego ga meri nad živim FK grafom.
  { table: "profile_groups" },
  { table: "profile_positions" },
  // --- razvoj / razgovori / korektivne mere ---
  { table: "development_plans" },
  { table: "employee_talks" },
  { table: "corrective_plans" },
  { table: "corrective_measures" },
  { table: "development_checkins" },
  { table: "employee_expectations" },
  // --- ocenjivanje ---
  { table: "assessment_cycles" },
  { table: "assessments" },
  { table: "assessment_raters" },
  { table: "assessment_answers" },
  { table: "assessment_scores" },
  { table: "assessment_results" },
  { table: "assessment_targets" },
  // --- radni odnos i dokumenti ---
  { table: "contracts" },
  { table: "salary_terms" },
  { table: "salary_payroll" },
  { table: "employee_bank_cards" },
  { table: "employee_children" },
  { table: "employee_documents" },
  { table: "employee_personal_docs" },
  { table: "employee_foreign_docs" },
  { table: "kadr_certificates" },
  { table: "kadr_medical_exams" },
  { table: "kadr_document_ack" },
  // --- odsustva ---
  { table: "absences" },
  { table: "vacation_entitlements" },
  { table: "vacation_requests" },
  { table: "vacation_change_requests" },
  { table: "vacation_history" },
  { table: "vacation_go_days" },
  { table: "makeup_requests" },
  { table: "vacation_bonus_days" },
  { table: "paid_leave_requests" },
  { table: "nop_requests" },
  // --- prisustvo (kapija, kiosk, grid) ---
  { table: "employee_badges" },
  { table: "katze_employee_map" },
  { table: "worker_employee_map" },
  { table: "attendance_notify_extra" },
  { table: "attendance_corrections" },
  // 🔴 najveća tabela domena — 491k redova, paket 5.000, kapija piše uživo.
  { table: "attendance_events", batch: 5000 },
  { table: "work_hours" },
  { table: "work_hours_remarks" },
  // --- onboarding ---
  { table: "kadr_onboarding_templates" },
  { table: "kadr_onboarding_template_items" },
  { table: "kadr_onboarding_runs" },
  { table: "kadr_onboarding_tasks" },
  // --- obaveštenja, audit, allowlist-e ---
  { table: "kadr_notification_config" },
  { table: "kadr_notification_log" },
  { table: "kadr_audit_log" },
  { table: "kadr_grid_editor_allowlist" },
  { table: "kadr_salary_viewer_allowlist" },
  { table: "kadr_vacation_editor_allowlist" },
];

/**
 * `uuid` kolone koje pokazuju na nalog -> u 3.0 postaju `users.id` (Int).
 *
 * Prvih 5 je IZMERENO iz `pg_constraint` (FK na `auth.users`). Šesta
 * (`kadr_audit_log.actor_user_id`) FK NEMA — nađena je pretragom po TIPU (`uuid`) i
 * proverena podatkom: 395/1239 popunjeno, 0 vrednosti bez parnjaka u `auth.users`.
 * Bez nje bi se audit trag tiho raskinuo, a `count(*)` bi se i dalje poklapao.
 *
 * 🔴 Skripta na startu PROVERAVA da u domenu nema DRUGE `uuid` kolone koja gađa
 * `auth.users` a nije ovde (v. `proveriUuidKoloneNaloga`) — spisak se ne veruje na reč.
 */
const USER_UUID_COLUMNS = new Set<string>([
  "absences.archived_by",
  "contracts.archived_by",
  "employee_documents.uploaded_by",
  "kadr_certificates.created_by",
  "kadr_medical_exams.created_by",
  "kadr_audit_log.actor_user_id",
]);

/**
 * TEKST kolone koje drže mejl korisnika. Ne prevode se (ostaju tekst, kao u izvoru) —
 * ali se svaka vrednost sa `@` mora naći u 3.0 `users`, inače je BLOKADA.
 * Spisak je izmeren (`pg_attribute` + tip text/varchar + ime `%email%`/`%_by`/`%actor%`).
 */
const ACTOR_EMAIL_COLUMNS: string[] = [
  "assessment_raters.rater_email",
  "assessments.opened_by",
  "attendance_corrections.cancelled_by",
  "attendance_corrections.created_by",
  "attendance_notify_extra.email",
  "company_profile.updated_by",
  "corrective_plans.created_by",
  "development_plans.created_by",
  "development_plans.updated_by",
  "employee_talks.conducted_by",
  "employee_talks.created_by",
  "employee_talks.updated_by",
  "employees.email",
  "job_positions.profile_updated_by",
  "kadr_audit_log.actor_email",
  "kadr_document_ack.acked_by",
  "kadr_onboarding_runs.created_by",
  "kadr_onboarding_tasks.done_by",
  "katze_employee_map.confirmed_by",
  "makeup_requests.completed_by",
  "makeup_requests.level1_by",
  "makeup_requests.reviewed_by",
  "makeup_requests.storno_by",
  "makeup_requests.submitted_by",
  "nop_requests.requested_by",
  "nop_requests.reviewed_by",
  "paid_leave_requests.level1_by",
  "paid_leave_requests.reviewed_by",
  "paid_leave_requests.submitted_by",
  "salary_payroll.created_by",
  "salary_terms.approved_by",
  "salary_terms.created_by",
  "vacation_bonus_days.added_by",
  "vacation_change_requests.decided_by",
  "vacation_change_requests.submitted_by",
  "vacation_entitlements.advance_approved_by",
  "vacation_requests.level1_by",
  "vacation_requests.reviewed_by",
  "vacation_requests.submitted_by",
  "work_hours.last_edited_by",
  "work_hours_remarks.resolved_by",
  "kadr_grid_editor_allowlist.email",
  "kadr_salary_viewer_allowlist.email",
  "kadr_vacation_editor_allowlist.email",
];

/**
 * Kolone vezane na sekvencu (izmereno `pg_get_serial_sequence`). Posle upisa se
 * sekvenca u ODREDIŠTU pomera na `max(kolona)` — inače prvi upis iz 3.0 pada na
 * `duplicate key`. `--verify-only` to proverava kao zasebnu stavku.
 */
const SEQUENCE_COLUMNS: [string, string][] = [
  ["attendance_events", "id"],
  ["competence_groups", "id"],
  ["competence_levels", "id"],
  ["competence_profiles", "id"],
  ["competence_questions", "id"],
  ["competences", "id"],
  ["departments", "id"],
  ["job_positions", "id"],
  ["kadr_audit_log", "id"],
  ["profile_groups", "id"],
  ["profile_positions", "id"],
  ["sub_departments", "id"],
];

// ---------------------------------------------------------------------------
// Izveštaj
// ---------------------------------------------------------------------------

interface StepReport {
  read: number;
  changed: number;
  inserted: number;
  updated: number;
  skipped: number;
  ms: number;
  napomene: Record<string, string[]>;
}
const report: Record<string, StepReport> = {};

/**
 * Blokade su podeljene po tome ŠTA ZAUSTAVLJAJU — jer nisu iste težine:
 *   `struktura` — tabela/kolona/PK se razišao. Upis se NE POKREĆE (bio bi nepotpun,
 *                 a `count(*)` bi se poklapao pa se ne bi videlo).
 *   `identitet`  — nalog bez parnjaka, mrtav mejl u allowlist-u. Ispisuje se GLASNO i
 *                 obara izlazni kod (runbook traži praznu sekciju pre produkcije), ali
 *                 NE zaustavlja prenos 510k redova zbog jednog mrtvog reda.
 *   `verifikacija` — count/checksum/sekvenca se ne poklapa (nastaje posle upisa).
 * 🔴 Ni jedna vrsta se NIKAD ne prećutkuje: „prijavljeno kao blokada, ne tiho
 * preskočeno" je izričit uslov ovog posla.
 */
type Tezina = "struktura" | "identitet" | "verifikacija";
const blockers: { tezina: Tezina; msg: string }[] = [];

function step(name: string): StepReport {
  const s: StepReport = {
    read: 0,
    changed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    ms: 0,
    napomene: {},
  };
  report[name] = s;
  return s;
}
function note(s: StepReport, kat: string, kljuc: string): void {
  (s.napomene[kat] ??= []).push(kljuc);
}
function blokada(tezina: Tezina, msg: string): void {
  if (!blockers.some((b) => b.msg === msg)) blockers.push({ tezina, msg });
}
function imaStrukturnihBlokada(): boolean {
  return blockers.some((b) => b.tezina === "struktura");
}

// ---------------------------------------------------------------------------
// Introspekcija: kolone, tipovi i PK — čita se iz BAZE, ne pretpostavlja
// ---------------------------------------------------------------------------

interface ColInfo {
  name: string;
  /** `format_type` — npr. `text`, `numeric(10,2)`, `timestamp with time zone`. */
  type: string;
  notNull: boolean;
  /**
   * `pg_attribute.attidentity`: `'a'` = GENERATED ALWAYS, `'d'` = BY DEFAULT, `''` = nije.
   *
   * 🔴 Zašto se ovo MERI: `attendance_events.id` je u sy15 `GENERATED ALWAYS AS IDENTITY`
   * (izmereno — u celoj `public` šemi takve su samo `attendance_events.id` i
   * `scada_alarms.id`). Postgres tada odbija eksplicitan `id` sa
   * `428C9 cannot insert a non-DEFAULT value into column "id"` — a to je JEDINA tabela
   * domena kojoj se ključ MORA preneti 1:1 (491k redova, kursor i idempotencija visе
   * o njemu). Rešenje je `OVERRIDING SYSTEM VALUE`, i dodaje se samo gde treba.
   */
  identity: string;
}
interface TableInfo {
  columns: ColInfo[];
  byName: Map<string, ColInfo>;
  pk: string[];
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Ponavljanje na PREKID VEZE — i samo na njega.
 *
 * 🔴 Izmereno tokom ovog posla: prolaz kroz 491k redova preko VPN-a je tri puta pao na
 * `Can't reach database server` iako je TCP port bio otvoren, SSH radio, a baza
 * primala konekcije (`pg_isready` OK). To je poznata klasa: WireGuard prekine sesiju,
 * a Prisma to prijavi kao „server nedostupan". Migracija koja zbog toga mora ispočetka
 * nije upotrebljiva na 140 MB.
 *
 * Ponavlja se SAMO greška veze (`P1001`/`P1017`, `Can't reach`, `ECONNRESET`,
 * `Connection reset`). Greške podataka (FK, tip, duplikat) se NE ponavljaju nego dižu
 * odmah — one su nalaz, ne smetnja.
 */
function jeGreskaVeze(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message}` : String(e);
  const kod = (e as { code?: string })?.code ?? "";
  return (
    kod === "P1001" ||
    kod === "P1017" ||
    /Can't reach database server/i.test(m) ||
    /ECONNRESET|Connection reset|Connection terminated|server closed the connection/i.test(
      m,
    )
  );
}

const RETRY_MAX = 5;

async function saPonavljanjem<T>(
  opis: string,
  op: () => Promise<T>,
): Promise<T> {
  let poslednja: unknown;
  for (let pokusaj = 1; pokusaj <= RETRY_MAX; pokusaj += 1) {
    try {
      return await op();
    } catch (e) {
      poslednja = e;
      if (!jeGreskaVeze(e)) throw e;
      const pauza = Math.min(1000 * 2 ** (pokusaj - 1), 15000);
      console.log(
        `    ! veza pala (${opis}), pokušaj ${pokusaj}/${RETRY_MAX} — čekam ${pauza}ms`,
      );
      await new Promise((r) => setTimeout(r, pauza));
    }
  }
  throw poslednja;
}

/** Kolone + tipovi + PK za spisak tabela, iz `pg_catalog` date baze. */
async function introspect(
  client: RawClient,
  tables: string[],
): Promise<Map<string, TableInfo>> {
  const list = tables.map((t) => `'${t}'`).join(",");
  const cols = await client.$queryRawUnsafe<
    {
      tabela: string;
      kolona: string;
      tip: string;
      notnull: boolean;
      identitet: string;
      poz: number;
    }[]
  >(`
    SELECT c.relname AS tabela, a.attname AS kolona,
           format_type(a.atttypid, a.atttypmod) AS tip,
           a.attnotnull AS notnull, a.attidentity::text AS identitet, a.attnum AS poz
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname IN (${list})
    ORDER BY c.relname, a.attnum
  `);
  const pks = await client.$queryRawUnsafe<
    { tabela: string; kolone: string[] }[]
  >(`
    SELECT c.relname AS tabela,
           array_agg(a.attname ORDER BY k.ord) AS kolone
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY k(att, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.att
    WHERE n.nspname = 'public' AND con.contype = 'p' AND c.relname IN (${list})
    GROUP BY c.relname
  `);
  const pkByTable = new Map(pks.map((p) => [p.tabela, p.kolone]));

  const out = new Map<string, TableInfo>();
  for (const row of cols) {
    let info = out.get(row.tabela);
    if (!info) {
      info = {
        columns: [],
        byName: new Map(),
        pk: pkByTable.get(row.tabela) ?? [],
      };
      out.set(row.tabela, info);
    }
    const ci: ColInfo = {
      name: row.kolona,
      type: row.tip,
      notNull: row.notnull,
      identity: row.identitet,
    };
    info.columns.push(ci);
    info.byName.set(ci.name, ci);
  }
  return out;
}

/**
 * Kontrola spiska `USER_UUID_COLUMNS`: da li u domenu postoji `uuid` kolona sa FK na
 * `auth.users` koja NIJE u spisku. Ako postoji — BLOKADA, jer bi se nalog tiho izgubio.
 */
async function proveriUuidKoloneNaloga(
  sy15: RawClient,
  tables: string[],
): Promise<void> {
  const list = tables.map((t) => `'${t}'`).join(",");
  const rows = await sy15.$queryRawUnsafe<{ kolona: string }[]>(`
    SELECT ch.relname || '.' || a.attname AS kolona
    FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_namespace chn ON chn.oid = ch.relnamespace
    JOIN pg_class pa ON pa.oid = c.confrelid
    JOIN pg_namespace pan ON pan.oid = pa.relnamespace
    JOIN unnest(c.conkey) WITH ORDINALITY k(att, ord) ON true
    JOIN pg_attribute a ON a.attrelid = ch.oid AND a.attnum = k.att
    WHERE c.contype = 'f' AND chn.nspname = 'public'
      AND pan.nspname = 'auth' AND pa.relname = 'users'
      AND ch.relname IN (${list})
  `);
  for (const r of rows) {
    if (!USER_UUID_COLUMNS.has(r.kolona)) {
      blokada(
        "struktura",
        `${r.kolona} ima FK na auth.users a NIJE u USER_UUID_COLUMNS — nalog bi se ` +
          `preneo kao sirov uuid ili pao na tip. Dodaj u spisak pa ponovi.`,
      );
    }
  }
}

/**
 * 🔴 Redosled tabela se MERI, ne veruje se spisku.
 *
 * `TABLES` je ručno topološki poređan i zato je pogrešiv: prva verzija je
 * `profile_groups`/`profile_positions` stavila uz organizaciju (jer im ime počinje sa
 * „profile"), a one gađaju `competence_groups`/`competence_profiles` — prenos je pao
 * na `23503`. Pad je bio bučan i to je dobro, ali se dogodio POSLE 45 minuta prolaza.
 *
 * Ova provera čita FK graf iz žive baze i traži da roditelj stoji PRE deteta. Prijavljuje
 * SVE prekršaje odjednom (ne prvi pa stani) i kao `struktura` — dakle zaustavlja upis
 * PRE nego što je bilo šta upisano.
 */
async function proveriRedosled(
  sy15: RawClient,
  imena: string[],
): Promise<void> {
  const list = imena.map((t) => `'${t}'`).join(",");
  const rows = await sy15.$queryRawUnsafe<
    { dete: string; roditelj: string; kolona: string }[]
  >(`
    SELECT DISTINCT ch.relname AS dete, pa.relname AS roditelj, a.attname AS kolona
    FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class pa ON pa.oid = c.confrelid
    JOIN pg_namespace chn ON chn.oid = ch.relnamespace
    JOIN pg_namespace pan ON pan.oid = pa.relnamespace
    JOIN unnest(c.conkey) WITH ORDINALITY k(att, ord) ON true
    JOIN pg_attribute a ON a.attrelid = ch.oid AND a.attnum = k.att
    WHERE c.contype = 'f' AND chn.nspname = 'public' AND pan.nspname = 'public'
      AND ch.relname IN (${list}) AND pa.relname IN (${list})
  `);
  const poz = new Map(imena.map((t, i) => [t, i]));
  for (const r of rows) {
    if (r.dete === r.roditelj) continue; // samoreferentni FK — rešava `ORDER BY`, ne redosled tabela
    const pd = poz.get(r.dete);
    const pr = poz.get(r.roditelj);
    if (pd === undefined || pr === undefined) continue;
    if (pr >= pd) {
      blokada(
        "struktura",
        `Redosled: "${r.dete}" (${r.kolona}) gađa "${r.roditelj}", a roditelj stoji ` +
          `POSLE deteta u TABLES — upis bi pao na 23503. Premesti "${r.roditelj}" iznad.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Kanonsko renderovanje vrednosti u tekst
// ---------------------------------------------------------------------------

/**
 * Zašto se SVE čita kao tekst: JS round-trip preko Prisma raw tipova je mesto tihe
 * greške (`bigint` puca na `JSON.stringify`, `time without time zone` se vrati kao
 * `Date` pa se ne da upisati, `numeric` prolazi kroz `Number` i gubi cifre). Tekst je
 * jedini oblik koji Postgres i pročita i vrati BIT-IDENTIČNO, uz eksplicitan `cast`
 * na upisu.
 *
 * Uz to, render je namerno NEZAVISAN od sesijskih podešavanja (`TimeZone`, `DateStyle`):
 * `timestamptz` se ne pušta kroz `::text` (to bi zavisilo od zone konekcije) nego kroz
 * `to_char(… AT TIME ZONE 'UTC', …)`. Tako se checksum izvora i odredišta poredi bez
 * zavisnosti od toga kako je koji server podešen.
 * 🔴 Ovo je direktna posledica pouke „vremena u bazi su UTC bez zone" — zona se
 * ISPISUJE u vrednosti, ne pretpostavlja.
 */
function renderExpr(col: string, type: string): string {
  const q = `"${col}"`;
  switch (type) {
    case "timestamp with time zone":
      return `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00"')`;
    case "timestamp without time zone":
      return `to_char(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
    case "date":
      return `to_char(${q}, 'YYYY-MM-DD')`;
    case "time without time zone":
      return `to_char(${q}, 'HH24:MI:SS.US')`;
    default:
      return `${q}::text`;
  }
}

/** Upis: tekst iz JSON-a vraćen u pravi tip odredišne kolone. */
function castExpr(col: string, type: string): string {
  return `x."${col}"::${type}`;
}

// ---------------------------------------------------------------------------
// Stanje prenosa (nastavak posle prekida)
// ---------------------------------------------------------------------------

/**
 * 🔴 Dva ODVOJENA naredbena stringa, ne jedan sa `;` — Prisma svaki
 * `$executeRawUnsafe` šalje kao PREPARED statement, a Postgres tada odbija više
 * naredbi: `42601 cannot insert multiple commands into a prepared statement`.
 * (Sudareno u prvom prolazu 08.08.2026.)
 */
const STANJE_DDL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS kadr_seoba`,
  `CREATE TABLE IF NOT EXISTS kadr_seoba.prenos_stanje (
     tabela          text PRIMARY KEY,
     poslednji_kljuc jsonb,
     redova          bigint NOT NULL DEFAULT 0,
     zavrseno        boolean NOT NULL DEFAULT false,
     azurirano       timestamptz NOT NULL DEFAULT now()
   )`,
];

async function ucitajStanje(
  dst: RawClient,
  tabela: string,
): Promise<string[] | null> {
  const rows = await dst.$queryRawUnsafe<
    { poslednji_kljuc: string[] | null }[]
  >(
    `SELECT poslednji_kljuc FROM kadr_seoba.prenos_stanje
      WHERE tabela = $1 AND zavrseno = false`,
    tabela,
  );
  return rows[0]?.poslednji_kljuc ?? null;
}

async function upisiStanje(
  dst: RawClient,
  tabela: string,
  kljuc: string[] | null,
  redova: number,
  zavrseno: boolean,
): Promise<void> {
  await dst.$executeRawUnsafe(
    `INSERT INTO kadr_seoba.prenos_stanje (tabela, poslednji_kljuc, redova, zavrseno, azurirano)
       VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (tabela) DO UPDATE
       SET poslednji_kljuc = EXCLUDED.poslednji_kljuc,
           redova = EXCLUDED.redova,
           zavrseno = EXCLUDED.zavrseno,
           azurirano = now()`,
    tabela,
    kljuc === null ? null : JSON.stringify(kljuc),
    redova,
    zavrseno,
  );
}

// ---------------------------------------------------------------------------
// Provera identiteta (mejlovi u tekst kolonama + uuid nalozi)
// ---------------------------------------------------------------------------

interface IdentitetNalaz {
  mejlova: number;
  bezParnjaka: string[];
  sistemskiPecati: string[];
}

/**
 * Skuplja SVE različite vrednosti iz 40+ „actor" tekst kolona i deli ih na tri korpe:
 * mejl sa parnjakom, mejl BEZ parnjaka (BLOKADA) i vrednost koja nije mejl (pečat
 * sistemskog upisa — ispisuje se, ne blokira). Vrednost bez `@` se NE traži u
 * `users` jer to nikad nije bio nalog (`auto:kapija`, `import-jun-2026`, …).
 */
async function proveriMejlove(
  sy15: RawClient,
  users: UserMaps,
  tabele: Set<string>,
  info: Map<string, TableInfo>,
): Promise<IdentitetNalaz> {
  const delovi: string[] = [];
  for (const tc of ACTOR_EMAIL_COLUMNS) {
    const [t, c] = tc.split(".");
    if (!tabele.has(t)) continue;
    if (!info.get(t)?.byName.has(c)) continue;
    delovi.push(
      `SELECT DISTINCT '${tc}'::text AS izvor, "${c}"::text AS v FROM public."${t}" WHERE "${c}" IS NOT NULL`,
    );
  }
  if (delovi.length === 0)
    return { mejlova: 0, bezParnjaka: [], sistemskiPecati: [] };

  const rows = await sy15.$queryRawUnsafe<{ izvor: string; v: string }[]>(
    delovi.join(" UNION "),
  );
  const mejlovi = new Set<string>();
  const bezParnjaka = new Set<string>();
  const pecati = new Set<string>();
  for (const r of rows) {
    const v = r.v.trim();
    if (v === "") continue;
    if (!v.includes("@")) {
      pecati.add(`${v}  (${r.izvor})`);
      continue;
    }
    const e = normEmail(v);
    if (e === null) continue;
    mejlovi.add(e);
    if (!users.byEmail.has(e)) bezParnjaka.add(`${e}  (${r.izvor})`);
  }
  for (const b of bezParnjaka) {
    blokada(
      "identitet",
      `Mejl "${b}" stoji u kadrovskoj kao upisivač/odobravalac, a u 3.0 "users" ` +
        `NEMA nalog s tim mejlom. Posle preklopa taj potpis nije nikome vezan — ` +
        `napravi nalog ili odluči šta sa redovima. NE preskačem tiho.`,
    );
  }
  return {
    mejlova: mejlovi.size,
    bezParnjaka: [...bezParnjaka].sort(),
    sistemskiPecati: [...pecati].sort(),
  };
}

// ---------------------------------------------------------------------------
// PRENOS
// ---------------------------------------------------------------------------

interface Plan {
  spec: TableSpec;
  /** Kolone koje se prenose (ime + tip u ODREDIŠTU). */
  cols: ColInfo[];
  /** Tip iste kolone u IZVORU — čitanje se renderuje po IZVORNOM tipu, ne odredišnom. */
  srcTypes: Map<string, string>;
  /** Kolone koje se prevode uuid -> users.id. */
  userCols: Set<string>;
  pk: string[];
  /** Tipovi PK kolona u IZVORU (za `cast` kursora). */
  pkTypes: string[];
}

/**
 * Pravi plan po tabeli i GLASNO prijavljuje svaku razliku u kolonama. Ovo je brana
 * koja u održavanju stoji na DMMF-u: kolona koja se raziđe ne sme tiho da otpadne.
 */
function napraviPlan(
  spec: TableSpec,
  src: TableInfo | undefined,
  dst: TableInfo | undefined,
): Plan | null {
  if (!src) {
    blokada(
      "struktura",
      `Tabela ${spec.table} ne postoji u IZVORU — nema šta da se prenese.`,
    );
    return null;
  }
  if (!dst) {
    blokada(
      "struktura",
      `Tabela ${spec.table} ne postoji u ODREDIŠTU — Prisma šema kadrovske još nije ` +
        `primenjena. Prenos te tabele je nemoguć (nije preskočen, nego blokiran).`,
    );
    return null;
  }
  const skip = spec.skip ?? {};
  const cols: ColInfo[] = [];
  for (const dc of dst.columns) {
    if (skip[dc.name] !== undefined) continue;
    const sc = src.byName.get(dc.name);
    if (!sc) {
      blokada(
        "struktura",
        `${spec.table}.${dc.name} postoji u ODREDIŠTU a NEMA je u izvoru — mapiranje ` +
          `se razišlo (proveri ime kolone). Tabela se ne prenosi.`,
      );
      return null;
    }
    cols.push(dc);
  }
  for (const sc of src.columns) {
    if (skip[sc.name] !== undefined) continue;
    if (!dst.byName.has(sc.name)) {
      blokada(
        "struktura",
        `${spec.table}.${sc.name} postoji u IZVORU a NEMA je u odredištu — podatak bi ` +
          `se TIHO izgubio. Dodaj kolonu ili je upiši u \`skip\` sa razlogom.`,
      );
      return null;
    }
  }
  if (src.pk.length === 0) {
    blokada(
      "struktura",
      `${spec.table} nema PK u izvoru — upsert nema po čemu da se hvata.`,
    );
    return null;
  }
  if (dst.pk.join(",") !== src.pk.join(",")) {
    blokada(
      "struktura",
      `${spec.table}: PK se razlikuje (izvor ${src.pk.join("+")} / odredište ` +
        `${dst.pk.join("+") || "nema"}) — upsert bi duplirao redove.`,
    );
    return null;
  }
  const userCols = new Set(
    cols
      .filter((c) => USER_UUID_COLUMNS.has(`${spec.table}.${c.name}`))
      .map((c) => c.name),
  );
  return {
    spec,
    cols,
    srcTypes: new Map(
      cols.map((c) => [c.name, src.byName.get(c.name)?.type ?? "text"]),
    ),
    userCols,
    pk: src.pk,
    pkTypes: src.pk.map((k) => src.byName.get(k)?.type ?? "text"),
  };
}

/** Jedna tabela: keyset paging po PK, upsert po paketu, merenje vremena. */
async function prenesiTabelu(
  dstPrisma: RawClient,
  sy15: RawClient,
  users: UserMaps,
  plan: Plan,
  dstInfo: TableInfo,
): Promise<void> {
  const { spec, cols, srcTypes, userCols, pk, pkTypes } = plan;
  const s = step(spec.table);
  const batch = BATCH_OVERRIDE ?? spec.batch ?? 2000;
  const t0 = Date.now();

  // SELECT: sve kolone kao tekst, kanonski i po IZVORNOM tipu (kod user kolona je
  // izvorni tip `uuid`, a odredišni `integer` — render se mora voditi izvorom).
  const srcSelect = cols
    .map(
      (c) =>
        `${renderExpr(c.name, srcTypes.get(c.name) ?? "text")} AS "${c.name}"`,
    )
    .join(", ");

  /**
   * 🔴 `ORDER BY` MORA biti kvalifikovan aliasom tabele (`s."id"`), nikad golo `"id"`.
   *
   * Postgres kod `ORDER BY` prvo gleda IZLAZNE aliase, pa tek onda kolone tabele. Kolone
   * se ovde čitaju kao tekst (`"id"::text AS "id"`), pa golo `ORDER BY "id"` veže se za
   * TEKSTUALNI izlaz i sortira leksikografski: 1, 10, 100, 1000, 10000, 100000…
   * `WHERE` te aliase NE vidi, pa se kursor poredi NUMERIČKI — i dva poretka se raziđu.
   *
   * Izmereno na probnoj bazi (prvi pun prolaz 08.08.2026): od 491.278 redova preneto je
   * 391.781, a **99.497 redova je TIHO preskočeno**; u odredištu su ostali baš id-jevi
   * 1, 10, 100, 104, 1000, 1044, 10000, 10449, 100000… — potpis leksikografskog poretka.
   * Uhvatila ga je verifikacija (`!!! attendance_events 491278 vs 391781`, i checksum),
   * ne prolaz — zato verifikacija i postoji.
   *
   * Ispod je, uz alias, i BRANA na nivou tabele (`s.read` vs `count(*)` izvora), da se
   * ovakav promašaj vidi ODMAH kod te tabele, a ne tek na kraju celog prolaza.
   */
  const orderBy = pk.map((k) => `s."${k}"`).join(", ");
  const orderByKursor = pk.map((k) => `s."${k}"`).join(", ");

  // UPSERT: jedan `jsonb` parametar (nema granice od 65535 vezanih parametara),
  // pa `cast` na tip odredišne kolone. `WHERE … IS DISTINCT FROM …` je ono što
  // ponovnom prolazu daje NULA izmena — bez njega bi svaki prolaz „ažurirao" sve.
  const defList = cols.map((c) => `"${c.name}" text`).join(", ");
  const insertCols = cols.map((c) => `"${c.name}"`).join(", ");
  const selectCast = cols
    .map((c) => castExpr(c.name, dstInfo.byName.get(c.name)?.type ?? "text"))
    .join(", ");
  const setList = cols
    .filter((c) => !pk.includes(c.name))
    .map((c) => `"${c.name}" = EXCLUDED."${c.name}"`)
    .join(", ");
  // `GENERATED ALWAYS AS IDENTITY` odbija eksplicitnu vrednost bez ovog dodatka.
  // Dodaje se SAMO kad je izmereno da je kolona takva — ne „za svaki slučaj", jer bi
  // inače tiho gazio i `GENERATED ALWAYS` kolone koje NE želimo da pregazimo.
  const overriding = cols.some(
    (c) => dstInfo.byName.get(c.name)?.identity === "a",
  )
    ? " OVERRIDING SYSTEM VALUE"
    : "";
  const upsertSql =
    `INSERT INTO public."${spec.table}" AS t (${insertCols})${overriding}\n` +
    `SELECT ${selectCast} FROM jsonb_to_recordset($1::jsonb) AS x(${defList})\n` +
    (setList === ""
      ? // Tabela u kojoj su SVE kolone deo PK — nema šta da se ažurira.
        `ON CONFLICT (${pk.map((k) => `"${k}"`).join(", ")}) DO NOTHING\n`
      : `ON CONFLICT (${pk.map((k) => `"${k}"`).join(", ")}) DO UPDATE SET ${setList}\n` +
        `  WHERE (t.*) IS DISTINCT FROM (EXCLUDED.*)\n`) +
    `RETURNING (t.xmax = 0) AS je_novi`;

  let cursor: string[] | null =
    RESUME && APPLY ? await ucitajStanje(dstPrisma, spec.table) : null;
  if (cursor !== null) note(s, "nastavak-od-kursora", cursor.join("/"));

  for (;;) {
    const where =
      cursor === null
        ? ""
        : ` WHERE (${orderByKursor}) > (${pkTypes.map((t, i) => `$${i + 1}::${t}`).join(", ")})`;
    const kursorParam = cursor;
    const rows: Record<string, string | null>[] = await saPonavljanjem(
      `čitanje ${spec.table}`,
      () =>
        sy15.$queryRawUnsafe(
          `SELECT ${srcSelect} FROM public."${spec.table}" AS s${where}` +
            ` ORDER BY ${orderBy} LIMIT ${batch}`,
          ...(kursorParam ?? []),
        ),
    );
    if (rows.length === 0) break;
    s.read += rows.length;

    // Prevod naloga uuid -> users.id. Radi se u JS-u jer mapa živi u aplikaciji.
    const zaUpis: Record<string, string | null>[] = [];
    for (const r of rows) {
      let preskoci = false;
      for (const uc of userCols) {
        const raw = r[uc];
        if (raw == null) continue;
        const id = users.byAuthUuid.get(raw.toLowerCase());
        if (id === undefined) {
          note(
            s,
            "nalog-nerazresen",
            `${pk.map((k) => r[k]).join("/")}.${uc} -> ${raw}`,
          );
          const notNull = dstInfo.byName.get(uc)?.notNull === true;
          if (notNull) {
            blokada(
              "identitet",
              `${spec.table}.${uc} (red ${pk.map((k) => r[k]).join("/")}) pokazuje na ` +
                `auth.users ${raw} koji NEMA parnjaka u 3.0 users, a kolona je NOT NULL — ` +
                `red se ne može preneti bez podmetanja tuđeg naloga.`,
            );
            preskoci = true;
          }
          r[uc] = null;
          continue;
        }
        r[uc] = String(id);
      }
      if (preskoci) s.skipped += 1;
      else zaUpis.push(r);
    }

    if (APPLY && zaUpis.length > 0) {
      // Ponavljanje je bezbedno baš zato što je upis UPSERT: paket koji je možda
      // delimično prošao pre pada veze se ponovnim slanjem samo poravna, ne duplira.
      const res = await saPonavljanjem(`upis ${spec.table}`, () =>
        dstPrisma.$queryRawUnsafe<{ je_novi: boolean }[]>(
          upsertSql,
          JSON.stringify(zaUpis),
        ),
      );
      for (const r of res) {
        if (r.je_novi) s.inserted += 1;
        else s.updated += 1;
      }
      s.changed += res.length;
    }

    cursor = pk.map((k) => rows[rows.length - 1][k] as string);
    if (APPLY)
      await saPonavljanjem("upis stanja", () =>
        upisiStanje(dstPrisma, spec.table, cursor, s.read, false),
      );
    if (rows.length < batch) break;

    // Napredak samo za tabele koje traju — da ispis ne postane šum.
    if (s.read % (batch * 10) === 0) {
      const brzina = Math.round(s.read / ((Date.now() - t0) / 1000));
      console.log(`    … ${spec.table}: ${s.read} redova, ${brzina} red/s`);
    }
  }

  if (APPLY)
    await saPonavljanjem("upis stanja", () =>
      upisiStanje(dstPrisma, spec.table, null, s.read, true),
    );
  s.ms = Date.now() - t0;

  /**
   * 🔴 BRANA: da li je paging stvarno prošao KROZ SVE redove.
   *
   * Bez ove provere promašaj kursora (v. komentar uz `orderBy`) ostaje nevidljiv sve do
   * kraja prolaza, a na 65 tabela to je dugo. Poređenje je namerno sa `count(*)` izvora
   * uzetim POSLE prolaza: izvor se menja uživo (kapija), pa se dozvoljava da je izvor
   * NARASTAO (novi redovi > kursora), ali se MANJAK prijavljuje kao blokada.
   */
  const [{ n }] = await saPonavljanjem(`brojanje ${spec.table}`, () =>
    sy15.$queryRawUnsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM public."${spec.table}"`,
    ),
  );
  const uIzvoru = Number(n);
  if (s.read < uIzvoru - s.skipped) {
    blokada(
      "struktura",
      `${spec.table}: pročitano ${s.read} redova, a izvor ih ima ${uIzvoru} — paging je ` +
        `PRESKOČIO ${uIzvoru - s.read} redova. To je greška kursora/sortiranja, ne ` +
        `posledica živog upisa (živi upis može samo da DODA redove iznad kursora).`,
    );
  }
}

// ---------------------------------------------------------------------------
// VERIFIKACIJA: count + checksum + sekvence + nalozi
// ---------------------------------------------------------------------------

/**
 * `count(*)` + md5 preko SVIH prenetih kolona.
 *
 * 🔴 Zašto checksum a ne samo count: promašena kolona (ili red kome se izmenila
 * vrednost) ostavlja broj redova NEPROMENJEN. Održavanje je verifikovano samo po
 * `count(*)` i to bi takav promašaj propustilo — ovde ne.
 *
 * Red se svodi na `md5` spoja svih kolona (kanonski render), a tabela na `md5`
 * spoja SORTIRANIH heševa redova — pa rezultat ne zavisi od fizičkog reda redova.
 * `quote_nullable` razlikuje NULL od praznog stringa (`concat_ws` bi ih spojio isto).
 *
 * User kolone (uuid u izvoru / Int u odredištu) se IZ HEŠA IZUZIMAJU i proveravaju
 * zasebno, jer im se tip i vrednost namerno razlikuju.
 */
function checksumSql(
  tabela: string,
  cols: ColInfo[],
  izuzmi: Set<string>,
): string {
  const izrazi = cols
    .filter((c) => !izuzmi.has(c.name))
    .map((c) => `quote_nullable(${renderExpr(c.name, c.type)})`);
  return `
    SELECT count(*)::text AS n,
           coalesce(md5(string_agg(h, '' ORDER BY h)), '(prazno)') AS chk
    FROM (SELECT md5(concat_ws(chr(31), ${izrazi.join(", ")})) AS h
            FROM public."${tabela}") q`;
}

async function verifikuj(
  dstPrisma: RawClient,
  sy15: RawClient,
  users: UserMaps,
  planovi: Plan[],
  srcInfo: Map<string, TableInfo>,
  dstInfo: Map<string, TableInfo>,
): Promise<void> {
  let ok = 0;
  let lose = 0;
  console.log(
    `${"tabela".padEnd(32)} ${"izvor".padStart(8)} ${"3.0".padStart(8)}  checksum`,
  );
  for (const plan of planovi) {
    const t = plan.spec.table;
    const srcCols = plan.cols.map(
      (c) => srcInfo.get(t)?.byName.get(c.name) ?? c,
    );
    const [sRow] = await sy15.$queryRawUnsafe<{ n: string; chk: string }[]>(
      checksumSql(t, srcCols, plan.userCols),
    );
    const [dRow] = await dstPrisma.$queryRawUnsafe<
      { n: string; chk: string }[]
    >(checksumSql(t, plan.cols, plan.userCols));
    const brojOk = sRow.n === dRow.n;
    const chkOk = sRow.chk === dRow.chk;
    const mark = brojOk && chkOk ? "OK  " : "!!! ";
    if (brojOk && chkOk) ok += 1;
    else lose += 1;
    console.log(
      `${mark}${t.padEnd(32)} ${sRow.n.padStart(8)} ${dRow.n.padStart(8)}  ` +
        `${chkOk ? "poklapa se" : `RAZLIKA (${sRow.chk.slice(0, 8)} vs ${dRow.chk.slice(0, 8)})`}`,
    );
    if (!brojOk) {
      blokada(
        "verifikacija",
        `${t}: broj redova se ne poklapa (izvor ${sRow.n}, 3.0 ${dRow.n}).`,
      );
    }
    if (!chkOk) {
      blokada(
        "verifikacija",
        `${t}: checksum se ne poklapa — ${
          brojOk
            ? "broj redova JE isti, a SADRŽAJ različit (to `count(*)` ne bi uhvatio)"
            : "uz to se razlikuje i broj redova"
        }. Pokreni sa --detalji da vidiš koji ključevi.`,
      );
      if (DETALJI) await ispisiRazlike(dstPrisma, sy15, plan, srcCols);
    }
  }
  console.log(
    `\n  poklapa se: ${ok}/${planovi.length}${lose > 0 ? `  RAZLIKA: ${lose}` : ""}`,
  );

  await verifikujNaloge(dstPrisma, sy15, users, planovi, dstInfo);
  await verifikujSekvence(dstPrisma, sy15);
}

/** Koji ključevi se razlikuju — poredi heševe redova po PK, sa obe strane. */
async function ispisiRazlike(
  dstPrisma: RawClient,
  sy15: RawClient,
  plan: Plan,
  srcCols: ColInfo[],
): Promise<void> {
  const t = plan.spec.table;
  const pkIzraz = plan.pk.map((k) => `"${k}"::text`).join(` || '/' || `);
  const sql = (cols: ColInfo[]): string => {
    const izrazi = cols
      .filter((c) => !plan.userCols.has(c.name))
      .map((c) => `quote_nullable(${renderExpr(c.name, c.type)})`);
    return `SELECT ${pkIzraz} AS k, md5(concat_ws(chr(31), ${izrazi.join(", ")})) AS h
              FROM public."${t}"`;
  };
  const s = await sy15.$queryRawUnsafe<{ k: string; h: string }[]>(
    sql(srcCols),
  );
  const d = await dstPrisma.$queryRawUnsafe<{ k: string; h: string }[]>(
    sql(plan.cols),
  );
  const dm = new Map(d.map((r) => [r.k, r.h]));
  const razlike: string[] = [];
  for (const r of s) {
    const h = dm.get(r.k);
    if (h === undefined) razlike.push(`${r.k}: nema ga u 3.0`);
    else if (h !== r.h) razlike.push(`${r.k}: sadržaj različit`);
    dm.delete(r.k);
  }
  for (const k of dm.keys()) razlike.push(`${k}: ima ga SAMO u 3.0`);
  console.log(`      razlika u ${razlike.length} redova, prvih 10:`);
  for (const r of razlike.slice(0, 10)) console.log(`        - ${r}`);
}

/** User kolone: uuid iz izvora, kroz mapu, mora dati tačno onaj Int koji stoji u 3.0. */
async function verifikujNaloge(
  dstPrisma: RawClient,
  sy15: RawClient,
  users: UserMaps,
  planovi: Plan[],
  dstInfo: Map<string, TableInfo>,
): Promise<void> {
  console.log("\n--- NALOZI U KOLONAMA (uuid -> users.id) ---");
  for (const plan of planovi) {
    for (const uc of plan.userCols) {
      const t = plan.spec.table;
      const pkIzraz = plan.pk.map((k) => `"${k}"::text`).join(` || '/' || `);
      const src = await sy15.$queryRawUnsafe<{ k: string; v: string }[]>(
        `SELECT ${pkIzraz} AS k, "${uc}"::text AS v FROM public."${t}" WHERE "${uc}" IS NOT NULL`,
      );
      const dst = await dstPrisma.$queryRawUnsafe<{ k: string; v: string }[]>(
        `SELECT ${pkIzraz} AS k, "${uc}"::text AS v FROM public."${t}" WHERE "${uc}" IS NOT NULL`,
      );
      const dm = new Map(dst.map((r) => [r.k, r.v]));
      let poklapa = 0;
      const lose: string[] = [];
      for (const r of src) {
        const ocekivano = users.byAuthUuid.get(r.v.toLowerCase());
        if (ocekivano === undefined) continue; // nerazrešeno -> NULL, već prijavljeno
        if (dm.get(r.k) === String(ocekivano)) poklapa += 1;
        else
          lose.push(
            `${r.k} (očekivano ${ocekivano}, u 3.0 ${dm.get(r.k) ?? "NULL"})`,
          );
      }
      const tip = dstInfo.get(t)?.byName.get(uc)?.type ?? "?";
      console.log(
        `${lose.length === 0 ? "OK  " : "!!! "}${`${t}.${uc}`.padEnd(40)} ` +
          `izvor=${src.length} preslikano=${poklapa} tip3.0=${tip}` +
          (lose.length > 0
            ? `  NE POKLAPA SE: ${lose.slice(0, 3).join("; ")}`
            : ""),
      );
      if (lose.length > 0) {
        blokada(
          "verifikacija",
          `${t}.${uc}: ${lose.length} redova ima pogrešno preslikan nalog.`,
        );
      }
    }
  }
}

/** Sekvence u odredištu moraju biti >= max(pk), inače prvi upis iz 3.0 pada. */
async function verifikujSekvence(
  dstPrisma: RawClient,
  sy15: RawClient,
): Promise<void> {
  console.log("\n--- SEKVENCE ---");
  for (const [tabela, kolona] of SEQUENCE_COLUMNS) {
    if (ONLY.length > 0 && !ONLY.includes(tabela)) continue;
    const [sMax] = await sy15.$queryRawUnsafe<{ m: string | null }[]>(
      `SELECT max("${kolona}")::text AS m FROM public."${tabela}"`,
    );
    let seq: string | null = null;
    let cur: string | null = null;
    try {
      const [r] = await dstPrisma.$queryRawUnsafe<{ s: string | null }[]>(
        `SELECT pg_get_serial_sequence('public.${tabela}', '${kolona}') AS s`,
      );
      seq = r?.s ?? null;
      if (seq !== null) {
        const [v] = await dstPrisma.$queryRawUnsafe<{ v: string }[]>(
          `SELECT last_value::text AS v FROM ${seq}`,
        );
        cur = v?.v ?? null;
      }
    } catch {
      seq = null;
    }
    if (seq === null) {
      console.log(
        `!!! ${`${tabela}.${kolona}`.padEnd(40)} u 3.0 NEMA sekvencu`,
      );
      blokada(
        "verifikacija",
        `${tabela}.${kolona}: u odredištu nema sekvencu — 3.0 ne ume da dodeli novi ` +
          `ključ (kolona je verovatno prosto \`integer\` bez \`autoincrement\`).`,
      );
      continue;
    }
    const maxSrc = sMax.m === null ? 0 : Number(sMax.m);
    const curVal = cur === null ? 0 : Number(cur);
    const ok = curVal >= maxSrc;
    console.log(
      `${ok ? "OK  " : "!!! "}${`${tabela}.${kolona}`.padEnd(40)} max_izvor=${maxSrc} sekvenca3.0=${curVal}`,
    );
    if (!ok) {
      blokada(
        "verifikacija",
        `Sekvenca za ${tabela}.${kolona} je na ${curVal}, a najveći preneti ključ je ` +
          `${maxSrc} — prvi upis iz 3.0 pada na "duplicate key" (ista zamka kao ` +
          `maint_wo_number_counter u održavanju).`,
      );
    }
  }
}

/**
 * Ime koraka za sekvence. Izdvojeno u konstantu jer se taj korak NE RAČUNA u zbir
 * „izmena" — inače bi `setval` (koji se izvrši i kad podaci nisu dirani) zamaglio
 * jedini signal idempotencije: „UKUPNO izmena=0".
 */
const KORAK_SEKVENCE = "(sekvence) setval";

/** Posle upisa: pomeri sekvence odredišta na max(pk). */
async function pomeriSekvence(dstPrisma: RawClient): Promise<void> {
  const s = step(KORAK_SEKVENCE);
  for (const [tabela, kolona] of SEQUENCE_COLUMNS) {
    if (ONLY.length > 0 && !ONLY.includes(tabela)) continue;
    const [r] = await dstPrisma.$queryRawUnsafe<{ s: string | null }[]>(
      `SELECT pg_get_serial_sequence('public.${tabela}', '${kolona}') AS s`,
    );
    if (!r?.s) {
      note(s, "nema-sekvencu", `${tabela}.${kolona}`);
      continue;
    }
    await dstPrisma.$executeRawUnsafe(
      `SELECT setval('${r.s}', GREATEST(coalesce((SELECT max("${kolona}") FROM public."${tabela}"), 0), 1),
              (SELECT count(*) FROM public."${tabela}") > 0)`,
    );
    s.changed += 1;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SY15_DATABASE_URL) {
    throw new Error("SY15_DATABASE_URL nije postavljen — nema izvora. Prekid.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nije postavljen — nema odredišta. Prekid.");
  }

  const prisma = new PrismaClient();
  const sy15 = new Sy15PrismaClient();
  const dstRaw = prisma as unknown as RawClient;
  const srcRaw = sy15 as unknown as RawClient;

  const mode = VERIFY_ONLY
    ? "VERIFY-ONLY"
    : SHOW_COLUMNS
      ? "SHOW-COLUMNS"
      : APPLY
        ? `APPLY (PIŠE!)${RESUME ? " + RESUME" : ""}`
        : "DRY-RUN";
  console.log(`\n=== migrate-kadrovska-sy15 :: ${mode} ===`);
  console.log(`izvor  (sy15): ${maskUrl(process.env.SY15_DATABASE_URL)}`);
  console.log(`odredište    : ${maskUrl(process.env.DATABASE_URL)}\n`);

  const t0 = Date.now();
  try {
    const specs = TABLES.filter(
      (t) => ONLY.length === 0 || ONLY.includes(t.table),
    );
    if (ONLY.length > 0) {
      const nepoznate = ONLY.filter((o) => !TABLES.some((t) => t.table === o));
      if (nepoznate.length > 0) {
        throw new Error(`--only: nepoznata tabela: ${nepoznate.join(", ")}`);
      }
    }
    const imena = specs.map((s) => s.table);

    const srcInfo = await saPonavljanjem("introspekcija izvora", () =>
      introspect(srcRaw, imena),
    );
    const dstInfo = await saPonavljanjem("introspekcija odredišta", () =>
      introspect(dstRaw, imena),
    );
    await proveriUuidKoloneNaloga(srcRaw, imena);
    // Redosled se proverava SAMO kad se prenosi ceo domen — `--only` namerno bira
    // podskup, pa bi „roditelj fali" bio lažna uzbuna.
    if (ONLY.length === 0) await proveriRedosled(srcRaw, imena);

    const planovi: Plan[] = [];
    for (const spec of specs) {
      const p = napraviPlan(
        spec,
        srcInfo.get(spec.table),
        dstInfo.get(spec.table),
      );
      if (p) planovi.push(p);
    }

    if (SHOW_COLUMNS) {
      prikaziKolone(planovi);
      ispisiBlokade();
      return;
    }

    // --- Korak 0: mapa identiteta ------------------------------------------
    const users = await buildUserMaps(prisma, sy15);
    console.log("--- MAPA IDENTITETA (korak 0) ---");
    console.log(`  3.0 users (po mejlu)          : ${users.byEmail.size}`);
    console.log(`  sy15 auth.users -> users.id   : ${users.byAuthUuid.size}`);
    console.log(
      `  sy15 auth.users BEZ parnjaka  : ${users.unmatchedAuthUuids.length}`,
    );
    for (const u of users.unmatchedAuthUuids) {
      console.log(`    ! ${u.email ?? "(bez mejla)"}  ${u.id}`);
    }
    const ident = await proveriMejlove(srcRaw, users, new Set(imena), srcInfo);
    console.log(`  mejlova u "actor" kolonama    : ${ident.mejlova}`);
    console.log(`  od toga bez naloga u 3.0     : ${ident.bezParnjaka.length}`);
    for (const b of ident.bezParnjaka) console.log(`    🔴 ${b}`);
    console.log(
      `  pečata sistemskog upisa      : ${ident.sistemskiPecati.length} (nisu nalozi, ne blokiraju)`,
    );
    for (const p of ident.sistemskiPecati) console.log(`     · ${p}`);
    console.log("");

    if (VERIFY_ONLY) {
      console.log("--- VERIFIKACIJA (count + checksum) ---");
      await verifikuj(dstRaw, srcRaw, users, planovi, srcInfo, dstInfo);
      ispisiBlokade();
      return;
    }

    if (APPLY) {
      for (const ddl of STANJE_DDL) await dstRaw.$executeRawUnsafe(ddl);
    }

    // Blokada u kolonama/PK znači da bi upis bio nepotpun — ne pišemo ništa.
    if (APPLY && imaStrukturnihBlokada()) {
      console.log(
        "🔴 STRUKTURNA blokada PRE upisa — ne pišem ništa. Spisak je ispod.",
      );
      ispisiBlokade();
      process.exitCode = 1;
      return;
    }

    console.log(`--- PRENOS (${planovi.length} tabela) ---`);
    for (const plan of planovi) {
      await prenesiTabelu(
        dstRaw,
        srcRaw,
        users,
        plan,
        dstInfo.get(plan.spec.table) as TableInfo,
      );
    }
    if (APPLY) await pomeriSekvence(dstRaw);

    ispisiIzvestaj(Date.now() - t0);

    if (APPLY) {
      console.log("\n--- VERIFIKACIJA POSLE UPISA ---");
      await verifikuj(dstRaw, srcRaw, users, planovi, srcInfo, dstInfo);
    }
    ispisiBlokade();
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

function maskUrl(u: string | undefined): string {
  if (!u) return "(prazno)";
  return u.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

function prikaziKolone(planovi: Plan[]): void {
  console.log("=== MAPA KOLONA (presek izvora i odredišta) ===\n");
  let ukupno = 0;
  for (const p of planovi) {
    ukupno += p.cols.length;
    console.log(
      `${p.spec.table}  (${p.cols.length} kolona, ključ: ${p.pk.join("+")})`,
    );
    console.log(`  ${p.cols.map((c) => c.name).join(", ")}`);
    if (p.userCols.size > 0)
      console.log(`  -> users.id: ${[...p.userCols].join(", ")}`);
    console.log("");
  }
  console.log(`UKUPNO: ${planovi.length} tabela, ${ukupno} kolona.`);
}

function ispisiIzvestaj(ukupnoMs: number): void {
  console.log("\n=== IZVEŠTAJ ===");
  let read = 0;
  let changed = 0;
  let ins = 0;
  let upd = 0;
  let skip = 0;
  for (const [name, s] of Object.entries(report)) {
    // `setval` se izvrši i kad podaci nisu dirani — ne sme da uđe u zbir izmena,
    // jer je „UKUPNO izmena=0" jedini merljiv dokaz idempotencije.
    if (name !== KORAK_SEKVENCE) {
      read += s.read;
      changed += s.changed;
      ins += s.inserted;
      upd += s.updated;
      skip += s.skipped;
    }
    const brzina =
      s.ms > 0 && s.read > 0
        ? ` ${Math.round(s.read / (s.ms / 1000))} red/s`
        : "";
    const det = APPLY
      ? ` izmena=${s.changed} (ins=${s.inserted} upd=${s.updated})`
      : "";
    console.log(
      `  ${name.padEnd(32)} read=${String(s.read).padStart(7)}${det}` +
        `${s.skipped > 0 ? ` SKIP=${s.skipped}` : ""}${s.ms > 0 ? ` ${s.ms}ms${brzina}` : ""}`,
    );
    for (const [kat, kljucevi] of Object.entries(s.napomene)) {
      console.log(
        `      ${kat}: ${kljucevi.length} (${kljucevi.slice(0, 3).join(", ")}${kljucevi.length > 3 ? ", …" : ""})`,
      );
    }
  }
  console.log(
    `\n  UKUPNO read=${read}${APPLY ? ` izmena=${changed} (ins=${ins} upd=${upd})` : ""}` +
      `${skip > 0 ? ` skip=${skip}` : ""}  za ${Math.round(ukupnoMs / 1000)}s`,
  );
  if (APPLY && changed === 0) {
    console.log(
      "  → 0 izmena: odredište je već poklopljeno sa izvorom (idempotencija).",
    );
  }
}

function ispisiBlokade(): void {
  console.log("\n=== BLOKADE ===");
  if (blockers.length === 0) {
    console.log(
      "  (nema) — sekcija mora biti prazna pre `--apply` na produkciji.",
    );
  } else {
    for (const t of ["struktura", "identitet", "verifikacija"] as Tezina[]) {
      const grupa = blockers.filter((b) => b.tezina === t);
      if (grupa.length === 0) continue;
      console.log(`  [${t}] ${grupa.length}:`);
      for (const b of grupa) console.log(`  🔴 ${b.msg}`);
    }
    // Izlazni kod je 1 za SVAKU blokadu — runbook i kapija traže praznu sekciju.
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("\nPAD:", e);
  process.exitCode = 1;
});
