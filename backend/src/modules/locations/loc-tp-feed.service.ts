import { ConflictException, Injectable, Logger } from "@nestjs/common";
// Dva Prisma klijenta = dva runtime-a: Sql instanca MORA poticati iz klijenta koji
// je izvršava (cross-package `instanceof Sql` pada) — Prisma20 za 2.0, Prisma za sy15.
import { Prisma } from "@prisma-sy15/client";
import { Prisma as Prisma20 } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * B1 loc-most repoint (RUNBOOK_LOC_MOST_REPOINT.md): hranilica sy15 bigtehn cache
 * tabela iz 2.0 baze — zamena za legacy bridge PRODUCTION jobove (tTehPostupak je
 * frozen od gašenja Sync A lanca 14.07). Nizvodni lanac je NETAKNUT: pg_cron →
 * `loc_bigtehn_ingest_run()` i dalje čita `bigtehn_tech_routing_cache` po id
 * watermarku — menja se samo KO puni cache (2.0 `tech_processes` umesto MSSQL-a).
 *
 * Pokriva TAČNO 3 tabele koje loc ingest lanac troši: tech_routing (signali),
 * work_orders (INITIAL_PLACEMENT qty + paneli), work_order_lines (op-status panel).
 * Katalozi (items/customers/...) NISU ovde — bridge CATALOGS ostaje živ do B2
 * (bigbit-bridge aktivacija); launches/approvals/part_movements su frozen-source.
 *
 * Watermark je SOPSTVENI (`loc_tp_feed_state`, seed skriptom 10_feed_state_init.sql)
 * — NE deli se sa bridge-om preko `bridge_sync_log` (bridge upisuje prazne success
 * runove svakih 15 min, pa bi deljeni watermark tiho preskočio backlog od 14.07;
 * verify nalaz B1-OPS-1). U `bridge_sync_log` se runovi ipak UPISUJU pod legacy
 * imenima jobova — `syncHealth.cacheStale` i `monitor-sy15.sh` nastavljaju da rade
 * bez izmene — ali se odatle nikad ne čita watermark.
 */

/** Red 2.0 `tech_processes` SELECT-a, već preimenovan u cache kolone. */
export interface TpFeedRow {
  id: number;
  work_order_id: number | null;
  item_id: number | null;
  worker_id: number | null;
  quality_type_id: number | null;
  operacija: number;
  machine_code: string | null;
  komada: number;
  prn_timer_seconds: number | null;
  started_at: Date | null;
  finished_at: Date | null;
  is_completed: boolean;
  ident_broj: string | null;
  varijanta: number;
  toznaka: string | null;
  potpis: string | null;
  napomena: string | null;
  dorada_operacije: number;
}

interface WoFeedRow {
  id: number;
  item_id: number | null;
  customer_id: number | null;
  ident_broj: string | null;
  varijanta: number;
  broj_crteza: string | null;
  naziv_dela: string | null;
  materijal: string | null;
  dimenzija_materijala: string | null;
  jedinica_mere: string | null;
  komada: number;
  tezina_neobr: number;
  tezina_obr: number;
  status_rn: boolean;
  zakljucano: boolean;
  revizija: string | null;
  quality_type_id: number | null;
  handover_status_id: number | null;
  napomena: string | null;
  rok_izrade: Date | null;
  datum_unosa: Date | null;
  created_at: Date | null;
  modified_at: Date;
  author_worker_id: number | null;
}

interface LineFeedRow {
  id: number;
  work_order_id: number;
  operacija: number;
  machine_code: string | null;
  opis_rada: string | null;
  alat_pribor: string | null;
  tpz: number;
  tk: number;
  tezina_to: number;
  author_worker_id: number | null;
  created_at: Date | null;
  modified_at: Date;
  prioritet: number;
}

interface FeedState {
  lastTpId: number;
  lastWoModifiedAt: Date;
  lastLineModifiedAt: Date;
  lastRunAt: Date | null;
}

