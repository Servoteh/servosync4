import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
} from "../sync.types";

/**
 * Handover status ids — 0/1/2/3 in `tRN.IDStatusPrimopredaje` map 1:1 onto the
 * `handover_statuses` lookup (same values as `HANDOVER_STATUS` in
 * handovers.service.ts; kept local to avoid a cross-module import).
 */
const STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  LAUNCHED: 3,
} as const;

/** Rows per `UPDATE ... FROM (VALUES ...)` statement in the remap post-step. */
const REMAP_CHUNK_SIZE = 500;

/** Remap tuple: work_orders.id (= tRN.IDRN) -> derived drawing_handovers.id. */
interface RemapTuple {
  /** tRN.IDRN = work_orders.id (1:1 sync mapping). */
  rnId: number;
  /** tRN.IDPrimopredaje — the WRONG value work_orders.drawing_handover_id holds today. */
  legacyGroupId: number;
  /** Derived drawing_handovers.id (native autoincrement). */
  handoverId: number;
}

/**
 * Derivation syncer: tRN (QBigTehn) -> drawing_handovers (Postgres).
 *
 * The legacy "primopredaja" does NOT live in `PrimopredajaCrteza` (empty even on
 * the live MSSQL) — it lives as attributes of the `tRN` row (~3.4k rows carry
 * `IDPrimopredaje > 0`). This syncer derives one `drawing_handovers` row per such
 * `tRN` row so the Na čekanju/Odobrene/Sve tabs have data before cutover.
 *
 * ID policy (deliberate, see PLAN_primopredaja_tp_cutover.md): derived rows get a
 * NATIVE autoincrement `id` — the derivation key is the unique `legacy_rn_id`
 * column (= tRN.IDRN), so the upsert is idempotent and can never collide with (or
 * silently overwrite) native 2.0 rows. `id = IDRN` was REJECTED: after
 * setval(MAX(IDRN)) a native submit takes MAX+1 while the legacy tRN identity
 * also continues from MAX+1, so the next derivation run would silently overwrite
 * the native row. No setval is needed here — Prisma `create` never sends an
 * explicit id.
 *
 * - Registered AFTER the generic loop in SyncService so it replaces the generic
 *   `PrimopredajaCrteza` mapping (whose source is empty anyway).
 * - Any inherited `bb_sync_state` cursor (moved by the old fallback) is IGNORED:
 *   every run is a full pass (~3.4k rows — cheap); newCursor marks that.
 * - `update` deliberately overwrites derived rows (legacy is the source of truth
 *   until cutover — that is what the HANDOVER_LEGACY_GUARD mutation guard is
 *   for). NATIVE rows (legacy_rn_id IS NULL) are structurally unreachable by the
 *   upsert, and `deleteMany` is never called (drawing_handovers stays in
 *   OWNED_PRODUCTION_TABLES, protected from a generic full refresh).
 *
 * Post-step: remap `work_orders.drawing_handover_id` — the generic tRN mapping
 * put `tRN.IDPrimopredaje` there, which is the id of the NACRT group
 * (IDNacrtPrim), semantically wrong. Each source row gives us (IDRN,
 * IDPrimopredaje) and the upsert gives the derived handover id, so we can fix
 * the reference in place. RUNBOOK: a force re-import of work_orders MUST run
 * with entities ["work_orders","drawing_handovers"] (SyncService honours array
 * order) so this remap runs AFTER the re-import.
 */
@Injectable()
export class HandoverDerivationSyncer implements EntitySyncer {
  readonly entity = "drawing_handovers";
  readonly defaultStrategy: SyncStrategy = "full_refresh";
  private readonly logger = new Logger(HandoverDerivationSyncer.name);

