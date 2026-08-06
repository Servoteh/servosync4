/**
 * One-off data migration: sy15 (1.0) sastanci + projektni biro -> 3.0 app-owned tabele.
 *
 * Korak 1 iz docs/PLAN_GASENJA_SY15_2026-08-03.md; merenje + runbook u
 * docs/SEOBA_SASTANCI_PB_2026-08-05.md. Obrazac: backend/scripts/migrate-reversi-sy15.ts.
 *
 * ⚠️ NE POKREĆE SE NA PRODUKCIJI dok ne padne odluka. Podrazumevani režim je
 * --dry-run (ništa se ne piše). Skripta ČITA sy15 (samo SELECT) i PIŠE u onu bazu
 * na koju pokazuje DATABASE_URL — proveri gde pokazuje pre `--apply`.
 *
 * ŠTA PRENOSI (27 tabela, redosledom koji poštuje FK):
 *   sastanci_templates -> sastanci_template_ucesnici
 *   sastanci -> sastanak_ucesnici -> pm_teme -> akcioni_plan -> akcioni_plan_istorija
 *            -> sastanak_odluke -> sastanak_arhiva -> presek_aktivnosti -> presek_slike
 *   sastanci_notification_prefs -> sastanci_notification_log -> sastanci_ai_settings
 *   sast_weekly_skip, sast_weekly_movers
 *   pb_eng_tip_categories -> pb_eng_tips -> pb_eng_tip_files / pb_eng_tip_likes
 *   pb_tasks -> pb_task_comments / pb_task_deps / pb_task_files
 *   pb_work_reports, pb_notification_config, pb_notification_log
 *
 * TRI TABELE KOJE „SPISAK PO PREFIKSU" PROMAŠI (i zašto idu):
 *   - `akcioni_plan_istorija` (689 redova!) — revizioni trag akcionih tačaka; nema
 *     prefiks domena, a bez njega se gubi cela istorija izmena.
 *   - `sast_weekly_skip` / `sast_weekly_movers` — prefiks je `sast_`, ne `sastan_`,
 *     pa ih upit `LIKE 'sastan%'` ne vidi. Nose ko sme da pomera sedmični sastanak
 *     i koje se nedelje preskaču.
 *
 * ŠTA NE PRENOSI
 *   - `rev_api_idempotency` (registar idempotencije CELE aplikacije) — v. nalaz 1
 *     u docs/SEOBA_REVERSA_2026-08-05.md. Od 643 reda 56 je sastanaka i 31 PB-a,
 *     ali tabela ostaje u sy15 dok tamo ima ijedan modul.
 *   - Fajlove iz storage-a (`sastanci-arhiva`, `sastanak-slike`, `pb-task-files`,
 *     `pb-eng-tip-files`). Prenose se SAMO putanje; URL-ovi ka sy15 ostaju važeći.
 *   - RLS politike (74) i 65 DEFINER funkcija — 3.0 koristi guardove; logika se
 *     prepisuje u NestJS (v. runbook §4).
 *
 * KLJUČNE ODLUKE PRESLIKAVANJA (izmerene, ne pretpostavljene):
 *   - UUID PK-ovi se ZADRŽAVAJU 1:1 -> prenos je egzaktno idempotentan (upsert po
 *     `id`), bez remap tabele. Ponovno pokretanje ažurira u mestu, nikad ne duplira.
 *   - Predmet: sy15 `projects.id` (uuid) -> 3.0 `projects.id` (Int) preko
 *     `bigtehn_item_id`. Mapu gradi i MERI `scripts/lib/sy15-identity.ts`
 *     (22/22 poklapanja, potvrđeno i nezavisno po šifri).
 *   - Autori sa FK na `auth.users` -> 3.0 `users.id` po mejlu (6/6 razrešeno).
 *     Nerazrešeno -> NULL + prijava (nema tihog podmetanja tuđeg naloga).
 *   - Mejlovi se prenose DOSLOVNO (i oni bez naloga: `auto@sistem`,
 *     `seed-zapisnik-…@import.servoteh`, tipfeler `…@servoteh.ocm`) — identitet
 *     domena JESTE mejl; „ispravljanje" bi bilo izmišljanje podatka.
 *   - `employees.id` (uuid) se prenosi DOSLOVNO kao meka veza bez FK-a
 *     (kadrovska je korak 4; obrazac `KadrGridDayLock`).
 *   - `pb_eng_tips.search_tsv` se NE prenosi — puni ga trigger u 3.0 bazi.
 *   - `pb_eng_tip_files.is_image` je generisana kolona — ne prenosi se.
 *
 * KONEKCIJE (iz backend/.env, kao migrate-reversi-sy15.ts):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client, sirovi SELECT)
 *   - odrediste   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/migrate-sastanci-pb-sy15.ts           # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-sastanci-pb-sy15.ts --apply   # upis
 *   ... --verify-only    # samo uporedi brojeve izvor/odrediste
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import {
  buildProjectMap,
  buildUserMaps,
  normEmail,
  type ProjectMap,
  type UserMaps,
} from "./lib/sy15-identity";

// ---------------------------------------------------------------------------
// Env bootstrap (bez dotenv zavisnosti) — isti obrazac kao migrate-reversi-sy15.
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

/** Tabele koje se prenose, redosledom FK zavisnosti (i za verifikaciju brojeva). */
const TABLES = [
  "sastanci_templates",
  "sastanci_template_ucesnici",
  "sastanci",
  "sastanak_ucesnici",
  "pm_teme",
  "akcioni_plan",
  "akcioni_plan_istorija",
  "sastanak_odluke",
  "sastanak_arhiva",
  "presek_aktivnosti",
  "presek_slike",
  "sastanci_notification_prefs",
  "sastanci_notification_log",
  "sastanci_ai_settings",
  "sast_weekly_skip",
  "sast_weekly_movers",
  "pb_eng_tip_categories",
  "pb_eng_tips",
  "pb_eng_tip_files",
  "pb_eng_tip_likes",
  "pb_tasks",
  "pb_task_comments",
  "pb_task_deps",
  "pb_task_files",
  "pb_work_reports",
  "pb_notification_config",
  "pb_notification_log",
] as const;