/**
 * Legacy bridge `cleanDate` paritet: BigTehn sentinel datumi (godina <= 1901)
 * postaju NULL — ingest `too_old` grana i FE formatiranje ih ne smeju videti.
 */
export function cleanCacheDate(d: Date | null | undefined): Date | null {
  if (!d) return null;
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() <= 1901) return null;
  return d;
}

/**
 * Holdback rez (verify nalaz B1-DATA-4, id-gap trka): redovi se hrane STROGO u
 * id-rastućem redosledu, ali samo prefiks stariji od cutoff-a. Prisma interaktivna
 * transakcija može commit-ovati red sa MANJIM id-jem POSLE reda sa većim (duže
 * transakcije u scan/control putanjama) — kad bi mlad red odmah ušao u cache,
 * nizvodni id-watermark ingest bi zauvek preskočio kasnije commit-ovanog suseda.
 * Sve mlađe od cutoff-a (uklj. sve IZA prvog mladog reda, da se ne probuši
 * redosled) čeka sledeći run — kadenca feed-a je minuti, kašnjenje je bezopasno.
 */
export function cutAtHoldback<T extends { started_at: Date | null }>(
  rows: T[],
  cutoff: Date,
): { fed: T[]; held: number } {
  const idx = rows.findIndex(
    (r) => r.started_at !== null && r.started_at >= cutoff,
  );
  if (idx === -1) return { fed: rows, held: 0 };
  return { fed: rows.slice(0, idx), held: rows.length - idx };
}

/** Legacy `syncWorkOrders.js` paritet: prazan ident dobija `(no-<id>)` (NOT NULL kolona). */
export function woIdentFallback(ident: string | null, id: number): string {
  return ident ?? `(no-${id})`;
}

const TP_BATCH = 1000;
const DELTA_BATCH = 1000;
const UPSERT_CHUNK = 400;
const MAX_LOOPS = 20;
/** Vidi `cutAtHoldback` — 2 min pokriva svaku realnu 2.0 transakciju. */
const HOLDBACK_MS = 2 * 60_000;
/** Legacy watermark.js paritet: -60s overlap na timestamp delte (upsert = idempotentan). */
const OVERLAP_MS = 60_000;
/** Refresh otvorenih TP redova: ingest ionako ignoriše starije od 30 dana (p_max_age_days). */
const REFRESH_OPEN_DAYS = 30;
const REFRESH_CLOSED_GRACE_MS = 15 * 60_000;
const REFRESH_LIMIT = 5000;

@Injectable()
export class LocTpFeedService {
  private readonly logger = new Logger(LocTpFeedService.name);
  /** In-process overlap guard (PLK-02 klasa) — feed sme da radi samo jedan odjednom. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sy15: Sy15Service,
  ) {}

  /** Admin/cron ulaz: jedan kompletan feed ciklus (tech_routing + WO + lines). */
  async run() {
    if (this.running) {
      throw new ConflictException("feed-run je već u toku (overlap guard)");
    }
    this.running = true;
    const startedAt = new Date();
    try {
      const state = await this.loadState();

      const tp = await this.logJob("production_tech_routing", () =>
        this.feedTechRouting(state),
      );
      const workOrders = await this.logJob("production_work_orders", () =>
        this.feedWorkOrders(state),
      );
      const lines = await this.logJob("production_work_order_lines", () =>
        this.feedLines(state),
      );

      const summary = {
        started_at: startedAt,
        finished_at: new Date(),
        tp,
        work_orders: workOrders,
        lines,
      };
      await this.sy15.db.$executeRaw`
        UPDATE loc_tp_feed_state
           SET last_tp_id = ${tp.lastTpId},
               last_wo_modified_at = ${workOrders.watermark},
               last_line_modified_at = ${lines.watermark},
               last_run_at = now(),
               last_run_summary = ${JSON.stringify(summary)}::jsonb,
               updated_at = now()
         WHERE id = 1`;

      return { data: summary };
    } finally {
      this.running = false;
    }
  }

