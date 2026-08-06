import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
// 3.0 Prisma namespace pod aliasom — modul radi sa DVA klijenta (sy15 i 3.0) i
// njihovi `WhereInput` tipovi se razlikuju (`projekatId` uuid vs `projectId` Int).
// Alias je obavezan: bez njega bi 3.0 upiti tiho preuzeli sy15 tipove.
import { Prisma as PrismaTriNula } from "@prisma/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import { SastanciSamouslugaService } from "./sastanci-samousluga.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SastanciFnService, type SastanciTx } from "./sastanci-fn.service";
import { SastanciAuthzService } from "./sastanci-authz.service";
import { SastanciPredmetService } from "./sastanci-predmet.service";
import { predmetZaSy15, saPredmetom } from "./sastanci-predmet";
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { assertPdfAttachment } from "../../common/attachments/attachment-format.util";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { AI_MODULE } from "../../common/ai/ai-limits.service";
import {
  AI_TASK,
  AiModelPolicyService,
} from "../../common/ai/ai-model-policy.service";
import {
  SASTANCI_INJECTION_FENCE,
  fenceUserInput,
} from "../../common/ai/injection-fence";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  SUMMARY_ALLOWED_MODELS,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryContent,
} from "./sastanci-summary";
import type {
  AkcijeQueryDto,
  ListSastanciQueryDto,
  NotificationsQueryDto,
  TemeQueryDto,
  WeeklyDiffQueryDto,
} from "./dto/sastanci-query.dto";
import type {
  AddUcesnikDto,
  BulkStatusDto,
  BulkUcesniciDto,
  CancelSastanakDto,
  CreateAkcijaDto,
  CreateAktivnostDto,
  CreateDraftTemaDto,
  CreateOdlukaDto,
  CreateSastanakDto,
  CreateTemaDto,
  CreateTemplateDto,
  DraftReviewDto,
  DraftUvediDto,
  InstantiateTemplateDto,
  LockSastanakDto,
  PatchAkcijaDto,
  PrenosDto,
  ReorderDto,
  ReorderRangDto,
  MyAkcijaStatusDto,
  MyPripremaDto,
  RsvpDto,
  SetAiModelDto,
  SetZapisnikDatumDto,
  TemaAdminRangDto,
  TemaDodeliDto,
  TemaHitnoDto,
  TemaRazmatranjeDto,
  UpdateAktivnostDto,
  UpdateOdlukaDto,
  UpdatePrefsDto,
  UpdateSastanakDto,
  UpdateTemaDto,
  UpdateSlikaDto,
  UpdateTemplateDto,
  UpdateUcesnikDto,
  UploadSlikaDto,
  WeeklyOdloziDto,
  WeeklyPomeriDto,
  WeeklyVratiDto,
} from "./dto/sastanci-mutation.dto";
import { nextOccurrence } from "./templates-cadence";
import {
  sledeciSedmicniTermin,
  type SledeciSedmicni,
} from "./weekly-rollover";
import {
  bazaLancaUpit,
  sledeciPeriodicniTermin,
} from "./periodicni-rollover";

/**
 * Sastanci — 3.0 TALAS B, R1 read sloj (MODULE_SPEC_sastanci_ai_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (doktrina §A.1); ovaj servis samo ČITA:
 *  - tabele kroz Prisma (`prisma/sy15.prisma`, bez FK relacija — 1.0 šema ih nema,
 *    spajanja su ručni batch-resolve),
 *  - view-ove `v_akcioni_plan` / `v_pm_teme_pregled` kroz $queryRaw (view ostaje u bazi,
 *    security_invoker → RLS pozivaoca; paritet 1:1 sa 1.0 frontom),
 *  - RPC-ove (sast_weekly_status, sast_dashboard_stats, get_sastanci_user_directory,
 *    sastanci_get_or_create_my_prefs) kroz isti most.
 * SVE ide kroz `Sy15Service.withUserRls` (GUC claims + SET LOCAL ROLE authenticated):
 * konekciona rola je BYPASSRLS (izmereno na sy15), pa row-scope (pm_teme vidljivost,
 * notification_log svoje∨mgmt…) sprovodi RLS TEK pod `authenticated` — scope se NE
 * duplira u WHERE. Mutacije/RPC-write su R2.
 *
 * ⚠️ `rsvp_token` (tajna magic-linka) se NIKAD ne vraća — učesnici se čitaju kroz
 * `UCESNIK_SELECT` koji ga izostavlja (§1/§3).
 */

/** Kolone učesnika bez `rsvpToken` (tajna magic-linka — §1). */
const UCESNIK_SELECT = {
  sastanakId: true,
  email: true,
  label: true,
  prisutan: true,
  pozvan: true,
  napomena: true,
  pripremljen: true,
  priprema: true,
  rsvpStatus: true,
  rsvpAt: true,
} as const;

/** Sort akcija — paritet 1.0 loadAkcije (akcioniPlan.js): rb, rok, prioritet, created_at.
 *  Kvalifikovano `a.` — koristi se uz AKCIJE_SELECT join (projects ima svoj created_at). */
const AKCIJE_ORDER = Prisma.sql`ORDER BY a.rb ASC NULLS LAST, a.rok ASC NULLS LAST, a.prioritet ASC, a.created_at DESC`;

/**
 * Redovi akcija + projekat polja za grupisanje po RN-u (S-P0 paket 2): 1.0 view
 * v_akcioni_plan NEMA projekat kolone — 1.0 ih spaja u JS-u (loadProjektiLite →
 * projects.project_code/project_name/bigtehn_item_id, sastanciArhiva.js:19-49).
 * Ovde isti izvor kroz LEFT JOIN; camelCase aliasi su DODATA polja uz sirove
 * view kolone (FE header grupe = „projekatCode — projekatNaziv", rank po
 * bigtehnItemId u ⭐ listi). bigtehn_item_id → text (ugovor: string|null).
 */
const AKCIJE_SELECT = Prisma.sql`SELECT a.*,
    p.project_name AS "projekatNaziv",
    p.project_code AS "projekatCode",
    p.bigtehn_item_id::text AS "bigtehnItemId"
  FROM v_akcioni_plan a
  LEFT JOIN projects p ON p.id = a.projekat_id`;

/**
 * 3.0 parnjak `AKCIJE_SELECT`. Kolone predmeta se ZOVU drugačije, pa se JOIN i
 * aliasi moraju prevesti (runbook blokada 5): sy15 `project_code` -> 3.0
 * `project_number`, a `bigtehn_item_id` (koji je i bio 3.0 id) -> sam `p.id`.
 *
 * Izmereno na 3.0 produkciji 06.08.2026: `projects` ima 7.631 red, od toga
 * `project_name` popunjen 7.472 puta a `description` 4.044 — zato je parnjak
 * naziva `project_name`, ne `description`.
 *
 * `bigtehnItemId` ostaje `text` (ugovor prema FE-u je `string|null`, koristi ga
 * rang u ⭐ listi) iako je izvor sada Int — konverzija je u SQL-u, ne u JS-u.
 *
 * Uz sirove view kolone dodaje se i `projekatUuid` — stari FE predmet poredi po
 * uuid-u (v. `sastanci-predmet.ts`). Računa se u JS-u (`saPredmetom`) jer md5 u
 * SQL-u ne bi mogao da zna za dva izmerena izuzetka.
 */
const AKCIJE_SELECT_30 = Prisma.sql`SELECT a.*,
    p.project_name AS "projekatNaziv",
    p.project_number AS "projekatCode",
    p.id::text AS "bigtehnItemId"
  FROM v_akcioni_plan a
  LEFT JOIN projects p ON p.id = a.projekat_id`;

/** Sastanak koji je „prošao" — kandidat za kolonu „Sledeći" u listi (024/26 d.29.07-1). */
const ZAVRSNI_STATUSI = ["zavrsen", "zakljucan", "otkazan"] as const;

/** Poruka kad tip 'periodicni' stigne PRE nego što je sy15 skripta primenjena. */
const PERIODICNI_SQL_PORUKA =
  "Periodični sastanci još nisu aktivirani na bazi — primeniti " +
  "backend/docs/sql/sy15/sastanci-024-periodicni-2026-08-04/10_periodicni_kolone_i_statusi.sql " +
  "pa restartovati backend.";

/** Termin SLEDEĆEG sastanka serije uz red liste (024/26, komentar 29.07 t.1):
 *  `sastanakId` postoji kad je termin već kreiran; `najava=true` = izračunat
 *  termin koji će automatika tek napraviti (sedmični petak 08h / periodični
 *  dnevni posao 08h). */
export interface SledeciTermin {
  datum: string;
  vreme: string | null;
  sastanakId: string | null;
  najava: boolean;
}

