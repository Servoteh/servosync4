'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

/**
 * Održavanje (CMMS) — 3.0 TALAS F (backend docs/design/MODULE_SPEC_odrzavanje_30.md).
 * Tipizovan klijent + TanStack hooks nad `/api/v1/maintenance/*`. Podaci žive u
 * sy15 (1.0) bazi; BE vraća DVE vrste oblika:
 *   • Prisma modeli (mašine/WO/incidenti/delovi/…) → camelCase polja,
 *   • sy15 view-ovi (overview/due/importable/…) → snake_case kolone (paritet 1.0).
 *
 * Dvoslojni authz: coarse permisije (odrzavanje.read/report/write/admin_ui) gate-uju
 * kapiju; FINU odluku UI donosi po `/maintenance/me` (maintRole + gates). Row-scope
 * presuđuje 102 sy15 RLS politike — FE ih NE duplira, samo prikazuje afordanse.
 */

// ══════════════════════════════════════════════════ helpers

/**
 * Idempotency ključ mutacije (BE `runIdempotentRls`): generiši JEDNOM po klik-akciji,
 * prosledi u variables — retry ISTE akcije nosi ISTI ključ. `crypto.randomUUID` postoji
 * samo u secure context-u (https/localhost); na LAN http:// pada na `getRandomValues`.
 */
export function newClientEventId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const BASE = '/v1/maintenance';

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
type List<T> = { data: T[]; meta: PageMeta };
type Rows<T> = { data: T[] };
type One<T> = { data: T };
/** Snake_case red sy15 view-a — poznate kolone + slobodan pristup ostalima. */
export type ViewRow = Record<string, unknown>;

// ══════════════════════════════════════════════════ tipovi (enumi)

export type OpStatus = 'running' | 'degraded' | 'down' | 'maintenance';
export type WoStatus =
  | 'novi' | 'potvrden' | 'dodeljen' | 'u_radu' | 'ceka_deo'
  | 'ceka_dobavljaca' | 'ceka_korisnika' | 'kontrola' | 'zavrsen' | 'otkazan';
export type WoGroup = 'novi' | 'u_toku' | 'ceka' | 'zavrseno';
export type WoPriority = 'p1_zastoj' | 'p2_smetnja' | 'p3_manje' | 'p4_planirano';
export type WoType = 'kvar' | 'preventiva' | 'inspekcija' | 'servis' | 'administrativni' | 'incident' | 'preventive';
export type AssetType = 'machine' | 'vehicle' | 'it' | 'facility';
export type IncidentStatus = 'open' | 'acknowledged' | 'in_progress' | 'awaiting_parts' | 'resolved' | 'closed';
export type IncidentSeverity = 'minor' | 'major' | 'critical';
export type CheckResult = 'ok' | 'warning' | 'fail' | 'skipped';
export type MaintRole = 'operator' | 'technician' | 'chief' | 'management' | 'admin';
export type IntervalUnit = 'hours' | 'days' | 'weeks' | 'months';
export type TireSeason = 'summer' | 'winter' | 'all_season';
export type TireStatus = 'nove' | 'koriscene' | 'dotrajale' | 'bacene';
export type OwnerType = 'firma' | 'leasing' | 'zaposleni' | 'spoljni';
export type BookingStatus = 'planirana' | 'u_toku' | 'zavrsena' | 'otkazana';
export type StockMovementType = 'in' | 'out' | 'adjustment' | 'return';
export type NotifChannel = 'telegram' | 'email' | 'in_app' | 'whatsapp';
export type NotifStatus = 'queued' | 'sent' | 'failed' | 'cancelled';
export type DocEntity = 'asset' | 'work_order' | 'incident' | 'preventive_task' | 'driver';

// ══════════════════════════════════════════════════ /me

export interface MaintGates {
  canManageMaintCatalog: boolean;
  canManageMaintTasks: boolean;
  canEditWorkOrder: boolean;
  canManageMaintOverride: boolean;
  canAccessMaintNotifications: boolean;
  canManageInventory: boolean;
  canMoveInventory: boolean;
  canCreateWo: boolean;
}
export interface MaintProfile {
  userId: string;
  fullName: string;
  role: MaintRole;
  assignedMachineCodes: string[];
  active: boolean;
  phone: string | null;
  telegramChatId: string | null;
}
export interface MaintMe {
  maintRole: MaintRole | null;
  floorRead: boolean;
  erpAdmin: boolean;
  erpAdminOrManagement: boolean;
  profile: MaintProfile | null;
  gates: MaintGates;
}

export function useMaintMe() {
  return useQuery({
    queryKey: ['odr', 'me'],
    staleTime: 60_000,
    queryFn: () => apiFetch<One<MaintMe>>(`${BASE}/me`),
  });
}

// ══════════════════════════════════════════════════ dashboard

export interface DashboardData {
  machineStatus: ViewRow[];
  dailySummary: Record<string, number> | null;
  categoryCounts: { asset_type: string; n: number }[];
  openIncidents: number;
  openWorkOrders: number;
}
export function useDashboard() {
  return useQuery({
    queryKey: ['odr', 'dashboard'],
    queryFn: () => apiFetch<One<DashboardData>>(`${BASE}/dashboard`),
  });
}

// ══════════════════════════════════════════════════ board (#33)

export interface BoardDue {
  task_id: string;
  machine_code: string;
  title: string;
  severity: string | null;
  interval_value: number | null;
  interval_unit: string | null;
  next_due_at: string;
  bucket: string;
}
export interface BoardOverride {
  machineCode: string;
  status: string;
  reason: string | null;
  validUntil: string | null;
}
export interface BoardData {
  overdue: BoardDue[];
  today: BoardDue[];
  week: BoardDue[];
  overrides: BoardOverride[];
  machineNames: { machineCode: string; name: string }[];
}
export function useBoard() {
  return useQuery({
    queryKey: ['odr', 'board'],
    queryFn: () => apiFetch<One<BoardData>>(`${BASE}/board`),
  });
}