  /** Stanje feed-a (watermarks + poslednji run) — admin Sync tab / verifikacija runbook koraka. */
  async status() {
    const rows = await this.sy15.db.$queryRaw<
      {
        last_tp_id: bigint | number;
        last_wo_modified_at: Date;
        last_line_modified_at: Date;
        last_run_at: Date | null;
        last_run_summary: unknown;
        updated_at: Date;
      }[]
    >`SELECT last_tp_id, last_wo_modified_at, last_line_modified_at,
             last_run_at, last_run_summary, updated_at
        FROM loc_tp_feed_state WHERE id = 1`;
    const s = rows[0];
    return {
      data: s
        ? {
            initialized: true,
            running: this.running,
            lastTpId: Number(s.last_tp_id),
            lastWoModifiedAt: s.last_wo_modified_at,
            lastLineModifiedAt: s.last_line_modified_at,
            lastRunAt: s.last_run_at,
            lastRunSummary: s.last_run_summary,
            updatedAt: s.updated_at,
          }
        : { initialized: false, running: this.running },
    };
  }

  private async loadState(): Promise<FeedState> {
    const rows = await this.sy15.db.$queryRaw<
      {
        last_tp_id: bigint | number;
        last_wo_modified_at: Date;
        last_line_modified_at: Date;
        last_run_at: Date | null;
      }[]
    >`SELECT last_tp_id, last_wo_modified_at, last_line_modified_at, last_run_at
        FROM loc_tp_feed_state WHERE id = 1`;
    if (!rows[0]) {
      throw new ConflictException(
        "loc_tp_feed_state nije inicijalizovan — izvršiti docs/sql/sy15/loc-most-repoint/10_feed_state_init.sql (runbook korak 1)",
      );
    }
    return {
      lastTpId: Number(rows[0].last_tp_id),
      lastWoModifiedAt: rows[0].last_wo_modified_at,
      lastLineModifiedAt: rows[0].last_line_modified_at,
      lastRunAt: rows[0].last_run_at,
    };
  }

