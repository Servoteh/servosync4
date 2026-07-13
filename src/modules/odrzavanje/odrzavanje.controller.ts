import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { OdrzavanjeService } from "./odrzavanje.service";
import type {
  DocumentsQuery,
  IncidentsQuery,
  MachinesQuery,
  NotificationsQuery,
  PartsQuery,
  WorkOrdersQuery,
} from "./odrzavanje.service";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Održavanje (CMMS) — 3.0 TALAS F, R1 read endpoints (MODULE_SPEC_odrzavanje_30.md §3).
 * Klasa: `odrzavanje.read` (F8 — hub kartica + prijava kvara = opšte pravo; VIDLJIVOST).
 * Row-nivo (operator machine-scope, chief-bez-globalne-role, magacioner krug, WO
 * dodeljeni/prijavilac…) presuđuje 102 sy15 RLS politike kroz `withUserRls` (GUC sub+email
 * + SET LOCAL ROLE authenticated) — paritet po konstrukciji. FE fino-gejtuje po `/maintenance/me`.
 * Mutacije (nalozi/incidenti/foto/storage/dispatch) + 16 front RPC = R2 — ovde ih NEMA.
 *
 * ⚠️ Route ordering: sve LITERAL rute pre `:id`/`:code` (inače bi param uhvatio literal).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ODRZAVANJE_READ)
@Controller({ path: "maintenance", version: "1" })
export class OdrzavanjeController {
  constructor(private readonly odr: OdrzavanjeService) {}