// ══════════════════════════════════════════════════ mašine

export interface Machine {
  machineCode: string;
  name: string;
  type: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  yearOfManufacture: number | null;
  yearCommissioned: number | null;
  location: string | null;
  departmentId: string | null;
  powerKw: string | number | null;
  weightKg: string | number | null;
  notes: string | null;
  tracked: boolean;
  archivedAt: string | null;
  source: string;
  responsibleUserId: string | null;
  assetId: string;
  createdAt: string;
  updatedAt: string;
}
export interface StatusOverride {
  machineCode: string;
  status: OpStatus;
  reason: string;
  setBy: string;
  setAt: string;
  validUntil: string | null;
}
export type MachineRow = Machine & { effectiveStatus: OpStatus | null; responsibleName: string | null };
export type MachineDetail = MachineRow & { statusOverride: StatusOverride | null };

export interface MachinesParams {
  q?: string;
  /** efektivni op-status (running/degraded/down/maintenance) — 1.0 chip (P0 filter). */
  status?: string;
  /** rok grupa: "overdue" | "danas" | "7d" (P0 filter). */
  deadline?: string;
  /** tačna lokacija (maint_machines.location) — 1.0 select (P0 filter). */
  location?: string;
  source?: string;
  archived?: boolean;
  mine?: boolean;
  page?: number;
  pageSize?: number;
}
export function useMachines(params: MachinesParams) {
  return useQuery({
    queryKey: ['odr', 'machines', params],
    queryFn: () => apiFetch<List<MachineRow>>(`${BASE}/machines${qs({ ...params })}`),
  });
}
export function useMachine(code: string | null) {
  return useQuery({
    queryKey: ['odr', 'machines', 'detail', code],
    enabled: !!code,
    queryFn: () => apiFetch<One<MachineDetail>>(`${BASE}/machines/${encodeURIComponent(code!)}`),
  });
}
export function useImportableMachines(enabled: boolean, includeNoProcedure = false) {
  return useQuery({
    queryKey: ['odr', 'machines', 'importable', includeNoProcedure],
    enabled,
    queryFn: () =>
      apiFetch<Rows<ViewRow>>(`${BASE}/machines/importable${qs({ includeNoProcedure: includeNoProcedure || undefined })}`),
  });
}
export interface DeletionLogRow {
  id: string;
  machineCode: string;
  machineName: string | null;
  reason: string;
  deletedAt: string;
  deletedByEmail: string | null;
  relatedCounts: Record<string, number>;
  /** Pun snapshot obrisanog reda mašine (jsonb) — paritet 1.0 log prikaza. */
  snapshot: Record<string, unknown> | null;
}
export function useDeletionLog(enabled: boolean) {
  return useQuery({
    queryKey: ['odr', 'machines', 'deletion-log'],
    enabled,
    queryFn: () => apiFetch<Rows<DeletionLogRow>>(`${BASE}/machines/deletion-log`),
  });
}