  /**
   * Run zapis u `bridge_sync_log` pod LEGACY imenom joba (monitoring paritet:
   * syncHealth cacheStale pragovi + monitor-sy15.sh čitaju ova imena). Metrika ide
   * u `rows_updated` (legacy finishRun paritet). Watermark se odavde NIKAD ne čita.
   */
  private async logJob<T extends { rows: number }>(
    job: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = new Date();
    const idRows = await this.sy15.db.$queryRaw<{ id: bigint }[]>`
      INSERT INTO bridge_sync_log (sync_job, started_at, status)
      VALUES (${job}, ${started}, 'running') RETURNING id`;
    const logId = idRows[0]?.id;
    try {
      const result = await fn();
      await this.sy15.db.$executeRaw`
        UPDATE bridge_sync_log
           SET finished_at = now(), status = 'success',
               rows_updated = ${result.rows},
               duration_ms = ${Date.now() - started.getTime()}
         WHERE id = ${logId}`;
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.sy15.db.$executeRaw`
        UPDATE bridge_sync_log
           SET finished_at = now(), status = 'error',
               error_message = ${message.slice(0, 4000)},
               duration_ms = ${Date.now() - started.getTime()}
         WHERE id = ${logId}`;
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // tech_processes → bigtehn_tech_routing_cache
  // --------------------------------------------------------------------------

  private async feedTechRouting(state: FeedState) {
    let lastTpId = state.lastTpId;
    let fed = 0;
    let heldBack = 0;
    let stornoSkipped = 0;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const rows = await this.selectTpRows(
        Prisma20.sql`tp.id > ${lastTpId}`,
        TP_BATCH,
      );
      if (rows.length === 0) break;

      const cutoff = new Date(Date.now() - HOLDBACK_MS);
      const { fed: fedRows, held } = cutAtHoldback(rows, cutoff);
      heldBack += held;
      if (fedRows.length === 0) break;

      // Storno kontra-redovi (piece_count < 0) se NE hrane (verify B1-DATA-6:
      // negativan komada bi prošao ingest gate i pravio lažni transfer na mašinu
      // stornirane operacije) — ali POMERAJU watermark (svesno odbačeni, ne pending).
      const upsertable = fedRows.filter((r) => r.komada >= 0);
      stornoSkipped += fedRows.length - upsertable.length;
      await this.upsertTechRouting(upsertable);
      fed += upsertable.length;
      lastTpId = fedRows[fedRows.length - 1].id;

      if (held > 0 || rows.length < TP_BATCH) break;
    }

    // Refresh: otvoreni redovi (kumulativ komada raste UPDATE-om bez novog id-ja —
    // verify B1-OPS-8 delta slepa mrlja) + skoro zatvoreni (STOP/kontrola posle
    // poslednjeg run-a). Idempotentan upsert po PK — re-slanje je bezopasno.
    const refreshSince = state.lastRunAt
      ? new Date(state.lastRunAt.getTime() - REFRESH_CLOSED_GRACE_MS)
      : new Date(Date.now() - 24 * 3600_000);
    const refreshRows = await this.selectTpRows(
      Prisma20.sql`tp.id <= ${lastTpId} AND tp.piece_count >= 0 AND (
        (COALESCE(tp.is_process_finished, false) = false
          AND tp.entered_at >= now() - make_interval(days => ${REFRESH_OPEN_DAYS}))
        OR tp.finished_at >= ${refreshSince})`,
      REFRESH_LIMIT,
    );
    await this.upsertTechRouting(refreshRows);
    if (refreshRows.length === REFRESH_LIMIT) {
      // Bez tihog seckanja: 5000 = abnormalno velik otvoren skup, mora se videti.
      this.logger.warn(
        `feedTechRouting: refresh pogodio LIMIT ${REFRESH_LIMIT} — otvoren skup je neočekivano velik`,
      );
    }

    return {
      rows: fed + refreshRows.length,
      fed,
      refreshed: refreshRows.length,
      heldBack,
      stornoSkipped,
      lastTpId,
    };
  }

  /**
   * Mapiranje kolona = legacy `syncTechRouting.js` paritet (tTehPostupak aliasi),
   * izvor 2.0 `tech_processes` (schema-rename-map: IdentBroj→ident_number,
   * RJgrupaRC→work_center_code, Komada→piece_count, DatumIVremeUnosa→entered_at...).
   * NULLIF(x,0) replicira legacy „0 = nema FK" konvenciju; BTRIM+NULLIF('')
   * replicira `emptyToNull`. Napomena o `p.id`-u: isti IDPostupka prostor
   * (tech_processes 1:1 sinhronizovan do 14.07) → ingest watermark važi bez reseta.
   */
  private selectTpRows(
    where: Prisma20.Sql,
    limit: number,
  ): Promise<TpFeedRow[]> {
    // Napomena: where/limit su Prisma.Sql/parametri — nema string interpolacije.
    return this.prisma.$queryRaw<TpFeedRow[]>(
      Prisma20.sql`
      SELECT tp.id                                    AS id,
             NULLIF(tp.work_order_id, 0)              AS work_order_id,
             NULLIF(tp.project_id, 0)                 AS item_id,
             NULLIF(tp.worker_id, 0)                  AS worker_id,
             NULLIF(tp.quality_type_id, 0)            AS quality_type_id,
             tp.operation_number                      AS operacija,
             NULLIF(BTRIM(tp.work_center_code), '')   AS machine_code,
             tp.piece_count                           AS komada,
             tp.print_timer                           AS prn_timer_seconds,
             tp.entered_at                            AS started_at,
             tp.finished_at                           AS finished_at,
             COALESCE(tp.is_process_finished, false)  AS is_completed,
             NULLIF(BTRIM(tp.ident_number), '')       AS ident_broj,
             tp.variant                               AS varijanta,
             NULLIF(BTRIM(tp.ident_mark), '')         AS toznaka,
             NULLIF(BTRIM(tp.signature), '')          AS potpis,
             NULLIF(BTRIM(tp.note), '')               AS napomena,
             COALESCE(tp.rework_operation_id, 0)      AS dorada_operacije
        FROM tech_processes tp
       WHERE ${where}
       ORDER BY tp.id ASC
       LIMIT ${limit}`,
    );
  }

  private async upsertTechRouting(rows: TpFeedRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const values = chunk.map(
        (r) => Prisma.sql`(${r.id}, ${r.work_order_id}, ${r.item_id},
          ${r.worker_id}, ${r.quality_type_id}, ${r.operacija}, ${r.machine_code},
          ${r.komada}, ${r.prn_timer_seconds}, ${cleanCacheDate(r.started_at)},
          ${cleanCacheDate(r.finished_at)}, ${r.is_completed}, ${r.ident_broj},
          ${r.varijanta}, ${r.toznaka}, ${r.potpis}, ${r.napomena},
          ${r.dorada_operacije}, now())`,
      );
      await this.sy15.db.$executeRaw(Prisma.sql`
        INSERT INTO bigtehn_tech_routing_cache
          (id, work_order_id, item_id, worker_id, quality_type_id, operacija,
           machine_code, komada, prn_timer_seconds, started_at, finished_at,
           is_completed, ident_broj, varijanta, toznaka, potpis, napomena,
           dorada_operacije, synced_at)
        VALUES ${Prisma.join(values)}
        ON CONFLICT (id) DO UPDATE SET
          work_order_id = EXCLUDED.work_order_id,
          item_id = EXCLUDED.item_id,
          worker_id = EXCLUDED.worker_id,
          quality_type_id = EXCLUDED.quality_type_id,
          operacija = EXCLUDED.operacija,
          machine_code = EXCLUDED.machine_code,
          komada = EXCLUDED.komada,
          prn_timer_seconds = EXCLUDED.prn_timer_seconds,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at,
          is_completed = EXCLUDED.is_completed,
          ident_broj = EXCLUDED.ident_broj,
          varijanta = EXCLUDED.varijanta,
          toznaka = EXCLUDED.toznaka,
          potpis = EXCLUDED.potpis,
          napomena = EXCLUDED.napomena,
          dorada_operacije = EXCLUDED.dorada_operacije,
          synced_at = EXCLUDED.synced_at`);
    }
  }

