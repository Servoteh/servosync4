/**
 * One-off data migration: sy15 (1.0) KADROVSKA (HR) -> 3.0 app-owned tabele.
 *
 * Korak 4 iz docs/PLAN_GASENJA_SY15_2026-08-03.md — NAJVEĆI preostali domen.
 * Merenje + runbook: docs/SEOBA_KADROVSKE_2026-08-07.md.
 * Obrazac: scripts/migrate-odrzavanje-sy15.ts (korak 2), sa istim helperom
 * identiteta `scripts/lib/sy15-identity.ts` — koji NIJE menjan.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI dok ne padne odluka. Podrazumevani režim je
 * --dry-run (ništa se ne piše). Skripta ČITA sy15 (samo SELECT) i PIŠE u onu bazu
 * na koju pokazuje DATABASE_URL — proveri gde pokazuje pre `--apply`.
 *
 * ⚠️ MODUL JE ZAMRZNUT (docs/OTVORENI_POSLOVI.md §K) za FUNKCIONALNE izmene.
 * Prenos podataka nije funkcionalna izmena; ništa se usput ne „popravlja".
 * Zatečene nedoslednosti se PRENOSE DOSLOVNO i popisuju u runbook-u §8.
 *
 * ŠTA PRENOSI: 63 tabele (redosledom koji poštuje FK) + spajanje 64-te.
 *
 * ── 🔴 DVE TABELE KOJE „SPISAK PO IMENIMA" NE MOŽE DA PRENESE DOSLOVNO ───────
 *
 *  1. `departments` -> `kadr_departments`
 *     3.0 VEĆ IMA tabelu `departments` — BigBit `BBOdeljenja` (`model Department`,
 *     kolone id/code/description, izmereno 1 red: `id=0, code='0'`). sy15 kadrovska
 *     `departments` je NEŠTO DRUGO (id/name/created_at, 13 redova). Doslovan prenos
 *     bi ih spojio u jednu tabelu i pomešao dva različita šifarnika. Zato jedina
 *     preimenovana tabela domena.
 *
 *  2. `worker_employee_map` — NE PRENOSI SE KAO TABELA, nego se SPAJA.
 *     3.0 već ima istoimenu tabelu (`model WorkerEmployeeMap`, ključ `worker_id`),
 *     sa ISTOM logičkom vezom (3.0 radnik -> sy15 `employees.id`). Izmereno
 *     08.08.2026:
 *         sy15  95 redova (ključ `bigtehn_worker_id`)
 *         3.0   79 redova (ključ `worker_id`)
 *         presek 71 ključ, RAZLIKA u `employee_id`: 0
 *         samo u sy15: 24, samo u 3.0: 8  ->  unija 103
 *     Dakle ni jedna kopija nije potpuna, ali se NE SUKOBLJAVAJU. Skripta radi
 *     upsert sy15 redova u 3.0 tabelu (`--apply`), čime obe strane dobijaju uniju.
 *     🔴 To je klasa greške „dva izvora istog podatka" (v. memoriju „Dva izvora ⭐
 *     prioriteta"): da se ovo nije IZMERILO, prenos bi napravio treću kopiju.
 *
 * ── ŠTA NE PRENOSI ───────────────────────────────────────────────────────────
 *   - `audit_log` (14.627 redova). NIJE ovaj domen — deli ga cela sy15 baza, a
 *     kadrovska je samo jedan od pisaca (4 trigera `audit_row_change`). 3.0 ima
 *     svoj `audit_log` (`model AuditLog`). Spajanje dva različita audit traga u
 *     jedan je odluka, ne prenos → runbook §8.
 *   - `user_roles` (60 redova) i `company_profile` (1) — globalni, ne domenski.
 *   - `vacreq_fn_defs_backup_026` (3 reda) — rezervna kopija definicija funkcija
 *     iz zahteva 026, artefakt razvoja. Ne prenosi se.
 *   - Fajlove iz storage-a (dokumenti zaposlenih, ugovori). Prenose se SAMO putanje.
 *   - 167 RLS politika, 116 funkcija, 19 view-ova i 23 „logika" trigera — to se
 *     prepisuje u NestJS (v. runbook §7).
 *
 * ── 🔴 MAPA IDENTITETA: OVAJ DOMEN JE DRUGAČIJI OD SVIH PRETHODNIH ───────────
 * Održavanje je imalo 46 FK-ova ka `auth.users`. Kadrovska ima **5**. Razlog je
 * izmeren, ne pretpostavljen: `employees` NEMA kolonu `user_id`. Veza zaposleni
 * -> nalog je ISKLJUČIVO MEJL (`pb_current_employee_id()`, `current_user_employee_id()`
 * i sve RLS politike rade `lower(e.email) = lower(auth.jwt() ->> 'email')`).
 *
 * Izmereno na produkciji 07.08.2026:
 *     employees: 157 redova, 152 aktivna
 *     od toga SA MEJLOM: 48   (109 zaposlenih NEMA nalog — proizvodni radnici)
 *     od tih 48, ima parnjaka u sy15 `auth.users`: 48/48
 *
 * Zato se `employees` prenosi 1:1 sa uuid ključem (nema remapa), a samo 6 kolona
 * prevodi uuid naloga u `users.id` (Int).
 *
 * ── 🔴 491.206 REDOVA `attendance_events` — REZ SE TRAŽI, NE PODRAZUMEVA ─────
 * Kapija (Katze) od 1999. do danas. Podela po godinama (izmereno):
 *     ≤2020: 58.919   2021: 42.621   2022: 74.818   2023: 74.661
 *     2024:  66.583   2025: 93.524   2026: 80.080
 * Podrazumevano se prenosi SVE (nema tihog gubitka istorije). `--attendance-from=
 * YYYY-MM-DD` seče, i to je ODLUKA VLASNIKA (runbook §8) — skripta je ne donosi.
 *
 * KONEKCIJE (iz backend/.env):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client, sirovi SELECT)
 *   - odredište   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-kadrovska-sy15.ts             # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-kadrovska-sy15.ts --apply     # upis
 *   ... --verify-only                    # samo uporedi brojeve izvor/odredište
 *   ... --show-columns                   # mapa kolona po tabeli (revizija), bez konekcije
 *   ... --attendance-from=2021-01-01     # rez istorije kapije (SAMO uz odluku vlasnika)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import { buildUserMaps, type UserMaps } from "./lib/sy15-identity";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao korak 2.
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
const ATTENDANCE_FROM = (() => {
  const arg = process.argv.find((a) => a.startsWith("--attendance-from="));
  if (!arg) return null;
  const v = arg.slice("--attendance-from=".length).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`--attendance-from očekuje YYYY-MM-DD, dobio "${v}".`);
  }
  return v;
})();

/** Koliko redova se čita odjednom iz `attendance_events` (491k ne staje u memoriju odjednom). */
const ATTENDANCE_BATCH = 20_000;

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
// Spisak tabela — redosled izveden iz FK grafa žive sy15 (72 unutrašnja FK-a),
// topološkim sortiranjem (roditelj pre deteta). Samoreferentnih FK-ova NEMA
// (izmereno: 0), pa nema ni potrebe za `ORDER BY parent NULLS FIRST` kao kod
// održavanja, niti za drugim prolazom — domen NEMA kružnih FK veza.
// ---------------------------------------------------------------------------

