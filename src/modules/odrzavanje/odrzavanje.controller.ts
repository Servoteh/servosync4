import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
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
import {
  ArchiveAssetDto,
  CreateAssetServicePlanDto,
  CreateBookingDto,
  CreateCheckDto,
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
  CreateTireDto,
  CreateVehicleServicePlanDto,
  CreateWorkOrderDto,
  DeadlineCheckDto,
  DeleteHardDto,
  ImportMachinesDto,
  DetailsUpsertDto,
  FileMetaDto,
  IncidentEventDto,
  LinkPartDto,
  PatchAssetCoreDto,
  RenameMachineDto,
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

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/** Hard DoS cap za upload (multer aborta pre baferovanja) — paritet sastanci. */
const UPLOAD_LIMITS = { limits: { fileSize: 25 * 1024 * 1024 } };

/**
 * Održavanje (CMMS) — 3.0 TALAS F (MODULE_SPEC_odrzavanje_30.md §3).
 * Klasa: `odrzavanje.read` (F8 — hub kartica + prijava kvara = opšte pravo; VIDLJIVOST).
 * Row-nivo (operator machine-scope, chief-bez-globalne-role, magacioner krug, WO
 * dodeljeni/prijavilac, 24h pravilo…) presuđuje 102 sy15 RLS politike kroz
 * `withUserRls`/`runIdempotentRls` (GUC sub+email + SET LOCAL ROLE authenticated) —
 * paritet po konstrukciji. FE fino-gejtuje po `/maintenance/me`.
 *
 * Metod-nivo `@RequirePermission` eskalira READ → WRITE (mutacije, coarse gate; stvarnu
 * odluku donosi RLS/RPC guard) ili → REPORT (prijava kvara + foto incidenta = opšte
 * pravo, F6/F3). Dispatch OSTAJE MRTAV (F1) — samo log/retry/rules.
 *
 * ⚠️ Route ordering: sve LITERAL rute pre `:id`/`:code` (inače bi param uhvatio literal).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ODRZAVANJE_READ)
@Controller({ path: "maintenance", version: "1" })
export class OdrzavanjeController {
  constructor(private readonly odr: OdrzavanjeService) {}

  // ======================================================================
  // READ (R1) — profil pozivaoca + pregled
  // ======================================================================

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.odr.me(req.user.email);
  }

  @Get("dashboard")
  dashboard(@Req() req: AuthedRequest) {
    return this.odr.dashboard(req.user.email);
  }

  // Board (#33): kolone Prekoračeno/Danas/Narednih 7 dana + override „PAUZA" izdvajanje.
  @Get("board")
  board(@Req() req: AuthedRequest) {
    return this.odr.board(req.user.email);
  }

  @Get("facility-types")
  facilityTypes() {
    return this.odr.facilityTypes();
  }

  // ---------- Mašine READ (machine_code = TEXT PK; literali pre :code) ----------

  @Get("machines")
  machines(@Req() req: AuthedRequest, @Query() query: MachinesQuery) {
    return this.odr.listMachines(req.user.email, query);
  }

  @Get("machines/importable")
  importable(
    @Req() req: AuthedRequest,
    @Query("includeNoProcedure") includeNoProcedure?: string,
  ) {
    return this.odr.importableMachines(
      req.user.email,
      includeNoProcedure === "true",
    );
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

  @Get("machines/:code/files/:id/url")
  machineFileUrl(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.signMachineFile(req.user.email, id);
  }

  @Get("machines/:code/tasks")
  machineTasks(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.listTasks(req.user.email, code);
  }

  @Get("machines/:code/checks")
  machineChecks(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.listChecks(req.user.email, code);
  }

  // ---------- Preventiva READ ----------

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

  // ---------- Incidenti READ ----------

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

  // ---------- Radni nalozi READ (assignable pre :id) ----------

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

  // ---------- Vozila / Vozači READ (service-plan-due pre :id) ----------

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

  // Signed URL glavne fotografije (READ; 404 čisto kad nema foto).
  @Get("vehicles/:id/photo/url")
  vehiclePhotoUrl(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.vehiclePhotoUrl(req.user.email, id);
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

  // ---------- IT oprema / Objekti / Sredstva READ (literali pre :id) ----------

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

  // ---------- Zalihe / dobavljači / lokacije READ ----------

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
  suppliers(@Req() req: AuthedRequest, @Query("active") active?: string) {
    return this.odr.listSuppliers(req.user.email, active);
  }

  @Get("locations")
  locations(@Req() req: AuthedRequest) {
    return this.odr.listLocations(req.user.email);
  }

  // ---------- Dokumenta (meta read) / Podešavanja / Notifikacije READ ----------

  @Get("documents")
  documents(@Req() req: AuthedRequest, @Query() query: DocumentsQuery) {
    return this.odr.listDocuments(req.user.email, query);
  }

  @Get("documents/:id")
  document(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.odr.findDocument(req.user.email, id);
  }

  @Get("documents/:id/url")
  documentUrl(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.signDocument(req.user.email, id);
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

  // ---------- Maint profili (SoD) / lookups (auto-detect) ----------

  // Lista profila = admin konzola; service guard = ERP admin (RLS ionako daje svoj-red).
  @Get("profiles")
  profiles(@Req() req: AuthedRequest) {
    return this.odr.listProfiles(req.user.email);
  }

  // Auto-detect zaposlenog (driver modal). Guard = write krug (kao driver mutacije).
  @Get("lookups/employees")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  lookupEmployees(@Req() req: AuthedRequest, @Query("q") q?: string) {
    return this.odr.lookupEmployees(req.user.email, q);
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

  // ======================================================================
  // R2 — MUTACIJE (metod-nivo WRITE/REPORT; row-odluku donosi sy15 RLS/RPC)
  // Route ordering: literali pre :code/:id; sve pod-rute distinktne po dubini/verbu.
  // ======================================================================

  // ---------- Mašine: katalog CRUD / arhiva / rename / import / hard-delete ----------

  @Post("machines")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createMachine(@Req() req: AuthedRequest, @Body() dto: CreateMachineDto) {
    return this.odr.createMachine(req.user.email, dto);
  }

  @Post("machines/import")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  importMachines(@Req() req: AuthedRequest, @Body() dto: ImportMachinesDto) {
    return this.odr.importMachines(req.user.email, dto.codes);
  }

  @Patch("machines/:code")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateMachine(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: UpdateMachineDto,
  ) {
    return this.odr.updateMachine(req.user.email, code, dto);
  }

  @Delete("machines/:code")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteMachine(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: DeleteHardDto,
  ) {
    return this.odr.deleteMachineHard(req.user.email, code, dto.reason);
  }

  @Post("machines/:code/archive")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  archiveMachine(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.archiveMachine(req.user.email, code);
  }

  @Post("machines/:code/restore")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  restoreMachine(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.restoreMachine(req.user.email, code);
  }

  @Post("machines/:code/rename")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  renameMachine(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: RenameMachineDto,
  ) {
    return this.odr.renameMachine(req.user.email, code, dto.newCode);
  }

  @Put("machines/:code/status-override")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  setStatusOverride(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: StatusOverrideDto,
  ) {
    return this.odr.setStatusOverride(req.user.email, code, dto);
  }

  @Delete("machines/:code/status-override")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  clearStatusOverride(@Req() req: AuthedRequest, @Param("code") code: string) {
    return this.odr.clearStatusOverride(req.user.email, code);
  }

  // ---------- Napomene mašine (24h pravilo je u RLS) ----------

  @Post("machines/:code/notes")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createNote(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: CreateNoteDto,
  ) {
    return this.odr.createNote(req.user.email, code, dto);
  }

  @Patch("machines/:code/notes/:noteId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateNote(
    @Req() req: AuthedRequest,
    @Param("noteId", ParseUUIDPipe) noteId: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.odr.updateNote(req.user.email, noteId, dto);
  }

  // ---------- Fajlovi mašine (storage proxy F4) ----------

  @Post("machines/:code/files")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  uploadMachineFile(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: FileMetaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.odr.uploadMachineFile(req.user.email, code, dto, file);
  }

  @Patch("machines/:code/files/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateMachineFile(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: FileMetaDto,
  ) {
    return this.odr.updateMachineFile(req.user.email, id, dto);
  }

  @Delete("machines/:code/files/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteMachineFile(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteMachineFile(req.user.email, id);
  }

  // ---------- Preventiva: šabloni + kontrole + WO iz šablona ----------

  @Post("tasks")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createTask(@Req() req: AuthedRequest, @Body() dto: CreateTaskDto) {
    return this.odr.createTask(req.user.email, dto);
  }

  @Patch("tasks/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateTask(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.odr.updateTask(req.user.email, id, dto);
  }

  @Delete("tasks/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteTask(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteTask(req.user.email, id);
  }

  @Post("tasks/:id/work-order")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createPreventiveWo(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.createPreventiveWorkOrder(req.user.email, id);
  }

  @Post("checks")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createCheck(@Req() req: AuthedRequest, @Body() dto: CreateCheckDto) {
    return this.odr.createCheck(req.user.email, dto);
  }

  // ---------- Incidenti (prijava = REPORT opšte pravo; tok = WRITE) ----------

  @Post("incidents")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_REPORT)
  reportIncident(@Req() req: AuthedRequest, @Body() dto: ReportIncidentDto) {
    return this.odr.reportIncident(req.user.email, dto);
  }

  @Patch("incidents/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateIncident(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateIncidentDto,
  ) {
    return this.odr.updateIncident(req.user.email, id, dto);
  }

  @Post("incidents/:id/events")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createIncidentEvent(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: IncidentEventDto,
  ) {
    return this.odr.createIncidentEvent(req.user.email, id, dto);
  }

  // Foto incidenta kroz RPC (F3) — prijavilac sme (REPORT), i bez WO/incident-UPDATE prava.
  @Post("incidents/:id/files")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_REPORT)
  @UseInterceptors(FilesInterceptor("files", 10, UPLOAD_LIMITS))
  attachIncidentFiles(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.odr.attachIncidentFiles(req.user.email, id, files ?? []);
  }

  // ---------- Radni nalozi: CRUD + events/parts/labor ----------

  @Post("work-orders")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createWorkOrder(@Req() req: AuthedRequest, @Body() dto: CreateWorkOrderDto) {
    return this.odr.createWorkOrder(req.user.email, dto);
  }

  @Patch("work-orders/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateWorkOrder(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkOrderDto,
  ) {
    return this.odr.updateWorkOrder(req.user.email, id, dto);
  }

  @Delete("work-orders/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteWorkOrder(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteWorkOrder(req.user.email, id);
  }

  @Post("work-orders/:id/events")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createWoEvent(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: WorkOrderEventDto,
  ) {
    return this.odr.createWoEvent(req.user.email, id, dto);
  }

  @Post("work-orders/:id/parts")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createWoPart(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: WorkOrderPartDto,
  ) {
    return this.odr.createWoPart(req.user.email, id, dto);
  }

  @Post("work-orders/:id/labor")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createWoLabor(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: WorkOrderLaborDto,
  ) {
    return this.odr.createWoLabor(req.user.email, id, dto);
  }

  // ---------- Vozila (RPC create/archive/restore + details + pod-entiteti) ----------

  @Post("vehicles")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createVehicle(@Req() req: AuthedRequest, @Body() dto: CreateMaintAssetDto) {
    return this.odr.createVehicle(req.user.email, dto);
  }

  @Post("vehicles/deadline-check")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  vehicleDeadlineCheck(
    @Req() req: AuthedRequest,
    @Body() dto: DeadlineCheckDto,
  ) {
    return this.odr.vehicleDeadlineCheck(req.user.email, dto);
  }

  @Post("vehicles/:id/archive")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  archiveVehicle(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ArchiveAssetDto,
  ) {
    return this.odr.archiveVehicle(req.user.email, id, dto.reason);
  }

  @Post("vehicles/:id/restore")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  restoreVehicle(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.restoreVehicle(req.user.email, id);
  }

  // Core maint_assets red vozila (HIGH#2; location_id/responsible_user_id — inače neupisivi).
  @Patch("vehicles/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  patchVehicleCore(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PatchAssetCoreDto,
  ) {
    return this.odr.patchAssetCore(req.user.email, id, dto);
  }

  @Put("vehicles/:id/details")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  upsertVehicleDetails(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DetailsUpsertDto,
  ) {
    return this.odr.upsertVehicleDetails(req.user.email, id, dto);
  }

  @Patch("vehicles/:id/toll-tag")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  patchVehicleTollTag(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TollTagDto,
  ) {
    return this.odr.patchVehicleTollTag(req.user.email, id, dto);
  }

  @Patch("vehicles/:id/shelf")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  patchVehicleShelf(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ShelfDto,
  ) {
    return this.odr.patchVehicleShelf(req.user.email, id, dto);
  }

  // ---------- Foto vozila (storage proxy F2-P4a; multipart `file`) ----------

  @Post("vehicles/:id/photo")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  uploadVehiclePhoto(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.odr.uploadVehiclePhoto(req.user.email, id, file);
  }

  @Delete("vehicles/:id/photo")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteVehiclePhoto(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteVehiclePhoto(req.user.email, id);
  }

  @Post("vehicles/:id/tires")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createTire(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateTireDto,
  ) {
    return this.odr.createTire(req.user.email, id, dto);
  }

  @Patch("vehicles/:id/tires/:tireId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateTire(
    @Req() req: AuthedRequest,
    @Param("tireId", ParseUUIDPipe) tireId: string,
    @Body() dto: UpdateTireDto,
  ) {
    return this.odr.updateTire(req.user.email, tireId, dto);
  }

  @Delete("vehicles/:id/tires/:tireId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteTire(
    @Req() req: AuthedRequest,
    @Param("tireId", ParseUUIDPipe) tireId: string,
  ) {
    return this.odr.deleteTire(req.user.email, tireId);
  }

  @Post("vehicles/:id/service-plan")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createVehicleServicePlan(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateVehicleServicePlanDto,
  ) {
    return this.odr.createVehicleServicePlan(req.user.email, id, dto);
  }

  @Post("vehicles/:id/service-plan/generate-wos")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  generateVehicleServiceWos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.ensureVehicleServiceWos(req.user.email, id);
  }

  @Patch("vehicles/:id/service-plan/:planId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateVehicleServicePlan(
    @Req() req: AuthedRequest,
    @Param("planId", ParseUUIDPipe) planId: string,
    @Body() dto: UpdateVehicleServicePlanDto,
  ) {
    return this.odr.updateVehicleServicePlan(req.user.email, planId, dto);
  }

  @Delete("vehicles/:id/service-plan/:planId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteVehicleServicePlan(
    @Req() req: AuthedRequest,
    @Param("planId", ParseUUIDPipe) planId: string,
  ) {
    return this.odr.deleteVehicleServicePlan(req.user.email, planId);
  }

  @Post("vehicles/:id/parts")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  linkPartToVehicle(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkPartDto,
  ) {
    return this.odr.linkPartToVehicle(req.user.email, id, dto);
  }

  @Patch("vehicles/:id/parts/:partId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updatePartVehicleLink(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("partId", ParseUUIDPipe) partId: string,
    @Body() dto: UpdatePartLinkDto,
  ) {
    return this.odr.updatePartVehicleLink(req.user.email, id, partId, dto);
  }

  @Delete("vehicles/:id/parts/:partId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  unlinkPartFromVehicle(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("partId", ParseUUIDPipe) partId: string,
  ) {
    return this.odr.unlinkPartFromVehicle(req.user.email, id, partId);
  }

  @Post("vehicles/:id/bookings")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createBooking(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.odr.createBooking(req.user.email, id, dto);
  }

  @Patch("vehicles/:id/bookings/:bookingId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateBooking(
    @Req() req: AuthedRequest,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
    @Body() dto: UpdateBookingDto,
  ) {
    return this.odr.updateBooking(req.user.email, bookingId, dto);
  }

  @Delete("vehicles/:id/bookings/:bookingId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteBooking(
    @Req() req: AuthedRequest,
    @Param("bookingId", ParseUUIDPipe) bookingId: string,
  ) {
    return this.odr.deleteBooking(req.user.email, bookingId);
  }

  // ---------- Vlasnici vozila ----------

  @Post("vehicle-owners")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createVehicleOwner(@Req() req: AuthedRequest, @Body() dto: CreateOwnerDto) {
    return this.odr.createVehicleOwner(req.user.email, dto);
  }

  // ---------- Vozači (PII) ----------

  @Post("drivers")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createDriver(@Req() req: AuthedRequest, @Body() dto: CreateDriverDto) {
    return this.odr.createDriver(req.user.email, dto);
  }

  @Patch("drivers/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateDriver(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.odr.updateDriver(req.user.email, id, dto);
  }

  @Post("drivers/:id/archive")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  archiveDriver(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ArchiveAssetDto,
  ) {
    return this.odr.archiveDriver(req.user.email, id, dto.reason);
  }

  @Post("drivers/:id/restore")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  restoreDriver(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.restoreDriver(req.user.email, id);
  }

  @Delete("drivers/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteDriver(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteDriver(req.user.email, id);
  }

  // ---------- IT oprema / Objekti (RPC create + details + arhiva + servisni plan) ----------

  @Post("it-assets")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createItAsset(@Req() req: AuthedRequest, @Body() dto: CreateMaintAssetDto) {
    return this.odr.createItAsset(req.user.email, dto);
  }

  // Core maint_assets red IT opreme (HIGH#2).
  @Patch("it-assets/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  patchItAssetCore(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PatchAssetCoreDto,
  ) {
    return this.odr.patchAssetCore(req.user.email, id, dto);
  }

  @Put("it-assets/:id/details")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  upsertItDetails(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DetailsUpsertDto,
  ) {
    return this.odr.upsertItDetails(req.user.email, id, dto);
  }

  @Post("facilities")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createFacility(@Req() req: AuthedRequest, @Body() dto: CreateMaintAssetDto) {
    return this.odr.createFacility(req.user.email, dto);
  }

  // Core maint_assets red objekta (HIGH#2).
  @Patch("facilities/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  patchFacilityCore(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PatchAssetCoreDto,
  ) {
    return this.odr.patchAssetCore(req.user.email, id, dto);
  }

  @Put("facilities/:id/details")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  upsertFacilityDetails(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DetailsUpsertDto,
  ) {
    return this.odr.upsertFacilityDetails(req.user.email, id, dto);
  }

  @Post("assets/:id/archive")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  archiveAsset(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ArchiveAssetDto,
  ) {
    return this.odr.archiveAsset(req.user.email, id, dto.reason);
  }

  @Post("assets/:id/restore")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  restoreAsset(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.restoreAsset(req.user.email, id);
  }

  @Post("assets/:id/service-plan")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createAssetServicePlan(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateAssetServicePlanDto,
  ) {
    return this.odr.createAssetServicePlan(req.user.email, id, dto);
  }

  @Post("assets/:id/service-plan/generate-wos")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  generateAssetServiceWos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.ensureAssetServiceWos(req.user.email, id);
  }

  @Patch("assets/:id/service-plan/:planId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateAssetServicePlan(
    @Req() req: AuthedRequest,
    @Param("planId", ParseUUIDPipe) planId: string,
    @Body() dto: UpdateAssetServicePlanDto,
  ) {
    return this.odr.updateAssetServicePlan(req.user.email, planId, dto);
  }

  @Delete("assets/:id/service-plan/:planId")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteAssetServicePlan(
    @Req() req: AuthedRequest,
    @Param("planId", ParseUUIDPipe) planId: string,
  ) {
    return this.odr.deleteAssetServicePlan(req.user.email, planId);
  }

  // ---------- Zalihe: delovi + dobavljači + stock ledger + lokacije ----------

  @Post("parts")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createPart(@Req() req: AuthedRequest, @Body() dto: CreatePartDto) {
    return this.odr.createPart(req.user.email, dto);
  }

  @Patch("parts/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updatePart(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartDto,
  ) {
    return this.odr.updatePart(req.user.email, id, dto);
  }

  @Post("parts/:id/stock-movements")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createStockMovement(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: StockMovementDto,
  ) {
    return this.odr.createStockMovement(req.user.email, id, dto);
  }

  @Post("suppliers")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createSupplier(@Req() req: AuthedRequest, @Body() dto: CreateSupplierDto) {
    return this.odr.createSupplier(req.user.email, dto);
  }

  @Patch("suppliers/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateSupplier(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.odr.updateSupplier(req.user.email, id, dto);
  }

  @Post("locations")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createLocation(@Req() req: AuthedRequest, @Body() dto: CreateLocationDto) {
    return this.odr.createLocation(req.user.email, dto);
  }

  @Patch("locations/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateLocation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.odr.updateLocation(req.user.email, id, dto);
  }

  // ---------- Dokumenta (storage proxy F4) ----------

  @Post("documents")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  uploadDocument(
    @Req() req: AuthedRequest,
    @Body() dto: UploadDocumentDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.odr.uploadDocument(req.user.email, dto, file);
  }

  @Patch("documents/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateDocument(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.odr.updateDocument(req.user.email, id, dto);
  }

  @Delete("documents/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  deleteDocument(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.deleteDocument(req.user.email, id);
  }

  // ---------- Podešavanja / notifikaciona pravila / retry ----------

  @Patch("settings")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateSettings(@Req() req: AuthedRequest, @Body() dto: UpdateSettingsDto) {
    return this.odr.updateSettings(req.user.email, dto);
  }

  @Post("notification-rules")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createNotificationRule(
    @Req() req: AuthedRequest,
    @Body() dto: CreateNotificationRuleDto,
  ) {
    return this.odr.createNotificationRule(req.user.email, dto);
  }

  @Patch("notification-rules/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateNotificationRule(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotificationRuleDto,
  ) {
    return this.odr.updateNotificationRule(req.user.email, id, dto);
  }

  @Post("notifications/:id/retry")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  retryNotification(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.odr.retryNotification(req.user.email, id);
  }

  // ---------- Maint profili — mutacije (SAMO ERP admin; service guard) ----------
  // Metod-nivo je coarse WRITE; SoD granicu (samo erp-admin, NE admin_ui krug) presuđuje
  // service `assertErpAdmin` + DB trigger `maint_profiles_guard_role`.

  @Post("profiles")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  createProfile(@Req() req: AuthedRequest, @Body() dto: CreateProfileDto) {
    return this.odr.createProfile(req.user.email, dto);
  }

  @Patch("profiles/:id")
  @RequirePermission(PERMISSIONS.ODRZAVANJE_WRITE)
  updateProfile(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.odr.updateProfile(req.user.email, id, dto);
  }
}
