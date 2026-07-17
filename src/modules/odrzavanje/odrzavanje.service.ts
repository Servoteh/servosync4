import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import type {
  CreateAssetServicePlanDto,
  CreateBookingDto,
  CreateDriverDto,
  CreateLocationDto,
  CreateMachineDto,
  CreateMaintAssetDto,
  CreateNoteDto,
  CreateNotificationRuleDto,
  CreateOwnerDto,
  CreatePartDto,
  CreateProfileDto,
  CreateSupplierDto,
  CreateTaskDto,
  CreateCheckDto,
  CreateTireDto,
  CreateVehicleServicePlanDto,
  CreateWorkOrderDto,
  DeadlineCheckDto,
  DetailsUpsertDto,
  FileMetaDto,
  IncidentEventDto,
  LinkPartDto,
  PatchAssetCoreDto,
  ReportIncidentDto,
  ShelfDto,
  StatusOverrideDto,
  StockMovementDto,
  TollTagDto,
  UpdateAssetServicePlanDto,
  UpdateBookingDto,
  UpdateDocumentDto,
  UpdateDriverDto,
  UpdateIncidentDto,
  UpdateLocationDto,
  UpdateMachineDto,
  UpdateNoteDto,
  UpdateNotificationRuleDto,
  UpdatePartDto,
  UpdatePartLinkDto,
  UpdateProfileDto,
  UpdateSettingsDto,
  UpdateSupplierDto,
  UpdateTaskDto,
  UpdateTireDto,
  UpdateVehicleServicePlanDto,
  UpdateWorkOrderDto,
  UploadDocumentDto,
  WorkOrderEventDto,
  WorkOrderLaborDto,
  WorkOrderPartDto,
} from "./dto/odrzavanje-mutation.dto";

/**
 * Održavanje (CMMS) — 3.0 TALAS F, R1 read sloj (MODULE_SPEC_odrzavanje_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (doktrina §A.1); ovaj servis samo ČITA.
 *
 * ⚠️ DVOSLOJNI authz — SVE ide kroz `Sy15Service.withUserRls` (GUC claims sub+email +
 * `SET LOCAL ROLE authenticated`). Konekciona rola `servosync2_app` je BYPASSRLS
 * (izmereno na sy15), pa TEK pod `authenticated` rade 102 RLS politike identično kao
 * 1.0 PostgREST → **paritet po konstrukciji**. Row-scope se NE duplira u TS:
 *   - maint profil po **auth.uid()** (`maint_profile_role`, `maint_assigned_machine_codes`):
 *     operator machine-scope, technician/chief/management/admin;
 *   - ERP sloj po **email-u** (`maint_is_erp_admin*`, `maint_has_floor_read_access`).
 * Zato je claims OBAVEZNO sa `sub` (auth.uid) I `email` — `setClaims` to već radi.
 *
 * Tabele → Prisma (`prisma/sy15.prisma`, bez FK relacija — spajanja ručni batch-resolve).
 * View-ovi (`v_maint_*`, svi `security_invoker=true`) → `$queryRaw` (RLS pozivaoca; paritet 1:1).
 * Helper fn (`maint_profile_role()` itd.) → `$queryRaw` pod istim mostom (`/maintenance/me`).
 * Mutacije (nalozi/incidenti/foto/storage/dispatch) + 16 front RPC = R2 — ovde ih NEMA.
 */

export interface MachinesQuery {
  q?: string;
  status?: string;
  source?: string;
  archived?: string; // "true" = uklj. arhivirane; default samo aktivne (tracked)
  mine?: string; // "true" = responsible_user_id = ja
  page?: string;
  pageSize?: string;
}
export interface WorkOrdersQuery {
  status?: string;
  group?: string;
  priority?: string;
  type?: string;
  assetId?: string;
  mine?: string; // assigned_to = ja
  page?: string;
  pageSize?: string;
}
export interface IncidentsQuery {
  status?: string;
  severity?: string;
  machineCode?: string;
  page?: string;
  pageSize?: string;
}
export interface DocumentsQuery {
  entityType?: string;
  assetId?: string;
  woId?: string;
  incidentId?: string;
  driverId?: string;
  page?: string;
  pageSize?: string;
}
export interface NotificationsQuery {
  status?: string;
  machineCode?: string;
  page?: string;
  pageSize?: string;
}
export interface PartsQuery {
  q?: string;
  vehicleId?: string;
  lowStock?: string;
  page?: string;
  pageSize?: string;
}

/** Allowliste enum vrednosti (paritet žive šeme; filter van skupa = ignorisan, ne 500). */
const WO_STATUSES = new Set([
  "novi",
  "potvrden",
  "dodeljen",
  "u_radu",
  "ceka_deo",
  "ceka_dobavljaca",
  "ceka_korisnika",
  "kontrola",
  "zavrsen",
  "otkazan",
]);
const WO_PRIORITIES = new Set([
  "p1_zastoj",
  "p2_smetnja",
  "p3_manje",
  "p4_planirano",
]);
const WO_TYPES = new Set([
  "kvar",
  "preventiva",
  "inspekcija",
  "servis",
  "administrativni",
  "incident",
  "preventive",
]);
const INCIDENT_STATUSES = new Set([
  "open",
  "acknowledged",
  "in_progress",
  "awaiting_parts",
  "resolved",
  "closed",
]);
const INCIDENT_SEVERITIES = new Set(["minor", "major", "critical"]);
const NOTIF_STATUSES = new Set(["queued", "sent", "failed"]);
/** Guard za query-param uuid (kontroler ga NE ParseUUIDPipe-uje) — pre Prisma @db.Uuid casta. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WO kanban grupe (spec §4.3): 4 grupe nad 10 statusa. */
const WO_GROUP: Record<string, string> = {
  novi: "novi",
  potvrden: "u_toku",
  dodeljen: "u_toku",
  u_radu: "u_toku",
  ceka_deo: "ceka",
  ceka_dobavljaca: "ceka",
  ceka_korisnika: "ceka",
  kontrola: "ceka",
  zavrsen: "zavrseno",
  otkazan: "zavrseno",
};
const WO_STATUSES_BY_GROUP: Record<string, string[]> = {
  novi: ["novi"],
  u_toku: ["potvrden", "dodeljen", "u_radu"],
  ceka: ["ceka_deo", "ceka_dobavljaca", "ceka_korisnika", "kontrola"],
  zavrseno: ["zavrsen", "otkazan"],
};

/** Jedini storage bucket CMMS-a (paritet 1.0 `MAINT_FILES_BUCKET`). */
const MAINT_BUCKET = "maint-machine-files";