interface TableSpec {
  /** Tabela u sy15. */
  src: string;
  /** Tabela u 3.0 (razlikuje se SAMO za `departments`). */
  dst: string;
  /** Ime Prisma modela u 3.0. */
  model: string;
  /** Kolone koje čine ključ upserta (imena KOLONA, ne polja). */
  key: string[];
  /** Kolone koje se NE prenose. */
  skip?: string[];
  /** Čita se u serijama (velike tabele). */
  chunked?: boolean;
}

const TABLES: TableSpec[] = [
  // --- sloj 0: bez FK-ova unutar domena ---
  { src: "assessment_cycles", dst: "assessment_cycles", model: "AssessmentCycle", key: ["id"] },
  { src: "attendance_notify_extra", dst: "attendance_notify_extra", model: "AttendanceNotifyExtra", key: ["id"] },
  { src: "competence_groups", dst: "competence_groups", model: "CompetenceGroup", key: ["id"] },
  { src: "competence_profiles", dst: "competence_profiles", model: "CompetenceProfile", key: ["id"] },
  { src: "competence_questions", dst: "competence_questions", model: "CompetenceQuestion", key: ["id"] },
  { src: "competences", dst: "competences", model: "Competence", key: ["id"] },
  // 🔴 jedina preimenovana tabela — v. zaglavlje
  { src: "departments", dst: "kadr_departments", model: "KadrDepartment", key: ["id"] },
  { src: "kadr_audit_log", dst: "kadr_audit_log", model: "KadrAuditLog", key: ["id"] },
  // 🔴 tri allowlist tabele PRENOSE SE SA SADRŽAJEM — to su PRAVA, ne šifarnik.
  //    Bez `kadr_salary_viewer_allowlist` zarade posle preklopa ne vidi NIKO
  //    (`current_user_can_view_salary()` je EXISTS nad njom).
  { src: "kadr_grid_editor_allowlist", dst: "kadr_grid_editor_allowlist", model: "KadrGridEditorAllowlist", key: ["email"] },
  { src: "kadr_salary_viewer_allowlist", dst: "kadr_salary_viewer_allowlist", model: "KadrSalaryViewerAllowlist", key: ["email"] },
  { src: "kadr_vacation_editor_allowlist", dst: "kadr_vacation_editor_allowlist", model: "KadrVacationEditorAllowlist", key: ["email"] },
  { src: "kadr_holidays", dst: "kadr_holidays", model: "KadrHoliday", key: ["id"] },
  { src: "kadr_notification_config", dst: "kadr_notification_config", model: "KadrNotificationConfig", key: ["id"] },
  { src: "kadr_onboarding_templates", dst: "kadr_onboarding_templates", model: "KadrOnboardingTemplate", key: ["id"] },
  { src: "profile_groups", dst: "profile_groups", model: "ProfileGroup", key: ["id"] },
  { src: "sub_departments", dst: "sub_departments", model: "KadrSubDepartment", key: ["id"] },
  // 🔴 5.269 redova, JEDINA tabela domena BEZ RLS-a (izmereno `relrowsecurity=false`).
  //    Zatečeno stanje — modul je zamrznut, ne popravlja se ovde (runbook §8).
  { src: "vacation_go_days", dst: "vacation_go_days", model: "VacationGoDay", key: ["employee_id", "used_date"] },

  // --- sloj 1 ---
  { src: "competence_levels", dst: "competence_levels", model: "CompetenceLevel", key: ["id"] },
  { src: "job_positions", dst: "job_positions", model: "KadrJobPosition", key: ["id"] },
  { src: "kadr_onboarding_template_items", dst: "kadr_onboarding_template_items", model: "KadrOnboardingTemplateItem", key: ["id"] },
  { src: "profile_positions", dst: "profile_positions", model: "ProfilePosition", key: ["id"] },

  // --- sloj 2: `employees` je koren svega ostalog ---
  { src: "employees", dst: "employees", model: "Employee", key: ["id"] },

  // --- sloj 3 ---
  { src: "kadr_certificates", dst: "kadr_certificates", model: "KadrCertificate", key: ["id"] },
  { src: "kadr_document_ack", dst: "kadr_document_ack", model: "KadrDocumentAck", key: ["id"] },
  { src: "kadr_medical_exams", dst: "kadr_medical_exams", model: "KadrMedicalExam", key: ["id"] },
  { src: "kadr_notification_log", dst: "kadr_notification_log", model: "KadrNotificationLog", key: ["id"] },
  { src: "kadr_onboarding_runs", dst: "kadr_onboarding_runs", model: "KadrOnboardingRun", key: ["id"] },
  { src: "kadr_onboarding_tasks", dst: "kadr_onboarding_tasks", model: "KadrOnboardingTask", key: ["id"] },
  { src: "katze_employee_map", dst: "katze_employee_map", model: "KatzeEmployeeMap", key: ["katze_id"] },
  { src: "makeup_requests", dst: "makeup_requests", model: "MakeupRequest", key: ["id"] },
  { src: "nop_requests", dst: "nop_requests", model: "NopRequest", key: ["id"] },
  { src: "paid_leave_requests", dst: "paid_leave_requests", model: "PaidLeaveRequest", key: ["id"] },
  { src: "salary_payroll", dst: "salary_payroll", model: "SalaryPayroll", key: ["id"] },
  { src: "salary_terms", dst: "salary_terms", model: "SalaryTerm", key: ["id"] },
  { src: "vacation_bonus_days", dst: "vacation_bonus_days", model: "VacationBonusDay", key: ["id"] },
  { src: "vacation_entitlements", dst: "vacation_entitlements", model: "VacationEntitlement", key: ["id"] },
  { src: "vacation_history", dst: "vacation_history", model: "VacationHistory", key: ["id"] },
  { src: "vacation_requests", dst: "vacation_requests", model: "VacationRequest", key: ["id"] },
  { src: "work_hours", dst: "work_hours", model: "WorkHour", key: ["id"] },
  { src: "work_hours_remarks", dst: "work_hours_remarks", model: "WorkHoursRemark", key: ["id"] },
  { src: "absences", dst: "absences", model: "Absence", key: ["id"] },
  { src: "attendance_corrections", dst: "attendance_corrections", model: "AttendanceCorrection", key: ["id"] },
  // 🔴 491.206 redova — čita se u serijama (v. `--attendance-from`).
  { src: "attendance_events", dst: "attendance_events", model: "AttendanceEvent", key: ["id"], chunked: true },
  { src: "contracts", dst: "contracts", model: "EmploymentContract", key: ["id"] },
  { src: "development_plans", dst: "development_plans", model: "DevelopmentPlan", key: ["id"] },
  { src: "employee_badges", dst: "employee_badges", model: "EmployeeBadge", key: ["id"] },
  { src: "employee_bank_cards", dst: "employee_bank_cards", model: "EmployeeBankCard", key: ["id"] },
  { src: "employee_children", dst: "employee_children", model: "EmployeeChildren", key: ["id"] },
  { src: "employee_documents", dst: "employee_documents", model: "EmployeeDocument", key: ["id"] },
  { src: "employee_expectations", dst: "employee_expectations", model: "EmployeeExpectation", key: ["id"] },
  { src: "employee_foreign_docs", dst: "employee_foreign_docs", model: "EmployeeForeignDoc", key: ["id"] },
  { src: "employee_personal_docs", dst: "employee_personal_docs", model: "EmployeePersonalDoc", key: ["id"] },
  { src: "employee_talks", dst: "employee_talks", model: "EmployeeTalk", key: ["id"] },
  { src: "vacation_change_requests", dst: "vacation_change_requests", model: "VacationChangeRequest", key: ["id"] },

  // --- sloj 4 ---
  { src: "assessments", dst: "assessments", model: "Assessment", key: ["id"] },
  { src: "corrective_plans", dst: "corrective_plans", model: "CorrectivePlan", key: ["id"] },
  { src: "development_checkins", dst: "development_checkins", model: "DevelopmentCheckin", key: ["id"] },

  // --- sloj 5 ---
  { src: "assessment_raters", dst: "assessment_raters", model: "AssessmentRater", key: ["id"] },
  { src: "assessment_results", dst: "assessment_results", model: "AssessmentResult", key: ["id"] },
  { src: "assessment_scores", dst: "assessment_scores", model: "AssessmentScore", key: ["id"] },
  { src: "assessment_targets", dst: "assessment_targets", model: "AssessmentTarget", key: ["id"] },
  { src: "corrective_measures", dst: "corrective_measures", model: "CorrectiveMeasure", key: ["id"] },

  // --- sloj 6 ---
  { src: "assessment_answers", dst: "assessment_answers", model: "AssessmentAnswer", key: ["id"] },
];