export interface MachineNote {
  id: string;
  machineCode: string;
  author: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export function useMachineNotes(code: string | null) {
  return useQuery({
    queryKey: ['odr', 'machines', code, 'notes'],
    enabled: !!code,
    queryFn: () => apiFetch<Rows<MachineNote>>(`${BASE}/machines/${encodeURIComponent(code!)}/notes`),
  });
}
export interface MachineFile {
  id: string;
  machineCode: string;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  category: string | null;
  description: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
}
export function useMachineFiles(code: string | null) {
  return useQuery({
    queryKey: ['odr', 'machines', code, 'files'],
    enabled: !!code,
    queryFn: () => apiFetch<Rows<MachineFile>>(`${BASE}/machines/${encodeURIComponent(code!)}/files`),
  });
}

export interface MaintTask {
  id: string;
  machineCode: string;
  title: string;
  description: string | null;
  instructions: string | null;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  severity: 'normal' | 'important' | 'critical';
  requiredRole: MaintRole;
  gracePeriodDays: number;
  active: boolean;
}
export interface MaintCheck {
  id: string;
  taskId: string;
  machineCode: string;
  performedBy: string;
  performedAt: string;
  result: CheckResult;
  notes: string | null;
}
export function useMachineTasks(code: string | null) {
  return useQuery({
    queryKey: ['odr', 'machines', code, 'tasks'],
    enabled: !!code,
    queryFn: () => apiFetch<Rows<MaintTask>>(`${BASE}/machines/${encodeURIComponent(code!)}/tasks`),
  });
}
export function useMachineChecks(code: string | null) {
  return useQuery({
    queryKey: ['odr', 'machines', code, 'checks'],
    enabled: !!code,
    queryFn: () => apiFetch<Rows<MaintCheck>>(`${BASE}/machines/${encodeURIComponent(code!)}/checks`),
  });
}

// ══════════════════════════════════════════════════ preventiva

export function useTasks(machine?: string) {
  return useQuery({
    queryKey: ['odr', 'tasks', machine ?? null],
    queryFn: () => apiFetch<Rows<MaintTask>>(`${BASE}/tasks${qs({ machine })}`),
  });
}
export function useTasksDue() {
  return useQuery({
    queryKey: ['odr', 'tasks', 'due'],
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/tasks/due`),
  });
}
export function useChecks(machine?: string) {
  return useQuery({
    queryKey: ['odr', 'checks', machine ?? null],
    queryFn: () => apiFetch<Rows<MaintCheck>>(`${BASE}/checks${qs({ machine })}`),
  });
}

// ══════════════════════════════════════════════════ incidenti (kvarovi)

export interface WorkOrderSummary {
  woId: string;
  woNumber: string | null;
  status: WoStatus;
  title: string;
  priority: WoPriority;
}
export interface Incident {
  id: string;
  machineCode: string;
  reportedBy: string;
  reportedAt: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignedTo: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionNotes: string | null;
  downtimeMinutes: number | null;
  attachmentUrls: string[];
  workOrderId: string | null;
  assetId: string | null;
  assetType: AssetType | null;
  safetyMarker: boolean;
}
export type IncidentRow = Incident & { workOrder: WorkOrderSummary | null };
export interface IncidentEvent {
  id: string;
  incidentId: string;
  actor: string | null;
  at: string;
  eventType: string;
  fromValue: string | null;
  toValue: string | null;
  comment: string | null;
}
export type IncidentDetail = Incident & { events: IncidentEvent[]; workOrder: WorkOrder | null };

export interface IncidentsParams {
  status?: string;
  severity?: string;
  machineCode?: string;
  page?: number;
  pageSize?: number;
}
export function useIncidents(params: IncidentsParams) {
  return useQuery({
    queryKey: ['odr', 'incidents', params],
    queryFn: () => apiFetch<List<IncidentRow>>(`${BASE}/incidents${qs({ ...params })}`),
  });
}
export function useIncident(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'incidents', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<IncidentDetail>>(`${BASE}/incidents/${id}`),
  });
}

// ══════════════════════════════════════════════════ radni nalozi (WO)

export interface WorkOrder {
  woId: string;
  woNumber: string | null;
  type: WoType;
  assetId: string;
  assetType: AssetType;
  sourceIncidentId: string | null;
  /** Preventivni šablon iz kog je nalog nastao — anti-duplikat provera (paritet 1.0). */
  sourcePreventiveTaskId: string | null;
  title: string;
  description: string | null;
  priority: WoPriority;
  safetyMarker: boolean;
  status: WoStatus;
  reportedBy: string;
  assignedTo: string | null;
  dueAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  downtimeFrom: string | null;
  downtimeTo: string | null;
  laborMinutes: number | null;
  costTotal: string | number | null;
  estimatedCost: string | number | null;
  closureComment: string | null;
  vehicleServiceCategory: string | null;
  odometerKmAtService: number | null;
  externalServicerName: string | null;
}
/** Sredstvo naloga (H4) — BE batch-resolve iz maint_assets (WO lista i detalj). */
export interface WoAsset {
  assetId: string;
  assetCode: string;
  name: string;
  assetType: AssetType | string;
}
export type WorkOrderRow = WorkOrder & { group: WoGroup | null; asset: WoAsset | null };
export interface WoEvent {
  id: string;
  woId: string;
  actor: string | null;
  at: string;
  eventType: string;
  fromValue: string | null;
  toValue: string | null;
  comment: string | null;
}
export interface WoPart {
  id: string;
  woId: string;
  partName: string;
  partId: string | null;
  quantity: string | number | null;
  unit: string | null;
  unitCost: string | number | null;
  supplier: string | null;
  createdAt: string;
}
export interface WoLabor {
  id: string;
  woId: string;
  technicianId: string | null;
  minutes: number | null;
  notes: string | null;
  createdAt: string;
}
export type WorkOrderDetail = WorkOrderRow & {
  /** source_incident_id — link „Otvori incident" u detalju (BE findWorkOrder). */
  incidentId: string | null;
  events: WoEvent[];
  parts: WoPart[];
  labor: WoLabor[];
};
export interface AssignableUser {
  user_id: string;
  full_name: string;
  maint_role: string;
  [k: string]: unknown;
}

export interface WorkOrdersParams {
  /** Pretraga (broj/naslov/opis/šifra+naziv sredstva) — BE `q` (paritet 1.0). */
  q?: string;
  status?: string;
  group?: string;
  priority?: string;
  type?: string;
  assetId?: string;
  mine?: boolean;
  /** „Samo otvoreni" — BE default ON; prosledi `false` da prikažeš i zavrsen/otkazan. */
  openOnly?: boolean;
  /** „Kasni rok (WO)" — samo otvoreni sa due_at < now. */
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}
export function useWorkOrders(params: WorkOrdersParams) {
  return useQuery({
    queryKey: ['odr', 'work-orders', params],
    queryFn: () => apiFetch<List<WorkOrderRow>>(`${BASE}/work-orders${qs({ ...params })}`),
  });
}
export function useWorkOrder(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'work-orders', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<WorkOrderDetail>>(`${BASE}/work-orders/${id}`),
  });
}
export function useAssignableUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['odr', 'work-orders', 'assignable'],
    enabled,
    queryFn: () => apiFetch<Rows<AssignableUser>>(`${BASE}/work-orders/assignable`),
  });
}

/**
 * Anti-duplikat pre-provera (paritet 1.0 `fetchOpenWoForPreventiveTask`, maintenance.js:541):
 * postoji li OTVOREN radni nalog za dati preventivni zadatak. BE due-red
 * (`v_maint_task_due_dates`) NE nosi `has_open_wo`, a nema ni ciljanog filtera po
 * `source_preventive_task_id`, pa — kao 1.0 — povučemo otvorene naloge (openOnly default ON)
 * i nađemo prvi čiji je `sourcePreventiveTaskId` == taskId. Poziva se na klik (van hook-a).
 */
export async function fetchOpenWoForTask(taskId: string): Promise<WorkOrderRow | null> {
  const res = await apiFetch<List<WorkOrderRow>>(`${BASE}/work-orders${qs({ pageSize: 200 })}`);
  return res.data.find((w) => w.sourcePreventiveTaskId === taskId) ?? null;
}

// ══════════════════════════════════════════════════ vozila / vozači

export interface VehicleOverviewRow {
  asset_id: string;
  asset_code: string;
  name: string;
  status: string;
  archived_at: string | null;
  [k: string]: unknown;
}
export interface MaintAsset {
  assetId: string;
  assetCode: string;
  assetType: AssetType;
  name: string;
  status: OpStatus;
  locationId: string | null;
  responsibleUserId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  supplier: string | null;
  notes: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  qrToken: string;
}
export interface VehicleDetails {
  assetId: string;
  registrationPlate: string | null;
  vin: string | null;
  odometerKm: number | null;
  fuelType: string | null;
  registrationExpiresAt: string | null;
  insuranceExpiresAt: string | null;
  serviceDueAt: string | null;
  firstAidKitExpiresAt: string | null;
  vehicleKind: string | null;
  usageType: string | null;
  gpsProvider: string | null;
  ownerId: string | null;
  primaryDriverId: string | null;
  partsShelf: string | null;
  hasPartsSet: boolean;
  partsNotes: string | null;
  primaryPhotoStoragePath: string | null;
  tollTagSerial: string | null;
  tollTagProvider: string | null;
  tollTagNotes: string | null;
  [k: string]: unknown;
}
export interface VehicleOwner {
  ownerId: string;
  name: string;
  ownerType: OwnerType;
  contact: string | null;
  notes: string | null;
  active: boolean;
}
export type VehicleDetail = MaintAsset & { details: VehicleDetails | null; owner: VehicleOwner | null };
export interface Tire {
  tireSetId: string;
  assetId: string;
  season: TireSeason;
  dimension: string;
  count: number;
  status: TireStatus;
  shelfCode: string | null;
  installedOnVehicle: boolean;
  purchasedAt: string | null;
  notes: string | null;
}
export interface VehicleServicePlan {
  planId: string;
  assetId: string;
  name: string;
  vehicleServiceCategory: string | null;
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneAt: string | null;
  lastDoneKm: number | null;
  priority: WoPriority;
  notes: string | null;
  active: boolean;
}
export interface Booking {
  bookingId: string;
  assetId: string;
  driverId: string | null;
  startAt: string;
  endAt: string;
  purpose: string | null;
  status: BookingStatus;
  notes: string | null;
}

export function useVehicles() {
  return useQuery({
    queryKey: ['odr', 'vehicles'],
    queryFn: () => apiFetch<Rows<VehicleOverviewRow>>(`${BASE}/vehicles`),
  });
}
export function useVehiclesDue() {
  return useQuery({
    queryKey: ['odr', 'vehicles', 'due'],
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/vehicles/service-plan-due`),
  });
}
export function useVehicle(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'vehicles', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<VehicleDetail>>(`${BASE}/vehicles/${id}`),
  });
}
export function useVehicleTires(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'vehicles', id, 'tires'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<Tire>>(`${BASE}/vehicles/${id}/tires`),
  });
}
/**
 * Servisni plan vozila — READ vraća `v_maint_vehicle_service_plan_due` (SNAKE_CASE view sa
 * računatim due kolonama: plan_id/name/interval_km/interval_months/last_done_at/next_due_at/
 * due_status/days_to_due/km_to_due/has_open_wo/open_wo_id/active). Mutacije koriste camelCase DTO.
 */
