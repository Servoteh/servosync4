import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";

/**
 * Mutacioni DTO-ovi za Održavanje (CMMS) R2 (MODULE_SPEC_odrzavanje_30.md §3).
 * `clientEventId` (uuid) je OBAVEZAN na NE-idempotentnim „create" POST-ovima
 * (nova mašina/WO/incident/šablon/kontrola/deo/dobavljač/vozač/lokacija/vozilo/IT/
 * objekat/guma/plan/rezervacija/napomena/kretanje zaliha/veza deo↔vozilo/WO deo/rad) —
 * idempotency ključ (Sy15Service.runIdempotentRls, doktrina A4). PATCH/DELETE/PUT
 * (upsert)/archive/restore/rename/import/generate/retry/override/toggle su idempotentni
 * pa ga NEMAJU. Row-odluku (102 RLS politike: maint profil po auth.uid() + ERP po email)
 * presuđuje sy15 kroz GUC most — NE duplira se ovde. Numerički/uuid param van skupa → 400.
 */

/* ── Enum allowliste (paritet žive sy15 šeme — prisma/sy15.prisma) ── */
const OP_STATUS = ["running", "degraded", "down", "maintenance"] as const;
const WO_STATUS = [
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
] as const;
const WO_PRIORITY = [
  "p1_zastoj",
  "p2_smetnja",
  "p3_manje",
  "p4_planirano",
] as const;
const WO_TYPE = [
  "kvar",
  "preventiva",
  "inspekcija",
  "servis",
  "administrativni",
  "incident",
  "preventive",
] as const;
const ASSET_TYPE = ["machine", "vehicle", "it", "facility"] as const;
const INCIDENT_STATUS = [
  "open",
  "acknowledged",
  "in_progress",
  "awaiting_parts",
  "resolved",
  "closed",
] as const;
const INCIDENT_SEVERITY = ["minor", "major", "critical"] as const;
const CHECK_RESULT = ["ok", "warning", "fail", "skipped"] as const;
const TASK_SEVERITY = ["normal", "important", "critical"] as const;
const INTERVAL_UNIT = ["hours", "days", "weeks", "months"] as const;
const MAINT_ROLE = [
  "operator",
  "technician",
  "chief",
  "management",
  "admin",
] as const;
const TIRE_SEASON = ["summer", "winter", "all_season"] as const;
const TIRE_STATUS = ["nove", "koriscene", "dotrajale", "bacene"] as const;
const OWNER_TYPE = ["firma", "leasing", "zaposleni", "spoljni"] as const;
const BOOKING_STATUS = ["planirana", "u_toku", "zavrsena", "otkazana"] as const;
const VEHICLE_SVC_CATEGORY = [
  "mali",
  "veliki",
  "kocnice",
  "elektrika",
  "oslanjanje",
  "motor_transmisija",
  "karoserija",
  "odluka_o_zameni",
  "ostalo",
] as const;
const STOCK_MOVEMENT_TYPE = ["in", "out", "adjustment", "return"] as const;
const NOTIF_CHANNEL = ["telegram", "email", "in_app", "whatsapp"] as const;
const DOC_ENTITY = [
  "asset",
  "work_order",
  "incident",
  "preventive_task",
  "driver",
] as const;

/** Baza za idempotentne „create" POST-ove (Sy15Service.runIdempotentRls). */
export class IdempotentDto {
  @IsUUID()
  clientEventId!: string;
}

/* ════════════════════════ Mašine ════════════════════════ */

export class CreateMachineDto extends IdempotentDto {
  @IsString() @MaxLength(60) machineCode!: string;
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsInt() yearOfManufacture?: number;
  @IsOptional() @IsInt() yearCommissioned?: number;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsNumber() powerKw?: number;
  @IsOptional() @IsNumber() weightKg?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() tracked?: boolean;
  @IsOptional() @IsIn(["manual", "bigtehn"]) source?: string;
  @IsOptional() @IsUUID() responsibleUserId?: string;
}

export class UpdateMachineDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsInt() yearOfManufacture?: number;
  @IsOptional() @IsInt() yearCommissioned?: number;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsNumber() powerKw?: number;
  @IsOptional() @IsNumber() weightKg?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() tracked?: boolean;
  @IsOptional() @IsUUID() responsibleUserId?: string;
}

export class RenameMachineDto {
  @IsString() @MaxLength(60) newCode!: string;
}

export class ImportMachinesDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) codes!: string[];
}

export class DeleteHardDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