/**
 * 6 kolona koje u sy15 drže `auth.users.id` (uuid) — u 3.0 su `users.id` (Int).
 * Spisak je IZMEREN (`pg_constraint` + `information_schema.columns` nad živom
 * sy15), ne pogađan po imenu. To je bitno jer domen ima **48 TEKSTUALNIH kolona
 * tipa `*_by`/`*_email`** (`submitted_by`, `reviewed_by`, `created_by`,
 * `approved_by`, `conducted_by`, `acked_by` …) koje drže MEJL, ne uuid — one se
 * prenose kao običan tekst i NISU ovde. Pogađanje po imenu bi ih pokvarilo.
 *
 * Pet od šest ima pravi FK na `auth.users`; šesta (`kadr_audit_log.actor_user_id`,
 * 35 različitih vrednosti) ga NEMA ni u sy15 — ne dobija ga ni u 3.0.
 */
const USER_COLUMNS = new Set<string>([
  "absences.archived_by",
  "contracts.archived_by",
  "employee_documents.uploaded_by",
  "kadr_audit_log.actor_user_id",
  "kadr_certificates.created_by",
  "kadr_medical_exams.created_by",
]);

/**
 * NOT NULL user kolone — nerazrešen nalog tu je BLOKADA (ne sme ni NULL ni tuđ
 * nalog). Izmereno: NIJEDNA od šest nije NOT NULL, pa je skup prazan. Ostavljen
 * je namerno, da se pri izmeni šeme vidi gde se dopunjuje.
 */