export function useVehicleServicePlan(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'vehicles', id, 'service-plan'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/vehicles/${id}/service-plan`),
  });
}
export function useVehicleParts(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'vehicles', id, 'parts'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/vehicles/${id}/parts`),
  });
}
export function useVehicleBookings(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'vehicles', id, 'bookings'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/vehicles/${id}/bookings`),
  });
}
export function useVehicleOwners() {
  return useQuery({
    queryKey: ['odr', 'vehicle-owners'],
    queryFn: () => apiFetch<Rows<VehicleOwner>>(`${BASE}/vehicle-owners`),
  });
}

export interface DriverRow {
  driver_id: string;
  full_name: string;
  [k: string]: unknown;
}
export interface Driver {
  driverId: string;
  fullName: string;
  isInternal: boolean;
  authUserId: string | null;
  driversLicenseNumber: string | null;
  driversLicenseCategories: string[];
  driversLicenseValidUntil: string | null;
  idCardNumber: string | null;
  idCardValidUntil: string | null;
  medicalCheckValidUntil: string | null;
  phone: string | null;
  jmbg: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  archivedAt: string | null;
  archiveReason: string | null;
}
export interface DriverDoc extends MachineFile { validUntil: string | null }
export type DriverDetail = Driver & { documents: DriverDoc[] };
export function useDrivers() {
  return useQuery({
    queryKey: ['odr', 'drivers'],
    queryFn: () => apiFetch<Rows<DriverRow>>(`${BASE}/drivers`),
  });
}
export function useDriver(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'drivers', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<DriverDetail>>(`${BASE}/drivers/${id}`),
  });
}

/** Zaposleni za auto-detect vozač↔zaposleni (GET /lookups/employees, write krug). */
export interface EmployeeLookup {
  id: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}
export function useEmployeeLookup(enabled: boolean) {
  return useQuery({
    queryKey: ['odr', 'lookups', 'employees'],
    enabled,
    staleTime: 300_000,
    queryFn: () => apiFetch<Rows<EmployeeLookup>>(`${BASE}/lookups/employees`),
  });
}

// ══════════════════════════════════════════════════ IT oprema / objekti / sredstva

export interface AssetServicePlan {
  planId: string;
  assetId: string;
  name: string;
  intervalMonths: number;
  lastDoneAt: string | null;
  priority: WoPriority;
  notes: string | null;
  active: boolean;
}
export type AssetCardDetail = MaintAsset & { details: ViewRow | null; servicePlan: AssetServicePlan[] };

export function useItAssets() {
  return useQuery({
    queryKey: ['odr', 'it-assets'],
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/it-assets`),
  });
}
export function useItAsset(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'it-assets', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<AssetCardDetail>>(`${BASE}/it-assets/${id}`),
  });
}
export function useFacilities() {
  return useQuery({
    queryKey: ['odr', 'facilities'],
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/facilities`),
  });
}
export function useFacility(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'facilities', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<AssetCardDetail>>(`${BASE}/facilities/${id}`),
  });
}
export function useFacilityTypes() {
  return useQuery({
    queryKey: ['odr', 'facility-types'],
    staleTime: 300_000,
    queryFn: () => apiFetch<Rows<ViewRow>>(`${BASE}/facility-types`),
  });
}
export interface AssetPickerRow {
  assetId: string;
  assetCode: string;
  assetType: AssetType;
  name: string;
  status: OpStatus;
  archivedAt: string | null;
}
export function useAssets(type?: AssetType, activeOnly = true) {
  return useQuery({
    queryKey: ['odr', 'assets', type ?? null, activeOnly],
    queryFn: () => apiFetch<Rows<AssetPickerRow>>(`${BASE}/assets${qs({ type, activeOnly })}`),
  });
}
export function useAssetServicePlan(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'assets', id, 'service-plan'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<AssetServicePlan>>(`${BASE}/assets/${id}/service-plan`),
  });
}

// ══════════════════════════════════════════════════ kalendar rokova

export interface CalendarData {
  vehicleServiceDue: ViewRow[];
  assetServiceDue: ViewRow[];
  itAssets: ViewRow[];
  facilities: ViewRow[];
}
export function useCalendar() {
  return useQuery({
    queryKey: ['odr', 'calendar'],
    queryFn: () => apiFetch<One<CalendarData>>(`${BASE}/calendar/deadlines`),
  });
}

// ══════════════════════════════════════════════════ zalihe / dobavljači / lokacije

export interface Part {
  partId: string;
  partCode: string;
  name: string;
  description: string | null;
  unit: string;
  supplierId: string | null;
  manufacturer: string | null;
  model: string | null;
  minStock: string | number;
  currentStock: string | number;
  unitCost: string | number | null;
  active: boolean;
}
export interface StockMovement {
  movementId: string;
  partId: string;
  woId: string | null;
  movementType: StockMovementType;
  quantity: string | number;
  unitCost: string | number | null;
  note: string | null;
  createdAt: string;
}
export interface Supplier {
  supplierId: string;
  name: string;
  contact: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
}
export interface MaintLocation {
  locationId: string;
  parentLocationId: string | null;
  locationType: string;
  code: string | null;
  name: string;
  active: boolean;
}
export interface PartsParams {
  q?: string;
  vehicleId?: string;
  lowStock?: boolean;
  /** „Prikaži neaktivne" — default samo aktivni; true uključuje deaktivirane (BE param). */
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}
export function useParts(params: PartsParams, enabled = true) {
  return useQuery({
    queryKey: ['odr', 'parts', params],
    enabled,
    queryFn: () => apiFetch<List<Part> | Rows<Part | ViewRow>>(`${BASE}/parts${qs({ ...params })}`),
  });
}
export function usePart(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'parts', 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<One<Part>>(`${BASE}/parts/${id}`),
  });
}
export function usePartMovements(id: string | null) {
  return useQuery({
    queryKey: ['odr', 'parts', id, 'movements'],
    enabled: !!id,
    queryFn: () => apiFetch<Rows<StockMovement>>(`${BASE}/parts/${id}/stock-movements`),
  });
}
/** Dobavljači. `active`: izostavljeno/'true' = samo aktivni; 'all' = svi; 'false' = neaktivni (BE param). */
export function useSuppliers(active?: 'all' | 'false') {
  return useQuery({
    queryKey: ['odr', 'suppliers', active ?? 'active'],
    queryFn: () => apiFetch<Rows<Supplier>>(`${BASE}/suppliers${qs({ active })}`),
  });
}
export function useLocations() {
  return useQuery({
    queryKey: ['odr', 'locations'],
    queryFn: () => apiFetch<Rows<MaintLocation>>(`${BASE}/locations`),
  });
}

// ══════════════════════════════════════════════════ dokumenta

export interface MaintDocument {
  documentId: string;
  entityType: DocEntity;
  entityId: string;
  assetId: string | null;
  woId: string | null;
  incidentId: string | null;
  driverId: string | null;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  category: string | null;
  description: string | null;
  uploadedAt: string;
  validUntil: string | null;
}
export interface DocumentsParams {
  entityType?: string;
  assetId?: string;
  woId?: string;
  incidentId?: string;
  driverId?: string;
  page?: number;
  pageSize?: number;
}
export function useDocuments(params: DocumentsParams) {
  return useQuery({
    queryKey: ['odr', 'documents', params],
    queryFn: () => apiFetch<List<MaintDocument>>(`${BASE}/documents${qs({ ...params })}`),
  });
}

// ══════════════════════════════════════════════════ podešavanja / notifikacije

export interface MaintSettings {
  id: number;
  autoCreateWoMajor: boolean;
  autoCreateWoCritical: boolean;
  safetyMarkerRequiresWo: boolean;
  defaultWoPriority: WoPriority;
  majorWoDueHours: number;
  criticalWoDueHours: number;
  preventiveDueWarningDays: number;
  notificationEnabled: boolean;
  notifyOnMajorIncident: boolean;
  notifyOnCriticalIncident: boolean;
  notifyOnOverduePreventive: boolean;
  notificationChannels: NotifChannel[];
  notes: string | null;
}
export function useSettings(enabled = true) {
  return useQuery({
    queryKey: ['odr', 'settings'],
    enabled,
    queryFn: () => apiFetch<One<MaintSettings | null>>(`${BASE}/settings`),
  });
}
export interface NotificationRule {
  ruleId: string;
  eventType: string;
  severity: string | null;
  assetType: AssetType | null;
  targetRole: MaintRole | null;
  channel: NotifChannel;
  delayMinutes: number;
  escalationLevel: number;
  enabled: boolean;
  notes: string | null;
}
export function useNotificationRules(enabled = true) {
  return useQuery({
    queryKey: ['odr', 'notification-rules'],
    enabled,
    queryFn: () => apiFetch<Rows<NotificationRule>>(`${BASE}/notification-rules`),
  });
}
export interface NotificationLog {
  id: string;
  channel: NotifChannel;
  recipient: string;
  subject: string | null;
  body: string;
  machineCode: string | null;
  status: NotifStatus;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  attempts: number;
}
export interface NotificationsParams {
  status?: string;
  machineCode?: string;
  page?: number;
  pageSize?: number;
}
export function useNotifications(params: NotificationsParams, enabled = true) {
  return useQuery({
    queryKey: ['odr', 'notifications', params],
    enabled,
    queryFn: () => apiFetch<List<NotificationLog>>(`${BASE}/notifications${qs({ ...params })}`),
  });
}

// ══════════════════════════════════════════════════ izveštaji

export interface ReportIncidents {
  total: number;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  downtimeMinutes: number;
  period: string;
}
export interface ReportWorkOrders {
  totalWorkOrders: number;
  partsCost: number;
  laborMinutes: number;
  costByAssetType: Record<string, number>;
  byType: Record<string, number>;
  period: string;
}
export function useReportIncidents(period: string) {
  return useQuery({
    queryKey: ['odr', 'reports', 'incidents', period],
    queryFn: () => apiFetch<One<ReportIncidents>>(`${BASE}/reports/incidents${qs({ period })}`),
  });
}
export function useReportWorkOrders(period: string) {
  return useQuery({
    queryKey: ['odr', 'reports', 'work-orders', period],
    queryFn: () => apiFetch<One<ReportWorkOrders>>(`${BASE}/reports/work-orders${qs({ period })}`),
  });
}
export function useReportAttention() {
  return useQuery({
    queryKey: ['odr', 'reports', 'attention'],
    queryFn: () => apiFetch<One<{ itAssets: ViewRow[]; facilities: ViewRow[] }>>(`${BASE}/reports/attention`),
  });
}

// ══════════════════════════════════════════════════ mutacije

/** Invalidira ceo `odr` podskup keša posle uspešne mutacije (jednostavno i sigurno). */
function useInvalidateOdr() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['odr'] });
}

interface CreateResult { data: unknown; meta: { idempotent: boolean } }

/** Generička POST „create" mutacija sa clientEventId (idempotencija). */
export function useOdrCreate<V extends object>(path: string | ((v: V) => string)) {
  const invalidate = useInvalidateOdr();
  return useMutation({
    mutationFn: (v: V) =>
      apiFetch<CreateResult>(typeof path === 'function' ? path(v) : path, {
        method: 'POST',
        body: JSON.stringify({ clientEventId: newClientEventId(), ...v }),
      }),
    onSuccess: invalidate,
  });
}

/** Generička mutacija bez idempotencije (PATCH/PUT/DELETE/POST-akcija). */
export function useOdrMutate<V extends object>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: (v: V) => string,
  body?: (v: V) => object | undefined,
) {
  const invalidate = useInvalidateOdr();
  return useMutation({
    mutationFn: (v: V) => {
      const b = body ? body(v) : undefined;
      return apiFetch<One<unknown>>(path(v), {
        method,
        ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
      });
    },
    onSuccess: invalidate,
  });
}

// ── Mašine
export const useCreateMachine = () => useOdrCreate<Record<string, unknown>>(`${BASE}/machines`);
export const useUpdateMachine = () =>
  useOdrMutate<{ code: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}`, (v) => v.patch);
export const useArchiveMachine = () =>
  useOdrMutate<{ code: string }>('POST', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/archive`);
export const useRestoreMachine = () =>
  useOdrMutate<{ code: string }>('POST', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/restore`);
export const useRenameMachine = () =>
  useOdrMutate<{ code: string; newCode: string }>('POST', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/rename`, (v) => ({ newCode: v.newCode }));
export const useDeleteMachineHard = () =>
  useOdrMutate<{ code: string; reason: string }>('DELETE', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}`, (v) => ({ reason: v.reason }));
export const useImportMachines = () => useOdrCreate<{ codes: string[] }>(`${BASE}/machines/import`);
export const useSetStatusOverride = () =>
  useOdrMutate<{ code: string; status: OpStatus; reason: string; validUntil?: string }>('PUT', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/status-override`, (v) => ({ status: v.status, reason: v.reason, validUntil: v.validUntil }));
export const useClearStatusOverride = () =>
  useOdrMutate<{ code: string }>('DELETE', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/status-override`);
export const useCreateNote = () =>
  useOdrCreate<{ code: string; content: string; pinned?: boolean }>((v) => `${BASE}/machines/${encodeURIComponent(v.code)}/notes`);
export const useUpdateNote = () =>
  useOdrMutate<{ code: string; noteId: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/notes/${v.noteId}`, (v) => v.patch);
export const useDeleteMachineFile = () =>
  useOdrMutate<{ code: string; id: string }>('DELETE', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/files/${v.id}`);
/** PATCH meta (kategorija/opis) fajla mašine — paritet 1.0 edit metapodataka (maintFilesTab.js). */
export const useUpdateMachineFile = () =>
  useOdrMutate<{ code: string; id: string; patch: { category?: string; description?: string } }>('PATCH', (v) => `${BASE}/machines/${encodeURIComponent(v.code)}/files/${v.id}`, (v) => v.patch);

/** Upload fajla mašine (multipart). */
export function useUploadMachineFile() {
  const invalidate = useInvalidateOdr();
  return useMutation({
    mutationFn: ({ code, file, category, description }: { code: string; file: File; category?: string; description?: string }) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      if (category) fd.append('category', category);
      if (description) fd.append('description', description);
      return apiUpload<One<MachineFile>>(`${BASE}/machines/${encodeURIComponent(code)}/files`, fd);
    },
    onSuccess: invalidate,
  });
}
/** Potpisan URL fajla mašine (on-demand). */
export function signMachineFileUrl(code: string, id: string): Promise<One<{ url: string; expiresIn: number }>> {
  return apiFetch(`${BASE}/machines/${encodeURIComponent(code)}/files/${id}/url`);
}

// ── Preventiva
export const useCreateTask = () => useOdrCreate<Record<string, unknown>>(`${BASE}/tasks`);
export const useUpdateTask = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/tasks/${v.id}`, (v) => v.patch);
export const useDeleteTask = () => useOdrMutate<{ id: string }>('DELETE', (v) => `${BASE}/tasks/${v.id}`);
export const useCreatePreventiveWo = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/tasks/${v.id}/work-order`);
export const useCreateCheck = () => useOdrCreate<Record<string, unknown>>(`${BASE}/checks`);