  // ---------- profil pozivaoca + pregled ----------

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.odr.me(req.user.email);
  }

  @Get("dashboard")
  dashboard(@Req() req: AuthedRequest) {
    return this.odr.dashboard(req.user.email);
  }

  @Get("facility-types")
  facilityTypes() {
    return this.odr.facilityTypes();
  }

  // ---------- Mašine (machine_code = TEXT PK; literali pre :code) ----------

  @Get("machines")
  machines(@Req() req: AuthedRequest, @Query() query: MachinesQuery) {
    return this.odr.listMachines(req.user.email, query);
  }

  @Get("machines/importable")
  importable(@Req() req: AuthedRequest) {
    return this.odr.importableMachines(req.user.email);
  }

  @Get("machines/deletion-log")
  deletionLog(@Req() req: AuthedRequest) {
    return this.odr.deletionLog(req.user.email);
  }

  @Get("machines/:code")
  machine(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.findMachine(req.user.email, code);
  }

  @Get("machines/:code/status-override")
  machineOverride(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.machineStatusOverride(req.user.email, code);
  }

  @Get("machines/:code/notes")
  machineNotes(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.machineNotes(req.user.email, code);
  }

  @Get("machines/:code/files")
  machineFiles(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.machineFiles(req.user.email, code);
  }

  @Get("machines/:code/tasks")
  machineTasks(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.listTasks(req.user.email, code);
  }

  @Get("machines/:code/checks")
  machineChecks(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.listChecks(req.user.email, code);
  }

  // ---------- Preventiva (šabloni / due / kontrole) ----------

  @Get("tasks")
  tasks(@Req() req: AuthedRequest, @Query("machine") machine?: string) {
    return this.odr.listTasks(req.user.email, machine);
  }

  @Get("tasks/due")
  tasksDue(@Req() req: AuthedRequest) {
    return this.odr.tasksDue(req.user.email);
  }

  @Get("tasks/:id")
  task(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findTask(req.user.email, id);
  }

  @Get("checks")
  checks(@Req() req: AuthedRequest, @Query("machine") machine?: string) {
    return this.odr.listChecks(req.user.email, machine);
  }

  // ---------- Incidenti (kvarovi) — GET (prijava/tok su R2) ----------

  @Get("incidents")
  incidents(@Req() req: AuthedRequest, @Query() query: IncidentsQuery) {
    return this.odr.listIncidents(req.user.email, query);
  }

  @Get("incidents/:id")
  incident(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findIncident(req.user.email, id);
  }

  @Get("incidents/:id/events")
  incidentEvents(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.incidentEvents(req.user.email, id);
  }

  // ---------- Radni nalozi (assignable pre :id) ----------

  @Get("work-orders")
  workOrders(@Req() req: AuthedRequest, @Query() query: WorkOrdersQuery) {
    return this.odr.listWorkOrders(req.user.email, query);
  }

  @Get("work-orders/assignable")
  assignable(@Req() req: AuthedRequest) {
    return this.odr.assignableUsers(req.user.email);
  }

  @Get("work-orders/:id")
  workOrder(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findWorkOrder(req.user.email, id);
  }

  @Get("work-orders/:id/events")
  woEvents(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.woEvents(req.user.email, id);
  }

  @Get("work-orders/:id/parts")
  woParts(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.woParts(req.user.email, id);
  }

  @Get("work-orders/:id/labor")
  woLabor(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.woLabor(req.user.email, id);
  }

  // ---------- Vozila / Vozači (service-plan-due pre :id) ----------

  @Get("vehicles")
  vehicles(@Req() req: AuthedRequest) {
    return this.odr.listVehicles(req.user.email);
  }

  @Get("vehicles/service-plan-due")
  vehiclesDue(@Req() req: AuthedRequest) {
    return this.odr.vehicleServicePlanDue(req.user.email);
  }

  @Get("vehicles/:id")
  vehicle(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findVehicle(req.user.email, id);
  }

  @Get("vehicles/:id/tires")
  vehicleTires(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.vehicleTires(req.user.email, id);
  }

  @Get("vehicles/:id/service-plan")
  vehicleServicePlan(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.vehicleServicePlan(req.user.email, id);
  }

  @Get("vehicles/:id/parts")
  vehicleParts(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.vehicleParts(req.user.email, id);
  }

  @Get("vehicles/:id/bookings")
  vehicleBookings(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.vehicleBookings(req.user.email, id);
  }

  @Get("vehicle-owners")
  vehicleOwners(@Req() req: AuthedRequest) {
    return this.odr.vehicleOwners(req.user.email);
  }

  @Get("drivers")
  drivers(@Req() req: AuthedRequest) {
    return this.odr.listDrivers(req.user.email);
  }

  @Get("drivers/:id")
  driver(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findDriver(req.user.email, id);
  }

  // ---------- IT oprema / Objekti / Sredstva (literali pre :id) ----------

  @Get("it-assets")
  itAssets(@Req() req: AuthedRequest) {
    return this.odr.listItAssets(req.user.email);
  }

  @Get("it-assets/:id")
  itAsset(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findItAsset(req.user.email, id);
  }

  @Get("facilities")
  facilities(@Req() req: AuthedRequest) {
    return this.odr.listFacilities(req.user.email);
  }

  @Get("facilities/:id")
  facility(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findFacility(req.user.email, id);
  }

  @Get("assets")
  assets(
    @Req() req: AuthedRequest,
    @Query("type") type?: string,
    @Query("activeOnly") activeOnly?: string,
  ) {
    return this.odr.listAssets(req.user.email, type, activeOnly === "true");
  }

  @Get("assets/service-plan-due")
  assetsDue(@Req() req: AuthedRequest) {
    return this.odr.assetServicePlanDue(req.user.email);
  }

  @Get("assets/:id/service-plan")
  assetServicePlan(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.assetServicePlan(req.user.email, id);
  }

  // ---------- Kalendar ----------

  @Get("calendar/deadlines")
  calendar(@Req() req: AuthedRequest) {
    return this.odr.calendarDeadlines(req.user.email);
  }

  // ---------- Zalihe / dobavljači / lokacije ----------

  @Get("parts")
  parts(@Req() req: AuthedRequest, @Query() query: PartsQuery) {
    return this.odr.listParts(req.user.email, query);
  }

  @Get("parts/:id")
  part(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findPart(req.user.email, id);
  }

  @Get("parts/:id/stock-movements")
  partMovements(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.partStockMovements(req.user.email, id);
  }

  @Get("suppliers")
  suppliers(@Req() req: AuthedRequest) {
    return this.odr.listSuppliers(req.user.email);
  }

  @Get("locations")
  locations(@Req() req: AuthedRequest) {
    return this.odr.listLocations(req.user.email);
  }

  // ---------- Dokumenta (meta read) / Podešavanja / Notifikacije ----------

  @Get("documents")
  documents(@Req() req: AuthedRequest, @Query() query: DocumentsQuery) {
    return this.odr.listDocuments(req.user.email, query);
  }

  @Get("documents/:id")
  document(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findDocument(req.user.email, id);
  }

  @Get("settings")
  settings(@Req() req: AuthedRequest) {
    return this.odr.settings(req.user.email);
  }

  @Get("notification-rules")
  notificationRules(@Req() req: AuthedRequest) {
    return this.odr.notificationRules(req.user.email);
  }

  @Get("notifications")
  notifications(@Req() req: AuthedRequest, @Query() query: NotificationsQuery) {
    return this.odr.notifications(req.user.email, query);
  }

  // ---------- Izveštaji ----------

  @Get("reports/incidents")
  reportIncidents(@Req() req: AuthedRequest, @Query("period") period?: string) {
    return this.odr.reportIncidents(req.user.email, period);
  }

  @Get("reports/work-orders")
  reportWorkOrders(
    @Req() req: AuthedRequest,
    @Query("period") period?: string,
  ) {
    return this.odr.reportWorkOrderCosts(req.user.email, period);
  }

  @Get("reports/attention")
  reportAttention(@Req() req: AuthedRequest) {
    return this.odr.reportAttention(req.user.email);
  }
}
