import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import { sanitizeDrawingNo } from "../../common/drawings";
import type {
  AkcioneTackeQueryDto,
  IzvestajQueryDto,
  OperativniPlanQueryDto,
  PortfolioQueryDto,
  PrijaveQueryDto,
} from "./dto/pracenje-query.dto";
import type {
  BlokirajAktivnostDto,
  EnsureRnDto,
  ExportLogDto,
  OdblokirajAktivnostDto,
  PracenjeManualOverrideDto,
  PracenjeNapomenaDto,
  PracenjeParentOverrideDto,
  PromoteAkcionaTackaDto,
  UpsertAktivnostDto,
  ZatvoriAktivnostDto,
} from "./dto/pracenje-mutation.dto";

const BIGTEHN_DRAWINGS_BUCKET = "bigtehn-drawings";

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
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
  ) {}

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
    // `legacy_idrn` je INTEGER, a Prisma vezuje ${qv} kao TEXT param → poređenje
    // `integer = text` pada na 42883 („operator does not exist") bez ::int cast-a
    // (za SVAKI čisto-numerički ref, npr. „9400" kojim počinju svi RN brojevi).
    // Ograniči na int4 opseg da ::int ne baci 22003; van opsega rn_broj ILIKE i dalje radi.
    const numeric = /^\d+$/.test(qv) && Number(qv) <= 2147483647;
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; rn_broj: string }[]>(
        Prisma.sql`SELECT id, rn_broj FROM radni_nalog
          WHERE rn_broj = ${qv} OR rn_broj ILIKE ${like}
            ${numeric ? Prisma.sql`OR legacy_idrn = ${qv}::int` : Prisma.empty}
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

  /**
   * Istorija aktivnosti — blokade svima (blok_istorija view), audit deo SAMO adminu
   * (presuda C5). Audit sekciju NE filtriramo u TS: `audit_log` SELECT politika je
   * `current_user_is_admin()` pa kroz `withUserRls` ne-admin dobije 0 redova (paritet §2-11).
   */
  async aktivnostIstorija(email: string, id: string) {
    return this.read(email, async (tx) => {
      const [blokade, audit] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM operativna_aktivnost_blok_istorija
            WHERE aktivnost_id = ${id}::uuid ORDER BY created_at DESC`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT id, table_name, action, actor_email, changed_at, old_data, new_data, diff_keys
            FROM audit_log WHERE record_id = ${id} ORDER BY changed_at DESC LIMIT 500`,
        ),
      ]);
      return { data: { blokade: jsonSafe(blokade), audit: jsonSafe(audit) } };
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
      // Limit 100 = paritet 1.0 UI (pretragaDelovaTab searchProizvodnjaDelovi(q, 100)).
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT search_proizvodnja_delovi(${query}::text, 100::int) AS r`,
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

  // ==========================================================================
  // R2 — MUTACIJE (DEFINER/wrapper RPC kroz withUserRls; scope odluka u DB)
  // ==========================================================================
  // Sve pod SET LOCAL ROLE authenticated → can_edit_pracenje / can_manage_predmet_aktivacija
  // / admin presuđuju (42501→403, 23514→422). Enumi (aktivnost_status…) su u `production`
  // šemi (authenticated ima USAGE — verifikovano); castujemo `::production.<enum>`.

  // ---------- Operativni plan — aktivnosti (Tab2, edit) ----------

  /**
   * Upsert operativne aktivnosti (24 param; p_id null=create, postojeći=edit). NIJE
   * idempotentno preko klijentskog UUID-a (1.0 nema — p_id je server PK ili edit-id).
   * Vraća uuid aktivnosti.
   */
  async upsertAktivnost(email: string, dto: UpsertAktivnostDto) {
    const status = dto.status ?? "nije_krenulo";
    const prioritet = dto.prioritet ?? "srednji";
    const statusMode = dto.statusMode ?? "manual";
    const izvor = dto.izvor ?? "rucno";
    const rb = Number.isFinite(Number(dto.rb)) ? Number(dto.rb) : 100;
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT upsert_operativna_aktivnost(
          ${dto.id ?? null}::uuid,
          ${dto.radniNalogId ?? null}::uuid,
          ${dto.projekatId ?? null}::uuid,
          ${dto.odeljenjeId}::uuid,
          ${dto.nazivAktivnosti}::text,
          ${this.toDbDate(dto.planiraniPocetak)}::date,
          ${this.toDbDate(dto.planiraniZavrsetak)}::date,
          ${dto.odgovoranUserId ?? null}::uuid,
          ${dto.odgovoranRadnikId ?? null}::uuid,
          ${status}::production.aktivnost_status,
          ${prioritet}::production.aktivnost_prioritet,
          ${rb}::int,
          ${dto.opis ?? null}::text,
          ${dto.brojTp ?? null}::text,
          ${dto.kolicinaText ?? null}::text,
          ${dto.odgovoranLabel ?? null}::text,
          ${dto.zavisiOdAktivnostId ?? null}::uuid,
          ${dto.zavisiOdText ?? null}::text,
          ${statusMode}::production.aktivnost_status_mode,
          ${dto.rizikNapomena ?? null}::text,
          ${izvor}::production.aktivnost_izvor,
          ${dto.izvorAkcioniPlanId ?? null}::uuid,
          ${dto.izvorPozicijaId ?? null}::uuid,
          ${dto.izvorTpOperacijaId ?? null}::uuid
        ) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  /** Zatvori aktivnost (napomena opciona). */
  async zatvoriAktivnost(email: string, id: string, dto: ZatvoriAktivnostDto) {
    return this.mut(email, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT zatvori_aktivnost(${id}::uuid, ${dto.napomena ?? ""}::text)`,
      );
      return { data: { id } };
    });
  }

  /** Blokiraj aktivnost (razlog OBAVEZAN — DTO enforce). */
  async blokirajAktivnost(email: string, id: string, dto: BlokirajAktivnostDto) {
    const razlog = dto.razlog.trim();
    if (!razlog) throw new BadRequestException("Razlog blokade je obavezan.");
    return this.mut(email, async (tx) => {
      // set_blokirano je RETURNS void — $queryRaw ne ume da deserializuje void kolonu (500).
      await tx.$executeRaw(
        Prisma.sql`SELECT set_blokirano(${id}::uuid, ${razlog}::text)`,
      );
      return { data: { id } };
    });
  }

  /** Skini blokadu (napomena opciona). */
  async odblokirajAktivnost(
    email: string,
    id: string,
    dto: OdblokirajAktivnostDto,
  ) {
    return this.mut(email, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT skini_blokadu(${id}::uuid, ${dto.napomena ?? ""}::text)`,
      );
      return { data: { id } };
    });
  }

  /** Promocija akcione tačke iz Sastanaka u aktivnost (vraća novi aktivnost uuid). */
  async promoteAkcionaTacka(email: string, dto: PromoteAkcionaTackaDto) {
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT promovisi_akcionu_tacku(${dto.akcioniPlanId}::uuid,
          ${dto.odeljenjeId}::uuid, ${dto.rnId}::uuid) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  // ---------- Tabela praćenja — napomena / override-i (manage) ----------

  /** Korisnička napomena praćenja (upsert_pracenje_proizvodnje_napomena). */
  async upsertNapomena(email: string, itemId: number, dto: PracenjeNapomenaDto) {
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT upsert_pracenje_proizvodnje_napomena(${itemId}::int,
          ${BigInt(dto.bigtehnRnId)}::bigint, ${String(dto.note ?? "")}::text,
          ${dto.rnId ?? null}::uuid) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  /** Ručni override statusa/mašinske/površinske (null polje = revert na auto). */
  async upsertManualOverride(
    email: string,
    itemId: number,
    dto: PracenjeManualOverrideDto,
  ) {
    const masinska = typeof dto.masinska === "boolean" ? dto.masinska : null;
    const povrsinska = typeof dto.povrsinska === "boolean" ? dto.povrsinska : null;
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT upsert_pracenje_manual_override(${itemId}::int,
          ${BigInt(dto.bigtehnRnId)}::bigint, ${dto.status ?? null}::text,
          ${masinska}::boolean, ${povrsinska}::boolean, ${dto.rnId ?? null}::uuid) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  /** Parent override (re-parent podsklopa) ili clear (nazad na BigTehn strukturu). */
  async upsertParentOverride(
    email: string,
    itemId: number,
    dto: PracenjeParentOverrideDto,
  ) {
    const parent =
      dto.parentRnId != null && dto.parentRnId !== ""
        ? BigInt(dto.parentRnId)
        : null;
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT upsert_pracenje_parent_override(${itemId}::int,
          ${BigInt(dto.bigtehnRnId)}::bigint, ${parent}::bigint,
          ${!!dto.clear}::boolean) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  /** ↑↓ prioritet praćenja (shift_predmet_prioritet; admin — RPC sam štiti). */
  async shiftPrioritet(email: string, itemId: number, direction: string) {
    return this.mut(email, async (tx) => {
      // shift_predmet_prioritet je RETURNS void — mora $executeRaw (bez deserializacije).
      await tx.$executeRaw(
        Prisma.sql`SELECT shift_predmet_prioritet(${itemId}::int, ${direction}::text)`,
      );
      return { data: { itemId, direction } };
    });
  }

  // ---------- RN ensure (drill-down; DEFINER, svaki korisnik) ----------

  /** Materijalizuj Faza-2 RN iz BigTehn work_order-a (vraća rn uuid). */
  async ensureRnFromBigtehn(email: string, dto: EnsureRnDto) {
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT ensure_radni_nalog_iz_bigtehn(${BigInt(dto.workOrderId)}::bigint) AS r`,
      );
      return { data: { id: rows[0]?.r ?? null } };
    });
  }

  // ---------- Export-log (server-side; presuda P4 — prvi put PRORADI) ----------

  /**
   * Loguj izvoz u `audit_log` (presuda P4). 1.0 write je bio MRTAV (audit_log ima
   * no-client-write RLS za authenticated). Ovde upisujemo kroz `withUser` (konekciona
   * rola je BYPASSRLS = „servisni nalog") pa RLS ne koči; identitet iz GUC claims
   * (auth.uid()). Isti `new_data` oblik kao 1.0 logPracenjeExport.
   */
  async logExport(email: string, dto: ExportLogDto) {
    const newData = {
      rn_id: dto.rnId ?? null,
      rn_broj: dto.rnBroj ?? null,
      predmet_item_id: dto.predmetItemId ?? null,
      tab: dto.tab,
      exported_at: new Date().toISOString(),
      ...(dto.extra && typeof dto.extra === "object" ? dto.extra : {}),
    };
    try {
      await this.sy15.withUser(email, async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`INSERT INTO audit_log
              (table_name, record_id, action, actor_email, actor_uid, new_data)
            VALUES ('pracenje_proizvodnje_export', ${dto.rnId ?? null}, 'INSERT',
              ${email}, auth.uid(), ${JSON.stringify(newData)}::jsonb)`,
        );
      });
    } catch (e) {
      mapSy15Error(e);
    }
    return { data: { logged: true } };
  }

  // ---------- Crteži (bigtehn) presigned — gate can_read_production_drawings (C3) ----------

  /**
   * Presigned URL crteža iz bigtehn keša za RN side-panel (paritet 1.0). Sanitizacija +
   * revizija fallback (`{broj}_A/B`). Gate `can_read_production_drawings` — pogon
   * (cnc_operater/tim_lider/monter…) NE može otvoriti PDF (presuda C3 strogi paritet).
   */
  async crtezSignUrl(email: string, code: string) {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    const path = await this.mut(email, async (tx) => {
      const gate = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT can_read_production_drawings() AS ok`,
      );
      if (!gate[0]?.ok)
        throw new ForbiddenException("Nemate pravo na PDF crteža.");
      const exact = await tx.$queryRaw<{ storage_path: string }[]>(
        Prisma.sql`SELECT storage_path FROM bigtehn_drawings_cache
          WHERE drawing_no = ${clean} AND removed_at IS NULL LIMIT 1`,
      );
      if (exact[0]?.storage_path) return exact[0].storage_path;
      const cands = await tx.$queryRaw<
        { drawing_no: string; storage_path: string }[]
      >(
        Prisma.sql`SELECT drawing_no, storage_path FROM bigtehn_drawings_cache
          WHERE drawing_no LIKE ${clean + "%"} AND removed_at IS NULL
          ORDER BY drawing_no DESC LIMIT 50`,
      );
      const hit = cands.find(
        (c) => c.drawing_no === clean || c.drawing_no.startsWith(clean + "_"),
      );
      if (!hit?.storage_path)
        throw new NotFoundException(`Crtež ${clean} nije u kešu.`);
      return hit.storage_path;
    });
    return { data: await this.storage.signUrl(BIGTEHN_DRAWINGS_BUCKET, path, 300) };
  }

  // ---------- interno ----------

  /** 'YYYY-MM-DD' → Date za @db.Date (null = obriši). */
  private toDbDate(v?: string | null): Date | null {
    if (v == null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  private async mut<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      mapSy15Error(e);
    }
  }

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