// ── Incidenti (prijava = report; tok = write)
export const useReportIncident = () => useOdrCreate<Record<string, unknown>>(`${BASE}/incidents`);
export const useUpdateIncident = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/incidents/${v.id}`, (v) => v.patch);
export const useCreateIncidentEvent = () =>
  useOdrMutate<{ id: string; eventType: string; comment?: string }>('POST', (v) => `${BASE}/incidents/${v.id}/events`, (v) => ({ eventType: v.eventType, comment: v.comment }));
/** Foto incidenta (multipart, do 10) — kroz RPC maint_attach_incident_files (prijavilac sme). */
export function useAttachIncidentFiles() {
  const invalidate = useInvalidateOdr();
  return useMutation({
    mutationFn: ({ id, files }: { id: string; files: File[] }) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      return apiUpload<One<{ attached: number; paths: string[] }>>(`${BASE}/incidents/${id}/files`, fd);
    },
    onSuccess: invalidate,
  });
}

// ── Radni nalozi
export const useCreateWorkOrder = () => useOdrCreate<Record<string, unknown>>(`${BASE}/work-orders`);
export const useUpdateWorkOrder = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/work-orders/${v.id}`, (v) => v.patch);
export const useDeleteWorkOrder = () => useOdrMutate<{ id: string }>('DELETE', (v) => `${BASE}/work-orders/${v.id}`);
export const useCreateWoEvent = () =>
  useOdrMutate<{ id: string; eventType: string; comment?: string }>('POST', (v) => `${BASE}/work-orders/${v.id}/events`, (v) => ({ eventType: v.eventType, comment: v.comment }));
