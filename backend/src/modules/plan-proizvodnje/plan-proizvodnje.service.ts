import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { jsonSafe } from "../../common/json-safe";
import { machineGroupSlug } from "./departments";
import type {
  BulkReassignDto,
  CooperationGroupPatchDto,
  CooperationGroupUpsertDto,
  OverlayReorderDto,
  OverlayUpsertDto,
  ReassignDto,
  SetUrgentDto,
} from "./dto/plan-proizvodnje-mutation.dto";

type Tx = Prisma.TransactionClient;

/** Dozvoljeni MIME tipovi za skice (port 1.0 drawingManager ALLOWED_MIMES). */
const ALLOWED_DRAWING_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];

/**
 * Plan proizvodnje — WRITE (mutacioni) sloj nad 2.0 app-owned `plan_proizvodnje_*`
 * tabelama (F5b, plan §4.2 (b)/(c)/(e)). Zamena za sy15 DEFINER RPC-ove
 * (`reassign_production_line`, overlay/urgency/koop upsert-e) i storage bucket —
 * sve sada kroz `PrismaService` (glavna baza). Autorizacija: kontroler gejtuje
 * `plan_proizvodnje.edit` (+ `.force` za forsirani reassign, `.koop_admin` za grupe);
 * sy15 RLS (`can_edit_plan_proizvodnje`) više NE presuđuje (ugašen most).
 *
 * `reassign` je verni port sy15 RPC-a (snapshot:3313-3437): group-mismatch gate
 * (`machine_group_mismatch` → 422), force gate (`force_reason` ≥3 + `plan_proizvodnje.force`
 * → 403), idempotencija audita `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`.
 * BE je sada KONAČNI gate (nema DB DEFINER-a) — pokriveno testom.
 *
 * id-jevi (`work_order_id`/`line_id`) su Int u native tabelama (ISTI id prostor kao
 * work_orders/work_order_operations); FE šalje stringove (M3) → `Number(...)`.
 */