  constructor(
    private readonly mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {}

  // Options (strategy/cursor) are intentionally not consumed — see below.
  async sync(): Promise<SyncEntityResult> {
    const errors: string[] = [];

    // Always a full pass — strategy/cursor are intentionally ignored (the
    // inherited cursor was moved by the old generic fallback and means nothing
    // for the derivation). Join semantics confirmed against the legacy
    // viewPregledPrimopredaje (qbigtehn_sqlserver.sql ~l.2830-2853).
    const rows = await this.mssql.query<Record<string, unknown>>(
      `SELECT rn.[IDRN], rn.[IDCrtez], rn.[IDPrimopredaje],
              rn.[IDStatusPrimopredaje], rn.[SifraRadnikaPrimopredaje],
              rn.[SifraRadnika], rn.[DatumUnosa], rn.[DIVUnosaRN],
              rn.[DIVIspravkeRN],
              sr.[DIVUnos] AS SaglasanAt, sr.[SifraRadnikaUnos] AS SaglasanBy,
              lr.[DIVUnos] AS LansiranAt, lr.[SifraRadnikaUnos] AS LansiranBy
       FROM [dbo].[tRN] rn
       OUTER APPLY (SELECT TOP 1 [DIVUnos], [SifraRadnikaUnos]
                    FROM [dbo].[tSaglasanRN] WHERE [IDRN] = rn.[IDRN]
                    ORDER BY [DIVUnos] DESC) sr
       OUTER APPLY (SELECT TOP 1 [DIVUnos], [SifraRadnikaUnos]
                    FROM [dbo].[tLansiranRN] WHERE [IDRN] = rn.[IDRN]
                    ORDER BY [DIVUnos] DESC) lr
       WHERE rn.[IDPrimopredaje] > 0`,
    );

    // fk_drawing_handovers_drawing is NOT NULL — pre-resolve existing drawing
    // ids so unresolvable references skip the row (not the whole run).
    const drawingIds = await this.prisma.drawing
      .findMany({ select: { id: true } })
      .then((r) => new Set(r.map((x) => x.id)));

    let rowsUpserted = 0;
    let rowsSkipped = 0;
    const remaps: RemapTuple[] = [];

    for (const row of rows) {
      try {
        const { legacyRnId, legacyGroupId, data } = this.mapRow(
          row,
          drawingIds,
        );
        const upserted = await this.prisma.drawingHandover.upsert({
          where: { legacyRnId },
          create: data,
          update: data,
        });
        rowsUpserted++;
        remaps.push({
          rnId: legacyRnId,
          legacyGroupId,
          handoverId: upserted.id,
        });
      } catch (err) {
        rowsSkipped++;
        const message = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) {
          errors.push(`IDRN=${String(row["IDRN"])}: ${message}`);
        }
        this.logger.warn(
          `Skipped derived handover IDRN=${String(row["IDRN"])}: ${message}`,
        );
      }
    }

    const remapped = await this.remapWorkOrders(remaps, errors);

    const newCursor: SyncCursor = { strategy: "derived_full_pass" };
    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor,
      errors,
      note: `Derivacija iz tRN (pun prolaz); remapovano ${remapped} work_orders.drawing_handover_id referenci.`,
    };
  }

  /**
   * Map one `tRN` source row to the derived `drawing_handovers` shape.
   * Throws (-> row skip) on: unresolvable drawing FK, status outside 0-3.
   */
  private mapRow(
    r: Record<string, unknown>,
    drawingIds: Set<number>,
  ): {
    legacyRnId: number;
    legacyGroupId: number;
    data: Prisma.DrawingHandoverUncheckedCreateInput;
  } {
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const date = (v: unknown): Date | null =>
      v ? new Date(v as string) : null;

    const legacyRnId = Number(r["IDRN"]);
    const legacyGroupId = Number(r["IDPrimopredaje"]);
    const drawingId = Number(r["IDCrtez"]);
    const statusId = Number(r["IDStatusPrimopredaje"]);

    if (!drawingIds.has(drawingId)) {
      throw new Error(`drawing ${drawingId} does not exist (skipping row)`);
    }
    if (
      !Number.isInteger(statusId) ||
      statusId < STATUS.PENDING ||
      statusId > STATUS.LAUNCHED
    ) {
      throw new Error(
        `IDStatusPrimopredaje=${statusId} outside 0-3 (skipping row)`,
      );
    }

    const createdAt = date(r["DIVUnosaRN"]);
    const updatedAt = date(r["DIVIspravkeRN"]);
    const handoverDate = date(r["DatumUnosa"]) ?? createdAt;
    if (!handoverDate) {
      throw new Error("DatumUnosa and DIVUnosaRN both NULL (skipping row)");
    }

    const saglasanAt = date(r["SaglasanAt"]);
    const launched = statusId === STATUS.LAUNCHED;
    // tRN has NO Tehnolog column — the "Tehnolog" field on the legacy form goes
    // through spPromeniStatusPrimopredaje(@SifraTehnologa), which writes into
    // tRN.SifraRadnika for statuses 0/1/2 (grouped by IDPrimopredaje) and 3
    // (per row) — qbigtehn_sqlserver.sql l.12904+. Only APPROVED/LAUNCHED rows
    // carry a meaningfully assigned technologist.
    const technologistId =
      statusId === STATUS.APPROVED || launched
        ? (num(r["SifraRadnika"]) ?? 0)
        : 0;

    return {
      legacyRnId,
      legacyGroupId,
      data: {
        legacyRnId,
        drawingId,
        statusId,
        handoverWorkerId: num(r["SifraRadnikaPrimopredaje"]) ?? 0,
        technologistId,
        handoverDate,
        createdAt,
        updatedAt,
        statusChangedAt:
          saglasanAt ?? (statusId > STATUS.PENDING ? updatedAt : null),
        statusChangedById: num(r["SaglasanBy"]) ?? null,
        launchedAt: launched ? (date(r["LansiranAt"]) ?? updatedAt) : null,
        launchedById: launched ? (num(r["LansiranBy"]) ?? null) : null,
        isLocked: launched,
        note: null,
        signature: null,
        statusChangeComment: null,
      },
    };
  }

  /**
   * Post-step: fix `work_orders.drawing_handover_id` (today = tRN.IDPrimopredaje
   * = id of the NACRT group — semantically wrong) to the derived handover id.
   * The `IN (legacyGroupId, handoverId)` condition ("still holds the legacy
   * value, or is already remapped") prevents a false hit on a NATIVE work order
   * whose id happens to fall into a future IDRN range — a native RN points at a
   * native handover id, never at IDNacrtPrim. RNs without a work_orders row
   * (legacy row created after the frozen tRN sync) are simply not matched —
   * harmless.
   */
  private async remapWorkOrders(
    remaps: RemapTuple[],
    errors: string[],
  ): Promise<number> {
    let remapped = 0;
    for (let i = 0; i < remaps.length; i += REMAP_CHUNK_SIZE) {
      const chunk = remaps.slice(i, i + REMAP_CHUNK_SIZE);
      const values = Prisma.join(
        chunk.map(
          (t) => Prisma.sql`(${t.rnId}, ${t.legacyGroupId}, ${t.handoverId})`,
        ),
      );
      try {
        remapped += await this.prisma.$executeRaw(Prisma.sql`
          UPDATE work_orders AS wo
          SET drawing_handover_id = v.handover_id
          FROM (VALUES ${values}) AS v(rn_id, legacy_group_id, handover_id)
          WHERE wo.id = v.rn_id
            AND wo.drawing_handover_id IN (v.legacy_group_id, v.handover_id)
        `);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) {
          errors.push(
            `remap chunk @${i} (${chunk.length} rows) failed: ${message}`,
          );
        }
        this.logger.warn(`work_orders remap chunk @${i} failed: ${message}`);
      }
    }
    return remapped;
  }
}
