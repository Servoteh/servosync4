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

@Injectable()
export class OdrzavanjeService {
  constructor(private readonly sy15: Sy15Service) {}

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
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}