@Injectable()
export class SastanciService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
    private readonly ai: AiProviderService,
    private readonly policy: AiModelPolicyService,
    private readonly izvor: SastanciSourceService,
    private readonly samousluga: SastanciSamouslugaService,
    private readonly prisma: PrismaService,
    private readonly fn: SastanciFnService,
    private readonly authz: SastanciAuthzService,
    private readonly idem: IdempotencyService,
    private readonly predmet: SastanciPredmetService,
  ) {}

  private readonly logger = new Logger(SastanciService.name);

  /**
   * Transakcija nad 3.0 bazom za PRENETE putanje (prekidač u položaju `3.0`).
   *
   * ZAŠTO NIJE `withUserMapped`: taj geter je brana ka sy15 i pod `3.0` NAMERNO
   * pada sa 503. Prenete putanje ne prolaze kroz njega nego kroz ovaj metod —
   * tako brana ostaje na snazi za sve što JOŠ NIJE preneto, a preneto radi.
   *
   * ⚠️ NEMA IDEMPOTENCIJE: `rev_api_idempotency` (registar `clientEventId`-jeva)
   * živi ISKLJUČIVO u sy15 i NE seli se u ovom koraku (runbook §7, rep 6). Zato
   * kroz ovaj put idu SAMO radnje koje imaju SOPSTVENU branu ponavljanja u
   * podacima (`already_locked`, `already_cancelled`) — one kojima je registar
   * jedina brana (create/bulk/prenos/instantiate) ostaju iza 503.
   */
  private async threeZeroTx<T>(fn: (tx: SastanciTx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction((tx) => fn(tx));
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * ČITANJE pod `3.0` bez transakcije — za rute koje samo `SELECT`-uju.
   *
   * ZAŠTO POSTOJI ODVOJENO OD `threeZeroTx`: liste i detalji su čist read;
   * umotavanje svakog u `$transaction` bi bez ijedne koristi držalo konekciju i
   * otvaralo transakciju po zahtevu. Mapiranje grešaka (`rethrowSy15`) ostaje
   * isto, pa je ugovor prema klijentu nepromenjen.
   */
  private async threeZeroRead<T>(fn: (tx: SastanciTx) => Promise<T>): Promise<T> {
    try {
      return await fn(this.prisma);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  // ---------- Izlaz reda koji nosi PREDMET (blokada 5) ----------
  //
  // 🔴 3.0 Prisma model kolonu `projekat_id` zove `projectId`, a sy15 model ju
  // je zvao `projekatId`. Bez prevoda bi sam prelazak na 3.0 TIHO preimenovao
  // polje u svakom odgovoru i FE bi svuda video „bez predmeta" — bez ijedne
  // greške u logu. Zato svaki red koji nosi predmet prolazi kroz `saPredmetom`,
  // koji vraća `projekatId` (Int) + `projekatUuid` (za stare klijente).

  /** Jedan red iz 3.0 baze -> red za klijenta. */
  private predmetOut<T extends { projectId?: number | null }>(row: T) {
    return saPredmetom(row);
  }

  /** Isto, za listu; `null` prolazi nepromenjen (404 grane vraćaju null). */
  private predmetOutMany<T extends { projectId?: number | null }>(rows: T[]) {
    return rows.map((r) => saPredmetom(r));
  }

  /**
   * Red view-a `v_akcioni_plan` (raw, snake_case) -> red za klijenta. View
   * kolonu `projekat_id` ostavlja kakva jeste (FE je već tako čita), a DODAJE
   * `projekatUuid` da stari klijent može da poklopi predmet.
   */
  private akcijaViewOut(rows: unknown[]): unknown[] {
    return (rows as { projekat_id?: number | null }[]).map((r) => ({
      ...r,
      projekatUuid:
        r.projekat_id == null ? null : saPredmetom({ projectId: r.projekat_id }).projekatUuid,
    }));
  }

  // ---------- Liste / pretraga ----------

  /** Lista sastanaka + filteri (paritet 1.0 loadSastanci). */
  async list(email: string, query: ListSastanciQueryDto) {
    if (this.izvor.isThreeZero) return this.list30(query);
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.SastanakWhereInput = {
      ...(query.tip ? { tip: query.tip } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.projekatId
        ? { projekatId: predmetZaSy15(query.projekatId) ?? undefined }
        : {}),
      ...(query.from || query.to
        ? {
            datum: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { naslov: { contains: query.q, mode: "insensitive" } },
              { mesto: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    return this.withUserMapped(email, async (tx) => {
      const [data, total] = await Promise.all([
        tx.sastanak.findMany({
          where,
          orderBy: [{ datum: "desc" }, { vreme: "desc" }],
          skip,
          take,
        }),
        tx.sastanak.count({ where }),
      ]);
      // 024/26 (komentar 29.07 t.1): zatvoren red nosi i termin SLEDEĆEG
      // sastanka serije — kolona „Sledeći" u tabeli.
      const enriched = await this.dodajSledeci(tx, data);
      return { data: enriched, meta: pageMeta(page, pageSize, total) };
    });
  }

  /**
   * Uz svaki ZATVOREN red (zavrsen/zakljucan/otkazan) priloži `sledeci` — termin
   * sledećeg sastanka iste serije (024/26, Zoranov komentar 29.07 t.1: „kada se
   * sastanak završi i zatvori, u tabeli treba da se pojavi datum sledećeg").
   *
   * Dve rekonstrukcije „sledećeg", po tipu:
   *  - NE-periodični (serija ne postoji kao entitet): prvi NEOTKAZAN sastanak
   *    ISTOG TIPA sa kasnijim datumom; sedmični bez takvog reda → NAJAVA iz
   *    `sledeciSedmicniTermin` (isto pravilo kao traka najave, petak 08h).
   *  - PERIODIČNI (review MAJOR-1): naslednik ISKLJUČIVO po lancu
   *    `prethodni_sastanak_id` — po tipu bi dve paralelne serije jedna drugoj
   *    „pozajmljivale" termine. Bez naslednika (ili sa OTKAZANIM naslednikom,
   *    koji je tada rep serije za automatiku) → NAJAVA iz BAZNOG ritma lanca
   *    (`bazaLancaUpit` + `sledeciPeriodicniTermin` — isto pravilo kao
   *    automatika `sast-periodicni-auto`). Raw upiti — kolone su van Prisma
   *    mape (vidi `periodicniKolone`); pre skripte periodičnih redova nema.
   * Otvoren (planiran/u toku) red nema `sledeci` — njegov termin JE sledeći.
   */
  private async dodajSledeci<
    T extends {
      id: string;
      tip: string;
      datum: Date;
      vreme: Date | null;
      status: string;
    },
  >(tx: Sy15Tx, rows: T[]): Promise<(T & { sledeci?: SledeciTermin | null })[]> {
    const zatvoreni = rows.filter((r) =>
      (ZAVRSNI_STATUSI as readonly string[]).includes(r.status),
    );
    if (!zatvoreni.length) return rows;
    const { danas, sat } = this.belgradeDanasSat();

    // ── NE-periodični: naslednik po tipu ──
    const obicni = zatvoreni.filter((r) => r.tip !== "periodicni");
    const tipovi = [...new Set(obicni.map((r) => r.tip))];
    let nasledniciRedovi: {
      id: string;
      tip: string;
      datum: Date;
      vreme: Date | null;
    }[] = [];
    if (tipovi.length) {
      const minDatum = obicni.reduce(
        (m, r) => (this.ymd(r.datum) < m ? this.ymd(r.datum) : m),
        this.ymd(obicni[0].datum),
      );
      nasledniciRedovi = await tx.sastanak.findMany({
        where: {
          tip: { in: tipovi },
          status: { not: "otkazan" },
          datum: { gt: this.toDbDate(minDatum)! },
        },
        select: { id: true, tip: true, datum: true, vreme: true },
        orderBy: [{ datum: "asc" }, { vreme: "asc" }],
        take: 500,
      });
    }
    const bezNaslednika = (r: T) =>
      !nasledniciRedovi.some(
        (n) => n.tip === r.tip && this.ymd(n.datum) > this.ymd(r.datum),
      );
    const trebaSedmicnaNajava = obicni.some(
      (r) => r.tip === "sedmicni" && bezNaslednika(r),
    );

    // ── Periodični: naslednik po lancu (MAJOR-1) ──
    const periodicni = zatvoreni.filter((r) => r.tip === "periodicni");
    // pret → direktan naslednik (raw: datum/vreme već kao text).
    const lanacNaslednik = new Map<
      string,
      { id: string; datum: string; vreme: string | null; status: string }
    >();
    // rep za najavu → { baza, interval } (rep = red bez naslednika ILI njegov
    // otkazan naslednik — od otkazanog repa automatika nastavlja seriju).
    let bazaMapa = new Map<string, { baza: string; interval: number }>();
    if (periodicni.length && (await this.periodicniKolone(tx))) {
      const direktni = await tx.$queryRaw<
        {
          pret: string;
          id: string;
          datum: string;
          vreme: string | null;
          status: string;
        }[]
      >(
        Prisma.sql`SELECT prethodni_sastanak_id::text AS pret, id::text AS id,
            datum::text AS datum, left(vreme::text, 5) AS vreme, status
          FROM sastanci
          WHERE prethodni_sastanak_id = ANY(${periodicni.map((r) => r.id)}::uuid[])`,
      );
      for (const n of direktni) lanacNaslednik.set(n.pret, n);
      const repIds = periodicni
        .map((r) => {
          const n = lanacNaslednik.get(r.id);
          if (!n) return r.id;
          return n.status === "otkazan" ? n.id : null;
        })
        .filter((id): id is string => id !== null);
      if (repIds.length) {
        const bazaRows = await tx.$queryRaw<
          { id: string; baza: string; interval_days: number | null }[]
        >(bazaLancaUpit([...new Set(repIds)]));
        bazaMapa = new Map(
          bazaRows
            .filter((b) => b.interval_days != null)
            .map((b) => [
              b.id,
              { baza: b.baza, interval: Number(b.interval_days) },
            ]),
        );
      }
    }

    // Praznici/najava — samo ako ih neko stvarno traži.
    let sedmicnaNajava: SledeciSedmicni | null = null;
    let praznici: string[] = [];
    if (trebaSedmicnaNajava || bazaMapa.size) {
      praznici = await this.neradniPraznici(tx, danas);
    }
    if (trebaSedmicnaNajava) {
      sedmicnaNajava = await this.izracunajSledeciSedmicni(
        tx,
        danas,
        sat,
        praznici,
      );
    }

    return rows.map((r) => {
      if (!(ZAVRSNI_STATUSI as readonly string[]).includes(r.status)) return r;
      const rDatum = this.ymd(r.datum);

      if (r.tip === "periodicni") {
        const n = lanacNaslednik.get(r.id);
        if (n && n.status !== "otkazan") {
          return {
            ...r,
            sledeci: {
              datum: n.datum,
              vreme: n.vreme,
              sastanakId: n.id,
              najava: false,
            },
          };
        }
        // Rep serije: sam red, ili njegov otkazan naslednik (automatika iz
        // njega niče) — najava iz BAZNOG ritma (MAJOR-2: pomeren datum nije ulaz).
        const rep = n
          ? { id: n.id, datum: n.datum, vreme: n.vreme }
          : { id: r.id, datum: rDatum, vreme: this.hhmm(r.vreme) };
        const info = bazaMapa.get(rep.id);
        if (!info) return { ...r, sledeci: null };
        return {
          ...r,
          sledeci: {
            datum: sledeciPeriodicniTermin({
              datum: info.baza,
              intervalDays: info.interval,
              danas,
              praznici,
              posle: rep.datum,
            }),
            vreme: rep.vreme,
            sastanakId: null,
            najava: true,
          },
        };
      }

      const naslednik = nasledniciRedovi.find(
        (n) => n.tip === r.tip && this.ymd(n.datum) > rDatum,
      );
      if (naslednik) {
        return {
          ...r,
          sledeci: {
            datum: this.ymd(naslednik.datum),
            vreme: this.hhmm(naslednik.vreme),
            sastanakId: naslednik.id,
            najava: false,
          },
        };
      }
      if (r.tip === "sedmicni" && sedmicnaNajava) {
        return {
          ...r,
          sledeci: {
            datum: sedmicnaNajava.datum,
            vreme: sedmicnaNajava.vreme,
            sastanakId: sedmicnaNajava.sastanakId,
            najava: sedmicnaNajava.sastanakId === null,
          },
        };
      }
      return { ...r, sledeci: null };
    });
  }

  /** „Moji sastanci" — svi na kojima je pozivalac učesnik (paritet 1.0 „Moj rad"). */
  async myMeetings(email: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const parts = await tx.sastanakUcesnik.findMany({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { sastanakId: true },
        });
        const ids = [...new Set(parts.map((p) => p.sastanakId))];
        const data = ids.length
          ? await tx.sastanak.findMany({
              where: { id: { in: ids } },
              orderBy: [{ datum: "desc" }],
            })
          : [];
        return { data: this.predmetOutMany(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const parts = await tx.sastanakUcesnik.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { sastanakId: true },
      });
      const ids = [...new Set(parts.map((p) => p.sastanakId))];
      const data = ids.length
        ? await tx.sastanak.findMany({
            where: { id: { in: ids } },
            orderBy: [{ datum: "desc" }],
          })
        : [];
      return { data };
    });
  }

  /**
   * Sledeći PLANIRAN sastanak — paritet 1.0 loadNextPlaniranSastanak (sastanci.js:148):
   * BEZ tip filtera (bilo koji tip), datum >= DANAS po LOKALNOM (Europe/Belgrade)
   * kalendaru, datum asc, prvi red.
   *
   * Uz `data` vraća i `sedmicni` (zahtev 024/26 a) — termin sledećeg SEDMIČNOG
   * sastanka. Kad ga automatika još nije kreirala (`sastanakId === null`), to je
   * NAJAVA izračunata iz istog pravila po kojem radi pg_cron posao `sast-weekly-auto`
   * (petak 08h → `sast_auto_create_weekly`); vidi `weekly-rollover.ts`. Bez toga UI
   * posle zatvaranja sedmičnog nema šta da pokaže osim poslednjeg (zatvorenog)
   * termina, pa deluje kao da je datum „zaglavljen".
   */
  async nextWeekly(email: string) {
    const { danas, sat } = this.belgradeDanasSat();
    const odDanas = new Date(danas);
    if (this.izvor.isThreeZero) {
      // Praznici pod 3.0 dolaze sa sy15 (kadr_holidays je kadrovska, korak 4) —
      // isti fail-soft put koji već koristi `weeklyStatus`.
      const praznici = [...(await this.prazniciZaTriNula())];
      return this.threeZeroRead(async (tx) => {
        const data = await tx.sastanak.findFirst({
          where: { status: "planiran", datum: { gte: odDanas } },
          orderBy: [{ datum: "asc" }],
        });
        const sedmicni = await this.izracunajSledeciSedmicni30(
          tx,
          danas,
          sat,
          praznici,
        );
        return { data: data ? this.predmetOut(data) : data, sedmicni };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const [data, praznici] = await Promise.all([
        tx.sastanak.findFirst({
          where: { status: "planiran", datum: { gte: odDanas } },
          orderBy: [{ datum: "asc" }],
        }),
        this.neradniPraznici(tx, danas),
      ]);
      const sedmicni = await this.izracunajSledeciSedmicni(
        tx,
        danas,
        sat,
        praznici,
      );
      return { data, sedmicni };
    });
  }

  /** Danas + tekući sat u Europe/Belgrade (izvučeno iz nextWeekly — deli i lista). */
  private belgradeDanasSat(): { danas: string; sat: number } {
    // en-CA locale daje YYYY-MM-DD; sidro je Beograd, ne UTC (posle 22h leti UTC ide u sutra).
    const now = new Date();
    const danas = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
    }).format(now);
    // h23 (ne hour12:false) — u pojedinim ICU verzijama „2-digit + hour12:false" daje 24 u ponoć.
    const sat =
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Belgrade",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(now),
      ) % 24;
    return { danas, sat };
  }

  /** Neradni praznici u prozoru 90 dana (8 nedelja simulacije + rezerva). */
  private async neradniPraznici(tx: Sy15Tx, danas: string): Promise<string[]> {
    const odDanas = new Date(danas);
    const rows = await tx.kadrHoliday.findMany({
      where: {
        holidayDate: {
          gte: odDanas,
          lte: new Date(odDanas.getTime() + 90 * 86_400_000),
        },
        isWorkday: false,
      },
      select: { holidayDate: true },
    });
    return rows.map((p) => this.ymd(p.holidayDate));
  }

  /** Sledeći SEDMIČNI termin (postojeći red ili najava) — vidi weekly-rollover.ts. */
  private async izracunajSledeciSedmicni(
    tx: Sy15Tx,
    danas: string,
    sat: number,
    praznici: string[],
  ): Promise<SledeciSedmicni | null> {
    const sedmicniRedovi = await tx.sastanak.findMany({
      where: { tip: "sedmicni", datum: { gte: new Date(danas) } },
      select: { id: true, datum: true, vreme: true, status: true },
      orderBy: [{ datum: "asc" }],
      take: 60,
    });
    return sledeciSedmicniTermin({
      danas,
      sat,
      sedmicni: sedmicniRedovi.map((s) => ({
        id: s.id,
        datum: this.ymd(s.datum),
        vreme: this.hhmm(s.vreme),
        status: s.status,
      })),
      praznici,
    });
  }

  /**
   * Globalna pretraga — paritet 1.0 searchSastanciGlobal (sastanci.js:330-343):
   * min 2 karaktera (ispod → prazno); vraća { akcije, sastanci }:
   * akcije iz v_akcioni_plan (naslov/opis/odgovoran_text/odgovoran_label ilike, limit 30),
   * sastanci SAMO po naslovu (datum desc, limit 15).
   */
  async search(email: string, q?: string) {
    const term = (q ?? "").trim();
    if (term.length < 2) return { data: { akcije: [], sastanci: [] } };
    const like = `%${term}%`;
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const [akcije, sastanci] = await Promise.all([
          tx.$queryRaw<unknown[]>(
            Prisma.sql`SELECT id, naslov, sastanak_id, projekat_id, effective_status, status, rok, rok_text
              FROM v_akcioni_plan
              WHERE naslov ILIKE ${like} OR opis ILIKE ${like}
                 OR odgovoran_text ILIKE ${like} OR odgovoran_label ILIKE ${like}
              LIMIT 30`,
          ),
          tx.sastanak.findMany({
            where: { naslov: { contains: term, mode: "insensitive" } },
            select: {
              id: true,
              naslov: true,
              datum: true,
              status: true,
              tip: true,
            },
            orderBy: [{ datum: "desc" }],
            take: 15,
          }),
        ]);
        return { data: { akcije: this.akcijaViewOut(akcije), sastanci } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const [akcije, sastanci] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT id, naslov, sastanak_id, projekat_id, effective_status, status, rok, rok_text
            FROM v_akcioni_plan
            WHERE naslov ILIKE ${like} OR opis ILIKE ${like}
               OR odgovoran_text ILIKE ${like} OR odgovoran_label ILIKE ${like}
            LIMIT 30`,
        ),
        tx.sastanak.findMany({
          where: { naslov: { contains: term, mode: "insensitive" } },
          select: {
            id: true,
            naslov: true,
            datum: true,
            status: true,
            tip: true,
          },
          orderBy: [{ datum: "desc" }],
          take: 15,
        }),
      ]);
      return { data: { akcije, sastanci } };
    });
  }

  // ---------- Detalj ----------

  /** Detalj sastanka (paritet getSastanakFull): učesnici (bez rsvp_token), tačke,
   *  slike, odluke, akcije (view), arhiva + overview brojke. */
  async findFull(email: string, id: string) {
    if (this.izvor.isThreeZero) return this.findFull30(id);
    return this.withUserMapped(email, async (tx) => {
      const sastanak = await tx.sastanak.findUnique({ where: { id } });
      if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      const [ucesnici, aktivnosti, slike, odluke, akcije, arhiva] =
        await Promise.all([
          tx.sastanakUcesnik.findMany({
            where: { sastanakId: id },
            select: UCESNIK_SELECT,
            orderBy: [{ label: "asc" }, { email: "asc" }],
          }),
          tx.presekAktivnost.findMany({
            where: { sastanakId: id },
            orderBy: [{ redosled: "asc" }, { rb: "asc" }],
          }),
          tx.presekSlika.findMany({
            where: { sastanakId: id },
            orderBy: [{ redosled: "asc" }],
          }),
          tx.sastanakOdluka.findMany({
            where: { sastanakId: id },
            orderBy: [
              { rb: { sort: "asc", nulls: "last" } },
              { createdAt: "asc" },
            ],
          }),
          tx.$queryRaw(
            Prisma.sql`${AKCIJE_SELECT} WHERE a.sastanak_id = ${id}::uuid ${AKCIJE_ORDER}`,
          ),
          tx.sastanakArhiva.findUnique({ where: { sastanakId: id } }),
        ]);
      const akcijeArr = akcije as { effective_status?: string }[];
      // 024/26 d1: interval serije za formu „Uredi" (kolona van Prisma mape).
      const intervalDays =
        sastanak.tip === "periodicni"
          ? ((await this.intervalDaysMapa(tx, [id])).get(id) ?? null)
          : undefined;
      return {
        data: {
          ...sastanak,
          ...(intervalDays !== undefined ? { intervalDays } : {}),
          ucesnici,
          aktivnosti,
          slike: slike.map((s) => this.slikaOut(s)),
          odluke,
          akcije: akcijeArr,
          arhiva: arhiva ? this.arhivaOut(arhiva) : arhiva,
          overview: {
            ucesnici: ucesnici.length,
            prisutni: ucesnici.filter((u) => u.prisutan).length,
            pripremljeni: ucesnici.filter((u) => u.pripremljen).length,
            aktivnosti: aktivnosti.length,
            odluke: odluke.length,
            akcije: akcijeArr.length,
            akcijeOtvorene: akcijeArr.filter((a) =>
              ["otvoren", "u_toku", "kasni"].includes(a.effective_status ?? ""),
            ).length,
          },
        },
      };
    });
  }

  /** Osnovni zapis sastanka (bez agregata). */
  async findOne(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const data = await tx.sastanak.findUnique({ where: { id } });
        if (!data) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        return { data: this.predmetOut(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanak.findUnique({ where: { id } });
      if (!data) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      return { data };
    });
  }

  /** Učesnici jednog sastanka (bez rsvp_token). */
  async ucesnici(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => ({
        data: await tx.sastanakUcesnik.findMany({
          where: { sastanakId: id },
          select: UCESNIK_SELECT,
          orderBy: [{ label: "asc" }, { email: "asc" }],
        }),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakUcesnik.findMany({
        where: { sastanakId: id },
        select: UCESNIK_SELECT,
        orderBy: [{ label: "asc" }, { email: "asc" }],
      });
      return { data };
    });
  }

  /** Tačke zapisnika (presek_aktivnosti). */
  async aktivnosti(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => ({
        data: await tx.presekAktivnost.findMany({
          where: { sastanakId: id },
          orderBy: [{ redosled: "asc" }, { rb: "asc" }],
        }),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.presekAktivnost.findMany({
        where: { sastanakId: id },
        orderBy: [{ redosled: "asc" }, { rb: "asc" }],
      });
      return { data };
    });
  }

  /** Slike uz tačke (meta; storage-bytes su u bucketu). */
  async slike(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const data = await tx.presekSlika.findMany({
          where: { sastanakId: id },
          orderBy: [{ redosled: "asc" }],
        });
        return { data: data.map((s) => this.slikaOut(s)) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.presekSlika.findMany({
        where: { sastanakId: id },
        orderBy: [{ redosled: "asc" }],
      });
      return { data: data.map((s) => this.slikaOut(s)) };
    });
  }

  /** Odluke sastanka — sort paritet 1.0 loadOdlukeBySastanak (sastanciOdluke.js:38). */
  async odluke(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => ({
        data: await tx.sastanakOdluka.findMany({
          where: { sastanakId: id },
          orderBy: [
            { rb: { sort: "asc", nulls: "last" } },
            { createdAt: "asc" },
          ],
        }),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakOdluka.findMany({
        where: { sastanakId: id },
        orderBy: [{ rb: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      });
      return { data };
    });
  }

  // ---------- Akcioni plan (view v_akcioni_plan) ----------

  /** Akcioni plan sa filterima (paritet loadAkcije). Čita ISKLJUČIVO view (effective_status). */
  async listAkcije(email: string, q: AkcijeQueryDto) {
    if (this.izvor.isThreeZero) {
      // Predmet se razrešava PRE upita: pod 3.0 je kolona `Int`, a filter može
      // stići i kao sy15 uuid (stari FE) i kao broj (novi).
      const projekat = await this.predmet.razresiFilter(q.projekatId);
      return this.threeZeroRead(async (tx) => {
        const conds: Prisma.Sql[] = [];
        if (q.sastanakId)
          conds.push(Prisma.sql`a.sastanak_id = ${q.sastanakId}::uuid`);
        if (projekat !== undefined)
          conds.push(Prisma.sql`a.projekat_id = ${projekat}`);
        if (q.status) conds.push(Prisma.sql`a.effective_status = ${q.status}`);
        if (q.odgovoranEmail)
          conds.push(
            Prisma.sql`lower(a.odgovoran_email) = lower(${q.odgovoranEmail})`,
          );
        const where = conds.length
          ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
          : Prisma.empty;
        const data = await tx.$queryRaw<unknown[]>(
          Prisma.sql`${AKCIJE_SELECT_30} ${where} ${AKCIJE_ORDER}`,
        );
        return { data: this.akcijaViewOut(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.sastanakId)
        conds.push(Prisma.sql`a.sastanak_id = ${q.sastanakId}::uuid`);
      if (q.projekatId)
        conds.push(
          Prisma.sql`a.projekat_id = ${predmetZaSy15(q.projekatId)}::uuid`,
        );
      if (q.status) conds.push(Prisma.sql`a.effective_status = ${q.status}`);
      if (q.odgovoranEmail)
        conds.push(
          Prisma.sql`lower(a.odgovoran_email) = lower(${q.odgovoranEmail})`,
        );
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`${AKCIJE_SELECT} ${where} ${AKCIJE_ORDER}`,
      );
      return { data };
    });
  }

  /** Istorija izmena jedne akcije (akcioni_plan_istorija — read; AFTER UPDATE trigger piše diff). */
  async akcijaIstorija(email: string, akcijaId: string) {
    if (this.izvor.isThreeZero) {
      // 3.0 model se zove `akcionaTackaIstorija` (tabela je ista:
      // `akcioni_plan_istorija`). Politika `ap_istorija_read` je `true` — nema
      // read-scope-a koji bi se izgubio.
      return this.threeZeroRead(async (tx) => ({
        data: await tx.akcionaTackaIstorija.findMany({
          where: { akcijaId },
          orderBy: [{ izmenjenoAt: "desc" }],
        }),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.akcioniPlanIstorija.findMany({
        where: { akcijaId },
        orderBy: [{ izmenjenoAt: "desc" }],
      });
      return { data };
    });
  }

  /**
   * Nedeljni diff akcija — paritet 1.0 loadWeeklyDiffStats (akcioniPlan.js:135-158):
   *   novo               = created_at > since
   *   zavrsenoOveNedelje = status='zavrsen' ∧ zatvoren_at > since
   *   kasni              = effective_status='kasni'
   *   aktivnih           = effective_status ∈ (otvoren,u_toku,kasni)
   * `since` = ISO timestamp prethodnog zaključanja; bez njega novo/zavrseno = 0.
   * Opcioni `projekatId` sužava na jedan projekat/RN.
   */
  async akcijeWeeklyDiff(email: string, q: WeeklyDiffQueryDto) {
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresiFilter(q.projekatId);
      return this.threeZeroRead(async (tx) => {
        const d = await this.weeklyDiffCounts30(
          tx,
          q.since ?? null,
          projekat ?? null,
        );
        return {
          data: {
            novo: d.novo,
            zavrsenoOveNedelje: d.zavrseno,
            kasni: d.kasni,
            aktivnih: d.aktivnih,
          },
        };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const d = await this.weeklyDiffCounts(
        tx,
        q.since ?? null,
        predmetZaSy15(q.projekatId) ?? null,
      );
      return {
        data: {
          novo: d.novo,
          zavrsenoOveNedelje: d.zavrseno,
          kasni: d.kasni,
          aktivnih: d.aktivnih,
        },
      };
    });
  }

  /**
   * Weekly-diff SA PRAVIM SIDROM (S-P0 paket 3) — red „Od prošlog sastanka":
   * paritet 1.0 getSastanakFullSaAkcijama (sastanciArhiva.js:53-57) →
   * loadPrethodniZakljucanPre(datum, id) (sastanci.js): poslednji sastanak sa
   * status='zakljucan' i datum < datum OVOG sastanka (isključen sam :id; sort
   * datum desc, zakljucan_at desc nulls last), pa loadWeeklyDiffStats(prev.
   * zakljucan_at). Nema prethodnog ILI prev.zakljucan_at prazan → data:null
   * (1.0 red se izostavlja). Diff je GLOBALAN (bez projekat filtera — kao 1.0).
   * Odgovor uz diff nosi i identitet prethodnog sastanka
   * (`prethodniSastanakId`/`prethodniNaslov`/`prethodniDatum`) za FE prečicu
   * „Prethodni zapisnik" (S1) — aditivno, postojeća polja se ne diraju.
   */
  async sastanakWeeklyDiff(email: string, id: string) {
    if (this.izvor.isThreeZero) return this.sastanakWeeklyDiff30(id);
    return this.withUserMapped(email, async (tx) => {
      const sastanak = await tx.sastanak.findUnique({
        where: { id },
        select: { datum: true },
      });
      if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      const prev = await tx.sastanak.findFirst({
        where: {
          status: "zakljucan",
          id: { not: id },
          datum: { lt: sastanak.datum },
        },
        orderBy: [
          { datum: "desc" },
          { zakljucanAt: { sort: "desc", nulls: "last" } },
        ],
        // Uz `zakljucanAt` (sidro diff-a) čitamo i id/naslov/datum prethodnog
        // sastanka — FE „Prethodni zapisnik" prečica (S1) štampa taj zapisnik.
        select: { id: true, naslov: true, datum: true, zakljucanAt: true },
      });
      if (!prev?.zakljucanAt) return { data: null };
      const since = prev.zakljucanAt.toISOString();
      const d = await this.weeklyDiffCounts(tx, since, null);
      return {
        data: {
          since,
          novo: d.novo,
          zavrsenoOveNedelje: d.zavrseno,
          kasni: d.kasni,
          aktivnih: d.aktivnih,
          // Backward-kompatibilna dopuna (S1): identitet prethodnog zaključanog
          // sastanka za „Prethodni zapisnik" dugme. `datum` je @db.Date → ymdOut.
          prethodniSastanakId: prev.id,
          prethodniNaslov: prev.naslov,
          prethodniDatum: this.ymdOut(prev.datum),
        },
      };
    });
  }

  /** Brojke diff-a nad v_akcioni_plan (paritet 1.0 loadWeeklyDiffStats, akcioniPlan.js:135). */
  private async weeklyDiffCounts(
    tx: Sy15Tx,
    since: string | null,
    projekatId: string | null,
  ): Promise<{
    novo: number;
    zavrseno: number;
    kasni: number;
    aktivnih: number;
  }> {
    const where = projekatId
      ? Prisma.sql`WHERE projekat_id = ${projekatId}::uuid`
      : Prisma.empty;
    const rows = await tx.$queryRaw<
      { novo: bigint; zavrseno: bigint; kasni: bigint; aktivnih: bigint }[]
    >(
      Prisma.sql`SELECT
          count(*) FILTER (WHERE ${since}::timestamptz IS NOT NULL AND created_at > ${since}::timestamptz) AS novo,
          count(*) FILTER (WHERE ${since}::timestamptz IS NOT NULL AND status = 'zavrsen' AND zatvoren_at > ${since}::timestamptz) AS zavrseno,
          count(*) FILTER (WHERE effective_status = 'kasni') AS kasni,
          count(*) FILTER (WHERE effective_status IN ('otvoren', 'u_toku', 'kasni')) AS aktivnih
        FROM v_akcioni_plan ${where}`,
    );
    const r = rows[0];
    return {
      novo: Number(r?.novo ?? 0),
      zavrseno: Number(r?.zavrseno ?? 0),
      kasni: Number(r?.kasni ?? 0),
      aktivnih: Number(r?.aktivnih ?? 0),
    };
  }

  /**
   * ⭐ lista prioritetnih predmeta (S-P0 paket 2b) — paritet 1.0
   * pullPredmetPlanPrioritetIds (predmetPlanPrioritet.js): DEFINER RPC
   * get_predmet_plan_prioritet_ids() → production.predmet_plan_prioritet
   * predmet_item_id redom slot 0..n-1 (max 10). Ista normalizacija kao 1.0
   * (Number, konačan, >0, cap 50); izlaz string[] (ID-jevi su bigtehn item id).
   */
  async predmetPrioritet(email: string) {
    // 🔴 `get_predmet_plan_prioritet_ids()` čita `production.predmet_plan_prioritet`
    // u sy15 i NIJE domen sastanaka (runbook §7c blokada 7) — stiže sa svojim
    // modulom. Zato ostaje iza brane i pod `3.0`, umesto da tiho vrati praznu
    // ⭐ listu (koja bi izgledala kao „nema prioritetnih predmeta").
    this.izvor.assertPorted("sastanci: ⭐ lista prioritetnih predmeta");
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ ids: unknown }[]>(
        Prisma.sql`SELECT get_predmet_plan_prioritet_ids() AS ids`,
      );
      const raw = rows[0]?.ids;
      const ids = (Array.isArray(raw) ? raw : [])
        .map(Number)
        .filter((x) => Number.isFinite(x) && x > 0)
        .slice(0, 50)
        .map(String);
      return { data: ids };
    });
  }

  /**
   * Lista projekata za RN picker (S5) — combobox „Projekat / RN" u AkcijaModal.
   * Čita sy15 tabelu `projects` (iste kolone kao AKCIJE_SELECT / seedFromTeme
   * codeByProj: id, project_code, project_name). Opcioni `q` = ILIKE po šifri ILI
   * nazivu (`%q%`); ORDER BY šifra; LIMIT 20 (dovoljno za autocomplete). Kroz
   * withUserMapped (RLS read pod `authenticated`, kao ostali čitajući endpointi).
   * Izlaz: camelCase ugovor `{ id, code, naziv }` (FE RN picker).
   */
  async listProjekti(email: string, q?: string) {
    const term = (q ?? "").trim();
    if (this.izvor.isThreeZero) {
      // 3.0 `projects` nema `project_code`/`project_name` pod tim imenima —
      // parnjaci su `project_number` i `project_name` (izmereno: 7.472/7.631
      // popunjenih naziva). Ugovor prema FE-u (`{id, code, naziv}`) je isti, ali
      // `id` je od sada Int; uz njega ide i `uuid` da stari picker i dalje ume
      // da poklopi izabran predmet sa zatečenom vrednošću u formi.
      return this.threeZeroRead(async (tx) => {
        const where = term
          ? Prisma.sql`WHERE project_number ILIKE ${`%${term}%`} OR project_name ILIKE ${`%${term}%`}`
          : Prisma.empty;
        const rows = await tx.$queryRaw<
          { id: number; code: string | null; naziv: string | null }[]
        >(
          Prisma.sql`SELECT id, project_number AS "code", project_name AS "naziv"
            FROM projects ${where}
            ORDER BY project_number ASC
            LIMIT 20`,
        );
        return {
          data: rows.map((r) => ({
            ...r,
            uuid: this.predmetOut({ projectId: r.id }).projekatUuid,
          })),
        };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const where = term
        ? Prisma.sql`WHERE project_code ILIKE ${`%${term}%`} OR project_name ILIKE ${`%${term}%`}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, project_code AS "code", project_name AS "naziv"
          FROM projects ${where}
          ORDER BY project_code ASC
          LIMIT 20`,
      );
      return { data };
    });
  }

  // ---------- PM teme (view v_pm_teme_pregled — SELECT nije javan, row-scope u RLS) ----------

  /**
   * PM teme — paritet 1.0 loadPmTeme (pmTeme.js:134-160): sort admin_rang ASC NULLS LAST,
   * hitno DESC, za_razmatranje DESC, prioritet ASC, predlozio_at DESC; filteri status/
   * excludeStatuses/sastanakId/projekatId/predlozioEmail/hitnoOnly/razmatranjeOnly.
   * Vidljivost redova (predlagač∨mgmt∨učesnik∨draft+edit) presuđuje RLS (withUserRls).
   *
   * 🔴 POD `3.0` SCOPE SE NE NASLEĐUJE NI OD ČEGA. View `v_pm_teme_pregled` je u
   * sy15 `security_invoker = true`, tj. RLS pozivaoca se primenjivao I KROZ
   * VIEW; u 3.0 RLS-a nema. Zato se `scopeTemeSql` (prepis politike `pmt_select`,
   * blokada 4) MORA spojiti u `WHERE` — bez njega bi lista tema pokazala i tuđe,
   * pa i tuđe draft predloge.
   */
  async listTeme(email: string, q: TemeQueryDto) {
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresiFilter(q.projekatId);
      const scope = await this.authz.scopeTemeSql(email, "v");
      return this.threeZeroRead(async (tx) => {
        const conds: Prisma.Sql[] = [scope];
        if (q.status) conds.push(Prisma.sql`v.status = ${q.status}`);
        const exclude = (q.excludeStatuses ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (exclude.length)
          conds.push(Prisma.sql`v.status <> ALL(${exclude}::text[])`);
        if (projekat !== undefined)
          conds.push(Prisma.sql`v.projekat_id = ${projekat}`);
        if (q.sastanakId)
          conds.push(Prisma.sql`v.sastanak_id = ${q.sastanakId}::uuid`);
        if (q.oblast) conds.push(Prisma.sql`v.oblast = ${q.oblast}`);
        if (q.predlozioEmail)
          conds.push(Prisma.sql`v.predlozio_email = ${q.predlozioEmail}`);
        if (q.hitnoOnly === "true") conds.push(Prisma.sql`v.hitno = true`);
        if (q.razmatranjeOnly === "true")
          conds.push(Prisma.sql`v.za_razmatranje = true`);
        const data = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT v.* FROM v_pm_teme_pregled v
            WHERE ${Prisma.join(conds, " AND ")}
            ORDER BY v.admin_rang ASC NULLS LAST, v.hitno DESC, v.za_razmatranje DESC,
                     v.prioritet ASC, v.predlozio_at DESC`,
        );
        return { data: this.akcijaViewOut(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      const exclude = (q.excludeStatuses ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (exclude.length)
        conds.push(Prisma.sql`status <> ALL(${exclude}::text[])`);
      if (q.projekatId)
        conds.push(
          Prisma.sql`projekat_id = ${predmetZaSy15(q.projekatId)}::uuid`,
        );
      if (q.sastanakId)
        conds.push(Prisma.sql`sastanak_id = ${q.sastanakId}::uuid`);
      if (q.oblast) conds.push(Prisma.sql`oblast = ${q.oblast}`);
      if (q.predlozioEmail)
        conds.push(Prisma.sql`predlozio_email = ${q.predlozioEmail}`);
      if (q.hitnoOnly === "true") conds.push(Prisma.sql`hitno = true`);
      if (q.razmatranjeOnly === "true")
        conds.push(Prisma.sql`za_razmatranje = true`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_pm_teme_pregled ${where}
          ORDER BY admin_rang ASC NULLS LAST, hitno DESC, za_razmatranje DESC, prioritet ASC, predlozio_at DESC`,
      );
      return { data };
    });
  }

  // ---------- Šabloni ----------

  /**
   * Šabloni + dve izvedene kolone (S5):
   *  - `sledeciTermin` — čist compute kroz postojeći `nextOccurrence` (isti port koji
   *    koristi `instantiate`, pa je „Sledeći termin" tačno ono što će dugme „Zakaži po
   *    šablonu" napraviti). `null` za neaktivan šablon i za `cadence='none'` (nema
   *    ponavljanja → nema sledećeg termina). Bez DB izmene.
   *  - `poslednjiSastanak` — poslednji ODRŽAN termin serije.
   *
   * TODO(sy15 template_id): veza instanca→šablon u 1.0 šemi NE POSTOJI, pa se poslednji
   * termin razrešava HEURISTIKOM `lower(btrim(naslov)) = lower(btrim(tpl.naziv))`
   * (instantiate upisuje `naslov := tpl.naziv`). Heuristika promašuje kad korisnik
   * ručno preimenuje instancu (S4 „Uredi") ili kad dva šablona imaju isti naziv.
   * Kad se primeni `backend/docs/sql/sy15/sastanci-lifecycle-2026-07-18/40_sastanci_template_id.sql`
   * (aditivna kolona + backfill) i re-introspektuje `prisma/sy15.prisma`, zameniti ceo
   * blok pravim JOIN-om po `template_id` — upit ostaje jedan (DISTINCT ON template_id).
   */
  async listTemplates(email: string) {
    if (this.izvor.isThreeZero) return this.listTemplates30();
    return this.withUserMapped(email, async (tx) => {
      const templates = await tx.sastanciTemplate.findMany({
        orderBy: [{ naziv: "asc" }],
      });
      const keys = [
        ...new Set(templates.map((t) => t.naziv.trim().toLowerCase())),
      ].filter(Boolean);

      // Jedan batch upit za SVE šablone (nikad N+1). „Poslednji" = najskoriji termin
      // koji je već (bar nominalno) održan: datum <= danas i status <> 'otkazan'
      // (otkazan se nije desio; budući planiran je „sledeći", ne „poslednji").
      const last = keys.length
        ? await tx.$queryRaw<
            { key: string; id: string; datum: Date; status: string }[]
          >(
            Prisma.sql`SELECT DISTINCT ON (lower(btrim(naslov)))
                lower(btrim(naslov)) AS key, id, datum, status
              FROM sastanci
              WHERE lower(btrim(naslov)) = ANY(${keys}::text[])
                AND status <> 'otkazan'
                AND datum <= CURRENT_DATE
              ORDER BY lower(btrim(naslov)), datum DESC, created_at DESC`,
          )
        : [];
      const byKey = new Map(last.map((r) => [r.key, r]));

      const data = templates.map((t) => {
        const hit = byKey.get(t.naziv.trim().toLowerCase());
        return {
          ...t,
          sledeciTermin:
            t.isActive && t.cadence !== "none"
              ? nextOccurrence({
                  cadence: t.cadence,
                  cadenceDow: t.cadenceDow,
                  cadenceDom: t.cadenceDom,
                  createdAt: t.createdAt,
                })
              : null,
          poslednjiSastanak: hit ? this.ymdOut(hit.datum) : null,
          poslednjiSastanakId: hit?.id ?? null,
        };
      });
      return { data };
    });
  }

  /** @db.Date kolona (UTC ponoć) → 'YYYY-MM-DD' bez TZ drift-a. */
  private ymdOut(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  async findTemplate(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const tpl = await tx.sastanciTemplate.findUnique({ where: { id } });
        if (!tpl) throw new NotFoundException(`Šablon ${id} ne postoji`);
        const ucesnici = await tx.sastanciTemplateUcesnik.findMany({
          where: { templateId: id },
        });
        return { data: { ...tpl, ucesnici } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const tpl = await tx.sastanciTemplate.findUnique({ where: { id } });
      if (!tpl) throw new NotFoundException(`Šablon ${id} ne postoji`);
      const ucesnici = await tx.sastanciTemplateUcesnik.findMany({
        where: { templateId: id },
      });
      return { data: { ...tpl, ucesnici } };
    });
  }

  // ---------- Arhiva ----------

  async listArhive(email: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const data = await tx.sastanakArhiva.findMany({
          orderBy: [{ arhiviranoAt: "desc" }],
        });
        return { data: data.map((a) => this.arhivaOut(a)) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakArhiva.findMany({
        orderBy: [{ arhiviranoAt: "desc" }],
      });
      return { data: data.map((a) => this.arhivaOut(a)) };
    });
  }

  async findArhiva(email: string, sastanakId: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroRead(async (tx) => {
        const data = await tx.sastanakArhiva.findUnique({
          where: { sastanakId },
        });
        if (!data)
          throw new NotFoundException(`Arhiva za ${sastanakId} ne postoji`);
        return { data: this.arhivaOut(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakArhiva.findUnique({
        where: { sastanakId },
      });
      if (!data)
        throw new NotFoundException(`Arhiva za ${sastanakId} ne postoji`);
      return { data: this.arhivaOut(data) };
    });
  }

  // ---------- Notifikacije (OUTBOX read — row-scope „svoje ∨ mgmt") ----------

  /**
   * Pod `sy15` scope presuđuje RLS politika `snl_select`; pod `3.0` isti uslov
   * sprovodi `SastanciAuthzService.scopeNotifLogWhere` (RLS-a nema — ODLUKE.md).
   *
   * 🔴 Scope se NE SME izostaviti: red ovog outbox-a nosi `subject`, `body_html`
   * i `payload` mejla. Nesuženo čitanje bi svakome dalo tuđu poštu.
   */
  async notifications(email: string, q: NotificationsQueryDto) {
    const filter = q.sastanakId ? { relatedSastanakId: q.sastanakId } : {};
    if (this.izvor.isThreeZero) {
      const scope = await this.authz.scopeNotifLogWhere(email);
      return this.threeZeroTx(async (tx) => ({
        data: await tx.sastanciNotificationLog.findMany({
          where: { AND: [filter, scope] },
          orderBy: [{ createdAt: "desc" }],
          take: 200,
        }),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanciNotificationLog.findMany({
        where: filter,
        orderBy: [{ createdAt: "desc" }],
        take: 200,
      });
      return { data };
    });
  }

  // ---------- RPC read-ovi (GUC most) ----------

  /** Podešavanja notifikacija pozivaoca (sastanci_get_or_create_my_prefs).
   *  Fn vraća snake_case red tabele sastanci_notification_prefs — aliasuje se u
   *  camelCase da GET /prefs bude identičan FE tipu `Prefs` i PATCH /prefs
   *  (camelCase Prisma model). */
  async myPrefs(email: string) {
    if (this.izvor.isThreeZero) {
      const p = await this.samousluga.getOrCreateMyPrefs(email);
      return {
        data: {
          email: p.email,
          onNewAkcija: p.onNewAkcija,
          onChangeAkcija: p.onChangeAkcija,
          onMeetingInvite: p.onMeetingInvite,
          onMeetingLocked: p.onMeetingLocked,
          onActionReminder: p.onActionReminder,
          onMeetingReminder: p.onMeetingReminder,
        },
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT email,
            on_new_akcija       AS "onNewAkcija",
            on_change_akcija    AS "onChangeAkcija",
            on_meeting_invite   AS "onMeetingInvite",
            on_meeting_locked   AS "onMeetingLocked",
            on_action_reminder  AS "onActionReminder",
            on_meeting_reminder AS "onMeetingReminder"
          FROM sastanci_get_or_create_my_prefs()`,
      );
      return { data: rows[0] ?? null };
    });
  }

  /**
   * Neradni praznici za 3.0 put — 🔴 JEDINA PREOSTALA CROSS-BAZA ZAVISNOST
   * sastanaka.
   *
   * `sast_adjust_for_holiday` (pomeranje sedmičnog kolegijuma sa praznika) čita
   * `kadr_holidays`. Ta tabela je KADROVSKA i stiže tek u koraku 4 seobe, pa se
   * pod `3.0` čita READ-ONLY sa sy15 — isti presedan kao fajlovi u sy15 storage-u
   * (runbook §7, rep 1): referentni podatak koji niko iz ovog domena ne piše, pa
   * dve baze ne mogu da se raziđu. Nestaje sa korakom 4.
   *
   * Fail-soft: bez `SY15_DATABASE_URL` vraća prazan skup i UPOZORAVA. Posledica
   * je poznata i bezopasna — termin se ne pomera sa praznika (ponašanje kao baza
   * bez ijednog praznika), umesto da ceo ekran padne.
   */
  private async prazniciZaTriNula(): Promise<ReadonlySet<string>> {
    const od = new Date();
    od.setUTCHours(0, 0, 0, 0);
    try {
      const rows = await this.sy15.db.kadrHoliday.findMany({
        where: {
          holidayDate: {
            gte: od,
            lte: new Date(od.getTime() + 90 * 86_400_000),
          },
          isWorkday: false,
        },
        select: { holidayDate: true },
      });
      return new Set(rows.map((r) => this.ymd(r.holidayDate)));
    } catch {
      this.logger.warn(
        "Praznici (kadr_holidays) nisu dostupni sa sy15 — sedmični termin se NEĆE pomeriti sa praznika. " +
          "Nestaje sa korakom 4 seobe (kadrovska).",
      );
      return new Set<string>();
    }
  }

  /** Status sedmičnog (sast_weekly_status → can_move iz movers tabele). */
  async weeklyStatus(email: string) {
    if (this.izvor.isThreeZero) {
      const praznici = await this.prazniciZaTriNula();
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.weeklyStatus(tx, email, praznici),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ sast_weekly_status: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_status() AS sast_weekly_status`,
      );
      return { data: rows[0]?.sast_weekly_status ?? null };
    });
  }

  /** KPI brojke za Pregled (sast_dashboard_stats). */
  async dashboardStats(email: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.dashboardStats(tx, email),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ sast_dashboard_stats: unknown }[]>(
        Prisma.sql`SELECT sast_dashboard_stats() AS sast_dashboard_stats`,
      );
      return { data: rows[0]?.sast_dashboard_stats ?? null };
    });
  }

  /** Direktorijum korisnika za autocomplete učesnika (get_sastanci_user_directory).
   *  DB fn traži has_edit_role → 42501 (→403) za role bez edit-a; guard je read. */
  async userDirectory(email: string) {
    if (this.izvor.isThreeZero) {
      return { data: await this.fn.userDirectory(email) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM get_sastanci_user_directory()`,
      );
      return { data };
    });
  }

  /** Model za AI rezime (sastanci_ai_settings singleton; PUT je admin/R2). */
  async aiModel(email: string) {
    if (this.izvor.isThreeZero) {
      const row = await this.prisma.sastanciAiSettings.findUnique({
        where: { id: 1 },
        select: {
          id: true,
          model: true,
          updatedAt: true,
          updatedByUserId: true,
        },
      });
      // Ugovor odgovora je snake_case (FE ga tako čita) i `updated_by` je tekst —
      // u sy15 je bio `auth.users.id` (uuid), u 3.0 je `users.id` (Int).
      return {
        data: row
          ? {
              id: row.id,
              model: row.model,
              updated_at: row.updatedAt,
              updated_by: row.updatedByUserId == null ? null : String(row.updatedByUserId),
            }
          : null,
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: number;
          model: string;
          updated_at: Date;
          updated_by: string | null;
        }[]
      >(
        Prisma.sql`SELECT id, model, updated_at, updated_by FROM sastanci_ai_settings WHERE id = 1`,
      );
      return { data: rows[0] ?? null };
    });
  }

  // ==========================================================================
  // 3.0 ČITANJA koja su duža od jedne grane (blokada 2)
  // ==========================================================================
  //
  // Ovde su SAMO tela koja se nisu dala uklopiti u `if (isThreeZero)` granu bez
  // gubitka čitljivosti. Ostala su inline uz sy15 parnjaka, da se razlika vidi
  // odmah. Zajedničko svima: nema RLS-a (ODLUKE.md), pa scope sprovodi
  // `SastanciAuthzService`, a `projekat_id` je `Int` (blokada 5).

  /** 3.0 parnjak `list` — isti filteri i sort, `projekat_id` je Int. */
  private async list30(query: ListSastanciQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const projekat = await this.predmet.razresiFilter(query.projekatId);
    const where: PrismaTriNula.SastanakWhereInput = {
      ...(query.tip ? { tip: query.tip } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(projekat !== undefined ? { projectId: projekat } : {}),
      ...(query.from || query.to
        ? {
            datum: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { naslov: { contains: query.q, mode: "insensitive" } },
              { mesto: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    // Praznici (za najavu sedmičnog) se čitaju IZVAN transakcije — dolaze sa
    // sy15 i ne smeju da drže 3.0 konekciju.
    const praznici = [...(await this.prazniciZaTriNula())];
    return this.threeZeroRead(async (tx) => {
      const [data, total] = await Promise.all([
        tx.sastanak.findMany({
          where,
          orderBy: [{ datum: "desc" }, { vreme: "desc" }],
          skip,
          take,
        }),
        tx.sastanak.count({ where }),
      ]);
      const enriched = await this.dodajSledeci30(tx, data, praznici);
      return {
        data: this.predmetOutMany(enriched),
        meta: pageMeta(page, pageSize, total),
      };
    });
  }

  /**
   * 3.0 parnjak `dodajSledeci`. Ista dva pravila („naslednik po tipu" za
   * ne-periodične, „naslednik po lancu" za periodične), ali BEZ probe kolona:
   * `interval_days` i `prethodni_sastanak_id` su u 3.0 REDOVNE kolone modela,
   * pa `periodicniKolone`/`intervalDaysMapa` (i njihov raw put) ovde ne postoje.
   */
  private async dodajSledeci30<
    T extends {
      id: string;
      tip: string;
      datum: Date;
      vreme: Date | null;
      status: string;
    },
  >(
    tx: SastanciTx,
    rows: T[],
    praznici: string[],
  ): Promise<(T & { sledeci?: SledeciTermin | null })[]> {
    const zatvoreni = rows.filter((r) =>
      (ZAVRSNI_STATUSI as readonly string[]).includes(r.status),
    );
    if (!zatvoreni.length) return rows;
    const { danas, sat } = this.belgradeDanasSat();

    const obicni = zatvoreni.filter((r) => r.tip !== "periodicni");
    const tipovi = [...new Set(obicni.map((r) => r.tip))];
    let nasledniciRedovi: {
      id: string;
      tip: string;
      datum: Date;
      vreme: Date | null;
    }[] = [];
    if (tipovi.length) {
      const minDatum = obicni.reduce(
        (m, r) => (this.ymd(r.datum) < m ? this.ymd(r.datum) : m),
        this.ymd(obicni[0].datum),
      );
      nasledniciRedovi = await tx.sastanak.findMany({
        where: {
          tip: { in: tipovi },
          status: { not: "otkazan" },
          datum: { gt: this.toDbDate(minDatum)! },
        },
        select: { id: true, tip: true, datum: true, vreme: true },
        orderBy: [{ datum: "asc" }, { vreme: "asc" }],
        take: 500,
      });
    }
    const bezNaslednika = (r: T) =>
      !nasledniciRedovi.some(
        (n) => n.tip === r.tip && this.ymd(n.datum) > this.ymd(r.datum),
      );
    const trebaSedmicnaNajava = obicni.some(
      (r) => r.tip === "sedmicni" && bezNaslednika(r),
    );

    // ── Periodični: naslednik po lancu (MAJOR-1) ──
    const periodicni = zatvoreni.filter((r) => r.tip === "periodicni");
    const lanacNaslednik = new Map<
      string,
      { id: string; datum: string; vreme: string | null; status: string }
    >();
    let bazaMapa = new Map<string, { baza: string; interval: number }>();
    if (periodicni.length) {
      const direktni = await tx.sastanak.findMany({
        where: { prethodniSastanakId: { in: periodicni.map((r) => r.id) } },
        select: {
          prethodniSastanakId: true,
          id: true,
          datum: true,
          vreme: true,
          status: true,
        },
      });
      for (const n of direktni) {
        if (!n.prethodniSastanakId) continue;
        lanacNaslednik.set(n.prethodniSastanakId, {
          id: n.id,
          datum: this.ymd(n.datum),
          vreme: this.hhmm(n.vreme),
          status: n.status,
        });
      }
      const repIds = periodicni
        .map((r) => {
          const n = lanacNaslednik.get(r.id);
          if (!n) return r.id;
          return n.status === "otkazan" ? n.id : null;
        })
        .filter((id): id is string => id !== null);
      if (repIds.length) {
        const bazaRows = await tx.$queryRaw<
          { id: string; baza: string; interval_days: number | null }[]
        >(bazaLancaUpit([...new Set(repIds)]));
        bazaMapa = new Map(
          bazaRows
            .filter((b) => b.interval_days != null)
            .map((b) => [
              b.id,
              { baza: b.baza, interval: Number(b.interval_days) },
            ]),
        );
      }
    }

    let sedmicnaNajava: SledeciSedmicni | null = null;
    if (trebaSedmicnaNajava) {
      sedmicnaNajava = await this.izracunajSledeciSedmicni30(
        tx,
        danas,
        sat,
        praznici,
      );
    }

    return rows.map((r) => {
      if (!(ZAVRSNI_STATUSI as readonly string[]).includes(r.status)) return r;
      const rDatum = this.ymd(r.datum);

      if (r.tip === "periodicni") {
        const n = lanacNaslednik.get(r.id);
        if (n && n.status !== "otkazan") {
          return {
            ...r,
            sledeci: {
              datum: n.datum,
              vreme: n.vreme,
              sastanakId: n.id,
              najava: false,
            },
          };
        }
        const rep = n
          ? { id: n.id, datum: n.datum, vreme: n.vreme }
          : { id: r.id, datum: rDatum, vreme: this.hhmm(r.vreme) };
        const info = bazaMapa.get(rep.id);
        if (!info) return { ...r, sledeci: null };
        return {
          ...r,
          sledeci: {
            datum: sledeciPeriodicniTermin({
              datum: info.baza,
              intervalDays: info.interval,
              danas,
              praznici,
              posle: rep.datum,
            }),
            vreme: rep.vreme,
            sastanakId: null,
            najava: true,
          },
        };
      }

      const naslednik = nasledniciRedovi.find(
        (n) => n.tip === r.tip && this.ymd(n.datum) > rDatum,
      );
      if (naslednik) {
        return {
          ...r,
          sledeci: {
            datum: this.ymd(naslednik.datum),
            vreme: this.hhmm(naslednik.vreme),
            sastanakId: naslednik.id,
            najava: false,
          },
        };
      }
      if (r.tip === "sedmicni" && sedmicnaNajava) {
        return {
          ...r,
          sledeci: {
            datum: sedmicnaNajava.datum,
            vreme: sedmicnaNajava.vreme,
            sastanakId: sedmicnaNajava.sastanakId,
            najava: sedmicnaNajava.sastanakId === null,
          },
        };
      }
      return { ...r, sledeci: null };
    });
  }

  /** 3.0 parnjak `izracunajSledeciSedmicni` (praznike prosleđuje pozivalac). */
  private async izracunajSledeciSedmicni30(
    tx: SastanciTx,
    danas: string,
    sat: number,
    praznici: string[],
  ): Promise<SledeciSedmicni | null> {
    const sedmicniRedovi = await tx.sastanak.findMany({
      where: { tip: "sedmicni", datum: { gte: new Date(danas) } },
      select: { id: true, datum: true, vreme: true, status: true },
      orderBy: [{ datum: "asc" }],
      take: 60,
    });
    return sledeciSedmicniTermin({
      danas,
      sat,
      sedmicni: sedmicniRedovi.map((s) => ({
        id: s.id,
        datum: this.ymd(s.datum),
        vreme: this.hhmm(s.vreme),
        status: s.status,
      })),
      praznici,
    });
  }

  /** 3.0 parnjak `findFull` — `intervalDays` je redovna kolona, bez probe. */
  private async findFull30(id: string) {
    return this.threeZeroRead(async (tx) => {
      const sastanak = await tx.sastanak.findUnique({ where: { id } });
      if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      const [ucesnici, aktivnosti, slike, odluke, akcije, arhiva] =
        await Promise.all([
          tx.sastanakUcesnik.findMany({
            where: { sastanakId: id },
            select: UCESNIK_SELECT,
            orderBy: [{ label: "asc" }, { email: "asc" }],
          }),
          tx.presekAktivnost.findMany({
            where: { sastanakId: id },
            orderBy: [{ redosled: "asc" }, { rb: "asc" }],
          }),
          tx.presekSlika.findMany({
            where: { sastanakId: id },
            orderBy: [{ redosled: "asc" }],
          }),
          tx.sastanakOdluka.findMany({
            where: { sastanakId: id },
            orderBy: [
              { rb: { sort: "asc", nulls: "last" } },
              { createdAt: "asc" },
            ],
          }),
          tx.$queryRaw<unknown[]>(
            Prisma.sql`${AKCIJE_SELECT_30} WHERE a.sastanak_id = ${id}::uuid ${AKCIJE_ORDER}`,
          ),
          tx.sastanakArhiva.findUnique({ where: { sastanakId: id } }),
        ]);
      const akcijeArr = this.akcijaViewOut(akcije) as {
        effective_status?: string;
      }[];
      return {
        data: {
          ...this.predmetOut(sastanak),
          // U sy15 je `intervalDays` bio VAN Prisma mape (kolona koje u bazi
          // možda nema), pa se čitao zasebno i samo za periodične. U 3.0 je
          // redovno polje modela — ali ugovor prema FE-u se zadržava: polje se
          // šalje SAMO za periodični sastanak, inače ga nema.
          ...(sastanak.tip === "periodicni"
            ? { intervalDays: sastanak.intervalDays ?? null }
            : {}),
          ucesnici,
          aktivnosti,
          slike: slike.map((s) => this.slikaOut(s)),
          odluke,
          akcije: akcijeArr,
          arhiva: arhiva ? this.arhivaOut(arhiva) : arhiva,
          overview: {
            ucesnici: ucesnici.length,
            prisutni: ucesnici.filter((u) => u.prisutan).length,
            pripremljeni: ucesnici.filter((u) => u.pripremljen).length,
            aktivnosti: aktivnosti.length,
            odluke: odluke.length,
            akcije: akcijeArr.length,
            akcijeOtvorene: akcijeArr.filter((a) =>
              ["otvoren", "u_toku", "kasni"].includes(a.effective_status ?? ""),
            ).length,
          },
        },
      };
    });
  }

  /** 3.0 parnjak `weeklyDiffCounts` — `projekat_id` je Int, bez `::uuid` cast-a. */
  private async weeklyDiffCounts30(
    tx: SastanciTx,
    since: string | null,
    projekatId: number | null,
  ): Promise<{
    novo: number;
    zavrseno: number;
    kasni: number;
    aktivnih: number;
  }> {
    const where =
      projekatId === null
        ? Prisma.empty
        : Prisma.sql`WHERE projekat_id = ${projekatId}`;
    const rows = await tx.$queryRaw<
      { novo: bigint; zavrseno: bigint; kasni: bigint; aktivnih: bigint }[]
    >(
      Prisma.sql`SELECT
          count(*) FILTER (WHERE ${since}::timestamptz IS NOT NULL AND created_at > ${since}::timestamptz) AS novo,
          count(*) FILTER (WHERE ${since}::timestamptz IS NOT NULL AND status = 'zavrsen' AND zatvoren_at > ${since}::timestamptz) AS zavrseno,
          count(*) FILTER (WHERE effective_status = 'kasni') AS kasni,
          count(*) FILTER (WHERE effective_status IN ('otvoren', 'u_toku', 'kasni')) AS aktivnih
        FROM v_akcioni_plan ${where}`,
    );
    const r = rows[0];
    return {
      novo: Number(r?.novo ?? 0),
      zavrseno: Number(r?.zavrseno ?? 0),
      kasni: Number(r?.kasni ?? 0),
      aktivnih: Number(r?.aktivnih ?? 0),
    };
  }

  /** 3.0 parnjak `sastanakWeeklyDiff` (sidro = prethodni zaključan sastanak). */
  private async sastanakWeeklyDiff30(id: string) {
    return this.threeZeroRead(async (tx) => {
      const sastanak = await tx.sastanak.findUnique({
        where: { id },
        select: { datum: true },
      });
      if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      const prev = await tx.sastanak.findFirst({
        where: {
          status: "zakljucan",
          id: { not: id },
          datum: { lt: sastanak.datum },
        },
        orderBy: [
          { datum: "desc" },
          { zakljucanAt: { sort: "desc", nulls: "last" } },
        ],
        select: { id: true, naslov: true, datum: true, zakljucanAt: true },
      });
      if (!prev?.zakljucanAt) return { data: null };
      const since = prev.zakljucanAt.toISOString();
      const d = await this.weeklyDiffCounts30(tx, since, null);
      return {
        data: {
          since,
          novo: d.novo,
          zavrsenoOveNedelje: d.zavrseno,
          kasni: d.kasni,
          aktivnih: d.aktivnih,
          prethodniSastanakId: prev.id,
          prethodniNaslov: prev.naslov,
          prethodniDatum: this.ymdOut(prev.datum),
        },
      };
    });
  }

  /** 3.0 parnjak `listTemplates` (ista heuristika „poslednji termin po nazivu"). */
  private async listTemplates30() {
    return this.threeZeroRead(async (tx) => {
      const templates = await tx.sastanciTemplate.findMany({
        orderBy: [{ naziv: "asc" }],
      });
      const keys = [
        ...new Set(templates.map((t) => t.naziv.trim().toLowerCase())),
      ].filter(Boolean);
      const last = keys.length
        ? await tx.$queryRaw<
            { key: string; id: string; datum: Date; status: string }[]
          >(
            Prisma.sql`SELECT DISTINCT ON (lower(btrim(naslov)))
                lower(btrim(naslov)) AS key, id, datum, status
              FROM sastanci
              WHERE lower(btrim(naslov)) = ANY(${keys}::text[])
                AND status <> 'otkazan'
                AND datum <= CURRENT_DATE
              ORDER BY lower(btrim(naslov)), datum DESC, created_at DESC`,
          )
        : [];
      const byKey = new Map(last.map((r) => [r.key, r]));
      const data = templates.map((t) => {
        const hit = byKey.get(t.naziv.trim().toLowerCase());
        return {
          ...t,
          sledeciTermin:
            t.isActive && t.cadence !== "none"
              ? nextOccurrence({
                  cadence: t.cadence,
                  cadenceDow: t.cadenceDow,
                  cadenceDom: t.cadenceDom,
                  createdAt: t.createdAt,
                })
              : null,
          poslednjiSastanak: hit ? this.ymdOut(hit.datum) : null,
          poslednjiSastanakId: hit?.id ?? null,
        };
      });
      return { data };
    });
  }

  // ---------- interno ----------

  /** BigInt kolone ne prežive res.json (TypeError) — konverzija u Number (review nalaz 1). */
  private slikaOut<T extends { sizeBytes: bigint | null }>(s: T) {
    return {
      ...s,
      sizeBytes: s.sizeBytes == null ? null : Number(s.sizeBytes),
    };
  }

  private arhivaOut<T extends { zapisnikSizeBytes: bigint | null }>(a: T) {
    return {
      ...a,
      zapisnikSizeBytes:
        a.zapisnikSizeBytes == null ? null : Number(a.zapisnikSizeBytes),
    };
  }

  /**
   * Sav pristup ide kroz `withUserRls` (GUC + SET LOCAL ROLE authenticated) —
   * RLS paritet sa 1.0 PostgREST-om (konekciona rola je BYPASSRLS, review 12.07).
   *
   * 🔴 JEDINI ULAZ U sy15 IZ OVOG SERVISA (uz `runIdem`) — zato je brana
   * `SASTANCI_IZVOR` ovde, a ne razasuta po 100+ poziva. Pod `3.0` ovaj put
   * više ne sme da se koristi: tiho čitanje/pisanje sy15 razišlo bi dve baze.
   */
  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    this.izvor.assertPorted("sastanci: čitanje/upis kroz sy15");
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Postgres SQLSTATE iz Prisma raw greške: `meta.code` (npr. P0002 koji digne
   *  DEFINER RPC) ima prednost nad spoljnim `e.code` (P2010 „raw query failed"). */
  private sy15Code(e: unknown): string | undefined {
    const meta = (e as { meta?: { code?: string } }).meta;
    return meta?.code ?? (e as { code?: string }).code;
  }

  /**
   * SQLSTATE iz DB fn/RLS → HTTP semantika (paritet Reversi §5):
   * 42501→403, P0001/P0002→422, 23514(check, npr. nepoznat model)→422, 23505/P2002→409.
   * Prisma P2002 (unique violation na TYPED `.create()` — top-level `e.code`, BEZ
   * `meta.code`; npr. dupli učesnik na PK (sastanak_id,email)) ide istom granom kao
   * raw-put 23505 → 409 (bez toga typed create bi pao na sirov 500).
   * Prisma P2025 (RLS-filtrovan UPDATE/DELETE = 0 redova) prepuštamo pozivaocu koji
   * je već razrešio postojanje reda (assertAffected) — ako stigne dovde → 403.
   */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = this.sy15Code(e);
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505" || code === "P2002")
      throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }

  // ============================================================================
  // R2 — MUTACIJE (REST write kroz withUserRls/runIdempotentRls; RLS presuđuje red)
  // ============================================================================
  // Sav write ide pod `SET LOCAL ROLE authenticated` (withUserRls/runIdempotentRls) →
  // sy15 RLS politike (`has_edit_role ∧ (učesnik ∨ mgmt ∨ organizator-trio)`) rade
  // IDENTIČNO kao 1.0 PostgREST — scope se NE duplira u kodu (doktrina A.2a/§C).
  // RLS-filtrovan UPDATE/DELETE (0 redova) → `assertAffected` razdvaja 404 (ne postoji)
  // od 403 (postoji ali nema prava). INSERT u sastanci_notification_log je ZABRANJEN
  // (presuda B10) — enqueue ide isključivo kroz postojeće DEFINER RPC-ove.

  /** Idempotentna akcija sa nus-efektima (create/lock/bulk-replace/instantiate).
   *  Drugi (i poslednji) ulaz u sy15 — v. branu u `withUserMapped`. */
  private async runIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    this.izvor.assertPorted(`sastanci: idempotentna mutacija "${action}" kroz sy15`);
    try {
      const out = await this.sy15.runIdempotentRls(
        email,
        clientEventId,
        action,
        fn,
      );
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * 3.0 parnjak `runIdem` — registar je `api_idempotency` u 3.0 bazi
   * (`IdempotencyService`), pa `create` / `bulk-ucesnici` / `prenos` /
   * `instantiate` više ne padaju sa 503.
   *
   * UGOVOR PREMA KLIJENTU JE ISTI kao pod `sy15`: isti `clientEventId` iz zahteva,
   * isti `action` prostor imena, isti `{ data, meta: { idempotent } }` odgovor,
   * isti 409 na ključ upotrebljen za drugu akciju. Klijent ne vidi razliku.
   *
   * Razlika je unutra i posledica je seobe: nema `SET LOCAL ROLE authenticated`
   * (3.0 nema RLS), pa scope reda sprovodi `SastanciAuthzService`, a logički
   * trigeri (`sast_trg_ucesnik_invite`, `sast_check_not_locked`…) se pozivaju
   * eksplicitno — u sy15 ih je okidala baza.
   */
  private async threeZeroIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: SastanciTx) => Promise<T>,
  ) {
    try {
      const out = await this.idem.run(email, clientEventId, action, fn);
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Konverzija 'YYYY-MM-DD' → Date za @db.Date kolonu (Prisma uzima datum-deo). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v}T00:00:00Z`);
  }

  /** Konverzija 'HH:MM[:SS]' → Date za @db.Time kolonu (Prisma uzima vreme-deo). */
  private toDbTime(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const t = v.length === 5 ? `${v}:00` : v;
    return new Date(`1970-01-01T${t}Z`);
  }

  /** @db.Date → 'YYYY-MM-DD' (kolona je UTC ponoć, pa nema TZ pomaka). */
  private ymd(d: Date | string): string {
    return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  }

  /** @db.Time → 'HH:MM' (obrnuto od `toDbTime`). */
  private hhmm(v: Date | string | null): string | null {
    if (!v) return null;
    const s = v instanceof Date ? v.toISOString() : String(v);
    return s.includes("T") ? s.slice(11, 16) : s.slice(0, 5);
  }

  /** Posle updateMany/deleteMany sa 0 pogodaka: 404 ako red ne postoji (po SELECT-u),
   *  inače 403 (postoji ali RLS write-scope odbija). Ne duplira write-scope. */
  private assertAffected(exists: boolean, count: number, what: string): void {
    if (count > 0) return;
    if (!exists) throw new NotFoundException(`${what} ne postoji`);
    throw new ForbiddenException(`Nemate pravo nad: ${what}`);
  }

  /**
   * 3.0 parnjak RLS politike `sastanci_update` / `sastanci_delete`:
   * `mgmt ∨ vodio_email ∨ zapisnicar_email ∨ created_by_email = jwt.email`.
   *
   * 🔴 ZAŠTO EKSPLICITNO: u sy15 je ovaj scope sprovodio RLS, pa ga kod NIJE
   * duplirao (doktrina A.2a). Pod `3.0` RLS-a nema — bez ove provere svako sa
   * `sastanci.edit` permisijom mogao bi da otkaže/promeni TUĐ sastanak. Prava
   * ovog obima ne smeju da nestanu usput sa seobom baze.
   */
  private async assertMozeMenjatiSastanak(
    email: string,
    id: string,
    s: {
      vodioEmail: string | null;
      zapisnicarEmail: string | null;
      createdByEmail: string | null;
    },
  ): Promise<void> {
    const v = (email ?? "").trim().toLowerCase();
    const eq = (x: string | null) => (x ?? "").trim().toLowerCase() === v;
    if (eq(s.vodioEmail) || eq(s.zapisnicarEmail) || eq(s.createdByEmail)) return;
    if (await this.authz.isManagement(v)) return;
    throw new ForbiddenException(`Nemate pravo nad: Sastanak ${id}`);
  }

  // ---------- Sastanci CRUD ----------

  /** Backdoor guard (S-P0 paket 1): status='zakljucan' NE ide kroz create/update
   *  — isključivo POST /:id/lock (RPC sast_zakljucaj_sastanak). DTO whitelist ovo
   *  već odbija na validaciji; servisni guard je pojas-i-tregeri za interne pozive. */
  private assertNotLockViaStatus(status?: string): void {
    if (status === "zakljucan") {
      throw new BadRequestException(
        "Status 'zakljucan' se ne postavlja direktno — koristite POST /sastanci/:id/lock.",
      );
    }
  }

  /** Dedup učesnika po lower(email) — PK je (sastanak_id,email), dupli unos = 23505.
   *  Prazan email se izbacuje (validacija je @IsString, ne @IsEmail — meki filter). */
  private dedupeUcesnici<T extends { email: string }>(list?: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const u of list ?? []) {
      const key = (u.email ?? "").toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    return out;
  }

  // ---------- Periodični (024/26 d1) — kolone van Prisma mape ----------
  // `interval_days`/`prethodni_sastanak_id` NISU u `prisma/sy15.prisma` NAMERNO:
  // mapirana kolona koje još nema u živoj bazi bi oborila SVAKO čitanje sastanaka
  // (Prisma select uzima sve mapirane kolone), a sy15 skriptu primenjuje vlasnik
  // ručno, nezavisno od deploy-a. Dok skripta nije primenjena, periodični tip se
  // uredno odbija porukom; posle primene je potreban restart (keš je procesni).

  private periodicniKoloneCache?: boolean;

  /** Da li žive kolone periodične serije postoje (keš po procesu). */
  private async periodicniKolone(tx: Sy15Tx): Promise<boolean> {
    if (this.periodicniKoloneCache !== undefined)
      return this.periodicniKoloneCache;
    const rows = await tx.$queryRaw<{ n: number }[]>(
      Prisma.sql`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sastanci'
          AND column_name IN ('interval_days', 'prethodni_sastanak_id')`,
    );
    this.periodicniKoloneCache = Number(rows[0]?.n ?? 0) === 2;
    return this.periodicniKoloneCache;
  }

  /** `interval_days` za skup sastanaka (prazna mapa dok kolone ne postoje). */
  private async intervalDaysMapa(
    tx: Sy15Tx,
    ids: string[],
  ): Promise<Map<string, number>> {
    const mapa = new Map<string, number>();
    if (!ids.length || !(await this.periodicniKolone(tx))) return mapa;
    const rows = await tx.$queryRaw<{ id: string; interval_days: number | null }[]>(
      Prisma.sql`SELECT id::text AS id, interval_days FROM sastanci
        WHERE id = ANY(${ids}::uuid[])`,
    );
    for (const r of rows) {
      if (r.interval_days != null) mapa.set(r.id, Number(r.interval_days));
    }
    return mapa;
  }

  /** Upis `interval_days` (raw — kolona van Prisma mape); zove se IZ transakcije
   *  create/update POSLE upisa reda, pod istim RLS-om (trio/mgmt scope važi). */
  private async upisiIntervalDays(
    tx: Sy15Tx,
    id: string,
    intervalDays: number,
  ): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`UPDATE sastanci SET interval_days = ${intervalDays} WHERE id = ${id}::uuid`,
    );
  }

  /** Kreiraj sastanak (paritet saveSastanak; RLS INSERT = has_edit_role).
   *  Zahtev 005/26: opcioni `dto.ucesnici` se umeću u istoj transakciji — umetanje
   *  reda u `sastanak_ucesnici` za planiran sastanak auto-okida sy15 trigger
   *  `sast_trg_ucesnik_invite` → 'meeting_invite' mejl (tema/termin/mesto). Isti
   *  put kao dodavanje učesnika (addUcesnik/bulk); enqueue radi DEFINER trigger,
   *  BE ne dira notification_log (B10). Atomično: pad unosa učesnika vrati i sastanak.
   *  Uvek `pozvan=true, prisutan=false` (klijent NE šalje te flagove — InviteUcesnikDto).
   *  Kad triger stварно pošalje (status='planiran' + bar 1 učesnik) stampujemo
   *  `pozivnicePoslateAt=now()` da detalj prikaže „Pošalji ponovo", a ne „Zakaži
   *  (pozivnice)" — inače bi ručni klik napravio DRUGI (dupli) talas mejlova. */
  async createSastanak(email: string, dto: CreateSastanakDto) {
    this.assertNotLockViaStatus(dto.status);
    // 024/26 d1 — tip↔interval par: periodični MORA imati interval, ostali NE SMEJU
    // (zaboravljen interval bi napravio seriju koju automatika nikad ne nastavi).
    if (dto.tip === "periodicni" && dto.intervalDays === undefined) {
      throw new BadRequestException(
        "Za periodični sastanak zadaj interval (broj dana između dva termina).",
      );
    }
    if (dto.tip !== "periodicni" && dto.intervalDays !== undefined) {
      throw new BadRequestException(
        "Interval važi samo uz tip 'periodicni'.",
      );
    }
    const ucesnici = this.dedupeUcesnici(dto.ucesnici);
    const status = dto.status ?? "planiran";
    // Triger šalje pozivnice samo za planiran sastanak — samo tada stampuj.
    const invitesSent = ucesnici.length > 0 && status === "planiran";
    if (this.izvor.isThreeZero) {
      // `sastanci_insert` WITH CHECK = has_edit_role(). U sy15 je odbijenicu davao
      // RLS (42501 -> 403); ovde gejt stoji PRE registra idempotencije, da
      // neovlašćen pokušaj ne potroši `clientEventId`.
      if (!(await this.authz.canCreateSastanak(email))) {
        throw new ForbiddenException("Nemate pravo da kreirate sastanak.");
      }
      // ✅ Rep iz prethodnog commita ZATVOREN (blokada 5): predmet se razrešava
      // PRE registra idempotencije (uuid -> Int), pa se više ne ispušta ćutke.
      // Nerazrešiv uuid je 422 — vidi „bezbedan smer" u `sastanci-predmet.ts`.
      const projekat = (await this.predmet.razresi(dto.projekatId)) ?? null;
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-sastanak",
        async (tx) => {
          const row = await tx.sastanak.create({
            data: {
              tip: dto.tip ?? "sedmicni",
              naslov: dto.naslov,
              datum: this.toDbDate(dto.datum)!,
              vreme: this.toDbTime(dto.vreme) ?? null,
              mesto: dto.mesto ?? "",
              projectId: projekat,
              vodioEmail: dto.vodioEmail ?? null,
              vodioLabel: dto.vodioLabel ?? null,
              zapisnicarEmail: dto.zapisnicarEmail ?? null,
              zapisnicarLabel: dto.zapisnicarLabel ?? null,
              status,
              napomena: dto.napomena ?? null,
              createdByEmail: email,
              // `interval_days` je u 3.0 redovna kolona modela (u sy15 je bila van
              // Prisma mape, pa je tamo trebao zaseban raw UPDATE + probe kolone).
              intervalDays: dto.intervalDays ?? null,
              pozivnicePoslateAt: invitesSent ? new Date() : null,
            },
          });
          if (ucesnici.length) {
            await tx.sastanakUcesnik.createMany({
              data: ucesnici.map((u) => ({
                sastanakId: row.id,
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
                pozvan: true,
                prisutan: false,
              })),
            });
            // sy15 je pozivnice slao TRIGEROM `sast_trg_ucesnik_invite` (AFTER
            // INSERT). Migracija taj triger namerno ne prenosi (logika, ne
            // mehanika), pa se prepis poziva ovde — inače bi novi sastanak
            // nastao BEZ ijedne pozivnice, tiho.
            await this.fn.ucesnikInviteTrigger(
              tx,
              row.id,
              ucesnici.map((u) => ({
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
              })),
            );
          }
          return this.predmetOut(row);
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-sastanak",
      async (tx) => {
        if (dto.tip === "periodicni" && !(await this.periodicniKolone(tx))) {
          throw new ConflictException(PERIODICNI_SQL_PORUKA);
        }
        const row = await tx.sastanak.create({
          data: {
            tip: dto.tip ?? "sedmicni",
            naslov: dto.naslov,
            datum: this.toDbDate(dto.datum)!,
            vreme: this.toDbTime(dto.vreme) ?? null,
            mesto: dto.mesto ?? "",
            projekatId: predmetZaSy15(dto.projekatId) ?? null,
            vodioEmail: dto.vodioEmail ?? null,
            vodioLabel: dto.vodioLabel ?? null,
            zapisnicarEmail: dto.zapisnicarEmail ?? null,
            zapisnicarLabel: dto.zapisnicarLabel ?? null,
            status,
            napomena: dto.napomena ?? null,
            createdByEmail: email,
            pozivnicePoslateAt: invitesSent ? new Date() : null,
          },
        });
        if (dto.tip === "periodicni" && dto.intervalDays !== undefined) {
          await this.upisiIntervalDays(tx, row.id, dto.intervalDays);
        }
        if (ucesnici.length) {
          // Uvek pozvan=true (kandidat za pozivnicu i otkazni mejl), prisutan=false
          // (prisustvo tek na „▶ Počni"). Umetanje reda okida invite triger.
          await tx.sastanakUcesnik.createMany({
            data: ucesnici.map((u) => ({
              sastanakId: row.id,
              email: u.email.toLowerCase().trim(),
              label: u.label ?? null,
              pozvan: true,
              prisutan: false,
            })),
          });
        }
        // `intervalDays` u odgovoru — red iz Prisma mape ga nema (kolona van mape).
        return dto.tip === "periodicni"
          ? { ...row, intervalDays: dto.intervalDays }
          : row;
      },
    );
  }

  /** Izmena sastanka (paritet saveSastanak/updateStatus; RLS UPDATE = mgmt∨trio).
   *  024/26 d2 — `tip` (uklj. 'periodicni') se menja OVDE: „od trenutka promene
   *  važi novi režim, istorija netaknuta" — stari redovi serije se ne diraju,
   *  automatika nastavlja po novom tipu/intervalu. Tip koji ode SA 'periodicni'
   *  zadržava zatečeni `interval_days` (bezopasno: automatika filtrira po tipu),
   *  pa povratak na periodični ne traži ponovni unos intervala. */
  async updateSastanak(email: string, id: string, dto: UpdateSastanakDto) {
    this.assertNotLockViaStatus(dto.status);
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresi(dto.projekatId);
      return this.threeZeroTx(async (tx) => {
        const postojeci = await tx.sastanak.findUnique({
          where: { id },
          select: {
            tip: true,
            intervalDays: true,
            vodioEmail: true,
            zapisnicarEmail: true,
            createdByEmail: true,
          },
        });
        if (!postojeci) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        const finalniTip = dto.tip ?? postojeci.tip;
        if (dto.intervalDays !== undefined && finalniTip !== "periodicni") {
          throw new BadRequestException(
            "Interval važi samo uz tip 'periodicni'.",
          );
        }
        // Pod `3.0` kolone periodične serije POSTOJE uvek (redovna polja modela),
        // pa provera `periodicniKolone` i njena `ConflictException` OTPADAJU —
        // preostaje samo poslovno pravilo „periodični mora imati interval".
        if (
          finalniTip === "periodicni" &&
          dto.intervalDays === undefined &&
          !postojeci.intervalDays
        ) {
          throw new BadRequestException(
            "Za periodični sastanak zadaj interval (broj dana između dva termina).",
          );
        }
        // RLS `sastanci_update` (mgmt ∨ trio) + guard `sast_check_not_locked`.
        await this.assertMozeMenjatiSastanak(email, id, postojeci);
        await this.fn.assertNotLocked(tx, email, id);
        const svez = await tx.sastanak.update({
          where: { id },
          data: {
            ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
            ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
            ...(dto.datum !== undefined
              ? { datum: this.toDbDate(dto.datum)! }
              : {}),
            ...(dto.vreme !== undefined
              ? { vreme: this.toDbTime(dto.vreme) }
              : {}),
            ...(dto.mesto !== undefined ? { mesto: dto.mesto } : {}),
            ...(projekat !== undefined ? { projectId: projekat } : {}),
            ...(dto.vodioEmail !== undefined
              ? { vodioEmail: dto.vodioEmail }
              : {}),
            ...(dto.vodioLabel !== undefined
              ? { vodioLabel: dto.vodioLabel }
              : {}),
            ...(dto.zapisnicarEmail !== undefined
              ? { zapisnicarEmail: dto.zapisnicarEmail }
              : {}),
            ...(dto.zapisnicarLabel !== undefined
              ? { zapisnicarLabel: dto.zapisnicarLabel }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
            ...(dto.intervalDays !== undefined
              ? { intervalDays: dto.intervalDays }
              : {}),
            updatedAt: new Date(),
          },
        });
        return {
          data: {
            ...this.predmetOut(svez),
            ...(svez.tip === "periodicni"
              ? { intervalDays: svez.intervalDays ?? null }
              : {}),
          },
        };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const postojeci = await tx.sastanak.findUnique({
        where: { id },
        select: { tip: true },
      });
      const exists = postojeci !== null;
      const finalniTip = dto.tip ?? postojeci?.tip;
      if (dto.intervalDays !== undefined && finalniTip !== "periodicni") {
        throw new BadRequestException("Interval važi samo uz tip 'periodicni'.");
      }
      if (finalniTip === "periodicni" && exists) {
        if (!(await this.periodicniKolone(tx))) {
          throw new ConflictException(PERIODICNI_SQL_PORUKA);
        }
        if (dto.intervalDays === undefined) {
          const zatecen = (await this.intervalDaysMapa(tx, [id])).get(id);
          if (!zatecen) {
            throw new BadRequestException(
              "Za periodični sastanak zadaj interval (broj dana između dva termina).",
            );
          }
        }
      }
      const data: Prisma.SastanakUpdateInput = {
        ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.datum !== undefined
          ? { datum: this.toDbDate(dto.datum)! }
          : {}),
        ...(dto.vreme !== undefined ? { vreme: this.toDbTime(dto.vreme) } : {}),
        ...(dto.mesto !== undefined ? { mesto: dto.mesto } : {}),
        ...(dto.projekatId !== undefined
          ? { projekatId: predmetZaSy15(dto.projekatId) }
          : {}),
        ...(dto.vodioEmail !== undefined ? { vodioEmail: dto.vodioEmail } : {}),
        ...(dto.vodioLabel !== undefined ? { vodioLabel: dto.vodioLabel } : {}),
        ...(dto.zapisnicarEmail !== undefined
          ? { zapisnicarEmail: dto.zapisnicarEmail }
          : {}),
        ...(dto.zapisnicarLabel !== undefined
          ? { zapisnicarLabel: dto.zapisnicarLabel }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
        updatedAt: new Date(),
      };
      const { count } = await tx.sastanak.updateMany({ where: { id }, data });
      this.assertAffected(exists, count, `Sastanak ${id}`);
      if (dto.intervalDays !== undefined) {
        // Tek POSLE updateMany: RLS je upravo pustio izmenu reda, pa sme i raw
        // upis intervala (ista transakcija, isti scope).
        await this.upisiIntervalDays(tx, id, dto.intervalDays);
      }
      const svez = await tx.sastanak.findUnique({ where: { id } });
      const interval =
        svez?.tip === "periodicni"
          ? ((await this.intervalDaysMapa(tx, [id])).get(id) ?? null)
          : undefined;
      return {
        data:
          svez && interval !== undefined
            ? { ...svez, intervalDays: interval }
            : svez,
      };
    });
  }

  /**
   * Brisanje sastanka (zahtev 013/26 — Zoran Jaraković, odobreno 24.07.2026:
   * „Organizator i administrator treba da imaju mogućnost brisanja sastanka.").
   *
   * AUTORIZACIJA: klasni guard je `sastanci.edit` (VIDLJIVOST akcije); RED presuđuje
   * sy15 RLS politika `sastanci_delete` (`current_user_is_management() ∨ vodio_email
   * ∨ zapisnicar_email = jwt.email`) POD `authenticated` rolom (withUserRls). RLS
   * odbijen DELETE = 0 redova → `assertAffected` mapira 403 (postoji, nema prava) /
   * 404 (ne postoji). DODATNI DB guard `sast_check_not_locked` (BEFORE DELETE)
   * dozvoljava brisanje ZAKLJUČANOG sastanka ISKLJUČIVO menadžmentu (inače 23514 →
   * 422) — organizator ne može obrisati zaključan sastanak dok ga mgmt ne otvori.
   *
   * OTKAZ vs BRISANJE (PRESUDA 013/26): brisanje UKLANJA sastanak (za razliku od
   * otkaza koji ga čuva sa status='otkazan'). Ako sastanak još NIJE gotov
   * (status ∈ {planiran,u_toku}), prvo se UVEK enqueue-uju otkazna obaveštenja
   * (`sast_enqueue_cancel(uuid)` → 'meeting_cancel' red u `sastanci_notification_log`
   * za svakog `pozvan=true`), pa se briše — da pozvani ne ostanu bez obaveštenja da
   * sastanak više ne postoji. Status se OVDE ne dira (red ionako nestaje). NAMERNO
   * bez count-gejta pozvanih: DEFINER fn sam enumeriše pozvane (0 pozvanih = 0
   * mejlova, bez greške), a brojanje pozvanih OVDE bi teklo pod su_select RLS-om
   * POZIVAOCA — ako se ta politika ikad suzi (postoji `harden_sastanci_rls_phase2`
   * varijanta), pogrešan 0 bi TIHO preskočio otkazne mejlove. Gotovi
   * (zakljucan/zavrsen/otkazan) → samo brisanje. Gejt je na STATUS (ne na datum) —
   * status je izvor istine o životnom ciklusu i identičan je gejtu postojećeg
   * „Otkaži sastanak" dugmeta (paritet UX-a).
   *
   * ⚠️ 021/26 (bug-fix 30.07.2026): ranije je ovde stajao poziv
   * `sastanci_cancel_sastanak(uuid)` — fn koja na živoj sy15 NIKAD NIJE KREIRANA
   * (skripta `backend/docs/sql/sy15/sastanci-lifecycle-2026-07-18/10_…` nije
   * primenjena). Svako brisanje planiranog/u_toku sastanka je zato padalo na
   * 42883 undefined_function → 500 „Neočekivana greška na serveru". Zamenjeno
   * POSTOJEĆOM `sast_enqueue_cancel` (SECURITY DEFINER, EXECUTE ima `authenticated`
   * — provereno na živoj bazi 30.07.2026). Nova sy15 fn se NE pravi (doktrina: na
   * sy15 se više ništa ne gradi).
   *
   * FK DECA (sy15 add_sastanci_module.sql / odluke tabela): ON DELETE CASCADE —
   * `sastanak_ucesnici`, `presek_aktivnosti`, `presek_slike`, `sastanak_arhiva`,
   * `sastanak_odluke` (brišu se automatski); ON DELETE SET NULL —
   * `pm_teme.sastanak_id`, `akcioni_plan.sastanak_id`,
   * `sastanci_notification_log.related_sastanak_id` (PREŽIVE; veza se nuluje). Zato
   * je brisanje parenta bezbedno bez ručnog čišćenja child tabela, a enqueue-ovani
   * 'meeting_cancel' mejlovi PREŽIVE brisanje (related_sastanak_id → NULL, red ostaje
   * 'queued' i dispatch ga pošalje). Cancel + delete su u ISTOJ transakciji
   * (withUserRls) — ako RLS odbije DELETE, i cancel se rollback-uje (nema fantomskih
   * mejlova za sastanak koji je ostao). NAPOMENA: storage-bajtovi slika/PDF-a nisu u
   * DB-u pa cascade ne dira bucket — ostaju siročići (bezopasno, isto kao u 1.0).
   */
  async deleteSastanak(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const s = await tx.sastanak.findUnique({
          where: { id },
          select: {
            status: true,
            vodioEmail: true,
            zapisnicarEmail: true,
            createdByEmail: true,
          },
        });
        if (!s) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        // RLS `sastanci_delete` (mgmt ∨ trio) + guard-triger `sast_check_not_locked`
        // (zaključan sme SAMO mgmt) — oba pod 3.0 eksplicitno, PRE enqueue-a.
        await this.assertMozeMenjatiSastanak(email, id, s);
        await this.fn.assertNotLocked(tx, email, id);
        // Redosled (enqueue → delete) MORA ostati: mejlovi preživljavaju brisanje
        // (FK je SET NULL), a neuspeh brisanja rollback-uje i njih.
        if (s.status === "planiran" || s.status === "u_toku") {
          await this.fn.enqueueCancel(tx, id);
        }
        await tx.sastanak.delete({ where: { id } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      // Postojanje kroz SELECT (RLS select je širi od delete): null → 404.
      const sastanak = await tx.sastanak.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);

      // Otkaz-pre-brisanja za žive sastanke: UVEK enqueue-uj otkazne mejlove (bez
      // count-gejta pozvanih — DEFINER sam enumeriše `pozvan=true`; vidi doc gore).
      //
      // AUTORIZACIJA NIJE OVDE: `sast_enqueue_cancel` je pozadinska DEFINER fn BEZ
      // ijedne provere prava (samo enumeriše pozvane i puni outbox). Pravo presuđuje
      // ISKLJUČIVO RLS politika `sastanci_delete` na DELETE-u ispod. Bezbedno je jer
      // je enqueue u ISTOJ transakciji PRE brisanja: ako RLS odbije DELETE (0 redova
      // → 403) ili guard-triger digne 23514 (zaključan, ne-mgmt → 422), ceo tx se
      // rollback-uje i enqueue-ovani redovi nestaju — neovlašćen pokušaj NE može da
      // ostavi mejlove u redu za slanje. Zato redosled (enqueue → delete) mora ostati.
      //
      // Bez try/catch: `sast_enqueue_cancel` NE diže greške — ako je red u
      // međuvremenu nestao (konkurentno brisanje) vraća 0, a 404 tada uredno stiže
      // iz `deleteMany`/`assertAffected` grane ispod. (Stara P0002→404 mapa je
      // pripadala `sastanci_cancel_sastanak`-ovom `SELECT … FOR UPDATE`; ta fn ne
      // postoji, pa je i grana bila mrtva.)
      if (sastanak.status === "planiran" || sastanak.status === "u_toku") {
        await tx.$queryRaw(
          Prisma.sql`SELECT sast_enqueue_cancel(${id}::uuid) AS result`,
        );
      }

      const { count } = await tx.sastanak.deleteMany({ where: { id } });
      if (count === 0) {
        // 0 redova: RLS delete-scope odbio (red i dalje postoji → 403) ILI je red u
        // međuvremenu nestao (konkurentno brisanje → 404). Svež upit u ISTOJ tx
        // razdvaja te dve mogućnosti (assertAffected: !exists→404, exists→403).
        const stillExists = (await tx.sastanak.count({ where: { id } })) > 0;
        this.assertAffected(stillExists, 0, `Sastanak ${id}`);
      }
      return { data: { ok: true } };
    });
  }

  /**
   * Zaključaj (arhiva snapshot + status; PDF path PRE meeting_locked trigera — §2 p.8).
   *
   * 4. argument `zapisnikDatum` je datum ODRŽAVANJA koji nosi zapisnik (zahtev 014/26 +
   * presuda vlasnika 25.07.2026). Ide U ISTOM RPC pozivu, a ne kroz naknadni UPDATE, jer
   * sy15 triger `sast_notif_meeting_locked` (AFTER UPDATE OF status) payload mejla gradi
   * iz `NEW.*` — zaseban naknadni upis bi zakasnio i mejl bi otišao sa starim datumom.
   * Izostavljen (`null`) → RPC ostavlja kolonu kakva jeste; PDF/mejl padaju na
   * `sastanci.datum`, tj. ponašanje identično stanju pre ovog paketa.
   */
  lock(email: string, id: string, dto: LockSastanakDto) {
    if (this.izvor.isThreeZero) {
      // Registra idempotencije nema u 3.0 (v. `threeZeroTx`), ali zaključavanje
      // ima SOPSTVENU branu ponavljanja: drugi poziv vraća `already_locked` i ne
      // dira ni arhivu ni mejlove. Zato je bezbedno bez registra; `meta` to i
      // kaže (`idempotent:false` = nije vraćen sačuvan rezultat).
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.zakljucajSastanak(
          tx,
          email,
          id,
          dto.pdfStoragePath ?? null,
          dto.zapisnikDatum ?? null,
        ),
        meta: { idempotent: false },
      }));
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.lock",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>(
          Prisma.sql`SELECT sast_zakljucaj_sastanak(${id}::uuid, NULL, ${dto.pdfStoragePath ?? null}, ${dto.zapisnikDatum ?? null}::date) AS result`,
        );
        return rows[0]?.result ?? null;
      },
    );
  }

  /**
   * Ispravi datum zapisnika i na ZAKLJUČANOM sastanku (zahtev 014/26 — Zoranova
   * primedba: zaključan zapisnik sa pogrešnim datumom, koji se do sada nije mogao
   * ispraviti bez „Otvori ponovo").
   *
   * Ide kroz sy15 DEFINER RPC `sast_set_zapisnik_datum`, a NE kroz `tx.sastanak.update`:
   * guard triger `sast_check_not_locked` (BEFORE UPDATE) obara direktan UPDATE zaključanog
   * reda sa 23514 (→ 422 i nejasnom porukom) svima osim rukovodstvu. RPC istu proveru radi
   * eksplicitno (`current_user_is_management()`, isti krug kao „Pošalji ponovo") i vraća
   * 42501 → 403. Ruta je uz to gejtovana `SASTANCI_MANAGE` permisijom.
   *
   * RPC ne dira `status`, pa `sast_notif_meeting_locked` ne okida — ispravka datuma NE
   * šalje mejlove. Ponovno slanje ostaje svestan klik („Pošalji ponovo"), koji već čita
   * novi datum. 404 razrešavamo pre RPC-a (rethrowSy15 P0002 mapira na 422).
   */
  setZapisnikDatum(email: string, id: string, dto: SetZapisnikDatumDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.setZapisnikDatum(
          tx,
          email,
          id,
          dto.zapisnikDatum,
        ),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanak.count({ where: { id } })) > 0;
      if (!exists) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT sast_set_zapisnik_datum(${id}::uuid, ${dto.zapisnikDatum}::date) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  /**
   * Otkaži sastanak sa obaveštenjem učesnicima (S2): `status='otkazan'` +
   * 'meeting_cancel' mejl svakom `pozvan=true`.
   *
   * ⚠️ 021/26 (bug-fix 30.07.2026): ranije je ceo tok išao kroz RPC
   * `sastanci_cancel_sastanak(uuid)` koji na živoj sy15 NIKAD NIJE KREIRAN (skripta
   * `docs/sql/sy15/sastanci-lifecycle-2026-07-18/10_…` nije primenjena) — „Otkaži i
   * obavesti" je zato SVIMA padalo na 42883 undefined_function → 500. Nova sy15 fn se
   * NE pravi (doktrina: sy15 se gasi, ništa novo se tamo ne gradi), pa je tok
   * sastavljen od POSTOJEĆIH delova, u ISTOJ transakciji i istom redosledu kao
   * `sast_weekly_odlozi` (prvo status, pa enqueue — mejl nosi već otkazano stanje):
   *   1. `updateMany status='otkazan'` kroz Prisma (dakle POD RLS-om `authenticated`);
   *   2. `sast_enqueue_cancel(uuid)` — postojeća DEFINER fn (EXECUTE ima
   *      `authenticated`, provereno na živoj bazi 30.07.2026) koja puni
   *      `sastanci_notification_log`. Direktan INSERT iz BE-a ostaje zabranjen
   *      (presuda B10) — enqueue radi isključivo DEFINER fn.
   *
   * AUTORIZACIJA: klasni guard `sastanci.edit` (VIDLJIVOST) + RED presuđuje RLS
   * politika `sastanci_update` (`mgmt ∨ vodio ∨ zapisnicar ∨ created_by`) — ISTI
   * scope kao običan PATCH statusa, tj. otkazivanje NIJE šire od onoga što korisnik
   * ionako sme. `sast_enqueue_cancel` sam NEMA nikakav guard; bezbedno je jer je
   * pozvan POSLE RLS-guarded UPDATE-a u istoj transakciji — RLS-odbijen UPDATE
   * (0 redova → 403) prekida tok PRE enqueue-a, a svaka kasnija greška rollback-uje
   * i već enqueue-ovane redove.
   *
   * ZAKLJUČAN/VEĆ OTKAZAN → meki `{ ok:false, reason:'locked'|'already_cancelled' }`
   * (legitiman 200, kao `already_locked` kod lock-a; FE ga prikazuje kao poruku, vidi
   * `sastanak-detalj.tsx`). Rana provera statusa čuva tu poruku i za rukovodstvo
   * (koje bi na UPDATE-u prošlo); guard-triger `sast_trg_locked_guard_sastanci`
   * ostaje brana za trku (sastanak zaključan između SELECT-a i UPDATE-a): ne-mgmt
   * dobija 23514 → 422.
   *
   * IDEMPOTENCIJA — dva sloja, oba očuvana: (a) `runIdempotentRls` sa clientEventId
   * (dupli POST vraća sačuvan rezultat, fn se NE izvršava ponovo → nema drugog talasa
   * mejlova); (b) status-provera `already_cancelled` (nov clientEventId nad već
   * otkazanim sastankom ne dira bazu i ne enqueue-uje).
   */
  cancel(email: string, id: string, dto: CancelSastanakDto) {
    if (this.izvor.isThreeZero) {
      // Kao kod `lock`: registra idempotencije nema, ali sloj (b) iz doc-a gore
      // (`already_cancelled`) sam po sebi sprečava drugi talas mejlova. Pravo
      // reda (RLS `sastanci_update` = mgmt ∨ trio) pod 3.0 sprovodi `assertMoze
      // MenjatiSastanak` PRE upisa — u sy15 ga je sprovodio RLS filter.
      return this.threeZeroTx(async (tx) => {
        const s = await tx.sastanak.findUnique({
          where: { id },
          select: {
            status: true,
            vodioEmail: true,
            zapisnicarEmail: true,
            createdByEmail: true,
          },
        });
        if (!s) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        if (s.status === "zakljucan")
          return { data: { ok: false, reason: "locked", sastanak_id: id }, meta: { idempotent: false } };
        if (s.status === "otkazan")
          return {
            data: { ok: false, reason: "already_cancelled", sastanak_id: id },
            meta: { idempotent: false },
          };
        await this.assertMozeMenjatiSastanak(email, id, s);
        const otkazanAt = new Date();
        await tx.sastanak.update({
          where: { id },
          data: { status: "otkazan", updatedAt: otkazanAt },
        });
        const obavesteno = await this.fn.enqueueCancel(tx, id);
        return {
          data: {
            ok: true,
            sastanak_id: id,
            otkazan_at: otkazanAt.toISOString(),
            obavesteno,
          },
          meta: { idempotent: false },
        };
      });
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.cancel",
      async (tx) => {
        const sastanak = await tx.sastanak.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!sastanak) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        if (sastanak.status === "zakljucan") {
          return { ok: false, reason: "locked", sastanak_id: id };
        }
        if (sastanak.status === "otkazan") {
          return { ok: false, reason: "already_cancelled", sastanak_id: id };
        }

        const otkazanAt = new Date();
        const { count } = await tx.sastanak.updateMany({
          where: { id },
          data: { status: "otkazan", updatedAt: otkazanAt },
        });
        if (count === 0) {
          // RLS odbio (red postoji → 403) ili je red nestao (→ 404) — isto
          // razdvajanje kao u deleteSastanak. Enqueue se NE izvršava.
          const stillExists = (await tx.sastanak.count({ where: { id } })) > 0;
          this.assertAffected(stillExists, 0, `Sastanak ${id}`);
        }

        const rows = await tx.$queryRaw<{ result: number | null }[]>(
          Prisma.sql`SELECT sast_enqueue_cancel(${id}::uuid) AS result`,
        );
        // `obavesteno` = broj pozvanih za koje je fn pozvala enqueue (opt-out red
        // uđe kao 'skipped', pa je to gornja granica poslatih — isti broj koji je
        // vraćao i planirani RPC).
        return {
          ok: true,
          sastanak_id: id,
          otkazan_at: otkazanAt.toISOString(),
          obavesteno: Number(rows[0]?.result ?? 0),
        };
      },
    );
  }

  /**
   * Reopen (mgmt): zakljucan → u_toku, očisti zakljucan_* (paritet otvojiPonovo).
   *
   * Briše i `zapisnikDatum` (review D7): zapisnik prestaje da postoji kao zvanični
   * dokument, pa sledeće zaključavanje mora da datum izabere iznova — inače bi stari
   * (možda baš pogrešan) datum tiho vaskrsao u novom PDF-u i mejlu. Isti brisač
   * postoji i na DB nivou (grana u `sast_check_not_locked`) jer 1.0 `otvojiPonovo`
   * ide direktnim PATCH-om na `sastanci`, mimo ovog servisa.
   */
  reopen(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const s = await tx.sastanak.findUnique({
          where: { id },
          select: {
            vodioEmail: true,
            zapisnicarEmail: true,
            createdByEmail: true,
          },
        });
        if (!s) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        await this.assertMozeMenjatiSastanak(email, id, s);
        // 🔴 `assertNotLocked` se OVDE NE ZOVE, a to nije propust: „Otvori
        // ponovo" po definiciji dira ZAKLJUČAN sastanak. U sy15 je guard-triger
        // `sast_check_not_locked` istu radnju puštao SAMO menadžmentu — a
        // `assertMozeMenjatiSastanak` je širi (mgmt ∨ trio). Zato se ovde traži
        // izričito rukovodstvo, kao u bazi.
        if (!(await this.authz.isManagement(email))) {
          throw new UnprocessableEntityException(
            `Zaključan sastanak može ponovo otvoriti samo rukovodstvo (id: ${id})`,
          );
        }
        const data = await tx.sastanak.update({
          where: { id },
          data: {
            status: "u_toku",
            zakljucanAt: null,
            zakljucanByEmail: null,
            // Review D7: reopen briše datum zapisnika — u sy15 je to radila
            // grana u `sast_check_not_locked`, ovde eksplicitno.
            zapisnikDatum: null,
            updatedAt: new Date(),
          },
        });
        return { data: this.predmetOut(data) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanak.count({ where: { id } })) > 0;
      const { count } = await tx.sastanak.updateMany({
        where: { id },
        data: {
          status: "u_toku",
          zakljucanAt: null,
          zakljucanByEmail: null,
          zapisnikDatum: null,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Sastanak ${id}`);
      return { data: await tx.sastanak.findUnique({ where: { id } }) };
    });
  }

  /**
   * „Sedmični + prenos" (S-P0 paket 4) — paritet 1.0 prenesiUNoviSastanak
   * (sastanci.js:258-290). Izvor je EKSPLICITAN (fromSastanakId) ili, kad
   * izostane, BE ga bira 1.0 semantikom UNUTAR iste transakcije: poslednji
   * sastanak ISTOG tipa kao novi, datum STROGO < datum novog (novi ima budući
   * datum pa bi „najnoviji" uhvatio sam novi red), id != novi, order datum
   * desc + created_at desc, limit 1. Nema kandidata → {ucesnici:0, akcije:0,
   * source:null} BEZ greške (1.0 vraća preneto/ucesnika 0). Odgovor uvek nosi
   * `source: { id, naslov } | null` (paritet 1.0 sourceNaslov).
   *  - učesnici: 1.0 saveUcesnici = bulk REPLACE na NOVOM sastanku učesnicima
   *    izvora (pozvan=true, prisutan=false); izvor bez učesnika → novi netaknut;
   *  - akcije: UPDATE akcioni_plan SET sastanak_id=novi za status IN
   *    ('otvoren','u_toku') — TAČAN 1.0 filter `status=in.(otvoren,u_toku)`
   *    (NE „!= zavrsen": zavrsen/odlozen/otkazan ostaju na starom).
   * Zaključan IZVOR prolazi kao u 1.0: lock-trigger (sast_check_not_locked) za
   * UPDATE child reda proverava NEW.sastanak_id — tj. status NOVOG (nezaključanog)
   * parenta; učesnici izvora se samo ČITAJU. Zaključan CILJNI sastanak pada na
   * trigeru (23514 → 422 „Nije moguće menjati podatke zaključanog sastanka").
   */
  async prenos(email: string, id: string, dto: PrenosDto) {
    if (dto.fromSastanakId === id) {
      throw new BadRequestException(
        "Izvorni i ciljni sastanak su isti — prenos nema šta da premesti.",
      );
    }
    if (this.izvor.isThreeZero) {
      // Prenos piše u DECU CILJNOG sastanka (`su_*` insert/delete, `ap_update`
      // WITH CHECK). Gejt ciljnog stoji pre registra; gejt IZVORA se proverava
      // unutar transakcije, kad se sazna koji je (može biti izabran automatski) —
      // `ap_update` u sy15 traži i USING (stari red) i WITH CHECK (novi red).
      await this.authz.assertCanWriteSastanakChild(email, id);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.prenos",
        async (tx) => {
          await this.fn.assertNotLocked(tx, email, id);
          const novi = await tx.sastanak.findUnique({
            where: { id },
            select: { datum: true, tip: true },
          });
          if (!novi) throw new NotFoundException(`Sastanak ${id} ne postoji`);
          let source: { id: string; naslov: string | null } | null;
          if (dto.fromSastanakId) {
            const izvor = await tx.sastanak.findUnique({
              where: { id: dto.fromSastanakId },
              select: { id: true, naslov: true },
            });
            if (!izvor) {
              throw new NotFoundException(
                `Izvorni sastanak ${dto.fromSastanakId} ne postoji`,
              );
            }
            source = izvor;
          } else {
            source = await tx.sastanak.findFirst({
              where: { id: { not: id }, tip: novi.tip, datum: { lt: novi.datum } },
              orderBy: [{ datum: "desc" }, { createdAt: "desc" }],
              select: { id: true, naslov: true },
            });
            if (!source) return { ucesnici: 0, akcije: 0, source: null };
          }
          // USING strana `ap_update`: akcije se SKIDAJU sa izvora, pa i on mora
          // da prođe gejt. (Učesnici izvora se samo čitaju — `su_select` je `true`.)
          await this.authz.assertCanWriteSastanakChild(email, source.id);
          const uce = await tx.sastanakUcesnik.findMany({
            where: { sastanakId: source.id },
            select: { email: true, label: true },
          });
          if (uce.length) {
            const stari = await tx.sastanakUcesnik.findMany({
              where: { sastanakId: id },
              select: { email: true },
            });
            await tx.sastanakUcesnik.deleteMany({ where: { sastanakId: id } });
            await this.fn.ucesnikInviteCleanup(
              tx,
              id,
              stari.map((u) => u.email),
            );
            await tx.sastanakUcesnik.createMany({
              data: uce.map((u) => ({
                sastanakId: id,
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
                pozvan: true,
                prisutan: false,
              })),
            });
            await this.fn.ucesnikInviteTrigger(
              tx,
              id,
              uce.map((u) => ({
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
              })),
            );
          }
          const { count } = await tx.akcionaTacka.updateMany({
            where: {
              sastanakId: source.id,
              status: { in: ["otvoren", "u_toku"] },
            },
            data: { sastanakId: id, updatedAt: new Date() },
          });
          return {
            ucesnici: uce.length,
            akcije: count,
            source: { id: source.id, naslov: source.naslov ?? null },
          };
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.prenos",
      async (tx) => {
        const novi = await tx.sastanak.findUnique({
          where: { id },
          select: { datum: true, tip: true },
        });
        if (!novi) throw new NotFoundException(`Sastanak ${id} ne postoji`);
        let source: { id: string; naslov: string | null } | null;
        if (dto.fromSastanakId) {
          const izvor = await tx.sastanak.findUnique({
            where: { id: dto.fromSastanakId },
            select: { id: true, naslov: true },
          });
          if (!izvor) {
            throw new NotFoundException(
              `Izvorni sastanak ${dto.fromSastanakId} ne postoji`,
            );
          }
          source = izvor;
        } else {
          source = await tx.sastanak.findFirst({
            where: {
              id: { not: id },
              tip: novi.tip,
              datum: { lt: novi.datum },
            },
            orderBy: [{ datum: "desc" }, { createdAt: "desc" }],
            select: { id: true, naslov: true },
          });
          if (!source) return { ucesnici: 0, akcije: 0, source: null };
        }
        const uce = await tx.sastanakUcesnik.findMany({
          where: { sastanakId: source.id },
          select: { email: true, label: true },
        });
        if (uce.length) {
          await tx.sastanakUcesnik.deleteMany({ where: { sastanakId: id } });
          await tx.sastanakUcesnik.createMany({
            data: uce.map((u) => ({
              sastanakId: id,
              email: u.email.toLowerCase().trim(),
              label: u.label ?? null,
              pozvan: true,
              prisutan: false,
            })),
          });
        }
        const { count } = await tx.akcioniPlan.updateMany({
          where: {
            sastanakId: source.id,
            status: { in: ["otvoren", "u_toku"] },
          },
          data: { sastanakId: id, updatedAt: new Date() },
        });
        return {
          ucesnici: uce.length,
          akcije: count,
          source: { id: source.id, naslov: source.naslov ?? null },
        };
      },
    );
  }

  // ---------- Pozivnice / podsetnici (delete-pa-enqueue RPC — re-send semantika) ----------

  /** Pošalji pozivnice + stamp pozivnice_poslate_at (paritet sendInvites; RPC=mgmt). */
  sendInvites(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const n = await this.fn.sendInvites(tx, email, id);
        if (n > 0) {
          await tx.sastanak.updateMany({
            where: { id },
            data: { pozivnicePoslateAt: new Date() },
          });
        }
        return { data: { sent: n } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT sastanci_send_invites(${id}::uuid) AS n`,
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        await tx.sastanak.updateMany({
          where: { id },
          data: { pozivnicePoslateAt: new Date() },
        });
      }
      return { data: { sent: n } };
    });
  }

  remindUnprepared(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: { reminded: await this.fn.remindUnprepared(tx, email, id) },
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT sastanci_remind_unprepared(${id}::uuid) AS n`,
      );
      return { data: { reminded: Number(rows[0]?.n ?? 0) } };
    });
  }

  resendLocked(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: { resent: await this.fn.resendMeetingLocked(tx, email, id) },
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT sastanci_resend_meeting_locked(${id}::uuid) AS n`,
      );
      return { data: { resent: Number(rows[0]?.n ?? 0) } };
    });
  }

  /** Moj RSVP (sastanci_set_my_rsvp — svako svoj; idempotentno po vrednosti). */
  async setMyRsvp(email: string, id: string, dto: RsvpDto) {
    if (this.izvor.isThreeZero) {
      const rsvp = await this.samousluga.setMyRsvp(email, id, dto.status ?? null);
      return { data: { rsvp } };
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sastanci_set_my_rsvp(${id}::uuid, ${dto.status ?? null}) AS result`,
      );
      return { data: { rsvp: rows[0]?.result ?? null } };
    });
  }

  /** Status SOPSTVENE akcije (sastanci_set_my_akcija_status — odluka 26.07): RPC
   *  presuđuje vlasništvo po odgovoran_email; zavrsen → zatvoren_* snapshot u bazi. */
  async setMyAkcijaStatus(email: string, id: string, dto: MyAkcijaStatusDto) {
    if (this.izvor.isThreeZero) {
      const status = await this.samousluga.setMyAkcijaStatus(email, id, dto.status);
      if (status === "not_owner")
        throw new ForbiddenException(
          "Niste odgovorni za ovu akciju — status menja zapisničar.",
        );
      return { data: { status } };
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sastanci_set_my_akcija_status(${id}::uuid, ${dto.status}::text) AS result`,
      );
      if ((rows[0]?.result ?? null) === "not_owner")
        throw new ForbiddenException(
          "Niste odgovorni za ovu akciju — status menja zapisničar.",
        );
      return { data: { status: rows[0]?.result ?? null } };
    });
  }

  /** Moja priprema (sastanci_set_my_priprema — odluka 26.07): samo pripremljen +
   *  tekst; prazan tekst čisti polje; pozvan/prisutan ostaje zapisničaru. */
  async setMyPriprema(email: string, id: string, dto: MyPripremaDto) {
    if (this.izvor.isThreeZero) {
      const out = await this.samousluga.setMyPriprema(
        email,
        id,
        dto.pripremljen ?? null,
        dto.priprema ?? null,
      );
      if (out === "not_participant")
        throw new ForbiddenException("Niste učesnik ovog sastanka.");
      return { data: { ok: true } };
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sastanci_set_my_priprema(${id}::uuid, ${dto.pripremljen ?? null}::boolean, ${dto.priprema ?? null}::text) AS result`,
      );
      if ((rows[0]?.result ?? null) === "not_participant")
        throw new ForbiddenException("Niste učesnik ovog sastanka.");
      return { data: { ok: true } };
    });
  }

  // ---------- Učesnici ----------

  /** Bulk replace (DELETE pa INSERT — regeneriše rsvp_token, briše RSVP; §2 p.6/B8). */
  async bulkUcesnici(email: string, id: string, dto: BulkUcesniciDto) {
    if (this.izvor.isThreeZero) {
      // `su_delete` + `su_insert` = has_edit_role ∧ (učesnik ∨ mgmt ∨ trio).
      await this.authz.assertCanWriteSastanakChild(email, id);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.bulk-ucesnici",
        async (tx) => {
          // Guard-triger `sast_check_not_locked` je u sy15 stajao i na deci —
          // zaključan sastanak menja samo rukovodstvo.
          await this.fn.assertNotLocked(tx, email, id);
          const stari = await tx.sastanakUcesnik.findMany({
            where: { sastanakId: id },
            select: { email: true },
          });
          await tx.sastanakUcesnik.deleteMany({ where: { sastanakId: id } });
          // AFTER DELETE triger: skinutom učesniku se briše nepokupljena
          // pozivnica, da mu ne stigne mejl za sastanak sa kog je uklonjen.
          await this.fn.ucesnikInviteCleanup(
            tx,
            id,
            stari.map((u) => u.email),
          );
          if (dto.ucesnici.length) {
            await tx.sastanakUcesnik.createMany({
              data: dto.ucesnici.map((u) => ({
                sastanakId: id,
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
                prisutan: u.prisutan !== false,
                pozvan: u.pozvan !== false,
                napomena: u.napomena ?? null,
              })),
            });
            await this.fn.ucesnikInviteTrigger(
              tx,
              id,
              dto.ucesnici.map((u) => ({
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
              })),
            );
            await tx.sastanak.updateMany({
              where: { id, status: "planiran" },
              data: { pozivnicePoslateAt: new Date() },
            });
          }
          return { count: dto.ucesnici.length };
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.bulk-ucesnici",
      async (tx) => {
        await tx.sastanakUcesnik.deleteMany({ where: { sastanakId: id } });
        if (dto.ucesnici.length) {
          await tx.sastanakUcesnik.createMany({
            data: dto.ucesnici.map((u) => ({
              sastanakId: id,
              email: u.email.toLowerCase().trim(),
              label: u.label ?? null,
              prisutan: u.prisutan !== false,
              pozvan: u.pozvan !== false,
              napomena: u.napomena ?? null,
            })),
          });
          // Bar 1 umetnut red za planiran sastanak okida invite trigger → stampuj
          // pozivnicePoslateAt (isti razlog kao addUcesnik: sprečava dupli „Zakaži").
          await tx.sastanak.updateMany({
            where: { id, status: "planiran" },
            data: { pozivnicePoslateAt: new Date() },
          });
        }
        return { count: dto.ucesnici.length };
      },
    );
  }

  addUcesnik(email: string, id: string, dto: AddUcesnikDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        // `su_insert` = has_edit_role ∧ (učesnik ∨ mgmt ∨ trio).
        await this.authz.assertCanWriteSastanakChild(email, id);
        await this.fn.assertNotLocked(tx, email, id);
        const key = dto.email.toLowerCase().trim();
        await tx.sastanakUcesnik.create({
          data: {
            sastanakId: id,
            email: key,
            label: dto.label ?? null,
            prisutan: false,
            pozvan: true,
          },
        });
        // AFTER INSERT triger `sast_trg_ucesnik_invite` — bez njega novi učesnik
        // NE BI dobio pozivnicu, i to tiho.
        await this.fn.ucesnikInviteTrigger(tx, id, [
          { email: key, label: dto.label ?? null },
        ]);
        await tx.sastanak.updateMany({
          where: { id, status: "planiran" },
          data: { pozivnicePoslateAt: new Date() },
        });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      await tx.sastanakUcesnik.create({
        data: {
          sastanakId: id,
          email: dto.email.toLowerCase().trim(),
          label: dto.label ?? null,
          prisutan: false,
          pozvan: true,
        },
      });
      // Umetnut red za planiran sastanak auto-okida invite trigger → stampuj
      // `pozivnicePoslateAt` (updateMany + where status='planiran' = stamp SAMO
      // kad je triger stvarno poslao) da header prikaže „Pošalji ponovo", a ne
      // „Zakaži (pozivnice)" — inače bi ručni klik napravio dupli talas mejlova.
      await tx.sastanak.updateMany({
        where: { id, status: "planiran" },
        data: { pozivnicePoslateAt: new Date() },
      });
      return { data: { ok: true } };
    });
  }

  updateUcesnik(
    email: string,
    id: string,
    ucesnikEmail: string,
    dto: UpdateUcesnikDto,
  ) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        await this.authz.assertCanWriteSastanakChild(email, id);
        await this.fn.assertNotLocked(tx, email, id);
        const key = ucesnikEmail.toLowerCase().trim();
        const exists =
          (await tx.sastanakUcesnik.count({
            where: { sastanakId: id, email: key },
          })) > 0;
        if (!exists) throw new NotFoundException(`Učesnik ${key} ne postoji`);
        await tx.sastanakUcesnik.updateMany({
          where: { sastanakId: id, email: key },
          data: {
            ...(dto.pozvan !== undefined ? { pozvan: dto.pozvan } : {}),
            ...(dto.prisutan !== undefined ? { prisutan: dto.prisutan } : {}),
            ...(dto.pripremljen !== undefined
              ? { pripremljen: dto.pripremljen }
              : {}),
            ...(dto.priprema !== undefined
              ? { priprema: dto.priprema || null }
              : {}),
          },
        });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const key = ucesnikEmail.toLowerCase().trim();
      const exists =
        (await tx.sastanakUcesnik.count({
          where: { sastanakId: id, email: key },
        })) > 0;
      const { count } = await tx.sastanakUcesnik.updateMany({
        where: { sastanakId: id, email: key },
        data: {
          ...(dto.pozvan !== undefined ? { pozvan: dto.pozvan } : {}),
          ...(dto.prisutan !== undefined ? { prisutan: dto.prisutan } : {}),
          ...(dto.pripremljen !== undefined
            ? { pripremljen: dto.pripremljen }
            : {}),
          ...(dto.priprema !== undefined
            ? { priprema: dto.priprema || null }
            : {}),
        },
      });
      this.assertAffected(exists, count, `Učesnik ${key}`);
      return { data: { ok: true } };
    });
  }

  removeUcesnik(email: string, id: string, ucesnikEmail: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        await this.authz.assertCanWriteSastanakChild(email, id);
        await this.fn.assertNotLocked(tx, email, id);
        const key = ucesnikEmail.toLowerCase().trim();
        const { count } = await tx.sastanakUcesnik.deleteMany({
          where: { sastanakId: id, email: key },
        });
        if (count === 0) throw new NotFoundException(`Učesnik ${key} ne postoji`);
        // AFTER DELETE triger `sast_trg_ucesnik_invite_cleanup` — skinutom
        // učesniku se briše nepokupljena pozivnica da mu mejl ne stigne.
        await this.fn.ucesnikInviteCleanup(tx, id, [key]);
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const key = ucesnikEmail.toLowerCase().trim();
      const exists =
        (await tx.sastanakUcesnik.count({
          where: { sastanakId: id, email: key },
        })) > 0;
      const { count } = await tx.sastanakUcesnik.deleteMany({
        where: { sastanakId: id, email: key },
      });
      this.assertAffected(exists, count, `Učesnik ${key}`);
      return { data: { ok: true } };
    });
  }

  /** „▶ Počni" default-prisutan: svi pozvani → prisutan (idempotentno; paritet markPozvaniPrisutni). */
  markPrisutni(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        await this.authz.assertCanWriteSastanakChild(email, id);
        await this.fn.assertNotLocked(tx, email, id);
        const { count } = await tx.sastanakUcesnik.updateMany({
          where: { sastanakId: id, pozvan: true },
          data: { prisutan: true },
        });
        return { data: { updated: count } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const { count } = await tx.sastanakUcesnik.updateMany({
        where: { sastanakId: id, pozvan: true },
        data: { prisutan: true },
      });
      return { data: { updated: count } };
    });
  }

  // ---------- Tačke zapisnika (presek_aktivnosti) ----------

  async createAktivnost(email: string, id: string, dto: CreateAktivnostDto) {
    if (this.izvor.isThreeZero) {
      // `pa_insert` je znak-za-znak isti izraz kao `su_insert` (izmereno) — zato
      // isti gejt, ne treći prepis istog pravila. Gejt stoji PRE registra
      // idempotencije, da neovlašćen pokušaj ne potroši `clientEventId`.
      await this.authz.assertCanWriteSastanakChild(email, id);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-aktivnost",
        async (tx) => {
          await this.fn.assertNotLocked(tx, email, id);
          const agg = await tx.presekAktivnost.aggregate({
            where: { sastanakId: id },
            _max: { rb: true },
          });
          const next = (agg._max.rb ?? 0) + 1;
          return tx.presekAktivnost.create({
            data: {
              sastanakId: id,
              rb: next,
              redosled: next,
              naslov: dto.naslov ?? "Nova tačka",
              podRn: dto.podRn ?? null,
              sadrzajHtml: dto.sadrzajHtml ?? null,
              sadrzajText: dto.sadrzajText ?? null,
              odgovoranEmail: dto.odgovoranEmail ?? null,
              odgovoranLabel: dto.odgovoranLabel ?? null,
              odgovoranText: dto.odgovoranText ?? null,
              rok: this.toDbDate(dto.rok) ?? null,
              rokText: dto.rokText ?? null,
              status: dto.status ?? "planiran",
              napomena: dto.napomena ?? null,
              temaId: dto.temaId ?? null,
            },
          });
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-aktivnost",
      async (tx) => {
        // rb/redosled = max+1 (paritet savePresekAktivnost).
        const agg = await tx.presekAktivnost.aggregate({
          where: { sastanakId: id },
          _max: { rb: true },
        });
        const next = (agg._max.rb ?? 0) + 1;
        const row = await tx.presekAktivnost.create({
          data: {
            sastanakId: id,
            rb: next,
            redosled: next,
            naslov: dto.naslov ?? "Nova tačka",
            podRn: dto.podRn ?? null,
            sadrzajHtml: dto.sadrzajHtml ?? null,
            sadrzajText: dto.sadrzajText ?? null,
            odgovoranEmail: dto.odgovoranEmail ?? null,
            odgovoranLabel: dto.odgovoranLabel ?? null,
            odgovoranText: dto.odgovoranText ?? null,
            rok: this.toDbDate(dto.rok) ?? null,
            rokText: dto.rokText ?? null,
            // 1.0 savePresekAktivnost (sastanciDetalj.js:242) EKSPLICITNO piše 'planiran'
            // (namerno gazi DB default 'u_toku') — vidi se u zaključanom zapisnik-PDF-u.
            status: dto.status ?? "planiran",
            napomena: dto.napomena ?? null,
            temaId: dto.temaId ?? null,
          },
        });
        return row;
      },
    );
  }

  updateAktivnost(email: string, aktId: string, dto: UpdateAktivnostDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        // Ruta ne nosi `sastanakId` — čita se iz reda, jer `pa_update` scope
        // visi o RODITELJU tačke.
        const cur = await tx.presekAktivnost.findUnique({
          where: { id: aktId },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Tačka ${aktId} ne postoji`);
        await this.authz.assertCanWriteSastanakChild(email, cur.sastanakId);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        const data = await tx.presekAktivnost.update({
          where: { id: aktId },
          data: {
            ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
            ...(dto.podRn !== undefined ? { podRn: dto.podRn } : {}),
            ...(dto.sadrzajHtml !== undefined
              ? { sadrzajHtml: dto.sadrzajHtml }
              : {}),
            ...(dto.sadrzajText !== undefined
              ? { sadrzajText: dto.sadrzajText }
              : {}),
            ...(dto.odgovoranEmail !== undefined
              ? { odgovoranEmail: dto.odgovoranEmail }
              : {}),
            ...(dto.odgovoranLabel !== undefined
              ? { odgovoranLabel: dto.odgovoranLabel }
              : {}),
            ...(dto.odgovoranText !== undefined
              ? { odgovoranText: dto.odgovoranText }
              : {}),
            ...(dto.rok !== undefined ? { rok: this.toDbDate(dto.rok) } : {}),
            ...(dto.rokText !== undefined ? { rokText: dto.rokText } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
            updatedAt: new Date(),
          },
        });
        return { data };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.presekAktivnost.count({ where: { id: aktId } })) > 0;
      const { count } = await tx.presekAktivnost.updateMany({
        where: { id: aktId },
        data: {
          ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
          ...(dto.podRn !== undefined ? { podRn: dto.podRn } : {}),
          ...(dto.sadrzajHtml !== undefined
            ? { sadrzajHtml: dto.sadrzajHtml }
            : {}),
          ...(dto.sadrzajText !== undefined
            ? { sadrzajText: dto.sadrzajText }
            : {}),
          ...(dto.odgovoranEmail !== undefined
            ? { odgovoranEmail: dto.odgovoranEmail }
            : {}),
          ...(dto.odgovoranLabel !== undefined
            ? { odgovoranLabel: dto.odgovoranLabel }
            : {}),
          ...(dto.odgovoranText !== undefined
            ? { odgovoranText: dto.odgovoranText }
            : {}),
          ...(dto.rok !== undefined ? { rok: this.toDbDate(dto.rok) } : {}),
          ...(dto.rokText !== undefined ? { rokText: dto.rokText } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Tačka ${aktId}`);
      return {
        data: await tx.presekAktivnost.findUnique({ where: { id: aktId } }),
      };
    });
  }

  deleteAktivnost(email: string, aktId: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.presekAktivnost.findUnique({
          where: { id: aktId },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Tačka ${aktId} ne postoji`);
        await this.authz.assertCanWriteSastanakChild(email, cur.sastanakId);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        await tx.presekAktivnost.delete({ where: { id: aktId } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.presekAktivnost.count({ where: { id: aktId } })) > 0;
      const { count } = await tx.presekAktivnost.deleteMany({
        where: { id: aktId },
      });
      this.assertAffected(exists, count, `Tačka ${aktId}`);
      return { data: { ok: true } };
    });
  }

  /** Reorder tačaka (redosled = index; idempotentno; paritet reorderPresekAktivnosti). */
  reorderAktivnosti(email: string, id: string, dto: ReorderDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        await this.authz.assertCanWriteSastanakChild(email, id);
        await this.fn.assertNotLocked(tx, email, id);
        let updated = 0;
        for (let i = 0; i < dto.ids.length; i++) {
          const { count } = await tx.presekAktivnost.updateMany({
            where: { id: dto.ids[i], sastanakId: id },
            data: { redosled: i },
          });
          updated += count;
        }
        return { data: { updated } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      let updated = 0;
      for (let i = 0; i < dto.ids.length; i++) {
        const { count } = await tx.presekAktivnost.updateMany({
          where: { id: dto.ids[i], sastanakId: id },
          data: { redosled: i },
        });
        updated += count;
      }
      return { data: { updated } };
    });
  }

  /**
   * Most teme→zapisnik: seed tačaka iz pm_teme (dedup po tema_id; §3 BE tx).
   * Paritet 1.0 seedZapisnikFromTeme (sastanciDetalj.js:456-499): teme se sortiraju
   * `prioritet.desc.nullslast, admin_rang.asc.nullslast, created_at.asc` PRE dodele
   * rb/redosled; `pod_rn` = kod projekta teme (best-effort → null ako tema nema
   * projekat); status EKSPLICITNO 'planiran'.
   */
  async seedFromTeme(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      // 🔴 Teme se ČITAJU, pa važi read-scope `pmt_select` (blokada 4). Bez njega
      // bi seed uvukao u zapisnik i temu koju pozivalac ne sme da vidi.
      const scope = await this.authz.scopeTemeWhere(email);
      await this.authz.assertCanWriteSastanakChild(email, id);
      return this.threeZeroTx(async (tx) => {
        await this.fn.assertNotLocked(tx, email, id);
        const teme = await tx.pmTema.findMany({
          where: { AND: [{ sastanakId: id }, scope] },
          select: { id: true, naslov: true, projectId: true },
          orderBy: [
            { prioritet: "desc" },
            { adminRang: { sort: "asc", nulls: "last" } },
            { createdAt: "asc" },
          ],
        });
        if (!teme.length) return { data: { inserted: 0, skipped: 0 } };
        const existing = await tx.presekAktivnost.findMany({
          where: { sastanakId: id },
          select: { temaId: true, rb: true, redosled: true },
        });
        const used = new Set(
          existing.map((a) => a.temaId).filter((x): x is string => !!x),
        );
        const fresh = teme.filter((t) => !used.has(t.id));
        if (!fresh.length)
          return { data: { inserted: 0, skipped: teme.length } };

        // `pod_rn` = šifra predmeta teme. U sy15 je to bio `projects.project_code`
        // (uuid join); u 3.0 je `project_number` (Int join). Best-effort kao 1.0:
        // pad upita ostavlja `pod_rn` prazan, ne obara seed.
        const projIds = [
          ...new Set(
            fresh.map((t) => t.projectId).filter((x): x is number => x != null),
          ),
        ];
        const codeByProj = new Map<number, string>();
        if (projIds.length) {
          try {
            const rows = await tx.project.findMany({
              where: { id: { in: projIds } },
              select: { id: true, projectNumber: true },
            });
            for (const r of rows) {
              if (r.projectNumber) codeByProj.set(r.id, r.projectNumber);
            }
          } catch {
            /* pod_rn ostaje null — best-effort (paritet 1.0) */
          }
        }

        let rb = existing.reduce((m, a) => Math.max(m, a.rb ?? 0), 0);
        let redosled = existing.reduce(
          (m, a) => Math.max(m, a.redosled ?? 0),
          0,
        );
        const now = new Date();
        await tx.presekAktivnost.createMany({
          data: fresh.map((t) => {
            rb += 1;
            redosled += 1;
            return {
              sastanakId: id,
              naslov: t.naslov || "Tema",
              podRn: t.projectId != null ? (codeByProj.get(t.projectId) ?? null) : null,
              temaId: t.id,
              status: "planiran",
              rb,
              redosled,
              createdAt: now,
              updatedAt: now,
            };
          }),
        });
        return {
          data: { inserted: fresh.length, skipped: teme.length - fresh.length },
        };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const teme = await tx.pmTema.findMany({
        where: { sastanakId: id },
        select: { id: true, naslov: true, projekatId: true },
        orderBy: [
          { prioritet: "desc" },
          { adminRang: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });
      if (!teme.length) return { data: { inserted: 0, skipped: 0 } };
      const existing = await tx.presekAktivnost.findMany({
        where: { sastanakId: id },
        select: { temaId: true, rb: true, redosled: true },
      });
      const used = new Set(
        existing.map((a) => a.temaId).filter((x): x is string => !!x),
      );
      const fresh = teme.filter((t) => !used.has(t.id));
      if (!fresh.length) return { data: { inserted: 0, skipped: teme.length } };

      // pod_rn iz koda projekta teme (best-effort; null ako projekat/kod fali).
      const projIds = [
        ...new Set(
          fresh.map((t) => t.projekatId).filter((x): x is string => !!x),
        ),
      ];
      const codeByProj = new Map<string, string>();
      if (projIds.length) {
        try {
          const rows = await tx.$queryRaw<
            { id: string; project_code: string | null }[]
          >(
            Prisma.sql`SELECT id, project_code FROM projects WHERE id = ANY(${projIds}::uuid[])`,
          );
          for (const r of rows) {
            if (r.project_code) codeByProj.set(r.id, r.project_code);
          }
        } catch {
          /* pod_rn ostaje null — best-effort (paritet 1.0) */
        }
      }

      let rb = existing.reduce((m, a) => Math.max(m, a.rb ?? 0), 0);
      let redosled = existing.reduce((m, a) => Math.max(m, a.redosled ?? 0), 0);
      const now = new Date();
      await tx.presekAktivnost.createMany({
        data: fresh.map((t) => {
          rb += 1;
          redosled += 1;
          return {
            sastanakId: id,
            naslov: t.naslov || "Tema",
            podRn: t.projekatId ? (codeByProj.get(t.projekatId) ?? null) : null,
            temaId: t.id,
            status: "planiran",
            rb,
            redosled,
            createdAt: now,
            updatedAt: now,
          };
        }),
      });
      return {
        data: { inserted: fresh.length, skipped: teme.length - fresh.length },
      };
    });
  }

  // ---------- Odluke ----------

  async createOdluka(email: string, id: string, dto: CreateOdlukaDto) {
    if (this.izvor.isThreeZero) {
      // 🔴 `sast_odluke_write` je SAMO `has_edit_role()` — namerno ŠIRE od dece
      // sastanka (izmereno na živoj sy15). Sužavanje na učesnike bi bila
      // regresija prava koju niko nije tražio.
      await this.authz.assertCanWriteOdluka(email);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-odluka",
        async (tx) => {
          await this.fn.assertNotLocked(tx, email, id);
          return tx.sastanakOdluka.create({
            data: {
              sastanakId: id,
              rb: dto.rb ?? null,
              naslov: dto.naslov,
              opis: dto.opis ?? null,
              odlucioEmail: dto.odlucioEmail ?? null,
              odlucioLabel: dto.odlucioLabel ?? null,
              odlukaDatum: this.toDbDate(dto.odlukaDatum) ?? null,
              uticaj: dto.uticaj ?? null,
              vezaTemaId: dto.vezaTemaId ?? null,
              vezaAkcijaId: dto.vezaAkcijaId ?? null,
              status: dto.status ?? "na_snazi",
            },
          });
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-odluka",
      async (tx) => {
        const row = await tx.sastanakOdluka.create({
          data: {
            sastanakId: id,
            rb: dto.rb ?? null,
            naslov: dto.naslov,
            opis: dto.opis ?? null,
            odlucioEmail: dto.odlucioEmail ?? null,
            odlucioLabel: dto.odlucioLabel ?? null,
            odlukaDatum: this.toDbDate(dto.odlukaDatum) ?? null,
            uticaj: dto.uticaj ?? null,
            vezaTemaId: dto.vezaTemaId ?? null,
            vezaAkcijaId: dto.vezaAkcijaId ?? null,
            status: dto.status ?? "na_snazi",
          },
        });
        return row;
      },
    );
  }

  updateOdluka(email: string, odlId: string, dto: UpdateOdlukaDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.sastanakOdluka.findUnique({
          where: { id: odlId },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Odluka ${odlId} ne postoji`);
        await this.authz.assertCanWriteOdluka(email);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        const data = await tx.sastanakOdluka.update({
          where: { id: odlId },
          data: {
            ...(dto.rb !== undefined ? { rb: dto.rb } : {}),
            ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
            ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
            ...(dto.odlucioEmail !== undefined
              ? { odlucioEmail: dto.odlucioEmail }
              : {}),
            ...(dto.odlucioLabel !== undefined
              ? { odlucioLabel: dto.odlucioLabel }
              : {}),
            ...(dto.odlukaDatum !== undefined
              ? { odlukaDatum: this.toDbDate(dto.odlukaDatum) }
              : {}),
            ...(dto.uticaj !== undefined ? { uticaj: dto.uticaj } : {}),
            ...(dto.vezaTemaId !== undefined
              ? { vezaTemaId: dto.vezaTemaId }
              : {}),
            ...(dto.vezaAkcijaId !== undefined
              ? { vezaAkcijaId: dto.vezaAkcijaId }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            updatedAt: new Date(),
          },
        });
        return { data };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.sastanakOdluka.count({ where: { id: odlId } })) > 0;
      const { count } = await tx.sastanakOdluka.updateMany({
        where: { id: odlId },
        data: {
          ...(dto.rb !== undefined ? { rb: dto.rb } : {}),
          ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
          ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
          ...(dto.odlucioEmail !== undefined
            ? { odlucioEmail: dto.odlucioEmail }
            : {}),
          ...(dto.odlucioLabel !== undefined
            ? { odlucioLabel: dto.odlucioLabel }
            : {}),
          ...(dto.odlukaDatum !== undefined
            ? { odlukaDatum: this.toDbDate(dto.odlukaDatum) }
            : {}),
          ...(dto.uticaj !== undefined ? { uticaj: dto.uticaj } : {}),
          ...(dto.vezaTemaId !== undefined
            ? { vezaTemaId: dto.vezaTemaId }
            : {}),
          ...(dto.vezaAkcijaId !== undefined
            ? { vezaAkcijaId: dto.vezaAkcijaId }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Odluka ${odlId}`);
      return {
        data: await tx.sastanakOdluka.findUnique({ where: { id: odlId } }),
      };
    });
  }

  deleteOdluka(email: string, odlId: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.sastanakOdluka.findUnique({
          where: { id: odlId },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Odluka ${odlId} ne postoji`);
        await this.authz.assertCanWriteOdluka(email);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        await tx.sastanakOdluka.delete({ where: { id: odlId } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.sastanakOdluka.count({ where: { id: odlId } })) > 0;
      const { count } = await tx.sastanakOdluka.deleteMany({
        where: { id: odlId },
      });
      this.assertAffected(exists, count, `Odluka ${odlId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Akcioni plan ----------

  async createAkcija(email: string, dto: CreateAkcijaDto) {
    if (this.izvor.isThreeZero) {
      const projekat = (await this.predmet.razresi(dto.projekatId)) ?? null;
      // `ap_insert` = has_edit_role ∧ (učesnik ∨ mgmt ∨ trio); akcija BEZ
      // sastanka prolazi zato što goli `mgmt` apsorbuje granu `sastanak_id IS
      // NULL` (v. odeljak WRITE-SCOPE u authz servisu).
      await this.authz.assertCanWriteSastanakChild(email, dto.sastanakId);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-akcija",
        async (tx) => {
          await this.fn.assertNotLocked(tx, email, dto.sastanakId);
          const row = await tx.akcionaTacka.create({
            data: {
              sastanakId: dto.sastanakId ?? null,
              temaId: dto.temaId ?? null,
              projectId: projekat,
              rb: dto.rb ?? null,
              naslov: dto.naslov,
              opis: dto.opis ?? null,
              odgovoranEmail: dto.odgovoranEmail ?? null,
              odgovoranLabel: dto.odgovoranLabel ?? null,
              odgovoranText: dto.odgovoranText ?? null,
              rok: this.toDbDate(dto.rok) ?? null,
              rokText: dto.rokText ?? null,
              status: dto.status ?? "otvoren",
              prioritet: dto.prioritet ?? 2,
              createdByEmail: email,
            },
          });
          // NAMERNO BEZ istorije: `akcioni_plan_istorija_trg` je AFTER **UPDATE**,
          // ne INSERT — nova akcija ne ostavlja trag ni u sy15.
          // Isto tako BEZ „dodeljena ti je akcija" mejla: `sast_trg_akcija_new`
          // je u sy15 MRTAV (nijedan triger je ne poziva od 23.06.2026) i njegovo
          // oživljavanje je odluka o proizvodu, ne o seobi — runbook §7b.
          return this.predmetOut(row);
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-akcija",
      async (tx) => {
        const row = await tx.akcioniPlan.create({
          data: {
            sastanakId: dto.sastanakId ?? null,
            temaId: dto.temaId ?? null,
            projekatId: predmetZaSy15(dto.projekatId) ?? null,
            rb: dto.rb ?? null,
            naslov: dto.naslov,
            opis: dto.opis ?? null,
            odgovoranEmail: dto.odgovoranEmail ?? null,
            odgovoranLabel: dto.odgovoranLabel ?? null,
            odgovoranText: dto.odgovoranText ?? null,
            rok: this.toDbDate(dto.rok) ?? null,
            rokText: dto.rokText ?? null,
            status: dto.status ?? "otvoren",
            prioritet: dto.prioritet ?? 2,
            createdByEmail: email,
          },
        });
        return row;
      },
    );
  }

  /** Inline patch (paritet patchAkcija): zavrsen → snapshot zatvoren_*; reopen → očisti. */
  async patchAkcija(email: string, id: string, dto: PatchAkcijaDto) {
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresi(dto.projekatId);
      return this.threeZeroTx(async (tx) => {
        const stara = await tx.akcionaTacka.findUnique({ where: { id } });
        if (!stara) throw new NotFoundException(`Akcija ${id} ne postoji`);
        // `ap_update` proverava OBE strane: USING nad starim redom, WITH CHECK
        // nad novim — premeštanje akcije na drugi sastanak mora proći oba.
        await this.authz.assertCanWriteSastanakChild(email, stara.sastanakId);
        if (dto.sastanakId !== undefined && dto.sastanakId !== stara.sastanakId) {
          await this.authz.assertCanWriteSastanakChild(email, dto.sastanakId);
          await this.fn.assertNotLocked(tx, email, dto.sastanakId);
        }
        await this.fn.assertNotLocked(tx, email, stara.sastanakId);
        const data: PrismaTriNula.AkcionaTackaUpdateInput = {
          ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
          ...(dto.sastanakId !== undefined
            ? { sastanakId: dto.sastanakId }
            : {}),
          ...(projekat !== undefined ? { projectId: projekat } : {}),
          ...(dto.rb !== undefined ? { rb: dto.rb } : {}),
          ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
          ...(dto.odgovoranEmail !== undefined
            ? { odgovoranEmail: dto.odgovoranEmail }
            : {}),
          ...(dto.odgovoranLabel !== undefined
            ? { odgovoranLabel: dto.odgovoranLabel }
            : {}),
          ...(dto.odgovoranText !== undefined
            ? { odgovoranText: dto.odgovoranText }
            : {}),
          ...(dto.rok !== undefined ? { rok: this.toDbDate(dto.rok) } : {}),
          ...(dto.rokText !== undefined ? { rokText: dto.rokText } : {}),
          ...(dto.prioritet !== undefined ? { prioritet: dto.prioritet } : {}),
          updatedAt: new Date(),
        };
        if (dto.status !== undefined) {
          data.status = dto.status;
          if (dto.status === "zavrsen") {
            data.zatvorenAt = new Date();
            data.zatvorenByEmail = email;
            if (dto.zatvorenNapomena !== undefined)
              data.zatvorenNapomena = dto.zatvorenNapomena || null;
          } else {
            data.zatvorenAt = null;
            data.zatvorenByEmail = null;
          }
        }
        const nova = await tx.akcionaTacka.update({ where: { id }, data });
        // 🔴 OBAVEZNO: `akcioni_plan_istorija_trg` (AFTER UPDATE) je u sy15 pisao
        // revizioni trag. Migracija taj triger namerno ne prenosi, pa bez ovog
        // poziva izmene akcija pod `3.0` ne bi ostavljale NIKAKAV trag — a to je
        // najveća tabela domena (689 redova naspram 98 akcija).
        await this.fn.akcijaIstorija(
          tx,
          { ...stara, projekatId: stara.projectId },
          { ...nova, projekatId: nova.projectId },
          email,
        );
        return { data: this.predmetOut(nova) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.akcioniPlan.count({ where: { id } })) > 0;
      const data: Prisma.AkcioniPlanUpdateInput = {
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.sastanakId !== undefined ? { sastanakId: dto.sastanakId } : {}),
        ...(dto.projekatId !== undefined
          ? { projekatId: predmetZaSy15(dto.projekatId) }
          : {}),
        ...(dto.rb !== undefined ? { rb: dto.rb } : {}),
        ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
        ...(dto.odgovoranEmail !== undefined
          ? { odgovoranEmail: dto.odgovoranEmail }
          : {}),
        ...(dto.odgovoranLabel !== undefined
          ? { odgovoranLabel: dto.odgovoranLabel }
          : {}),
        ...(dto.odgovoranText !== undefined
          ? { odgovoranText: dto.odgovoranText }
          : {}),
        ...(dto.rok !== undefined ? { rok: this.toDbDate(dto.rok) } : {}),
        ...(dto.rokText !== undefined ? { rokText: dto.rokText } : {}),
        ...(dto.prioritet !== undefined ? { prioritet: dto.prioritet } : {}),
        updatedAt: new Date(),
      };
      if (dto.status !== undefined) {
        data.status = dto.status;
        if (dto.status === "zavrsen") {
          data.zatvorenAt = new Date();
          data.zatvorenByEmail = email;
          if (dto.zatvorenNapomena !== undefined)
            data.zatvorenNapomena = dto.zatvorenNapomena || null;
        } else {
          data.zatvorenAt = null;
          data.zatvorenByEmail = null;
        }
      }
      const { count } = await tx.akcioniPlan.updateMany({
        where: { id },
        data,
      });
      this.assertAffected(exists, count, `Akcija ${id}`);
      return { data: await tx.akcioniPlan.findUnique({ where: { id } }) };
    });
  }

  deleteAkcija(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.akcionaTacka.findUnique({
          where: { id },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Akcija ${id} ne postoji`);
        await this.authz.assertCanWriteSastanakChild(email, cur.sastanakId);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        // Istorija ide sa akcijom (FK `ON DELETE CASCADE`) — kao u sy15.
        await tx.akcionaTacka.delete({ where: { id } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.akcioniPlan.count({ where: { id } })) > 0;
      const { count } = await tx.akcioniPlan.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Akcija ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Bulk status (paritet updateAkcijeStatusBulk — vraća STVARNO izmenjen broj, RLS može odbiti deo). */
  bulkStatus(email: string, dto: BulkStatusDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        // 🔴 PARITET KOJI SE MORA ZADRŽATI: u sy15 je RLS filtrirao `updateMany`
        // po redu, pa je odgovor nosio STVARNO izmenjen broj — deo skupa je
        // mogao tiho da ostane netaknut, bez greške. Pod `3.0` isto: red koji
        // gejt ne pusti se PRESKAČE (ne obara ceo poziv), a `updated` je broj
        // onih koji su prošli. Bacanje 403 na prvi tuđi red bilo bi promena
        // ponašanja masovne radnje.
        const stare = await tx.akcionaTacka.findMany({
          where: { id: { in: dto.ids } },
        });
        let updated = 0;
        for (const stara of stare) {
          if (
            !(await this.authz.canWriteSastanakChild(email, stara.sastanakId))
          ) {
            continue;
          }
          // Guard zaključanog sastanka je u sy15 dizao 23514 i obarao CEO
          // `updateMany` (BEFORE UPDATE triger, jedna izjava) — zato ovde NE
          // preskačemo nego puštamo grešku.
          await this.fn.assertNotLocked(tx, email, stara.sastanakId);
          const data: PrismaTriNula.AkcionaTackaUpdateInput = {
            status: dto.status,
            updatedAt: new Date(),
          };
          if (dto.status === "zavrsen") {
            data.zatvorenAt = new Date();
            data.zatvorenByEmail = email;
          }
          const nova = await tx.akcionaTacka.update({
            where: { id: stara.id },
            data,
          });
          // Triger je u sy15 okidao PO REDU — isto i ovde.
          await this.fn.akcijaIstorija(
            tx,
            { ...stara, projekatId: stara.projectId },
            { ...nova, projekatId: nova.projectId },
            email,
          );
          updated += 1;
        }
        return { data: { updated } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const data: Prisma.AkcioniPlanUpdateManyMutationInput = {
        status: dto.status,
        updatedAt: new Date(),
      };
      if (dto.status === "zavrsen") {
        data.zatvorenAt = new Date();
        data.zatvorenByEmail = email;
      }
      const { count } = await tx.akcioniPlan.updateMany({
        where: { id: { in: dto.ids } },
        data,
      });
      return { data: { updated: count } };
    });
  }

  // ---------- PM teme ----------

  async createTema(email: string, dto: CreateTemaDto) {
    if (this.izvor.isThreeZero) {
      const projekat = (await this.predmet.razresi(dto.projekatId)) ?? null;
      const status = dto.status ?? "predlog";
      // 🔴 `pmt_insert` ∨ `pm_teme_draft_insert` — tema BEZ sastanka traži
      // rukovodstvo, OSIM ako je draft (tada je dosta edit rola). Dve politike
      // se sabiraju; prepis samo stroža bi ubio „predloži temu".
      await this.authz.assertCanInsertTema(email, status, dto.sastanakId ?? null);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-tema",
        async (tx) => {
          await this.fn.assertNotLocked(tx, email, dto.sastanakId);
          const row = await tx.pmTema.create({
            data: {
              vrsta: dto.vrsta ?? "tema",
              oblast: dto.oblast ?? "opste",
              naslov: dto.naslov,
              opis: dto.opis ?? null,
              projectId: projekat,
              status,
              prioritet: dto.prioritet ?? 2,
              hitno: dto.hitno === true,
              zaRazmatranje: dto.zaRazmatranje === true,
              sastanakId: dto.sastanakId ?? null,
              predlozioEmail: email,
              predlozioLabel: email,
            },
          });
          return this.predmetOut(row);
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-tema",
      async (tx) => {
        const row = await tx.pmTema.create({
          data: {
            vrsta: dto.vrsta ?? "tema",
            oblast: dto.oblast ?? "opste",
            naslov: dto.naslov,
            opis: dto.opis ?? null,
            projekatId: predmetZaSy15(dto.projekatId) ?? null,
            status: dto.status ?? "predlog",
            prioritet: dto.prioritet ?? 2,
            hitno: dto.hitno === true,
            zaRazmatranje: dto.zaRazmatranje === true,
            sastanakId: dto.sastanakId ?? null,
            predlozioEmail: email,
            predlozioLabel: email,
          },
        });
        return row;
      },
    );
  }

  async updateTema(email: string, id: string, dto: UpdateTemaDto) {
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresi(dto.projekatId);
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.pmTema.findUnique({ where: { id } });
        if (!cur) throw new NotFoundException(`Tema ${id} ne postoji`);
        const noviStatus = dto.status ?? cur.status;
        const noviSastanak =
          dto.sastanakId !== undefined ? dto.sastanakId : cur.sastanakId;
        // Guard-triger `sast_trg_pm_teme_draft_status_guard`: draft sme SAMO u
        // usvojeno/odbijeno. Ide PRE gejta prava — isti redosled kao BEFORE
        // UPDATE triger u bazi.
        this.fn.assertDraftStatusPrelaz(cur.status, noviStatus);
        await this.authz.assertCanUpdateTema(
          email,
          { status: cur.status, sastanakId: cur.sastanakId },
          { status: noviStatus, sastanakId: noviSastanak },
        );
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        if (noviSastanak && noviSastanak !== cur.sastanakId) {
          await this.fn.assertNotLocked(tx, email, noviSastanak);
        }
        const data: PrismaTriNula.PmTemaUpdateInput = {
          ...(dto.vrsta !== undefined ? { vrsta: dto.vrsta } : {}),
          ...(dto.oblast !== undefined ? { oblast: dto.oblast } : {}),
          ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
          ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
          ...(projekat !== undefined ? { projectId: projekat } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.prioritet !== undefined ? { prioritet: dto.prioritet } : {}),
          ...(dto.hitno !== undefined ? { hitno: dto.hitno } : {}),
          ...(dto.zaRazmatranje !== undefined
            ? { zaRazmatranje: dto.zaRazmatranje }
            : {}),
          ...(dto.sastanakId !== undefined
            ? { sastanakId: dto.sastanakId }
            : {}),
          updatedAt: new Date(),
        };
        // Rešeno stanje → snapshot resio_*, ali ČUVA postojećeg rešavača (1.0:
        // B menja naslov i ne preotima ko je A rešio).
        if (
          dto.status &&
          ["usvojeno", "odbijeno", "odlozeno", "zatvoreno"].includes(dto.status)
        ) {
          data.resioEmail = cur.resioEmail || email;
          data.resioLabel = cur.resioLabel || cur.resioEmail || email;
          data.resioAt = cur.resioAt ?? new Date();
          data.resioNapomena =
            dto.resioNapomena !== undefined
              ? dto.resioNapomena || null
              : (cur.resioNapomena ?? null);
        }
        const row = await tx.pmTema.update({ where: { id }, data });
        return { data: this.predmetOut(row) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      // Čitamo postojeći red (za exists + očuvanje resio_* atribucije — B menja
      // samo naslov, ne sme da preotme ko je A rešio; paritet buildTemaPayload).
      const cur = await tx.pmTema.findUnique({
        where: { id },
        select: {
          resioEmail: true,
          resioLabel: true,
          resioAt: true,
          resioNapomena: true,
        },
      });
      const exists = !!cur;
      const data: Prisma.PmTemaUpdateInput = {
        ...(dto.vrsta !== undefined ? { vrsta: dto.vrsta } : {}),
        ...(dto.oblast !== undefined ? { oblast: dto.oblast } : {}),
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
        ...(dto.projekatId !== undefined
          ? { projekatId: predmetZaSy15(dto.projekatId) }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.prioritet !== undefined ? { prioritet: dto.prioritet } : {}),
        ...(dto.hitno !== undefined ? { hitno: dto.hitno } : {}),
        ...(dto.zaRazmatranje !== undefined
          ? { zaRazmatranje: dto.zaRazmatranje }
          : {}),
        ...(dto.sastanakId !== undefined ? { sastanakId: dto.sastanakId } : {}),
        updatedAt: new Date(),
      };
      // Rešeno stanje → snapshot resio_* ali ČUVA postojećeg rešavača (1.0:
      // resio_email = existing || cu.email; resio_at = existing || now).
      if (
        dto.status &&
        ["usvojeno", "odbijeno", "odlozeno", "zatvoreno"].includes(dto.status)
      ) {
        data.resioEmail = cur?.resioEmail || email;
        data.resioLabel = cur?.resioLabel || cur?.resioEmail || email;
        data.resioAt = cur?.resioAt ?? new Date();
        data.resioNapomena =
          dto.resioNapomena !== undefined
            ? dto.resioNapomena || null
            : (cur?.resioNapomena ?? null);
      }
      const { count } = await tx.pmTema.updateMany({ where: { id }, data });
      this.assertAffected(exists, count, `Tema ${id}`);
      return { data: await tx.pmTema.findUnique({ where: { id } }) };
    });
  }

  deleteTema(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.pmTema.findUnique({
          where: { id },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Tema ${id} ne postoji`);
        await this.authz.assertCanDeleteTema(email, cur.sastanakId);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        await tx.pmTema.delete({ where: { id } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.pmTema.count({ where: { id } })) > 0;
      const { count } = await tx.pmTema.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Tema ${id}`);
      return { data: { ok: true } };
    });
  }

  setTemaHitno(email: string, id: string, dto: TemaHitnoDto) {
    return this.patchTema(email, id, { hitno: dto.hitno }, `Tema ${id}`);
  }

  setTemaRazmatranje(email: string, id: string, dto: TemaRazmatranjeDto) {
    return this.patchTema(
      email,
      id,
      {
        zaRazmatranje: dto.zaRazmatranje,
        adminRangByEmail: email,
        adminRangAt: new Date(),
      },
      `Tema ${id}`,
    );
  }

  setTemaAdminRang(email: string, id: string, dto: TemaAdminRangDto) {
    return this.patchTema(
      email,
      id,
      {
        adminRang: dto.rang ?? null,
        adminRangByEmail: email,
        adminRangAt: new Date(),
      },
      `Tema ${id}`,
    );
  }

  /** Reorder ranga po projektu (admin — FE gate; DB = has_edit_role). */
  reorderRang(email: string, dto: ReorderRangDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const ts = new Date();
        const teme = await tx.pmTema.findMany({
          where: { id: { in: dto.items.map((i) => i.id) } },
          select: { id: true, sastanakId: true },
        });
        const poId = new Map(teme.map((t) => [t.id, t.sastanakId]));
        let updated = 0;
        for (const it of dto.items) {
          if (!poId.has(it.id)) continue; // nepostojeća tema — kao 0 pogodaka u sy15
          const sastanakId = poId.get(it.id) ?? null;
          // Isti paritet kao `bulkStatus`: red koji gejt ne pusti se PRESKAČE
          // (RLS `updateMany` u sy15 je radio isto), pa `updated` nosi stvarni broj.
          if (!(await this.authz.canWriteTema(email, sastanakId))) continue;
          await this.fn.assertNotLocked(tx, email, sastanakId);
          await tx.pmTema.update({
            where: { id: it.id },
            data: {
              adminRang: it.rang ?? null,
              adminRangByEmail: email,
              adminRangAt: ts,
              updatedAt: ts,
            },
          });
          updated += 1;
        }
        return { data: { updated } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const ts = new Date();
      let updated = 0;
      for (const it of dto.items) {
        const { count } = await tx.pmTema.updateMany({
          where: { id: it.id },
          data: {
            adminRang: it.rang ?? null,
            adminRangByEmail: email,
            adminRangAt: ts,
            updatedAt: ts,
          },
        });
        updated += count;
      }
      return { data: { updated } };
    });
  }

  dodeliTemu(email: string, id: string, dto: TemaDodeliDto) {
    return this.patchTema(
      email,
      id,
      {
        status: "usvojeno",
        sastanakId: dto.sastanakId,
        resioEmail: email,
        resioLabel: email,
        resioAt: new Date(),
      },
      `Tema ${id}`,
    );
  }

  async createDraftTema(email: string, dto: CreateDraftTemaDto) {
    if (this.izvor.isThreeZero) {
      // Predmet je OBAVEZAN za draft temu, pa `razresi` ne sme vratiti null.
      const projekat = await this.predmet.razresi(dto.projektId);
      if (projekat == null) {
        throw new UnprocessableEntityException(
          "Draft tema mora imati predmet (projektId).",
        );
      }
      // `pm_teme_draft_insert`: draft ∧ bez sastanka ∧ has_edit_role().
      await this.authz.assertCanInsertTema(email, "draft", null);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-draft-tema",
        async (tx) => {
          const row = await tx.pmTema.create({
            data: {
              projectId: projekat,
              sastanakId: null,
              status: "draft",
              vrsta: dto.vrsta ?? "tema",
              oblast: dto.oblast ?? "opste",
              naslov: dto.naslov.trim(),
              opis: dto.opis ?? null,
              prioritet: dto.prioritet ?? 2,
              hitno: dto.hitno === true,
              predlozioEmail: email,
              predlozioLabel: dto.predlozioLabel ?? email,
            },
          });
          return this.predmetOut(row);
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-draft-tema",
      async (tx) => {
        const row = await tx.pmTema.create({
          data: {
            projekatId: predmetZaSy15(dto.projektId) ?? null,
            sastanakId: null,
            status: "draft",
            vrsta: dto.vrsta ?? "tema",
            oblast: dto.oblast ?? "opste",
            naslov: dto.naslov.trim(),
            opis: dto.opis ?? null,
            prioritet: dto.prioritet ?? 2,
            hitno: dto.hitno === true,
            predlozioEmail: email,
            predlozioLabel: dto.predlozioLabel ?? email,
          },
        });
        return row;
      },
    );
  }

  async draftTeme(email: string, projektId: string) {
    if (this.izvor.isThreeZero) {
      const projekat = await this.predmet.razresi(projektId);
      // 🔴 Read-scope `pmt_select` — bez njega bi lista drafta po predmetu
      // pokazala i tuđe predloge (četvrta grana politike pušta SVE draftove bez
      // sastanka SAMO onome sa edit rolom).
      const scope = await this.authz.scopeTemeWhere(email);
      return this.threeZeroRead(async (tx) => ({
        data: await tx.pmTema.findMany({
          where: {
            AND: [
              { projectId: projekat, status: "draft", sastanakId: null },
              scope,
            ],
          },
          orderBy: [{ createdAt: "asc" }],
        }),
      })).then((r) => ({ data: this.predmetOutMany(r.data) }));
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pmTema.findMany({
        where: {
          projekatId: predmetZaSy15(projektId) ?? undefined,
          status: "draft",
          sastanakId: null,
        },
        orderBy: [{ createdAt: "asc" }],
      });
      return { data };
    });
  }

  /** Pregled draft teme (usvoji/odbij) — WHERE status=draft (paritet pregledajDraftTemu). */
  draftReview(email: string, id: string, dto: DraftReviewDto) {
    const status =
      dto.odluka === "aktivna"
        ? "usvojeno"
        : dto.odluka === "odbijena"
          ? "odbijeno"
          : dto.odluka;
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        // `pm_teme_draft_review` USING traži da STARI red bude draft — zato
        // filter na status ostaje deo upita, kao u sy15 (`WHERE status='draft'`).
        const cur = await tx.pmTema.findUnique({
          where: { id },
          select: { status: true, sastanakId: true },
        });
        if (!cur || cur.status !== "draft") {
          throw new NotFoundException(`Draft tema ${id} ne postoji`);
        }
        this.fn.assertDraftStatusPrelaz(cur.status, status);
        await this.authz.assertCanUpdateTema(
          email,
          { status: cur.status, sastanakId: cur.sastanakId },
          { status, sastanakId: cur.sastanakId },
        );
        const row = await tx.pmTema.update({
          where: { id },
          data: {
            status,
            resioEmail: email,
            resioLabel: email,
            resioAt: new Date(),
            resioNapomena: dto.napomena ?? null,
            updatedAt: new Date(),
          },
        });
        return { data: this.predmetOut(row) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.pmTema.count({ where: { id, status: "draft" } })) > 0;
      const { count } = await tx.pmTema.updateMany({
        where: { id, status: "draft" },
        data: {
          status,
          resioEmail: email,
          resioLabel: email,
          resioAt: new Date(),
          resioNapomena: dto.napomena ?? null,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Draft tema ${id}`);
      return { data: await tx.pmTema.findUnique({ where: { id } }) };
    });
  }

  draftUvedi(email: string, id: string, dto: DraftUvediDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.pmTema.findUnique({
          where: { id },
          select: { status: true, sastanakId: true },
        });
        if (!cur || cur.status !== "usvojeno") {
          throw new NotFoundException(`Usvojena tema ${id} ne postoji`);
        }
        // Tema se VEZUJE za sastanak — `pmt_update` traži pravo i nad starim
        // (bez sastanka → mgmt) i nad novim stanjem (učesnik/trio ciljnog).
        await this.authz.assertCanUpdateTema(
          email,
          { status: cur.status, sastanakId: cur.sastanakId },
          { status: cur.status, sastanakId: dto.sastanakId },
        );
        await this.fn.assertNotLocked(tx, email, dto.sastanakId);
        const row = await tx.pmTema.update({
          where: { id },
          data: { sastanakId: dto.sastanakId, updatedAt: new Date() },
        });
        return { data: this.predmetOut(row) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.pmTema.count({ where: { id, status: "usvojeno" } })) > 0;
      const { count } = await tx.pmTema.updateMany({
        where: { id, status: "usvojeno" },
        data: { sastanakId: dto.sastanakId, updatedAt: new Date() },
      });
      this.assertAffected(exists, count, `Usvojena tema ${id}`);
      return { data: await tx.pmTema.findUnique({ where: { id } }) };
    });
  }

  /**
   * Zajednički PATCH jedne teme (flag/rang/dodela) — pod `sy15` RLS presuđuje
   * red, pod `3.0` `pmt_update` prepis.
   *
   * ⚠️ Poziva ga pet ruta (`hitno`, `za-razmatranje`, `admin-rang`, `dodeli`), pa
   * je gejt OVDE — jedno mesto za sve njih. `dodeli` menja i `sastanak_id`, zato
   * `noviSastanak` može doći iz `data`.
   */
  private patchTema(
    email: string,
    id: string,
    data: Prisma.PmTemaUpdateManyMutationInput,
    what: string,
  ) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.pmTema.findUnique({
          where: { id },
          select: { status: true, sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`${what} ne postoji`);
        // `UncheckedUpdateInput`, ne `UpdateManyMutationInput`: u 3.0 je
        // `sastanakId` FK relacije, pa ga „checked" varijanta ne nosi — a
        // `dodeliTemu` upravo njega postavlja. (U sy15 šemi nema relacija, pa je
        // tamo to bio običan skalar.) Nijedan pozivalac ne dira `projekatId`,
        // zato je zajednički oblik dovoljan.
        const d = data as PrismaTriNula.PmTemaUncheckedUpdateInput;
        const noviStatus =
          typeof d.status === "string" ? d.status : cur.status;
        const noviSastanak =
          typeof d.sastanakId === "string" ? d.sastanakId : cur.sastanakId;
        this.fn.assertDraftStatusPrelaz(cur.status, noviStatus);
        await this.authz.assertCanUpdateTema(
          email,
          { status: cur.status, sastanakId: cur.sastanakId },
          { status: noviStatus, sastanakId: noviSastanak },
        );
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        if (noviSastanak && noviSastanak !== cur.sastanakId) {
          await this.fn.assertNotLocked(tx, email, noviSastanak);
        }
        const row = await tx.pmTema.update({
          where: { id },
          data: { ...d, updatedAt: new Date() },
        });
        return { data: this.predmetOut(row) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.pmTema.count({ where: { id } })) > 0;
      const { count } = await tx.pmTema.updateMany({
        where: { id },
        data: { ...data, updatedAt: new Date() },
      });
      this.assertAffected(exists, count, what);
      return { data: await tx.pmTema.findUnique({ where: { id } }) };
    });
  }

  // ---------- Šabloni ----------

  async createTemplate(email: string, dto: CreateTemplateDto) {
    if (this.izvor.isThreeZero) {
      // `sast_tpl_write` i `sast_tu_write` (oba ALL) = samo `has_edit_role()`.
      await this.authz.assertCanWriteTemplate(email);
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.create-template",
        async (tx) => {
          const tpl = await tx.sastanciTemplate.create({
            data: {
              naziv: dto.naziv,
              tip: dto.tip ?? "sedmicni",
              mesto: dto.mesto ?? null,
              vodioEmail: dto.vodioEmail ?? null,
              zapisnicarEmail: dto.zapisnicarEmail ?? null,
              cadence: dto.cadence ?? "none",
              cadenceDow: dto.cadenceDow ?? null,
              cadenceDom: dto.cadenceDom ?? null,
              vreme: this.toDbTime(dto.vreme) ?? null,
              napomena: dto.napomena ?? null,
              isActive: dto.isActive !== false,
              createdByEmail: email,
            },
          });
          if (dto.ucesnici?.length) {
            await tx.sastanciTemplateUcesnik.createMany({
              data: dto.ucesnici.map((u) => ({
                templateId: tpl.id,
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
              })),
            });
          }
          return tpl;
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-template",
      async (tx) => {
        const tpl = await tx.sastanciTemplate.create({
          data: {
            naziv: dto.naziv,
            tip: dto.tip ?? "sedmicni",
            mesto: dto.mesto ?? null,
            vodioEmail: dto.vodioEmail ?? null,
            zapisnicarEmail: dto.zapisnicarEmail ?? null,
            cadence: dto.cadence ?? "none",
            cadenceDow: dto.cadenceDow ?? null,
            cadenceDom: dto.cadenceDom ?? null,
            vreme: this.toDbTime(dto.vreme) ?? null,
            napomena: dto.napomena ?? null,
            isActive: dto.isActive !== false,
            createdByEmail: email,
          },
        });
        if (dto.ucesnici?.length) {
          await tx.sastanciTemplateUcesnik.createMany({
            data: dto.ucesnici.map((u) => ({
              templateId: tpl.id,
              email: u.email.toLowerCase().trim(),
              label: u.label ?? null,
            })),
          });
        }
        return tpl;
      },
    );
  }

  updateTemplate(email: string, id: string, dto: UpdateTemplateDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const exists =
          (await tx.sastanciTemplate.count({ where: { id } })) > 0;
        if (!exists) throw new NotFoundException(`Šablon ${id} ne postoji`);
        await this.authz.assertCanWriteTemplate(email);
        await tx.sastanciTemplate.update({
          where: { id },
          data: {
            ...(dto.naziv !== undefined ? { naziv: dto.naziv } : {}),
            ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
            ...(dto.mesto !== undefined ? { mesto: dto.mesto } : {}),
            ...(dto.vodioEmail !== undefined
              ? { vodioEmail: dto.vodioEmail }
              : {}),
            ...(dto.zapisnicarEmail !== undefined
              ? { zapisnicarEmail: dto.zapisnicarEmail }
              : {}),
            ...(dto.cadence !== undefined ? { cadence: dto.cadence } : {}),
            ...(dto.cadenceDow !== undefined
              ? { cadenceDow: dto.cadenceDow }
              : {}),
            ...(dto.cadenceDom !== undefined
              ? { cadenceDom: dto.cadenceDom }
              : {}),
            ...(dto.vreme !== undefined
              ? { vreme: this.toDbTime(dto.vreme) }
              : {}),
            ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            updatedAt: new Date(),
          },
        });
        if (dto.ucesnici !== undefined) {
          await tx.sastanciTemplateUcesnik.deleteMany({
            where: { templateId: id },
          });
          if (dto.ucesnici.length) {
            await tx.sastanciTemplateUcesnik.createMany({
              data: dto.ucesnici.map((u) => ({
                templateId: id,
                email: u.email.toLowerCase().trim(),
                label: u.label ?? null,
              })),
            });
          }
        }
        return {
          data: await tx.sastanciTemplate.findUnique({ where: { id } }),
        };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanciTemplate.count({ where: { id } })) > 0;
      const { count } = await tx.sastanciTemplate.updateMany({
        where: { id },
        data: {
          ...(dto.naziv !== undefined ? { naziv: dto.naziv } : {}),
          ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
          ...(dto.mesto !== undefined ? { mesto: dto.mesto } : {}),
          ...(dto.vodioEmail !== undefined
            ? { vodioEmail: dto.vodioEmail }
            : {}),
          ...(dto.zapisnicarEmail !== undefined
            ? { zapisnicarEmail: dto.zapisnicarEmail }
            : {}),
          ...(dto.cadence !== undefined ? { cadence: dto.cadence } : {}),
          ...(dto.cadenceDow !== undefined
            ? { cadenceDow: dto.cadenceDow }
            : {}),
          ...(dto.cadenceDom !== undefined
            ? { cadenceDom: dto.cadenceDom }
            : {}),
          ...(dto.vreme !== undefined
            ? { vreme: this.toDbTime(dto.vreme) }
            : {}),
          ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Šablon ${id}`);
      if (dto.ucesnici !== undefined) {
        await tx.sastanciTemplateUcesnik.deleteMany({
          where: { templateId: id },
        });
        if (dto.ucesnici.length) {
          await tx.sastanciTemplateUcesnik.createMany({
            data: dto.ucesnici.map((u) => ({
              templateId: id,
              email: u.email.toLowerCase().trim(),
              label: u.label ?? null,
            })),
          });
        }
      }
      return { data: await tx.sastanciTemplate.findUnique({ where: { id } }) };
    });
  }

  deleteTemplate(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const exists =
          (await tx.sastanciTemplate.count({ where: { id } })) > 0;
        if (!exists) throw new NotFoundException(`Šablon ${id} ne postoji`);
        await this.authz.assertCanWriteTemplate(email);
        // Učesnici šablona idu sa njim (FK `ON DELETE CASCADE`) — kao u sy15.
        await tx.sastanciTemplate.delete({ where: { id } });
        return { data: { ok: true } };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanciTemplate.count({ where: { id } })) > 0;
      const { count } = await tx.sastanciTemplate.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Šablon ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Instanciraj šablon → nov sastanak + učesnici (nextOccurrence port; pozivalac uvek u listi). */
  async instantiate(email: string, id: string, dto: InstantiateTemplateDto) {
    if (this.izvor.isThreeZero) {
      // Nastaje NOV sastanak → `sastanci_insert` = has_edit_role(). Deca prolaze
      // preko `created_by_email` grane trija (upisuje se mejl pozivaoca).
      if (!(await this.authz.canCreateSastanak(email))) {
        throw new ForbiddenException("Nemate pravo da kreirate sastanak.");
      }
      return this.threeZeroIdem(
        email,
        dto.clientEventId,
        "sastanci.instantiate-template",
        async (tx) => {
          const tpl = await tx.sastanciTemplate.findUnique({ where: { id } });
          if (!tpl) throw new NotFoundException(`Šablon ${id} ne postoji`);
          const ucesnici = await tx.sastanciTemplateUcesnik.findMany({
            where: { templateId: id },
          });
          const datum = nextOccurrence({
            cadence: tpl.cadence,
            cadenceDow: tpl.cadenceDow,
            cadenceDom: tpl.cadenceDom,
            createdAt: tpl.createdAt,
          });
          const sast = await tx.sastanak.create({
            data: {
              tip: tpl.tip || "sedmicni",
              naslov: tpl.naziv,
              datum: new Date(`${datum}T00:00:00Z`),
              vreme: tpl.vreme ?? null,
              mesto: tpl.mesto ?? "",
              status: "planiran",
              vodioEmail: tpl.vodioEmail ?? null,
              zapisnicarEmail: tpl.zapisnicarEmail ?? null,
              napomena: tpl.napomena ?? null,
              createdByEmail: email,
            },
          });
          const map = new Map<string, string | null>();
          for (const u of ucesnici)
            map.set(u.email.toLowerCase().trim(), u.label ?? u.email);
          if (!map.has(email)) map.set(email, email);
          const redovi = [...map.entries()].map(([em, label]) => ({
            email: em,
            label: label ?? em,
          }));
          await tx.sastanakUcesnik.createMany({
            data: redovi.map((u) => ({
              sastanakId: sast.id,
              email: u.email,
              label: u.label,
              prisutan: true,
              pozvan: true,
            })),
          });
          // Instanca se pravi kao `planiran`, pa AFTER INSERT triger u sy15
          // OVDE ŠALJE pozivnice. Bez ovog poziva bi „Zakaži po šablonu" tiho
          // napravilo sastanak na koji niko nije pozvan.
          await this.fn.ucesnikInviteTrigger(tx, sast.id, redovi);
          return { id: sast.id, datum };
        },
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.instantiate-template",
      async (tx) => {
        const tpl = await tx.sastanciTemplate.findUnique({ where: { id } });
        if (!tpl) throw new NotFoundException(`Šablon ${id} ne postoji`);
        const ucesnici = await tx.sastanciTemplateUcesnik.findMany({
          where: { templateId: id },
        });
        const datum = nextOccurrence({
          cadence: tpl.cadence,
          cadenceDow: tpl.cadenceDow,
          cadenceDom: tpl.cadenceDom,
          createdAt: tpl.createdAt,
        });
        const sast = await tx.sastanak.create({
          data: {
            tip: tpl.tip || "sedmicni",
            naslov: tpl.naziv,
            datum: new Date(`${datum}T00:00:00Z`),
            vreme: tpl.vreme ?? null,
            mesto: tpl.mesto ?? "",
            status: "planiran",
            vodioEmail: tpl.vodioEmail ?? null,
            zapisnicarEmail: tpl.zapisnicarEmail ?? null,
            napomena: tpl.napomena ?? null,
            createdByEmail: email,
          },
        });
        const map = new Map<string, string | null>();
        for (const u of ucesnici)
          map.set(u.email.toLowerCase().trim(), u.label ?? u.email);
        if (!map.has(email)) map.set(email, email);
        await tx.sastanakUcesnik.createMany({
          data: [...map.entries()].map(([em, label]) => ({
            sastanakId: sast.id,
            email: em,
            label: label ?? em,
            prisutan: true,
            pozvan: true,
          })),
        });
        return { id: sast.id, datum };
      },
    );
  }

  // ---------- Prefs (svoje) ----------

  updatePrefs(email: string, dto: UpdatePrefsDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async () => {
        // Isti redosled kao sy15 put: osiguraj red (upsert po mejlu) pa PATCH.
        await this.samousluga.getOrCreateMyPrefs(email);
        const key = email.toLowerCase();
        // `snp_update_own` = svoj red ∨ mgmt. Ruta piše ISKLJUČIVO svoj red
        // (ključ je mejl iz sesije), pa je provera zadovoljena po konstrukciji —
        // stoji izričito da bi se videla ako ruta ikad dobije parametar mejla.
        await this.authz.assertCanWritePrefs(email, key);
        const data = await this.prisma.sastanciNotificationPrefs.update({
          where: { email: key },
          data: {
            ...(dto.onNewAkcija !== undefined ? { onNewAkcija: dto.onNewAkcija } : {}),
            ...(dto.onChangeAkcija !== undefined
              ? { onChangeAkcija: dto.onChangeAkcija }
              : {}),
            ...(dto.onMeetingInvite !== undefined
              ? { onMeetingInvite: dto.onMeetingInvite }
              : {}),
            ...(dto.onMeetingLocked !== undefined
              ? { onMeetingLocked: dto.onMeetingLocked }
              : {}),
            ...(dto.onActionReminder !== undefined
              ? { onActionReminder: dto.onActionReminder }
              : {}),
            ...(dto.onMeetingReminder !== undefined
              ? { onMeetingReminder: dto.onMeetingReminder }
              : {}),
            updatedAt: new Date(),
          },
        });
        return { data };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      // Osiguraj red (DEFINER RPC) pa PATCH svog reda (RLS: svoje po email claim-u).
      await tx.$queryRaw(Prisma.sql`SELECT sastanci_get_or_create_my_prefs()`);
      const key = email.toLowerCase();
      await tx.sastanciNotificationPref.updateMany({
        where: { email: key },
        data: {
          ...(dto.onNewAkcija !== undefined
            ? { onNewAkcija: dto.onNewAkcija }
            : {}),
          ...(dto.onChangeAkcija !== undefined
            ? { onChangeAkcija: dto.onChangeAkcija }
            : {}),
          ...(dto.onMeetingInvite !== undefined
            ? { onMeetingInvite: dto.onMeetingInvite }
            : {}),
          ...(dto.onMeetingLocked !== undefined
            ? { onMeetingLocked: dto.onMeetingLocked }
            : {}),
          ...(dto.onActionReminder !== undefined
            ? { onActionReminder: dto.onActionReminder }
            : {}),
          ...(dto.onMeetingReminder !== undefined
            ? { onMeetingReminder: dto.onMeetingReminder }
            : {}),
          updatedAt: new Date(),
        },
      });
      const data = await tx.sastanciNotificationPref.findUnique({
        where: { email: key },
      });
      return { data };
    });
  }

  // ---------- Sedmični (weekly_move gate = sast_weekly_movers tabela u DB kroz GUC) ----------

  weeklyPomeri(email: string, dto: WeeklyPomeriDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: {
          sastanakId: await this.fn.weeklyPomeri(
            tx,
            email,
            dto.datum,
            dto.vreme ?? "09:00",
          ),
        },
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sast_weekly_pomeri(${dto.datum}::date, ${dto.vreme ?? "09:00"}::time) AS result`,
      );
      return { data: { sastanakId: rows[0]?.result ?? null } };
    });
  }

  weeklyOdlozi(email: string, dto: WeeklyOdloziDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.weeklyOdlozi(
          tx,
          email,
          dto.weekMonday ?? null,
          dto.reason ?? null,
        ),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_odlozi(${dto.weekMonday ?? null}::date, ${dto.reason ?? null}) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  weeklyVrati(email: string, dto: WeeklyVratiDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: await this.fn.weeklyVrati(tx, email, dto.weekMonday ?? null),
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_vrati(${dto.weekMonday ?? null}::date) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  // ---------- AI model (admin — set_sastanci_ai_model gate-uje current_user_is_admin) ----------

  setAiModel(email: string, dto: SetAiModelDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => ({
        data: { model: await this.fn.setAiModel(tx, email, dto.model) },
      }));
    }
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT set_sastanci_ai_model(${dto.model}) AS result`,
      );
      return { data: { model: rows[0]?.result ?? null } };
    });
  }

  /**
   * „Sažmi zapisnik" (presuda B2, port edge sastanci-ai-summary): model iz
   * sastanci_ai_settings (fallback SAST_AI_MODEL env pa opus), Anthropic one-shot.
   * Guard = sastanci.read (prijavljen korisnik). FE sklopi objekat sastanka.
   */
  async aiSummary(
    email: string,
    sastanak: Record<string, unknown>,
    actor?: { userId: number },
  ) {
    if (JSON.stringify(sastanak).length > 40000) {
      throw new UnprocessableEntityException(
        "Sastanak je prevelik za sažimanje.",
      );
    }
    const izabran = (m: string): string => {
      if (SUMMARY_ALLOWED_MODELS.includes(m)) return m;
      const env = process.env.SAST_AI_MODEL ?? "";
      return SUMMARY_ALLOWED_MODELS.includes(env) ? env : "claude-opus-4-8";
    };
    const legacyModel = this.izvor.isThreeZero
      ? izabran(
          (
            await this.prisma.sastanciAiSettings.findUnique({
              where: { id: 1 },
              select: { model: true },
            })
          )?.model ?? "",
        )
      : await this.withUserMapped(email, async (tx) => {
          const rows = await tx.$queryRaw<{ model: string | null }[]>(
            Prisma.sql`SELECT model FROM sastanci_ai_settings WHERE id = 1 LIMIT 1`,
          );
          return izabran(rows[0]?.model ?? "");
        });
    // Talas AI-0 (stavka 7c): registar prvi, sy15 podešavanje kao fallback.
    const resolved = await this.policy.resolve(
      AI_TASK.SASTANCI_SUMMARY,
      legacyModel,
    );
    const model = SUMMARY_ALLOWED_MODELS.includes(resolved.model)
      ? resolved.model
      : legacyModel;
    // Talas AI-0 (stavka 6): zapisnik i akcioni plan kucaju učesnici sastanka —
    // nepouzdan unos ide obmotan ogradom, a ograda u system prompt.
    const content = fenceUserInput(buildSummaryContent(sastanak));
    const out = await this.ai.summarize(
      model,
      `${SUMMARY_SYSTEM_PROMPT}\n\n${SASTANCI_INJECTION_FENCE}`,
      content,
      { module: AI_MODULE.SASTANCI_SUMMARY, userId: actor?.userId ?? null },
    );
    return { data: out };
  }

  // ==========================================================================
  // R2.2 — STORAGE (bucketi sastanci-arhiva, sastanak-slike) preko sy15 storage-api
  // BE proxy sa SY15_SERVICE_KEY (Reversi obrazac); pravo se proverava PRE operacije
  // kroz withUserRls nad meta-redom (bucket RLS se zaobilazi service ključem).
  // Putanje IDENTIČNE 1.0 (paralelni rad — §C): arhiva `{id}/{ts}_zapisnik.pdf`,
  // slike `{id}/{uuid}_{safeBase}`.
  // ==========================================================================

  /**
   * Upload PDF zapisnika u `sastanci-arhiva` (paritet uploadSastanakPdf). Vraća
   * storagePath koji FE prosleđuje u `/lock` (RPC upiše path PRE meeting_locked
   * trigera — §2 p.8). Ako arhiva red već postoji (regeneriši na zaključanom),
   * PATCH-uje path kroz withUserRls — RLS write-scope presuđuje.
   * Guard = sastanci.edit (paritet bucket INSERT = has_edit_role).
   *
   * Dva toka, dve semantike 0-pogodaka (review nalaz — tihi 200 sa starim PDF-om):
   *  - LOCK (bez `requireArhiva`): arhiva red još NE postoji — nastaje tek u RPC-u
   *    sast_zakljucaj_sastanak (INSERT … ON CONFLICT, path kroz p_pdf_storage_path).
   *    0 pogodaka je legitimno → 200, `arhivaUpdated:false` u odgovoru.
   *  - REGEN (`requireArhiva:true`, zaključan sastanak): red MORA biti pogođen —
   *    0 pogodaka (RLS odbija ili red ne postoji) → 403, uz best-effort brisanje
   *    upravo upload-ovanog fajla (niko ga nikad ne bi referencirao).
   */
  async uploadArhivaPdf(
    email: string,
    id: string,
    file?: Express.Multer.File,
    requireArhiva?: boolean,
  ) {
    // Magic bytes, ne `mimetype` iz zahteva (klijent ga laže) — `common/attachments`.
    assertPdfAttachment(file);
    // Postojanje + read-vidljivost sastanka (SELECT je `true` za sve prijavljene).
    // Uz to (review D5) proveravamo STATUS: LOCK tok (bez `requireArhiva`) gađa
    // sastanak koji tek treba da se zaključa. Ako je već zaključan — drugi klik,
    // dva taba, ili trka dve sesije — RPC bi vratio `already_locked` kao USPEH, a
    // ovaj upload bi dotle već prepisao `zapisnik_storage_path` novim PDF-om koji
    // nosi datum iz OVOG pokušaja. Rezultat: PDF u arhivi i datum u bazi/mejlu se
    // razilaze. Zato pucamo PRE upload-a — ništa se ne prepisuje.
    // 🔴 FAJLOVI OSTAJU U sy15 STORAGE-U i pod `3.0` (runbook §7 rep 1) — seli se
    // samo META. Zato `this.storage` NIJE u grani prekidača, a svaki upit nad
    // meta redom jeste.
    const status = this.izvor.isThreeZero
      ? await this.threeZeroRead(async (tx) => {
          const s = await tx.sastanak.findUnique({
            where: { id },
            select: { status: true },
          });
          if (!s) throw new NotFoundException(`Sastanak ${id} ne postoji`);
          return s.status;
        })
      : await this.withUserMapped(email, async (tx) => {
          const s = await tx.sastanak.findUnique({
            where: { id },
            select: { status: true },
          });
          if (!s) throw new NotFoundException(`Sastanak ${id} ne postoji`);
          return s.status;
        });
    if (!requireArhiva && status === "zakljucan") {
      throw new ConflictException(
        "Sastanak je već zaključan — zvanični PDF se ne prepisuje kroz zaključavanje. " +
          "Osveži prikaz; za zamenu PDF-a koristi „Re-generiši PDF“.",
      );
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const storagePath = `${id}/${ts}_zapisnik.pdf`;
    await this.storage.upload(
      "sastanci-arhiva",
      storagePath,
      new Uint8Array(file.buffer),
      "application/pdf",
    );
    // Ako red postoji (npr. regeneriši na zaključanom) — upiši path; pod `sy15`
    // presuđuje RLS `sa_update`, pod `3.0` isti izraz iz `canWriteSastanakChild`
    // (`sa_*` je znak-za-znak `su_*` — izmereno).
    const arhivaData = {
      zapisnikStoragePath: storagePath,
      zapisnikSizeBytes: BigInt(file.buffer.length),
      zapisnikGeneratedAt: new Date(),
    };
    const updated = this.izvor.isThreeZero
      ? await this.threeZeroTx(async (tx) => {
          if (!(await this.authz.canWriteSastanakChild(email, id))) return 0;
          // Regen ide na ZAKLJUČAN sastanak, pa `assertNotLocked` (koji to
          // dozvoljava samo rukovodstvu) mora da važi — isti guard-triger je u
          // sy15 stajao na `sastanak_arhiva`.
          await this.fn.assertNotLocked(tx, email, id);
          const { count } = await tx.sastanakArhiva.updateMany({
            where: { sastanakId: id },
            data: arhivaData,
          });
          return count;
        })
      : await this.withUserMapped(email, async (tx) => {
          const { count } = await tx.sastanakArhiva.updateMany({
            where: { sastanakId: id },
            data: arhivaData,
          });
          return count;
        });
    if (requireArhiva && updated === 0) {
      // Orphan cleanup (best-effort): path se ne vraća FE-u pa fajl niko ne referencira.
      await this.storage.remove("sastanci-arhiva", storagePath).catch(() => {});
      throw new ForbiddenException(
        "Arhiva nije ažurirana — nemaš pravo izmene ovog sastanka ili arhiva ne postoji.",
      );
    }
    return { data: { storagePath, arhivaUpdated: updated > 0 } };
  }

  /**
   * Presigned URL PDF-a zapisnika. Fajl je vidljiv samo mgmt ∨ učesniku (bucket
   * SELECT politika) — proveravamo kroz withUserRls PRE potpisivanja (service ključ
   * zaobilazi bucket RLS). Paritet downloadSastanakPdf.
   */
  async getArhivaPdfUrl(email: string, id: string) {
    if (this.izvor.isThreeZero) {
      // Bucket SELECT politika (`mgmt ∨ učesnik`) je u sy15 sprovođena kroz
      // `current_user_is_management() OR is_sastanak_ucesnik(id)` — ovde isti
      // izraz preko `SastanciAuthzService`. Bez njega bi PDF zapisnika mogao da
      // potpiše svako prijavljen, a service ključ zaobilazi bucket RLS.
      const path = await this.threeZeroRead(async (tx) => {
        const dozvoljeno =
          (await this.authz.isManagement(email)) ||
          (await this.authz.isUcesnik(email, id));
        if (!dozvoljeno) {
          throw new ForbiddenException(
            "Nemate pravo na PDF zapisnika (niste učesnik ni rukovodstvo)",
          );
        }
        const arh = await tx.sastanakArhiva.findUnique({
          where: { sastanakId: id },
          select: { zapisnikStoragePath: true },
        });
        if (!arh?.zapisnikStoragePath) {
          throw new NotFoundException(
            "Arhiva nema PDF (zapisnik_storage_path prazan)",
          );
        }
        return arh.zapisnikStoragePath;
      });
      return { data: await this.storage.signUrl("sastanci-arhiva", path, 300) };
    }
    const path = await this.withUserMapped(email, async (tx) => {
      const allowed = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT (current_user_is_management() OR is_sastanak_ucesnik(${id}::uuid)) AS ok`,
      );
      if (!allowed[0]?.ok) {
        throw new ForbiddenException(
          "Nemate pravo na PDF zapisnika (niste učesnik ni rukovodstvo)",
        );
      }
      const arh = await tx.sastanakArhiva.findUnique({
        where: { sastanakId: id },
        select: { zapisnikStoragePath: true },
      });
      if (!arh?.zapisnikStoragePath) {
        throw new NotFoundException(
          "Arhiva nema PDF (zapisnik_storage_path prazan)",
        );
      }
      return arh.zapisnikStoragePath;
    });
    return { data: await this.storage.signUrl("sastanci-arhiva", path, 300) };
  }

  /**
   * Upload slike uz tačku zapisnika u `sastanak-slike` + meta u presek_slike.
   * Meta INSERT ide PRE upload-a kroz withUserRls (RLS write-scope enforce; bez
   * orphan fajla ako pravo fali); pad upload-a → rollback meta. Paritet uploadPresekSlika.
   */
  async uploadSlika(
    email: string,
    id: string,
    dto: UploadSlikaDto,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException(
        "Očekivan fajl (multipart `file`)",
      );
    }
    const ext = (file.originalname.split(".").pop() ?? "jpg").toLowerCase();
    const safeBase = file.originalname
      .replace(/[^a-z0-9_.-]/gi, "_")
      .slice(0, 80);
    const uuid = randomUUID();
    const storagePath = `${id}/${uuid}_${safeBase || `slika.${ext}`}`;
    // 1) Meta pre upload-a (bez orphan fajla): pod `sy15` write-scope presuđuje
    //    RLS `ps_insert`, pod `3.0` isti izraz iz `canWriteSastanakChild`.
    const metaData = {
      sastanakId: id,
      aktivnostId: dto.aktivnostId ?? null,
      storagePath,
      fileName: file.originalname,
      mimeType: file.mimetype ?? null,
      sizeBytes: BigInt(file.buffer.length),
      caption: dto.caption ?? null,
      uploadedByEmail: email,
    };
    const meta = this.izvor.isThreeZero
      ? await this.threeZeroTx(async (tx) => {
          await this.authz.assertCanWriteSastanakChild(email, id);
          await this.fn.assertNotLocked(tx, email, id);
          const existingCount = await tx.presekSlika.count({
            where: { sastanakId: id },
          });
          return tx.presekSlika.create({
            data: { ...metaData, redosled: existingCount },
          });
        })
      : await this.withUserMapped(email, async (tx) => {
          const existingCount = await tx.presekSlika.count({
            where: { sastanakId: id },
          });
          return tx.presekSlika.create({
            data: { ...metaData, redosled: existingCount },
          });
        });
    // 2) Upload fajla; pad → rollback meta reda.
    try {
      await this.storage.upload(
        "sastanak-slike",
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype || "application/octet-stream",
        false,
      );
    } catch (e) {
      const rollback = this.izvor.isThreeZero
        ? this.threeZeroTx(async (tx) => {
            await tx.presekSlika.deleteMany({ where: { id: meta.id } });
          })
        : this.withUserMapped(email, async (tx) => {
            await tx.presekSlika.deleteMany({ where: { id: meta.id } });
          });
      await rollback.catch(() => {
        /* rollback best-effort */
      });
      throw e;
    }
    return { data: this.slikaOut(meta) };
  }

  updateSlika(email: string, slikaId: string, dto: UpdateSlikaDto) {
    if (this.izvor.isThreeZero) {
      return this.threeZeroTx(async (tx) => {
        const cur = await tx.presekSlika.findUnique({
          where: { id: slikaId },
          select: { sastanakId: true },
        });
        if (!cur) throw new NotFoundException(`Slika ${slikaId} ne postoji`);
        await this.authz.assertCanWriteSastanakChild(email, cur.sastanakId);
        await this.fn.assertNotLocked(tx, email, cur.sastanakId);
        const row = await tx.presekSlika.update({
          where: { id: slikaId },
          data: {
            ...(dto.caption !== undefined ? { caption: dto.caption } : {}),
            ...(dto.redosled !== undefined ? { redosled: dto.redosled } : {}),
          },
        });
        return { data: this.slikaOut(row) };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.presekSlika.count({ where: { id: slikaId } })) > 0;
      const { count } = await tx.presekSlika.updateMany({
        where: { id: slikaId },
        data: {
          ...(dto.caption !== undefined ? { caption: dto.caption } : {}),
          ...(dto.redosled !== undefined ? { redosled: dto.redosled } : {}),
        },
      });
      this.assertAffected(exists, count, `Slika ${slikaId}`);
      const row = await tx.presekSlika.findUnique({ where: { id: slikaId } });
      return { data: row ? this.slikaOut(row) : null };
    });
  }

  /** Obriši meta (RLS presuđuje) pa fajl iz bucketa (paritet deletePresekSlika). */
  async deleteSlika(email: string, slikaId: string) {
    if (this.izvor.isThreeZero) {
      const path = await this.threeZeroTx(async (tx) => {
        const row = await tx.presekSlika.findUnique({
          where: { id: slikaId },
          select: { storagePath: true, sastanakId: true },
        });
        if (!row) throw new NotFoundException(`Slika ${slikaId} ne postoji`);
        await this.authz.assertCanWriteSastanakChild(email, row.sastanakId);
        await this.fn.assertNotLocked(tx, email, row.sastanakId);
        await tx.presekSlika.delete({ where: { id: slikaId } });
        return row.storagePath;
      });
      // Fajl je i dalje u sy15 bucketu (rep 1) — briše se posle meta reda.
      if (path) await this.storage.remove("sastanak-slike", path);
      return { data: { ok: true } };
    }
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.presekSlika.findUnique({
        where: { id: slikaId },
        select: { storagePath: true },
      });
      const exists = !!row;
      const { count } = await tx.presekSlika.deleteMany({
        where: { id: slikaId },
      });
      this.assertAffected(exists, count, `Slika ${slikaId}`);
      return row?.storagePath ?? null;
    });
    if (path) await this.storage.remove("sastanak-slike", path);
    return { data: { ok: true } };
  }

  /** Presigned URL slike (bucket SELECT = svi prijavljeni; guard read). */
  async getSlikaUrl(email: string, slikaId: string) {
    if (this.izvor.isThreeZero) {
      // Bucket SELECT je „svi prijavljeni" (`ps_select` = `true`) — nema
      // read-scope-a koji bi se izgubio; guard rute je `sastanci.read`.
      const path = await this.threeZeroRead(async (tx) => {
        const row = await tx.presekSlika.findUnique({
          where: { id: slikaId },
          select: { storagePath: true },
        });
        if (!row) throw new NotFoundException(`Slika ${slikaId} ne postoji`);
        return row.storagePath;
      });
      return { data: await this.storage.signUrl("sastanak-slike", path, 3600) };
    }
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.presekSlika.findUnique({
        where: { id: slikaId },
        select: { storagePath: true },
      });
      if (!row) throw new NotFoundException(`Slika ${slikaId} ne postoji`);
      return row.storagePath;
    });
    return { data: await this.storage.signUrl("sastanak-slike", path, 3600) };
  }
}
