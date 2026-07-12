import {
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

  /** SQLSTATE iz DB fn → HTTP semantika (paritet Reversi §5): 42501→403, P0001/P0002→422. */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const message = meta?.message ?? (e as Error).message;
    if (meta?.code === "42501") throw new ForbiddenException(message);
    if (meta?.code === "P0001" || meta?.code === "P0002")
      throw new UnprocessableEntityException(message);
    throw e;
  }
}