// ---------------------------------------------------------------------------
// Konverzije tipova (pg -> Prisma)
// ---------------------------------------------------------------------------

/** `time without time zone` stiže kao "HH:MM:SS" — Prisma @db.Time traži Date. */
function toTime(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(`1970-01-01T${String(v)}Z`);
}

/** `bigint` stiže kao string (pg driver) — Prisma BigInt traži bigint. */
function toBigInt(v: unknown): bigint | null {
  if (v == null) return null;
  return typeof v === "bigint" ? v : BigInt(String(v));
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function lowerUuid(v: unknown): string | null {
  return v == null ? null : String(v).toLowerCase();
}

/**
 * Predmet: sy15 uuid -> 3.0 `projects.id`. Nerazrešeno je BLOKADA, ne tiho NULL —
 * izgubljena veza sa predmetom se ne vidi dok neko ne otvori ekran.
 */
function mapProject(
  s: StepReport,
  projects: ProjectMap,
  raw: unknown,
  rowId: string,
): number | null {
  const uuid = lowerUuid(raw);
  if (uuid === null) return null;
  const id = projects.byUuid.get(uuid);
  if (id === undefined) {
    note(s, "predmet-nerazresen", `${rowId} -> ${uuid}`);
    blockers.push(`Predmet ${uuid} (red ${rowId}) nema parnjaka u 3.0 projects.`);
    return null;
  }
  return id;
}

/** `auth.users` uuid -> 3.0 `users.id`. Nerazrešeno -> NULL + prijava. */
function mapUser(
  s: StepReport,
  users: UserMaps,
  raw: unknown,
  rowId: string,
): number | null {
  const uuid = lowerUuid(raw);
  if (uuid === null) return null;
  const id = users.byAuthUuid.get(uuid);
  if (id === undefined) {
    note(s, "nalog-nerazresen", `${rowId} -> ${uuid}`);
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Generički upsert (idempotentan: isti podaci u create i update)
// ---------------------------------------------------------------------------

interface UpsertDelegate<W, D> {
  upsert(args: { where: W; create: D; update: D }): Promise<unknown>;
  /** `findUnique` (a NE `count`) — jedini prihvata i složene ključeve
   *  tipa `{ sastanakId_email: {...} }`; služi samo za razlikovanje ins/upd. */
  findUnique(args: { where: W }): Promise<unknown>;
}

async function upsertRows<W, D>(
  s: StepReport,
  delegate: UpsertDelegate<W, D>,
  rows: { where: W; data: D }[],
): Promise<void> {
  for (const r of rows) {
    if (!APPLY) {
      s.written += 1;
      continue;
    }
    const before = await delegate.findUnique({ where: r.where });
    await delegate.upsert({ where: r.where, create: r.data, update: r.data });
    if (before === null) s.inserted += 1;
    else s.updated += 1;
    s.written += 1;
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

  const mode = VERIFY_ONLY ? "VERIFY-ONLY" : APPLY ? "APPLY (PIŠE!)" : "DRY-RUN";
  console.log(`\n=== migrate-sastanci-pb-sy15 :: ${mode} ===`);
  console.log(`izvor  (sy15): ${maskUrl(process.env.SY15_DATABASE_URL)}`);
  console.log(`odredište    : ${maskUrl(process.env.DATABASE_URL)}\n`);

  try {
    if (VERIFY_ONLY) {
      await verify(prisma, sy15);
      return;
    }

    // --- Korak 0: mape (identitet + predmeti) -------------------------------
    const users = await buildUserMaps(prisma, sy15);
    const projects = await buildProjectMap(prisma, sy15);

    console.log("--- MAPA IDENTITETA (korak 0) ---");
    console.log(`  3.0 users (po mejlu)          : ${users.byEmail.size}`);
    console.log(`  sy15 auth.users -> users.id   : ${users.byAuthUuid.size}`);
    console.log(`  sy15 auth.users BEZ parnjaka  : ${users.unmatchedAuthUuids.length}`);
    console.log("--- MAPA PREDMETA ---");
    console.log(`  sy15 projects -> 3.0 projects : ${projects.byUuid.size}`);
    console.log(`  kontrola po ŠIFRI (nezavisno) : ${projects.matchedByCode}`);
    for (const u of projects.unmatched) {
      console.log(`  ! nepoklopljen predmet ${u.code ?? "(bez šifre)"}: ${u.reason}`);
    }
    if (projects.byUuid.size !== projects.matchedByCode) {
      blockers.push(
        `Mapa predmeta se ne slaže sama sa sobom: po id-u ${projects.byUuid.size}, ` +
          `po šifri ${projects.matchedByCode}. Ključ NIJE ono što mislimo — stani.`,
      );
    }
    console.log("");

    await transfer(prisma, sy15, users, projects);
    printReport();

    if (APPLY) {
      console.log("\n--- VERIFIKACIJA POSLE UPISA ---");
      await verify(prisma, sy15);
    }
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

function maskUrl(u: string | undefined): string {
  if (!u) return "(prazno)";
  return u.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
}

/** Sirov SELECT nad sy15 — Prisma sy15 klijent ne pokriva sve 27 tabela. */
async function readSy15(
  sy15: Sy15PrismaClient,
  table: string,
  columns: string,
): Promise<Record<string, unknown>[]> {
  return sy15.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${columns} FROM public.${table}`,
  );
}

// ===========================================================================
// PRENOS
// ===========================================================================

async function transfer(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
  users: UserMaps,
  projects: ProjectMap,
): Promise<void> {
  // --- 1. sastanci_templates ------------------------------------------------
  {
    const s = step("sastanci_templates");
    const rows = await readSy15(
      sy15,
      "sastanci_templates",
      `id::text AS id, naziv, tip, mesto, vodio_email, zapisnicar_email, cadence,
       cadence_dow, cadence_dom, vreme::text AS vreme, napomena, is_active,
       created_by_email, created_at, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanciTemplate,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          naziv: String(r.naziv),
          tip: String(r.tip),
          mesto: str(r.mesto),
          vodioEmail: str(r.vodio_email),
          zapisnicarEmail: str(r.zapisnicar_email),
          cadence: String(r.cadence),
          cadenceDow: r.cadence_dow == null ? null : Number(r.cadence_dow),
          cadenceDom: r.cadence_dom == null ? null : Number(r.cadence_dom),
          vreme: toTime(r.vreme),
          napomena: str(r.napomena),
          isActive: Boolean(r.is_active),
          createdByEmail: str(r.created_by_email),
          createdAt: toDate(r.created_at) ?? new Date(),
          updatedAt: toDate(r.updated_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 2. sastanci_template_ucesnici ----------------------------------------
  {
    const s = step("sastanci_template_ucesnici");
    const rows = await readSy15(
      sy15,
      "sastanci_template_ucesnici",
      `template_id::text AS template_id, email, label`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanciTemplateUcesnik,
      rows.map((r) => ({
        where: {
          templateId_email: {
            templateId: String(r.template_id),
            email: String(r.email),
          },
        },
        data: {
          templateId: String(r.template_id),
          email: String(r.email),
          label: str(r.label),
        },
      })),
    );
  }

  // --- 3. sastanci ----------------------------------------------------------
  // Self-FK (`prethodni_sastanak_id`): prvi prolaz bez njega, drugi ga popunjava —
  // inače bi redosled unosa lanca određivao uspeh.
  const sastanciSelfLinks: { id: string; prethodni: string }[] = [];
  {
    const s = step("sastanci");
    const rows = await readSy15(
      sy15,
      "sastanci",
      `id::text AS id, tip, naslov, datum, vreme::text AS vreme, mesto,
       projekat_id::text AS projekat_id, vodio_email, vodio_label,
       zapisnicar_email, zapisnicar_label, status, zakljucan_at, zakljucan_by_email,
       napomena, created_at, created_by_email, updated_at, pozivnice_poslate_at,
       zapisnik_datum, interval_days, prethodni_sastanak_id::text AS prethodni_sastanak_id`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanak,
      rows.map((r) => {
        const id = String(r.id);
        if (r.prethodni_sastanak_id != null) {
          sastanciSelfLinks.push({ id, prethodni: String(r.prethodni_sastanak_id) });
        }
        return {
          where: { id },
          data: {
            id,
            tip: String(r.tip),
            naslov: String(r.naslov),
            datum: toDate(r.datum) ?? new Date(),
            vreme: toTime(r.vreme),
            mesto: str(r.mesto),
            projectId: mapProject(s, projects, r.projekat_id, `sastanci:${id}`),
            vodioEmail: str(r.vodio_email),
            vodioLabel: str(r.vodio_label),
            zapisnicarEmail: str(r.zapisnicar_email),
            zapisnicarLabel: str(r.zapisnicar_label),
            status: String(r.status),
            zakljucanAt: toDate(r.zakljucan_at),
            zakljucanByEmail: str(r.zakljucan_by_email),
            napomena: str(r.napomena),
            createdAt: toDate(r.created_at) ?? new Date(),
            createdByEmail: str(r.created_by_email),
            updatedAt: toDate(r.updated_at) ?? new Date(),
            pozivnicePoslateAt: toDate(r.pozivnice_poslate_at),
            zapisnikDatum: toDate(r.zapisnik_datum),
            intervalDays: r.interval_days == null ? null : Number(r.interval_days),
            prethodniSastanakId: null, // drugi prolaz
          },
        };
      }),
    );
    if (APPLY) {
      for (const link of sastanciSelfLinks) {
        await prisma.sastanak.update({
          where: { id: link.id },
          data: { prethodniSastanakId: link.prethodni },
        });
      }
    }
    if (sastanciSelfLinks.length > 0) {
      console.log(
        `  (sastanci) lanac periodičnih: ${sastanciSelfLinks.length} veza u drugom prolazu`,
      );
    }
  }

  // --- 4. sastanak_ucesnici -------------------------------------------------
  {
    const s = step("sastanak_ucesnici");
    const rows = await readSy15(
      sy15,
      "sastanak_ucesnici",
      `sastanak_id::text AS sastanak_id, email, label, prisutan, pozvan, napomena,
       pripremljen, priprema, rsvp_status, rsvp_at, rsvp_token::text AS rsvp_token`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanakUcesnik,
      rows.map((r) => ({
        where: {
          sastanakId_email: {
            sastanakId: String(r.sastanak_id),
            email: String(r.email),
          },
        },
        data: {
          sastanakId: String(r.sastanak_id),
          email: String(r.email),
          label: str(r.label),
          prisutan: Boolean(r.prisutan),
          pozvan: Boolean(r.pozvan),
          napomena: str(r.napomena),
          pripremljen: Boolean(r.pripremljen),
          priprema: str(r.priprema),
          rsvpStatus: str(r.rsvp_status),
          rsvpAt: toDate(r.rsvp_at),
          // Token se prenosi DOSLOVNO — magic-linkovi iz već poslatih mejlova
          // moraju nastaviti da rade posle prebacivanja prekidača.
          rsvpToken: String(r.rsvp_token),
        },
      })),
    );
  }

  // --- 5. pm_teme -----------------------------------------------------------
  {
    const s = step("pm_teme");
    const rows = await readSy15(
      sy15,
      "pm_teme",
      `id::text AS id, vrsta, oblast, naslov, opis, projekat_id::text AS projekat_id,
       status, prioritet, sastanak_id::text AS sastanak_id, predlozio_email,
       predlozio_label, predlozio_at, resio_email, resio_label, resio_at,
       resio_napomena, created_at, updated_at, hitno, za_razmatranje, admin_rang,
       admin_rang_by_email, admin_rang_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pmTema,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            vrsta: String(r.vrsta),
            oblast: String(r.oblast),
            naslov: String(r.naslov),
            opis: str(r.opis),
            projectId: mapProject(s, projects, r.projekat_id, `pm_teme:${id}`),
            status: String(r.status),
            prioritet: Number(r.prioritet),
            sastanakId: str(r.sastanak_id),
            predlozioEmail: String(r.predlozio_email),
            predlozioLabel: str(r.predlozio_label),
            predlozioAt: toDate(r.predlozio_at) ?? new Date(),
            resioEmail: str(r.resio_email),
            resioLabel: str(r.resio_label),
            resioAt: toDate(r.resio_at),
            resioNapomena: str(r.resio_napomena),
            createdAt: toDate(r.created_at) ?? new Date(),
            updatedAt: toDate(r.updated_at) ?? new Date(),
            hitno: Boolean(r.hitno),
            zaRazmatranje: Boolean(r.za_razmatranje),
            adminRang: r.admin_rang == null ? null : Number(r.admin_rang),
            adminRangByEmail: str(r.admin_rang_by_email),
            adminRangAt: toDate(r.admin_rang_at),
          },
        };
      }),
    );
  }

  // --- 6. akcioni_plan ------------------------------------------------------
  {
    const s = step("akcioni_plan");
    const rows = await readSy15(
      sy15,
      "akcioni_plan",
      `id::text AS id, sastanak_id::text AS sastanak_id, tema_id::text AS tema_id,
       projekat_id::text AS projekat_id, rb, naslov, opis, odgovoran_email,
       odgovoran_label, odgovoran_text, rok, rok_text, status, prioritet,
       zatvoren_at, zatvoren_by_email, zatvoren_napomena, created_at,
       created_by_email, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.akcionaTacka,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            sastanakId: str(r.sastanak_id),
            temaId: str(r.tema_id),
            projectId: mapProject(s, projects, r.projekat_id, `akcioni_plan:${id}`),
            rb: r.rb == null ? null : Number(r.rb),
            naslov: String(r.naslov),
            opis: str(r.opis),
            odgovoranEmail: str(r.odgovoran_email),
            odgovoranLabel: str(r.odgovoran_label),
            odgovoranText: str(r.odgovoran_text),
            rok: toDate(r.rok),
            rokText: str(r.rok_text),
            status: String(r.status),
            prioritet: Number(r.prioritet),
            zatvorenAt: toDate(r.zatvoren_at),
            zatvorenByEmail: str(r.zatvoren_by_email),
            zatvorenNapomena: str(r.zatvoren_napomena),
            createdAt: toDate(r.created_at) ?? new Date(),
            createdByEmail: str(r.created_by_email),
            updatedAt: toDate(r.updated_at) ?? new Date(),
          },
        };
      }),
    );
  }

  // --- 7. akcioni_plan_istorija --------------------------------------------
  {
    const s = step("akcioni_plan_istorija");
    const rows = await readSy15(
      sy15,
      "akcioni_plan_istorija",
      `id::text AS id, akcija_id::text AS akcija_id, polje, staro, novo,
       izmenio_email, izmenjeno_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.akcionaTackaIstorija,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          akcijaId: String(r.akcija_id),
          polje: String(r.polje),
          staro: str(r.staro),
          novo: str(r.novo),
          izmenioEmail: str(r.izmenio_email),
          izmenjenoAt: toDate(r.izmenjeno_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 8. sastanak_odluke ---------------------------------------------------
  {
    const s = step("sastanak_odluke");
    const rows = await readSy15(
      sy15,
      "sastanak_odluke",
      `id::text AS id, sastanak_id::text AS sastanak_id, rb, naslov, opis,
       odlucio_email, odlucio_label, odluka_datum, uticaj,
       veza_tema_id::text AS veza_tema_id, veza_akcija_id::text AS veza_akcija_id,
       status, created_at, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanakOdluka,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          sastanakId: String(r.sastanak_id),
          rb: r.rb == null ? null : Number(r.rb),
          naslov: String(r.naslov),
          opis: str(r.opis),
          odlucioEmail: str(r.odlucio_email),
          odlucioLabel: str(r.odlucio_label),
          odlukaDatum: toDate(r.odluka_datum),
          uticaj: str(r.uticaj),
          vezaTemaId: str(r.veza_tema_id),
          vezaAkcijaId: str(r.veza_akcija_id),
          status: String(r.status),
          createdAt: toDate(r.created_at) ?? new Date(),
          updatedAt: toDate(r.updated_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 9. sastanak_arhiva ---------------------------------------------------
  {
    const s = step("sastanak_arhiva");
    const rows = await readSy15(
      sy15,
      "sastanak_arhiva",
      `id::text AS id, sastanak_id::text AS sastanak_id, snapshot,
       zapisnik_storage_path, zapisnik_size_bytes, zapisnik_generated_at,
       arhivirao_email, arhivirao_label, arhivirano_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanakArhiva,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          sastanakId: String(r.sastanak_id),
          // JSONB snimak se prenosi kakav jeste — u njemu su i stari sy15 uuid-ovi
          // predmeta; to je ARHIVA (slika stanja), ne živa veza, i ne prevodi se.
          snapshot: r.snapshot as object,
          zapisnikStoragePath: str(r.zapisnik_storage_path),
          zapisnikSizeBytes: toBigInt(r.zapisnik_size_bytes),
          zapisnikGeneratedAt: toDate(r.zapisnik_generated_at),
          arhiviraoEmail: str(r.arhivirao_email),
          arhiviraoLabel: str(r.arhivirao_label),
          arhiviranoAt: toDate(r.arhivirano_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 10. presek_aktivnosti ------------------------------------------------
  {
    const s = step("presek_aktivnosti");
    const rows = await readSy15(
      sy15,
      "presek_aktivnosti",
      `id::text AS id, sastanak_id::text AS sastanak_id, rb, redosled, naslov,
       pod_rn, sadrzaj_html, sadrzaj_text, odgovoran_email, odgovoran_label,
       odgovoran_text, rok, rok_text, status, napomena, created_at, updated_at,
       tema_id::text AS tema_id`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.presekAktivnost,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          sastanakId: String(r.sastanak_id),
          rb: Number(r.rb),
          redosled: Number(r.redosled),
          naslov: String(r.naslov),
          podRn: str(r.pod_rn),
          sadrzajHtml: str(r.sadrzaj_html),
          sadrzajText: str(r.sadrzaj_text),
          odgovoranEmail: str(r.odgovoran_email),
          odgovoranLabel: str(r.odgovoran_label),
          odgovoranText: str(r.odgovoran_text),
          rok: toDate(r.rok),
          rokText: str(r.rok_text),
          status: String(r.status),
          napomena: str(r.napomena),
          createdAt: toDate(r.created_at) ?? new Date(),
          updatedAt: toDate(r.updated_at) ?? new Date(),
          temaId: str(r.tema_id),
        },
      })),
    );
  }

  // --- 11. presek_slike -----------------------------------------------------
  {
    const s = step("presek_slike");
    const rows = await readSy15(
      sy15,
      "presek_slike",
      `id::text AS id, sastanak_id::text AS sastanak_id,
       aktivnost_id::text AS aktivnost_id, storage_path, file_name, mime_type,
       size_bytes, caption, redosled, uploaded_by_email, uploaded_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.presekSlika,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          sastanakId: String(r.sastanak_id),
          aktivnostId: str(r.aktivnost_id),
          storagePath: String(r.storage_path),
          fileName: str(r.file_name),
          mimeType: str(r.mime_type),
          sizeBytes: toBigInt(r.size_bytes),
          caption: str(r.caption),
          redosled: Number(r.redosled),
          uploadedByEmail: str(r.uploaded_by_email),
          uploadedAt: toDate(r.uploaded_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 12. sastanci_notification_prefs --------------------------------------
  {
    const s = step("sastanci_notification_prefs");
    const rows = await readSy15(
      sy15,
      "sastanci_notification_prefs",
      `email, on_new_akcija, on_change_akcija, on_meeting_invite, on_meeting_locked,
       on_action_reminder, on_meeting_reminder, email_address, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanciNotificationPrefs,
      rows.map((r) => ({
        where: { email: String(r.email) },
        data: {
          email: String(r.email),
          onNewAkcija: Boolean(r.on_new_akcija),
          onChangeAkcija: Boolean(r.on_change_akcija),
          onMeetingInvite: Boolean(r.on_meeting_invite),
          onMeetingLocked: Boolean(r.on_meeting_locked),
          onActionReminder: Boolean(r.on_action_reminder),
          onMeetingReminder: Boolean(r.on_meeting_reminder),
          emailAddress: str(r.email_address),
          updatedAt: toDate(r.updated_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 13. sastanci_notification_log ----------------------------------------
  {
    const s = step("sastanci_notification_log");
    const rows = await readSy15(
      sy15,
      "sastanci_notification_log",
      `id::text AS id, kind, channel, recipient_email, recipient_label, subject,
       body_html, body_text, related_sastanak_id::text AS related_sastanak_id,
       related_akcija_id::text AS related_akcija_id, status, scheduled_at,
       next_attempt_at, last_attempt_at, attempts, max_attempts, error, payload,
       created_by_email, created_at, sent_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanciNotificationLog,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          kind: String(r.kind),
          channel: String(r.channel),
          recipientEmail: String(r.recipient_email),
          recipientLabel: str(r.recipient_label),
          subject: String(r.subject),
          bodyHtml: str(r.body_html),
          bodyText: str(r.body_text),
          relatedSastanakId: str(r.related_sastanak_id),
          relatedAkcijaId: str(r.related_akcija_id),
          status: String(r.status),
          scheduledAt: toDate(r.scheduled_at) ?? new Date(),
          nextAttemptAt: toDate(r.next_attempt_at) ?? new Date(),
          lastAttemptAt: toDate(r.last_attempt_at),
          attempts: Number(r.attempts),
          maxAttempts: Number(r.max_attempts),
          error: str(r.error),
          payload: (r.payload ?? undefined) as object | undefined,
          createdByEmail: str(r.created_by_email),
          createdAt: toDate(r.created_at) ?? new Date(),
          sentAt: toDate(r.sent_at),
        },
      })),
    );
  }

  // --- 14. sastanci_ai_settings ---------------------------------------------
  {
    const s = step("sastanci_ai_settings");
    const rows = await readSy15(
      sy15,
      "sastanci_ai_settings",
      `id, model, updated_by::text AS updated_by, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastanciAiSettings,
      rows.map((r) => ({
        where: { id: Number(r.id) },
        data: {
          id: Number(r.id),
          model: String(r.model),
          updatedByUserId: mapUser(s, users, r.updated_by, "sastanci_ai_settings:1"),
          updatedAt: toDate(r.updated_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 15. sast_weekly_skip -------------------------------------------------
  {
    const s = step("sast_weekly_skip");
    const rows = await readSy15(
      sy15,
      "sast_weekly_skip",
      `week_monday, reason, created_by_email, created_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastWeeklySkip,
      rows.map((r) => ({
        where: { weekMonday: toDate(r.week_monday) ?? new Date() },
        data: {
          weekMonday: toDate(r.week_monday) ?? new Date(),
          reason: str(r.reason),
          createdByEmail: str(r.created_by_email),
          createdAt: toDate(r.created_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 16. sast_weekly_movers -----------------------------------------------
  {
    const s = step("sast_weekly_movers");
    const rows = await readSy15(sy15, "sast_weekly_movers", `email, created_at`);
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.sastWeeklyMover,
      rows.map((r) => ({
        where: { email: String(r.email) },
        data: {
          email: String(r.email),
          createdAt: toDate(r.created_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 17. pb_eng_tip_categories --------------------------------------------
  {
    const s = step("pb_eng_tip_categories");
    const rows = await readSy15(
      sy15,
      "pb_eng_tip_categories",
      `id::text AS id, naziv, slug, ikona, boja, redosled, je_aktivna, created_at, updated_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbEngTipCategory,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          naziv: String(r.naziv),
          slug: String(r.slug),
          ikona: str(r.ikona),
          boja: str(r.boja),
          redosled: Number(r.redosled),
          jeAktivna: Boolean(r.je_aktivna),
          createdAt: toDate(r.created_at) ?? new Date(),
          updatedAt: toDate(r.updated_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 18. pb_eng_tips ------------------------------------------------------
  {
    const s = step("pb_eng_tips");
    // `search_tsv` se NE čita — puni ga trigger u 3.0 bazi.
    const rows = await readSy15(
      sy15,
      "pb_eng_tips",
      `id::text AS id, naslov, telo, category_id::text AS category_id, tags, vendor,
       url, project_id::text AS project_id, status::text AS status,
       author_id::text AS author_id, author_email, likes_count, views_count,
       created_at, updated_at, created_by, updated_by, deleted_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbEngTip,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            naslov: String(r.naslov),
            telo: String(r.telo),
            categoryId: str(r.category_id),
            tags: (r.tags as string[] | null) ?? [],
            vendor: str(r.vendor),
            url: str(r.url),
            projectId: mapProject(s, projects, r.project_id, `pb_eng_tips:${id}`),
            status: String(r.status),
            authorId: lowerUuid(r.author_id),
            authorEmail: str(r.author_email),
            likesCount: Number(r.likes_count),
            viewsCount: Number(r.views_count),
            createdAt: toDate(r.created_at) ?? new Date(),
            updatedAt: toDate(r.updated_at) ?? new Date(),
            createdBy: str(r.created_by),
            updatedBy: str(r.updated_by),
            deletedAt: toDate(r.deleted_at),
          },
        };
      }),
    );
  }

  // --- 19. pb_eng_tip_files -------------------------------------------------
  {
    const s = step("pb_eng_tip_files");
    // `is_image` je generisana kolona — ne prenosi se.
    const rows = await readSy15(
      sy15,
      "pb_eng_tip_files",
      `id::text AS id, tip_id::text AS tip_id, storage_path, file_name, mime_type,
       size_bytes, uploaded_by, created_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbEngTipFile,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          tipId: String(r.tip_id),
          storagePath: String(r.storage_path),
          fileName: String(r.file_name),
          mimeType: str(r.mime_type),
          sizeBytes: toBigInt(r.size_bytes),
          uploadedBy: str(r.uploaded_by),
          createdAt: toDate(r.created_at) ?? new Date(),
        },
      })),
    );
  }

  // --- 20. pb_eng_tip_likes -------------------------------------------------
  // PK je (tip_id, user_id); `user_id` je bio auth uuid -> sada `users.id`.
  // Nerazrešen nalog = red se PRESKAČE (ne sme se lajk pripisati tuđem nalogu,
  // a NULL nije moguć jer je deo ključa).
  {
    const s = step("pb_eng_tip_likes");
    const rows = await readSy15(
      sy15,
      "pb_eng_tip_likes",
      `tip_id::text AS tip_id, user_id::text AS user_id, user_email, created_at`,
    );
    s.read = rows.length;
    const mapped: { where: { tipId_userId: { tipId: string; userId: number } }; data: unknown }[] =
      [];
    for (const r of rows) {
      const uid = mapUser(s, users, r.user_id, `pb_eng_tip_likes:${String(r.tip_id)}`);
      if (uid === null) {
        s.skipped += 1;
        blockers.push(
          `pb_eng_tip_likes: nalog ${String(r.user_id)} nije razrešen — lajk preskočen ` +
            `(tip ${String(r.tip_id)}, mejl ${normEmail(str(r.user_email)) ?? "?"}).`,
        );
        continue;
      }
      mapped.push({
        where: { tipId_userId: { tipId: String(r.tip_id), userId: uid } },
        data: {
          tipId: String(r.tip_id),
          userId: uid,
          userEmail: str(r.user_email),
          createdAt: toDate(r.created_at) ?? new Date(),
        },
      });
    }
    await upsertRows(
      s,
      prisma.pbEngTipLike,
      mapped as { where: { tipId_userId: { tipId: string; userId: number } }; data: never }[],
    );
  }

  // --- 21. pb_tasks ---------------------------------------------------------
  {
    const s = step("pb_tasks");
    const rows = await readSy15(
      sy15,
      "pb_tasks",
      `id::text AS id, naziv, opis, problem, project_id::text AS project_id,
       employee_id::text AS employee_id, vrsta::text AS vrsta,
       prioritet::text AS prioritet, status::text AS status, datum_pocetka_plan,
       datum_zavrsetka_plan, datum_pocetka_real, datum_zavrsetka_real,
       procenat_zavrsenosti, norma_sati_dan, created_at, updated_at, created_by,
       updated_by, deleted_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbTask,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            naziv: String(r.naziv),
            opis: str(r.opis),
            problem: str(r.problem),
            projectId: mapProject(s, projects, r.project_id, `pb_tasks:${id}`),
            employeeId: lowerUuid(r.employee_id),
            vrsta: String(r.vrsta),
            prioritet: String(r.prioritet),
            status: String(r.status),
            datumPocetkaPlan: toDate(r.datum_pocetka_plan),
            datumZavrsetkaPlan: toDate(r.datum_zavrsetka_plan),
            datumPocetkaReal: toDate(r.datum_pocetka_real),
            datumZavrsetkaReal: toDate(r.datum_zavrsetka_real),
            procenatZavrsenosti: Number(r.procenat_zavrsenosti),
            normaSatiDan: Number(r.norma_sati_dan),
            createdAt: toDate(r.created_at) ?? new Date(),
            updatedAt: toDate(r.updated_at) ?? new Date(),
            createdBy: str(r.created_by),
            updatedBy: str(r.updated_by),
            deletedAt: toDate(r.deleted_at),
          },
        };
      }),
    );
  }

  // --- 22. pb_task_comments -------------------------------------------------
  {
    const s = step("pb_task_comments");
    const rows = await readSy15(
      sy15,
      "pb_task_comments",
      `id::text AS id, task_id::text AS task_id, body, mentions, created_at,
       updated_at, created_by, created_by_user_id::text AS created_by_user_id, edited_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbTaskComment,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            taskId: String(r.task_id),
            body: String(r.body),
            mentions: (r.mentions as string[] | null) ?? [],
            createdAt: toDate(r.created_at) ?? new Date(),
            updatedAt: toDate(r.updated_at) ?? new Date(),
            createdBy: str(r.created_by),
            createdByUserId: mapUser(
              s,
              users,
              r.created_by_user_id,
              `pb_task_comments:${id}`,
            ),
            editedAt: toDate(r.edited_at),
          },
        };
      }),
    );
  }

  // --- 23. pb_task_deps -----------------------------------------------------
  {
    const s = step("pb_task_deps");
    const rows = await readSy15(
      sy15,
      "pb_task_deps",
      `id::text AS id, task_id::text AS task_id,
       depends_on_task_id::text AS depends_on_task_id, created_at, created_by`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbTaskDep,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          taskId: String(r.task_id),
          dependsOnTaskId: String(r.depends_on_task_id),
          createdAt: toDate(r.created_at) ?? new Date(),
          createdBy: str(r.created_by),
        },
      })),
    );
  }

  // --- 24. pb_task_files ----------------------------------------------------
  {
    const s = step("pb_task_files");
    const rows = await readSy15(
      sy15,
      "pb_task_files",
      `id::text AS id, task_id::text AS task_id, file_name, storage_path, mime_type,
       size_bytes, category, description, deleted_at, uploaded_at,
       uploaded_by::text AS uploaded_by, uploaded_by_email`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbTaskFile,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            taskId: String(r.task_id),
            fileName: String(r.file_name),
            storagePath: String(r.storage_path),
            mimeType: str(r.mime_type),
            sizeBytes: toBigInt(r.size_bytes),
            category: str(r.category),
            description: str(r.description),
            deletedAt: toDate(r.deleted_at),
            uploadedAt: toDate(r.uploaded_at) ?? new Date(),
            uploadedByUserId: mapUser(s, users, r.uploaded_by, `pb_task_files:${id}`),
            uploadedByEmail: str(r.uploaded_by_email),
          },
        };
      }),
    );
  }

  // --- 25. pb_work_reports --------------------------------------------------
  {
    const s = step("pb_work_reports");
    const rows = await readSy15(
      sy15,
      "pb_work_reports",
      `id::text AS id, employee_id::text AS employee_id, datum, sati::text AS sati,
       opis, created_at, created_by`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbWorkReport,
      rows.map((r) => ({
        where: { id: String(r.id) },
        data: {
          id: String(r.id),
          employeeId: lowerUuid(r.employee_id),
          datum: toDate(r.datum) ?? new Date(),
          sati: String(r.sati),
          opis: str(r.opis),
          createdAt: toDate(r.created_at) ?? new Date(),
          createdBy: str(r.created_by),
        },
      })),
    );
  }

  // --- 26. pb_notification_config -------------------------------------------
  {
    const s = step("pb_notification_config");
    const rows = await readSy15(
      sy15,
      "pb_notification_config",
      `id, enabled, deadline_warning_days, overload_threshold_pct, email_recipients,
       notify_on_blocked, notify_on_overload, notify_on_deadline_warning,
       notify_on_deadline_overdue, notify_on_no_engineer, updated_at, updated_by,
       quiet_hours_start::text AS quiet_hours_start,
       quiet_hours_end::text AS quiet_hours_end, quiet_hours_tz, digest_mode`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbNotificationConfig,
      rows.map((r) => ({
        where: { id: Number(r.id) },
        data: {
          id: Number(r.id),
          enabled: Boolean(r.enabled),
          deadlineWarningDays: Number(r.deadline_warning_days),
          overloadThresholdPct: Number(r.overload_threshold_pct),
          emailRecipients: (r.email_recipients as string[] | null) ?? [],
          notifyOnBlocked: Boolean(r.notify_on_blocked),
          notifyOnOverload: Boolean(r.notify_on_overload),
          notifyOnDeadlineWarning: Boolean(r.notify_on_deadline_warning),
          notifyOnDeadlineOverdue: Boolean(r.notify_on_deadline_overdue),
          notifyOnNoEngineer: Boolean(r.notify_on_no_engineer),
          updatedAt: toDate(r.updated_at),
          updatedBy: str(r.updated_by),
          quietHoursStart: toTime(r.quiet_hours_start),
          quietHoursEnd: toTime(r.quiet_hours_end),
          quietHoursTz: String(r.quiet_hours_tz),
          digestMode: Boolean(r.digest_mode),
        },
      })),
    );
  }

  // --- 27. pb_notification_log ----------------------------------------------
  {
    const s = step("pb_notification_log");
    const rows = await readSy15(
      sy15,
      "pb_notification_log",
      `id::text AS id, channel, recipient, recipient_user_id::text AS recipient_user_id,
       subject, body, trigger_type, related_task_id::text AS related_task_id,
       related_employee_id::text AS related_employee_id, status, error, attempts,
       scheduled_at, next_attempt_at, last_attempt_at, sent_at, created_at, payload,
       processed_at`,
    );
    s.read = rows.length;
    await upsertRows(
      s,
      prisma.pbNotificationLog,
      rows.map((r) => {
        const id = String(r.id);
        return {
          where: { id },
          data: {
            id,
            channel: String(r.channel),
            recipient: String(r.recipient),
            recipientUserId: mapUser(
              s,
              users,
              r.recipient_user_id,
              `pb_notification_log:${id}`,
            ),
            subject: str(r.subject),
            body: String(r.body),
            triggerType: String(r.trigger_type),
            relatedTaskId: str(r.related_task_id),
            relatedEmployeeId: lowerUuid(r.related_employee_id),
            status: String(r.status),
            error: str(r.error),
            attempts: Number(r.attempts),
            scheduledAt: toDate(r.scheduled_at) ?? new Date(),
            nextAttemptAt: toDate(r.next_attempt_at) ?? new Date(),
            lastAttemptAt: toDate(r.last_attempt_at),
            sentAt: toDate(r.sent_at),
            createdAt: toDate(r.created_at) ?? new Date(),
            payload: (r.payload ?? undefined) as object | undefined,
            processedAt: toDate(r.processed_at),
          },
        };
      }),
    );
  }
}

// ===========================================================================
// VERIFIKACIJA — poređenje broja redova izvor/odredište, tabela po tabela
// ===========================================================================

const TARGET_COUNTERS: Record<string, (p: PrismaClient) => Promise<number>> = {
  sastanci_templates: (p) => p.sastanciTemplate.count(),
  sastanci_template_ucesnici: (p) => p.sastanciTemplateUcesnik.count(),
  sastanci: (p) => p.sastanak.count(),
  sastanak_ucesnici: (p) => p.sastanakUcesnik.count(),
  pm_teme: (p) => p.pmTema.count(),
  akcioni_plan: (p) => p.akcionaTacka.count(),
  akcioni_plan_istorija: (p) => p.akcionaTackaIstorija.count(),
  sastanak_odluke: (p) => p.sastanakOdluka.count(),
  sastanak_arhiva: (p) => p.sastanakArhiva.count(),
  presek_aktivnosti: (p) => p.presekAktivnost.count(),
  presek_slike: (p) => p.presekSlika.count(),
  sastanci_notification_prefs: (p) => p.sastanciNotificationPrefs.count(),
  sastanci_notification_log: (p) => p.sastanciNotificationLog.count(),
  sastanci_ai_settings: (p) => p.sastanciAiSettings.count(),
  sast_weekly_skip: (p) => p.sastWeeklySkip.count(),
  sast_weekly_movers: (p) => p.sastWeeklyMover.count(),
  pb_eng_tip_categories: (p) => p.pbEngTipCategory.count(),
  pb_eng_tips: (p) => p.pbEngTip.count(),
  pb_eng_tip_files: (p) => p.pbEngTipFile.count(),
  pb_eng_tip_likes: (p) => p.pbEngTipLike.count(),
  pb_tasks: (p) => p.pbTask.count(),
  pb_task_comments: (p) => p.pbTaskComment.count(),
  pb_task_deps: (p) => p.pbTaskDep.count(),
  pb_task_files: (p) => p.pbTaskFile.count(),
  pb_work_reports: (p) => p.pbWorkReport.count(),
  pb_notification_config: (p) => p.pbNotificationConfig.count(),
  pb_notification_log: (p) => p.pbNotificationLog.count(),
};

async function verify(
  prisma: PrismaClient,
  sy15: Sy15PrismaClient,
): Promise<void> {
  let ok = 0;
  let bad = 0;
  for (const t of TABLES) {
    const srcRows = await sy15.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public.${t}`,
    );
    const src = Number(srcRows[0]?.n ?? 0);
    const dst = await TARGET_COUNTERS[t](prisma);
    const mark = src === dst ? "OK  " : "!!! ";
    if (src === dst) ok += 1;
    else bad += 1;
    console.log(
      `${mark}${t.padEnd(30)} sy15=${String(src).padStart(5)}  3.0=${String(dst).padStart(5)}`,
    );
  }
  console.log(`\n  poklapa se: ${ok}/${TABLES.length}${bad > 0 ? `  RAZLIKA: ${bad}` : ""}`);
  if (bad > 0) {
    blockers.push(`Verifikacija: ${bad} tabela se NE poklapa po broju redova.`);
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
      `  ${name.padEnd(30)} read=${String(s.read).padStart(4)} write=${String(s.written).padStart(4)}${det}${
        s.skipped > 0 ? ` SKIP=${s.skipped}` : ""
      }`,
    );
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      console.log(`      ${cat}: ${keys.length} (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""})`);
    }
  }
  console.log(
    `\n  UKUPNO read=${read} write=${written}${APPLY ? ` ins=${inserted} upd=${updated}` : ""}${
      skipped > 0 ? ` skip=${skipped}` : ""
    }`,
  );

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
