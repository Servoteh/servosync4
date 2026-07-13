import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import type {
  AkcioneTackeQueryDto,
  IzvestajQueryDto,
  OperativniPlanQueryDto,
  PortfolioQueryDto,
  PrijaveQueryDto,
} from "./dto/pracenje-query.dto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lot clamp — paritet 1.0 fetchPracenjePortfolio (1..100000, default 12). */
function clampLot(raw?: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100000) : 12;
}

/**
 * Praćenje proizvodnje — 3.0 TALAS C, R1 read sloj (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Podaci žive u sy15 (production/core/pdm šeme); front im prilazi kroz public wrapper
 * RPC-ove (jsonb) i public bridge view-ove (security_invoker). SVE kroz `withUserRls`
 * (GUC claims + SET LOCAL ROLE authenticated) — DEFINER RPC-ovi (get_pracenje_*,
 * can_edit_pracenje…) i RLS „moji" view-ovi rade netaknuti (paritet po konstrukciji,
 * doktrina §A.2a). Mutacije (upsert aktivnost/override/napomena/prioritet) su R2.
 */
@Injectable()
export class PracenjeService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Portfolio / predmeti ----------

  /** Kontrolna tabla — rollup po aktivnom predmetu (get_pracenje_portfolio). */
  async portfolio(email: string, q: PortfolioQueryDto) {
    const lot = clampLot(q.lotQty);
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ get_pracenje_portfolio: unknown }[]>(
        Prisma.sql`SELECT get_pracenje_portfolio(${lot}::int) AS get_pracenje_portfolio`,
      );
      return { data: rows[0]?.get_pracenje_portfolio ?? null };
    });
  }

  /** Aktivni predmeti (ekran 1) — jsonb niz (get_aktivni_predmeti). */
  async predmeti(email: string) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ get_aktivni_predmeti: unknown }[]>(
        Prisma.sql`SELECT get_aktivni_predmeti() AS get_aktivni_predmeti`,
      );
      return { data: rows[0]?.get_aktivni_predmeti ?? null };
    });
  }

  /** Stablo podsklopova predmeta (get_podsklopovi_predmeta). */
  async podsklopovi(email: string, itemId: number) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ get_podsklopovi_predmeta: unknown }[]>(
        Prisma.sql`SELECT get_podsklopovi_predmeta(${itemId}::int) AS get_podsklopovi_predmeta`,
      );
      return { data: rows[0]?.get_podsklopovi_predmeta ?? null };
    });
  }

  /** Tabela praćenja predmeta (get_predmet_pracenje_izvestaj + root_rn, lot). */
  async izvestaj(email: string, itemId: number, q: IzvestajQueryDto) {
    const lot = clampLot(q.lotQty);
    const rootRn = q.rootRn ? BigInt(q.rootRn) : null;
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<
        { get_predmet_pracenje_izvestaj: unknown }[]
      >(
        Prisma.sql`SELECT get_predmet_pracenje_izvestaj(${itemId}::int, ${rootRn}::bigint, ${lot}::int) AS get_predmet_pracenje_izvestaj`,
      );
      return { data: rows[0]?.get_predmet_pracenje_izvestaj ?? null };
    });
  }

  // ---------- RN ----------

  /**
   * Razrešavanje RN reference (broj/legacy_idrn/uuid → uuid) — paritet resolveRnId
   * (pracenjeProizvodnje.js:34): uuid → direktno; inače ILIKE po rn_broj (+ legacy_idrn
   * ako je numerički). 0 → 404-semantika (422), >1 → 409-semantika (409).
   */
  async rnResolve(email: string, ref: string) {
    const qv = (ref ?? "").trim();
    if (!qv) throw new BadRequestException("Unesi RN broj ili RN UUID.");
    if (UUID_RE.test(qv)) return { data: { id: qv } };
    const like = `%${qv}%`;
    const numeric = /^\d+$/.test(qv);
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; rn_broj: string }[]>(
        Prisma.sql`SELECT id, rn_broj FROM radni_nalog
          WHERE rn_broj = ${qv} OR rn_broj ILIKE ${like}
            ${numeric ? Prisma.sql`OR legacy_idrn = ${qv}` : Prisma.empty}
          ORDER BY rn_broj ASC LIMIT 5`,
      );
      if (rows.length === 1) return { data: { id: rows[0].id } };
      if (rows.length > 1)
        throw new BadRequestException(
          `Nađeno je više RN-ova za "${qv}". Unesi tačan RN broj ili UUID.`,
        );
      throw new BadRequestException(
        `RN "${qv}" nije pronađen u proizvodnji. Proveri RN broj ili prvo importuj/lansiraj RN.`,
      );
    });
  }

  /** RN pregled (Tab1 pozicije, source local/bigtehn fallback) — get_pracenje_rn. */
  async rn(email: string, rnId: string) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ get_pracenje_rn: unknown }[]>(
        Prisma.sql`SELECT get_pracenje_rn(${rnId}::uuid) AS get_pracenje_rn`,
      );
      return { data: rows[0]?.get_pracenje_rn ?? null };
    });
  }

  /** Operativni plan RN-a (Tab2 aktivnosti po odeljenjima) — get_operativni_plan. */
  async operativniPlan(email: string, rnId: string, q: OperativniPlanQueryDto) {
    const projekat = q.projekat ?? null;
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ get_operativni_plan: unknown }[]>(
        Prisma.sql`SELECT get_operativni_plan(${rnId}::uuid, ${projekat}::uuid) AS get_operativni_plan`,
      );
      return { data: rows[0]?.get_operativni_plan ?? null };
    });
  }

  /** FE gate paritet — can_edit_pracenje(projekat, rn) kao flag (row-odluka u DB). */
  async canEdit(email: string, rnId: string, projekat?: string) {
    const proj = projekat ?? null;
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ can_edit: boolean }[]>(
        Prisma.sql`SELECT can_edit_pracenje(${proj}::uuid, ${rnId}::uuid) AS can_edit`,
      );
      return { data: { canEdit: rows[0]?.can_edit ?? false } };
    });
  }

  /** Istorija aktivnosti — blokade svima (blok_istorija view). Audit deo (admin) = R2 TODO. */
  async aktivnostIstorija(email: string, id: string) {
    return this.read(email, async (tx) => {
      const blokade = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM operativna_aktivnost_blok_istorija
          WHERE aktivnost_id = ${id}::uuid ORDER BY created_at DESC`,
      );
      // TODO(R2): audit sekcija (audit_log SELECT admin-only, §2-11) — vratiti samo adminu.
      return { data: { blokade: jsonSafe(blokade), audit: [] } };
    });
  }

  // ---------- Prijave rada ----------

  /**
   * Prijave rada za operaciju: BigTehn varijanta (get_bigtehn_prijave_za_operaciju)
   * ili lokalna (prijava_rada view po Faza-2 poziciji). Paritet side-panel-a RN Tab1.
   */
  async prijave(email: string, q: PrijaveQueryDto) {
    if (q.workOrder && q.op) {
      const wo = BigInt(q.workOrder);
      const op = Number(q.op);
      const machine = q.machine ?? null;
      return this.read(email, async (tx) => {
        const rows = await tx.$queryRaw<
          { get_bigtehn_prijave_za_operaciju: unknown }[]
        >(
          Prisma.sql`SELECT get_bigtehn_prijave_za_operaciju(${wo}::bigint, ${op}::int, ${machine}::text) AS get_bigtehn_prijave_za_operaciju`,
        );
        return {
          data: rows[0]?.get_bigtehn_prijave_za_operaciju ?? null,
          meta: { source: "bigtehn" },
        };
      });
    }
    if (q.pozicija) {
      return this.read(email, async (tx) => {
        const rows = await tx.$queryRaw(
          Prisma.sql`SELECT * FROM prijava_rada
            WHERE radni_nalog_pozicija_id = ${q.pozicija}::uuid
            ORDER BY started_at ASC NULLS LAST`,
        );
        return { data: jsonSafe(rows), meta: { source: "local" } };
      });
    }
    throw new BadRequestException(
      "Zadaj workOrder+op (BigTehn) ili pozicija (lokalno).",
    );
  }

  // ---------- Lookups / pretraga ----------

  /** Šifarnik odeljenja (bridge view core.odeljenje). */
  async odeljenja(email: string) {
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, kod, naziv, boja, sort_order, aktivan, vodja_user_id, vodja_radnik_id
          FROM odeljenje WHERE aktivan IS TRUE ORDER BY sort_order ASC NULLS LAST, kod ASC`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Šifarnik radnika (bridge view core.radnik). */
  async radnici(email: string) {
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, employee_id, odeljenje_id, sifra_radnika, ime, puno_ime, email, aktivan
          FROM radnik WHERE aktivan IS TRUE ORDER BY puno_ime ASC NULLS LAST, ime ASC`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Otvorene akcione tačke projekta (v_akcioni_plan) — za promociju u aktivnost (most Sastanci). */
  async akcioneTacke(email: string, q: AkcioneTackeQueryDto) {
    const projekat = q.projekat ?? null;
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, naslov, opis, projekat_id, sastanak_id, effective_status, rok, rok_text, odgovoran_label, odgovoran_text
          FROM v_akcioni_plan
          WHERE ${projekat ? Prisma.sql`projekat_id = ${projekat}::uuid` : Prisma.sql`projekat_id IS NOT NULL`}
            AND effective_status IN ('otvoren','u_toku','kasni')
          ORDER BY rok ASC NULLS LAST, created_at DESC`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Pretraga delova/pozicija (search_proizvodnja_delovi) — min 2 znaka. */
  async searchDelovi(email: string, q?: string) {
    const query = (q ?? "").trim();
    if (query.length < 2) return { data: [] };
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT search_proizvodnja_delovi(${query}::text, 50::int) AS r`,
      );
      const arr = (data as { r: unknown }[])[0]?.r ?? [];
      return { data: jsonSafe(arr) };
    });
  }

  /** ⭐ plan-prioritet (get_predmet_plan_prioritet_ids/max/prev) — čita za ⭐ top-listu. */
  async planPrioritet(email: string) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          ids: number[] | null;
          max: number | null;
          prev: number[] | null;
        }[]
      >(
        Prisma.sql`SELECT get_predmet_plan_prioritet_ids() AS ids,
                          get_predmet_plan_prioritet_max() AS max,
                          get_predmet_plan_prioritet_prev() AS prev`,
      );
      const r = rows[0];
      return {
        data: {
          ids: r?.ids ?? [],
          max: r?.max ?? null,
          prev: r?.prev ?? null,
        },
      };
    });
  }

  // ---------- interno ----------

  private async read<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      mapSy15Error(e);
    }
  }
}