const USER_COLUMNS_REQUIRED = new Set<string>([]);

// ---------------------------------------------------------------------------
// Mapa kolona iz DMMF-a ciljnog modela
//
// ZAŠTO SE KOLONE VUKU IZ DMMF-a, A NE PREPISUJU RUČNO: 63 tabele nose 736
// kolona. Ručni prepis te veličine nosi rizik TIHE greške (promašeno ime kolone =
// kolona se ne prenese, a `count(*)` se i dalje poklapa — verifikacija po broju
// redova to NE bi uhvatila). Zato se spisak izvodi iz Prisma DMMF-a ciljnog
// modela: za svako skalarno polje uzima se `dbName ?? name`, i baš ta kolona se
// čita iz sy15. Ako je u sy15 nema, `SELECT` pukne ODMAH i glasno.
// ---------------------------------------------------------------------------

interface FieldMap {
  column: string;
  field: string;
  type: string;
  isList: boolean;
  isUser: boolean;
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
        isUser: USER_COLUMNS.has(`${spec.src}.${column}`),
        isUserRequired: USER_COLUMNS_REQUIRED.has(`${spec.src}.${column}`),
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
  if (f.isList) return Array.isArray(raw) ? raw : [raw];
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
          `podmetanja tuđeg naloga.`,
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

function whereFor(
  spec: TableSpec,
  maps: FieldMap[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const parts = spec.key.map((col) => {
    const f = maps.find((m) => m.column === col);
    if (!f) throw new Error(`Ključna kolona ${spec.src}.${col} nije u modelu.`);
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
  console.log(`\n=== migrate-kadrovska-sy15 :: ${mode} ===`);
  console.log(`izvor  (sy15): ${maskUrl(process.env.SY15_DATABASE_URL)}`);
  console.log(`odredište    : ${maskUrl(process.env.DATABASE_URL)}`);
  if (ATTENDANCE_FROM) {
    console.log(
      `🔴 REZ ISTORIJE KAPIJE: attendance_events samo od ${ATTENDANCE_FROM} ` +
        `— ovo je ODLUKA VLASNIKA, ne podrazumevano ponašanje.`,
    );
  }
  console.log("");

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

    const domainUsers = await domainUserIds(sy15);
    const missing = domainUsers.filter((u) => !users.byAuthUuid.has(u.toLowerCase()));
    console.log(`  naloga koje DOMEN koristi     : ${domainUsers.length}`);
    console.log(`  od toga bez parnjaka u 3.0    : ${missing.length}`);
    for (const m of missing) console.log(`    ! ${m}`);

    // 🔴 Druga mapa identiteta, specifična za OVAJ domen: zaposleni -> nalog ide
    // preko MEJLA (`employees` nema `user_id`). Meri se pre upisa, jer o njoj
    // zavisi svaki gejt posle preklopa.
    await reportEmployeeIdentity(sy15, users);

    await transfer(prisma, sy15, users);
    await mergeWorkerEmployeeMap(prisma, sy15);
    await resyncSequences(prisma);
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
    const rename = spec.src !== spec.dst ? `  -> 3.0: ${spec.dst}` : "";
    console.log(`${spec.src}  (${maps.length} kolona, ključ: ${spec.key.join("+")})${rename}`);
    console.log(`  ${maps.map((m) => m.column).join(", ")}`);
    if (userCols.length > 0) console.log(`  -> users.id: ${userCols.join(", ")}`);
    console.log("");
  }
  console.log(`UKUPNO: ${TABLES.length} tabela, ${total} kolona.`);
  const seen = TABLES.flatMap((spec) =>
    fieldMapsFor(spec)
      .filter((m) => m.isUser)
      .map((m) => `${spec.src}.${m.column}`),
  );
  console.log(`USER kolona: deklarisano ${USER_COLUMNS.size}, nađeno u modelima ${seen.length}.`);
  if (USER_COLUMNS.size !== seen.length) {
    const miss = [...USER_COLUMNS].filter((c) => !seen.includes(c));
    console.log(`🔴 NE POKLAPA SE. Nema u modelima: ${miss.join(", ")}`);
  }
}

/** Koje `auth.users` naloge domen STVARNO koristi (svih 6 uuid kolona). */
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

/**
 * 🔴 Mapa identiteta koja je SPECIFIČNA za kadrovsku: `employees` -> nalog.
 *
 * Sve RLS politike domena i svi gejtovi (`current_user_employee_id()`,
 * `pb_current_employee_id()`) vezuju zaposlenog za nalog ISKLJUČIVO po MEJLU —
 * `employees` nema kolonu `user_id` (izmereno). Ako se posle preklopa ta veza
 * raskine, zaposleni koji se prijavi NE VIDI svoje podatke, a to se ne vidi u
 * brojevima redova. Zato se meri PRE upisa i ispisuje kao poseban blok.
 */
async function reportEmployeeIdentity(
  sy15: Sy15PrismaClient,
  users: UserMaps,
): Promise<void> {
  const rows = await sy15.$queryRawUnsafe<{ email: string | null; is_active: boolean }[]>(
    `SELECT email, coalesce(is_active, false) AS is_active FROM public.employees`,
  );
  const withEmail = rows.filter((r) => (r.email ?? "").trim() !== "");
  const matched = withEmail.filter((r) =>
    users.byEmail.has((r.email ?? "").trim().toLowerCase()),
  );
  const unmatched = withEmail.filter(
    (r) => !users.byEmail.has((r.email ?? "").trim().toLowerCase()),
  );

  console.log("\n--- MAPA IDENTITETA ZAPOSLENIH (`employees` -> nalog, po MEJLU) ---");
  console.log(`  employees ukupno              : ${rows.length}`);
  console.log(`  aktivnih                      : ${rows.filter((r) => r.is_active).length}`);
  console.log(`  SA mejlom                     : ${withEmail.length}`);
  console.log(`  BEZ mejla (nemaju nalog)      : ${rows.length - withEmail.length}`);
  console.log(`  sa parnjakom u 3.0 users      : ${matched.length}/${withEmail.length}`);
  for (const u of unmatched) console.log(`    ! ${u.email}`);
  if (unmatched.length > 0) {
    blockers.push(
      `${unmatched.length} zaposlenih ima mejl koji NEMA parnjaka u 3.0 \`users\`. ` +
        `Posle preklopa ti ljudi ne bi videli sopstvene podatke (sve RLS politike i ` +
        `\`current_user_employee_id()\` uparuju po mejlu). Napravi naloge pre \`--apply\`.`,
    );
  }
  console.log("");
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
    const s = step(spec.src);
    const maps = fieldMapsFor(spec);
    const cols = maps.map((m) => `"${m.column}"`).join(", ");
    const delegate = delegateFor(prisma, spec.model);

    // `attendance_events` (491k) se čita u serijama; ostalo staje odjednom.
    const where =
      spec.src === "attendance_events" && ATTENDANCE_FROM
        ? ` WHERE event_ts >= '${ATTENDANCE_FROM}'::date`
        : "";

    let offset = 0;
    for (;;) {
      const limit = spec.chunked
        ? ` ORDER BY ${spec.key.map((k) => `"${k}"`).join(", ")} LIMIT ${ATTENDANCE_BATCH} OFFSET ${offset}`
        : "";
      // Ako kolona u sy15 ne postoji, ovo pukne ODMAH i glasno — namerno.
      const rows = await sy15.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${cols} FROM public.${spec.src}${where}${limit}`,
      );
      s.read += rows.length;

      for (const raw of rows) {
        const rowId = spec.key.map((k) => String(raw[k])).join("/");
        const data: Record<string, unknown> = {};
        for (const f of maps) {
          // Prisma ne ume `null` u skalarnom nizu — polje se izostavlja iz upisa
          // (kolona ostaje NULL, kao u izvoru).
          if (f.isList && raw[f.column] == null) continue;
          data[f.field] = f.isUser
            ? mapUser(s, users, f, raw[f.column], spec.src, rowId)
            : convert(f, raw[f.column]);
        }

        const missingRequired = maps.some((f) => f.isUserRequired && data[f.field] == null);
        if (missingRequired) {
          s.skipped += 1;
          continue;
        }
        if (!APPLY) {
          s.written += 1;
          continue;
        }
        const w = whereFor(spec, maps, data);
        const before = await delegate.findUnique({ where: w });
        await delegate.upsert({ where: w, create: data, update: data });
        if (before === null) s.inserted += 1;
        else s.updated += 1;
        s.written += 1;
      }

      if (!spec.chunked || rows.length < ATTENDANCE_BATCH) break;
      offset += ATTENDANCE_BATCH;
      if (spec.chunked) {
        process.stdout.write(`\r  ${spec.src}: ${s.read} redova …`);
      }
    }
    if (spec.chunked) process.stdout.write("\n");
  }
}

/**
 * 🔴 64. tabela: `worker_employee_map` se SPAJA, ne prenosi.
 *
 * 3.0 već ima istoimenu tabelu sa istom logičkom vezom, ali sa ključem `worker_id`
 * (sy15 ga zove `bigtehn_worker_id`). Izmereno 08.08.2026: 71 zajednički ključ,
 * NULA razlika u `employee_id`, 24 samo u sy15, 8 samo u 3.0. Zato je spajanje
 * bezbedno (nema šta da se pregazi) i rezultat je unija od 103 reda.
 *
 * `confirmed_by` je u sy15 TEKST (mejl), a u 3.0 `Int` (`users.id`) — ne prenosi
 * se; izmereno je da u sy15 ima 1 potvrđen red. Prenose se ključ, `employee_id`
 * i `match_method`; ostalo 3.0 popunjava sam.
 */
async function mergeWorkerEmployeeMap(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
): Promise<void> {
  const s = step("worker_employee_map (SPAJANJE u postojeću 3.0 tabelu)");
  const rows = await sy15.$queryRawUnsafe<
    { bigtehn_worker_id: number; employee_id: string; match_method: string | null }[]
  >(
    `SELECT bigtehn_worker_id, employee_id::text AS employee_id, match_method
       FROM public.worker_employee_map
      WHERE bigtehn_worker_id IS NOT NULL AND employee_id IS NOT NULL`,
  );
  s.read = rows.length;

  if (!APPLY) {
    s.written = rows.length;
    return;
  }
  for (const r of rows) {
    const before = await prisma.workerEmployeeMap.findUnique({
      where: { workerId: r.bigtehn_worker_id },
    });
    // 🔴 Ako 3.0 već ima DRUGAČIJEG zaposlenog za istog radnika — ne gazimo tiho.
    if (before !== null && before.employeeId.toLowerCase() !== r.employee_id.toLowerCase()) {
      note(s, "sukob-mapiranja", `${r.bigtehn_worker_id}: 3.0=${before.employeeId} sy15=${r.employee_id}`);
      blockers.push(
        `worker_employee_map[${r.bigtehn_worker_id}]: 3.0 pokazuje na ${before.employeeId}, ` +
          `sy15 na ${r.employee_id}. Merenje 08.08.2026 je dalo 0 takvih — ako se pojavio, ` +
          `neko je u međuvremenu menjao mapu. Odluči ručno, ne prepisuj.`,
      );
      s.skipped += 1;
      continue;
    }
    await prisma.workerEmployeeMap.upsert({
      where: { workerId: r.bigtehn_worker_id },
      create: {
        workerId: r.bigtehn_worker_id,
        employeeId: r.employee_id,
        matchMethod: r.match_method ?? "card",
      },
      update: { employeeId: r.employee_id },
    });
    if (before === null) s.inserted += 1;
    else s.updated += 1;
    s.written += 1;
  }
}

/**
 * 🔴 Sekvence posle prenosa.
 *
 * 11 tabela domena ima `serial` PK (`competence_*`, `kadr_departments`,
 * `job_positions`, `kadr_audit_log`, `profile_*`, `sub_departments`), a
 * `attendance_events` `identity`. Prenos upisuje POSTOJEĆE id-jeve, pa sekvenca
 * ostaje na 1 — i PRVI novi red posle preklopa pada na duplikat PK-a.
 *
 * Pouka „Incident sekvence 27.07": `USAGE` bez `UPDATE` je već jednom oborio
 * produkciju. Zato se ovde sekvenca ne „pretpostavlja da je u redu", nego se
 * eksplicitno pomera na `max(id)`.
 */
async function resyncSequences(prisma: PrismaClient): Promise<void> {
  const s = step("(posle prenosa) sekvence");
  const SEQ: { table: string; col: string }[] = [
    { table: "attendance_events", col: "id" },
    { table: "competence_groups", col: "id" },
    { table: "competence_levels", col: "id" },
    { table: "competence_profiles", col: "id" },
    { table: "competence_questions", col: "id" },
    { table: "competences", col: "id" },
    { table: "job_positions", col: "id" },
    { table: "kadr_audit_log", col: "id" },
    { table: "kadr_departments", col: "id" },
    { table: "profile_groups", col: "id" },
    { table: "profile_positions", col: "id" },
    { table: "sub_departments", col: "id" },
  ];
  s.read = SEQ.length;
  if (!APPLY) {
    s.written = SEQ.length;
    return;
  }
  for (const q of SEQ) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(
         pg_get_serial_sequence('public.${q.table}', '${q.col}'),
         GREATEST(COALESCE((SELECT max("${q.col}") FROM public.${q.table}), 0), 1),
         (SELECT count(*) FROM public.${q.table}) > 0
       )`,
    );
    s.written += 1;
    s.updated += 1;
  }
}

// ===========================================================================
// VERIFIKACIJA
// ===========================================================================

async function verify(prisma: PrismaClient, sy15: Sy15PrismaClient): Promise<void> {
  let ok = 0;
  let bad = 0;
  for (const spec of TABLES) {
    const where =
      spec.src === "attendance_events" && ATTENDANCE_FROM
        ? ` WHERE event_ts >= '${ATTENDANCE_FROM}'::date`
        : "";
    const srcRows = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public.${spec.src}${where}`,
    );
    const src = Number(srcRows[0]?.n ?? 0);
    const dst = await delegateFor(prisma, spec.model).count();
    const mark = src === dst ? "OK  " : "!!! ";
    if (src === dst) ok += 1;
    else bad += 1;
    console.log(
      `${mark}${spec.src.padEnd(32)} sy15=${String(src).padStart(7)}  3.0=${String(dst).padStart(7)}`,
    );
  }
  console.log(`\n  poklapa se: ${ok}/${TABLES.length}${bad > 0 ? `  RAZLIKA: ${bad}` : ""}`);
  if (bad > 0) blockers.push(`Verifikacija: ${bad} tabela se NE poklapa po broju redova.`);

  // --- Kontrole koje `count(*)` NE hvata -----------------------------------

  // 1) allowlist zarada — bez nje niko ne vidi plate.
  const salaryViewers = await prisma.kadrSalaryViewerAllowlist.count();
  const srcViewers = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public.kadr_salary_viewer_allowlist`,
  );
  const viewersOk = salaryViewers === Number(srcViewers[0]?.n ?? 0) && salaryViewers > 0;
  console.log(
    `${viewersOk ? "OK  " : "!!! "}allowlist ZARADA                 ` +
      `sy15=${Number(srcViewers[0]?.n ?? 0)}  3.0=${salaryViewers}`,
  );
  if (!viewersOk) {
    blockers.push(
      "`kadr_salary_viewer_allowlist` nije preneta ili je prazna — posle preklopa " +
        "ZARADE NE BI VIDEO NIKO (`current_user_can_view_salary()` je EXISTS nad njom).",
    );
  }

  // 2) worker_employee_map — unija, ne kopija.
  const wem = await prisma.workerEmployeeMap.count();
  const srcWem = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public.worker_employee_map`,
  );
  console.log(
    `${wem >= Number(srcWem[0]?.n ?? 0) ? "OK  " : "!!! "}worker_employee_map (UNIJA)      ` +
      `sy15=${Number(srcWem[0]?.n ?? 0)}  3.0=${wem} (očekivano >= sy15; izmereno 103)`,
  );

  // 3) `employees` sa mejlom — nosač identiteta celog domena.
  const empWithEmail = await prisma.employee.count({
    where: { email: { not: "" }, NOT: { email: null } },
  });
  const srcEmp = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public.employees WHERE coalesce(btrim(email),'') <> ''`,
  );
  const empOk = empWithEmail === Number(srcEmp[0]?.n ?? 0);
  console.log(
    `${empOk ? "OK  " : "!!! "}employees SA MEJLOM              ` +
      `sy15=${Number(srcEmp[0]?.n ?? 0)}  3.0=${empWithEmail}`,
  );
  if (!empOk) {
    blockers.push(
      "Broj zaposlenih sa mejlom se ne poklapa — mejl je JEDINA veza zaposleni->nalog " +
        "(`employees` nema `user_id`), pa bi razlika značila da neko ne vidi svoje podatke.",
    );
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
      `  ${name.padEnd(44)} read=${String(s.read).padStart(6)} write=${String(s.written).padStart(6)}${det}${
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