export const useCreateWoPart = () =>
  useOdrCreate<{ id: string; partName: string; quantity?: number; unit?: string; unitCost?: number; partId?: string; supplier?: string }>((v) => `${BASE}/work-orders/${v.id}/parts`);
export const useCreateWoLabor = () =>
  useOdrCreate<{ id: string; minutes: number; notes?: string }>((v) => `${BASE}/work-orders/${v.id}/labor`);

// ── Vozila
export const useCreateVehicle = () => useOdrCreate<Record<string, unknown>>(`${BASE}/vehicles`);
export const usePatchVehicleCore = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}`, (v) => v.patch);
export const useUpsertVehicleDetails = () =>
  useOdrMutate<{ id: string; details: Record<string, unknown> }>('PUT', (v) => `${BASE}/vehicles/${v.id}/details`, (v) => ({ details: v.details }));
export const usePatchVehicleTollTag = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/toll-tag`, (v) => v.patch);
export const usePatchVehicleShelf = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/shelf`, (v) => v.patch);
export const useArchiveVehicle = () =>
  useOdrMutate<{ id: string; reason: string }>('POST', (v) => `${BASE}/vehicles/${v.id}/archive`, (v) => ({ reason: v.reason }));
export const useRestoreVehicle = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/vehicles/${v.id}/restore`);
export const useCreateTire = () =>
  useOdrCreate<{ id: string; season: TireSeason; dimension: string; count: number; status?: TireStatus; shelfCode?: string; installedOnVehicle?: boolean; purchasedAt?: string; notes?: string }>((v) => `${BASE}/vehicles/${v.id}/tires`);
