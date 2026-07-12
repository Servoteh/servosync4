import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { pageMeta, parsePagination } from "../../common/pagination";

/**
 * Sastanci — 3.0 TALAS B, R1 read sloj (MODULE_SPEC_sastanci_ai_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (doktrina §A.1); ovaj servis samo ČITA:
 *  - tabele kroz Prisma (`prisma/sy15.prisma`, bez FK relacija — 1.0 šema ih nema,
 *    spajanja su ručni batch-resolve),
 *  - view-ove `v_akcioni_plan` / `v_pm_teme_pregled` kroz $queryRaw (view ostaje u bazi,
 *    security_invoker → RLS pozivaoca; paritet 1:1 sa 1.0 frontom),
 *  - RPC-ove (sast_weekly_status, sast_dashboard_stats, get_sastanci_user_directory,
 *    sastanci_get_or_create_my_prefs) i row-scoped tabele (pm_teme, notification_log)
 *    kroz GUC most (`Sy15Service.withUser`) jer čitaju identitet iz `auth.jwt()`.
 * SVE ide kroz withUser da GUC claims uvek postoje (pm_teme/notification_log su
 * row-scoped, a `true`-politike ionako prolaze). Mutacije/RPC-write su R2.
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

export interface ListSastanciQuery {
  tip?: string;
  status?: string;
  projekatId?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

export interface AkcijeQuery {
  sastanakId?: string;
  projekatId?: string;
  status?: string;
  odgovoranEmail?: string;
}

export interface TemeQuery {
  status?: string;
  projekatId?: string;
  sastanakId?: string;
  oblast?: string;
}

@Injectable()
export class SastanciService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Liste / pretraga ----------

  /** Lista sastanaka + filteri (paritet 1.0 loadSastanci). */
  async list(email: string, query: ListSastanciQuery) {
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

  /** Sledeći PLANIRAN sedmični (paritet 1.0 loadNextPlaniran). */
  async nextWeekly(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanak.findFirst({
        where: {
          tip: "sedmicni",
          status: "planiran",
          datum: { gte: new Date(new Date().toISOString().slice(0, 10)) },
        },
        orderBy: [{ datum: "asc" }],
      });
      return { data };
    });
  }

  /** Globalna pretraga sastanaka (paritet 1.0 searchSastanciGlobal). */
  async search(email: string, q?: string) {
    const term = (q ?? "").trim();
    if (!term) return { data: [] };
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanak.findMany({
        where: {
          OR: [
            { naslov: { contains: term, mode: "insensitive" } },
            { mesto: { contains: term, mode: "insensitive" } },
            { napomena: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: [{ datum: "desc" }],
        take: 50,
      });
      return { data };
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
            orderBy: [{ createdAt: "asc" }],
          }),
          tx.$queryRaw(
            Prisma.sql`SELECT * FROM v_akcioni_plan WHERE sastanak_id = ${id}::uuid ORDER BY rb ASC NULLS LAST, created_at ASC`,
          ),
          tx.sastanakArhiva.findUnique({ where: { sastanakId: id } }),
        ]);
      const akcijeArr = akcije as { effective_status?: string }[];
      return {
        data: {
          ...sastanak,
          ucesnici,
          aktivnosti,
          slike,
          odluke,
          akcije: akcijeArr,
          arhiva,
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
      return { data };
    });
  }

  /** Odluke sastanka. */
  async odluke(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakOdluka.findMany({
        where: { sastanakId: id },
        orderBy: [{ createdAt: "asc" }],
      });
      return { data };
    });
  }

  // ---------- Akcioni plan (view v_akcioni_plan) ----------

  /** Akcioni plan sa filterima (paritet loadAkcije). Čita ISKLJUČIVO view (effective_status). */
  async listAkcije(email: string, q: AkcijeQuery) {
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
        Prisma.sql`SELECT * FROM v_akcioni_plan ${where} ORDER BY rok ASC NULLS LAST, created_at DESC`,
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

  /** Zbir akcija po effective_status (paritet loadWeeklyDiffStats — KPI za „Sedmični presek"). */
  async akcijeWeeklyDiff(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<
        { effective_status: string; n: bigint }[]
      >(
        Prisma.sql`SELECT effective_status, count(*)::bigint AS n FROM v_akcioni_plan GROUP BY effective_status`,
      );
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[r.effective_status] = Number(r.n);
      return { data: { byStatus } };
    });
  }

  // ---------- PM teme (view v_pm_teme_pregled — SELECT nije javan, row-scope u bazi) ----------

  async listTeme(email: string, q: TemeQuery) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      if (q.projekatId)
        conds.push(Prisma.sql`projekat_id = ${q.projekatId}::uuid`);
      if (q.sastanakId)
        conds.push(Prisma.sql`sastanak_id = ${q.sastanakId}::uuid`);
      if (q.oblast) conds.push(Prisma.sql`oblast = ${q.oblast}`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_pm_teme_pregled ${where} ORDER BY COALESCE(admin_rang, 999), prioritet, predlozio_at DESC`,
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
      return { data };
    });
  }

  async findArhiva(email: string, sastanakId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanakArhiva.findUnique({
        where: { sastanakId },
      });
      if (!data)
        throw new NotFoundException(`Arhiva za ${sastanakId} ne postoji`);
      return { data };
    });
  }

  // ---------- Notifikacije (OUTBOX read — RLS: svoje ∨ mgmt) ----------

  async notifications(email: string, sastanakId?: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.sastanciNotificationLog.findMany({
        where: sastanakId ? { relatedSastanakId: sastanakId } : {},
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

  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUser(email, fn);
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
