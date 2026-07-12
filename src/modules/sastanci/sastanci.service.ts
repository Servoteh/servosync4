import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { pageMeta, parsePagination } from "../../common/pagination";
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
  ReorderDto,
  ReorderRangDto,
  RsvpDto,
  SetAiModelDto,
  TemaAdminRangDto,
  TemaDodeliDto,
  TemaHitnoDto,
  TemaRazmatranjeDto,
  UpdateAktivnostDto,
  UpdateOdlukaDto,
  UpdatePrefsDto,
  UpdateSastanakDto,
  UpdateTemaDto,
  UpdateTemplateDto,
  UpdateUcesnikDto,
  WeeklyOdloziDto,
  WeeklyPomeriDto,
  WeeklyVratiDto,
} from "./dto/sastanci-mutation.dto";
import { nextOccurrence } from "./templates-cadence";

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

/** Sort akcija — paritet 1.0 loadAkcije (akcioniPlan.js): rb, rok, prioritet, created_at. */
const AKCIJE_ORDER = Prisma.sql`ORDER BY rb ASC NULLS LAST, rok ASC NULLS LAST, prioritet ASC, created_at DESC`;

@Injectable()
export class SastanciService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Liste / pretraga ----------

  /** Lista sastanaka + filteri (paritet 1.0 loadSastanci). */
  async list(email: string, query: ListSastanciQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.SastanakWhereInput = {
      ...(query.tip ? { tip: query.tip } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.projekatId ? { projekatId: query.projekatId } : {}),
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
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  /** „Moji sastanci" — svi na kojima je pozivalac učesnik (paritet 1.0 „Moj rad"). */
  async myMeetings(email: string) {
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
   */
  async nextWeekly(email: string) {
    // en-CA locale daje YYYY-MM-DD; sidro je Beograd, ne UTC (posle 22h leti UTC ide u sutra).
    const todayBelgrade = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
    }).format(new Date());
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanak.findFirst({
        where: {
          status: "planiran",
          datum: { gte: new Date(todayBelgrade) },
        },
        orderBy: [{ datum: "asc" }],
      });
      return { data };
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
            Prisma.sql`SELECT * FROM v_akcioni_plan WHERE sastanak_id = ${id}::uuid ${AKCIJE_ORDER}`,
          ),
          tx.sastanakArhiva.findUnique({ where: { sastanakId: id } }),
        ]);
      const akcijeArr = akcije as { effective_status?: string }[];
      return {
        data: {
          ...sastanak,
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
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanak.findUnique({ where: { id } });
      if (!data) throw new NotFoundException(`Sastanak ${id} ne postoji`);
      return { data };
    });
  }

  /** Učesnici jednog sastanka (bez rsvp_token). */
  async ucesnici(email: string, id: string) {
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
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.sastanakId)
        conds.push(Prisma.sql`sastanak_id = ${q.sastanakId}::uuid`);
      if (q.projekatId)
        conds.push(Prisma.sql`projekat_id = ${q.projekatId}::uuid`);
      if (q.status) conds.push(Prisma.sql`effective_status = ${q.status}`);
      if (q.odgovoranEmail)
        conds.push(
          Prisma.sql`lower(odgovoran_email) = lower(${q.odgovoranEmail})`,
        );
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_akcioni_plan ${where} ${AKCIJE_ORDER}`,
      );
      return { data };
    });
  }

  /** Istorija izmena jedne akcije (akcioni_plan_istorija — read; AFTER UPDATE trigger piše diff). */
  async akcijaIstorija(email: string, akcijaId: string) {
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
    const since = q.since ?? null;
    return this.withUserMapped(email, async (tx) => {
      const where = q.projekatId
        ? Prisma.sql`WHERE projekat_id = ${q.projekatId}::uuid`
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
        data: {
          novo: Number(r?.novo ?? 0),
          zavrsenoOveNedelje: Number(r?.zavrseno ?? 0),
          kasni: Number(r?.kasni ?? 0),
          aktivnih: Number(r?.aktivnih ?? 0),
        },
      };
    });
  }

  // ---------- PM teme (view v_pm_teme_pregled — SELECT nije javan, row-scope u RLS) ----------

  /**
   * PM teme — paritet 1.0 loadPmTeme (pmTeme.js:134-160): sort admin_rang ASC NULLS LAST,
   * hitno DESC, za_razmatranje DESC, prioritet ASC, predlozio_at DESC; filteri status/
   * excludeStatuses/sastanakId/projekatId/predlozioEmail/hitnoOnly/razmatranjeOnly.
   * Vidljivost redova (predlagač∨mgmt∨učesnik∨draft+edit) presuđuje RLS (withUserRls).
   */
  async listTeme(email: string, q: TemeQueryDto) {
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
        conds.push(Prisma.sql`projekat_id = ${q.projekatId}::uuid`);
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

  async listTemplates(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const templates = await tx.sastanciTemplate.findMany({
        orderBy: [{ naziv: "asc" }],
      });
      return { data: templates };
    });
  }

  async findTemplate(email: string, id: string) {
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
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakArhiva.findMany({
        orderBy: [{ arhiviranoAt: "desc" }],
      });
      return { data: data.map((a) => this.arhivaOut(a)) };
    });
  }

  async findArhiva(email: string, sastanakId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakArhiva.findUnique({
        where: { sastanakId },
      });
      if (!data)
        throw new NotFoundException(`Arhiva za ${sastanakId} ne postoji`);
      return { data: this.arhivaOut(data) };
    });
  }

  // ---------- Notifikacije (OUTBOX read — row-scope „svoje ∨ mgmt" presuđuje RLS) ----------

  async notifications(email: string, q: NotificationsQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanciNotificationLog.findMany({
        where: q.sastanakId ? { relatedSastanakId: q.sastanakId } : {},
        orderBy: [{ createdAt: "desc" }],
        take: 200,
      });
      return { data };
    });
  }

  // ---------- RPC read-ovi (GUC most) ----------

  /** Podešavanja notifikacija pozivaoca (sastanci_get_or_create_my_prefs). */
  async myPrefs(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM sastanci_get_or_create_my_prefs()`,
      );
      return { data: rows[0] ?? null };
    });
  }

  /** Status sedmičnog (sast_weekly_status → can_move iz movers tabele). */
  async weeklyStatus(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ sast_weekly_status: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_status() AS sast_weekly_status`,
      );
      return { data: rows[0]?.sast_weekly_status ?? null };
    });
  }

  /** KPI brojke za Pregled (sast_dashboard_stats). */
  async dashboardStats(email: string) {
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
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM get_sastanci_user_directory()`,
      );
      return { data };
    });
  }

  /** Model za AI rezime (sastanci_ai_settings singleton; PUT je admin/R2). */
  async aiModel(email: string) {
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
   */
  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * SQLSTATE iz DB fn/RLS → HTTP semantika (paritet Reversi §5):
   * 42501→403, P0001/P0002→422, 23514(check, npr. nepoznat model)→422, 23505→409.
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
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
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

  /** Idempotentna akcija sa nus-efektima (create/lock/bulk-replace/instantiate). */
  private async runIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
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

  /** Posle updateMany/deleteMany sa 0 pogodaka: 404 ako red ne postoji (po SELECT-u),
   *  inače 403 (postoji ali RLS write-scope odbija). Ne duplira write-scope. */
  private assertAffected(exists: boolean, count: number, what: string): void {
    if (count > 0) return;
    if (!exists) throw new NotFoundException(`${what} ne postoji`);
    throw new ForbiddenException(`Nemate pravo nad: ${what}`);
  }

  // ---------- Sastanci CRUD ----------

  /** Kreiraj sastanak (paritet saveSastanak; RLS INSERT = has_edit_role). */
  createSastanak(email: string, dto: CreateSastanakDto) {
    return this.runIdem(
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
            projekatId: dto.projekatId ?? null,
            vodioEmail: dto.vodioEmail ?? null,
            vodioLabel: dto.vodioLabel ?? null,
            zapisnicarEmail: dto.zapisnicarEmail ?? null,
            zapisnicarLabel: dto.zapisnicarLabel ?? null,
            status: dto.status ?? "planiran",
            napomena: dto.napomena ?? null,
            createdByEmail: email,
          },
        });
        return row;
      },
    );
  }

  /** Izmena sastanka (paritet saveSastanak/updateStatus; RLS UPDATE = mgmt∨trio). */
  async updateSastanak(email: string, id: string, dto: UpdateSastanakDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanak.count({ where: { id } })) > 0;
      const data: Prisma.SastanakUpdateInput = {
        ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.datum !== undefined
          ? { datum: this.toDbDate(dto.datum)! }
          : {}),
        ...(dto.vreme !== undefined ? { vreme: this.toDbTime(dto.vreme) } : {}),
        ...(dto.mesto !== undefined ? { mesto: dto.mesto } : {}),
        ...(dto.projekatId !== undefined ? { projekatId: dto.projekatId } : {}),
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
      return { data: await tx.sastanak.findUnique({ where: { id } }) };
    });
  }

  async deleteSastanak(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanak.count({ where: { id } })) > 0;
      const { count } = await tx.sastanak.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Sastanak ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Zaključaj (arhiva snapshot + status; PDF path PRE meeting_locked trigera — §2 p.8). */
  lock(email: string, id: string, dto: LockSastanakDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.lock",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>(
          Prisma.sql`SELECT sast_zakljucaj_sastanak(${id}::uuid, NULL, ${dto.pdfStoragePath ?? null}) AS result`,
        );
        return rows[0]?.result ?? null;
      },
    );
  }

  /** Reopen (mgmt): zakljucan → u_toku, očisti zakljucan_* (paritet otvojiPonovo). */
  reopen(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanak.count({ where: { id } })) > 0;
      const { count } = await tx.sastanak.updateMany({
        where: { id },
        data: {
          status: "u_toku",
          zakljucanAt: null,
          zakljucanByEmail: null,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Sastanak ${id}`);
      return { data: await tx.sastanak.findUnique({ where: { id } }) };
    });
  }

  // ---------- Pozivnice / podsetnici (delete-pa-enqueue RPC — re-send semantika) ----------

  /** Pošalji pozivnice + stamp pozivnice_poslate_at (paritet sendInvites; RPC=mgmt). */
  sendInvites(email: string, id: string) {
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
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT sastanci_remind_unprepared(${id}::uuid) AS n`,
      );
      return { data: { reminded: Number(rows[0]?.n ?? 0) } };
    });
  }

  resendLocked(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT sastanci_resend_meeting_locked(${id}::uuid) AS n`,
      );
      return { data: { resent: Number(rows[0]?.n ?? 0) } };
    });
  }

  /** Moj RSVP (sastanci_set_my_rsvp — svako svoj; idempotentno po vrednosti). */
  setMyRsvp(email: string, id: string, dto: RsvpDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sastanci_set_my_rsvp(${id}::uuid, ${dto.status ?? null}) AS result`,
      );
      return { data: { rsvp: rows[0]?.result ?? null } };
    });
  }

  // ---------- Učesnici ----------

  /** Bulk replace (DELETE pa INSERT — regeneriše rsvp_token, briše RSVP; §2 p.6/B8). */
  bulkUcesnici(email: string, id: string, dto: BulkUcesniciDto) {
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
        }
        return { count: dto.ucesnici.length };
      },
    );
  }

  addUcesnik(email: string, id: string, dto: AddUcesnikDto) {
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
      return { data: { ok: true } };
    });
  }

  updateUcesnik(
    email: string,
    id: string,
    ucesnikEmail: string,
    dto: UpdateUcesnikDto,
  ) {
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
    return this.withUserMapped(email, async (tx) => {
      const { count } = await tx.sastanakUcesnik.updateMany({
        where: { sastanakId: id, pozvan: true },
        data: { prisutan: true },
      });
      return { data: { updated: count } };
    });
  }

  // ---------- Tačke zapisnika (presek_aktivnosti) ----------

  createAktivnost(email: string, id: string, dto: CreateAktivnostDto) {
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
            status: dto.status ?? "u_toku",
            napomena: dto.napomena ?? null,
            temaId: dto.temaId ?? null,
          },
        });
        return row;
      },
    );
  }

  updateAktivnost(email: string, aktId: string, dto: UpdateAktivnostDto) {
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

  /** Most teme→zapisnik: seed tačaka iz pm_teme (dedup po tema_id; §3 BE tx). */
  seedFromTeme(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const teme = await tx.pmTema.findMany({
        where: { sastanakId: id },
        select: { id: true, naslov: true },
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
            temaId: t.id,
            status: "u_toku",
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

  createOdluka(email: string, id: string, dto: CreateOdlukaDto) {
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

  createAkcija(email: string, dto: CreateAkcijaDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-akcija",
      async (tx) => {
        const row = await tx.akcioniPlan.create({
          data: {
            sastanakId: dto.sastanakId ?? null,
            temaId: dto.temaId ?? null,
            projekatId: dto.projekatId ?? null,
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
  patchAkcija(email: string, id: string, dto: PatchAkcijaDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.akcioniPlan.count({ where: { id } })) > 0;
      const data: Prisma.AkcioniPlanUpdateInput = {
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.sastanakId !== undefined ? { sastanakId: dto.sastanakId } : {}),
        ...(dto.projekatId !== undefined ? { projekatId: dto.projekatId } : {}),
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
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.akcioniPlan.count({ where: { id } })) > 0;
      const { count } = await tx.akcioniPlan.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Akcija ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Bulk status (paritet updateAkcijeStatusBulk — vraća STVARNO izmenjen broj, RLS može odbiti deo). */
  bulkStatus(email: string, dto: BulkStatusDto) {
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

  createTema(email: string, dto: CreateTemaDto) {
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
            projekatId: dto.projekatId ?? null,
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

  updateTema(email: string, id: string, dto: UpdateTemaDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.pmTema.count({ where: { id } })) > 0;
      const data: Prisma.PmTemaUpdateInput = {
        ...(dto.vrsta !== undefined ? { vrsta: dto.vrsta } : {}),
        ...(dto.oblast !== undefined ? { oblast: dto.oblast } : {}),
        ...(dto.naslov !== undefined ? { naslov: dto.naslov } : {}),
        ...(dto.opis !== undefined ? { opis: dto.opis } : {}),
        ...(dto.projekatId !== undefined ? { projekatId: dto.projekatId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.prioritet !== undefined ? { prioritet: dto.prioritet } : {}),
        ...(dto.hitno !== undefined ? { hitno: dto.hitno } : {}),
        ...(dto.zaRazmatranje !== undefined
          ? { zaRazmatranje: dto.zaRazmatranje }
          : {}),
        ...(dto.sastanakId !== undefined ? { sastanakId: dto.sastanakId } : {}),
        updatedAt: new Date(),
      };
      // Rešeno stanje → snapshot resio_* (paritet buildTemaPayload).
      if (
        dto.status &&
        ["usvojeno", "odbijeno", "odlozeno", "zatvoreno"].includes(dto.status)
      ) {
        data.resioEmail = email;
        data.resioLabel = email;
        data.resioAt = new Date();
        if (dto.resioNapomena !== undefined)
          data.resioNapomena = dto.resioNapomena || null;
      }
      const { count } = await tx.pmTema.updateMany({ where: { id }, data });
      this.assertAffected(exists, count, `Tema ${id}`);
      return { data: await tx.pmTema.findUnique({ where: { id } }) };
    });
  }

  deleteTema(email: string, id: string) {
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

  createDraftTema(email: string, dto: CreateDraftTemaDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "sastanci.create-draft-tema",
      async (tx) => {
        const row = await tx.pmTema.create({
          data: {
            projekatId: dto.projektId,
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
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pmTema.findMany({
        where: { projekatId: projektId, status: "draft", sastanakId: null },
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

  /** Zajednički PATCH jedne teme (flag/rang/dodela) — RLS presuđuje red. */
  private patchTema(
    email: string,
    id: string,
    data: Prisma.PmTemaUpdateManyMutationInput,
    what: string,
  ) {
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

  createTemplate(email: string, dto: CreateTemplateDto) {
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
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.sastanciTemplate.count({ where: { id } })) > 0;
      const { count } = await tx.sastanciTemplate.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Šablon ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Instanciraj šablon → nov sastanak + učesnici (nextOccurrence port; pozivalac uvek u listi). */
  instantiate(email: string, id: string, dto: InstantiateTemplateDto) {
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
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT sast_weekly_pomeri(${dto.datum}::date, ${dto.vreme ?? "09:00"}::time) AS result`,
      );
      return { data: { sastanakId: rows[0]?.result ?? null } };
    });
  }

  weeklyOdlozi(email: string, dto: WeeklyOdloziDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_odlozi(${dto.weekMonday ?? null}::date, ${dto.reason ?? null}) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  weeklyVrati(email: string, dto: WeeklyVratiDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT sast_weekly_vrati(${dto.weekMonday ?? null}::date) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  // ---------- AI model (admin — set_sastanci_ai_model gate-uje current_user_is_admin) ----------

  setAiModel(email: string, dto: SetAiModelDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: string }[]>(
        Prisma.sql`SELECT set_sastanci_ai_model(${dto.model}) AS result`,
      );
      return { data: { model: rows[0]?.result ?? null } };
    });
  }
}