  // --------------------------------------------------------------------------
  // work_orders → bigtehn_work_orders_cache
  // --------------------------------------------------------------------------

  /**
   * PUN skup kolona legacy `syncWorkOrders.js` mapRow-a (verify B1-DATA-3:
   * item_id/customer_id/varijanta... su ŽIVI 1.0+2.0 potrošači — tab Predmet,
   * pickeri, loc_tps_for_predmet). BBIDKomitent→external_customer_id,
   * DatumUnosa→entered_at, DIVIspravkeRN→updated_at (watermark).
   */
  private async feedWorkOrders(state: FeedState) {
    let since = new Date(state.lastWoModifiedAt.getTime() - OVERLAP_MS);
    let watermark = state.lastWoModifiedAt;
    let fed = 0;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const rows = await this.prisma.$queryRaw<WoFeedRow[]>(
        Prisma20.sql`
        SELECT wo.id                                       AS id,
               NULLIF(wo.project_id, 0)                    AS item_id,
               NULLIF(wo.external_customer_id, 0)          AS customer_id,
               NULLIF(BTRIM(wo.ident_number), '')          AS ident_broj,
               wo.variant                                  AS varijanta,
               NULLIF(BTRIM(wo.drawing_number), '')        AS broj_crteza,
               NULLIF(BTRIM(wo.part_name), '')             AS naziv_dela,
               NULLIF(BTRIM(wo.material), '')              AS materijal,
               NULLIF(BTRIM(wo.material_dimension), '')    AS dimenzija_materijala,
               NULLIF(BTRIM(wo.unit), '')                  AS jedinica_mere,
               wo.piece_count                              AS komada,
               COALESCE(wo.unprocessed_part_weight, 0)     AS tezina_neobr,
               COALESCE(wo.processed_part_weight, 0)       AS tezina_obr,
               COALESCE(wo.status, false)                  AS status_rn,
               COALESCE(wo.is_locked, false)               AS zakljucano,
               NULLIF(BTRIM(wo.revision), '')              AS revizija,
               NULLIF(wo.quality_type_id, 0)               AS quality_type_id,
               wo.handover_status_id                       AS handover_status_id,
               NULLIF(BTRIM(wo.note), '')                  AS napomena,
               wo.production_deadline                      AS rok_izrade,
               wo.entered_at                               AS datum_unosa,
               wo.created_at                               AS created_at,
               wo.updated_at                               AS modified_at,
               NULLIF(wo.worker_id, 0)                     AS author_worker_id
          FROM work_orders wo
         WHERE wo.updated_at > ${since}
         ORDER BY wo.updated_at ASC
         LIMIT ${DELTA_BATCH}`,
      );
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const values = chunk.map(
          (r) => Prisma.sql`(${r.id}, ${r.item_id}, ${r.customer_id},
            ${woIdentFallback(r.ident_broj, r.id)}, ${r.varijanta},
            ${r.broj_crteza}, ${r.naziv_dela}, ${r.materijal},
            ${r.dimenzija_materijala}, ${r.jedinica_mere}, ${r.komada},
            ${r.tezina_neobr}, ${r.tezina_obr}, ${r.status_rn}, ${r.zakljucano},
            ${r.revizija}, ${r.quality_type_id}, ${r.handover_status_id},
            ${r.napomena}, ${cleanCacheDate(r.rok_izrade)},
            ${cleanCacheDate(r.datum_unosa)}, ${cleanCacheDate(r.created_at)},
            ${cleanCacheDate(r.modified_at)}, ${r.author_worker_id}, now())`,
        );
        await this.sy15.db.$executeRaw(Prisma.sql`
          INSERT INTO bigtehn_work_orders_cache
            (id, item_id, customer_id, ident_broj, varijanta, broj_crteza,
             naziv_dela, materijal, dimenzija_materijala, jedinica_mere, komada,
             tezina_neobr, tezina_obr, status_rn, zakljucano, revizija,
             quality_type_id, handover_status_id, napomena, rok_izrade,
             datum_unosa, created_at, modified_at, author_worker_id, synced_at)
          VALUES ${Prisma.join(values)}
          ON CONFLICT (id) DO UPDATE SET
            item_id = EXCLUDED.item_id,
            customer_id = EXCLUDED.customer_id,
            ident_broj = EXCLUDED.ident_broj,
            varijanta = EXCLUDED.varijanta,
            broj_crteza = EXCLUDED.broj_crteza,
            naziv_dela = EXCLUDED.naziv_dela,
            materijal = EXCLUDED.materijal,
            dimenzija_materijala = EXCLUDED.dimenzija_materijala,
            jedinica_mere = EXCLUDED.jedinica_mere,
            komada = EXCLUDED.komada,
            tezina_neobr = EXCLUDED.tezina_neobr,
            tezina_obr = EXCLUDED.tezina_obr,
            status_rn = EXCLUDED.status_rn,
            zakljucano = EXCLUDED.zakljucano,
            revizija = EXCLUDED.revizija,
            quality_type_id = EXCLUDED.quality_type_id,
            handover_status_id = EXCLUDED.handover_status_id,
            napomena = EXCLUDED.napomena,
            rok_izrade = EXCLUDED.rok_izrade,
            datum_unosa = EXCLUDED.datum_unosa,
            created_at = EXCLUDED.created_at,
            modified_at = EXCLUDED.modified_at,
            author_worker_id = EXCLUDED.author_worker_id,
            synced_at = EXCLUDED.synced_at`);
      }