@Injectable()
export class PlanProizvodnjeService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================================
  // Overlays (merge upsert)
  // ==========================================================================

  /**
   * Overlay UPSERT (patch, merge — samo poslata polja se menjaju; ON CONFLICT
   * (work_order_id, line_id)). Audit kolone (cam_ready_at/by, ready_override_at/by,
   * cooperation_set_at/by) stampuje server. `updated_by`/`created_by` = email.
   */
  async upsertOverlay(email: string, dto: OverlayUpsertDto) {
    const wo = Number(dto.workOrderId);
    const line = Number(dto.lineId);
    const now = new Date();
    const patch: Record<string, unknown> = {};
    if (dto.localStatus !== undefined) patch.localStatus = dto.localStatus;
    if (dto.shiftNote !== undefined) patch.shiftNote = dto.shiftNote;
    // Pin-marker: klijent šalje shiftSortOrder=-1 kao „pin-to-top" signal.
    // Kanon (1.0 pinToTop): vrednost = MIN(shift_sort_order ručnih iste efektivne
    // mašine) − 1 (bez ručnih → 1). Ostale vrednosti (drag redosled, null=unpin) prolaze
    // doslovno. Računa se u tx (delta min nad overlay ⋈ linija).
    const isPinMarker = dto.shiftSortOrder === -1;
    if (dto.shiftSortOrder !== undefined && !isPinMarker)
      patch.shiftSortOrder = dto.shiftSortOrder;
    if (dto.assignedMachineCode !== undefined)
      patch.assignedMachineCode = dto.assignedMachineCode;
    if (dto.camReady !== undefined) {
      patch.camReady = dto.camReady;
      patch.camReadyAt = dto.camReady ? now : null;
      patch.camReadyBy = dto.camReady ? email : null;
    }
    if (dto.readyOverride !== undefined) {
      patch.readyOverride = dto.readyOverride;
      patch.readyOverrideAt = dto.readyOverride ? now : null;
      patch.readyOverrideBy = dto.readyOverride ? email : null;
    }
    if (dto.cooperationStatus !== undefined) {
      patch.cooperationStatus = dto.cooperationStatus;
      if (dto.cooperationStatus === "none") {
        patch.cooperationPartner = null;
        patch.cooperationExpectedReturn = null;
        patch.cooperationSetBy = null;
        patch.cooperationSetAt = null;
      } else {
        if (dto.cooperationPartner !== undefined)
          patch.cooperationPartner = dto.cooperationPartner;
        patch.cooperationExpectedReturn = this.toDbDate(
          dto.cooperationExpectedReturn,
        );
        patch.cooperationSetBy = email;
        patch.cooperationSetAt = now;
      }
    }
    return this.prisma.$transaction(async (tx) => {
      if (isPinMarker) {
        patch.shiftSortOrder = await this.resolvePinOrder(tx, wo, line);
      }
      const row = await tx.planProizvodnjeOverlay.upsert({
        where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
        create: {
          workOrderId: wo,
          lineId: line,
          ...patch,
          createdBy: email,
          updatedBy: email,
        },
        update: { ...patch, updatedBy: email, updatedAt: now },
      });
      return { data: jsonSafe(row) };
    });
  }

  /**
   * Pin-to-top kanon (1.0 pinToTop): MIN(shift_sort_order) postojećih RUČNIH
   * (NOT NULL) operacija ISTE efektivne mašine kao ciljna linija, minus 1. Bez ručnih
   * redova → 1. Ciljna operacija se isključuje. Efektivna mašina = COALESCE(overlay
   * assigned, work_order_operations.work_center_code) — poštuje reassign.
   */
  private async resolvePinOrder(
    tx: Tx,
    wo: number,
    line: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ min_order: number | null }[]>(Prisma.sql`
      SELECT MIN(o.shift_sort_order)::int AS min_order
        FROM plan_proizvodnje_overlays o
        JOIN work_order_operations l ON l.work_order_id = o.work_order_id AND l.id = o.line_id
       WHERE COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) = (
               SELECT COALESCE(o2.assigned_machine_code, NULLIF(BTRIM(l2.work_center_code), ''))
                 FROM work_order_operations l2
                 LEFT JOIN plan_proizvodnje_overlays o2
                   ON o2.work_order_id = l2.work_order_id AND o2.line_id = l2.id
                WHERE l2.work_order_id = ${wo} AND l2.id = ${line} LIMIT 1
             )
         AND o.shift_sort_order IS NOT NULL
         AND NOT (o.work_order_id = ${wo} AND o.line_id = ${line})`);
    const min = rows[0]?.min_order;
    return min != null ? min - 1 : 1;
  }

  /** Bulk reorder — `shift_sort_order` = 1..n u datom redosledu (jedan tx). */
  async reorderOverlays(email: string, dto: OverlayReorderDto) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < dto.items.length; i++) {
        const it = dto.items[i];
        const wo = Number(it.workOrderId);
        const line = Number(it.lineId);
        await tx.planProizvodnjeOverlay.upsert({
          where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
          create: {
            workOrderId: wo,
            lineId: line,
            shiftSortOrder: i + 1,
            createdBy: email,
            updatedBy: email,
          },
          update: { shiftSortOrder: i + 1, updatedBy: email, updatedAt: now },
        });
      }
      return { data: { reordered: dto.items.length } };
    });
  }

  // ==========================================================================
  // Urgency (HITNO) — set/clear, DELETE nikad
  // ==========================================================================

  /** HITNO set (merge upsert; reset cleared_*). Unique work_order_id, DELETE nikad. */
  async setUrgent(email: string, workOrderId: string, dto: SetUrgentDto) {
    const wo = Number(workOrderId);
    const reason = (dto.reason ?? "").trim() || null;
    const row = await this.prisma.planProizvodnjeUrgency.upsert({
      where: { workOrderId: wo },
      create: { workOrderId: wo, isUrgent: true, reason, setBy: email },
      update: {
        isUrgent: true,
        reason,
        setBy: email,
        setAt: new Date(),
        clearedAt: null,
        clearedBy: null,
      },
    });
    return { data: jsonSafe(row) };
  }

  /** HITNO clear = flag off + cleared_* (NE briše red; paritet 1.0 clearUrgent). */
  async clearUrgent(email: string, workOrderId: string) {
    const wo = Number(workOrderId);
    const row = await this.prisma.planProizvodnjeUrgency.upsert({
      where: { workOrderId: wo },
      create: {
        workOrderId: wo,
        isUrgent: false,
        clearedAt: new Date(),
        clearedBy: email,
      },
      update: { isUrgent: false, clearedAt: new Date(), clearedBy: email },
    });
    return { data: jsonSafe(row) };
  }

  // ==========================================================================
  // Reassign (port sy15 reassign_production_line)
  // ==========================================================================

  /**
   * Reassign jedne linije (verni port RPC-a). `canForce` = da li korisnik ima
   * `plan_proizvodnje.force` (kontroler računa iz role) — BE je konačni gate.
   * group-mismatch bez force → 422; force bez prava → 403; force_reason<3 → 422.
   */
  async reassign(email: string, dto: ReassignDto, canForce: boolean) {
    const cev = dto.clientEventId ?? randomUUID();
    return this.prisma.$transaction((tx) =>
      this.reassignOne(
        tx,
        email,
        canForce,
        Number(dto.workOrderId),
        Number(dto.lineId),
        dto.targetMachine ?? null,
        !!dto.force,
        dto.reason ?? null,
        cev,
      ),
    );
  }

  /** Bulk reassign (JEDAN client_event_uuid za ceo bulk; paritet 1.0). */
  async bulkReassign(email: string, dto: BulkReassignDto, canForce: boolean) {
    const cev = dto.clientEventId ?? randomUUID();
    return this.prisma.$transaction(async (tx) => {
      let count = 0;
      for (const p of dto.pairs) {
        await this.reassignOne(
          tx,
          email,
          canForce,
          Number(p.workOrderId),
          Number(p.lineId),
          dto.targetMachine ?? null,
          !!dto.force,
          dto.reason ?? null,
          cev,
        );
        count += 1;
      }
      return { data: { updated_count: count } };
    });
  }

  /** Jedan reassign u tx — overlay upsert + (ako forsiran) audit ON CONFLICT DO NOTHING. */
  private async reassignOne(
    tx: Tx,
    email: string,
    canForce: boolean,
    wo: number,
    line: number,
    targetRaw: string | null,
    force: boolean,
    reason: string | null,
    cev: string,
  ) {
    const rows = await tx.$queryRaw<
      { original_machine: string | null; source_machine: string | null }[]
    >(Prisma.sql`
      SELECT NULLIF(BTRIM(l.work_center_code), '') AS original_machine,
             COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) AS source_machine
        FROM work_order_operations l
        LEFT JOIN plan_proizvodnje_overlays o
          ON o.work_order_id = l.work_order_id AND o.line_id = l.id
       WHERE l.work_order_id = ${wo} AND l.id = ${line} LIMIT 1`);
    const original = rows[0]?.original_machine ?? null;
    const source = rows[0]?.source_machine ?? null;
    if (original === null) {
      throw new UnprocessableEntityException("operation_not_found");
    }

    let target: string | null = (targetRaw ?? "").trim() || null;
    // Izbor originalne mašine = „vrati na original" = NULL overlay.
    if (target !== null && target === original) target = null;

    let sourceGroup: string;
    let targetGroup: string;
    let forced = false;

    if (target !== null) {
      const exists = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
        SELECT EXISTS (SELECT 1 FROM operations m WHERE m.work_center_code = ${target}) AS ok`);
      if (!exists[0]?.ok) {
        throw new UnprocessableEntityException("target_machine_not_found");
      }
      sourceGroup = machineGroupSlug(source);
      targetGroup = machineGroupSlug(target);
      if (sourceGroup !== targetGroup) {
        if (!force) {
          throw new UnprocessableEntityException("machine_group_mismatch");
        }
        if (!canForce) {
          throw new ForbiddenException("force_reassign_forbidden");
        }
        if (reason === null || reason.trim().length < 3) {
          throw new UnprocessableEntityException("force_reason_required");
        }
        forced = true;
      }
    } else {
      sourceGroup = machineGroupSlug(source);
      targetGroup = machineGroupSlug(original);
    }

    await tx.planProizvodnjeOverlay.upsert({
      where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
      create: {
        workOrderId: wo,
        lineId: line,
        assignedMachineCode: target,
        createdBy: email,
        updatedBy: email,
      },
      update: { assignedMachineCode: target, updatedBy: email },
    });

    if (forced) {
      // Idempotencija po (client_event_uuid, line_id) — paritet sy15
      // `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO plan_proizvodnje_reassign_audit
          (work_order_id, line_id, actor_email, from_machine_code, to_machine_code,
           source_group, target_group, forced, force_reason, client_event_uuid)
        VALUES (${wo}, ${line}, ${email}, ${source}, ${target},
                ${sourceGroup}, ${targetGroup}, true, ${reason!.trim()}, ${cev}::uuid)
        ON CONFLICT (client_event_uuid, line_id) DO NOTHING`);
    }

    return {
      data: {
        work_order_id: String(wo),
        line_id: String(line),
        assigned_machine_code: target,
        source_group: sourceGroup,
        target_group: targetGroup,
        forced,
      },
    };
  }

  // ==========================================================================
  // Kooperacija — auto grupe (admin; DELETE nikad, soft removed_at)
  // ==========================================================================

  /** Upsert auto-koop grupe (ON CONFLICT rj_group_code; restore = removed_at→NULL). */
  async upsertCooperationGroup(email: string, dto: CooperationGroupUpsertDto) {
    const rows = await this.prisma.$queryRaw(Prisma.sql`
      INSERT INTO plan_proizvodnje_auto_cooperation_groups
          (rj_group_code, group_label, notes, added_by, added_at)
        VALUES (${dto.rjGroupCode}, ${dto.groupLabel}, ${dto.notes ?? null}, ${email}, now())
        ON CONFLICT (rj_group_code) DO UPDATE SET
          group_label = EXCLUDED.group_label,
          notes = EXCLUDED.notes,
          removed_at = NULL, removed_by = NULL
        RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`);
    return { data: jsonSafe((rows as unknown[])[0] ?? null) };
  }

  /** Izmena/soft-remove/restore auto-koop grupe. */
  async patchCooperationGroup(
    email: string,
    code: string,
    dto: CooperationGroupPatchDto,
  ) {
    const sets: Prisma.Sql[] = [];
    if (dto.groupLabel !== undefined)
      sets.push(Prisma.sql`group_label = ${dto.groupLabel}`);
    if (dto.notes !== undefined) sets.push(Prisma.sql`notes = ${dto.notes}`);
    if (dto.removed !== undefined) {
      sets.push(
        dto.removed
          ? Prisma.sql`removed_at = now(), removed_by = ${email}`
          : Prisma.sql`removed_at = NULL, removed_by = NULL`,
      );
    }
    if (!sets.length)
      throw new BadRequestException("Nema polja za izmenu grupe.");
    const rows = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      UPDATE plan_proizvodnje_auto_cooperation_groups
        SET ${Prisma.join(sets, ", ")}
        WHERE rj_group_code = ${code}
        RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`);
    if (!rows.length)
      throw new NotFoundException(`Koop grupa ${code} ne postoji`);
    return { data: jsonSafe(rows[0]) };
  }

  // ==========================================================================
  // Skice (plan_proizvodnje_drawings) — bytea (M1)
  // ==========================================================================

  /**
   * Upload skice (bytea u bazi, M1 — nema object storage). MIME whitelist (port 1.0
   * drawingManager ALLOWED_MIMES) ili bilo koji image/*. Autorizacija = kontroler
   * `plan_proizvodnje.edit`. Vraća meta bez binarnog sadržaja.
   */
  async uploadDrawing(
    email: string,
    workOrder: string,
    line: string,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException("Očekivan fajl (multipart `file`)");
    }
    const mime = String(file.mimetype ?? "").toLowerCase();
    if (!ALLOWED_DRAWING_MIMES.includes(mime) && !mime.startsWith("image/")) {
      throw new UnprocessableEntityException(
        `Nepodržan tip fajla: ${file.mimetype || "(nepoznat)"}. Dozvoljeni: JPG, PNG, WEBP, HEIC, PDF.`,
      );
    }
    const row = await this.prisma.planProizvodnjeDrawing.create({
      data: {
        workOrderId: Number(workOrder),
        lineId: Number(line),
        fileName: file.originalname,
        contentType: file.mimetype || null,
        pdfBinary: new Uint8Array(file.buffer),
        sizeBytes: file.size ? BigInt(file.size) : null,
        uploadedBy: email,
      },
      select: {
        id: true,
        workOrderId: true,
        lineId: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        uploadedAt: true,
        uploadedBy: true,
      },
    });
    return {
      data: jsonSafe({
        id: String(row.id),
        workOrderId: String(row.workOrderId),
        lineId: row.lineId != null ? String(row.lineId) : null,
        storagePath: null,
        fileName: row.fileName,
        mimeType: row.contentType,
        sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
        uploadedAt: row.uploadedAt,
        uploadedBy: row.uploadedBy,
      }),
    };
  }

  /** Soft-delete skice (deleted_at/by). Idempotentno (već obrisano → 200). */
  async deleteDrawing(email: string, id: string) {
    const idNum = Number(id);
    const d = await this.prisma.planProizvodnjeDrawing.findUnique({
      where: { id: idNum },
      select: { deletedAt: true },
    });
    if (!d) throw new NotFoundException(`Skica ${id} ne postoji`);
    await this.prisma.planProizvodnjeDrawing.updateMany({
      where: { id: idNum, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: email },
    });
    return { data: { id } };
  }

  // ---------- interno ----------

  /** 'YYYY-MM-DD' → Date za @db.Date (undefined = ne diraj, null = obriši). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }
}