@Injectable()
export class OdrzavanjeService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
  ) {}

  // ==========================================================================
  // /maintenance/me — dvoslojni profil pozivaoca (server računa preko GUC-a)
  // ==========================================================================

  /**
   * Efektivna maint-prava pozivaoca (paritet 1.0 `fetchMaintUserProfile` + lokalni
   * helperi). Server računa preko DEFINER helper fn pod GUC-om (auth.uid()+email);
   * FE fino-gejtuje po ovome (guard/rola sloj NE može izraziti maint profil).
   */
  async me(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          uid: string | null;
          maint_role: string | null;
          floor_read: boolean;
          erp_admin: boolean;
          erp_admin_or_management: boolean;
        }[]
      >(Prisma.sql`SELECT
        auth.uid() AS uid,
        public.maint_profile_role() AS maint_role,
        public.maint_has_floor_read_access() AS floor_read,
        public.maint_is_erp_admin() AS erp_admin,
        public.maint_is_erp_admin_or_management() AS erp_admin_or_management`);
      const r = rows[0] ?? {
        uid: null,
        maint_role: null,
        floor_read: false,
        erp_admin: false,
        erp_admin_or_management: false,
      };
      const profile = r.uid
        ? await tx.maintUserProfile.findUnique({ where: { userId: r.uid } })
        : null;
      const role = r.maint_role;
      const isChiefAdmin = role === "chief" || role === "admin";
      const erpMgmt = r.erp_admin_or_management;
      // FE gate-ovi (paritet 1.0 §2.4). Guard/RLS su autoritativni; ovo je za PRIKAZ.
      const gates = {
        canManageMaintCatalog: erpMgmt || isChiefAdmin,
        canManageMaintTasks: isChiefAdmin, // ⚠ BEZ erp kruga (§2.4)
        canEditWorkOrder: erpMgmt || role === "technician" || isChiefAdmin,
        canManageMaintOverride: erpMgmt || isChiefAdmin,
        canAccessMaintNotifications:
          erpMgmt ||
          role === "chief" ||
          role === "management" ||
          role === "admin",
        canManageInventory: erpMgmt || isChiefAdmin,
        canMoveInventory: erpMgmt || isChiefAdmin || role === "technician",
        canCreateWo: erpMgmt || role === "technician" || isChiefAdmin,
      };
      return {
        data: {
          maintRole: role,
          floorRead: r.floor_read,
          erpAdmin: r.erp_admin,
          erpAdminOrManagement: erpMgmt,
          profile,
          gates,
        },
      };
    });
  }

  // ==========================================================================
  // Dashboard / Pregled (spec §3, §4.1)
  // ==========================================================================

  /** Objedinjeni pregled: statusi mašina + dnevni sažetak + brojevi kategorija (1 poziv umesto 9). */
  async dashboard(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [machineStatus, dailySummary, categoryCounts] = await Promise.all([
        tx.$queryRaw(Prisma.sql`SELECT * FROM v_maint_machine_current_status`),
        tx.$queryRaw(Prisma.sql`SELECT * FROM v_maint_cmms_daily_summary`),
        tx.$queryRaw(
          Prisma.sql`SELECT asset_type::text AS asset_type, count(*)::int AS n
            FROM maint_assets WHERE archived_at IS NULL GROUP BY asset_type`,
        ),
      ]);
      const openIncidents = await tx.maintIncident.count({
        where: { status: { notIn: ["resolved", "closed"] } },
      });
      const openWorkOrders = await tx.maintWorkOrder.count({
        where: { status: { notIn: ["zavrsen", "otkazan"] } },
      });
      return {
        data: {
          machineStatus,
          // v_maint_cmms_daily_summary ima 8 int8 (bigint) kolona → res.json baca
          // TypeError (isti bug rešen u sastanci) → numRows konvertuje bigint→Number.
          dailySummary: this.numRows((dailySummary as unknown[])[0] ?? null),
          categoryCounts,
          openIncidents,
          openWorkOrders,
        },
      };
    });
  }

  // ==========================================================================
  // Mašine (spec §4.2/§4.4)
  // ==========================================================================

  async listMachines(email: string, query: MachinesQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintMachineWhereInput = {
        ...(query.archived === "true" ? {} : { archivedAt: null }),
        ...(query.source ? { source: query.source } : {}),
        ...(query.mine === "true"
          ? { responsibleUserId: await this.uid(tx) }
          : {}),
        ...(query.q
          ? {
              OR: [
                { machineCode: { contains: query.q, mode: "insensitive" } },
                { name: { contains: query.q, mode: "insensitive" } },
                { manufacturer: { contains: query.q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.maintMachine.findMany({
          where,
          orderBy: [{ machineCode: "asc" }],
          skip,
          take,
        }),
        tx.maintMachine.count({ where }),
      ]);
      // Batch enrich: tekući status (view) + odgovorni (maint_user_profiles).
      const codes = rows.map((m) => m.machineCode);
      const [statuses, responsibles] = await Promise.all([
        codes.length
          ? tx.$queryRaw<{ machine_code: string; status: string }[]>(
              // v_maint_machine_current_status izlaže `status` (NE effective_status);
              // 1.0 maintenance.js čita `status`.
              Prisma.sql`SELECT machine_code, status
                FROM v_maint_machine_current_status
                WHERE machine_code IN (${Prisma.join(codes)})`,
            )
          : Promise.resolve([]),
        this.resolveProfiles(
          tx,
          rows.map((m) => m.responsibleUserId),
        ),
      ]);
      const statusByCode = new Map(
        statuses.map((s) => [s.machine_code, s.status]),
      );
      const data = rows.map((m) => ({
        ...m,
        effectiveStatus: statusByCode.get(m.machineCode) ?? null,
        responsibleName: m.responsibleUserId
          ? (responsibles.get(m.responsibleUserId) ?? null)
          : null,
      }));
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Kandidati za uvoz iz BigTehn cache (view). */
  async importableMachines(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_machines_importable`,
      );
      return { data };
    });
  }

  /** Audit log hard-delete-a (RLS: erp-admin ∨ chief/admin/management). */
  async deletionLog(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintMachineDeletionLog.findMany({
        orderBy: { deletedAt: "desc" },
        take: 200,
      });
      return { data };
    });
  }

  async findMachine(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const machine = await tx.maintMachine.findUnique({
        where: { machineCode: code },
      });
      if (!machine)
        throw new NotFoundException(
          `Mašina ${code} ne postoji ili nije vidljiva`,
        );
      const [statusRows, override, responsibles] = await Promise.all([
        tx.$queryRaw<{ status: string }[]>(
          // view kolona je `status` (NE effective_status) — paritet 1.0.
          Prisma.sql`SELECT status FROM v_maint_machine_current_status
            WHERE machine_code = ${code}`,
        ),
        this.activeOverride(tx, code),
        this.resolveProfiles(tx, [machine.responsibleUserId]),
      ]);
      return {
        data: {
          ...machine,
          effectiveStatus: statusRows[0]?.status ?? null,
          statusOverride: override,
          responsibleName: machine.responsibleUserId
            ? (responsibles.get(machine.responsibleUserId) ?? null)
            : null,
        },
      };
    });
  }

  async machineStatusOverride(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await this.activeOverride(tx, code);
      return { data };
    });
  }

  async machineNotes(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintMachineNote.findMany({
        where: { machineCode: code, deletedAt: null },
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      });
      return { data };
    });
  }

  async machineFiles(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.maintMachineFile.findMany({
        where: { machineCode: code, deletedAt: null },
        orderBy: { uploadedAt: "desc" },
      });
      return { data: rows.map((f) => this.withNumSize(f)) };
    });
  }

  /** Šabloni kontrola (preventiva) za mašinu (?machine=) — CRUD je R2 (chief/admin). */
  async listTasks(email: string, machineCode?: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintTask.findMany({
        where: {
          active: true,
          ...(machineCode ? { machineCode } : {}),
        },
        orderBy: [{ machineCode: "asc" }, { title: "asc" }],
      });
      return { data };
    });
  }

  async findTask(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintTask.findUnique({ where: { id } });
      if (!data)
        throw new NotFoundException(`Šablon kontrole ${id} ne postoji`);
      return { data };
    });
  }

  /** Due preventiva (view). */
  async tasksDue(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_task_due_dates`,
      );
      return { data };
    });
  }

  /** Urađene kontrole (?machine=) — history. */
  async listChecks(email: string, machineCode?: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintCheck.findMany({
        where: machineCode ? { machineCode } : {},
        orderBy: { performedAt: "desc" },
        take: 500,
      });
      return { data };
    });
  }

  // ==========================================================================
  // Incidenti (kvarovi) — GET (prijava/tok su R2)
  // ==========================================================================

  async listIncidents(email: string, query: IncidentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.MaintIncidentWhereInput = {
      ...(query.status && INCIDENT_STATUSES.has(query.status)
        ? { status: query.status as never }
        : {}),
      ...(query.severity && INCIDENT_SEVERITIES.has(query.severity)
        ? { severity: query.severity as never }
        : {}),
      ...(query.machineCode ? { machineCode: query.machineCode } : {}),
    };
    return this.withUserMapped(email, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.maintIncident.findMany({
          where,
          orderBy: { reportedAt: "desc" },
          skip,
          take,
        }),
        tx.maintIncident.count({ where }),
      ]);
      // 1.0 (fetchMaintIncidents) ugnježđuje maint_work_orders(wo_id,wo_number,
      // status,title,priority) u svaki incident (globalna lista + machine-history).
      const woIds = [
        ...new Set(
          rows.map((r) => r.workOrderId).filter((x): x is string => !!x),
        ),
      ];
      const wos = woIds.length
        ? await tx.maintWorkOrder.findMany({
            where: { woId: { in: woIds } },
            select: {
              woId: true,
              woNumber: true,
              status: true,
              title: true,
              priority: true,
            },
          })
        : [];
      const woById = new Map(wos.map((w) => [w.woId, w]));
      const data = rows.map((r) => ({
        ...r,
        workOrder: r.workOrderId ? (woById.get(r.workOrderId) ?? null) : null,
      }));
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  async findIncident(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const incident = await tx.maintIncident.findUnique({ where: { id } });
      if (!incident)
        throw new NotFoundException(`Kvar ${id} ne postoji ili nije vidljiv`);
      const [events, workOrder] = await Promise.all([
        tx.maintIncidentEvent.findMany({
          where: { incidentId: id },
          orderBy: { at: "asc" },
        }),
        incident.workOrderId
          ? tx.maintWorkOrder.findUnique({
              where: { woId: incident.workOrderId },
            })
          : Promise.resolve(null),
      ]);
      return { data: { ...incident, events, workOrder } };
    });
  }

  async incidentEvents(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintIncidentEvent.findMany({
        where: { incidentId: id },
        orderBy: { at: "asc" },
      });
      return { data };
    });
  }

  // ==========================================================================
  // Radni nalozi (WO) — kanban lista + detalj read
  // ==========================================================================

  async listWorkOrders(email: string, query: WorkOrdersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const statusFilter: string[] | undefined =
      query.group && WO_STATUSES_BY_GROUP[query.group]
        ? WO_STATUSES_BY_GROUP[query.group]
        : query.status && WO_STATUSES.has(query.status)
          ? [query.status]
          : undefined;
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintWorkOrderWhereInput = {
        ...(statusFilter ? { status: { in: statusFilter as never[] } } : {}),
        ...(query.priority && WO_PRIORITIES.has(query.priority)
          ? { priority: query.priority as never }
          : {}),
        ...(query.type && WO_TYPES.has(query.type)
          ? { type: query.type as never }
          : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.mine === "true" ? { assignedTo: await this.uid(tx) } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.maintWorkOrder.findMany({
          where,
          orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
          skip,
          take,
        }),
        tx.maintWorkOrder.count({ where }),
      ]);
      const data = rows.map((w) => ({
        ...w,
        group: WO_GROUP[w.status] ?? null,
      }));
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Dropdown dodele (RPC — SECURITY DEFINER, samo aktivni operator/technician/chief/admin). */
  async assignableUsers(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM public.maint_assignable_users()`,
      );
      return { data };
    });
  }

  async findWorkOrder(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const wo = await tx.maintWorkOrder.findUnique({ where: { woId: id } });
      if (!wo)
        throw new NotFoundException(
          `Radni nalog ${id} ne postoji ili nije vidljiv`,
        );
      const [events, parts, labor] = await Promise.all([
        tx.maintWoEvent.findMany({
          where: { woId: id },
          orderBy: { at: "asc" },
        }),
        tx.maintWoPart.findMany({
          where: { woId: id },
          orderBy: { createdAt: "asc" },
        }),
        tx.maintWoLabor.findMany({
          where: { woId: id },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      return {
        data: {
          ...wo,
          group: WO_GROUP[wo.status] ?? null,
          events,
          parts,
          labor,
        },
      };
    });
  }

  async woEvents(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoEvent.findMany({
        where: { woId: id },
        orderBy: { at: "asc" },
      });
      return { data };
    });
  }

  async woParts(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoPart.findMany({
        where: { woId: id },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  async woLabor(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoLabor.findMany({
        where: { woId: id },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  // ==========================================================================
  // Vozila / Vozači (spec §4.5)
  // ==========================================================================

  async listVehicles(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_overview`,
      );
      return { data };
    });
  }

  async findVehicle(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const asset = await tx.maintAsset.findFirst({
        where: { assetId, assetType: "vehicle" },
      });
      if (!asset)
        throw new NotFoundException(
          `Vozilo ${assetId} ne postoji ili nije vidljivo`,
        );
      const details = await tx.maintVehicleDetails.findUnique({
        where: { assetId },
      });
      const owner = details?.ownerId
        ? await tx.maintVehicleOwner.findUnique({
            where: { ownerId: details.ownerId },
          })
        : null;
      return { data: { ...asset, details, owner } };
    });
  }

  async vehicleTires(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintVehicleTire.findMany({
        where: { assetId },
        orderBy: { createdAt: "desc" },
      });
      return { data };
    });
  }

  async vehicleServicePlan(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintVehicleServicePlan.findMany({
        where: { assetId },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  async vehicleParts(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_parts WHERE asset_id = ${assetId}::uuid`,
      );
      return { data };
    });
  }

  async vehicleBookings(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_bookings WHERE asset_id = ${assetId}::uuid`,
      );
      return { data };
    });
  }

  async vehicleServicePlanDue(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_service_plan_due`,
      );
      return { data };
    });
  }

  async vehicleOwners(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintVehicleOwner.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
      });
      return { data };
    });
  }

  async listDrivers(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_drivers_overview`,
      );
      return { data };
    });
  }

  /** Karton vozača (PII — bez maskiranja; RLS krug §2.2 odlučuje ko vidi). */
  async findDriver(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const driver = await tx.maintDriver.findUnique({
        where: { driverId: id },
      });
      if (!driver)
        throw new NotFoundException(`Vozač ${id} ne postoji ili nije vidljiv`);
      const documents = await tx.maintDocument.findMany({
        where: { driverId: id, deletedAt: null },
        orderBy: { uploadedAt: "desc" },
      });
      return {
        data: {
          ...driver,
          documents: documents.map((d) => this.withNumSize(d)),
        },
      };
    });
  }

  // ==========================================================================
  // IT oprema / Objekti / Sredstva (spec §4.6)
  // ==========================================================================

  async listItAssets(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_it_overview`,
      );
      return { data };
    });
  }

  async listFacilities(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_facility_overview`,
      );
      return { data };
    });
  }

  async findItAsset(email: string, assetId: string) {
    return this.assetCard(email, assetId, "it");
  }

  async findFacility(email: string, assetId: string) {
    return this.assetCard(email, assetId, "facility");
  }

  private async assetCard(
    email: string,
    assetId: string,
    type: "it" | "facility",
  ) {
    return this.withUserMapped(email, async (tx) => {
      const asset = await tx.maintAsset.findFirst({
        where: { assetId, assetType: type },
      });
      if (!asset)
        throw new NotFoundException(
          `Sredstvo ${assetId} ne postoji ili nije vidljivo`,
        );
      const details =
        type === "it"
          ? await tx.maintItAssetDetails.findUnique({ where: { assetId } })
          : await tx.maintFacilityDetails.findUnique({ where: { assetId } });
      const servicePlan = await tx.maintAssetServicePlan.findMany({
        where: { assetId },
        orderBy: { createdAt: "asc" },
      });
      return { data: { ...asset, details, servicePlan } };
    });
  }

  /** Picker/registar sredstava (maint_assets) — filter po tipu/aktivnosti. */
  async listAssets(email: string, type?: string, activeOnly?: boolean) {
    return this.withUserMapped(email, async (tx) => {
      const validType =
        type && ["machine", "vehicle", "it", "facility"].includes(type)
          ? (type as never)
          : undefined;
      const data = await tx.maintAsset.findMany({
        where: {
          ...(validType ? { assetType: validType } : {}),
          ...(activeOnly ? { archivedAt: null } : {}),
        },
        orderBy: [{ assetType: "asc" }, { name: "asc" }],
        take: 1000,
      });
      return { data };
    });
  }

  async assetServicePlan(email: string, assetId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintAssetServicePlan.findMany({
        where: { assetId },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  async assetServicePlanDue(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_asset_service_plan_due`,
      );
      return { data };
    });
  }

  /**
   * Tipovi objekata — lookup. Tabela `maint_facility_type_lookup` NE postoji na živoj
   * bazi (migracija neprimenjena; F5), pa endpoint vraća `[]` (paritet FE fallback).
   */
  facilityTypes() {
    return { data: [] as unknown[] };
  }

  // ==========================================================================
  // Kalendar rokova (spec §4.7) — BE sklapa isto što 1.0 klijent
  // ==========================================================================

  async calendarDeadlines(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [vehicleServiceDue, assetServiceDue, itAssets, facilities] =
        await Promise.all([
          tx.$queryRaw(
            Prisma.sql`SELECT * FROM v_maint_vehicle_service_plan_due WHERE due_status IN ('overdue','due_soon')`,
          ),
          tx.$queryRaw(
            Prisma.sql`SELECT * FROM v_maint_asset_service_plan_due WHERE due_status IN ('overdue','due_soon')`,
          ),
          tx.$queryRaw(
            Prisma.sql`SELECT asset_id, asset_code, name, license_expires_at, warranty_expires_at
              FROM v_maint_it_overview WHERE archived_at IS NULL
                AND (license_expires_at IS NOT NULL OR warranty_expires_at IS NOT NULL)`,
          ),
          tx.$queryRaw(
            Prisma.sql`SELECT asset_id, asset_code, name, inspection_due_at, fire_safety_due_at
              FROM v_maint_facility_overview WHERE archived_at IS NULL
                AND (inspection_due_at IS NOT NULL OR fire_safety_due_at IS NOT NULL)`,
          ),
        ]);
      return {
        data: { vehicleServiceDue, assetServiceDue, itAssets, facilities },
      };
    });
  }

  // ==========================================================================
  // Zalihe / dobavljači / lokacije (spec §4.8)
  // ==========================================================================

  async listParts(email: string, query: PartsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    // „Po vozilu" ide preko view-a (v_maint_parts_with_vehicles) — paritet 1.0 filtera.
    // ⚠️ View NEMA asset_id; filtrira se po `vehicle_codes` (text[] asset_code-ova) koji
    // sadrži šifru vozila (paritet 1.0 `vehicle_codes=cs.{code}`). Param je asset_id
    // vozila → razreši u asset_code pa `<code> = ANY(vehicle_codes)`.
    if (query.vehicleId) {
      const vid = query.vehicleId;
      if (!UUID_RE.test(vid)) return { data: [] };
      return this.withUserMapped(email, async (tx) => {
        const asset = await tx.maintAsset.findFirst({
          where: { assetId: vid, assetType: "vehicle" },
          select: { assetCode: true },
        });
        if (!asset) return { data: [] };
        const data = await tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_maint_parts_with_vehicles
            WHERE ${asset.assetCode} = ANY(vehicle_codes)`,
        );
        return { data };
      });
    }
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintPartWhereInput = {
        active: true,
        ...(query.q
          ? {
              OR: [
                { partCode: { contains: query.q, mode: "insensitive" } },
                { name: { contains: query.q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const [data, total] = await Promise.all([
        tx.maintPart.findMany({
          where,
          orderBy: { partCode: "asc" },
          skip,
          take,
        }),
        tx.maintPart.count({ where }),
      ]);
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  async findPart(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintPart.findUnique({ where: { partId: id } });
      if (!data)
        throw new NotFoundException(`Deo ${id} ne postoji ili nije vidljiv`);
      return { data };
    });
  }

  async partStockMovements(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintPartStockMovement.findMany({
        where: { partId: id },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      return { data };
    });
  }

  async listSuppliers(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintSupplier.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
      });
      return { data };
    });
  }

  /** CMMS interna hijerarhija lokacija (≠ loc_locations). */
  async listLocations(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintLocation.findMany({
        where: { active: true },
        orderBy: [{ locationType: "asc" }, { name: "asc" }],
      });
      return { data };
    });
  }

  // ==========================================================================
  // Dokumenta (meta read) / Podešavanja / Notifikacije (spec §4.9/§4.11/§4.12)
  // ==========================================================================

  async listDocuments(email: string, query: DocumentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const validEntity =
      query.entityType &&
      ["asset", "work_order", "incident", "preventive_task", "driver"].includes(
        query.entityType,
      )
        ? (query.entityType as never)
        : undefined;
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintDocumentWhereInput = {
        deletedAt: null,
        ...(validEntity ? { entityType: validEntity } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.woId ? { woId: query.woId } : {}),
        ...(query.incidentId ? { incidentId: query.incidentId } : {}),
        ...(query.driverId ? { driverId: query.driverId } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.maintDocument.findMany({
          where,
          orderBy: { uploadedAt: "desc" },
          skip,
          take,
        }),
        tx.maintDocument.count({ where }),
      ]);
      return {
        data: rows.map((d) => this.withNumSize(d)),
        meta: pageMeta(page, pageSize, total),
      };
    });
  }

  async findDocument(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const doc = await tx.maintDocument.findUnique({
        where: { documentId: id },
      });
      if (!doc)
        throw new NotFoundException(
          `Dokument ${id} ne postoji ili nije vidljiv`,
        );
      return { data: this.withNumSize(doc) };
    });
  }

  async settings(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintSettings.findUnique({ where: { id: 1 } });
      return { data };
    });
  }

  async notificationRules(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintNotificationRule.findMany({
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  /** Outbox log (RLS: erp-admin ∨ chief/management/admin) + filteri. */
  async notifications(email: string, query: NotificationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintNotificationLogWhereInput = {
        ...(query.status && NOTIF_STATUSES.has(query.status)
          ? { status: query.status as never }
          : {}),
        ...(query.machineCode ? { machineCode: query.machineCode } : {}),
      };
      const [data, total] = await Promise.all([
        tx.maintNotificationLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        tx.maintNotificationLog.count({ where }),
      ]);
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  // ==========================================================================
  // Izveštaji (spec §4.10) — BE računa isto što 1.0 klijentski
  // ==========================================================================

  private periodDays(period?: string): number | null {
    if (period === "all") return null;
    const n = Number(period);
    return [30, 90, 365].includes(n) ? n : 30;
  }

  async reportIncidents(email: string, period?: string) {
    const days = this.periodDays(period);
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintIncidentWhereInput = days
        ? { reportedAt: { gte: this.sinceDate(days) } }
        : {};
      const rows = await tx.maintIncident.findMany({ where });
      const bySeverity = this.countBy(rows, (r) => r.severity);
      const byStatus = this.countBy(rows, (r) => r.status);
      const downtimeMinutes = rows.reduce(
        (a, r) => a + (r.downtimeMinutes ?? 0),
        0,
      );
      return {
        data: {
          total: rows.length,
          bySeverity,
          byStatus,
          downtimeMinutes,
          period: days ? `${days}d` : "all",
        },
      };
    });
  }

  /**
   * WO troškovi — agregacija LINE-ITEM-a (paritet 1.0 maintReportsPanel):
   * partsCost = Σ(quantity × (wo_parts.unit_cost ?? maint_parts.unit_cost)) nad wo_parts;
   * laborMinutes = Σ(minutes) nad wo_labor. WO header kolone (cost_total/labor_minutes)
   * NISU pouzdan rollup (nijedan trigger ih ne agregira iz stavki) — NE sabiraju se.
   */
  async reportWorkOrderCosts(email: string, period?: string) {
    const days = this.periodDays(period);
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintWorkOrderWhereInput = days
        ? { createdAt: { gte: this.sinceDate(days) } }
        : {};
      const wos = await tx.maintWorkOrder.findMany({
        where,
        select: { woId: true, type: true, assetType: true },
      });
      const emptyPeriod = days ? `${days}d` : "all";
      if (!wos.length) {
        return {
          data: {
            totalWorkOrders: 0,
            partsCost: 0,
            laborMinutes: 0,
            costByAssetType: {},
            byType: {},
            period: emptyPeriod,
          },
        };
      }
      const woIds = wos.map((w) => w.woId);
      const assetTypeByWo = new Map(
        wos.map((w) => [w.woId, String(w.assetType)]),
      );
      const [parts, labor] = await Promise.all([
        tx.maintWoPart.findMany({
          where: { woId: { in: woIds } },
          select: { woId: true, partId: true, quantity: true, unitCost: true },
        }),
        tx.maintWoLabor.findMany({
          where: { woId: { in: woIds } },
          select: { minutes: true },
        }),
      ]);
      // Fallback jedinične cene iz maint_parts kad wo_parts.unit_cost fali (paritet 1.0).
      const missing = [
        ...new Set(
          parts
            .filter((p) => p.unitCost == null && p.partId)
            .map((p) => p.partId as string),
        ),
      ];
      const catalogCost = new Map<string, number>();
      if (missing.length) {
        const cat = await tx.maintPart.findMany({
          where: { partId: { in: missing } },
          select: { partId: true, unitCost: true },
        });
        for (const c of cat) catalogCost.set(c.partId, Number(c.unitCost ?? 0));
      }
      const partCost = (p: {
        partId: string | null;
        quantity: Prisma.Decimal | null;
        unitCost: Prisma.Decimal | null;
      }) =>
        Number(p.quantity ?? 0) *
        (p.unitCost != null
          ? Number(p.unitCost)
          : p.partId
            ? (catalogCost.get(p.partId) ?? 0)
            : 0);
      const partsCost = parts.reduce((a, p) => a + partCost(p), 0);
      const laborMinutes = labor.reduce((a, l) => a + (l.minutes ?? 0), 0);
      const costByAssetType: Record<string, number> = {};
      for (const p of parts) {
        const at = assetTypeByWo.get(p.woId) ?? "—";
        costByAssetType[at] = (costByAssetType[at] ?? 0) + partCost(p);
      }
      return {
        data: {
          totalWorkOrders: wos.length,
          partsCost,
          laborMinutes,
          costByAssetType,
          byType: this.countBy(wos, (w) => String(w.type)),
          period: emptyPeriod,
        },
      };
    });
  }

  /** IT/objekti koji „zahtevaju pažnju" — rokovi iz overview view-ova. */
  async reportAttention(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [itAssets, facilities] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_maint_it_overview WHERE archived_at IS NULL`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_maint_facility_overview WHERE archived_at IS NULL`,
        ),
      ]);
      return { data: { itAssets, facilities } };
    });
  }

  // ==========================================================================
  // Interni helperi
  // ==========================================================================

  /** auth.uid() pozivaoca pod GUC-om (= claims sub). Za „Moje" filtere. */
  private async uid(tx: Sy15Tx): Promise<string | null> {
    const rows = await tx.$queryRaw<{ uid: string | null }[]>(
      Prisma.sql`SELECT auth.uid() AS uid`,
    );
    return rows[0]?.uid ?? null;
  }

  /**
   * Tvrda kapija za mutacije maint profila: SAMO ERP admin (`maint_is_erp_admin()` —
   * user_roles global `admin` po email-u). NIJE admin_ui krug: menadzment/magacioner
   * (koji imaju `odrzavanje.admin_ui`) NE smeju menjati profile — inače bi mogli sami
   * sebi eskalirati CMMS rolu. Guard NE sme biti ni uži ni širi od žive RLS/trigger
   * granice: `maint_user_profiles` INSERT/DELETE = erp-admin, a trigger
   * `maint_profiles_guard_role` dozvoljava izmenu `role`/`active` ISKLJUČIVO erp-adminu
   * (§2.5.10). Poziva se POD `authenticated` rolom (DEFINER fn čita claims->>'email').
   */
  private async assertErpAdmin(tx: Sy15Tx): Promise<void> {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>(
      Prisma.sql`SELECT public.maint_is_erp_admin() AS ok`,
    );
    if (rows[0]?.ok !== true) {
      throw new ForbiddenException(
        "Samo ERP admin sme da menja profile održavanja",
      );
    }
  }

  /** Batch-resolve full_name iz maint_user_profiles (RLS: self ∨ erp-admin — best-effort). */
  private async resolveProfiles(
    tx: Sy15Tx,
    userIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const rows = await tx.maintUserProfile.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.userId, r.fullName]));
  }

  /** BigInt (size_bytes) ne prežive res.json → Number (kao sastanci slikaOut). */
  private withNumSize<T extends { sizeBytes: bigint | null }>(row: T) {
    return {
      ...row,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    };
  }

  /**
   * $queryRaw nad view-om vraća int8 kolone kao JS BigInt → `res.json` baca TypeError.
   * Konvertuje TOP-LEVEL bigint polja reda u Number (ne recurse-uje — Prisma Decimal
   * poljima se NE dira, ostaju kao string kroz toJSON). Primenjuje se na raw view redove
   * sa agregatnim count-ovima (npr. v_maint_cmms_daily_summary — 8 int8 kolona).
   */
  private numRows<T>(v: T): T {
    const fix = (o: unknown): unknown => {
      if (o === null || typeof o !== "object") {
        return typeof o === "bigint" ? Number(o) : o;
      }
      if (Array.isArray(o)) return o.map(fix);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
        out[k] = typeof val === "bigint" ? Number(val) : val;
      }
      return out;
    };
    return fix(v) as T;
  }

  /**
   * Ručni status override — SAMO važeći (paritet 1.0 fetchMaintMachineOverride:
   * `valid_until IS NULL OR valid_until >= now()`). Istekli override se NE vraća.
   */
  private async activeOverride(tx: Sy15Tx, code: string) {
    return tx.maintMachineStatusOverride.findFirst({
      where: {
        machineCode: code,
        OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
      },
    });
  }

  private sinceDate(days: number): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }

  private countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = key(r);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  /** Kao sastanci: withUserRls (GUC + SET ROLE authenticated) + SQLSTATE→HTTP mapiranje. */
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

  /** SQLSTATE iz DB fn/RLS → HTTP semantika (paritet Reversi §5 / sastanci). */
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
    if (
      code === "P0001" ||
      code === "P0002" ||
      code === "23514" ||
      code === "23503" || // FK (npr. preventive task bez CMMS asset-a)
      code === "22023" // invalid param (npr. delete-hard razlog < 5)
    )
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }

  // ============================================================================
  // R2 — MUTACIJE (REST write kroz withUserRls/runIdempotentRls; RLS presuđuje red)
  // ============================================================================
  // Sav write ide pod `SET LOCAL ROLE authenticated` → 102 sy15 RLS politike rade
  // IDENTIČNO kao 1.0 PostgREST (dvoslojni authz sub+email) — scope se NE duplira u
  // kodu (doktrina A.2a/§C). „Create" upisi nose `clientEventId` (runIdempotentRls);
  // PATCH/DELETE su idempotentni pa idu `withUserRls`. RLS-filtrovan UPDATE/DELETE
  // (0 redova) → `assertAffected` razdvaja 404 (ne postoji) od 403 (nema prava).
  // Kolone `*_by`/`performed_by`/`reported_by`/`uploaded_by` = `auth.uid()` pozivaoca
  // (RLS WITH CHECK to i traži). Notif outbox INSERT je DENY-ALL (enqueue = trigeri/cron).
  // Dispatch OSTAJE MRTAV (presuda F1) — seli se samo log+retry+rules.

  /** Idempotentna „create" akcija (clientEventId ključ; runIdempotentRls). */
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

  /** 'YYYY-MM-DD'/ISO → Date za @db.Date; undefined = ne diraj, ''/null = obriši. */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  }

  /** ISO string → Date za @db.Timestamptz; undefined = ne diraj, ''/null = obriši. */
  private toDbTs(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(v);
  }

  /** 0 pogodaka: 404 ako red ne postoji (po SELECT-u), inače 403 (RLS write-scope). */
  private assertAffected(exists: boolean, count: number, what: string): void {
    if (count > 0) return;
    if (!exists) throw new NotFoundException(`${what} ne postoji`);
    throw new ForbiddenException(`Nemate pravo nad: ${what}`);
  }

  /** Sanitizacija imena fajla (paritet 1.0 uploadMaintMachineFile safeName). */
  private safeFileName(name: string): string {
    const s = String(name || "file")
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90);
    return s || "file";
  }

  // ---------- Mašine: katalog CRUD / arhiva / rename / import / hard-delete ----------

  createMachine(email: string, dto: CreateMachineDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-machine",
      async (tx) => {
        // asset_id je NOT NULL ali ga popunjava trigger `maint_machines_ensure_asset`
        // PRE INSERT-a → koristimo $executeRaw (Prisma create traži asset_id u tipu).
        const uid = await this.uid(tx);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO maint_machines
            (machine_code, name, type, manufacturer, model, serial_number,
             year_of_manufacture, year_commissioned, location, department_id,
             power_kw, weight_kg, notes, tracked, source, responsible_user_id, updated_by)
          VALUES (
            ${dto.machineCode.trim()}, ${dto.name.trim()}, ${dto.type ?? null},
            ${dto.manufacturer ?? null}, ${dto.model ?? null}, ${dto.serialNumber ?? null},
            ${dto.yearOfManufacture ?? null}, ${dto.yearCommissioned ?? null},
            ${dto.location ?? null}, ${dto.departmentId ?? null},
            ${dto.powerKw ?? null}, ${dto.weightKg ?? null}, ${dto.notes ?? null},
            ${dto.tracked !== false}, ${dto.source ?? "manual"},
            ${dto.responsibleUserId ?? null}::uuid, ${uid}::uuid)`);
        const row = await tx.maintMachine.findUnique({
          where: { machineCode: dto.machineCode.trim() },
        });
        return row;
      },
    );
  }

  async updateMachine(email: string, code: string, dto: UpdateMachineDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintMachine.count({ where: { machineCode: code } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintMachine.updateMany({
        where: { machineCode: code },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.manufacturer !== undefined
            ? { manufacturer: dto.manufacturer }
            : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.serialNumber !== undefined
            ? { serialNumber: dto.serialNumber }
            : {}),
          ...(dto.yearOfManufacture !== undefined
            ? { yearOfManufacture: dto.yearOfManufacture }
            : {}),
          ...(dto.yearCommissioned !== undefined
            ? { yearCommissioned: dto.yearCommissioned }
            : {}),
          ...(dto.location !== undefined ? { location: dto.location } : {}),
          ...(dto.departmentId !== undefined
            ? { departmentId: dto.departmentId }
            : {}),
          ...(dto.powerKw !== undefined ? { powerKw: dto.powerKw } : {}),
          ...(dto.weightKg !== undefined ? { weightKg: dto.weightKg } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.tracked !== undefined ? { tracked: dto.tracked } : {}),
          ...(dto.responsibleUserId !== undefined
            ? { responsibleUserId: dto.responsibleUserId }
            : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Mašina ${code}`);
      return {
        data: await tx.maintMachine.findUnique({
          where: { machineCode: code },
        }),
      };
    });
  }

  /** Soft-delete mašine: archived_at = now(), tracked = false (paritet archiveMaintMachine). */
  async archiveMachine(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintMachine.count({ where: { machineCode: code } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintMachine.updateMany({
        where: { machineCode: code },
        data: {
          archivedAt: new Date(),
          tracked: false,
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Mašina ${code}`);
      return { data: { ok: true } };
    });
  }

  async restoreMachine(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintMachine.count({ where: { machineCode: code } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintMachine.updateMany({
        where: { machineCode: code },
        data: {
          archivedAt: null,
          tracked: true,
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Mašina ${code}`);
      return { data: { ok: true } };
    });
  }

  /** Uvoz mašina iz BigTehn cache (RPC; ON CONFLICT DO NOTHING → idempotentno). */
  importMachines(email: string, codes: string[]) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT public.maint_machines_import_from_cache(${codes}::text[]) AS n`,
      );
      return { data: { imported: Number(rows[0]?.n ?? 0) } };
    });
  }

  /** Atomski rename PK kroz 6 tabela (RPC). NE dira loc_locations (skriveno pravilo §2.5.14). */
  renameMachine(email: string, oldCode: string, newCode: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT public.maint_machine_rename(${oldCode}, ${newCode.trim()}) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  /**
   * Hard-delete mašine: BE PRVO očisti storage (fajlovi mašine), pa RPC atomski
   * obriše red + child redove + upiše deletion_log (1.0 to radi klijent — spec §3).
   * Storage brisanje je best-effort PRE RPC-a (meta-red je izvor istine; RLS SELECT
   * na files presuđuje šta je vidljivo pozivaocu).
   */
  async deleteMachineHard(email: string, code: string, reason: string) {
    // 1) Skupi putanje fajlova (RLS SELECT), pa best-effort obriši iz bucketa.
    const paths = await this.withUserMapped(email, async (tx) => {
      const files = await tx.maintMachineFile.findMany({
        where: { machineCode: code },
        select: { storagePath: true },
      });
      return files.map((f) => f.storagePath).filter(Boolean);
    });
    for (const p of paths) await this.storage.remove(MAINT_BUCKET, p);
    // 2) RPC (auth: erp-admin ∨ chief/admin; validira razlog ≥5; P0002 ako ne postoji).
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT public.maint_machine_delete_hard(${code}, ${reason}) AS result`,
      );
      return { data: rows[0]?.result ?? null };
    });
  }

  // ---------- Ručni status override ----------

  /** Upsert override (PK machine_code); set_by = ja (paritet upsertMaintMachineOverride). */
  async setStatusOverride(email: string, code: string, dto: StatusOverrideDto) {
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const data = {
        status: dto.status as never,
        reason: dto.reason,
        setBy: uid!,
        setAt: new Date(),
        validUntil: this.toDbTs(dto.validUntil) ?? null,
      };
      const row = await tx.maintMachineStatusOverride.upsert({
        where: { machineCode: code },
        create: { machineCode: code, ...data },
        update: data,
      });
      return { data: row };
    });
  }

  async clearStatusOverride(email: string, code: string) {
    return this.withUserMapped(email, async (tx) => {
      await tx.maintMachineStatusOverride.deleteMany({
        where: { machineCode: code },
      });
      return { data: { ok: true } };
    });
  }

  // ---------- Napomene mašine (24h pravilo je u RLS) ----------

  createNote(email: string, code: string, dto: CreateNoteDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-note",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintMachineNote.create({
          data: {
            machineCode: code,
            author: uid!,
            content: dto.content,
            pinned: dto.pinned === true,
          },
        });
      },
    );
  }

  async updateNote(email: string, noteId: string, dto: UpdateNoteDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintMachineNote.count({ where: { id: noteId } })) > 0;
      const { count } = await tx.maintMachineNote.updateMany({
        where: { id: noteId },
        data: {
          ...(dto.content !== undefined ? { content: dto.content } : {}),
          ...(dto.pinned !== undefined ? { pinned: dto.pinned } : {}),
          ...(dto.deleted !== undefined
            ? { deletedAt: dto.deleted ? new Date() : null }
            : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Napomena ${noteId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Fajlovi mašine (storage proxy F4) ----------

  /** Upload fajla mašine: meta PRE bajtova (RLS INSERT enforce; bez orphan-a). */
  async uploadMachineFile(
    email: string,
    code: string,
    dto: FileMetaDto,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException(
        "Očekivan fajl (multipart `file`)",
      );
    }
    const uuid = randomUUID().replace(/-/g, "").slice(0, 12);
    const storagePath = `${code}/${uuid}_${this.safeFileName(file.originalname)}`;
    const meta = await this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      return tx.maintMachineFile.create({
        data: {
          machineCode: code,
          fileName: file.originalname,
          storagePath,
          mimeType: file.mimetype ?? null,
          sizeBytes: BigInt(file.buffer.length),
          category: dto.category ?? null,
          description: dto.description ?? null,
          uploadedBy: uid,
        },
      });
    });
    try {
      await this.storage.upload(
        MAINT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype || "application/octet-stream",
        false,
      );
    } catch (e) {
      await this.withUserMapped(email, async (tx) => {
        await tx.maintMachineFile.deleteMany({ where: { id: meta.id } });
      }).catch(() => {});
      throw e;
    }
    return { data: this.withNumSize(meta) };
  }

  updateMachineFile(email: string, id: string, dto: FileMetaDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintMachineFile.count({ where: { id } })) > 0;
      const { count } = await tx.maintMachineFile.updateMany({
        where: { id },
        data: {
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
      });
      this.assertAffected(exists, count, `Fajl ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Soft-delete fajla (deleted_at) pod RLS + best-effort brisanje bajtova. */
  async deleteMachineFile(email: string, id: string) {
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.maintMachineFile.findUnique({
        where: { id },
        select: { storagePath: true },
      });
      const exists = !!row;
      const { count } = await tx.maintMachineFile.updateMany({
        where: { id },
        data: { deletedAt: new Date() },
      });
      this.assertAffected(exists, count, `Fajl ${id}`);
      return row?.storagePath ?? null;
    });
    if (path) await this.storage.remove(MAINT_BUCKET, path);
    return { data: { ok: true } };
  }

  /** Presigned URL fajla mašine (RLS SELECT presuđuje vidljivost PRE potpisivanja). */
  async signMachineFile(email: string, id: string) {
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.maintMachineFile.findUnique({
        where: { id },
        select: { storagePath: true, deletedAt: true },
      });
      if (!row || row.deletedAt)
        throw new NotFoundException(`Fajl ${id} ne postoji`);
      return row.storagePath;
    });
    return { data: await this.storage.signUrl(MAINT_BUCKET, path, 300) };
  }

  // ---------- Preventiva: šabloni + kontrole + WO iz šablona ----------

  createTask(email: string, dto: CreateTaskDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-task",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintTask.create({
          data: {
            machineCode: dto.machineCode,
            title: dto.title,
            description: dto.description ?? null,
            instructions: dto.instructions ?? null,
            intervalValue: dto.intervalValue,
            intervalUnit: dto.intervalUnit as never,
            severity: (dto.severity ?? "normal") as never,
            requiredRole: (dto.requiredRole ?? "operator") as never,
            gracePeriodDays: dto.gracePeriodDays ?? 3,
            active: dto.active ?? true,
            createdBy: uid,
            updatedBy: uid,
            checklistTemplate: [],
          },
        });
      },
    );
  }

  async updateTask(email: string, id: string, dto: UpdateTaskDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintTask.count({ where: { id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintTask.updateMany({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.instructions !== undefined
            ? { instructions: dto.instructions }
            : {}),
          ...(dto.intervalValue !== undefined
            ? { intervalValue: dto.intervalValue }
            : {}),
          ...(dto.intervalUnit !== undefined
            ? { intervalUnit: dto.intervalUnit as never }
            : {}),
          ...(dto.severity !== undefined
            ? { severity: dto.severity as never }
            : {}),
          ...(dto.requiredRole !== undefined
            ? { requiredRole: dto.requiredRole as never }
            : {}),
          ...(dto.gracePeriodDays !== undefined
            ? { gracePeriodDays: dto.gracePeriodDays }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Šablon ${id}`);
      return { data: await tx.maintTask.findUnique({ where: { id } }) };
    });
  }

  /** DELETE šablona (CASCADE briše maint_checks istoriju — 1.0 preporučuje active=false). */
  async deleteTask(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintTask.count({ where: { id } })) > 0;
      const { count } = await tx.maintTask.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Šablon ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Kreiraj (ili vrati postojeći) WO iz preventivnog šablona (RPC; anti-duplikat u DB). */
  createPreventiveWorkOrder(email: string, taskId: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ wo: string | null }[]>(
        Prisma.sql`SELECT public.maint_create_preventive_work_order(${taskId}::uuid) AS wo`,
      );
      return { data: { woId: rows[0]?.wo ?? null } };
    });
  }

  createCheck(email: string, dto: CreateCheckDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-check",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintCheck.create({
          data: {
            taskId: dto.taskId,
            machineCode: dto.machineCode,
            performedBy: uid!,
            result: dto.result as never,
            notes: dto.notes ?? null,
            attachmentUrls: [],
          },
        });
      },
    );
  }

  // ---------- Incidenti (prijava = opšte pravo; F6 INSERT-bez-SELECT) ----------

  /**
   * Prijava kvara (presuda F6): INSERT-bez-representation → 201 + id. Reporter bez
   * ijedne maint vidljivosti sme prijaviti (RLS INSERT `reported_by = auth.uid()`),
   * ali svoj incident možda NE VIDI (SELECT ga filtrira) → RETURNING bi pao. Zato
   * `$executeRaw` sa app-generisanim id-om (bez RETURNING), pa vrati id. asset_id/
   * asset_type popunjava trigger; auto-WO/auto-notify trigeri se okidaju u bazi.
   */
  reportIncident(email: string, dto: ReportIncidentDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.report-incident",
      async (tx) => {
        const id = randomUUID();
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO maint_incidents
            (id, machine_code, asset_id, asset_type, reported_by, title,
             description, severity, safety_marker, status, attachment_urls)
          VALUES (
            ${id}::uuid, ${dto.machineCode}, ${dto.assetId ?? null}::uuid,
            ${dto.assetType ?? null}::maint_asset_type, auth.uid(), ${dto.title},
            ${dto.description ?? null}, ${dto.severity}::maint_incident_severity,
            ${dto.safetyMarker === true}, 'open'::maint_incident_status, '{}'::text[])`);
        return { id };
      },
    );
  }

  async updateIncident(email: string, id: string, dto: UpdateIncidentDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintIncident.count({ where: { id } })) > 0;
      const uid = await this.uid(tx);
      // CHECK (u closed samo maint_can_close_incident) presuđuje DB → 23514/42501.
      const { count } = await tx.maintIncident.updateMany({
        where: { id },
        data: {
          ...(dto.status !== undefined ? { status: dto.status as never } : {}),
          ...(dto.assignedTo !== undefined
            ? { assignedTo: dto.assignedTo }
            : {}),
          ...(dto.severity !== undefined
            ? { severity: dto.severity as never }
            : {}),
          ...(dto.resolutionNotes !== undefined
            ? { resolutionNotes: dto.resolutionNotes }
            : {}),
          ...(dto.downtimeMinutes !== undefined
            ? { downtimeMinutes: dto.downtimeMinutes }
            : {}),
          ...(dto.resolvedAt !== undefined
            ? { resolvedAt: this.toDbTs(dto.resolvedAt) }
            : {}),
          ...(dto.closedAt !== undefined
            ? { closedAt: this.toDbTs(dto.closedAt) }
            : {}),
          ...(dto.safetyMarker !== undefined
            ? { safetyMarker: dto.safetyMarker }
            : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Kvar ${id}`);
      return { data: await tx.maintIncident.findUnique({ where: { id } }) };
    });
  }

  createIncidentEvent(email: string, id: string, dto: IncidentEventDto) {
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const row = await tx.maintIncidentEvent.create({
        data: {
          incidentId: id,
          actor: uid,
          eventType: dto.eventType,
          comment: dto.comment ?? null,
          fromValue: dto.fromValue ?? null,
          toValue: dto.toValue ?? null,
        },
      });
      return { data: row };
    });
  }

  /**
   * Foto incidenta (presuda F3): upload bajtova u bucket, pa `maint_attach_incident_files`
   * RPC (reported_by = auth.uid() putanja) — NE direktni PATCH attachment_urls koji tiho
   * pada za prijavioce bez WO/incident-UPDATE prava. Putanja = 1.0-kompatibilna
   * (`${machineCode}/${uuid}_${safeName}`, kao uploadMaintMachineFile).
   */
  async attachIncidentFiles(
    email: string,
    id: string,
    files: Express.Multer.File[],
  ) {
    if (!files?.length) {
      throw new UnprocessableEntityException(
        "Očekivane fotografije (multipart `files`)",
      );
    }
    // machine_code incidenta (za 1.0-kompatibilnu putanju); RLS SELECT presuđuje vidljivost.
    const machineCode = await this.withUserMapped(email, async (tx) => {
      const inc = await tx.maintIncident.findUnique({
        where: { id },
        select: { machineCode: true },
      });
      // Reporter možda NE VIDI svoj incident (F6) → fallback na "incident/<id>" putanju.
      return inc?.machineCode ?? `incident/${id}`;
    });
    const paths: string[] = [];
    for (const f of files) {
      if (!f?.buffer?.length) continue;
      const uuid = randomUUID().replace(/-/g, "").slice(0, 12);
      const p = `${machineCode}/${uuid}_${this.safeFileName(f.originalname)}`;
      await this.storage.upload(
        MAINT_BUCKET,
        p,
        new Uint8Array(f.buffer),
        f.mimetype || "application/octet-stream",
        false,
      );
      paths.push(p);
    }
    if (!paths.length) {
      throw new UnprocessableEntityException(
        "Nijedna fotografija nije prihvaćena",
      );
    }
    const ok = await this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT public.maint_attach_incident_files(${id}::uuid, ${paths}::text[]) AS ok`,
      );
      return rows[0]?.ok === true;
    });
    // RPC je autoritet (reported_by = auth.uid()). Ako odbije (nisi prijavilac),
    // OČISTI upload-ovane bajtove — inače ostaju kao orphan u bucketu (review nalaz,
    // merge-klasa „autorizacija oko upload-a"; RPC ostaje jedini izvor authz-a).
    if (!ok) {
      await Promise.allSettled(
        paths.map((p) => this.storage.remove(MAINT_BUCKET, p)),
      );
      throw new ForbiddenException(
        "Prilaganje fotografija dozvoljeno je samo prijaviocu incidenta.",
      );
    }
    return { data: { attached: ok, paths } };
  }

  // ---------- Radni nalozi: CRUD + events/parts/labor ----------

  /** Kreiraj WO (reported_by = ja; wo_number dodeljuje trigger — NE generišemo ga). */
  createWorkOrder(email: string, dto: CreateWorkOrderDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-work-order",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintWorkOrder.create({
          data: {
            type: dto.type as never,
            assetId: dto.assetId,
            assetType: dto.assetType as never,
            title: dto.title,
            description: dto.description ?? null,
            priority: dto.priority as never,
            safetyMarker: dto.safetyMarker === true,
            status: "novi",
            reportedBy: uid!,
            dueAt: this.toDbTs(dto.dueAt) ?? null,
            sourceIncidentId: dto.sourceIncidentId ?? null,
          },
        });
      },
    );
  }

  /** Kanban status/dodela/prioritet/rok/closure. wo_events piše trigger — NE dupliramo. */
  async updateWorkOrder(email: string, id: string, dto: UpdateWorkOrderDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintWorkOrder.count({ where: { woId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintWorkOrder.updateMany({
        where: { woId: id },
        data: {
          ...(dto.status !== undefined ? { status: dto.status as never } : {}),
          ...(dto.priority !== undefined
            ? { priority: dto.priority as never }
            : {}),
          ...(dto.assignedTo !== undefined
            ? { assignedTo: dto.assignedTo }
            : {}),
          ...(dto.dueAt !== undefined ? { dueAt: this.toDbTs(dto.dueAt) } : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.closureComment !== undefined
            ? { closureComment: dto.closureComment }
            : {}),
          ...(dto.startedAt !== undefined
            ? { startedAt: this.toDbTs(dto.startedAt) }
            : {}),
          ...(dto.completedAt !== undefined
            ? { completedAt: this.toDbTs(dto.completedAt) }
            : {}),
          ...(dto.downtimeFrom !== undefined
            ? { downtimeFrom: this.toDbTs(dto.downtimeFrom) }
            : {}),
          ...(dto.downtimeTo !== undefined
            ? { downtimeTo: this.toDbTs(dto.downtimeTo) }
            : {}),
          ...(dto.laborMinutes !== undefined
            ? { laborMinutes: dto.laborMinutes }
            : {}),
          ...(dto.costTotal !== undefined ? { costTotal: dto.costTotal } : {}),
          ...(dto.estimatedCost !== undefined
            ? { estimatedCost: dto.estimatedCost }
            : {}),
          ...(dto.safetyMarker !== undefined
            ? { safetyMarker: dto.safetyMarker }
            : {}),
          ...(dto.vehicleServiceCategory !== undefined
            ? { vehicleServiceCategory: dto.vehicleServiceCategory as never }
            : {}),
          ...(dto.odometerKmAtService !== undefined
            ? { odometerKmAtService: dto.odometerKmAtService }
            : {}),
          ...(dto.externalServicerName !== undefined
            ? { externalServicerName: dto.externalServicerName }
            : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Radni nalog ${id}`);
      const wo = await tx.maintWorkOrder.findUnique({ where: { woId: id } });
      return {
        data: wo ? { ...wo, group: WO_GROUP[wo.status] ?? null } : null,
      };
    });
  }

  async deleteWorkOrder(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintWorkOrder.count({ where: { woId: id } })) > 0;
      const { count } = await tx.maintWorkOrder.deleteMany({
        where: { woId: id },
      });
      this.assertAffected(exists, count, `Radni nalog ${id}`);
      return { data: { ok: true } };
    });
  }

  createWoEvent(email: string, id: string, dto: WorkOrderEventDto) {
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const row = await tx.maintWoEvent.create({
        data: {
          woId: id,
          actor: uid,
          eventType: dto.eventType,
          comment: dto.comment ?? null,
          fromValue: dto.fromValue ?? null,
          toValue: dto.toValue ?? null,
        },
      });
      return { data: row };
    });
  }

  createWoPart(email: string, id: string, dto: WorkOrderPartDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-wo-part",
      async (tx) =>
        tx.maintWoPart.create({
          data: {
            woId: id,
            partName: dto.partName.trim(),
            partId: dto.partId ?? null,
            quantity: dto.quantity ?? null,
            unit: dto.unit ?? null,
            unitCost: dto.unitCost ?? null,
            supplier: dto.supplier ?? null,
          },
        }),
    );
  }

  createWoLabor(email: string, id: string, dto: WorkOrderLaborDto) {
    if (!Number.isFinite(dto.minutes) || dto.minutes <= 0) {
      throw new UnprocessableEntityException("Minuti rada moraju biti > 0");
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-wo-labor",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintWoLabor.create({
          data: {
            woId: id,
            technicianId: uid,
            minutes: Math.round(dto.minutes),
            notes: dto.notes ?? null,
          },
        });
      },
    );
  }

  // ---------- Vozila (RPC create/archive/restore + details + pod-entiteti) ----------

  createVehicle(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_vehicle",
      "create-vehicle",
    );
  }
  createItAsset(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_it_asset",
      "create-it-asset",
    );
  }
  createFacility(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_facility",
      "create-facility",
    );
  }

  private createAssetViaRpc(
    email: string,
    dto: CreateMaintAssetDto,
    fn: string,
    action: string,
  ) {
    return this.runIdem(
      email,
      dto.clientEventId,
      `odrzavanje.${action}`,
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string | null }[]>(
          Prisma.sql`SELECT public.${Prisma.raw(fn)}(
          ${dto.assetCode.trim()}, ${dto.name.trim()}, ${dto.status ?? "running"},
          ${dto.manufacturer ?? null}, ${dto.model ?? null}, ${dto.serialNumber ?? null},
          ${dto.supplier ?? null}, ${dto.assetNotes ?? null},
          ${JSON.stringify(dto.details ?? {})}::jsonb) AS id`,
        );
        return { assetId: rows[0]?.id ?? null };
      },
    );
  }

  archiveVehicle(email: string, assetId: string, reason: string) {
    return this.rpcBool(
      email,
      "archive_maint_vehicle",
      Prisma.sql`${assetId}::uuid, ${reason}`,
    );
  }
  restoreVehicle(email: string, assetId: string) {
    return this.rpcBool(
      email,
      "restore_maint_vehicle",
      Prisma.sql`${assetId}::uuid`,
    );
  }
  /** archive/restore IT+objekti (isti RPC za oba; guard asset_type IN it/facility). */
  archiveAsset(email: string, assetId: string, reason: string) {
    return this.rpcBool(
      email,
      "archive_maint_asset",
      Prisma.sql`${assetId}::uuid, ${reason}`,
    );
  }
  restoreAsset(email: string, assetId: string) {
    return this.rpcBool(
      email,
      "restore_maint_asset",
      Prisma.sql`${assetId}::uuid`,
    );
  }

  private rpcBool(email: string, fn: string, args: Prisma.Sql) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT public.${Prisma.raw(fn)}(${args}) AS ok`,
      );
      return { data: { ok: rows[0]?.ok === true } };
    });
  }

  /**
   * PATCH core `maint_assets` reda (HIGH#2 paritet 1.0 `patchMaintAsset`) — vozilo/IT/objekat.
   * `location_id`/`responsible_user_id` create RPC NE prima → ovo je jedini put da se postave
   * (1.0 to radi naknadnim patch-om). `null` = unassign; undefined = ne diraj. Row-odluka
   * (asset_visible ∧ erp/chief/admin — `maint_assets_update` RLS) presuđuje DB (42501→403).
   */
  async patchAssetCore(email: string, assetId: string, dto: PatchAssetCoreDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintAsset.count({ where: { assetId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintAsset.updateMany({
        where: { assetId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.status !== undefined ? { status: dto.status as never } : {}),
          ...(dto.manufacturer !== undefined
            ? { manufacturer: dto.manufacturer }
            : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.serialNumber !== undefined
            ? { serialNumber: dto.serialNumber }
            : {}),
          ...(dto.supplier !== undefined ? { supplier: dto.supplier } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.locationId !== undefined
            ? { locationId: dto.locationId }
            : {}),
          ...(dto.responsibleUserId !== undefined
            ? { responsibleUserId: dto.responsibleUserId }
            : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Sredstvo ${assetId}`);
      return { data: await tx.maintAsset.findUnique({ where: { assetId } }) };
    });
  }

  /** Allowlist kolona details (paritet 1.0 upsert body — nema mass-assignment). */
  private pickVehicleDetails(d: Record<string, unknown>) {
    const s = (k: string) =>
      d[k] == null || d[k] === "" ? null : String(d[k]);
    const n = (k: string) =>
      d[k] == null || d[k] === "" ? null : Number(d[k]);
    const b = (k: string) => Boolean(d[k]);
    return {
      registrationPlate: s("registration_plate"),
      vin: s("vin"),
      odometerKm: n("odometer_km"),
      fuelType: s("fuel_type"),
      registrationExpiresAt:
        this.toDbDate(s("registration_expires_at")) ?? null,
      insuranceExpiresAt: this.toDbDate(s("insurance_expires_at")) ?? null,
      serviceDueAt: this.toDbDate(s("service_due_at")) ?? null,
      serviceIntervalKm: n("service_interval_km"),
      nextServiceMileageKm: n("next_service_mileage_km"),
      notes: s("notes"),
      yearOfManufacture: n("year_of_manufacture"),
      vehicleKind: (s("vehicle_kind") as never) ?? null,
      payloadKg: n("payload_kg"),
      passengerSeats: n("passenger_seats"),
      usageType: (s("usage_type") as never) ?? null,
      gpsProvider: ((s("gps_provider") as never) ?? "nema") as never,
      gpsDeviceId: s("gps_device_id"),
      firstAidKitExpiresAt:
        this.toDbDate(s("first_aid_kit_expires_at")) ?? null,
      isPrivateVehicle: b("is_private_vehicle"),
      ownerId: s("owner_id"),
      primaryDriverId: s("primary_driver_id"),
    };
  }

  /** Upsert details vozila (PK asset_id; paritet upsertMaintVehicleDetails). */
  async upsertVehicleDetails(
    email: string,
    assetId: string,
    dto: DetailsUpsertDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const base = { ...this.pickVehicleDetails(dto.details), updatedBy: uid };
      const row = await tx.maintVehicleDetails.upsert({
        where: { assetId },
        create: { assetId, ...base },
        update: base,
      });
      return { data: row };
    });
  }

  patchVehicleTollTag(email: string, assetId: string, dto: TollTagDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleDetails.count({ where: { assetId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintVehicleDetails.updateMany({
        where: { assetId },
        data: {
          tollTagSerial: dto.tollTagSerial ?? null,
          tollTagProvider: dto.tollTagProvider ?? null,
          tollTagNotes: dto.tollTagNotes ?? null,
          updatedBy: uid,
        },
      });
      this.assertAffected(exists, count, `Detalji vozila ${assetId}`);
      return { data: { ok: true } };
    });
  }

  patchVehicleShelf(email: string, assetId: string, dto: ShelfDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleDetails.count({ where: { assetId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintVehicleDetails.updateMany({
        where: { assetId },
        data: {
          ...(dto.hasPartsSet !== undefined
            ? { hasPartsSet: dto.hasPartsSet }
            : {}),
          ...(dto.partsShelf !== undefined
            ? { partsShelf: dto.partsShelf || null }
            : {}),
          ...(dto.partsNotes !== undefined
            ? { partsNotes: dto.partsNotes || null }
            : {}),
          updatedBy: uid,
        },
      });
      this.assertAffected(exists, count, `Detalji vozila ${assetId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- IT/objekti details upsert (allowlist) ----------

  async upsertItDetails(email: string, assetId: string, dto: DetailsUpsertDto) {
    const d = dto.details;
    const s = (k: string) =>
      d[k] == null || d[k] === "" ? null : String(d[k]);
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const base = {
        deviceType: s("device_type"),
        hostname: s("hostname"),
        ipAddress: s("ip_address"),
        macAddress: s("mac_address"),
        operatingSystem: s("operating_system"),
        assignedTo: s("assigned_to"),
        licenseKey: s("license_key"),
        licenseExpiresAt: this.toDbDate(s("license_expires_at")) ?? null,
        warrantyExpiresAt: this.toDbDate(s("warranty_expires_at")) ?? null,
        backupRequired: Boolean(d.backup_required),
        lastBackupAt: this.toDbTs(s("last_backup_at")) ?? null,
        notes: s("notes"),
        updatedBy: uid,
      };
      const row = await tx.maintItAssetDetails.upsert({
        where: { assetId },
        create: { assetId, ...base },
        update: base,
      });
      return { data: row };
    });
  }

  async upsertFacilityDetails(
    email: string,
    assetId: string,
    dto: DetailsUpsertDto,
  ) {
    const d = dto.details;
    const s = (k: string) =>
      d[k] == null || d[k] === "" ? null : String(d[k]);
    const n = (k: string) =>
      d[k] == null || d[k] === "" ? null : Number(d[k]);
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      const base = {
        facilityType: s("facility_type"),
        floorAreaM2: n("floor_area_m2"),
        floorOrZone: s("floor_or_zone"),
        criticality: s("criticality"),
        inspectionDueAt: this.toDbDate(s("inspection_due_at")) ?? null,
        fireSafetyDueAt: this.toDbDate(s("fire_safety_due_at")) ?? null,
        serviceContract: s("service_contract"),
        serviceProvider: s("service_provider"),
        lastInspectionAt: this.toDbDate(s("last_inspection_at")) ?? null,
        notes: s("notes"),
        updatedBy: uid,
      };
      const row = await tx.maintFacilityDetails.upsert({
        where: { assetId },
        create: { assetId, ...base },
        update: base,
      });
      return { data: row };
    });
  }

  // ---------- Gume ----------

  createTire(email: string, assetId: string, dto: CreateTireDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-tire",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintVehicleTire.create({
          data: {
            assetId,
            season: dto.season as never,
            dimension: dto.dimension,
            count: dto.count,
            status: (dto.status ?? "koriscene") as never,
            shelfCode: dto.shelfCode ?? null,
            installedOnVehicle: dto.installedOnVehicle === true,
            purchasedAt: this.toDbDate(dto.purchasedAt) ?? null,
            notes: dto.notes ?? null,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateTire(email: string, tireId: string, dto: UpdateTireDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleTire.count({ where: { tireSetId: tireId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintVehicleTire.updateMany({
        where: { tireSetId: tireId },
        data: {
          ...(dto.season !== undefined ? { season: dto.season as never } : {}),
          ...(dto.dimension !== undefined ? { dimension: dto.dimension } : {}),
          ...(dto.count !== undefined ? { count: dto.count } : {}),
          ...(dto.status !== undefined ? { status: dto.status as never } : {}),
          ...(dto.shelfCode !== undefined ? { shelfCode: dto.shelfCode } : {}),
          ...(dto.installedOnVehicle !== undefined
            ? { installedOnVehicle: dto.installedOnVehicle }
            : {}),
          ...(dto.purchasedAt !== undefined
            ? { purchasedAt: this.toDbDate(dto.purchasedAt) }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Guma ${tireId}`);
      return { data: { ok: true } };
    });
  }

  async deleteTire(email: string, tireId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleTire.count({ where: { tireSetId: tireId } })) > 0;
      const { count } = await tx.maintVehicleTire.deleteMany({
        where: { tireSetId: tireId },
      });
      this.assertAffected(exists, count, `Guma ${tireId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Servisni plan vozila + generisanje WO ----------

  createVehicleServicePlan(
    email: string,
    assetId: string,
    dto: CreateVehicleServicePlanDto,
  ) {
    if (dto.intervalKm == null && dto.intervalMonths == null) {
      throw new UnprocessableEntityException("Zadaj interval (km ili meseci)");
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-vehicle-service-plan",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintVehicleServicePlan.create({
          data: {
            assetId,
            name: dto.name.trim(),
            intervalKm: dto.intervalKm ?? null,
            intervalMonths: dto.intervalMonths ?? null,
            lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
            lastDoneKm: dto.lastDoneKm ?? null,
            vehicleServiceCategory:
              (dto.vehicleServiceCategory as never) ?? null,
            priority: (dto.priority ?? "p4_planirano") as never,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateVehicleServicePlan(
    email: string,
    planId: string,
    dto: UpdateVehicleServicePlanDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleServicePlan.count({ where: { planId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintVehicleServicePlan.updateMany({
        where: { planId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.intervalKm !== undefined
            ? { intervalKm: dto.intervalKm }
            : {}),
          ...(dto.intervalMonths !== undefined
            ? { intervalMonths: dto.intervalMonths }
            : {}),
          ...(dto.lastDoneAt !== undefined
            ? { lastDoneAt: this.toDbDate(dto.lastDoneAt) }
            : {}),
          ...(dto.lastDoneKm !== undefined
            ? { lastDoneKm: dto.lastDoneKm }
            : {}),
          ...(dto.vehicleServiceCategory !== undefined
            ? { vehicleServiceCategory: dto.vehicleServiceCategory as never }
            : {}),
          ...(dto.priority !== undefined
            ? { priority: dto.priority as never }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Plan servisa ${planId}`);
      return { data: { ok: true } };
    });
  }

  async deleteVehicleServicePlan(email: string, planId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleServicePlan.count({ where: { planId } })) > 0;
      const { count } = await tx.maintVehicleServicePlan.deleteMany({
        where: { planId },
      });
      this.assertAffected(exists, count, `Plan servisa ${planId}`);
      return { data: { ok: true } };
    });
  }

  /** Generiši WO iz overdue/due_soon plana vozila (RPC; anti-duplikat has_open_wo). */
  ensureVehicleServiceWos(email: string, assetId?: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT public.ensure_vehicle_service_wos(${assetId ?? null}::uuid) AS n`,
      );
      return { data: { created: Number(rows[0]?.n ?? 0) } };
    });
  }

  // ---------- Delovi po vozilu (link/unlink/patch) ----------

  linkPartToVehicle(email: string, assetId: string, dto: LinkPartDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.link-part-vehicle",
      async (tx) =>
        tx.maintPartVehicle.create({
          data: {
            assetId,
            partId: dto.partId,
            qtyMin: dto.qtyMin ?? null,
            notes: dto.notes ?? null,
            createdBy: await this.uid(tx),
            updatedBy: await this.uid(tx),
          },
        }),
    );
  }

  async updatePartVehicleLink(
    email: string,
    assetId: string,
    partId: string,
    dto: UpdatePartLinkDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintPartVehicle.updateMany({
        where: { assetId, partId },
        data: {
          ...(dto.qtyMin !== undefined ? { qtyMin: dto.qtyMin } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Veza deo↔vozilo`);
      return { data: { ok: true } };
    });
  }

  async unlinkPartFromVehicle(email: string, assetId: string, partId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
      const { count } = await tx.maintPartVehicle.deleteMany({
        where: { assetId, partId },
      });
      this.assertAffected(exists, count, `Veza deo↔vozilo`);
      return { data: { ok: true } };
    });
  }

  // ---------- Carpool rezervacije ----------

  createBooking(email: string, assetId: string, dto: CreateBookingDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-booking",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintVehicleBooking.create({
          data: {
            assetId,
            driverId: dto.driverId ?? null,
            startAt: new Date(dto.startAt),
            endAt: new Date(dto.endAt),
            purpose: dto.purpose ?? null,
            status: (dto.status ?? "planirana") as never,
            notes: dto.notes ?? null,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateBooking(email: string, bookingId: string, dto: UpdateBookingDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleBooking.count({ where: { bookingId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintVehicleBooking.updateMany({
        where: { bookingId },
        data: {
          ...(dto.startAt !== undefined
            ? { startAt: new Date(dto.startAt) }
            : {}),
          ...(dto.endAt !== undefined ? { endAt: new Date(dto.endAt) } : {}),
          ...(dto.driverId !== undefined ? { driverId: dto.driverId } : {}),
          ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
          ...(dto.status !== undefined ? { status: dto.status as never } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Rezervacija ${bookingId}`);
      return { data: { ok: true } };
    });
  }

  async deleteBooking(email: string, bookingId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintVehicleBooking.count({ where: { bookingId } })) > 0;
      const { count } = await tx.maintVehicleBooking.deleteMany({
        where: { bookingId },
      });
      this.assertAffected(exists, count, `Rezervacija ${bookingId}`);
      return { data: { ok: true } };
    });
  }

  /** Ručni run rokova vozila (RPC; dedupe u DB → idempotentan). */
  vehicleDeadlineCheck(email: string, dto: DeadlineCheckDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ enqueued: number; skipped: number }[]>(
        Prisma.sql`SELECT * FROM public.maint_check_vehicle_deadlines(${dto.lookaheadDays ?? 30})`,
      );
      const r = rows[0];
      return {
        data: {
          enqueued: Number(r?.enqueued ?? 0),
          skipped: Number(r?.skipped ?? 0),
        },
      };
    });
  }

  // ---------- Vlasnici vozila ----------

  createVehicleOwner(email: string, dto: CreateOwnerDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-owner",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintVehicleOwner.create({
          data: {
            name: dto.name.trim(),
            ownerType: (dto.ownerType ?? "spoljni") as never,
            contact: dto.contact ?? null,
            notes: dto.notes ?? null,
            active: true,
            updatedBy: uid,
          },
        });
      },
    );
  }

  // ---------- Vozači (PII) ----------

  createDriver(email: string, dto: CreateDriverDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-driver",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintDriver.create({
          data: {
            fullName: dto.fullName.trim(),
            isInternal: dto.isInternal !== false,
            authUserId:
              dto.isInternal === false ? null : (dto.authUserId ?? null),
            driversLicenseNumber: dto.driversLicenseNumber.trim(),
            driversLicenseCategories: dto.driversLicenseCategories
              .map((c) => c.trim())
              .filter(Boolean),
            driversLicenseValidUntil: this.toDbDate(
              dto.driversLicenseValidUntil,
            )!,
            idCardNumber: dto.idCardNumber ?? null,
            idCardValidUntil: this.toDbDate(dto.idCardValidUntil) ?? null,
            medicalCheckValidUntil:
              this.toDbDate(dto.medicalCheckValidUntil) ?? null,
            phone: dto.phone ?? null,
            jmbg: dto.jmbg ?? null,
            address: dto.address ?? null,
            notes: dto.notes ?? null,
            active: dto.active !== false,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateDriver(email: string, id: string, dto: UpdateDriverDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintDriver.updateMany({
        where: { driverId: id },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
          ...(dto.isInternal !== undefined
            ? { isInternal: dto.isInternal }
            : {}),
          ...(dto.driversLicenseNumber !== undefined
            ? { driversLicenseNumber: dto.driversLicenseNumber }
            : {}),
          ...(dto.driversLicenseCategories !== undefined
            ? { driversLicenseCategories: dto.driversLicenseCategories }
            : {}),
          ...(dto.driversLicenseValidUntil !== undefined
            ? {
                driversLicenseValidUntil: this.toDbDate(
                  dto.driversLicenseValidUntil,
                ),
              }
            : {}),
          ...(dto.idCardNumber !== undefined
            ? { idCardNumber: dto.idCardNumber }
            : {}),
          ...(dto.idCardValidUntil !== undefined
            ? { idCardValidUntil: this.toDbDate(dto.idCardValidUntil) }
            : {}),
          ...(dto.medicalCheckValidUntil !== undefined
            ? {
                medicalCheckValidUntil: this.toDbDate(
                  dto.medicalCheckValidUntil,
                ),
              }
            : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.jmbg !== undefined ? { jmbg: dto.jmbg } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Vozač ${id}`);
      return {
        data: await tx.maintDriver.findUnique({ where: { driverId: id } }),
      };
    });
  }

  archiveDriver(email: string, id: string, reason: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintDriver.updateMany({
        where: { driverId: id },
        data: {
          archivedAt: new Date(),
          archiveReason: reason.trim(),
          active: false,
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Vozač ${id}`);
      return { data: { ok: true } };
    });
  }

  restoreDriver(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintDriver.updateMany({
        where: { driverId: id },
        data: {
          archivedAt: null,
          archiveReason: null,
          active: true,
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Vozač ${id}`);
      return { data: { ok: true } };
    });
  }

  /** Hard-delete vozača (RLS: erp adm/mgmt ∨ SAMO maint admin profil — chief NE, §2.5.9). */
  async deleteDriver(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
      const { count } = await tx.maintDriver.deleteMany({
        where: { driverId: id },
      });
      this.assertAffected(exists, count, `Vozač ${id}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Servisni plan IT/objekti + generisanje WO ----------

  createAssetServicePlan(
    email: string,
    assetId: string,
    dto: CreateAssetServicePlanDto,
  ) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-asset-service-plan",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintAssetServicePlan.create({
          data: {
            assetId,
            name: dto.name.trim(),
            intervalMonths: dto.intervalMonths,
            lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
            priority: (dto.priority ?? "p4_planirano") as never,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateAssetServicePlan(
    email: string,
    planId: string,
    dto: UpdateAssetServicePlanDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintAssetServicePlan.updateMany({
        where: { planId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.intervalMonths !== undefined
            ? { intervalMonths: dto.intervalMonths }
            : {}),
          ...(dto.lastDoneAt !== undefined
            ? { lastDoneAt: this.toDbDate(dto.lastDoneAt) }
            : {}),
          ...(dto.priority !== undefined
            ? { priority: dto.priority as never }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Plan servisa ${planId}`);
      return { data: { ok: true } };
    });
  }

  async deleteAssetServicePlan(email: string, planId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
      const { count } = await tx.maintAssetServicePlan.deleteMany({
        where: { planId },
      });
      this.assertAffected(exists, count, `Plan servisa ${planId}`);
      return { data: { ok: true } };
    });
  }

  ensureAssetServiceWos(email: string, assetId?: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT public.ensure_asset_service_wos(${assetId ?? null}::uuid) AS n`,
      );
      return { data: { created: Number(rows[0]?.n ?? 0) } };
    });
  }

  // ---------- Zalihe: delovi + dobavljači + stock ledger (insert-only) ----------

  createPart(email: string, dto: CreatePartDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-part",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintPart.create({
          data: {
            partCode: dto.partCode.trim(),
            name: dto.name.trim(),
            description: dto.description ?? null,
            unit: dto.unit ?? "kom",
            supplierId: dto.supplierId ?? null,
            manufacturer: dto.manufacturer ?? null,
            model: dto.model ?? null,
            minStock: dto.minStock ?? 0,
            currentStock: dto.currentStock ?? 0,
            unitCost: dto.unitCost ?? null,
            active: dto.active ?? true,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updatePart(email: string, id: string, dto: UpdatePartDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.maintPart.count({ where: { partId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintPart.updateMany({
        where: { partId: id },
        data: {
          ...(dto.partCode !== undefined ? { partCode: dto.partCode } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
          ...(dto.supplierId !== undefined
            ? { supplierId: dto.supplierId }
            : {}),
          ...(dto.manufacturer !== undefined
            ? { manufacturer: dto.manufacturer }
            : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.minStock !== undefined ? { minStock: dto.minStock } : {}),
          // current_stock održava trigger iz ledger-a; ručni patch dozvoljen (paritet 1.0).
          ...(dto.currentStock !== undefined
            ? { currentStock: dto.currentStock }
            : {}),
          ...(dto.unitCost !== undefined ? { unitCost: dto.unitCost } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Deo ${id}`);
      return { data: await tx.maintPart.findUnique({ where: { partId: id } }) };
    });
  }

  /** Insert-only kretanje zaliha (trigger primenjuje delta na current_stock; sme u minus). */
  createStockMovement(email: string, partId: string, dto: StockMovementDto) {
    if (!Number.isFinite(dto.quantity) || dto.quantity === 0) {
      throw new UnprocessableEntityException(
        "Količina mora biti različita od 0",
      );
    }
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-stock-movement",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintPartStockMovement.create({
          data: {
            partId,
            woId: dto.woId ?? null,
            movementType: dto.movementType as never,
            quantity: dto.quantity,
            unitCost: dto.unitCost ?? null,
            note: dto.note ?? null,
            createdBy: uid,
          },
        });
      },
    );
  }

  createSupplier(email: string, dto: CreateSupplierDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-supplier",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintSupplier.create({
          data: {
            name: dto.name.trim(),
            contact: dto.contact ?? null,
            email: dto.email ?? null,
            phone: dto.phone ?? null,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateSupplier(email: string, id: string, dto: UpdateSupplierDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintSupplier.count({ where: { supplierId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintSupplier.updateMany({
        where: { supplierId: id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.contact !== undefined ? { contact: dto.contact } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Dobavljač ${id}`);
      return {
        data: await tx.maintSupplier.findUnique({ where: { supplierId: id } }),
      };
    });
  }

  // ---------- CMMS lokacije (≠ loc_locations) ----------

  createLocation(email: string, dto: CreateLocationDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-location",
      async (tx) =>
        tx.maintLocation.create({
          data: {
            name: dto.name.trim(),
            code: dto.code?.trim() || null,
            locationType: dto.locationType?.trim() || "lokacija",
            parentLocationId: dto.parentLocationId ?? null,
            active: dto.active ?? true,
          },
        }),
    );
  }

  async updateLocation(email: string, id: string, dto: UpdateLocationDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintLocation.count({ where: { locationId: id } })) > 0;
      const { count } = await tx.maintLocation.updateMany({
        where: { locationId: id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code || null } : {}),
          ...(dto.locationType !== undefined
            ? { locationType: dto.locationType }
            : {}),
          ...(dto.parentLocationId !== undefined
            ? { parentLocationId: dto.parentLocationId }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Lokacija ${id}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Dokumenta (storage proxy F4; svi entiteti + valid_until) ----------

  /** Upload dokumenta (meta PRE bajtova; putanja `documents/<entity>/<id>/…` — 1.0 kompat). */
  async uploadDocument(
    email: string,
    dto: UploadDocumentDto,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException(
        "Očekivan fajl (multipart `file`)",
      );
    }
    const uuid = randomUUID().replace(/-/g, "").slice(0, 16);
    const storagePath = `documents/${dto.entityType}/${dto.entityId}/${uuid}_${this.safeFileName(file.originalname)}`;
    const meta = await this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      return tx.maintDocument.create({
        data: {
          entityType: dto.entityType as never,
          entityId: dto.entityId,
          assetId: dto.entityType === "asset" ? dto.entityId : null,
          woId: dto.entityType === "work_order" ? dto.entityId : null,
          incidentId: dto.entityType === "incident" ? dto.entityId : null,
          preventiveTaskId:
            dto.entityType === "preventive_task" ? dto.entityId : null,
          driverId: dto.entityType === "driver" ? dto.entityId : null,
          fileName: file.originalname,
          storagePath,
          mimeType: file.mimetype ?? null,
          sizeBytes: BigInt(file.buffer.length),
          category: dto.category ?? null,
          description: dto.description ?? null,
          validUntil: this.toDbDate(dto.validUntil) ?? null,
          uploadedBy: uid,
        },
      });
    });
    try {
      await this.storage.upload(
        MAINT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype || "application/octet-stream",
        false,
      );
    } catch (e) {
      await this.withUserMapped(email, async (tx) => {
        await tx.maintDocument.deleteMany({
          where: { documentId: meta.documentId },
        });
      }).catch(() => {});
      throw e;
    }
    return { data: this.withNumSize(meta) };
  }

  updateDocument(email: string, id: string, dto: UpdateDocumentDto) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintDocument.count({ where: { documentId: id } })) > 0;
      const { count } = await tx.maintDocument.updateMany({
        where: { documentId: id },
        data: {
          ...(dto.validUntil !== undefined
            ? { validUntil: this.toDbDate(dto.validUntil) }
            : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
      });
      this.assertAffected(exists, count, `Dokument ${id}`);
      return { data: { ok: true } };
    });
  }

  async deleteDocument(email: string, id: string) {
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.maintDocument.findUnique({
        where: { documentId: id },
        select: { storagePath: true },
      });
      const exists = !!row;
      const { count } = await tx.maintDocument.updateMany({
        where: { documentId: id },
        data: { deletedAt: new Date() },
      });
      this.assertAffected(exists, count, `Dokument ${id}`);
      return row?.storagePath ?? null;
    });
    if (path) await this.storage.remove(MAINT_BUCKET, path);
    return { data: { ok: true } };
  }

  /** Presigned URL dokumenta (RLS SELECT presuđuje vidljivost PRE potpisivanja). */
  async signDocument(email: string, id: string) {
    const path = await this.withUserMapped(email, async (tx) => {
      const row = await tx.maintDocument.findUnique({
        where: { documentId: id },
        select: { storagePath: true, deletedAt: true },
      });
      if (!row || row.deletedAt)
        throw new NotFoundException(`Dokument ${id} ne postoji`);
      return row.storagePath;
    });
    return { data: await this.storage.signUrl(MAINT_BUCKET, path, 300) };
  }

  // ---------- Podešavanja / notifikaciona pravila / retry ----------

  updateSettings(email: string, dto: UpdateSettingsDto) {
    return this.withUserMapped(email, async (tx) => {
      const uid = await this.uid(tx);
      await tx.maintSettings.updateMany({
        where: { id: 1 },
        data: {
          ...(dto.autoCreateWoMajor !== undefined
            ? { autoCreateWoMajor: dto.autoCreateWoMajor }
            : {}),
          ...(dto.autoCreateWoCritical !== undefined
            ? { autoCreateWoCritical: dto.autoCreateWoCritical }
            : {}),
          ...(dto.safetyMarkerRequiresWo !== undefined
            ? { safetyMarkerRequiresWo: dto.safetyMarkerRequiresWo }
            : {}),
          ...(dto.defaultWoPriority !== undefined
            ? { defaultWoPriority: dto.defaultWoPriority as never }
            : {}),
          ...(dto.majorWoDueHours !== undefined
            ? { majorWoDueHours: dto.majorWoDueHours }
            : {}),
          ...(dto.criticalWoDueHours !== undefined
            ? { criticalWoDueHours: dto.criticalWoDueHours }
            : {}),
          ...(dto.preventiveDueWarningDays !== undefined
            ? { preventiveDueWarningDays: dto.preventiveDueWarningDays }
            : {}),
          ...(dto.notificationEnabled !== undefined
            ? { notificationEnabled: dto.notificationEnabled }
            : {}),
          ...(dto.notifyOnMajorIncident !== undefined
            ? { notifyOnMajorIncident: dto.notifyOnMajorIncident }
            : {}),
          ...(dto.notifyOnCriticalIncident !== undefined
            ? { notifyOnCriticalIncident: dto.notifyOnCriticalIncident }
            : {}),
          ...(dto.notifyOnOverduePreventive !== undefined
            ? { notifyOnOverduePreventive: dto.notifyOnOverduePreventive }
            : {}),
          ...(dto.notificationChannels !== undefined
            ? { notificationChannels: dto.notificationChannels as never }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      return { data: await tx.maintSettings.findUnique({ where: { id: 1 } }) };
    });
  }

  createNotificationRule(email: string, dto: CreateNotificationRuleDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-notif-rule",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintNotificationRule.create({
          data: {
            eventType: dto.eventType ?? "incident_created",
            severity: dto.severity ?? null,
            assetType: (dto.assetType as never) ?? null,
            targetRole: (dto.targetRole as never) ?? null,
            channel: (dto.channel ?? "in_app") as never,
            delayMinutes: dto.delayMinutes ?? 0,
            escalationLevel: dto.escalationLevel ?? 0,
            enabled: dto.enabled ?? true,
            notes: dto.notes ?? null,
            updatedBy: uid,
          },
        });
      },
    );
  }

  async updateNotificationRule(
    email: string,
    id: string,
    dto: UpdateNotificationRuleDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.maintNotificationRule.count({ where: { ruleId: id } })) > 0;
      const uid = await this.uid(tx);
      const { count } = await tx.maintNotificationRule.updateMany({
        where: { ruleId: id },
        data: {
          ...(dto.eventType !== undefined ? { eventType: dto.eventType } : {}),
          ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
          ...(dto.assetType !== undefined
            ? { assetType: dto.assetType as never }
            : {}),
          ...(dto.targetRole !== undefined
            ? { targetRole: dto.targetRole as never }
            : {}),
          ...(dto.channel !== undefined
            ? { channel: dto.channel as never }
            : {}),
          ...(dto.delayMinutes !== undefined
            ? { delayMinutes: dto.delayMinutes }
            : {}),
          ...(dto.escalationLevel !== undefined
            ? { escalationLevel: dto.escalationLevel }
            : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Pravilo ${id}`);
      return {
        data: await tx.maintNotificationRule.findUnique({
          where: { ruleId: id },
        }),
      };
    });
  }

  /** Retry pale notifikacije (RPC: failed → queued; erp-admin ∨ chief/admin). Dispatch OSTAJE MRTAV (F1). */
  retryNotification(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ ok: boolean }[]>(
        Prisma.sql`SELECT public.maint_notification_retry(${id}::uuid) AS ok`,
      );
      return { data: { requeued: rows[0]?.ok === true } };
    });
  }

  // ============================================================================
  // Maint profili (SoD; audit H19/H20 — BE strana ekrana „Profili održavanja")
  // ============================================================================
  // Mutacije SAMO ERP admin (assertErpAdmin) — NE admin_ui krug (menadzment/magacioner
  // NE smeju menjati profile). DB trigger `maint_profiles_guard_role` ostaje jedina tvrda
  // granica za role/active. Sve ide kroz withUserRls/runIdempotentRls (RLS + SET ROLE).

  /**
   * Puna lista profila (admin konzola). Guard = ERP admin; RLS profila
   * (`auth.uid() = user_id ∨ erp-admin`) ionako ostalima daje samo svoj red, pa list
   * bez erp-admina nema smisla → 403 (paritet 1.0 `fetchAllMaintProfiles`, ekran je
   * u CMMS Podešavanjima, samo za administraciju).
   */
  async listProfiles(email: string) {
    return this.withUserMapped(email, async (tx) => {
      await this.assertErpAdmin(tx);
      const data = await tx.maintUserProfile.findMany({
        orderBy: { fullName: "asc" },
        take: 500,
      });
      return { data };
    });
  }

  /**
   * Novi profil. Guard = ERP admin. EKSPLICITNA provera duplikata `userId` — 1.0
   * `insertMaintProfile` (sbReq POST) default-uje merge-duplicates pa bi ponovljen
   * user_id TIHO pregazio postojeći profil (§5.1 pravilo 22). Idempotentno po
   * `clientEventId`.
   */
  createProfile(email: string, dto: CreateProfileDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "odrzavanje.create-profile",
      async (tx) => {
        await this.assertErpAdmin(tx);
        const existing = await tx.maintUserProfile.findUnique({
          where: { userId: dto.userId },
        });
        if (existing) {
          throw new ConflictException(
            "Profil sa ovim korisničkim ID-em već postoji (koristi izmenu)",
          );
        }
        return tx.maintUserProfile.create({
          data: {
            userId: dto.userId,
            fullName: dto.fullName.trim(),
            role: dto.role as never,
            assignedMachineCodes: (dto.assignedMachineCodes ?? [])
              .map((c) => c.trim())
              .filter(Boolean),
            phone: dto.phone ?? null,
            telegramChatId: dto.telegramChatId ?? null,
            active: dto.active !== false,
          },
        });
      },
    );
  }

  /**
   * Izmena profila. Guard = ERP admin (SoD; menadzment/magacioner NE smeju).
   * `role`/`active` menja ionako samo erp-admin (DB trigger). Idempotentan PATCH.
   */
  async updateProfile(email: string, id: string, dto: UpdateProfileDto) {
    return this.withUserMapped(email, async (tx) => {
      await this.assertErpAdmin(tx);
      const exists =
        (await tx.maintUserProfile.count({ where: { userId: id } })) > 0;
      const { count } = await tx.maintUserProfile.updateMany({
        where: { userId: id },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
          ...(dto.role !== undefined ? { role: dto.role as never } : {}),
          ...(dto.assignedMachineCodes !== undefined
            ? {
                assignedMachineCodes: dto.assignedMachineCodes
                  .map((c) => c.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.telegramChatId !== undefined
            ? { telegramChatId: dto.telegramChatId }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists, count, `Profil ${id}`);
      return {
        data: await tx.maintUserProfile.findUnique({ where: { userId: id } }),
      };
    });
  }

  // ============================================================================
  // Lookups — employees (auto-detect vozača; §5.1 pravilo 12, best-effort, uski select)
  // ============================================================================

  /**
   * Uski select nad `employees` za auto-detect zaposlenog u driver modalu (paritet 1.0
   * `fetchEmployeesForMatching`, maintDriversPanel.js:173-207). Vraća SAMO id + ime +
   * email (NIKAD PII kolone — JMBG/adresa/banka). Normalizaciju imena (`maint_normalize_name`:
   * dj→d, kvačice) radi FE nad ovim skupom. Guard = write krug (kao driver mutacije);
   * čita se pod `authenticated` (employees RLS = isti kao 1.0 PostgREST → paritet).
   */
  async lookupEmployees(email: string, q?: string) {
    const term = (q ?? "").trim();
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.employee.findMany({
        where: {
          isActive: true,
          ...(term
            ? {
                OR: [
                  { fullName: { contains: term, mode: "insensitive" } },
                  { firstName: { contains: term, mode: "insensitive" } },
                  { lastName: { contains: term, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          fullName: true,
          firstName: true,
          lastName: true,
          email: true,
        },
        orderBy: { lastName: "asc" },
        take: 500,
      });
      return { data };
    });
  }
}