export const useUpdateTire = () =>
  useOdrMutate<{ id: string; tireId: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/tires/${v.tireId}`, (v) => v.patch);
export const useDeleteTire = () =>
  useOdrMutate<{ id: string; tireId: string }>('DELETE', (v) => `${BASE}/vehicles/${v.id}/tires/${v.tireId}`);
export const useCreateVehicleServicePlan = () =>
  useOdrCreate<{ id: string; name: string; intervalKm?: number; intervalMonths?: number; lastDoneAt?: string; lastDoneKm?: number; vehicleServiceCategory?: string; priority?: WoPriority; notes?: string; active?: boolean }>((v) => `${BASE}/vehicles/${v.id}/service-plan`);
export const useUpdateVehicleServicePlan = () =>
  useOdrMutate<{ id: string; planId: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/service-plan/${v.planId}`, (v) => v.patch);
export const useDeleteVehicleServicePlan = () =>
  useOdrMutate<{ id: string; planId: string }>('DELETE', (v) => `${BASE}/vehicles/${v.id}/service-plan/${v.planId}`);
export const useGenerateVehicleServiceWos = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/vehicles/${v.id}/service-plan/generate-wos`);
export const useCreateBooking = () =>
  useOdrCreate<{ id: string; startAt: string; endAt: string; driverId?: string; purpose?: string; status?: BookingStatus; notes?: string }>((v) => `${BASE}/vehicles/${v.id}/bookings`);
export const useUpdateBooking = () =>
  useOdrMutate<{ id: string; bookingId: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/bookings/${v.bookingId}`, (v) => v.patch);
export const useDeleteBooking = () =>
  useOdrMutate<{ id: string; bookingId: string }>('DELETE', (v) => `${BASE}/vehicles/${v.id}/bookings/${v.bookingId}`);
export const useLinkPartToVehicle = () =>
  useOdrCreate<{ id: string; partId: string; qtyMin?: number; notes?: string }>((v) => `${BASE}/vehicles/${v.id}/parts`);