export class StatusOverrideDto {
  @IsIn(OP_STATUS) status!: string;
  @IsString() @MaxLength(500) reason!: string;
  @IsOptional() @IsISO8601() validUntil?: string;
}

export class CreateNoteDto extends IdempotentDto {
  @IsString() @MaxLength(4000) content!: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
}

export class UpdateNoteDto {
  @IsOptional() @IsString() @MaxLength(4000) content?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
  /** true → soft-delete (deleted_at = now()); false → un-delete. */
  @IsOptional() @IsBoolean() deleted?: boolean;
}

/** Meta polja fajla mašine / dokumenta (multipart upload form ILI PATCH meta). */
export class FileMetaDto {
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/* ════════════════════════ Preventiva ════════════════════════ */

export class CreateTaskDto extends IdempotentDto {
  @IsString() @MaxLength(60) machineCode!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() instructions?: string;
  @IsInt() intervalValue!: number;
  @IsIn(INTERVAL_UNIT) intervalUnit!: string;
  @IsOptional() @IsIn(TASK_SEVERITY) severity?: string;
  @IsOptional() @IsIn(MAINT_ROLE) requiredRole?: string;
  @IsOptional() @IsInt() gracePeriodDays?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() instructions?: string;
  @IsOptional() @IsInt() intervalValue?: number;
  @IsOptional() @IsIn(INTERVAL_UNIT) intervalUnit?: string;
  @IsOptional() @IsIn(TASK_SEVERITY) severity?: string;
  @IsOptional() @IsIn(MAINT_ROLE) requiredRole?: string;
  @IsOptional() @IsInt() gracePeriodDays?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateCheckDto extends IdempotentDto {
  @IsUUID() taskId!: string;
  @IsString() @MaxLength(60) machineCode!: string;
  @IsIn(CHECK_RESULT) result!: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

/* ════════════════════════ Incidenti ════════════════════════ */

export class ReportIncidentDto extends IdempotentDto {
  @IsString() @MaxLength(60) machineCode!: string;
  @IsOptional() @IsUUID() assetId?: string;
  @IsOptional() @IsIn(ASSET_TYPE) assetType?: string;
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(INCIDENT_SEVERITY) severity!: string;
  @IsOptional() @IsBoolean() safetyMarker?: boolean;
}

export class UpdateIncidentDto {
  @IsOptional() @IsIn(INCIDENT_STATUS) status?: string;
  @IsOptional() @IsUUID() assignedTo?: string;
  @IsOptional() @IsIn(INCIDENT_SEVERITY) severity?: string;
  @IsOptional() @IsString() resolutionNotes?: string;
  @IsOptional() @IsInt() downtimeMinutes?: number;
  @IsOptional() @IsISO8601() resolvedAt?: string;
  @IsOptional() @IsISO8601() closedAt?: string;
  @IsOptional() @IsBoolean() safetyMarker?: boolean;
}

/**
 * Ručni komentar/tok incidenta. `clientEventId` sprečava dupli-klik → dupli komentar
 * (audit §5 „event rute bez clientEventId"). Idempotentno kroz runIdempotentRls.
 */
export class IncidentEventDto extends IdempotentDto {
  @IsString() @MaxLength(60) eventType!: string;
  @IsOptional() @IsString() @MaxLength(4000) comment?: string;
  @IsOptional() @IsString() fromValue?: string;
  @IsOptional() @IsString() toValue?: string;
}

/* ════════════════════════ Radni nalozi ════════════════════════ */

export class CreateWorkOrderDto extends IdempotentDto {
  @IsIn(WO_TYPE) type!: string;
  @IsUUID() assetId!: string;
  @IsIn(ASSET_TYPE) assetType!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(WO_PRIORITY) priority!: string;
  @IsOptional() @IsISO8601() dueAt?: string;
  @IsOptional() @IsBoolean() safetyMarker?: boolean;
  @IsOptional() @IsUUID() sourceIncidentId?: string;
}

export class UpdateWorkOrderDto {
  @IsOptional() @IsIn(WO_STATUS) status?: string;
  @IsOptional() @IsIn(WO_PRIORITY) priority?: string;
  @IsOptional() @IsUUID() assignedTo?: string;
  @IsOptional() @IsISO8601() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() closureComment?: string;
  @IsOptional() @IsISO8601() startedAt?: string;
  @IsOptional() @IsISO8601() completedAt?: string;
  @IsOptional() @IsISO8601() downtimeFrom?: string;
  @IsOptional() @IsISO8601() downtimeTo?: string;
  @IsOptional() @IsInt() laborMinutes?: number;
  @IsOptional() @IsNumber() costTotal?: number;
  @IsOptional() @IsNumber() estimatedCost?: number;
  @IsOptional() @IsBoolean() safetyMarker?: boolean;
  @IsOptional() @IsIn(VEHICLE_SVC_CATEGORY) vehicleServiceCategory?: string;
  @IsOptional() @IsInt() odometerKmAtService?: number;
  @IsOptional() @IsString() externalServicerName?: string;
}

/**
 * Ručni komentar/prelaz statusa WO. `clientEventId` sprečava dupli-klik → dupli komentar
 * (audit §5). Idempotentno kroz runIdempotentRls. (Automatski status_change event i dalje
 * piše DB trigger — ovaj je za ručni user_note/komentar iz drawera.)
 */
export class WorkOrderEventDto extends IdempotentDto {
  @IsString() @MaxLength(60) eventType!: string;
  @IsOptional() @IsString() @MaxLength(4000) comment?: string;
  @IsOptional() @IsString() fromValue?: string;
  @IsOptional() @IsString() toValue?: string;
}

export class WorkOrderPartDto extends IdempotentDto {
  @IsString() @MaxLength(300) partName!: string;
  @IsOptional() @IsUUID() partId?: string;
  @IsOptional() @IsNumber() quantity?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsString() supplier?: string;
}

export class WorkOrderLaborDto extends IdempotentDto {
  @IsInt() minutes!: number;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

/* ════════════════════════ Sredstva (RPC create) + arhiva ════════════════════════ */

/** Zajednički payload za create_maint_vehicle / _it_asset / _facility (details = jsonb). */
export class CreateMaintAssetDto extends IdempotentDto {
  @IsString() @MaxLength(60) assetCode!: string;
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsIn(OP_STATUS) status?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() assetNotes?: string;
  /** Slobodan objekat — RPC (`p_details->>'...'`) allowlist-uje kolone. */
  @IsOptional() @IsObject() details?: Record<string, unknown>;
}

export class ArchiveAssetDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

/** PUT upsert details (vozilo/IT/objekat) — service allowlist-uje kolone iz `details`. */
export class DetailsUpsertDto {
  @IsObject() details!: Record<string, unknown>;
}

/**
 * PATCH core `maint_assets` reda (HIGH#2 paritet 1.0 `patchMaintAsset`) — vozilo/IT/objekat
 * edit modali menjaju name/status/proizvođač/model/serijski/napomene + `location_id`/
 * `responsible_user_id` (create RPC ih NE prima → jedini put da se postave). `null` briše
 * vezu (unassign). Row-odluku (asset_visible ∧ erp/chief/admin) presuđuje RLS.
 */
export class PatchAssetCoreDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsIn(OP_STATUS) status?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() notes?: string;
  /** uuid maint_locations ILI null (unassign). */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() locationId?:
    | string
    | null;
  /** uuid odgovornog korisnika ILI null (unassign). */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  responsibleUserId?: string | null;
}

/* ════════════════════════ Vozila ════════════════════════ */

export class TollTagDto {
  @IsOptional() @IsString() tollTagSerial?: string;
  @IsOptional() @IsString() tollTagProvider?: string;
  @IsOptional() @IsString() tollTagNotes?: string;
}

export class ShelfDto {
  @IsOptional() @IsBoolean() hasPartsSet?: boolean;
  @IsOptional() @IsString() partsShelf?: string;
  @IsOptional() @IsString() partsNotes?: string;
}

export class CreateTireDto extends IdempotentDto {
  @IsIn(TIRE_SEASON) season!: string;
  @IsString() @MaxLength(100) dimension!: string;
  @IsInt() count!: number;
  @IsOptional() @IsIn(TIRE_STATUS) status?: string;
  @IsOptional() @IsString() shelfCode?: string;
  @IsOptional() @IsBoolean() installedOnVehicle?: boolean;
  @IsOptional() @IsISO8601() purchasedAt?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateTireDto {
  @IsOptional() @IsIn(TIRE_SEASON) season?: string;
  @IsOptional() @IsString() @MaxLength(100) dimension?: string;
  @IsOptional() @IsInt() count?: number;
  @IsOptional() @IsIn(TIRE_STATUS) status?: string;
  @IsOptional() @IsString() shelfCode?: string;
  @IsOptional() @IsBoolean() installedOnVehicle?: boolean;
  @IsOptional() @IsISO8601() purchasedAt?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateVehicleServicePlanDto extends IdempotentDto {
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsInt() intervalKm?: number;
  @IsOptional() @IsInt() intervalMonths?: number;
  @IsOptional() @IsISO8601() lastDoneAt?: string;
  @IsOptional() @IsInt() lastDoneKm?: number;
  @IsOptional() @IsIn(VEHICLE_SVC_CATEGORY) vehicleServiceCategory?: string;
  @IsOptional() @IsIn(WO_PRIORITY) priority?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateVehicleServicePlanDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsInt() intervalKm?: number;
  @IsOptional() @IsInt() intervalMonths?: number;
  @IsOptional() @IsISO8601() lastDoneAt?: string;
  @IsOptional() @IsInt() lastDoneKm?: number;
  @IsOptional() @IsIn(VEHICLE_SVC_CATEGORY) vehicleServiceCategory?: string;
  @IsOptional() @IsIn(WO_PRIORITY) priority?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class LinkPartDto extends IdempotentDto {
  @IsUUID() partId!: string;
  @IsOptional() @IsNumber() qtyMin?: number;
  @IsOptional() @IsString() notes?: string;
}

export class UpdatePartLinkDto {
  @IsOptional() @IsNumber() qtyMin?: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateBookingDto extends IdempotentDto {
  @IsISO8601() startAt!: string;
  @IsISO8601() endAt!: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsString() purpose?: string;
  @IsOptional() @IsIn(BOOKING_STATUS) status?: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateBookingDto {
  @IsOptional() @IsISO8601() startAt?: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsString() purpose?: string;
  @IsOptional() @IsIn(BOOKING_STATUS) status?: string;
  @IsOptional() @IsString() notes?: string;
}

export class DeadlineCheckDto {
  @IsOptional() @IsInt() lookaheadDays?: number;
}

export class CreateOwnerDto extends IdempotentDto {
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsIn(OWNER_TYPE) ownerType?: string;
  @IsOptional() @IsString() contact?: string;
  @IsOptional() @IsString() notes?: string;
}

/* ════════════════════════ Vozači (PII) ════════════════════════ */

export class CreateDriverDto extends IdempotentDto {
  @IsString() @MaxLength(300) fullName!: string;
  @IsOptional() @IsBoolean() isInternal?: boolean;
  @IsOptional() @IsUUID() authUserId?: string;
  @IsString() @MaxLength(100) driversLicenseNumber!: string;
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  driversLicenseCategories!: string[];
  @IsISO8601() driversLicenseValidUntil!: string;
  @IsOptional() @IsString() idCardNumber?: string;
  @IsOptional() @IsISO8601() idCardValidUntil?: string;
  @IsOptional() @IsISO8601() medicalCheckValidUntil?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() jmbg?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateDriverDto {
  @IsOptional() @IsString() @MaxLength(300) fullName?: string;
  @IsOptional() @IsBoolean() isInternal?: boolean;
  /**
   * ERP nalog vozača (auth.users.id) ILI null (raskini vezu). Skriveno pravilo 11:
   * spoljni vozač (is_internal=false) NE sme imati auth_user_id (DB CHECK) — service
   * forsira null (maintenance.js:2836). `null` = eksplicitno odveži.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() authUserId?:
    | string
    | null;
  @IsOptional() @IsString() driversLicenseNumber?: string;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  driversLicenseCategories?: string[];
  @IsOptional() @IsISO8601() driversLicenseValidUntil?: string;
  @IsOptional() @IsString() idCardNumber?: string;
  @IsOptional() @IsISO8601() idCardValidUntil?: string;
  @IsOptional() @IsISO8601() medicalCheckValidUntil?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() jmbg?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/* ════════════════════════ Servisni plan IT/objekti ════════════════════════ */

export class CreateAssetServicePlanDto extends IdempotentDto {
  @IsString() @MaxLength(300) name!: string;
  @IsInt() intervalMonths!: number;
  @IsOptional() @IsISO8601() lastDoneAt?: string;
  @IsOptional() @IsIn(WO_PRIORITY) priority?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateAssetServicePlanDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsInt() intervalMonths?: number;
  @IsOptional() @IsISO8601() lastDoneAt?: string;
  @IsOptional() @IsIn(WO_PRIORITY) priority?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/* ════════════════════════ Zalihe / dobavljači / lokacije ════════════════════════ */

export class CreatePartDto extends IdempotentDto {
  @IsString() @MaxLength(100) partCode!: string;
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() currentStock?: number;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdatePartDto {
  @IsOptional() @IsString() @MaxLength(100) partCode?: string;
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsNumber() minStock?: number;
  @IsOptional() @IsNumber() currentStock?: number;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class StockMovementDto extends IdempotentDto {
  @IsIn(STOCK_MOVEMENT_TYPE) movementType!: string;
  @IsNumber() quantity!: number;
  @IsOptional() @IsUUID() woId?: string;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsString() note?: string;
}

export class CreateSupplierDto extends IdempotentDto {
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsString() contact?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsString() contact?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateLocationDto extends IdempotentDto {
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() locationType?: string;
  @IsOptional() @IsUUID() parentLocationId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateLocationDto {
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() locationType?: string;
  @IsOptional() @IsUUID() parentLocationId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/* ════════════════════════ Dokumenta ════════════════════════ */

export class UploadDocumentDto {
  @IsIn(DOC_ENTITY) entityType!: string;
  @IsUUID() entityId!: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsISO8601() validUntil?: string;
}

export class UpdateDocumentDto {
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/* ════════════════════════ Podešavanja / notif pravila ════════════════════════ */

export class UpdateSettingsDto {
  @IsOptional() @IsBoolean() autoCreateWoMajor?: boolean;
  @IsOptional() @IsBoolean() autoCreateWoCritical?: boolean;
  @IsOptional() @IsBoolean() safetyMarkerRequiresWo?: boolean;
  @IsOptional() @IsIn(WO_PRIORITY) defaultWoPriority?: string;
  @IsOptional() @IsInt() majorWoDueHours?: number;
  @IsOptional() @IsInt() criticalWoDueHours?: number;
  @IsOptional() @IsInt() preventiveDueWarningDays?: number;
  @IsOptional() @IsBoolean() notificationEnabled?: boolean;
  @IsOptional() @IsBoolean() notifyOnMajorIncident?: boolean;
  @IsOptional() @IsBoolean() notifyOnCriticalIncident?: boolean;
  @IsOptional() @IsBoolean() notifyOnOverduePreventive?: boolean;
  @IsOptional()
  @IsArray()
  @IsIn(NOTIF_CHANNEL, { each: true })
  notificationChannels?: string[];
  @IsOptional() @IsString() notes?: string;
}

export class CreateNotificationRuleDto extends IdempotentDto {
  @IsOptional() @IsString() @MaxLength(60) eventType?: string;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsIn(ASSET_TYPE) assetType?: string;
  @IsOptional() @IsIn(MAINT_ROLE) targetRole?: string;
  @IsOptional() @IsIn(NOTIF_CHANNEL) channel?: string;
  @IsOptional() @IsInt() delayMinutes?: number;
  @IsOptional() @IsInt() escalationLevel?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateNotificationRuleDto {
  @IsOptional() @IsString() @MaxLength(60) eventType?: string;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsIn(ASSET_TYPE) assetType?: string;
  @IsOptional() @IsIn(MAINT_ROLE) targetRole?: string;
  @IsOptional() @IsIn(NOTIF_CHANNEL) channel?: string;
  @IsOptional() @IsInt() delayMinutes?: number;
  @IsOptional() @IsInt() escalationLevel?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() notes?: string;
}

/* ════════════════════════ Maint profili (SoD; audit H19/H20) ════════════════════════ */

/**
 * CMMS profil (maint_user_profiles) — vezan za `auth.uid()` (NE za email!). Mutacije SAMO
 * ERP admin (service `assertErpAdmin`; DB trigger `maint_profiles_guard_role` ostaje tvrda
 * granica za role/active). POST mora imati EKSPLICITNU proveru duplikata `userId` — 1.0
 * `insertMaintProfile` (sbReq POST) default-uje merge-duplicates pa bi tiho pregazio profil
 * (§5.1 pravilo 22, maintProfilesTab.js:161-167). `phone` = E.164 (koristi ga notif kanal);
 * paritet 1.0 = slobodan tekst (bez stroge validacije, doktrina §C), pa ostaje `@IsString`.
 */
export class CreateProfileDto extends IdempotentDto {
  /** auth.users.id korisnika (= maint_user_profiles.user_id, PK). */
  @IsUUID() userId!: string;
  @IsString() @MaxLength(300) fullName!: string;
  @IsIn(MAINT_ROLE) role!: string;
  @IsOptional() @IsArray() @IsString({ each: true })
  assignedMachineCodes?: string[];
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) telegramChatId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(300) fullName?: string;
  @IsOptional() @IsIn(MAINT_ROLE) role?: string;
  @IsOptional() @IsArray() @IsString({ each: true })
  assignedMachineCodes?: string[];
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) telegramChatId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