      fed += rows.length;
      const last = rows[rows.length - 1].modified_at;
      if (last > watermark) watermark = last;
      since = last;
      if (rows.length < DELTA_BATCH) break;
    }

    return { rows: fed, watermark };
  }

  // --------------------------------------------------------------------------
  // work_order_operations → bigtehn_work_order_lines_cache
  // --------------------------------------------------------------------------

  /** Legacy `syncWorkOrderLines.js` paritet (tStavkeRN): Tpz→setup_time, Tk→cycle_time... */
  private async feedLines(state: FeedState) {
    let since = new Date(state.lastLineModifiedAt.getTime() - OVERLAP_MS);
    let watermark = state.lastLineModifiedAt;
    let fed = 0;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const rows = await this.prisma.$queryRaw<LineFeedRow[]>(
        Prisma20.sql`
        SELECT op.id                                   AS id,
               op.work_order_id                        AS work_order_id,
               op.operation_number                     AS operacija,
               NULLIF(BTRIM(op.work_center_code), '')  AS machine_code,
               NULLIF(BTRIM(op.work_description), '')  AS opis_rada,
               NULLIF(BTRIM(op.tools_fixtures), '')    AS alat_pribor,
               COALESCE(op.setup_time, 0)              AS tpz,
               COALESCE(op.cycle_time, 0)              AS tk,
               COALESCE(op.tool_weight, 0)             AS tezina_to,
               NULLIF(op.worker_id, 0)                 AS author_worker_id,
               op.created_at                           AS created_at,
               op.updated_at                           AS modified_at,
               op.priority                             AS prioritet
          FROM work_order_operations op
         WHERE op.updated_at > ${since}
         ORDER BY op.updated_at ASC
         LIMIT ${DELTA_BATCH}`,
      );
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        const values = chunk.map(
          (r) => Prisma.sql`(${r.id}, ${r.work_order_id}, ${r.operacija},
            ${r.machine_code}, ${r.opis_rada}, ${r.alat_pribor}, ${r.tpz},
            ${r.tk}, ${r.tezina_to}, ${r.author_worker_id},
            ${cleanCacheDate(r.created_at)}, ${cleanCacheDate(r.modified_at)},
            ${r.prioritet}, now())`,
        );
        await this.sy15.db.$executeRaw(Prisma.sql`
          INSERT INTO bigtehn_work_order_lines_cache
            (id, work_order_id, operacija, machine_code, opis_rada, alat_pribor,
             tpz, tk, tezina_to, author_worker_id, created_at, modified_at,
             prioritet, synced_at)
          VALUES ${Prisma.join(values)}
          ON CONFLICT (id) DO UPDATE SET
            work_order_id = EXCLUDED.work_order_id,
            operacija = EXCLUDED.operacija,
            machine_code = EXCLUDED.machine_code,
            opis_rada = EXCLUDED.opis_rada,
            alat_pribor = EXCLUDED.alat_pribor,
            tpz = EXCLUDED.tpz,
            tk = EXCLUDED.tk,
            tezina_to = EXCLUDED.tezina_to,
            author_worker_id = EXCLUDED.author_worker_id,
            created_at = EXCLUDED.created_at,
            modified_at = EXCLUDED.modified_at,
            prioritet = EXCLUDED.prioritet,
            synced_at = EXCLUDED.synced_at`);
      }

      fed += rows.length;
      const last = rows[rows.length - 1].modified_at;
      if (last > watermark) watermark = last;
      since = last;
      if (rows.length < DELTA_BATCH) break;
    }

    return { rows: fed, watermark };
  }
}