export const useUpdatePartVehicleLink = () =>
  useOdrMutate<{ id: string; partId: string; patch: { qtyMin?: number | null; notes?: string | null } }>('PATCH', (v) => `${BASE}/vehicles/${v.id}/parts/${v.partId}`, (v) => v.patch);
export const useUnlinkPartFromVehicle = () =>
  useOdrMutate<{ id: string; partId: string }>('DELETE', (v) => `${BASE}/vehicles/${v.id}/parts/${v.partId}`);
export const useCreateVehicleOwner = () => useOdrCreate<Record<string, unknown>>(`${BASE}/vehicle-owners`);

// ── Vozači
export const useCreateDriver = () => useOdrCreate<Record<string, unknown>>(`${BASE}/drivers`);
export const useUpdateDriver = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/drivers/${v.id}`, (v) => v.patch);
export const useArchiveDriver = () =>
  useOdrMutate<{ id: string; reason: string }>('POST', (v) => `${BASE}/drivers/${v.id}/archive`, (v) => ({ reason: v.reason }));
export const useRestoreDriver = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/drivers/${v.id}/restore`);
export const useDeleteDriver = () =>
  useOdrMutate<{ id: string }>('DELETE', (v) => `${BASE}/drivers/${v.id}`);

// ── IT / objekti / sredstva
export const useCreateItAsset = () => useOdrCreate<Record<string, unknown>>(`${BASE}/it-assets`);
export const usePatchItAssetCore = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/it-assets/${v.id}`, (v) => v.patch);
export const useUpsertItDetails = () =>
  useOdrMutate<{ id: string; details: Record<string, unknown> }>('PUT', (v) => `${BASE}/it-assets/${v.id}/details`, (v) => ({ details: v.details }));
export const useCreateFacility = () => useOdrCreate<Record<string, unknown>>(`${BASE}/facilities`);
export const usePatchFacilityCore = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/facilities/${v.id}`, (v) => v.patch);
export const useUpsertFacilityDetails = () =>
  useOdrMutate<{ id: string; details: Record<string, unknown> }>('PUT', (v) => `${BASE}/facilities/${v.id}/details`, (v) => ({ details: v.details }));
export const useArchiveAsset = () =>
  useOdrMutate<{ id: string; reason: string }>('POST', (v) => `${BASE}/assets/${v.id}/archive`, (v) => ({ reason: v.reason }));
export const useRestoreAsset = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/assets/${v.id}/restore`);
export const useCreateAssetServicePlan = () =>
  useOdrCreate<{ id: string; name: string; intervalMonths: number; priority?: WoPriority; notes?: string; lastDoneAt?: string; active?: boolean }>((v) => `${BASE}/assets/${v.id}/service-plan`);
export const useUpdateAssetServicePlan = () =>
  useOdrMutate<{ id: string; planId: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/assets/${v.id}/service-plan/${v.planId}`, (v) => v.patch);
export const useDeleteAssetServicePlan = () =>
  useOdrMutate<{ id: string; planId: string }>('DELETE', (v) => `${BASE}/assets/${v.id}/service-plan/${v.planId}`);
export const useGenerateAssetServiceWos = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/assets/${v.id}/service-plan/generate-wos`);

// ── Zalihe / dobavljači / lokacije
export const useCreatePart = () => useOdrCreate<Record<string, unknown>>(`${BASE}/parts`);
export const useUpdatePart = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/parts/${v.id}`, (v) => v.patch);
export const useCreateStockMovement = () =>
  useOdrCreate<{ id: string; movementType: StockMovementType; quantity: number; note?: string; unitCost?: number }>((v) => `${BASE}/parts/${v.id}/stock-movements`);
export const useCreateSupplier = () => useOdrCreate<Record<string, unknown>>(`${BASE}/suppliers`);
export const useUpdateSupplier = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/suppliers/${v.id}`, (v) => v.patch);
export const useCreateLocation = () => useOdrCreate<Record<string, unknown>>(`${BASE}/locations`);
export const useUpdateLocation = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/locations/${v.id}`, (v) => v.patch);

// ── Dokumenta
export function useUploadDocument() {
  const invalidate = useInvalidateOdr();
  return useMutation({
    mutationFn: ({ file, entityType, entityId, category, description, validUntil }: {
      file: File; entityType: DocEntity; entityId: string; category?: string; description?: string; validUntil?: string;
    }) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('entityType', entityType);
      fd.append('entityId', entityId);
      if (category) fd.append('category', category);
      if (description) fd.append('description', description);
      if (validUntil) fd.append('validUntil', validUntil);
      return apiUpload<One<MaintDocument>>(`${BASE}/documents`, fd);
    },
    onSuccess: invalidate,
  });
}
export const useUpdateDocument = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/documents/${v.id}`, (v) => v.patch);
export const useDeleteDocument = () => useOdrMutate<{ id: string }>('DELETE', (v) => `${BASE}/documents/${v.id}`);
export function signDocumentUrl(id: string): Promise<One<{ url: string; expiresIn: number }>> {
  return apiFetch(`${BASE}/documents/${id}/url`);
}

// ── Podešavanja / notif pravila
export const useUpdateSettings = () =>
  useOdrMutate<{ patch: Record<string, unknown> }>('PATCH', () => `${BASE}/settings`, (v) => v.patch);
export const useCreateNotificationRule = () => useOdrCreate<Record<string, unknown>>(`${BASE}/notification-rules`);
export const useUpdateNotificationRule = () =>
  useOdrMutate<{ id: string; patch: Record<string, unknown> }>('PATCH', (v) => `${BASE}/notification-rules/${v.id}`, (v) => v.patch);
export const useRetryNotification = () =>
  useOdrMutate<{ id: string }>('POST', (v) => `${BASE}/notifications/${v.id}/retry`);
export const useVehicleDeadlineCheck = () =>
  useOdrMutate<{ lookaheadDays?: number }>('POST', () => `${BASE}/vehicles/deadline-check`, (v) => ({ lookaheadDays: v.lookaheadDays }));
