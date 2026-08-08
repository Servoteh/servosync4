import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
// 🔴 DVA KLIJENTA U ISTOM FAJLU. `Prisma` je sy15 (1.0) klijent, `P30` je 3.0.
// Alias je NAMERNO kratak i vidljiv: `Prisma.sql` i `P30.sql` prave upit nad
// RAZLIČITIM bazama, pa zamena jednog drugim ne pada nego tiho čita pogrešnu
// bazu. Pravilo: sve u `*30` metodama ide kroz `P30`, sve ostalo kroz `Prisma`.
import { Prisma as P30 } from "@prisma/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import {
  assertAttachment,
  assertAttachments,
  IMAGE_ATTACHMENT_FORMATS,
} from "../../common/attachments/attachment-format.util";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  IdempotencyService,
  type IdempotencyTx,
} from "../../common/idempotency/idempotency.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import {
  AI_TASK,
  AiModelPolicyService,
} from "../../common/ai/ai-model-policy.service";
import { AI_MODULE } from "../../common/ai/ai-limits.service";
import {
  fenceUserInput,
  ODRZAVANJE_INJECTION_FENCE,
} from "../../common/ai/injection-fence";
import { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";
// 🔴 NE `import type` — sve tri klase su DI tokeni (Nest ih traži u runtime-u).
// 🔴 Korak 2 seobe: prepis DEFINER funkcija/trigera + 3.0 parnjak RLS-a.
// Bez njih upisni put pod `3.0` NE POSTOJI (brana `assertPorted` ostaje na snazi).
import {
  OdrzavanjeAuthzService,
  type MaintScope,
} from "./odrzavanje-authz.service";
import {
  OdrzavanjeFnService,
  type OdrzavanjeTx,
} from "./odrzavanje-fn.service";
import { OdrzavanjeLokacijeMostService } from "./odrzavanje-lokacije-most.service";
import {
  normalizeRacunOut,
  RACUN_AI_ALLOWED_MODELS,
  RACUN_AI_DEFAULT_MODEL,
  RACUN_AI_SYSTEM_PROMPT,
  RACUN_AI_TOOL,
  RACUN_MAX_FAJL_B64,
  RACUN_MAX_FAJLOVA,
  RACUN_PDF_MIME,
  RACUN_VISION_MIME,
} from "./odrzavanje-racun-ai";
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
import {
  assertAtLeastOneInterval,
  normalizeAssetIntervalMonths,
  normalizeInterval,
} from "./dto/service-plan-intervals";

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
  status?: string; // efektivni op-status (running/degraded/down/maintenance) — 1.0 chip
  deadline?: string; // "overdue" | "danas" | "7d" — rok grupa (index.js:724-735)
  location?: string; // tačna lokacija (maint_machines.location) — 1.0 select
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
  q?: string; // pretraga: wo_number/naslov/opis/sredstvo (index.js:168-174)
  openOnly?: string; // default ON (sakrij zavrsen/otkazan); "false" = prikaži sve — paritet 1.0 `open!=='0'`
  overdue?: string; // "true" = samo otvoreni sa due_at < now
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
  incidentId?: string; // related_entity_id filter (maintenance.js:1600)
  page?: string;
  pageSize?: string;
}
export interface PartsQuery {
  q?: string;
  vehicleId?: string;
  lowStock?: string; // "true" = samo current_stock < min_stock
  includeInactive?: string; // "true" = uklj. neaktivne delove (default samo active)
  page?: string;
  pageSize?: string;
}

/**
 * Redovi view-ova koje `board` čita. Izdvojeni u tipove jer ih sada čitaju DVE
 * grane (sy15 i 3.0) i sklapa ih zajednički `boardData` — da se oblik odgovora
 * ne bi razišao između izvora.
 */
export interface BoardDueRed {
  task_id: string;
  machine_code: string;
  title: string;
  severity: string | null;
  interval_value: number | null;
  interval_unit: string | null;
  next_due_at: Date | string;
  bucket: string;
}
export interface BoardOverrideRed {
  machine_code: string;
  status: string;
  override_reason: string | null;
  override_valid_until: Date | string | null;
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
    private readonly otpisNotify: MasinaOtpisNotifyService,
    // AI je opcion: modul mora da se digne i bez AI ključeva (boot-safe, kao storage).
    // Postojeći unit testovi prave servis sa 3 argumenta — zato @Optional.
    @Optional() private readonly ai?: AiProviderService,
    @Optional() private readonly policy?: AiModelPolicyService,
    @Optional() private readonly prisma?: PrismaService,
    // Prekidač izvora (korak 2 gašenja sy15). @Optional iz istog razloga kao gore;
    // kad ga nema, `assertPorted` ne radi ništa → ponašanje je kao `sy15`, tj.
    // izostanak prekidača NIKAD ne može da prebaci modul na 3.0 (bezbedan smer).
    @Optional() private readonly izvor?: OdrzavanjeSourceService,
    // Registar idempotencije 3.0 baze (`api_idempotency`) — 3.0 parnjak sy15
    // `runIdempotentRls`. `@Optional` iz istog razloga kao `izvor`: postojeći unit
    // testovi prave servis sa 3 argumenta. Kad ga nema, `runIdem` NE prelazi u 3.0
    // granu (v. branu tamo) — izostanak zavisnosti nikad ne pomera izvor podataka.
    @Optional() private readonly idem?: IdempotencyService,
    // 3.0 parnjak sy15 RLS-a (`OdrzavanjeAuthzService`) i prepis DEFINER funkcija
    // (`OdrzavanjeFnService`). `@Optional` iz istog razloga kao gore — postojeći
    // unit testovi prave servis sa 3 argumenta. Kad ih NEMA, `tri30` je `false`,
    // pa čitanje/upis pod `3.0` pada na `withUserMapped` gde ga dočeka brana (503):
    // izostanak zavisnosti nikad ne može tiho da vrati saobraćaj u sy15.
    @Optional() private readonly authz?: OdrzavanjeAuthzService,
    @Optional() private readonly fnSvc?: OdrzavanjeFnService,
    // 🔴 MOST ka `loc_locations` (sy15) — treba ISKLJUČIVO upisnoj polovini (§7.1):
    // mašina upisana u 3.0 mora da dobije/izgubi lokaciju u tuđoj bazi. Isti
    // `@Optional` razlog; kad ga nema, `mostSync` samo preskoči (nikad ne pukne).
    @Optional() private readonly locMost?: OdrzavanjeLokacijeMostService,
  ) {}

  /**
   * Brana prekidača. Pod `ODRZAVANJE_IZVOR=sy15` ne radi ništa; pod `3.0` baca 503
   * sa imenom putanje.
   *
   * Sav saobraćaj modula prolazi kroz `withUserMapped`/`runIdem` — izmereno 121 + 24
   * poziva, i nijedan direktan sirov pristup sy15 datasource-u mimo njih (to i
   * pinuje `odrzavanje.set-role-discipline.spec.ts`). Zato je dovoljno postaviti
   * branu na ta dva mesta da nijedan upis ne može TIHO da ode u sy15 dok se logika
   * prepisuje.
   */
  private assertPorted(feature: string): void {
    this.izvor?.assertPorted(feature);
  }

  // ==========================================================================
  // 3.0 — ZAJEDNIČKI ULAZ U READ GRANU (§7.1 / §7.4 runbook-a)
  // ==========================================================================
  //
  // 🔴 ZAŠTO SVAKO ČITANJE ISPOD NOSI EKSPLICITAN SCOPE
  //
  // U sy15 row-scope sprovodi 102 RLS politike, a svih 15 `v_maint_*` view-ova je
  // `security_invoker = true` — dakle RLS pozivaoca se primenjivao I KROZ VIEW.
  // 3.0 nema RLS (ODLUKE.md), pa `SELECT * FROM v_maint_vehicle_overview` vraća
  // SVA vozila i operateru koji ne sme da vidi nijedno. To je NAJTIŠI mogući kvar
  // cele seobe: upit ne puca, ruta ne vraća grešku, ekran se otvori — samo ima
  // više redova nego što sme. Test koji proverava „ima li podataka" to NE hvata;
  // hvata ga isključivo test koji BROJI redove za usku rolu (v.
  // `odrzavanje-citanja-3-0.spec.ts`, tabela istinitosti po roli).
  //
  // Zato nijedan `*30` metod ispod ne čita bazu pre `scope30(email)`, i svaki
  // upit spaja isečak iz `OdrzavanjeAuthzService`. Pravilo je:
  //   `undefined`/`null`  = „ne dodaj ništa" (pozivalac ionako vidi sve);
  //   prazan `in: []`     = „nula redova" — TAČAN parnjak RLS-a za operatera bez
  //                         dodeljenih mašina; NIKAD ga ne pretvarati u `undefined`.
  //
  // ⚠️ Fiksni filter ekrana i scope se spajaju kroz `AND: [...]`, a NE kroz spread.
  // Spread bi kod sudara ključeva (`machineCode`, `assetType`, `OR`) drugi objekat
  // pustio da PREGAZI prvi — i to bi u pola slučajeva proširilo prava.

  /** Da li ovo čitanje ide 3.0 putem (prekidač JE na `3.0` i sve zavisnosti postoje). */
  private get tri30(): boolean {
    return (
      this.izvor?.isThreeZero === true &&
      !!this.prisma &&
      !!this.authz &&
      !!this.fnSvc
    );
  }

  /**
   * 3.0 zavisnosti kao ne-null trojka. Postojanje je već provereno u `tri30`, pa
   * je bacanje ovde samo mreža: kad zavisnosti FALE, `tri30` je `false` i poziv
   * pada natrag na `withUserMapped`, gde ga pod `3.0` dočeka brana `assertPorted`
   * (503). Izostanak zavisnosti tako NIKAD ne može tiho da vrati čitanje u sy15.
   */
  private tri(): {
    db: PrismaService;
    az: OdrzavanjeAuthzService;
    fn: OdrzavanjeFnService;
  } {
    if (!this.prisma || !this.authz || !this.fnSvc) {
      throw new ServiceUnavailableException(
        "Održavanje (3.0): nedostaje PrismaService/OdrzavanjeAuthzService/OdrzavanjeFnService.",
      );
    }
    return { db: this.prisma, az: this.authz, fn: this.fnSvc };
  }

  /**
   * e-mail pozivaoca → snimak prava (`MaintScope`).
   *
   * U sy15 je isti posao radio GUC (`auth.uid()` + `jwt.email`) pa su ga gejtovi
   * čitali sami; u 3.0 se mora izmeriti unapred i proslediti u svaki upit.
   * Nalog koji 3.0 baza ne poznaje NE dobija „prazna prava" nego 403: prazan
   * scope bi za neke rute (npr. one bez sužavanja) bio isto što i puna prava.
   */
  private async scope30(email: string): Promise<MaintScope> {
    const { db, az } = this.tri();
    const u = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (!u) {
      throw new ForbiddenException(
        `Nalog ${email} ne postoji u 3.0 bazi — prava održavanja se ne mogu odrediti`,
      );
    }
    return az.loadScope(u.id);
  }

  /** Spaja SQL isečke u jedan `AND` uslov; `null` kad nijedan ne postoji. */
  private andSql(...delovi: (P30.Sql | null)[]): P30.Sql | null {
    const zivi = delovi.filter((d): d is P30.Sql => d != null);
    if (!zivi.length) return null;
    return zivi.reduce((a, b) => P30.sql`${a} AND ${b}`);
  }

  /**
   * SQL parnjak `assetListWhere` nad view-om koji nabraja SVE tipove sredstava
   * (`v_maint_asset_service_plan_due` — jedini takav).
   *
   * 🔴 `nonMachineViewScopeSql` ovde NE VAŽI: taj helper sme samo nad view-ovima
   * koji vraćaju isključivo ne-mašinska sredstva. Da se upotrebi ovde, tehničar
   * (`M ∧ ¬N`) bi izgubio i mašinske planove, a operater bi dobio `FALSE` umesto
   * svojih mašina. Odluku i dalje donosi `OdrzavanjeAuthzService`
   * (`machineVisibleForAll` / `nonMachineVisible` / `assignedMachineCodes`) —
   * ovde se ona samo prevodi u SQL.
   */
  private assetTipViewScopeSql(s: MaintScope): P30.Sql | null {
    const { az } = this.tri();
    const m = az.machineVisibleForAll(s);
    const n = az.nonMachineVisible(s);
    if (m && n) return null;
    // Tehničar: sve mašine, nijedno vozilo/IT/objekat.
    if (m) return P30.sql`asset_type = 'machine'`;
    const codes = az.assignedMachineCodes(s);
    // (Mrtva grana po konstrukciji — `N ⊆ M`; ostaje doslovna radi tačnosti prepisa.)
    if (n) {
      if (!codes.length) return P30.sql`asset_type <> 'machine'`;
      return P30.sql`(asset_type <> 'machine' OR asset_id IN (
        SELECT mm.asset_id FROM maint_machines mm WHERE mm.machine_code = ANY(${codes}::text[])))`;
    }
    // Operater: samo dodeljene mašine; bez ijedne -> nula redova (kao RLS).
    if (!codes.length) return P30.sql`FALSE`;
    return P30.sql`(asset_type = 'machine' AND asset_id IN (
      SELECT mm.asset_id FROM maint_machines mm WHERE mm.machine_code = ANY(${codes}::text[])))`;
  }

  // ==========================================================================
  // /maintenance/me — dvoslojni profil pozivaoca (server računa preko GUC-a)
  // ==========================================================================

  /**
   * Efektivna maint-prava pozivaoca (paritet 1.0 `fetchMaintUserProfile` + lokalni
   * helperi). Server računa preko DEFINER helper fn pod GUC-om (auth.uid()+email);
   * FE fino-gejtuje po ovome (guard/rola sloj NE može izraziti maint profil).
   */
  async me(email: string) {
    if (this.tri30) return this.me30(email);
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
      return {
        data: this.meData(
          r.maint_role,
          r.floor_read,
          r.erp_admin,
          r.erp_admin_or_management,
          profile,
        ),
      };
    });
  }

  /**
   * 3.0 parnjak `me()`. Četiri GUC helpera (`maint_profile_role`,
   * `maint_has_floor_read_access`, `maint_is_erp_admin`,
   * `maint_is_erp_admin_or_management`) zamenjuje JEDAN `loadScope` — isti snimak
   * prava koji potom nose i svi ostali upiti, pa `/me` i liste ne mogu da se raziđu.
   *
   * ⚠️ UGOVOR PREMA FE-u JE NEPROMENJEN: ista polja, isti `gates` — jedina razlika
   * je da `profile.userId` postaje broj (3.0 `users.id`) umesto uuid-a, što je
   * posledica odluke 2 seobe i važi za ceo modul.
   */
  private async me30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    // `maint_user_profiles` SELECT = `uid() = user_id ∨ erp_admin` — SVOJ red
    // pozivalac vidi uvek, pa `/me` ne traži dodatno sužavanje.
    const profile = await db.maintUserProfile.findUnique({
      where: { userId: scope.userId },
    });
    return {
      data: this.meData(
        az.profileRole(scope),
        az.hasFloorReadAccess(scope),
        az.isErpAdmin(scope),
        az.isErpAdminOrManagement(scope),
        profile,
      ),
    };
  }

  /**
   * Ugovor `/maintenance/me` — JEDAN izvor za oba izvora podataka.
   * FE gate-ovi (paritet 1.0 §2.4): guard/RLS su autoritativni, ovo je za PRIKAZ.
   */
  private meData(
    role: string | null,
    floorRead: boolean,
    erpAdmin: boolean,
    erpMgmt: boolean,
    profile: unknown,
  ) {
    const isChiefAdmin = role === "chief" || role === "admin";
    const gates = {
      canManageMaintCatalog: erpMgmt || isChiefAdmin,
      canManageMaintTasks: erpMgmt || isChiefAdmin, // 1.0 maintTasksTab.js:32-35 — erp adm/mgmt/magacioner ∨ chief/admin (spec §2.4 „bez erp kruga" oboren auditom 17.07; RLS ostaje autoritativan)
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
      maintRole: role,
      floorRead,
      erpAdmin,
      erpAdminOrManagement: erpMgmt,
      profile,
      gates,
    };
  }

  // ==========================================================================
  // Dashboard / Pregled (spec §3, §4.1)
  // ==========================================================================

  /** Objedinjeni pregled: statusi mašina + dnevni sažetak + brojevi kategorija (1 poziv umesto 9). */
  async dashboard(email: string) {
    if (this.tri30) return this.dashboard30(email);
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

  /**
   * 3.0 parnjak `dashboard()`. Sve četiri brojke su u sy15 bile SUŽENE RLS-om
   * pozivaoca (i kroz view i kroz `count`), pa svaka ovde nosi svoj isečak.
   *
   * 🔴 `v_maint_cmms_daily_summary` je jedini view koji se ne da suziti u `WHERE`
   * — on je skup `count(*)` podupita nad celom bazom. Zato ga sme videti samo
   * onaj kome `canReadFullSummary()` kaže da ionako vidi sve; ostalima ide `null`.
   * Vraćanje nesuženih brojki bilo bi curenje: „7 otvorenih kvarova" operateru
   * koji sme da vidi jednu mašinu odaje stanje cele firme.
   */
  private async dashboard30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const [machineStatus, dailySummary, kategorije] = await Promise.all([
      db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_machine_current_status${az.viewWhere(
          az.machineScopeSql(scope),
        )}`,
      ),
      az.canReadFullSummary(scope)
        ? db.$queryRaw(P30.sql`SELECT * FROM v_maint_cmms_daily_summary`)
        : Promise.resolve([] as unknown[]),
      db.maintAsset.groupBy({
        by: ["assetType"],
        where: {
          AND: [
            { archivedAt: null },
            (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
          ],
        },
        _count: { _all: true },
      }),
    ]);
    const [openIncidents, openWorkOrders] = await Promise.all([
      db.maintIncident.count({
        where: {
          AND: [
            { status: { notIn: ["resolved", "closed"] } },
            (az.incidentListWhere(scope) ?? {}) as P30.MaintIncidentWhereInput,
          ],
        },
      }),
      db.maintWorkOrder.count({
        where: {
          AND: [
            { status: { notIn: ["zavrsen", "otkazan"] } },
            (az.workOrderListWhere(scope) ??
              {}) as P30.MaintWorkOrderWhereInput,
          ],
        },
      }),
    ]);
    return {
      data: {
        machineStatus,
        dailySummary: this.numRows((dailySummary as unknown[])[0] ?? null),
        categoryCounts: kategorije.map((k) => ({
          asset_type: k.assetType,
          n: k._count._all,
        })),
        openIncidents,
        openWorkOrders,
      },
    };
  }

  /**
   * Board (#33): preventivni taskovi grupisani u kolone Prekoračeno/Danas/Narednih 7 dana
   * (bucket iz `v_maint_task_due_dates` po DB clock-u — kalendarski dan, paritet 1.0
   * bucketTaskDueDates index.js:494-513) + aktivni override-i po mašini (za „PAUZA" izdvajanje
   * na dno kolone, splitByOverride index.js:1349-1357) + imena mašina. FE renderuje/izdvaja.
   */
  async board(email: string) {
    if (this.tri30) return this.board30(email);
    return this.withUserMapped(email, async (tx) => {
      const [dues, statuses, machines] = await Promise.all([
        tx.$queryRaw<BoardDueRed[]>(
          Prisma.sql`SELECT task_id, machine_code, title, severity,
              interval_value, interval_unit, next_due_at,
              CASE
                WHEN next_due_at < date_trunc('day', now()) THEN 'overdue'
                WHEN next_due_at < date_trunc('day', now()) + interval '1 day' THEN 'today'
                WHEN next_due_at < date_trunc('day', now()) + interval '8 days' THEN 'week'
                ELSE 'later'
              END AS bucket
            FROM v_maint_task_due_dates
            WHERE next_due_at IS NOT NULL
            ORDER BY next_due_at ASC`,
        ),
        tx.$queryRaw<BoardOverrideRed[]>(
          Prisma.sql`SELECT machine_code, status, override_reason, override_valid_until
            FROM v_maint_machine_current_status WHERE override_reason IS NOT NULL`,
        ),
        tx.maintMachine.findMany({ select: { machineCode: true, name: true } }),
      ]);
      return { data: this.boardData(dues, statuses, machines) };
    });
  }

  /**
   * 3.0 parnjak `board()` — oba view-a nose `machineScopeSql`, a spisak imena
   * mašina `machineListWhere`.
   *
   * ⚠️ `v_maint_task_due_dates` ima `COALESCE(..., now())`: zadatak koji NIKAD
   * nije izvršen dospeva ODMAH i pada u kolonu „Prekoračeno". To je prepis, ne
   * greška — ali znači da broj stavki kalendara zavisi od toga koliko zadataka
   * nema nijednu kontrolu, pa se paritetno merenje radi po istoj definiciji.
   */
  private async board30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const masine = az.machineScopeSql(scope);
    const [dues, statuses, machines] = await Promise.all([
      db.$queryRaw<BoardDueRed[]>(
        P30.sql`SELECT task_id, machine_code, title, severity,
              interval_value, interval_unit, next_due_at,
              CASE
                WHEN next_due_at < date_trunc('day', now()) THEN 'overdue'
                WHEN next_due_at < date_trunc('day', now()) + interval '1 day' THEN 'today'
                WHEN next_due_at < date_trunc('day', now()) + interval '8 days' THEN 'week'
                ELSE 'later'
              END AS bucket
            FROM v_maint_task_due_dates${az.viewWhere(
              this.andSql(P30.sql`next_due_at IS NOT NULL`, masine),
            )}
            ORDER BY next_due_at ASC`,
      ),
      db.$queryRaw<BoardOverrideRed[]>(
        P30.sql`SELECT machine_code, status, override_reason, override_valid_until
            FROM v_maint_machine_current_status${az.viewWhere(
              this.andSql(P30.sql`override_reason IS NOT NULL`, masine),
            )}`,
      ),
      db.maintMachine.findMany({
        where: az.machineListWhere(scope),
        select: { machineCode: true, name: true },
      }),
    ]);
    return { data: this.boardData(dues, statuses, machines) };
  }

  /** Sklapanje odgovora `board` — JEDAN izvor za oba izvora podataka. */
  private boardData(
    dues: BoardDueRed[],
    statuses: BoardOverrideRed[],
    machines: { machineCode: string; name: string }[],
  ) {
    return {
      overdue: dues.filter((d) => d.bucket === "overdue"),
      today: dues.filter((d) => d.bucket === "today"),
      week: dues.filter((d) => d.bucket === "week"),
      overrides: statuses.map((s) => ({
        machineCode: s.machine_code,
        status: s.status,
        reason: s.override_reason,
        validUntil: s.override_valid_until,
      })),
      machineNames: machines.map((m) => ({
        machineCode: m.machineCode,
        name: m.name,
      })),
    };
  }

  // ==========================================================================
  // Mašine (spec §4.2/§4.4)
  // ==========================================================================

  async listMachines(email: string, query: MachinesQuery) {
    if (this.tri30) return this.listMachines30(email, query);
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    return this.withUserMapped(email, async (tx) => {
      // Rok/status filteri se izvode iz view-ova (v_maint_machine_current_status,
      // v_maint_task_due_dates) → prvo razrešimo dozvoljeni skup machine_code-ova pa
      // ga intersektujemo u where (`machineCode in`), da DB paginacija ostane tačna
      // (paritet 1.0 filterRows, index.js:716-735 — status/rok grupe AND-uju se).
      const codeFilter = await this.machineCodeFilter(tx, query);
      const where: Prisma.MaintMachineWhereInput = {
        ...(query.archived === "true" ? {} : { archivedAt: null }),
        ...(query.source ? { source: query.source } : {}),
        ...(query.location ? { location: query.location } : {}),
        ...(codeFilter ? { machineCode: { in: codeFilter } } : {}),
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

  /**
   * 3.0 parnjak `listMachines()`.
   *
   * 🔴 DVA NEZAVISNA SUŽAVANJA PO ISTOJ KOLONI: filter ekrana (status/rok, izveden
   * iz view-ova) i scope (`machineListWhere`). Spajaju se PRESEKOM, ne spread-om —
   * dva `machineCode: { in: … }` u istom objektu značila bi da drugo pregazi prvo,
   * i to bi u pola slučajeva vratilo mašine koje pozivalac ne sme da vidi.
   */
  private async listMachines30(email: string, query: MachinesQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const scopeCodes = az.machineListWhere(scope)?.machineCode.in;
    const codeFilter = await this.machineCodeFilter30(scope, query);
    const codes =
      codeFilter && scopeCodes
        ? codeFilter.filter((c) => scopeCodes.includes(c))
        : (codeFilter ?? scopeCodes);
    const where: P30.MaintMachineWhereInput = {
      ...(query.archived === "true" ? {} : { archivedAt: null }),
      ...(query.source ? { source: query.source } : {}),
      ...(query.location ? { location: query.location } : {}),
      ...(codes ? { machineCode: { in: codes } } : {}),
      // `auth.uid()` -> `scope.userId` (3.0 `users.id`, Int).
      ...(query.mine === "true" ? { responsibleUserId: scope.userId } : {}),
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
      db.maintMachine.findMany({
        where,
        orderBy: [{ machineCode: "asc" }],
        skip,
        take,
      }),
      db.maintMachine.count({ where }),
    ]);
    const kodovi = rows.map((m) => m.machineCode);
    const [statuses, responsibles] = await Promise.all([
      kodovi.length
        ? db.$queryRaw<{ machine_code: string; status: string }[]>(
            // Skup `kodovi` je već sužen scope-om (dolazi iz `rows`), pa dodatni
            // isečak ovde ne bi ništa promenio — `IN` je uži od njega.
            P30.sql`SELECT machine_code, status
                FROM v_maint_machine_current_status
                WHERE machine_code IN (${P30.join(kodovi)})`,
          )
        : Promise.resolve([]),
      this.resolveProfiles30(
        scope,
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
  }

  /**
   * Kandidati za uvoz iz BigTehn cache (view). Skriveno pravilo 6: default SAKRIVA
   * pomoćne operacije (`no_procedure=true`: Kontrola/Kooperacija… nisu mašine) —
   * paritet 1.0 `no_procedure=is.false` (maintenance.js:1431-1432). `includeNoProcedure=true`
   * prikazuje sve.
   *
   * 🔴 Pod `3.0` NE POSTOJI: `v_maint_machines_importable` čita
   * `bigtehn_machines_cache`, tabelu koja nije `maint_*` i koju 3.0 baza nema
   * (blokada 9 runbook-a). View se NAMERNO ne pravi prazan — prazan view bi tiho
   * nudio nula mašina i izgledao kao „nema kandidata". Zato pada glasno (422).
   */
  async importableMachines(email: string, includeNoProcedure?: boolean) {
    if (this.tri30) return this.tri().fn.importFromCacheNijePreneto();
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        includeNoProcedure
          ? Prisma.sql`SELECT * FROM v_maint_machines_importable ORDER BY machine_code ASC`
          : Prisma.sql`SELECT * FROM v_maint_machines_importable
              WHERE no_procedure IS FALSE ORDER BY machine_code ASC`,
      );
      return { data };
    });
  }

  /** Audit log hard-delete-a (RLS: erp-admin ∨ chief/admin/management). */
  async deletionLog(email: string) {
    if (this.tri30) return this.deletionLog30(email);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintMachineDeletionLog.findMany({
        orderBy: { deletedAt: "desc" },
        take: 200,
      });
      return { data };
    });
  }

  /**
   * 3.0 parnjak. `maint_machines_deletion_log` nema per-red scope — politika je
   * bool (`canReadDeletionLog`). Onome ko nema pravo RLS je vraćao NULA REDOVA,
   * ne grešku, pa i ovde ide prazna lista: 403 bi bio NOVO ponašanje.
   */
  private async deletionLog30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    if (!az.canReadDeletionLog(scope)) return { data: [] };
    const data = await db.maintMachineDeletionLog.findMany({
      orderBy: { deletedAt: "desc" },
      take: 200,
    });
    return { data };
  }

  async findMachine(email: string, code: string) {
    if (this.tri30) return this.findMachine30(email, code);
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

  /**
   * 3.0 parnjak `findMachine()`.
   * ⚠️ Nevidljiva mašina daje ISTU 404 poruku kao nepostojeća — kao pod RLS-om,
   * gde je red naprosto izostao iz rezultata. Poseban 403 bi odao da mašina postoji.
   */
  private async findMachine30(email: string, code: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const machine = az.machineVisible(scope, code)
      ? await db.maintMachine.findUnique({ where: { machineCode: code } })
      : null;
    if (!machine)
      throw new NotFoundException(
        `Mašina ${code} ne postoji ili nije vidljiva`,
      );
    const [statusRows, override, responsibles] = await Promise.all([
      db.$queryRaw<{ status: string }[]>(
        P30.sql`SELECT status FROM v_maint_machine_current_status
            WHERE machine_code = ${code}`,
      ),
      this.activeOverride30(scope, code),
      this.resolveProfiles30(scope, [machine.responsibleUserId]),
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
  }

  async machineStatusOverride(email: string, code: string) {
    if (this.tri30) {
      const scope = await this.scope30(email);
      return { data: await this.activeOverride30(scope, code) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await this.activeOverride(tx, code);
      return { data };
    });
  }

  async machineNotes(email: string, code: string) {
    if (this.tri30) return this.machineNotes30(email, code);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintMachineNote.findMany({
        where: { machineCode: code, deletedAt: null },
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      });
      return { data };
    });
  }

  /**
   * 3.0 parnjak. `machineNotesWhere` nosi `deletedAt: null` jer je soft-delete
   * DEO POLITIKE (`maint_machine_notes` SELECT), a ne deo upita modula — u sy15
   * ga je nosio RLS. Da se izgubi, obrisane napomene bi tiho iskrsle nazad.
   */
  private async machineNotes30(email: string, code: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const data = await db.maintMachineNote.findMany({
      where: {
        AND: [
          { machineCode: code },
          az.machineNotesWhere(scope) as P30.MaintMachineNoteWhereInput,
        ],
      },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    });
    return { data };
  }

  async machineFiles(email: string, code: string) {
    if (this.tri30) return this.machineFiles30(email, code);
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.maintMachineFile.findMany({
        where: { machineCode: code, deletedAt: null },
        orderBy: { uploadedAt: "desc" },
      });
      return { data: rows.map((f) => this.withNumSize(f)) };
    });
  }

  private async machineFiles30(email: string, code: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const rows = await db.maintMachineFile.findMany({
      where: {
        AND: [
          { machineCode: code, deletedAt: null },
          (az.machineScopedWhere(scope) ??
            {}) as P30.MaintMachineFileWhereInput,
        ],
      },
      orderBy: { uploadedAt: "desc" },
    });
    return { data: rows.map((f) => this.withNumSize(f)) };
  }

  /** Šabloni kontrola (preventiva) za mašinu (?machine=) — CRUD je R2 (chief/admin). */
  async listTasks(email: string, machineCode?: string) {
    if (this.tri30) return this.listTasks30(email, machineCode);
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

  private async listTasks30(email: string, machineCode?: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const data = await db.maintTask.findMany({
      where: {
        AND: [
          { active: true, ...(machineCode ? { machineCode } : {}) },
          (az.machineScopedWhere(scope) ?? {}) as P30.MaintTaskWhereInput,
        ],
      },
      orderBy: [{ machineCode: "asc" }, { title: "asc" }],
    });
    return { data };
  }

  async findTask(email: string, id: string) {
    if (this.tri30) return this.findTask30(email, id);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintTask.findUnique({ where: { id } });
      if (!data)
        throw new NotFoundException(`Šablon kontrole ${id} ne postoji`);
      return { data };
    });
  }

  private async findTask30(email: string, id: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const data = await db.maintTask.findFirst({
      where: {
        AND: [
          { id },
          (az.machineScopedWhere(scope) ?? {}) as P30.MaintTaskWhereInput,
        ],
      },
    });
    if (!data) throw new NotFoundException(`Šablon kontrole ${id} ne postoji`);
    return { data };
  }

  /** Due preventiva (view). */
  async tasksDue(email: string) {
    if (this.tri30) return this.tasksDue30(email);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_task_due_dates`,
      );
      return { data };
    });
  }

  private async tasksDue30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const data = await db.$queryRaw(
      P30.sql`SELECT * FROM v_maint_task_due_dates${az.viewWhere(
        az.machineScopeSql(scope),
      )}`,
    );
    return { data };
  }

  /** Urađene kontrole (?machine=) — history. */
  async listChecks(email: string, machineCode?: string) {
    if (this.tri30) return this.listChecks30(email, machineCode);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintCheck.findMany({
        where: machineCode ? { machineCode } : {},
        orderBy: { performedAt: "desc" },
        take: 500,
      });
      return { data };
    });
  }

  private async listChecks30(email: string, machineCode?: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const data = await db.maintCheck.findMany({
      where: {
        AND: [
          machineCode ? { machineCode } : {},
          (az.machineScopedWhere(scope) ?? {}) as P30.MaintCheckWhereInput,
        ],
      },
      orderBy: { performedAt: "desc" },
      take: 500,
    });
    return { data };
  }

  // ==========================================================================
  // Incidenti (kvarovi) — GET (prijava/tok su R2)
  // ==========================================================================

  async listIncidents(email: string, query: IncidentsQuery) {
    if (this.tri30) return this.listIncidents30(email, query);
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

  /**
   * 3.0 parnjak `listIncidents()`.
   * ⚠️ Ugnježđen nalog nosi SVOJ scope (`workOrderListWhere`): vidljiv incident ne
   * znači vidljiv nalog, pa se za nalog ne sme pretpostaviti pravo po roditelju.
   */
  private async listIncidents30(email: string, query: IncidentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const where: P30.MaintIncidentWhereInput = {
      AND: [
        {
          ...(query.status && INCIDENT_STATUSES.has(query.status)
            ? { status: query.status }
            : {}),
          ...(query.severity && INCIDENT_SEVERITIES.has(query.severity)
            ? { severity: query.severity }
            : {}),
          ...(query.machineCode ? { machineCode: query.machineCode } : {}),
        },
        az.incidentListWhere(scope) ?? {},
      ],
    };
    const [rows, total] = await Promise.all([
      db.maintIncident.findMany({
        where,
        orderBy: { reportedAt: "desc" },
        skip,
        take,
      }),
      db.maintIncident.count({ where }),
    ]);
    const woIds = [
      ...new Set(
        rows.map((r) => r.workOrderId).filter((x): x is string => !!x),
      ),
    ];
    const wos = woIds.length
      ? await db.maintWorkOrder.findMany({
          where: {
            AND: [
              { woId: { in: woIds } },
              (az.workOrderListWhere(scope) ??
                {}) as P30.MaintWorkOrderWhereInput,
            ],
          },
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
  }

  async findIncident(email: string, id: string) {
    if (this.tri30) return this.findIncident30(email, id);
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

  private async findIncident30(email: string, id: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const incident = await db.maintIncident.findFirst({
      where: {
        AND: [
          { id },
          (az.incidentListWhere(scope) ?? {}) as P30.MaintIncidentWhereInput,
        ],
      },
    });
    if (!incident)
      throw new NotFoundException(`Kvar ${id} ne postoji ili nije vidljiv`);
    const [events, workOrder] = await Promise.all([
      this.incidentEventsRows30(scope, id),
      incident.workOrderId
        ? db.maintWorkOrder.findFirst({
            where: {
              AND: [
                { woId: incident.workOrderId },
                (az.workOrderListWhere(scope) ??
                  {}) as P30.MaintWorkOrderWhereInput,
              ],
            },
          })
        : Promise.resolve(null),
    ]);
    return { data: { ...incident, events, workOrder } };
  }

  async incidentEvents(email: string, id: string) {
    if (this.tri30) {
      const scope = await this.scope30(email);
      return { data: await this.incidentEventsRows30(scope, id) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintIncidentEvent.findMany({
        where: { incidentId: id },
        orderBy: { at: "asc" },
      });
      return { data };
    });
  }

  /**
   * Trag na prijavi kvara pod 3.0 scope-om.
   *
   * 🔴 ASIMETRIJA KOJU JE LAKO PROMAŠITI: `maint_incident_events` politika gleda
   * `maint_machine_visible(i.machine_code)`, a NE `maint_incident_row_visible`.
   * Zato ovde ide `incidentEventWhere`, ne `incidentListWhere` — prepis „po
   * analogiji sa incidentima" bi TIHO proširio prava (trag kvara na vozilu/IT/
   * objektu postao bi vidljiv onome ko sredstvo ne vidi). Ostavljeno doslovno,
   * uključujući i posledicu da za neke incidente lista traga bude prazna.
   */
  private async incidentEventsRows30(scope: MaintScope, id: string) {
    const { db, az } = this.tri();
    return db.maintIncidentEvent.findMany({
      where: {
        AND: [
          { incidentId: id },
          (az.incidentEventWhere(scope) ??
            {}) as P30.MaintIncidentEventWhereInput,
        ],
      },
      orderBy: { at: "asc" },
    });
  }

  // ==========================================================================
  // Radni nalozi (WO) — kanban lista + detalj read
  // ==========================================================================

  async listWorkOrders(email: string, query: WorkOrdersQuery) {
    if (this.tri30) return this.listWorkOrders30(email, query);
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const statusFilter = this.woStatusFilter(query);
    return this.withUserMapped(email, async (tx) => {
      // Pretraga (q) uključuje sredstvo (asset_code/name) koje je u maint_assets, ne u
      // maint_work_orders → prvo razrešimo asset_id-eve koji matchuju pa OR-ujemo
      // (paritet 1.0 index.js:168-174; DB paginacija ostaje tačna).
      const qTerm = query.q?.trim();
      let assetIdMatches: string[] | undefined;
      if (qTerm) {
        const assets = await tx.maintAsset.findMany({
          where: {
            OR: [
              { assetCode: { contains: qTerm, mode: "insensitive" } },
              { name: { contains: qTerm, mode: "insensitive" } },
            ],
          },
          select: { assetId: true },
          take: 500,
        });
        assetIdMatches = assets.map((a) => a.assetId);
      }
      // Skriveno pravilo #8: „Samo otvoreni" je ON po defaultu (1.0
      // maintWorkOrdersPanel.js:128 `open !== '0'`) → BE default ON, isključuje se
      // eksplicitno `openOnly=false`. Bez ovoga bi kanban po defaultu prikazao i
      // zavrsen/otkazan (regresija pariteta).
      const openOnly = query.openOnly !== "false";
      const overdue = query.overdue === "true";
      // `status` se javlja u DVE nezavisne dimenzije (group/status filter = `in`, a
      // openOnly/overdue = `notIn`) → AND array, da druga NE pregazi prvu (obe AND-uju,
      // paritet 1.0 gde su filteri nezavisni; kontradikcija = prazan skup).
      const statusConds: Prisma.MaintWorkOrderWhereInput[] = [];
      if (statusFilter)
        statusConds.push({ status: { in: statusFilter as never[] } });
      if (openOnly || overdue)
        statusConds.push({
          status: { notIn: ["zavrsen", "otkazan"] as never[] },
        });
      const where: Prisma.MaintWorkOrderWhereInput = {
        ...(statusConds.length ? { AND: statusConds } : {}),
        ...(query.priority && WO_PRIORITIES.has(query.priority)
          ? { priority: query.priority as never }
          : {}),
        ...(query.type && WO_TYPES.has(query.type)
          ? { type: query.type as never }
          : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.mine === "true" ? { assignedTo: await this.uid(tx) } : {}),
        // overdue traži i due_at < now (index.js:162-167).
        ...(overdue ? { dueAt: { lt: new Date() } } : {}),
        ...(qTerm
          ? {
              OR: [
                { woNumber: { contains: qTerm, mode: "insensitive" } },
                { title: { contains: qTerm, mode: "insensitive" } },
                { description: { contains: qTerm, mode: "insensitive" } },
                ...(assetIdMatches && assetIdMatches.length
                  ? [{ assetId: { in: assetIdMatches } }]
                  : []),
              ],
            }
          : {}),
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
      // WO ↔ sredstvo (H4): kanban/lista mora znati za koje je sredstvo nalog
      // (šifra · naziv; maintWorkOrdersPanel.js:206-220). Batch-resolve iz maint_assets.
      const [assetMap, partsByWo] = await Promise.all([
        this.resolveAssets(
          tx,
          rows.map((w) => w.assetId),
        ),
        // Trošak na redu liste: bez ovoga se cena vidi tek kad se otvori nalog.
        this.partsCostByWo(
          tx,
          rows.map((w) => w.woId),
        ),
      ]);
      const data = rows.map((w) => {
        const partsCost = partsByWo.get(w.woId) ?? 0;
        return {
          ...w,
          group: WO_GROUP[w.status] ?? null,
          asset: assetMap.get(w.assetId) ?? null,
          partsCost,
          effectiveCost: this.effectiveWoCost(partsCost, w.costTotal),
        };
      });
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Kanban grupa → spisak statusa (jedan izvor za oba izvora podataka). */
  private woStatusFilter(query: WorkOrdersQuery): string[] | undefined {
    return query.group && WO_STATUSES_BY_GROUP[query.group]
      ? WO_STATUSES_BY_GROUP[query.group]
      : query.status && WO_STATUSES.has(query.status)
        ? [query.status]
        : undefined;
  }

  /**
   * 3.0 parnjak `listWorkOrders()`.
   *
   * 🔴 `workOrderListWhere` NIJE isto što i `assetScopedWhere`: politika
   * `maint_wo_row_visible` ima disjunkciju „moj nalog je uvek moj" (dodeljeni i
   * prijavilac vide nalog i kad sredstvo ne vide). Bez nje bi operater izgubio iz
   * vida nalog koji je sam prijavio na tuđoj mašini.
   *
   * ⚠️ Ceo `where` je AND-lista: `OR` iz pretrage (q) i `OR` iz scope-a ne smeju
   * da dele isti ključ, inače bi jedan pregazio drugi.
   */
  private async listWorkOrders30(email: string, query: WorkOrdersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const statusFilter = this.woStatusFilter(query);
    const qTerm = query.q?.trim();
    let assetIdMatches: string[] | undefined;
    if (qTerm) {
      // I pomoćni upit nad `maint_assets` nosi scope: bez njega bi pretraga po
      // nazivu sredstva „provukla" asset_id tuđe mašine u glavni `OR`.
      const assets = await db.maintAsset.findMany({
        where: {
          AND: [
            {
              OR: [
                { assetCode: { contains: qTerm, mode: "insensitive" } },
                { name: { contains: qTerm, mode: "insensitive" } },
              ],
            },
            (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
          ],
        },
        select: { assetId: true },
        take: 500,
      });
      assetIdMatches = assets.map((a) => a.assetId);
    }
    const openOnly = query.openOnly !== "false";
    const overdue = query.overdue === "true";
    const uslovi: P30.MaintWorkOrderWhereInput[] = [];
    if (statusFilter) uslovi.push({ status: { in: statusFilter } });
    if (openOnly || overdue)
      uslovi.push({ status: { notIn: ["zavrsen", "otkazan"] } });
    if (query.priority && WO_PRIORITIES.has(query.priority))
      uslovi.push({ priority: query.priority });
    if (query.type && WO_TYPES.has(query.type))
      uslovi.push({ type: query.type });
    if (query.assetId) uslovi.push({ assetId: query.assetId });
    if (query.mine === "true") uslovi.push({ assignedTo: scope.userId });
    if (overdue) uslovi.push({ dueAt: { lt: new Date() } });
    if (qTerm)
      uslovi.push({
        OR: [
          { woNumber: { contains: qTerm, mode: "insensitive" } },
          { title: { contains: qTerm, mode: "insensitive" } },
          { description: { contains: qTerm, mode: "insensitive" } },
          ...(assetIdMatches && assetIdMatches.length
            ? [{ assetId: { in: assetIdMatches } }]
            : []),
        ],
      });
    uslovi.push(az.workOrderListWhere(scope) ?? {});
    const where: P30.MaintWorkOrderWhereInput = { AND: uslovi };
    const [rows, total] = await Promise.all([
      db.maintWorkOrder.findMany({
        where,
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
        skip,
        take,
      }),
      db.maintWorkOrder.count({ where }),
    ]);
    const [assetMap, partsByWo] = await Promise.all([
      this.resolveAssets30(
        scope,
        rows.map((w) => w.assetId),
      ),
      this.partsCostByWo30(
        scope,
        rows.map((w) => w.woId),
      ),
    ]);
    const data = rows.map((w) => {
      const partsCost = partsByWo.get(w.woId) ?? 0;
      return {
        ...w,
        group: WO_GROUP[w.status] ?? null,
        asset: assetMap.get(w.assetId) ?? null,
        partsCost,
        effectiveCost: this.effectiveWoCost(partsCost, w.costTotal),
      };
    });
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** Dropdown dodele (RPC — SECURITY DEFINER, samo aktivni operator/technician/chief/admin). */
  async assignableUsers(email: string) {
    if (this.tri30) {
      // DEFINER fn nije imala role-guard (svako ulogovan je smeo da povuče
      // spisak) — prepis to prati doslovno, `OdrzavanjeFnService.assignableUsers`.
      return { data: await this.tri().fn.assignableUsers() };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM public.maint_assignable_users()`,
      );
      return { data };
    });
  }

  async findWorkOrder(email: string, id: string) {
    if (this.tri30) return this.findWorkOrder30(email, id);
    return this.withUserMapped(email, async (tx) => {
      const wo = await tx.maintWorkOrder.findUnique({ where: { woId: id } });
      if (!wo)
        throw new NotFoundException(
          `Radni nalog ${id} ne postoji ili nije vidljiv`,
        );
      const [events, parts, labor, assetMap] = await Promise.all([
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
        this.resolveAssets(tx, [wo.assetId]),
      ]);
      // Detalj prikazuje „šifra · naziv" sredstva + linkove „Otvori mašinu/incident"
      // (maintWorkOrdersPanel.js:513-525). `sourceIncidentId` je već na wo redu (link
      // „Otvori incident"); `asset.assetCode` == machine_code za mašine (link „Otvori mašinu").
      return {
        data: {
          ...wo,
          group: WO_GROUP[wo.status] ?? null,
          asset: assetMap.get(wo.assetId) ?? null,
          incidentId: wo.sourceIncidentId ?? null,
          events,
          parts,
          labor,
        },
      };
    });
  }

  private async findWorkOrder30(email: string, id: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const woScope = (az.workOrderListWhere(scope) ??
      {}) as P30.MaintWorkOrderWhereInput;
    const wo = await db.maintWorkOrder.findFirst({
      where: { AND: [{ woId: id }, woScope] },
    });
    if (!wo)
      throw new NotFoundException(
        `Radni nalog ${id} ne postoji ili nije vidljiv`,
      );
    const [events, parts, labor, assetMap] = await Promise.all([
      this.woEventsRows30(scope, id),
      this.woPartsRows30(scope, id),
      this.woLaborRows30(scope, id),
      this.resolveAssets30(scope, [wo.assetId]),
    ]);
    return {
      data: {
        ...wo,
        group: WO_GROUP[wo.status] ?? null,
        // Sredstvo se razrešava POD SVOJIM scope-om: „moj nalog je uvek moj" daje
        // pravo na NALOG, ne i na karticu sredstva — zato ovde sme da bude `null`.
        asset: assetMap.get(wo.assetId) ?? null,
        incidentId: wo.sourceIncidentId ?? null,
        events,
        parts,
        labor,
      },
    };
  }

  async woEvents(email: string, id: string) {
    if (this.tri30) {
      const scope = await this.scope30(email);
      return { data: await this.woEventsRows30(scope, id) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoEvent.findMany({
        where: { woId: id },
        orderBy: { at: "asc" },
      });
      return { data };
    });
  }

  async woParts(email: string, id: string) {
    if (this.tri30) {
      const scope = await this.scope30(email);
      return { data: await this.woPartsRows30(scope, id) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoPart.findMany({
        where: { woId: id },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  async woLabor(email: string, id: string) {
    if (this.tri30) {
      const scope = await this.scope30(email);
      return { data: await this.woLaborRows30(scope, id) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintWoLabor.findMany({
        where: { woId: id },
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  // Deca naloga (`maint_wo_events` / `maint_wo_parts` / `maint_wo_labor`) imaju u
  // sy15 politiku `EXISTS (… maint_wo_row_visible …)` — dakle scope RODITELJA, ne
  // svoj. `woChildWhere` je taj isečak; bez njega bi trag rada i utrošeni delovi
  // tuđeg naloga bili čitljivi svakome ko pogodi `wo_id`.

  private async woEventsRows30(scope: MaintScope, id: string) {
    const { db, az } = this.tri();
    return db.maintWoEvent.findMany({
      where: {
        AND: [
          { woId: id },
          (az.woChildWhere(scope) ?? {}) as P30.MaintWoEventWhereInput,
        ],
      },
      orderBy: { at: "asc" },
    });
  }

  private async woPartsRows30(scope: MaintScope, id: string) {
    const { db, az } = this.tri();
    return db.maintWoPart.findMany({
      where: {
        AND: [
          { woId: id },
          (az.woChildWhere(scope) ?? {}) as P30.MaintWoPartWhereInput,
        ],
      },
      orderBy: { createdAt: "asc" },
    });
  }

  private async woLaborRows30(scope: MaintScope, id: string) {
    const { db, az } = this.tri();
    return db.maintWoLabor.findMany({
      where: {
        AND: [
          { woId: id },
          (az.woChildWhere(scope) ?? {}) as P30.MaintWoLaborWhereInput,
        ],
      },
      orderBy: { createdAt: "asc" },
    });
  }

  // ==========================================================================
  // Vozila / Vozači (spec §4.5)
  // ==========================================================================

  async listVehicles(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_vehicle_overview${az.viewWhere(
            az.nonMachineViewScopeSql(scope),
          )}`,
        ),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_overview`,
      );
      return { data };
    });
  }

  async findVehicle(email: string, assetId: string) {
    if (this.tri30) return this.findVehicle30(email, assetId);
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

  private async findVehicle30(email: string, assetId: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const asset = await db.maintAsset.findFirst({
      where: {
        AND: [
          { assetId, assetType: "vehicle" },
          (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
        ],
      },
    });
    if (!asset)
      throw new NotFoundException(
        `Vozilo ${assetId} ne postoji ili nije vidljivo`,
      );
    // Detalji vise o sredstvu (`maint_asset_visible`) koje je gore već provereno.
    const details = await db.maintVehicleDetails.findUnique({
      where: { assetId },
    });
    // ⚠️ `maint_vehicle_owners_select` je u sy15 doslovno `true` — vlasnike vozila
    // vide SVI ulogovani. Prepis to prati; sužavanje bi bilo NOVO pravilo.
    const owner = details?.ownerId
      ? await db.maintVehicleOwner.findUnique({
          where: { ownerId: details.ownerId },
        })
      : null;
    return { data: { ...asset, details, owner } };
  }

  async vehicleTires(email: string, assetId: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.maintVehicleTire.findMany({
          where: {
            AND: [
              { assetId },
              (az.assetScopedWhere(scope) ??
                {}) as P30.MaintVehicleTireWhereInput,
            ],
          },
          orderBy: { createdAt: "desc" },
        }),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintVehicleTire.findMany({
        where: { assetId },
        orderBy: { createdAt: "desc" },
      });
      return { data };
    });
  }

  /**
   * Servisni plan vozila sa RAČUNATIM „due" kolonama (next_due_at/due_status/km_to_due/
   * has_open_wo/open_wo_id) — čita `v_maint_vehicle_service_plan_due` umesto sirove tabele
   * (paritet 1.0 fetchMaintVehicleServicePlan, maintenance.js:2606-2611; sortiran po
   * due_status pa next_due_at nulls last). View je security_invoker → RLS pozivaoca važi.
   */
  async vehicleServicePlan(email: string, assetId: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const data = await db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_vehicle_service_plan_due${az.viewWhere(
          this.andSql(
            P30.sql`asset_id = ${assetId}::uuid`,
            az.nonMachineViewScopeSql(scope),
          ),
        )}
          ORDER BY due_status ASC, next_due_at ASC NULLS LAST`,
      );
      return { data: this.numRows(data) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_service_plan_due
          WHERE asset_id = ${assetId}::uuid
          ORDER BY due_status ASC, next_due_at ASC NULLS LAST`,
      );
      return { data: this.numRows(data) };
    });
  }

  async vehicleParts(email: string, assetId: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      // Dva nezavisna kruga: magacin delova (`maint_parts_select`) I sredstvo
      // (vozilo). Ko ne sme u magacin ne sme ni ovde, i obrnuto — zato AND.
      const data = await db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_vehicle_parts${az.viewWhere(
          this.andSql(
            P30.sql`asset_id = ${assetId}::uuid`,
            az.partsViewScopeSql(scope),
            az.nonMachineViewScopeSql(scope),
          ),
        )}`,
      );
      return { data };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_parts WHERE asset_id = ${assetId}::uuid`,
      );
      return { data };
    });
  }

  async vehicleBookings(email: string, assetId: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const data = await db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_vehicle_bookings${az.viewWhere(
          this.andSql(
            P30.sql`asset_id = ${assetId}::uuid`,
            az.nonMachineViewScopeSql(scope),
          ),
        )}`,
      );
      return { data };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_bookings WHERE asset_id = ${assetId}::uuid`,
      );
      return { data };
    });
  }

  async vehicleServicePlanDue(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_vehicle_service_plan_due${az.viewWhere(
            az.nonMachineViewScopeSql(scope),
          )}`,
        ),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_vehicle_service_plan_due`,
      );
      return { data };
    });
  }

  async vehicleOwners(email: string) {
    if (this.tri30) {
      const { db } = this.tri();
      // Scope-a NEMA i to je izmereno: `maint_vehicle_owners_select` = `true`.
      // Ipak prolazi kroz `scope30` da nepoznat nalog ne prođe kroz modul.
      await this.scope30(email);
      return {
        data: await db.maintVehicleOwner.findMany({
          where: { active: true },
          orderBy: { name: "asc" },
        }),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintVehicleOwner.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
      });
      return { data };
    });
  }

  async listDrivers(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      // 🔴 `driversViewScopeSql` ima PER-RED granu (`auth_user_id = ja`): vozač bez
      // ijedne rangirane role vidi SVOJ karton, i ništa više. Zamena bool gejtom
      // bi ga ili zaključala ili mu otvorila tuđe lične podatke (JMBG, adresa).
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_drivers_overview${az.viewWhere(
            az.driversViewScopeSql(scope),
          )}`,
        ),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_drivers_overview`,
      );
      return { data };
    });
  }

  /** Karton vozača (PII — bez maskiranja; RLS krug §2.2 odlučuje ko vidi). */
  async findDriver(email: string, id: string) {
    if (this.tri30) return this.findDriver30(email, id);
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

  private async findDriver30(email: string, id: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const driver = await db.maintDriver.findFirst({
      where: {
        AND: [
          { driverId: id },
          (az.driverListWhere(scope) ?? {}) as P30.MaintDriverWhereInput,
        ],
      },
    });
    if (!driver)
      throw new NotFoundException(`Vozač ${id} ne postoji ili nije vidljiv`);
    const documents = await db.maintDocument.findMany({
      where: {
        AND: [
          { driverId: id, deletedAt: null },
          (az.documentListWhere(scope) ?? {}) as P30.MaintDocumentWhereInput,
        ],
      },
      orderBy: { uploadedAt: "desc" },
    });
    return {
      data: {
        ...driver,
        documents: documents.map((d) => this.withNumSize(d)),
      },
    };
  }

  // ==========================================================================
  // IT oprema / Objekti / Sredstva (spec §4.6)
  // ==========================================================================

  async listItAssets(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_it_overview${az.viewWhere(
            az.nonMachineViewScopeSql(scope),
          )}`,
        ),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_it_overview`,
      );
      return { data };
    });
  }

  async listFacilities(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_facility_overview${az.viewWhere(
            az.nonMachineViewScopeSql(scope),
          )}`,
        ),
      };
    }
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
    if (this.tri30) return this.assetCard30(email, assetId, type);
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

  /**
   * 3.0 parnjak kartice IT/objekta.
   * ⚠️ Tehničar (`M ∧ ¬N`) ovde legitimno dobija 404: `assetListWhere` mu daje
   * `{ assetType: 'machine' }`, pa IT/objekat naprosto nije u njegovom skupu —
   * isto što je radio RLS. To NIJE kvar i ne treba ga „popravljati" proširenjem.
   */
  private async assetCard30(
    email: string,
    assetId: string,
    type: "it" | "facility",
  ) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const asset = await db.maintAsset.findFirst({
      where: {
        AND: [
          { assetId, assetType: type },
          (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
        ],
      },
    });
    if (!asset)
      throw new NotFoundException(
        `Sredstvo ${assetId} ne postoji ili nije vidljivo`,
      );
    const details =
      type === "it"
        ? await db.maintItAssetDetails.findUnique({ where: { assetId } })
        : await db.maintFacilityDetails.findUnique({ where: { assetId } });
    const servicePlan = await db.maintAssetServicePlan.findMany({
      where: { assetId },
      orderBy: { createdAt: "asc" },
    });
    return { data: { ...asset, details, servicePlan } };
  }

  /** Picker/registar sredstava (maint_assets) — filter po tipu/aktivnosti. */
  async listAssets(email: string, type?: string, activeOnly?: boolean) {
    if (this.tri30) return this.listAssets30(email, type, activeOnly);
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

  /**
   * 3.0 parnjak. `assetListWhere` i sam ume da nosi `assetType` (tehničar dobija
   * `{ assetType: 'machine' }`), pa se sa filterom ekrana spaja kroz `AND` —
   * spread bi jedan od ta dva TIHO obrisao.
   */
  private async listAssets30(
    email: string,
    type?: string,
    activeOnly?: boolean,
  ) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const validType =
      type && ["machine", "vehicle", "it", "facility"].includes(type)
        ? type
        : undefined;
    const data = await db.maintAsset.findMany({
      where: {
        AND: [
          {
            ...(validType ? { assetType: validType } : {}),
            ...(activeOnly ? { archivedAt: null } : {}),
          },
          (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
        ],
      },
      orderBy: [{ assetType: "asc" }, { name: "asc" }],
      take: 1000,
    });
    return { data };
  }

  /**
   * Servisni plan IT/objekta sa RAČUNATIM „due" kolonama — čita
   * `v_maint_asset_service_plan_due` umesto sirove tabele (paritet 1.0
   * fetchMaintAssetServicePlan, maintenance.js:2696-2701). View je security_invoker.
   */
  async assetServicePlan(email: string, assetId: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const data = await db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_asset_service_plan_due${az.viewWhere(
          this.andSql(
            P30.sql`asset_id = ${assetId}::uuid`,
            this.assetTipViewScopeSql(scope),
          ),
        )}
          ORDER BY due_status ASC, next_due_at ASC NULLS LAST`,
      );
      return { data: this.numRows(data) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_maint_asset_service_plan_due
          WHERE asset_id = ${assetId}::uuid
          ORDER BY due_status ASC, next_due_at ASC NULLS LAST`,
      );
      return { data: this.numRows(data) };
    });
  }

  async assetServicePlanDue(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      return {
        data: await db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_asset_service_plan_due${az.viewWhere(
            this.assetTipViewScopeSql(scope),
          )}`,
        ),
      };
    }
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
    if (this.tri30) return this.calendarDeadlines30(email);
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

  /**
   * 3.0 parnjak kalendara — četiri view-a, četiri isečka.
   * ⚠️ Plan sredstva ide kroz `assetTipViewScopeSql` (view nabraja SVE tipove), a
   * ostala tri kroz `nonMachineViewScopeSql` (vraćaju samo ne-mašinska sredstva).
   */
  private async calendarDeadlines30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const neMasine = az.nonMachineViewScopeSql(scope);
    const dospelo = P30.sql`due_status IN ('overdue','due_soon')`;
    const [vehicleServiceDue, assetServiceDue, itAssets, facilities] =
      await Promise.all([
        db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_vehicle_service_plan_due${az.viewWhere(
            this.andSql(dospelo, neMasine),
          )}`,
        ),
        db.$queryRaw(
          P30.sql`SELECT * FROM v_maint_asset_service_plan_due${az.viewWhere(
            this.andSql(dospelo, this.assetTipViewScopeSql(scope)),
          )}`,
        ),
        db.$queryRaw(
          P30.sql`SELECT asset_id, asset_code, name, license_expires_at, warranty_expires_at
              FROM v_maint_it_overview${az.viewWhere(
                this.andSql(
                  P30.sql`archived_at IS NULL
                AND (license_expires_at IS NOT NULL OR warranty_expires_at IS NOT NULL)`,
                  neMasine,
                ),
              )}`,
        ),
        db.$queryRaw(
          P30.sql`SELECT asset_id, asset_code, name, inspection_due_at, fire_safety_due_at
              FROM v_maint_facility_overview${az.viewWhere(
                this.andSql(
                  P30.sql`archived_at IS NULL
                AND (inspection_due_at IS NOT NULL OR fire_safety_due_at IS NOT NULL)`,
                  neMasine,
                ),
              )}`,
        ),
      ]);
    return {
      data: { vehicleServiceDue, assetServiceDue, itAssets, facilities },
    };
  }

  // ==========================================================================
  // Zalihe / dobavljači / lokacije (spec §4.8)
  // ==========================================================================

  async listParts(email: string, query: PartsQuery) {
    if (this.tri30) return this.listParts30(email, query);
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
      // „Ispod minimuma" = current_stock <= min_stock (kolona-na-kolonu; Prisma where to
      // ne može) → razreši part_id-eve raw upitom pa `in` (paritet 1.0 lowOnly,
      // maintInventoryPanel.js:308 — `<=`, ne `<`; paginacija ostaje tačna).
      let lowIds: string[] | undefined;
      if (query.lowStock === "true") {
        const rows = await tx.$queryRaw<{ part_id: string }[]>(
          Prisma.sql`SELECT part_id FROM maint_parts WHERE current_stock <= min_stock`,
        );
        lowIds = rows.map((r) => r.part_id);
      }
      const where: Prisma.MaintPartWhereInput = {
        // Default samo aktivni; includeInactive=true prikazuje i deaktivirane (paritet
        // 1.0 „prikaži neaktivne"). Neaktivan deo inače zauvek nevidljiv (audit §5).
        ...(query.includeInactive === "true" ? {} : { active: true }),
        ...(lowIds ? { partId: { in: lowIds } } : {}),
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

  /**
   * 3.0 parnjak `listParts()`.
   *
   * 🔴 `maint_parts_select` NEMA per-red scope — pravilo je „ceo magacin ili
   * ništa" (`canReadStock`). Ko nema pravo, pod RLS-om je dobijao NULA REDOVA (ne
   * 403), pa i ovde ide prazna strana sa `total = 0`. Da se umesto toga vrati
   * puna lista, procenjena vrednost zaliha cele firme bila bi vidljiva svakome.
   */
  private async listParts30(email: string, query: PartsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    if (query.vehicleId) {
      const vid = query.vehicleId;
      if (!UUID_RE.test(vid)) return { data: [] };
      const asset = await db.maintAsset.findFirst({
        where: {
          AND: [
            { assetId: vid, assetType: "vehicle" },
            (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
          ],
        },
        select: { assetCode: true },
      });
      if (!asset) return { data: [] };
      const data = await db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_parts_with_vehicles${az.viewWhere(
          this.andSql(
            P30.sql`${asset.assetCode} = ANY(vehicle_codes)`,
            az.partsViewScopeSql(scope),
          ),
        )}`,
      );
      return { data };
    }
    if (!az.canReadStock(scope)) {
      return { data: [], meta: pageMeta(page, pageSize, 0) };
    }
    let lowIds: string[] | undefined;
    if (query.lowStock === "true") {
      const rows = await db.$queryRaw<{ part_id: string }[]>(
        P30.sql`SELECT part_id FROM maint_parts WHERE current_stock <= min_stock`,
      );
      lowIds = rows.map((r) => r.part_id);
    }
    const where: P30.MaintPartWhereInput = {
      ...(query.includeInactive === "true" ? {} : { active: true }),
      ...(lowIds ? { partId: { in: lowIds } } : {}),
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
      db.maintPart.findMany({
        where,
        orderBy: { partCode: "asc" },
        skip,
        take,
      }),
      db.maintPart.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findPart(email: string, id: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const data = az.canReadStock(scope)
        ? await db.maintPart.findUnique({ where: { partId: id } })
        : null;
      if (!data)
        throw new NotFoundException(`Deo ${id} ne postoji ili nije vidljiv`);
      return { data };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintPart.findUnique({ where: { partId: id } });
      if (!data)
        throw new NotFoundException(`Deo ${id} ne postoji ili nije vidljiv`);
      return { data };
    });
  }

  async partStockMovements(email: string, id: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      if (!az.canReadStock(scope)) return { data: [] };
      return {
        data: await db.maintPartStockMovement.findMany({
          where: { partId: id },
          orderBy: { createdAt: "desc" },
          take: 500,
        }),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintPartStockMovement.findMany({
        where: { partId: id },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      return { data };
    });
  }

  /**
   * Dobavljači. `active` param (ne hardkodovano true — audit §5): izostavljeno/'true' =
   * samo aktivni (default, paritet 1.0); 'all' = svi; 'false' = samo neaktivni. Bez ovoga
   * su deaktivirani dobavljači zauvek nevidljivi.
   */
  async listSuppliers(email: string, active?: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      if (!az.canReadStock(scope)) return { data: [] };
      return {
        data: await db.maintSupplier.findMany({
          where: this.supplierWhere(active),
          orderBy: { name: "asc" },
        }),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintSupplier.findMany({
        where: this.supplierWhere(active),
        orderBy: { name: "asc" },
      });
      return { data };
    });
  }

  /** `active` param → where (jedan izvor za oba izvora podataka). */
  private supplierWhere(active?: string): { active?: boolean } {
    if (active === "all") return {};
    if (active === "false") return { active: false };
    return { active: true };
  }

  /** CMMS interna hijerarhija lokacija (≠ loc_locations). */
  async listLocations(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      // `maint_locations_select` deli krug sa magacinom (`canReadStock`) — mereno
      // sa `pg_policies`, nije izvedeno „po logici".
      if (!az.canReadStock(scope)) return { data: [] };
      return {
        data: await db.maintLocation.findMany({
          where: { active: true },
          orderBy: [{ locationType: "asc" }, { name: "asc" }],
        }),
      };
    }
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
    if (this.tri30) return this.listDocuments30(email, query);
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const validEntity = this.validEntityType(query.entityType);
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintDocumentWhereInput = {
        deletedAt: null,
        ...(validEntity ? { entityType: validEntity as never } : {}),
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

  private validEntityType(v?: string): string | undefined {
    return v &&
      ["asset", "work_order", "incident", "preventive_task", "driver"].includes(
        v,
      )
      ? v
      : undefined;
  }

  /**
   * 3.0 parnjak `listDocuments()`. `documentListWhere` je KASKADA po tome koji je
   * FK popunjen (sredstvo → nalog → incident → preventivni zadatak → vozač), sa
   * `ELSE FALSE` na kraju: dokument bez ijedne veze se NE VIDI. Zato se dokumenta
   * ne smeju svesti na „scope sredstva" — pola njih visi o nalogu ili vozaču.
   */
  private async listDocuments30(email: string, query: DocumentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const validEntity = this.validEntityType(query.entityType);
    const where: P30.MaintDocumentWhereInput = {
      AND: [
        {
          deletedAt: null,
          ...(validEntity ? { entityType: validEntity } : {}),
          ...(query.assetId ? { assetId: query.assetId } : {}),
          ...(query.woId ? { woId: query.woId } : {}),
          ...(query.incidentId ? { incidentId: query.incidentId } : {}),
          ...(query.driverId ? { driverId: query.driverId } : {}),
        },
        az.documentListWhere(scope) ?? {},
      ],
    };
    const [rows, total] = await Promise.all([
      db.maintDocument.findMany({
        where,
        orderBy: { uploadedAt: "desc" },
        skip,
        take,
      }),
      db.maintDocument.count({ where }),
    ]);
    return {
      data: rows.map((d) => this.withNumSize(d)),
      meta: pageMeta(page, pageSize, total),
    };
  }

  async findDocument(email: string, id: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const doc = await db.maintDocument.findFirst({
        where: {
          AND: [
            { documentId: id },
            (az.documentListWhere(scope) ?? {}) as P30.MaintDocumentWhereInput,
          ],
        },
      });
      if (!doc)
        throw new NotFoundException(
          `Dokument ${id} ne postoji ili nije vidljiv`,
        );
      return { data: this.withNumSize(doc) };
    }
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
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      // 🔴 `maint_settings_select` NE SADRŽI profil `management` — zatečena
      // nedoslednost sy15, prenosi se doslovno (popravka je odluka o proizvodu).
      if (!az.canReadSettings(scope)) return { data: null };
      return { data: await db.maintSettings.findUnique({ where: { id: 1 } }) };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintSettings.findUnique({ where: { id: 1 } });
      return { data };
    });
  }

  async notificationRules(email: string) {
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      // ⚠️ ŠIRE od `canReadNotificationLog`: magacioner vidi PRAVILA, ali ne outbox.
      if (!az.canReadNotificationRules(scope)) return { data: [] };
      return {
        data: await db.maintNotificationRule.findMany({
          orderBy: { createdAt: "asc" },
        }),
      };
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.maintNotificationRule.findMany({
        orderBy: { createdAt: "asc" },
      });
      return { data };
    });
  }

  /** Outbox log (RLS: erp-admin ∨ chief/management/admin) + filteri. */
  async notifications(email: string, query: NotificationsQuery) {
    if (this.tri30) return this.notifications30(email, query);
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
        // Filter po incidentu = related_entity_id (paritet 1.0 maintenance.js:1600).
        ...(query.incidentId ? { relatedEntityId: query.incidentId } : {}),
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

  private async notifications30(email: string, query: NotificationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    // ⚠️ Ovde NIJE `erp_admin_or_management` — magacioner NE vidi outbox
    // (poruke nose imena i telefone primalaca).
    if (!az.canReadNotificationLog(scope)) {
      return { data: [], meta: pageMeta(page, pageSize, 0) };
    }
    const where: P30.MaintNotificationLogWhereInput = {
      ...(query.status && NOTIF_STATUSES.has(query.status)
        ? { status: query.status }
        : {}),
      ...(query.machineCode ? { machineCode: query.machineCode } : {}),
      ...(query.incidentId ? { relatedEntityId: query.incidentId } : {}),
    };
    const [data, total] = await Promise.all([
      db.maintNotificationLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      db.maintNotificationLog.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
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
    if (this.tri30) {
      const { db, az } = this.tri();
      const scope = await this.scope30(email);
      const rows = await db.maintIncident.findMany({
        where: {
          AND: [
            days ? { reportedAt: { gte: this.sinceDate(days) } } : {},
            (az.incidentListWhere(scope) ?? {}) as P30.MaintIncidentWhereInput,
          ],
        },
      });
      return { data: this.incidentReportData(rows, days) };
    }
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintIncidentWhereInput = days
        ? { reportedAt: { gte: this.sinceDate(days) } }
        : {};
      const rows = await tx.maintIncident.findMany({ where });
      return { data: this.incidentReportData(rows, days) };
    });
  }

  /** Agregacija izveštaja o kvarovima — jedan izvor za oba izvora podataka. */
  private incidentReportData(
    rows: {
      severity: string;
      status: string;
      downtimeMinutes: number | null;
    }[],
    days: number | null,
  ) {
    return {
      total: rows.length,
      bySeverity: this.countBy(rows, (r) => r.severity),
      byStatus: this.countBy(rows, (r) => r.status),
      downtimeMinutes: rows.reduce((a, r) => a + (r.downtimeMinutes ?? 0), 0),
      period: days ? `${days}d` : "all",
    };
  }

  /**
   * Zbir stavki „Delovi" po nalogu: Σ(quantity × (wo_parts.unit_cost ?? maint_parts.unit_cost)).
   * Jedan izvor istine — koriste ga i lista naloga i izveštaj, da isti nalog ne bi
   * pokazivao dva različita iznosa na dva ekrana.
   */
  private async partsCostByWo(
    tx: Sy15Tx,
    woIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!woIds.length) return out;
    const parts = await tx.maintWoPart.findMany({
      where: { woId: { in: woIds } },
      select: { woId: true, partId: true, quantity: true, unitCost: true },
    });
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
    return this.sumPartsCost(parts, catalogCost, out);
  }

  /** Zbrajanje stavki — deljeno između sy15 i 3.0 grane. */
  private sumPartsCost(
    parts: {
      woId: string;
      partId: string | null;
      quantity: Prisma.Decimal | null;
      unitCost: Prisma.Decimal | null;
    }[],
    catalogCost: Map<string, number>,
    out: Map<string, number>,
  ): Map<string, number> {
    for (const p of parts) {
      const unit =
        p.unitCost != null
          ? Number(p.unitCost)
          : p.partId
            ? (catalogCost.get(p.partId) ?? 0)
            : 0;
      out.set(p.woId, (out.get(p.woId) ?? 0) + Number(p.quantity ?? 0) * unit);
    }
    return out;
  }

  /**
   * Trošak naloga = VEĆI od (zbir stavki „Delovi", `cost_total` sa fakture servisa).
   * Nikad zbir oba: kad spoljni servis fakturiše i delove koje smo popisali kao stavke,
   * sabiranje bi ih brojalo dvaput. `cost_total` NIJE trigger-rollup — unosi ga čovek
   * iz WO detalja kao ceo iznos sa računa.
   */
  private effectiveWoCost(
    partsCost: number,
    costTotal: Prisma.Decimal | P30.Decimal | null,
  ): number {
    return Math.max(partsCost, Number(costTotal ?? 0));
  }

  /**
   * WO troškovi (paritet 1.0 maintReportsPanel + faktura spoljnog servisa):
   * partsCost = Σ po nalozima od `effectiveWoCost` (delovi ili faktura, šta je veće);
   * laborMinutes = Σ(minutes) nad wo_labor (rad se ne monetizuje — nema tarife).
   */
  async reportWorkOrderCosts(email: string, period?: string) {
    const days = this.periodDays(period);
    if (this.tri30) return this.reportWorkOrderCosts30(email, days);
    return this.withUserMapped(email, async (tx) => {
      const where: Prisma.MaintWorkOrderWhereInput = days
        ? { createdAt: { gte: this.sinceDate(days) } }
        : {};
      const wos = await tx.maintWorkOrder.findMany({
        where,
        select: { woId: true, type: true, assetType: true, costTotal: true },
      });
      if (!wos.length) return { data: this.emptyWoCosts(days) };
      const woIds = wos.map((w) => w.woId);
      const [partsByWo, labor] = await Promise.all([
        this.partsCostByWo(tx, woIds),
        tx.maintWoLabor.findMany({
          where: { woId: { in: woIds } },
          select: { minutes: true },
        }),
      ]);
      return { data: this.woCostsData(wos, partsByWo, labor, days) };
    });
  }

  /**
   * 3.0 parnjak. Sva tri upita nose scope: nalozi `workOrderListWhere`, stavke i
   * rad `woChildWhere`. Bez toga bi izveštaj o TROŠKU bio prvi ekran koji odaje
   * stanje cele firme — i to u agregatu, gde se curenje ne vidi po redovima.
   */
  private async reportWorkOrderCosts30(email: string, days: number | null) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const wos = await db.maintWorkOrder.findMany({
      where: {
        AND: [
          days ? { createdAt: { gte: this.sinceDate(days) } } : {},
          (az.workOrderListWhere(scope) ?? {}) as P30.MaintWorkOrderWhereInput,
        ],
      },
      select: { woId: true, type: true, assetType: true, costTotal: true },
    });
    if (!wos.length) return { data: this.emptyWoCosts(days) };
    const woIds = wos.map((w) => w.woId);
    const [partsByWo, labor] = await Promise.all([
      this.partsCostByWo30(scope, woIds),
      db.maintWoLabor.findMany({
        where: {
          AND: [
            { woId: { in: woIds } },
            (az.woChildWhere(scope) ?? {}) as P30.MaintWoLaborWhereInput,
          ],
        },
        select: { minutes: true },
      }),
    ]);
    return { data: this.woCostsData(wos, partsByWo, labor, days) };
  }

  private emptyWoCosts(days: number | null) {
    return {
      totalWorkOrders: 0,
      partsCost: 0,
      laborMinutes: 0,
      costByAssetType: {} as Record<string, number>,
      byType: {} as Record<string, number>,
      period: days ? `${days}d` : "all",
    };
  }

  /** Agregacija WO troškova — jedan izvor za oba izvora podataka. */
  private woCostsData(
    wos: {
      woId: string;
      type: string;
      assetType: string;
      costTotal: Prisma.Decimal | P30.Decimal | null;
    }[],
    partsByWo: Map<string, number>,
    labor: { minutes: number | null }[],
    days: number | null,
  ) {
    // Agregacija je PO NALOGU (ne po stavci) — tek na nivou naloga se zna da li je
    // faktura servisa veća od popisanih delova.
    let partsCost = 0;
    const costByAssetType: Record<string, number> = {};
    for (const w of wos) {
      const cost = this.effectiveWoCost(
        partsByWo.get(w.woId) ?? 0,
        w.costTotal,
      );
      if (cost === 0) continue;
      partsCost += cost;
      const at = String(w.assetType);
      costByAssetType[at] = (costByAssetType[at] ?? 0) + cost;
    }
    return {
      totalWorkOrders: wos.length,
      partsCost,
      laborMinutes: labor.reduce((a, l) => a + (l.minutes ?? 0), 0),
      costByAssetType,
      byType: this.countBy(wos, (w) => String(w.type)),
      period: days ? `${days}d` : "all",
    };
  }

  /**
   * IT/objekti koji „zahtevaju pažnju" — sredstva sa STVARNIM problemom SADA.
   *
   * Uslov je namerno uzak: pločica na pregledu je ranije brojala SVE nearhivirano
   * (5/5 IT sredstava koja sva rade), pa je „⚠ 5 zahtevaju pažnju" bilo šum.
   * Filtriranje je u SQL-u (ne na FE) da isti skup vide i pločica i izveštaj.
   *
   * Pažnju traži red kome je BAR JEDNO tačno:
   *  - `status <> 'running'` — smetnje / zastoj / u održavanju (enum
   *    `maint_operational_status` = running|degraded|down|maintenance; arhivirano se
   *    ionako odseca `archived_at IS NULL`). Isto pravilo koje pločica „Mašine"
   *    već koristi (`status !== 'running'`);
   *  - `open_wo_count > 0` — ima otvoren radni nalog (novi/dodeljen/u_radu);
   *  - IT: `license_status`/`warranty_status = 'expired'` — rok je PROŠAO;
   *  - IT: `backup_status IN ('missing','stale')` — backup je tražen a ne postoji
   *    (`missing`), ili je stariji od 7 dana (`stale`);
   *  - Objekti: `inspection_status`/`fire_safety_status = 'expired'` — inspekcija
   *    odnosno protivpožarni pregled su prekoračeni.
   *
   * NE ulazi (svesno):
   *  - `'unknown'` — podatak NIJE unet (rok je NULL); to je rupa u šifarniku, ne kvar,
   *    i ne sme da pali alarm nad sredstvom koje radi;
   *  - `'due_soon'` (≤30 dana) i `backup_status = 'not_required'` — nadolazeći rokovi
   *    imaju svoje mesto u „Rokovi (narednih 30 dana)" / kalendaru rokova, a
   *    „backup nije potreban" nije propust.
   */
  async reportAttention(email: string) {
    if (this.tri30) return this.reportAttention30(email);
    return this.withUserMapped(email, async (tx) => {
      const [itAssets, facilities] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_maint_it_overview
            WHERE archived_at IS NULL
              AND (status <> 'running'
                OR open_wo_count > 0
                OR license_status = 'expired'
                OR warranty_status = 'expired'
                OR backup_status IN ('missing', 'stale'))
            ORDER BY asset_code`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_maint_facility_overview
            WHERE archived_at IS NULL
              AND (status <> 'running'
                OR open_wo_count > 0
                OR inspection_status = 'expired'
                OR fire_safety_status = 'expired')
            ORDER BY asset_code`,
        ),
      ]);
      return { data: { itAssets, facilities } };
    });
  }

  private async reportAttention30(email: string) {
    const { db, az } = this.tri();
    const scope = await this.scope30(email);
    const neMasine = az.nonMachineViewScopeSql(scope);
    const [itAssets, facilities] = await Promise.all([
      db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_it_overview${az.viewWhere(
          this.andSql(
            P30.sql`archived_at IS NULL
              AND (status <> 'running'
                OR open_wo_count > 0
                OR license_status = 'expired'
                OR warranty_status = 'expired'
                OR backup_status IN ('missing', 'stale'))`,
            neMasine,
          ),
        )}
            ORDER BY asset_code`,
      ),
      db.$queryRaw(
        P30.sql`SELECT * FROM v_maint_facility_overview${az.viewWhere(
          this.andSql(
            P30.sql`archived_at IS NULL
              AND (status <> 'running'
                OR open_wo_count > 0
                OR inspection_status = 'expired'
                OR fire_safety_status = 'expired')`,
            neMasine,
          ),
        )}
            ORDER BY asset_code`,
      ),
    ]);
    return { data: { itAssets, facilities } };
  }

  // ==========================================================================
  // 3.0 — batch-resolve i izvedeni filteri (parnjaci privatnih sy15 helpera)
  // ==========================================================================

  /**
   * Batch-resolve `full_name` iz `maint_user_profiles` pod 3.0 scope-om.
   *
   * ⚠️ `maint_user_profiles` SELECT = `uid() = user_id ∨ erp_admin`, pa ne-admin
   * dobija ime SAMO za sebe — isto što je radio RLS (u sy15 je zato i stajalo
   * „best-effort"). Prazan rezultat NIJE kvar; širenje ovog kruga bi otvorilo
   * CMMS role i dodeljene mašine cele firme.
   */
  private async resolveProfiles30(
    scope: MaintScope,
    userIds: (number | null)[],
  ): Promise<Map<number, string>> {
    const { db, az } = this.tri();
    const ids = [...new Set(userIds.filter((x): x is number => x != null))];
    if (!ids.length) return new Map();
    const rows = await db.maintUserProfile.findMany({
      where: {
        AND: [
          { userId: { in: ids } },
          (az.userProfileListWhere(scope) ??
            {}) as P30.MaintUserProfileWhereInput,
        ],
      },
      select: { userId: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.userId, r.fullName]));
  }

  /** Batch-resolve sredstava za WO listu/detalj, pod `assetListWhere`. */
  private async resolveAssets30(
    scope: MaintScope,
    assetIds: (string | null)[],
  ): Promise<
    Map<
      string,
      { assetId: string; assetCode: string; name: string; assetType: string }
    >
  > {
    const { db, az } = this.tri();
    const ids = [...new Set(assetIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const rows = await db.maintAsset.findMany({
      where: {
        AND: [
          { assetId: { in: ids } },
          (az.assetListWhere(scope) ?? {}) as P30.MaintAssetWhereInput,
        ],
      },
      select: { assetId: true, assetCode: true, name: true, assetType: true },
    });
    return new Map(rows.map((r) => [r.assetId, { ...r }]));
  }

  /** 3.0 parnjak `activeOverride` — samo VAŽEĆI override, i samo za vidljivu mašinu. */
  private async activeOverride30(scope: MaintScope, code: string) {
    const { db, az } = this.tri();
    if (!az.machineVisible(scope, code)) return null;
    return db.maintMachineStatusOverride.findFirst({
      where: {
        machineCode: code,
        OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
      },
    });
  }

  /** 3.0 parnjak `partsCostByWo` — stavke nose scope RODITELJSKOG naloga. */
  private async partsCostByWo30(
    scope: MaintScope,
    woIds: string[],
  ): Promise<Map<string, number>> {
    const { db, az } = this.tri();
    const out = new Map<string, number>();
    if (!woIds.length) return out;
    const parts = await db.maintWoPart.findMany({
      where: {
        AND: [
          { woId: { in: woIds } },
          (az.woChildWhere(scope) ?? {}) as P30.MaintWoPartWhereInput,
        ],
      },
      select: { woId: true, partId: true, quantity: true, unitCost: true },
    });
    const missing = [
      ...new Set(
        parts
          .filter((p) => p.unitCost == null && p.partId)
          .map((p) => p.partId as string),
      ),
    ];
    const catalogCost = new Map<string, number>();
    // Katalog cena je `maint_parts` (krug `canReadStock`): ko ne sme u magacin ne
    // dobija fallback cenu, pa stavka bez `unit_cost` ostaje 0 — kao pod RLS-om.
    if (missing.length && az.canReadStock(scope)) {
      const cat = await db.maintPart.findMany({
        where: { partId: { in: missing } },
        select: { partId: true, unitCost: true },
      });
      for (const c of cat) catalogCost.set(c.partId, Number(c.unitCost ?? 0));
    }
    return this.sumPartsCost(parts, catalogCost, out);
  }

  /**
   * 3.0 parnjak `machineCodeFilter` — skup `machine_code`-ova koji zadovoljavaju
   * status/rok filter. Oba view-a nose `machineScopeSql`: bez toga bi filter
   * „Prekoračeno" vraćao šifre tuđih mašina, koje bi tek presek sa scope-om
   * odsekao — a presek se lako izgubi pri sledećoj izmeni.
   */
  private async machineCodeFilter30(
    scope: MaintScope,
    query: MachinesQuery,
  ): Promise<string[] | undefined> {
    const { db, az } = this.tri();
    const statusVal = this.normalizeOpStatus(query.status);
    const dl = query.deadline;
    const needDeadline = dl === "overdue" || dl === "danas" || dl === "7d";
    if (!statusVal && !needDeadline) return undefined;
    const masine = az.machineScopeSql(scope);
    const sets: Set<string>[] = [];
    if (statusVal) {
      const rows = await db.$queryRaw<{ machine_code: string }[]>(
        P30.sql`SELECT machine_code FROM v_maint_machine_current_status${az.viewWhere(
          this.andSql(P30.sql`status = ${statusVal}`, masine),
        )}`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    }
    if (dl === "overdue") {
      const rows = await db.$queryRaw<{ machine_code: string }[]>(
        P30.sql`SELECT machine_code FROM v_maint_machine_current_status${az.viewWhere(
          this.andSql(P30.sql`overdue_checks_count > 0`, masine),
        )}`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    } else if (dl === "danas") {
      const rows = await db.$queryRaw<{ machine_code: string }[]>(
        P30.sql`SELECT machine_code FROM v_maint_task_due_dates${az.viewWhere(
          masine,
        )}
          GROUP BY machine_code
          HAVING min(next_due_at) >= date_trunc('day', now())
             AND min(next_due_at) < date_trunc('day', now()) + interval '1 day'`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    } else if (dl === "7d") {
      const rows = await db.$queryRaw<{ machine_code: string }[]>(
        P30.sql`SELECT machine_code FROM v_maint_task_due_dates${az.viewWhere(
          masine,
        )}
          GROUP BY machine_code
          HAVING min(next_due_at) < date_trunc('day', now()) + interval '8 days'`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    }
    let acc = sets[0] ?? new Set<string>();
    for (let i = 1; i < sets.length; i++) {
      acc = new Set([...acc].filter((x) => sets[i].has(x)));
    }
    return [...acc];
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
   * 1.0 chip → efektivni op-status (index.js:717-722). Prima i raw enum (running…)
   * i srpski chip (radi/smetnje/zastoj/odrzavanje); nepoznato = null (ignoriši filter).
   */
  private normalizeOpStatus(s?: string): string | null {
    if (!s) return null;
    const map: Record<string, string> = {
      running: "running",
      degraded: "degraded",
      down: "down",
      maintenance: "maintenance",
      radi: "running",
      smetnje: "degraded",
      zastoj: "down",
      odrzavanje: "maintenance",
    };
    return map[s] ?? null;
  }

  /**
   * Skup machine_code-ova koji zadovoljavaju status/rok filter (view-derived), da DB
   * paginacija ostane tačna. Vraća `undefined` kad nema takvog filtera (bez `in` klauzule).
   * Semantika 1.0 (index.js:716-735): status = efektivni op-status; rok:
   *   overdue = `overdue_checks_count > 0`; danas = min(next_due) danas (DB clock);
   *   7d = min(next_due) unutar 8 dana (uklj. prekoračene, kao `nextDueAt <= weekEnd`).
   * Više filtera se AND-uje (intersekcija skupova).
   */
  private async machineCodeFilter(
    tx: Sy15Tx,
    query: MachinesQuery,
  ): Promise<string[] | undefined> {
    const statusVal = this.normalizeOpStatus(query.status);
    const dl = query.deadline;
    const needDeadline = dl === "overdue" || dl === "danas" || dl === "7d";
    if (!statusVal && !needDeadline) return undefined;
    const sets: Set<string>[] = [];
    if (statusVal) {
      const rows = await tx.$queryRaw<{ machine_code: string }[]>(
        Prisma.sql`SELECT machine_code FROM v_maint_machine_current_status
          WHERE status = ${statusVal}`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    }
    if (dl === "overdue") {
      const rows = await tx.$queryRaw<{ machine_code: string }[]>(
        Prisma.sql`SELECT machine_code FROM v_maint_machine_current_status
          WHERE overdue_checks_count > 0`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    } else if (dl === "danas") {
      const rows = await tx.$queryRaw<{ machine_code: string }[]>(
        Prisma.sql`SELECT machine_code FROM v_maint_task_due_dates
          GROUP BY machine_code
          HAVING min(next_due_at) >= date_trunc('day', now())
             AND min(next_due_at) < date_trunc('day', now()) + interval '1 day'`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    } else if (dl === "7d") {
      const rows = await tx.$queryRaw<{ machine_code: string }[]>(
        Prisma.sql`SELECT machine_code FROM v_maint_task_due_dates
          GROUP BY machine_code
          HAVING min(next_due_at) < date_trunc('day', now()) + interval '8 days'`,
      );
      sets.push(new Set(rows.map((r) => r.machine_code)));
    }
    let acc = sets[0] ?? new Set<string>();
    for (let i = 1; i < sets.length; i++) {
      acc = new Set([...acc].filter((x) => sets[i].has(x)));
    }
    return [...acc];
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

  /**
   * Batch-resolve sredstva (maint_assets) za WO listu/detalj (H4). RLS SELECT na
   * maint_assets presuđuje vidljivost (isti krug kao sam WO). Vraća `assetCode`/`name`/
   * `assetType` po asset_id (1.0 ugnježđuje `maint_assets(asset_code,name,asset_type)`).
   */
  private async resolveAssets(
    tx: Sy15Tx,
    assetIds: (string | null)[],
  ): Promise<
    Map<
      string,
      { assetId: string; assetCode: string; name: string; assetType: string }
    >
  > {
    const ids = [...new Set(assetIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const rows = await tx.maintAsset.findMany({
      where: { assetId: { in: ids } },
      select: { assetId: true, assetCode: true, name: true, assetType: true },
    });
    return new Map(
      rows.map((r) => [
        r.assetId,
        {
          assetId: r.assetId,
          assetCode: r.assetCode,
          name: r.name,
          assetType: r.assetType as unknown as string,
        },
      ]),
    );
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
    this.assertPorted("čitanje/upis održavanja");
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
    /* ⚠️ Prisma vraća RLS violaciju kao PrismaClientUnknownRequestError (npr. iz updateMany):
       SQLSTATE 42501 je SAMO u tekstu poruke (ConnectorError), NE u strukturnom `code`/`meta.code`.
       Bez ovog fallback-a takav slučaj promašuje mapper i pada u `throw e` → 500. Konkretno:
       soft-delete napomene/fajla/dokumenta (deleted_at != null) obara WITH CHECK jer red postane
       SELECT-nevidljiv (SELECT USING traži deleted_at IS NULL) — pre-postojeći 1.0 defekt (paritet
       §C). Mapiramo u 403. 1.0 docs/CUTOVER_AUDIT_odrzavanje_2026-07-17.md §4.2. */
    const rlsInMessage =
      typeof message === "string" &&
      (message.includes("42501") ||
        message.includes("row-level security policy"));
    if (code === "42501" || rlsInMessage)
      throw new ForbiddenException(
        "Operacija nije dozvoljena postojećim RLS pravilom (npr. soft-delete čini red nevidljivim).",
      );
    if (
      code === "P0001" ||
      code === "P0002" ||
      code === "23514" ||
      code === "23503" || // FK (npr. preventive task bez CMMS asset-a)
      code === "22023" // invalid param (npr. delete-hard razlog < 5)
    )
      throw new UnprocessableEntityException(message);
    /* 🔴 NEISPRAVAN OBLIK ULAZA = 422, NIKAD 500 (BACKEND_RULES §6).
       `P2023` je Prisma „Inconsistent column data" (npr. `userId: "123"` nad
       `uuid` kolonom u sy15), `22P02` je isti kvar kad ga vrati sam PG
       (`invalid input syntax for type ...`). Otkad je `ParseUUIDPipe` skinut sa
       `PATCH profiles/:id` (šav seobe: `user_id` je uuid u sy15, Int u 3.0),
       besmislen parametar više ne pada na pipe nego stigne do upita — bez ovog
       reda bi pod PODRAZUMEVANIM prekidačem (sy15, produkcija danas) 400/422
       postalo 500. Poruka je NAŠA, ne Prisma-ina: sirova nosi ime modela i
       kolone i nema šta da traži kod korisnika. */
    if (
      code === "P2023" ||
      code === "22P02" ||
      (typeof message === "string" &&
        message.includes("invalid input syntax for type"))
    )
      throw new UnprocessableEntityException(
        "Neispravan oblik identifikatora u zahtevu",
      );
    if (code === "23505") throw new ConflictException(message);
    // Zaštitna mreža za trku „provera → INSERT" (zahtev 047/26): sirova P2002 poruka
    // („Unique constraint failed on the fields: (`machine_code`)") ne sme do korisnika.
    if (code === "P2002")
      throw new ConflictException(
        "Šifra je već zauzeta (moguće otpisanom mašinom) — osveži listu i probaj ponovo",
      );
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

  /**
   * Idempotentna „create" akcija (`clientEventId` je ključ) — JEDAN ulaz za oba
   * izvora (§7.5 runbook-a, korak 2 gašenja sy15).
   *
   *   `ODRZAVANJE_IZVOR=sy15` (PODRAZUMEVANO) — sy15 registar `rev_api_idempotency`
   *                                             kroz `Sy15Service.runIdempotentRls`.
   *   `ODRZAVANJE_IZVOR=3.0`                   — 3.0 registar `api_idempotency`
   *                                             kroz generički `IdempotencyService`.
   *
   * UGOVOR PREMA KLIJENTU JE IDENTIČAN u oba položaja: isti `clientEventId` iz
   * zahteva, isti prostor imena `action`, isti odgovor `{ data, meta: { idempotent } }`,
   * isti 409 na ključ upotrebljen za drugu akciju. FE ga tako čita i ne vidi razliku.
   *
   * 🔴 REDOSLED JE DEO UGOVORA: `assertPorted` je PRVI RED. Da je ispod poziva
   * registra, neprenet (ili neovlašćen) poziv bi prvo POTROŠIO korisnikov
   * `clientEventId`, pa tek onda bio odbijen — ponovljen pokušaj posle preklopa
   * dobio bi 409 „ključ već upotrebljen" umesto 503, i to tiho.
   *
   * 🔴 `fn` NE MOŽE biti isto telo za obe grane: `Sy15Tx` je sy15 klijent (RLS,
   * `SET LOCAL ROLE authenticated`, `maint_*` DEFINER fn), a `IdempotencyTx` je
   * `Prisma.TransactionClient` nad 3.0 bazom — tipovi se ne poklapaju. Zato se 3.0
   * telo predaje zasebno kao `opts.fn30`. Prisustvo `fn30` je ujedno i OZNAKA DA JE
   * PUTANJA PRENETA: bez njega brana ostaje na snazi i putanja pod `3.0` i dalje
   * pada sa 503 (to je brana, ne kvar). Tela `fn30` pišu delovi 3 i 4 seobe —
   * ovaj korak samo otvara put.
   *
   * ⚠️ NAMERNA PROMENA PONAŠANJA POD `3.0`: `IdempotencyService` poredi i
   * `actor_email`, pa isti ključ od DRUGOG korisnika dobija 409. sy15 registar tu
   * kolonu nema i takvom pozivaocu vraća sačuvan (tuđi) odgovor. Ključ je nasumičan
   * uuid pa je razlika praktično neuočljiva, ali JESTE stroža — zabeleženo ovde da
   * se ne pripiše kvaru posle preklopa. Detalji u `idempotency.service.ts`.
   *
   * ⚠️ Stari ključevi se NE PRENOSE (izmereno: 21 ključ u sy15 `rev_api_idempotency`
   * za `odrzavanje.*`). Prvi zahtev posle preklopa je zato uvek „prvo izvršenje".
   *
   * ⚠️ `IdempotencyService.run` otvara SVOJU Prisma transakciju sa podrazumevanih
   * 5 s. Bulk akcije (hard-delete mašine, uvoz iz kataloga, stock ledger) to ume da
   * probiju — takva putanja mora da preda `opts.timeoutMs`.
   *
   * 🔴 `MaintScope` se čita PRE otvaranja transakcije, isto kao u `withUser30`.
   * Da se čita unutra, `scope30` bi tražio NOVU konekciju iz pool-a dok ova
   * transakcija svoju već drži — pod opterećenjem svaka konekcija može biti
   * zauzeta transakcijom koja čeka slobodnu, pa se pool sam sa sobom zaključa
   * do isteka. Cena je jedan upit više na ponovljen (idempotentan) zahtev.
   */
  private async runIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
    opts?: {
      /** 3.0 telo iste akcije; bez njega putanja NIJE preneta (brana 503). */
      fn30?: (tx: IdempotencyTx, s: MaintScope) => Promise<T>;
      /** Timeout 3.0 transakcije u ms (podrazumevano Prisma 5 s) — samo za bulk. */
      timeoutMs?: number;
    },
  ) {
    const fn30 = opts?.fn30;
    // Brana PRE registra idempotencije — neovlašćen/neprenet poziv ne sme da
    // potroši korisnikov `clientEventId` (isti redosled kao kod sastanaka, §7e).
    // Izostanak registra (`IdempotencyService` nije ubrizgan) ILI 3.0 trojke
    // (`tri30`) tretira se kao NEPRENETA putanja: pod `3.0` 503, nikad tih upis
    // u sy15 bazu. Trojka je u spisku otkad `runIdem` sam učitava `MaintScope`
    // (za to mu treba `prisma`+`authz`) — isti uslov koji `withUser30` već ima.
    if (!fn30 || !this.idem || !this.tri30) this.assertPorted(action);

    if (fn30 && this.idem && this.tri30) {
      try {
        // Scope se čita VAN transakcije registra (v. napomenu iznad).
        const s = await this.scope30(email);
        const out = await this.idem.run(
          email,
          clientEventId,
          action,
          (tx) => fn30(tx, s),
          opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : undefined,
        );
        return { data: out.result, meta: { idempotent: out.idempotent } };
      } catch (e) {
        this.rethrowSy15(e);
      }
    }

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

  // ==========================================================================
  // 3.0 GRANA UPISA — skretnice, snimak prava, most (korak 2 seobe, §7.1)
  // ==========================================================================
  // Nastavlja se na čitanja: `tri30`/`tri()`/`scope30` iz read sloja su ISTI
  // ovde — jedan snimak prava, jedna brana, jedno ponašanje. Ovo dodaje samo ono
  // što upisi traže: transakciju, gejt sa imenom politike i most ka lokacijama.
  //
  // Zašto NE kroz izmenu `withUserMapped`/`runIdem`: te dve tačke su brana
  // („neprenet put pada sa 503") i namerno ostaju NEDIRNUTE. `wum30`/`idem30` se
  // naslanjaju NA njih — pod `sy15` prosleđuju posao netaknut, a pod `3.0` uopšte
  // ne uđu u sy15 granu. Prisustvo `fn30` tela je i dalje jedina oznaka „preneto".

  /** Gejtovi 3.0 (parnjak RLS-a) — kratko ime za `tri().az` u telima upisa. */
  private get az(): OdrzavanjeAuthzService {
    return this.tri().az;
  }

  /** Prepis DEFINER fn i logičkih trigera — kratko ime za `tri().fn`. */
  private get fns(): OdrzavanjeFnService {
    return this.tri().fn;
  }

  /** 403 sa porukom koja imenuje sy15 politiku čiji je ovo prepis. */
  private gejt(dozvoljeno: boolean, politika: string): void {
    if (!dozvoljeno)
      throw new ForbiddenException(`Nemate pravo za ovu izmenu (${politika}).`);
  }

  /**
   * Snimak prava SAMO kad upis stvarno ide 3.0 putem; inače `null`.
   *
   * 🔴 Uslov je `tri30`, ne samo prekidač: kad prekidač JESTE na `3.0` ali neka
   * zavisnost fali, vraća se `null` pa poziv pada natrag na `withUserMapped`,
   * gde ga dočeka brana `assertPorted` (503). Izostanak zavisnosti tako nikad ne
   * može tiho da vrati UPIS u sy15 — isti bezbedan smer kao kod čitanja.
   *
   * Učitava se PRE transakcije (u sy15 su gejtovi bili `STABLE`, pa ih je planer
   * računao jednom po naredbi) — transakcija ne troši drugu konekciju iz pula.
   */
  private async scope30Ako(email: string): Promise<MaintScope | null> {
    if (!this.tri30) return null;
    return this.scope30(email);
  }

  /**
   * `withUserMapped` parnjak za PRENETE putanje. Pod `sy15` je doslovno
   * `withUserMapped(email, fn)`; pod `3.0` otvara transakciju 3.0 baze i predaje
   * je `fn30` zajedno sa snimkom prava.
   *
   * 🔴 `fn30` OBAVEZNO prima `tx` — svaki poziv `OdrzavanjeFnService` metode
   * unutra mora da ga prosledi dalje, inače „obriši mašinu + upiši trag" prestaje
   * da bude jedan potez (u sy15 su DEFINER fn radile u istoj transakciji).
   */
  // ⚠️ DVA TIPA REZULTATA, ne jedan: `maintMachine` iz `@prisma-sy15/client` i iz
  // `@prisma/client` su RAZLIČITI tipovi (npr. `responsible_user_id` je uuid u sy15,
  // `Int` u 3.0). Zato `T | U` — a ne prisilno svođenje na jedan, koje bi zahtevalo
  // `as` i sakrilo baš tu razliku.
  private async wum30<T, U>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
    fn30: (tx: OdrzavanjeTx, scope: MaintScope) => Promise<U>,
    opts?: { timeoutMs?: number },
  ): Promise<T | U> {
    const scope = await this.scope30Ako(email);
    if (scope) {
      const { db } = this.tri();
      try {
        return await db.$transaction(
          (tx) => fn30(tx, scope),
          opts?.timeoutMs != null ? { timeout: opts.timeoutMs } : undefined,
        );
      } catch (e) {
        // Isti mapper kao sy15 grana: Prisma kodovi (P2002/P2025/23505/23514…)
        // znače isto u obe baze, a domenske izuzetke propušta netaknute.
        this.rethrowSy15(e);
      }
    }
    return this.withUserMapped(email, fn);
  }

  /** `runIdem` parnjak za prenete „create" putanje — dodaje snimak prava u `fn30`. */
  private async idem30<T, U>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
    fn30: (tx: OdrzavanjeTx, scope: MaintScope) => Promise<U>,
    opts?: { timeoutMs?: number },
  ) {
    // Pod `sy15` snimak je `null` → `fn30` se NE prosleđuje, pa `runIdem` ide
    // starim putem i `assertPorted` (koji je pod `sy15` nem) ostaje na svom mestu.
    const scope = await this.scope30Ako(email);
    return this.runIdem<T | U>(email, clientEventId, action, fn, {
      ...(scope ? { fn30: (tx: IdempotencyTx) => fn30(tx, scope) } : {}),
      ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /**
   * Most ka `loc_locations` — 🔴 POSLE COMMIT-a 3.0 transakcije, nikad unutar nje
   * (`loc_locations` je DRUGA baza; unutar `$transaction` bi 3.0 upis visio na
   * sy15 latenciji). Fail-soft je u samom mostu — nikad ne baca.
   */
  private async mostSync(
    m: {
      machineCode: string;
      name: string | null;
      archivedAt: Date | null;
      tracked: boolean;
    },
    op: "INSERT" | "UPDATE",
  ): Promise<void> {
    if (this.locMost?.aktivan() !== true) return;
    await this.locMost.syncMachineToLoc(m, op);
  }

  /**
   * 🔴 IDENTITET NIJE PRENET: DTO polja koja nose korisnika (`responsibleUserId`,
   * `assignedTo`) su `@IsUUID()` — to je sy15 `auth.users.id`. U 3.0 je ista
   * kolona `Int` (`users.id`), a `users` NEMA kolonu sa sy15 uuid-om (izmereno:
   * prenosna skripta ih je razrešila po mejlu, van runtime-a).
   *
   * Zato takva vrednost pod `3.0` GLASNO pada umesto da se tiho odbaci — tiho
   * odbacivanje bi značilo „sačuvao sam nalog, ali dodela je nestala". Polje koje
   * klijent NIJE poslao (`undefined`) prolazi netaknuto, pa 95% upisa radi.
   */
  private id30(
    v: string | undefined,
    polje: string,
  ): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (/^\d+$/.test(v)) return Number(v);
    throw new UnprocessableEntityException(
      `Polje „${polje}" nosi sy15 uuid (${v}), a pod ODRZAVANJE_IZVOR=3.0 se očekuje ` +
        "numerički `users.id`. Prevod identiteta stiže sa korakom 3 seobe " +
        "(docs/SEOBA_ODRZAVANJA_2026-08-06.md); do tada ovo polje radi samo pod `sy15`.",
    );
  }

  // ---------- Mašine: katalog CRUD / arhiva / rename / import / hard-delete ----------

  /**
   * Sufiks kojim se šifra otpisane mašine sklanja s puta (zahtev 047/26).
   * `machine_code` je PRIMARNI KLJUČ, a otpis je soft-delete — bez preimenovanja bi
   * šifra ostala zauzeta zauvek, pa nova mašina sa istom oznakom ne može da se unese.
   */
  private static readonly ARCHIVE_SUFFIX_RE = /#ARH-\d{8}(?:-\d+)?$/;

  /** Bazna (upotrebljiva) šifra: `3.10#ARH-20260730` → `3.10`. */
  private baseMachineCode(code: string): string {
    return code.replace(OdrzavanjeService.ARCHIVE_SUFFIX_RE, "");
  }

  /**
   * `#ARH-` je REZERVISAN marker arhive (047/26) — ručno unet u šifru pravi mašinu
   * koju otpis/restore ne ume da vrati pod izvornom oznakom (`baseMachineCode` bi
   * skinuo i taj „pravi" deo šifre). Zato ga zabranjujemo na ulazu, umesto da
   * kasnije pogađamo šta je marker a šta deo imena.
   */
  private static readonly RESERVED_ARCHIVE_MARK = "#ARH-";

  /** Trimuje i odbija rezervisani marker; vraća šifru spremnu za upis. */
  private assertUsableMachineCode(code: string): string {
    const c = String(code ?? "").trim();
    if (!c) throw new UnprocessableEntityException("Šifra mašine je obavezna");
    if (c.toUpperCase().includes(OdrzavanjeService.RESERVED_ARCHIVE_MARK))
      throw new UnprocessableEntityException(
        `„${OdrzavanjeService.RESERVED_ARCHIVE_MARK}" je rezervisan za šifre otpisanih mašina — izaberi drugu oznaku`,
      );
    return c;
  }

  /**
   * Prva slobodna šifra iz niza `base`, `base-2`, `base-3`… (do 50).
   * Bira je baza u JEDNOM upitu — bez petlje sa neuspelim rename-ovima, jer bi
   * greška unutar transakcije oborila ceo otpis.
   *
   * Kad NIJEDAN kandidat nije slobodan, baca se 409 — vraćanje `base` (koji je po
   * konstrukciji zauzet) bi u `restoreMachine` zaobišlo guard „bazna šifra je
   * zauzeta", a u otpisu proizvelo sirovu RPC grešku umesto jasne poruke.
   */
  private async firstFreeMachineCode(
    tx: Sy15Tx,
    base: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ code: string }[]>(Prisma.sql`
      SELECT c.code
        FROM (SELECT g,
                     ${base}::text || CASE WHEN g = 1 THEN '' ELSE '-' || g END AS code
                FROM generate_series(1, 50) g) c
       WHERE NOT EXISTS (SELECT 1 FROM maint_machines m WHERE m.machine_code = c.code)
       ORDER BY c.g
       LIMIT 1`);
    const free = rows[0]?.code;
    if (!free)
      throw new ConflictException(
        `Sve šifre od ${base} do ${base}-50 su zauzete — ručno preimenuj neku od njih pa ponovi`,
      );
    return free;
  }

  /**
   * 3.0 parnjak `firstFreeMachineCode`. Isti niz kandidata i ista poruka; niz se
   * pravi u kodu umesto `generate_series` — i dalje JEDAN upit, pa se guard
   * „bazna šifra je zauzeta" ponaša identično.
   */
  private async firstFreeMachineCode30(
    tx: OdrzavanjeTx,
    base: string,
  ): Promise<string> {
    const kandidati = Array.from({ length: 50 }, (_, i) =>
      i === 0 ? base : `${base}-${i + 1}`,
    );
    const zauzete = new Set(
      (
        await tx.maintMachine.findMany({
          where: { machineCode: { in: kandidati } },
          select: { machineCode: true },
        })
      ).map((m) => m.machineCode),
    );
    const free = kandidati.find((c) => !zauzete.has(c));
    if (!free)
      throw new ConflictException(
        `Sve šifre od ${base} do ${base}-50 su zauzete — ručno preimenuj neku od njih pa ponovi`,
      );
    return free;
  }

  async createMachine(email: string, dto: CreateMachineDto) {
    const out = await this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-machine",
      async (tx) => {
        // Zauzeta šifra se presuđuje PRE INSERT-a — inače korisnik dobije sirovu
        // Prisma P2002 poruku („Unique constraint failed"), koja ne kaže ni koja je
        // mašina zauzela šifru ni šta da uradi (zahtev 047/26). Rezervisani `#ARH-`
        // marker se odbija istim tim putem (422), pre ijednog upisa.
        const code = this.assertUsableMachineCode(dto.machineCode);
        const taken = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: { machineCode: true, name: true, archivedAt: true },
        });
        if (taken) {
          throw new ConflictException(
            taken.archivedAt
              ? `Šifra ${code} pripada otpisanoj mašini „${taken.name}" — vrati je iz arhive ili je preimenuj u arhivi`
              : `Mašina sa šifrom ${code} već postoji`,
          );
        }
        // asset_id je NOT NULL ali ga popunjava trigger `maint_machines_ensure_asset`
        // PRE INSERT-a → koristimo $executeRaw (Prisma create traži asset_id u tipu).
        const uid = await this.uid(tx);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO maint_machines
            (machine_code, name, type, manufacturer, model, serial_number,
             year_of_manufacture, year_commissioned, location, department_id,
             power_kw, weight_kg, notes, tracked, source, responsible_user_id, updated_by)
          VALUES (
            ${code}, ${dto.name.trim()}, ${dto.type ?? null},
            ${dto.manufacturer ?? null}, ${dto.model ?? null}, ${dto.serialNumber ?? null},
            ${dto.yearOfManufacture ?? null}, ${dto.yearCommissioned ?? null},
            ${dto.location ?? null}, ${dto.departmentId ?? null},
            ${dto.powerKw ?? null}, ${dto.weightKg ?? null}, ${dto.notes ?? null},
            ${dto.tracked !== false}, ${dto.source ?? "manual"},
            ${dto.responsibleUserId ?? null}::uuid, ${uid}::uuid)`);
        const row = await tx.maintMachine.findUnique({
          where: { machineCode: code },
        });
        return row;
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      async (tx, scope) => {
        // `maint_machines_insert` CHECK: erp_admin ∨ chief/admin.
        this.gejt(this.az.canWriteCatalog(scope), "maint_machines_insert");
        const code = this.assertUsableMachineCode(dto.machineCode);
        const taken = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: { machineCode: true, name: true, archivedAt: true },
        });
        if (taken) {
          throw new ConflictException(
            taken.archivedAt
              ? `Šifra ${code} pripada otpisanoj mašini „${taken.name}" — vrati je iz arhive ili je preimenuj u arhivi`
              : `Mašina sa šifrom ${code} već postoji`,
          );
        }
        // 🔴 BEFORE INSERT triger `maint_machines_ensure_asset` — `asset_id` je
        // NOT NULL i u 3.0 ga NEMA ko drugi da popuni (triger NIJE prenet u bazu).
        const name = dto.name.trim();
        const assetId = await this.fns.machineEnsureAsset(tx, {
          assetId: null,
          machineCode: code,
          name,
          responsibleUserId:
            this.id30(dto.responsibleUserId, "responsibleUserId") ?? null,
          manufacturer: dto.manufacturer ?? null,
          model: dto.model ?? null,
          serialNumber: dto.serialNumber ?? null,
          notes: dto.notes ?? null,
          archivedAt: null,
        });
        return tx.maintMachine.create({
          data: {
            machineCode: code,
            name,
            type: dto.type ?? null,
            manufacturer: dto.manufacturer ?? null,
            model: dto.model ?? null,
            serialNumber: dto.serialNumber ?? null,
            yearOfManufacture: dto.yearOfManufacture ?? null,
            yearCommissioned: dto.yearCommissioned ?? null,
            location: dto.location ?? null,
            departmentId: dto.departmentId ?? null,
            powerKw: dto.powerKw ?? null,
            weightKg: dto.weightKg ?? null,
            notes: dto.notes ?? null,
            tracked: dto.tracked !== false,
            source: dto.source ?? "manual",
            responsibleUserId:
              this.id30(dto.responsibleUserId, "responsibleUserId") ?? null,
            updatedBy: scope.userId,
            assetId,
          },
        });
      },
    );
    // 🔴 Most ka `loc_locations` TEK POSLE commit-a (druga baza). Ponovljen
    // zahtev (`idempotent: true`) ne izvršava telo, pa ne diramo ni most.
    if (out.meta.idempotent !== true) {
      await this.mostSync(
        {
          machineCode: this.assertUsableMachineCode(dto.machineCode),
          name: dto.name.trim(),
          archivedAt: null,
          tracked: dto.tracked !== false,
        },
        "INSERT",
      );
    }
    return out;
  }

  async updateMachine(email: string, code: string, dto: UpdateMachineDto) {
    const out = await this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      async (tx, scope) => {
        // `maint_machines_update` USING/CHECK: erp_admin ∨ chief/admin.
        this.gejt(this.az.canWriteCatalog(scope), "maint_machines_update");
        const exists =
          (await tx.maintMachine.count({ where: { machineCode: code } })) > 0;
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
              ? {
                  responsibleUserId: this.id30(
                    dto.responsibleUserId,
                    "responsibleUserId",
                  ),
                }
              : {}),
            updatedBy: scope.userId,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Mašina ${code}`);
        return {
          data: await tx.maintMachine.findUnique({
            where: { machineCode: code },
          }),
        };
      },
    );
    // AFTER UPDATE `maint_machines_sync_to_loc` — posle commit-a (druga baza).
    const m = out.data;
    if (m)
      await this.mostSync(
        {
          machineCode: m.machineCode,
          name: m.name,
          archivedAt: m.archivedAt,
          tracked: m.tracked,
        },
        "UPDATE",
      );
    return out;
  }

  /**
   * OTPIS mašine (zahtev 037/26) — mašina se izbacuje iz upotrebe, ali se NE briše
   * nego ARHIVIRA: karton i cela istorija (kontrole, kvarovi, nalozi, napomene,
   * dokumenta) ostaju dostupni. Nasleđuje raniji `archiveMachine` i dodaje tri stvari
   * koje su nedostajale:
   *
   *  1. RAZLOG + trag ko je otpisao. `maint_machines` NEMA te kolone, ali ogledalo u
   *     `maint_assets` ima (`archive_reason`/`archived_by`) — a sy15 šema se iz ovog
   *     repoa NE migrira (`prisma migrate` gađa samo glavnu bazu, `sy15.prisma` je
   *     `db pull` introspekcija), pa se piše tamo gde kolone već postoje.
   *  2. PROPAGACIJA na `maint_assets` (`archived_at`, `active=false`). Bez toga je
   *     otpis bio pola posla: `listAssets(activeOnly)` filtrira po `maint_assets`, pa
   *     bi se otpisana mašina i dalje nudila u pickeru novog radnog naloga i prijave
   *     kvara. RLS je isti kao za `maint_machines` (`maint_assets_update`:
   *     erp-admin ∨ chief/admin) — ko sme da otpiše, sme i ogledalo.
   *  3. OBAVEŠTENJE ŠEFU PROIZVODNJE da preraspodeli poslove (posle commit-a).
   *
   * SELECT ostaje nedirnut: `maint_asset_visible()` za mašine gleda
   * `maint_machine_visible(machine_code)` i NE filtrira `archived_at` — zato karton
   * otpisane mašine i dalje otvara.
   */
  async otpisMachine(email: string, code: string, reason: string) {
    const razlog = reason.trim();
    const out = await this.wum30(
      email,
      async (tx) => {
        const machine = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: {
            machineCode: true,
            name: true,
            assetId: true,
            archivedAt: true,
          },
        });
        const exists = machine !== null;
        const uid = await this.uid(tx);
        const now = new Date();

        const { count } = await tx.maintMachine.updateMany({
          where: { machineCode: code },
          data: {
            archivedAt: now,
            tracked: false,
            updatedBy: uid,
            updatedAt: now,
          },
        });
        this.assertAffected(exists, count, `Mašina ${code}`);

        // Otvoreni nalozi se čitaju PRE nego što ih iko preraspodeli — broj ide i u
        // poruku šefu. `notIn` je isti skup kao `openOnly` u listWorkOrders.
        const openWorkOrders = await tx.maintWorkOrder.findMany({
          where: {
            assetId: machine!.assetId,
            status: { notIn: ["zavrsen", "otkazan"] as never[] },
          },
          select: { woNumber: true, title: true, status: true },
          orderBy: { createdAt: "asc" },
          take: 50,
        });

        await tx.maintAsset.updateMany({
          where: { assetId: machine!.assetId },
          data: {
            archivedAt: now,
            archiveReason: razlog,
            archivedBy: uid,
            active: false,
            updatedBy: uid,
            updatedAt: now,
          },
        });

        // Zahtev 047/26: šifra se OSLOBAĐA za novu mašinu. PK se menja atomski kroz
        // isti RPC koji koristi `renameMachine` (propagira kroz sve child tabele), i to
        // TEK POSLE update-a — tako RLS provera prava (`assertAffected`) i dalje presuđuje
        // nad izvornom šifrom. Već otpisana mašina se ne preimenuje drugi put.
        //
        // ⚠️ ZAVISNOST: traži popravljen `maint_machine_rename` iz
        // `backend/docs/migration/ZAHTEV_047_MASINA_RENAME_FIX.sql` (mora biti primenjen
        // na sy15 PRE deploy-a). Popravljena verzija u kopiju reda nosi `asset_id` i u
        // istoj transakciji preimenuje `maint_assets.asset_code` → sredstvo PRATI mašinu,
        // pa arhiva (`archive_reason`/`archived_by` upisani gore) i cela istorija naloga i
        // dokumenata ostaju uz otpisanu mašinu, a oslobođena šifra ne pokazuje ni na jedno
        // sredstvo. Zato je redosled bitan: asset se arhivira PRE rename-a (isti red).
        let newCode = code;
        if (machine!.archivedAt == null) {
          const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
          newCode = await this.firstFreeMachineCode(
            tx,
            `${this.baseMachineCode(code)}#ARH-${stamp}`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT public.maint_machine_rename(${code}, ${newCode}) AS result`,
          );
        }

        return {
          alreadyArchived: machine!.archivedAt != null,
          machineName: machine!.name,
          newCode,
          openWorkOrders: openWorkOrders.map((w) => ({
            woNumber: w.woNumber ?? null,
            title: w.title,
            status: String(w.status),
          })),
        };
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      async (tx, scope) => {
        // `maint_machines_update` + `maint_assets_update` — isti izraz za oba.
        this.gejt(this.az.canWriteCatalog(scope), "maint_machines_update");
        const machine = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: {
            machineCode: true,
            name: true,
            assetId: true,
            archivedAt: true,
          },
        });
        const exists = machine !== null;
        const now = new Date();
        const { count } = await tx.maintMachine.updateMany({
          where: { machineCode: code },
          data: {
            archivedAt: now,
            tracked: false,
            updatedBy: scope.userId,
            updatedAt: now,
          },
        });
        this.assertAffected(exists, count, `Mašina ${code}`);

        const openWorkOrders = await tx.maintWorkOrder.findMany({
          where: {
            assetId: machine!.assetId,
            status: { notIn: ["zavrsen", "otkazan"] },
          },
          select: { woNumber: true, title: true, status: true },
          orderBy: { createdAt: "asc" },
          take: 50,
        });

        await tx.maintAsset.updateMany({
          where: { assetId: machine!.assetId },
          data: {
            archivedAt: now,
            archiveReason: razlog,
            archivedBy: scope.userId,
            active: false,
            updatedBy: scope.userId,
            updatedAt: now,
          },
        });

        let newCode = code;
        if (machine!.archivedAt == null) {
          const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
          newCode = await this.firstFreeMachineCode30(
            tx,
            `${this.baseMachineCode(code)}#ARH-${stamp}`,
          );
          // 🔴 ISTI `tx` — prepis `maint_machine_rename` mora ostati u istoj
          // transakciji kao arhiviranje (u sy15 je bio DEFINER poziv iz nje).
          await this.fns.machineRename(tx, scope, code, newCode);
        }

        return {
          alreadyArchived: machine!.archivedAt != null,
          machineName: machine!.name,
          newCode,
          openWorkOrders: openWorkOrders.map((w) => ({
            woNumber: w.woNumber ?? null,
            title: w.title,
            status: String(w.status),
          })),
        };
      },
    );

    // AFTER UPDATE most: arhivirana mašina mora da postane `is_active = false` i u
    // `loc_locations`.
    //
    // 🔴 Ide pod IZVORNOM šifrom, ne pod novom arhivskom — u sy15 je triger pucao na
    // UPDATE-u koji je bio PRE rename-a, a `maint_machine_rename` `loc_locations`
    // NAMERNO ne dira (§2.5.14). Red u lokacijama zato i dalje nosi staru šifru;
    // gađanje nove ne bi našlo ništa i lokacija bi tiho ostala „aktivna".
    if (!out.alreadyArchived) {
      await this.mostSync(
        {
          machineCode: code,
          name: out.machineName,
          archivedAt: new Date(),
          tracked: false,
        },
        "UPDATE",
      );
    }

    // Obaveštenje TEK po uspešnom otpisu i fire-and-forget: mail (N primalaca ×
    // Resend timeout) ne sme da drži odgovor otvoren, a pad slanja ne sme da obori
    // već izvršen otpis (PLAN_dorade §D8). Ponovljeni otpis već otpisane mašine NE
    // šalje ponovo — inače bi „dupli klik" zasuo šefa istim obaveštenjem.
    if (!out.alreadyArchived) {
      void this.otpisNotify
        .notifyOtpis({
          machineCode: code,
          machineName: out.machineName,
          reason: razlog,
          openWorkOrders: out.openWorkOrders,
        })
        .catch(() => undefined);
    }

    return {
      data: {
        ok: true,
        alreadyArchived: out.alreadyArchived,
        openWorkOrders: out.openWorkOrders.length,
        // Nova (arhivska) šifra — FE mora da je zna da bi otvorio karton otpisane mašine.
        machineCode: out.newCode,
      },
    };
  }

  /** Vraćanje otpisane mašine u upotrebu — simetrično čisti i ogledalo u `maint_assets`. */
  async restoreMachine(email: string, code: string) {
    const out = await this.wum30(
      email,
      async (tx) => {
        const machine = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: { assetId: true },
        });
        const exists = machine !== null;
        const uid = await this.uid(tx);
        const now = new Date();
        const { count } = await tx.maintMachine.updateMany({
          where: { machineCode: code },
          data: {
            archivedAt: null,
            tracked: true,
            updatedBy: uid,
            updatedAt: now,
          },
        });
        this.assertAffected(exists, count, `Mašina ${code}`);
        await tx.maintAsset.updateMany({
          where: { assetId: machine!.assetId },
          data: {
            archivedAt: null,
            archiveReason: null,
            archivedBy: null,
            active: true,
            updatedBy: uid,
            updatedAt: now,
          },
        });

        // Simetrično otpisu: `#ARH-…` sufiks se skida i mašina se vraća pod svojom
        // izvornom šifrom — ali samo ako je u međuvremenu niko nije zauzeo (zahtev 047/26).
        //
        // Odarhiviranje sredstva iznad gađa `machine.assetId`, a to je (sa popravljenim
        // RPC-om iz ZAHTEV_047_MASINA_RENAME_FIX.sql) IZVORNO sredstvo mašine — ono koje
        // nosi naloge i dokumenta. Rename ga zatim vraća i pod baznu `asset_code`, pa
        // posle restore-a mašina ima AKTIVNO sredstvo sa očuvanom istorijom i nigde ne
        // ostaje fantomski `#ARH` red (privremeno sredstvo se više i ne pravi).
        let newCode = code;
        const base = this.baseMachineCode(code);
        if (base !== code && base.length > 0) {
          const free = await this.firstFreeMachineCode(tx, base);
          if (free !== base) {
            throw new ConflictException(
              `Šifra ${base} je u međuvremenu zauzeta drugom mašinom — preimenuj tu mašinu ili ovu vrati pod drugom šifrom`,
            );
          }
          await tx.$queryRaw(
            Prisma.sql`SELECT public.maint_machine_rename(${code}, ${base}) AS result`,
          );
          newCode = base;
        }
        return { data: { ok: true, machineCode: newCode } };
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_machines_update");
        const machine = await tx.maintMachine.findUnique({
          where: { machineCode: code },
          select: { assetId: true, name: true },
        });
        const exists = machine !== null;
        const now = new Date();
        const { count } = await tx.maintMachine.updateMany({
          where: { machineCode: code },
          data: {
            archivedAt: null,
            tracked: true,
            updatedBy: scope.userId,
            updatedAt: now,
          },
        });
        this.assertAffected(exists, count, `Mašina ${code}`);
        await tx.maintAsset.updateMany({
          where: { assetId: machine!.assetId },
          data: {
            archivedAt: null,
            archiveReason: null,
            archivedBy: null,
            active: true,
            updatedBy: scope.userId,
            updatedAt: now,
          },
        });

        let newCode = code;
        const base = this.baseMachineCode(code);
        if (base !== code && base.length > 0) {
          const free = await this.firstFreeMachineCode30(tx, base);
          if (free !== base) {
            throw new ConflictException(
              `Šifra ${base} je u međuvremenu zauzeta drugom mašinom — preimenuj tu mašinu ili ovu vrati pod drugom šifrom`,
            );
          }
          await this.fns.machineRename(tx, scope, code, base);
          newCode = base;
        }
        return {
          data: { ok: true, machineCode: newCode, name: machine!.name },
        };
      },
    );

    // ⚠️ SVESNO ODSTUPANJE (jedno, i mereno): u sy15 je triger pucao dok je mašina
    // još nosila `#ARH-` šifru, pa je u `loc_locations` NASTAJAO red pod arhivskom
    // šifrom (izvorni `3.10` red je ostajao neaktivan) — smeće koje niko ne čisti.
    // Ovde most gađa KONAČNU (baznu) šifru: isti željeni ishod („lokacija je opet
    // aktivna"), bez novog reda. Zabeleženo da se ne pripiše kvaru posle preklopa.
    await this.mostSync(
      {
        machineCode: out.data.machineCode,
        name: "name" in out.data ? (out.data.name ?? null) : null,
        archivedAt: null,
        tracked: true,
      },
      "UPDATE",
    );
    return { data: { ok: true, machineCode: out.data.machineCode } };
  }

  /** Uvoz mašina iz BigTehn cache (RPC; ON CONFLICT DO NOTHING → idempotentno). */
  importMachines(email: string, codes: string[]) {
    return this.wum30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ n: number }[]>(
          Prisma.sql`SELECT public.maint_machines_import_from_cache(${codes}::text[]) AS n`,
        );
        return { data: { imported: Number(rows[0]?.n ?? 0) } };
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      // 🔴 JEDINA putanja domena koja pod `3.0` GLASNO pada: izvor čita
      // `bigtehn_machines_cache`, tabelu koja nije `maint_*` i koju 3.0 baza NEMA
      // (blokada 9 runbook-a). Tiho „uvezeno 0" bi izgledalo kao prazan katalog.
      // Nije `async`: telo nema šta da čeka — jedini mu je posao da padne.
      () => this.fns.importFromCacheNijePreneto(),
    );
  }

  /**
   * Atomski rename PK kroz child tabele + ogledalo u `maint_assets` (RPC).
   * NE dira loc_locations (skriveno pravilo §2.5.14).
   *
   * Ručni rename NE sme da uvede rezervisani `#ARH-` marker (047/26) — inače bi
   * kasniji otpis/restore te mašine „skinuo" deo prave šifre.
   */
  async renameMachine(email: string, oldCode: string, newCode: string) {
    const target = this.assertUsableMachineCode(newCode);
    return this.wum30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>(
          Prisma.sql`SELECT public.maint_machine_rename(${oldCode}, ${target}) AS result`,
        );
        return { data: rows[0]?.result ?? null };
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      // Gejt je UNUTAR `machineRename` (uži je od hard-delete-a: bez
      // `erp_admin_or_management`) — zato se ovde NE duplira. Mosta NEMA namerno:
      // `loc_locations` se pri preimenovanju ne dira (skriveno pravilo §2.5.14).
      async (tx, scope) => ({
        data: await this.fns.machineRename(tx, scope, oldCode, target),
      }),
    );
  }

  /**
   * Hard-delete mašine: BE PRVO očisti storage (fajlovi mašine), pa RPC atomski
   * obriše red + child redove + upiše deletion_log (1.0 to radi klijent — spec §3).
   * Storage brisanje je best-effort PRE RPC-a (meta-red je izvor istine).
   *
   * 🔴 KO SME, presuđuje se PRE prvog obrisanog bajta. Pod `sy15` je korak 1 bio
   * običan SELECT nad kojim je stajao RLS `mmf_select`
   * (`maint_machine_visible(machine_code)`), pa je nevidljiva mašina davala 0
   * redova; RLS-a pod `3.0` nema, a `Sy15StorageService.remove` ide servisnim
   * ključem i briše STVARNO. Bez gejta ovde bi svako sa grubom modul-kapijom
   * `ODRZAVANJE_WRITE` mogao da obriše sve fajlove tuđe mašine (uputstva, šeme,
   * fotografije) i tek onda dobije 403 — nepovratno i bez traga.
   */
  async deleteMachineHard(email: string, code: string, reason: string) {
    // 1) Skupi putanje fajlova (RLS SELECT), pa best-effort obriši iz bucketa.
    //    Bajtovi OSTAJU u sy15 storage-u i pod `3.0` — seli se samo putanja.
    const paths = await this.wum30(
      email,
      async (tx) => {
        const files = await tx.maintMachineFile.findMany({
          where: { machineCode: code },
          select: { storagePath: true },
        });
        return files.map((f) => f.storagePath).filter(Boolean);
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      async (tx, scope) => {
        // ⚠️ SVESNO ODSTUPANJE (u BEZBEDNOM smeru, i mereno): gejt trajnog
        // brisanja je pomeren PRE brisanja bajtova. U sy15 je operater kome je
        // mašina dodeljena stizao da joj obriše fajlove pa tek onda pao na 403
        // u RPC-u; ovde ne stiže. Isti gejt (`canDeleteMachineHard`) presuđuje
        // i u koraku 2 — ovo ga samo dovodi ISPRED nepovratnog poteza.
        this.gejt(
          this.az.canDeleteMachineHard(scope),
          "maint_machine_delete_hard",
        );
        // `mmf_select` = `maint_machine_visible(machine_code)`, prepisan kao
        // FILTER a ne kao gejt: pod sy15 nevidljiva mašina daje 0 redova
        // (bajtovi ostaju), ne grešku.
        //
        // ⚠️ POŠTENO: danas je ova grana NEDOSTIŽNA — izmereno je da svaka rola
        // koju `canDeleteMachineHard` pušta prolazi i `machineVisible`
        // (`ERP_ADMIN_OR_MGMT_ROLES ⊂ FLOOR_READ_ROLES`). Zato bug gore ne bi
        // popravio scope nego GEJT. Ostaje kao brana za razlaz ta dva spiska;
        // implikacija je pinovana testom u `odrzavanje-authz.service.spec.ts`,
        // pa se razlaz vidi kao pad testa, a ne kao obrisani tuđi fajlovi.
        if (!this.az.machineVisible(scope, code)) return [];
        const files = await tx.maintMachineFile.findMany({
          where: { machineCode: code },
          select: { storagePath: true },
        });
        return files.map((f) => f.storagePath).filter(Boolean);
      },
    );
    for (const p of paths) await this.storage.remove(MAINT_BUCKET, p);
    // 2) RPC (auth: erp-admin ∨ chief/admin; validira razlog ≥5; P0002 ako ne postoji).
    return this.wum30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>(
          Prisma.sql`SELECT public.maint_machine_delete_hard(${code}, ${reason}) AS result`,
        );
        return { data: rows[0]?.result ?? null };
      },
      // ── 3.0 ──────────────────────────────────────────────────────────────
      // Gejt, validacija razloga (≥5) i 🔴 trag u `maint_machines_deletion_log`
      // (upisan PRE brisanja, sa celim redom mašine) su UNUTAR `machineDeleteHard`.
      // Isti `tx` = „obriši mašinu + upiši trag" je jedan potez ili nijedan.
      async (tx, scope) => ({
        data: await this.fns.machineDeleteHard(tx, scope, email, code, reason),
      }),
      // Brisanje 7 tabela dece bez FK CASCADE ume da probije 5 s podrazumevanog
      // prozora Prisma transakcije (bulk putanja — v. zaglavlje `runIdem`).
      { timeoutMs: 60_000 },
    );
  }

  // ---------- Ručni status override ----------

  /** Upsert override (PK machine_code); set_by = ja (paritet upsertMaintMachineOverride). */
  async setStatusOverride(email: string, code: string, dto: StatusOverrideDto) {
    return this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `maint_override_insert`/`_update`: erp_admin ∨ chief/admin.
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_override_insert");
        const data = {
          status: dto.status,
          reason: dto.reason,
          setBy: scope.userId,
          setAt: new Date(),
          validUntil: this.toDbTs(dto.validUntil) ?? null,
        };
        return {
          data: await tx.maintMachineStatusOverride.upsert({
            where: { machineCode: code },
            create: { machineCode: code, ...data },
            update: data,
          }),
        };
      },
    );
  }

  async clearStatusOverride(email: string, code: string) {
    return this.wum30(
      email,
      async (tx) => {
        await tx.maintMachineStatusOverride.deleteMany({
          where: { machineCode: code },
        });
        return { data: { ok: true } };
      },
      // ── 3.0 ── `maint_override_delete`: erp_admin ∨ chief/admin.
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_override_delete");
        await tx.maintMachineStatusOverride.deleteMany({
          where: { machineCode: code },
        });
        return { data: { ok: true } };
      },
    );
  }

  // ---------- Napomene mašine (24h pravilo je u RLS) ----------

  createNote(email: string, code: string, dto: CreateNoteDto) {
    return this.idem30(
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
      // ── 3.0 ── `maint_notes_insert` CHECK: author = ja ∧ mašina vidljiva ∧
      // (erp_admin ∨ profil operator/technician/chief/admin). Poslednji član NEMA
      // svoj helper (nije RLS-scope nego role-gate) — zato je ovde ispisan.
      async (tx, scope) => {
        const smePisatiNapomene =
          this.az.isErpAdmin(scope) ||
          ["operator", "technician", "chief", "admin"].includes(
            scope.profileRole ?? "",
          );
        this.gejt(
          this.az.machineVisible(scope, code) && smePisatiNapomene,
          "maint_notes_insert",
        );
        return tx.maintMachineNote.create({
          data: {
            machineCode: code,
            author: scope.userId,
            content: dto.content,
            pinned: dto.pinned === true,
          },
        });
      },
    );
  }

  async updateNote(email: string, noteId: string, dto: UpdateNoteDto) {
    return this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `maint_notes_update` USING: mašina vidljiva ∧ (erp_admin ∨
      // chief/admin ∨ autor u prvih 24 h sa rolom operator/technician).
      // 🔴 „24 sata" je najlakše propušteno pravilo cele seobe (v. `canEditOwnWithin24h`).
      async (tx, scope) => {
        const row = await tx.maintMachineNote.findUnique({
          where: { id: noteId },
          select: { machineCode: true, author: true, createdAt: true },
        });
        if (!row) throw new NotFoundException(`Napomena ${noteId} ne postoji`);
        this.gejt(
          this.az.machineVisible(scope, row.machineCode) &&
            this.az.canEditOwnWithin24h(scope, {
              authorId: row.author,
              createdAt: row.createdAt,
            }),
          "maint_notes_update",
        );
        await tx.maintMachineNote.update({
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
        return { data: { ok: true } };
      },
    );
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
    const meta = await this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `mmf_insert` CHECK: uploaded_by = ja ∧ (erp_admin ∨
      // erp_admin_or_management ∨ profil operator/technician/chief/admin).
      // Bajtovi i dalje idu u sy15 bucket — seli se SAMO meta red (putanja).
      async (tx, scope) => {
        const smeSlati =
          this.az.isErpAdmin(scope) ||
          this.az.isErpAdminOrManagement(scope) ||
          ["operator", "technician", "chief", "admin"].includes(
            scope.profileRole ?? "",
          );
        this.gejt(smeSlati, "mmf_insert");
        return tx.maintMachineFile.create({
          data: {
            machineCode: code,
            fileName: file.originalname,
            storagePath,
            mimeType: file.mimetype ?? null,
            sizeBytes: BigInt(file.buffer.length),
            category: dto.category ?? null,
            description: dto.description ?? null,
            uploadedBy: scope.userId,
          },
        });
      },
    );
    try {
      await this.storage.upload(
        MAINT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype || "application/octet-stream",
        false,
      );
    } catch (e) {
      // Poništavanje meta reda ide u ISTI izvor u koji je i upisan.
      await this.wum30(
        email,
        async (tx) => {
          await tx.maintMachineFile.deleteMany({ where: { id: meta.id } });
        },
        async (tx) => {
          await tx.maintMachineFile.deleteMany({ where: { id: meta.id } });
        },
      ).catch(() => {});
      throw e;
    }
    return { data: this.withNumSize(meta) };
  }

  updateMachineFile(email: string, id: string, dto: FileMetaDto) {
    return this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `mmf_update`: erp_admin ∨ chief/admin ∨ vlasnik u prvih 24 h.
      async (tx, scope) => {
        const row = await tx.maintMachineFile.findUnique({
          where: { id },
          select: { uploadedBy: true, uploadedAt: true },
        });
        if (!row) throw new NotFoundException(`Fajl ${id} ne postoji`);
        this.gejt(
          this.az.canEditOwnWithin24h(scope, {
            authorId: row.uploadedBy,
            createdAt: row.uploadedAt,
          }),
          "mmf_update",
        );
        await tx.maintMachineFile.update({
          where: { id },
          data: {
            ...(dto.category !== undefined ? { category: dto.category } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  /** Soft-delete fajla (deleted_at) pod RLS + best-effort brisanje bajtova. */
  async deleteMachineFile(email: string, id: string) {
    const path = await this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `mmf_delete`: isti izraz kao `mmf_update` (24 h pravilo).
      // ⚠️ Pod `3.0` NESTAJE 1.0 defekt „soft-delete čini red nevidljiv pa RLS
      // WITH CHECK obori upis" (paritet §C) — ovde gejt presuđuje pre upisa.
      async (tx, scope) => {
        const row = await tx.maintMachineFile.findUnique({
          where: { id },
          select: {
            storagePath: true,
            uploadedBy: true,
            uploadedAt: true,
          },
        });
        if (!row) throw new NotFoundException(`Fajl ${id} ne postoji`);
        this.gejt(
          this.az.canEditOwnWithin24h(scope, {
            authorId: row.uploadedBy,
            createdAt: row.uploadedAt,
          }),
          "mmf_delete",
        );
        await tx.maintMachineFile.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        return row.storagePath;
      },
    );
    if (path) await this.storage.remove(MAINT_BUCKET, path);
    return { data: { ok: true } };
  }

  /** Presigned URL fajla mašine (RLS SELECT presuđuje vidljivost PRE potpisivanja). */
  async signMachineFile(email: string, id: string) {
    const path = await this.wum30(
      email,
      async (tx) => {
        const row = await tx.maintMachineFile.findUnique({
          where: { id },
          select: { storagePath: true, deletedAt: true },
        });
        if (!row || row.deletedAt)
          throw new NotFoundException(`Fajl ${id} ne postoji`);
        return row.storagePath;
      },
      // ── 3.0 ── `mmf_select`: mašina vidljiva. Vidljivost se presuđuje PRE
      // potpisivanja — potpisan URL zaobilazi svaku kasniju proveru.
      async (tx, scope) => {
        const row = await tx.maintMachineFile.findUnique({
          where: { id },
          select: { storagePath: true, deletedAt: true, machineCode: true },
        });
        if (!row || row.deletedAt)
          throw new NotFoundException(`Fajl ${id} ne postoji`);
        this.gejt(this.az.machineVisible(scope, row.machineCode), "mmf_select");
        return row.storagePath;
      },
    );
    return { data: await this.storage.signUrl(MAINT_BUCKET, path, 300) };
  }

  // ---------- Preventiva: šabloni + kontrole + WO iz šablona ----------

  createTask(email: string, dto: CreateTaskDto) {
    return this.idem30(
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
      // ── 3.0 ── `maint_tasks_insert` CHECK: erp_admin ∨ chief/admin.
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_tasks_insert");
        return tx.maintTask.create({
          data: {
            machineCode: dto.machineCode,
            title: dto.title,
            description: dto.description ?? null,
            instructions: dto.instructions ?? null,
            intervalValue: dto.intervalValue,
            intervalUnit: dto.intervalUnit,
            severity: dto.severity ?? "normal",
            requiredRole: dto.requiredRole ?? "operator",
            gracePeriodDays: dto.gracePeriodDays ?? 3,
            active: dto.active ?? true,
            createdBy: scope.userId,
            updatedBy: scope.userId,
            checklistTemplate: [],
          },
        });
      },
    );
  }

  async updateTask(email: string, id: string, dto: UpdateTaskDto) {
    return this.wum30(
      email,
      async (tx) => {
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
      },
      // ── 3.0 ── `maint_tasks_update`: erp_admin ∨ chief/admin.
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_tasks_update");
        const exists = (await tx.maintTask.count({ where: { id } })) > 0;
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
              ? { intervalUnit: dto.intervalUnit }
              : {}),
            ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
            ...(dto.requiredRole !== undefined
              ? { requiredRole: dto.requiredRole }
              : {}),
            ...(dto.gracePeriodDays !== undefined
              ? { gracePeriodDays: dto.gracePeriodDays }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            updatedBy: scope.userId,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Šablon ${id}`);
        return { data: await tx.maintTask.findUnique({ where: { id } }) };
      },
    );
  }

  /** DELETE šablona (CASCADE briše maint_checks istoriju — 1.0 preporučuje active=false). */
  async deleteTask(email: string, id: string) {
    return this.wum30(
      email,
      async (tx) => {
        const exists = (await tx.maintTask.count({ where: { id } })) > 0;
        const { count } = await tx.maintTask.deleteMany({ where: { id } });
        this.assertAffected(exists, count, `Šablon ${id}`);
        return { data: { ok: true } };
      },
      // ── 3.0 ── `maint_tasks_delete`: erp_admin ∨ chief/admin.
      async (tx, scope) => {
        this.gejt(this.az.canWriteCatalog(scope), "maint_tasks_delete");
        const exists = (await tx.maintTask.count({ where: { id } })) > 0;
        const { count } = await tx.maintTask.deleteMany({ where: { id } });
        this.assertAffected(exists, count, `Šablon ${id}`);
        return { data: { ok: true } };
      },
    );
  }

  /** Kreiraj (ili vrati postojeći) WO iz preventivnog šablona (RPC; anti-duplikat u DB). */
  createPreventiveWorkOrder(email: string, taskId: string) {
    return this.wum30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ wo: string | null }[]>(
          Prisma.sql`SELECT public.maint_create_preventive_work_order(${taskId}::uuid) AS wo`,
        );
        return { data: { woId: rows[0]?.wo ?? null } };
      },
      // ── 3.0 ── Gejt (technician+), 🔴 anti-duplikat („nalog za ovaj šablon koji
      // NIJE otkazan → vrati postojeći") i `preventive_auto_wo` trag su UNUTAR
      // prepisa. Broj naloga dodeljuje DB triger `trg_maint_wo_assign_number`.
      async (tx, scope) => ({
        data: {
          woId: await this.fns.createPreventiveWorkOrder(tx, scope, taskId),
        },
      }),
    );
  }

  createCheck(email: string, dto: CreateCheckDto) {
    return this.idem30(
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
      // ── 3.0 ── `maint_checks_insert` CHECK: performed_by = ja ∧ mašina vidljiva.
      async (tx, scope) => {
        this.gejt(
          this.az.canCreateCheck(scope, scope.userId, dto.machineCode),
          "maint_checks_insert",
        );
        return tx.maintCheck.create({
          data: {
            taskId: dto.taskId,
            machineCode: dto.machineCode,
            performedBy: scope.userId,
            result: dto.result,
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
    return this.idem30(
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
      // ── 3.0 ─────────────────────────────────────────────────────────────
      // 🔴 ČETIRI TRIGERA IZ sy15 KOJIH U 3.0 BAZI NEMA — sva četiri se zovu
      // ODAVDE, redom kojim ih je baza izvršavala. Zaobići bilo koji znači tih
      // gubitak: kvar bez traga, KRITIČAN kvar bez auto-naloga, major/critical
      // kvar bez ijednog obaveštenja. Ništa ne pukne — samo podatak nedostaje.
      async (tx, scope) => {
        // `maint_incidents_insert` CHECK je SAMO `reported_by = auth.uid()`:
        // prijava kvara je NAMERNO otvorena celoj firmi (§2.5.4).
        this.gejt(
          this.az.canReportIncident(scope, scope.userId),
          "maint_incidents_insert",
        );
        // 1) BEFORE INSERT — denormalizacija sredstva.
        const polja = await this.fns.incidentSetAssetFields(tx, {
          machineCode: dto.machineCode,
          assetId: dto.assetId ?? null,
        });
        const inc = await tx.maintIncident.create({
          data: {
            machineCode: polja.machineCode ?? dto.machineCode,
            assetId: polja.assetId,
            // Triger prepisuje tip samo kad je sredstvo NAŠAO; inače ostaje ono
            // što je klijent poslao (izvor tada ne dira NEW).
            assetType: polja.assetType ?? dto.assetType ?? null,
            reportedBy: scope.userId,
            title: dto.title,
            description: dto.description ?? null,
            severity: dto.severity,
            safetyMarker: dto.safetyMarker === true,
            status: "open",
            attachmentUrls: [],
          },
        });
        // 2) AFTER INSERT — revizioni trag (`created`, TAČNO jedan red).
        await this.fns.incidentLogChanges(tx, {
          incidentId: inc.id,
          actor: scope.userId,
          op: "INSERT",
          neu: { status: inc.status, assignedTo: inc.assignedTo },
        });
        // 3) AFTER INSERT — auto radni nalog (critical → rok 8 h, status
        //    `potvrden`, prioritet `p1_zastoj`; sve iz `maint_settings`).
        await this.fns.incidentAutocreateWorkOrder(tx, {
          id: inc.id,
          machineCode: inc.machineCode,
          assetId: inc.assetId,
          severity: inc.severity,
          safetyMarker: inc.safetyMarker,
          title: inc.title,
          description: inc.description,
          reportedBy: inc.reportedBy,
          assignedTo: inc.assignedTo,
          workOrderId: inc.workOrderId,
        });
        // 4) AFTER INSERT — outbox obaveštenja (bez pravila i dalje JEDAN
        //    `in_app` red; bez toga bi kvar prošao nemo).
        await this.fns.incidentEnqueueNotify(tx, {
          id: inc.id,
          machineCode: inc.machineCode,
          assetId: inc.assetId,
          assetType: inc.assetType,
          severity: inc.severity,
          status: inc.status,
          title: inc.title,
          reportedBy: inc.reportedBy,
          assignedTo: inc.assignedTo,
        });
        return { id: inc.id };
      },
    );
  }

  async updateIncident(email: string, id: string, dto: UpdateIncidentDto) {
    return this.wum30(
      email,
      async (tx) => {
        const exists = (await tx.maintIncident.count({ where: { id } })) > 0;
        const uid = await this.uid(tx);
        // CHECK (u closed samo maint_can_close_incident) presuđuje DB → 23514/42501.
        const { count } = await tx.maintIncident.updateMany({
          where: { id },
          data: {
            ...(dto.status !== undefined
              ? { status: dto.status as never }
              : {}),
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
      },
      // ── 3.0 ─────────────────────────────────────────────────────────────
      // `maint_incidents_update` USING: red vidljiv ∧ (erp_admin_or_management ∨
      // erp_admin ∨ profil technician/chief/admin) — to je TAČNO izraz koji nosi
      // `canUpdateWorkOrder` (deljen predikat „tehničar naviše", isti u sy15).
      // WITH CHECK dodaje close-gate: u `closed` samo `maint_can_close_incident`.
      async (tx, scope) => {
        const stari = await tx.maintIncident.findUnique({
          where: { id },
          select: {
            machineCode: true,
            assetId: true,
            status: true,
            assignedTo: true,
            asset: { select: { assetType: true } },
          },
        });
        if (!stari) throw new NotFoundException(`Kvar ${id} ne postoji`);
        this.gejt(
          this.az.incidentRowVisible(scope, {
            machineCode: stari.machineCode,
            asset: stari.assetId
              ? {
                  assetType: stari.asset?.assetType ?? "machine",
                  machineCode: stari.machineCode,
                }
              : null,
          }) && this.az.canUpdateWorkOrder(scope),
          "maint_incidents_update",
        );
        if (dto.status === "closed") {
          this.gejt(
            this.az.canCloseIncident(scope),
            "maint_incidents_update (close-gate)",
          );
        }
        const noviAssignedTo = this.id30(dto.assignedTo, "assignedTo");
        await tx.maintIncident.update({
          where: { id },
          data: {
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(noviAssignedTo !== undefined
              ? { assignedTo: noviAssignedTo }
              : {}),
            ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
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
            updatedBy: scope.userId,
            updatedAt: new Date(),
          },
        });
        // 🔴 AFTER UPDATE `maint_incidents_log_changes` — status i dodela se
        // pišu u `maint_incident_events`. U 3.0 to NEMA trigger.
        await this.fns.incidentLogChanges(tx, {
          incidentId: id,
          actor: scope.userId,
          op: "UPDATE",
          old: { status: stari.status, assignedTo: stari.assignedTo },
          neu: {
            status: dto.status ?? stari.status,
            assignedTo:
              noviAssignedTo !== undefined ? noviAssignedTo : stari.assignedTo,
          },
        });
        return { data: await tx.maintIncident.findUnique({ where: { id } }) };
      },
    );
  }

  /** Ručni komentar/tok incidenta. Idempotentan po clientEventId (dupli-klik ≠ dupli event). */
  createIncidentEvent(email: string, id: string, dto: IncidentEventDto) {
    return this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-incident-event",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintIncidentEvent.create({
          data: {
            incidentId: id,
            actor: uid,
            eventType: dto.eventType,
            comment: dto.comment ?? null,
            fromValue: dto.fromValue ?? null,
            toValue: dto.toValue ?? null,
          },
        });
      },
      // ── 3.0 ── `maint_inc_events_insert` CHECK: postoji incident čija je mašina
      // vidljiva ∧ (actor IS NULL ∨ actor = ja). Actor je uvek pozivalac.
      async (tx, scope) => {
        const inc = await tx.maintIncident.findUnique({
          where: { id },
          select: { machineCode: true },
        });
        if (!inc) throw new NotFoundException(`Kvar ${id} ne postoji`);
        this.gejt(
          this.az.machineVisible(scope, inc.machineCode),
          "maint_inc_events_insert",
        );
        return tx.maintIncidentEvent.create({
          data: {
            incidentId: id,
            actor: scope.userId,
            eventType: dto.eventType,
            comment: dto.comment ?? null,
            fromValue: dto.fromValue ?? null,
            toValue: dto.toValue ?? null,
          },
        });
      },
    );
  }

  /**
   * Foto incidenta (presuda F3): upload bajtova u bucket, pa `maint_attach_incident_files`
   * RPC (reported_by = auth.uid() putanja) — NE direktni PATCH attachment_urls koji tiho
   * pada za prijavioce bez WO/incident-UPDATE prava. Putanja = 1.0-kompatibilna
   * (`${machineCode}/${uuid}_${safeName}`, kao uploadMaintMachineFile).
   *
   * Format se presuđuje po SADRŽAJU pre ijednog upload-a (`common/attachments`).
   * Ranije ovde nije bilo NIKAKVE provere: sirov HEIC sa telefona odlazio je u bucket
   * i ostajao trajno nevidljiv (prikaz je `<img>`), a `content-type` u bucketu je bio
   * onaj koji je klijent prijavio. Sada: cela serija se proverava pre prvog bajta —
   * ili sve prolazi, ili se ništa ne otprema (bez orphan fajlova u bucketu).
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
    const checked = assertAttachments(files, {
      hint: "Kvar je prijavljen — prijavu ne unosite ponovo; ispravite fotografiju pa je priložite uz istu prijavu.",
    });
    // machine_code incidenta (za 1.0-kompatibilnu putanju); RLS SELECT presuđuje vidljivost.
    const machineCode = await this.wum30(
      email,
      async (tx) => {
        const inc = await tx.maintIncident.findUnique({
          where: { id },
          select: { machineCode: true },
        });
        // Reporter možda NE VIDI svoj incident (F6) → fallback na "incident/<id>".
        return inc?.machineCode ?? `incident/${id}`;
      },
      // ── 3.0 ── isti fallback; putanja u bucketu ostaje 1.0-kompatibilna.
      // 🔴 Scope NIJE kozmetika: pod sy15 je RLS `maint_incidents` SELECT vraćao
      // `null` prijaviocu koji svoj incident NE vidi (F6), pa su fotografije
      // odlazile pod `incident/<id>/…`. Bez ovog isečka bi ista prijava pod 3.0
      // dobila pravu šifru mašine i raspored bajtova u bucketu bi se tiho
      // razišao između dva izvora — a authz i dalje presuđuje `fns` prepis.
      async (tx, scope) => {
        const inc = await tx.maintIncident.findFirst({
          where: {
            id,
            ...((this.az.incidentListWhere(scope) ??
              {}) as P30.MaintIncidentWhereInput),
          },
          select: { machineCode: true },
        });
        return inc?.machineCode ?? `incident/${id}`;
      },
    );
    const paths: string[] = [];
    for (const { file: f, contentType } of checked) {
      const uuid = randomUUID().replace(/-/g, "").slice(0, 12);
      const p = `${machineCode}/${uuid}_${this.safeFileName(f.originalname)}`;
      await this.storage.upload(
        MAINT_BUCKET,
        p,
        new Uint8Array(f.buffer),
        contentType,
        false,
      );
      paths.push(p);
    }
    const ok = await this.wum30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ ok: boolean }[]>(
          Prisma.sql`SELECT public.maint_attach_incident_files(${id}::uuid, ${paths}::text[]) AS ok`,
        );
        return rows[0]?.ok === true;
      },
      // ── 3.0 ── 🔴 Najskrivenije pravilo modula (`reported_by = ja`, bez ijedne
      // role) je UNUTAR prepisa i vraća `false` umesto greške — zato se ovde ne
      // duplira, a orphan bajtovi se čiste ispod, isto kao pod sy15.
      async (tx, scope) => this.fns.attachIncidentFiles(tx, scope, id, paths),
    );
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
    return this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-work-order",
      async (tx) => {
        // Otpisano/arhivirano sredstvo ne prima NOVE naloge (zahtev 037/26). Picker ga
        // već ne nudi (`listAssets(activeOnly)`), ali API mora da drži pravilo i kad
        // asset_id stigne iz starog taba, deep-linka ili direktnog poziva.
        const asset = await tx.maintAsset.findUnique({
          where: { assetId: dto.assetId },
          select: { archivedAt: true, name: true },
        });
        if (asset?.archivedAt)
          throw new UnprocessableEntityException(
            `Sredstvo „${asset.name}" je otpisano — novi radni nalog nije moguć. Vratite ga u upotrebu ili izaberite drugo.`,
          );
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
            // Trošak već pri KREIRANJU: servis se najčešće unosi unazad, sa računom
            // u ruci — terati čoveka da prvo napravi nalog pa ga ponovo otvara da
            // upiše cenu je bio glavni razlog što cena nije ni unošena.
            costTotal: dto.costTotal ?? null,
            estimatedCost: dto.estimatedCost ?? null,
            externalServicerName: dto.externalServicerName?.trim() || null,
            odometerKmAtService: dto.odometerKmAtService ?? null,
          },
        });
      },
      // ── 3.0 ── `maint_wo_insert` CHECK: reported_by = ja ∧ sredstvo vidljivo ∧
      // (erp_admin_or_management ∨ profil operator/technician/chief/admin).
      // 🔴 `wo_number` dodeljuje DB triger `trg_maint_wo_assign_number` (JESTE
      // prenet) — ovde se NE generiše; dupla dodela bi potrošila brojač.
      async (tx, scope) => {
        const asset = await tx.maintAsset.findUnique({
          where: { assetId: dto.assetId },
          select: {
            archivedAt: true,
            name: true,
            assetType: true,
            machine: { select: { machineCode: true } },
          },
        });
        // Nepostojeći `asset_id` je LOŠ PODATAK, ne uskraćeno pravo: u sy15 je
        // INSERT padao na FK (23503) → 422. Bez ove provere `assetVisible(…,
        // null)` = false pa bi 3.0 na istu grešku vratio 403 i FE bi javio
        // „nemate pravo" umesto „sredstvo ne postoji".
        if (!asset) {
          throw new UnprocessableEntityException(
            `Sredstvo ${dto.assetId} ne postoji`,
          );
        }
        this.gejt(
          this.az.canCreateWorkOrder(scope, scope.userId) &&
            this.az.assetVisible(scope, {
              assetType: asset.assetType,
              machineCode: asset.machine?.machineCode ?? null,
            }),
          "maint_wo_insert",
        );
        if (asset.archivedAt)
          throw new UnprocessableEntityException(
            `Sredstvo „${asset.name}" je otpisano — novi radni nalog nije moguć. Vratite ga u upotrebu ili izaberite drugo.`,
          );
        return tx.maintWorkOrder.create({
          data: {
            type: dto.type,
            assetId: dto.assetId,
            assetType: dto.assetType,
            title: dto.title,
            description: dto.description ?? null,
            priority: dto.priority,
            safetyMarker: dto.safetyMarker === true,
            status: "novi",
            reportedBy: scope.userId,
            dueAt: this.toDbTs(dto.dueAt) ?? null,
            sourceIncidentId: dto.sourceIncidentId ?? null,
            costTotal: dto.costTotal ?? null,
            estimatedCost: dto.estimatedCost ?? null,
            externalServicerName: dto.externalServicerName?.trim() || null,
            odometerKmAtService: dto.odometerKmAtService ?? null,
          },
        });
      },
    );
  }

  /** Kanban status/dodela/prioritet/rok/closure. wo_events piše trigger — NE dupliramo. */
  async updateWorkOrder(email: string, id: string, dto: UpdateWorkOrderDto) {
    return this.wum30(
      email,
      async (tx) => {
        const current = await tx.maintWorkOrder.findUnique({
          where: { woId: id },
          select: { startedAt: true, completedAt: true },
        });
        const exists = current !== null;
        const uid = await this.uid(tx);
        // Pečatiranje prelaza statusa (audit MEDIUM; 1.0 pečatira KLIJENT — skriveno pravilo 9,
        // maintWorkOrdersPanel.js:367-368/754): u_radu → started_at (samo ako DTO ga ne nosi i
        // još nije pečatiran), zavrsen → completed_at (samo ako DTO ga ne nosi I još nije
        // pečatiran — 1.0 `st==='zavrsen' && !wo.completed_at`). Bez `!current?.completedAt`
        // čuvara ponovljeni „zavrsen" PATCH bi pregazio originalni završetak (kvari
        // downtime/trošak/kompletiranje izveštaje) — simetrično sa stampStarted.
        const stampStarted =
          dto.status === "u_radu" &&
          dto.startedAt === undefined &&
          !current?.startedAt;
        const stampCompleted =
          dto.status === "zavrsen" &&
          dto.completedAt === undefined &&
          !current?.completedAt;
        const { count } = await tx.maintWorkOrder.updateMany({
          where: { woId: id },
          data: {
            ...(dto.status !== undefined
              ? { status: dto.status as never }
              : {}),
            ...(dto.priority !== undefined
              ? { priority: dto.priority as never }
              : {}),
            ...(dto.assignedTo !== undefined
              ? { assignedTo: dto.assignedTo }
              : {}),
            ...(dto.dueAt !== undefined
              ? { dueAt: this.toDbTs(dto.dueAt) }
              : {}),
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
            ...(dto.costTotal !== undefined
              ? { costTotal: dto.costTotal }
              : {}),
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
            ...(stampStarted ? { startedAt: new Date() } : {}),
            ...(stampCompleted ? { completedAt: new Date() } : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Radni nalog ${id}`);
        const wo = await tx.maintWorkOrder.findUnique({ where: { woId: id } });
        return {
          data: wo ? { ...wo, group: WO_GROUP[wo.status] ?? null } : null,
        };
      },
      // ── 3.0 ─────────────────────────────────────────────────────────────
      // `maint_wo_update` USING: red vidljiv ∧ (erp_admin_or_management ∨ profil
      // technician/chief/admin). Uz to TRI trigera koja u 3.0 nemaju parnjaka u
      // bazi: trag izmena (BEFORE U) i zatvaranje roka plana servisa (AFTER U ×2).
      async (tx, scope) => {
        const current = await tx.maintWorkOrder.findUnique({
          where: { woId: id },
          select: {
            startedAt: true,
            completedAt: true,
            status: true,
            assignedTo: true,
            reportedBy: true,
            priority: true,
            servicePlanId: true,
            assetServicePlanId: true,
            odometerKmAtService: true,
            asset: {
              select: {
                assetType: true,
                machine: { select: { machineCode: true } },
              },
            },
          },
        });
        if (!current)
          throw new NotFoundException(`Radni nalog ${id} ne postoji`);
        this.gejt(
          this.az.woRowVisible(scope, {
            assignedTo: current.assignedTo,
            reportedBy: current.reportedBy,
            asset: {
              assetType: current.asset.assetType,
              machineCode: current.asset.machine?.machineCode ?? null,
            },
          }) && this.az.canUpdateWorkOrder(scope),
          "maint_wo_update",
        );

        const noviAssignedTo = this.id30(dto.assignedTo, "assignedTo");
        // 🔴 BEFORE UPDATE `maint_wo_log_field_changes` — PRE upisa, sa starim
        // vrednostima. Bez njega nalog menja status bez ijednog reda u
        // `maint_wo_events` (u 3.0 taj trigger NE POSTOJI).
        await this.fns.woLogFieldChanges(tx, {
          woId: id,
          actor: scope.userId,
          old: {
            status: current.status,
            assignedTo: current.assignedTo,
            priority: current.priority,
          },
          neu: {
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(noviAssignedTo !== undefined
              ? { assignedTo: noviAssignedTo }
              : {}),
            ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          },
        });

        const stampStarted =
          dto.status === "u_radu" &&
          dto.startedAt === undefined &&
          !current.startedAt;
        const stampCompleted =
          dto.status === "zavrsen" &&
          dto.completedAt === undefined &&
          !current.completedAt;
        await tx.maintWorkOrder.update({
          where: { woId: id },
          data: {
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
            ...(noviAssignedTo !== undefined
              ? { assignedTo: noviAssignedTo }
              : {}),
            ...(dto.dueAt !== undefined
              ? { dueAt: this.toDbTs(dto.dueAt) }
              : {}),
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
            ...(dto.costTotal !== undefined
              ? { costTotal: dto.costTotal }
              : {}),
            ...(dto.estimatedCost !== undefined
              ? { estimatedCost: dto.estimatedCost }
              : {}),
            ...(dto.safetyMarker !== undefined
              ? { safetyMarker: dto.safetyMarker }
              : {}),
            ...(dto.vehicleServiceCategory !== undefined
              ? { vehicleServiceCategory: dto.vehicleServiceCategory }
              : {}),
            ...(dto.odometerKmAtService !== undefined
              ? { odometerKmAtService: dto.odometerKmAtService }
              : {}),
            ...(dto.externalServicerName !== undefined
              ? { externalServicerName: dto.externalServicerName }
              : {}),
            ...(stampStarted ? { startedAt: new Date() } : {}),
            ...(stampCompleted ? { completedAt: new Date() } : {}),
            updatedBy: scope.userId,
            updatedAt: new Date(),
          },
        });

        const wo = await tx.maintWorkOrder.findUnique({ where: { woId: id } });
        // AFTER UPDATE ×2 — zatvaranje roka plana servisa (vozilo i sredstvo).
        // Okidaju SAMO na PRELAZ u `zavrsen`; oba čuvara su unutar prepisa.
        if (wo) {
          await this.fns.woVehicleServicePlanCompletion(tx, {
            servicePlanId: wo.servicePlanId,
            status: wo.status,
            oldStatus: current.status,
            completedAt: wo.completedAt,
            odometerKmAtService: wo.odometerKmAtService,
            updatedBy: wo.updatedBy,
          });
          await this.fns.woAssetServicePlanCompletion(
            tx,
            {
              assetServicePlanId: wo.assetServicePlanId,
              status: wo.status,
              oldStatus: current.status,
              completedAt: wo.completedAt,
            },
            scope.userId,
          );
        }
        return {
          data: wo ? { ...wo, group: WO_GROUP[wo.status] ?? null } : null,
        };
      },
    );
  }

  async deleteWorkOrder(email: string, id: string) {
    return this.wum30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintWorkOrder.count({ where: { woId: id } })) > 0;
        const { count } = await tx.maintWorkOrder.deleteMany({
          where: { woId: id },
        });
        this.assertAffected(exists, count, `Radni nalog ${id}`);
        return { data: { ok: true } };
      },
      // ── 3.0 ── `maint_wo_delete` USING: erp_admin_or_management ∨ chief/admin.
      // ⚠️ To je ŠIRE od `canUpdateWorkOrder` (bez `technician`) — brisanje naloga
      // nije isto pravo kao izmena; predikat je `canWriteStock` (isti izraz).
      async (tx, scope) => {
        this.gejt(this.az.canWriteStock(scope), "maint_wo_delete");
        const exists =
          (await tx.maintWorkOrder.count({ where: { woId: id } })) > 0;
        const { count } = await tx.maintWorkOrder.deleteMany({
          where: { woId: id },
        });
        this.assertAffected(exists, count, `Radni nalog ${id}`);
        return { data: { ok: true } };
      },
    );
  }

  /** Ručni WO komentar/prelaz. Idempotentan po clientEventId (dupli-klik ≠ dupli event). */
  createWoEvent(email: string, id: string, dto: WorkOrderEventDto) {
    return this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-wo-event",
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: uid,
            eventType: dto.eventType,
            comment: dto.comment ?? null,
            fromValue: dto.fromValue ?? null,
            toValue: dto.toValue ?? null,
          },
        });
      },
      // ── 3.0 ── `maint_wo_events_write` CHECK: nalog vidljiv ∧ tehničar naviše.
      async (tx, scope) => {
        await this.assertWoWritable30(tx, scope, id, "maint_wo_events_write");
        return tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: scope.userId,
            eventType: dto.eventType,
            comment: dto.comment ?? null,
            fromValue: dto.fromValue ?? null,
            toValue: dto.toValue ?? null,
          },
        });
      },
    );
  }

  /**
   * Zajednički gejt dece naloga (`maint_wo_events` / `_parts` / `_labor`, i
   * `wo_id` grana `maint_stock_movements_insert`): red naloga mora biti vidljiv
   * pozivaocu I pozivalac mora biti tehničar naviše. Isti `EXISTS` podupit stoji
   * u sve četiri sy15 politike — zato je ovde jedan helper, ne četiri prepisa.
   */
  private async assertWoWritable30(
    tx: OdrzavanjeTx,
    scope: MaintScope,
    woId: string,
    politika: string,
  ): Promise<void> {
    const wo = await tx.maintWorkOrder.findUnique({
      where: { woId },
      select: {
        assignedTo: true,
        reportedBy: true,
        asset: {
          select: {
            assetType: true,
            machine: { select: { machineCode: true } },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${woId} ne postoji`);
    this.gejt(
      this.az.woRowVisible(scope, {
        assignedTo: wo.assignedTo,
        reportedBy: wo.reportedBy,
        asset: {
          assetType: wo.asset.assetType,
          machineCode: wo.asset.machine?.machineCode ?? null,
        },
      }) && this.az.canUpdateWorkOrder(scope),
      politika,
    );
  }

  /**
   * Dodaj deo na WO (H5). Kad je zadat kataloški `partId` I `quantity > 0`, u ISTOJ
   * transakciji se upisuje i „out" kretanje zaliha (`maint_part_stock_movements`,
   * created_by=auth.uid(), wo_id, quantity) — paritet 1.0 klijentske sprege
   * (maintWorkOrdersPanel.js:677-705). Ledger je INSERT-only, zaliha SME u minus
   * (skriveno pravilo 16 — bez donje granice). Dodatno se piše `user_note` audit event.
   * Sve atomarno: ako RLS odbije kretanje/event, ceo unos se poništi (za razliku od 1.0
   * gde su bili 3 nezavisna zahteva) — svesno pojačanje (H5 = pouzdana potrošnja delova).
   */
  createWoPart(email: string, id: string, dto: WorkOrderPartDto) {
    return this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-wo-part",
      async (tx) => {
        const uid = await this.uid(tx);
        // Kad je izabran KATALOŠKI deo (partId), katalog je AUTORITATIVAN za naziv i
        // jed.cenu (paritet 1.0 :686 `selectedPart?.name || partName`, :689/:702
        // `selectedPart.unit_cost` — 1.0 NEMA ručni unit_cost za kataloški deo). BE
        // razrešava maint_parts server-side umesto da veruje DTO vrednostima → tačna
        // „Vrednost zaliha" (insert-only ledger) i sačuvani naziv bez obzira na FE.
        // Slobodan unos (bez partId) zadržava DTO polja (unit_cost = 2.0 nadogradnja).
        const catalog = dto.partId
          ? await tx.maintPart.findUnique({
              where: { partId: dto.partId },
              select: { name: true, unit: true, unitCost: true },
            })
          : null;
        const partName = (catalog?.name ?? dto.partName).trim();
        const unit = dto.unit?.trim() || catalog?.unit || null; // 1.0 :680 typed || katalog
        const unitCost = catalog
          ? (catalog.unitCost ?? null)
          : (dto.unitCost ?? null);
        const row = await tx.maintWoPart.create({
          data: {
            woId: id,
            partName,
            partId: dto.partId ?? null,
            quantity: dto.quantity ?? null,
            unit,
            unitCost,
            supplier: dto.supplier ?? null,
          },
        });
        if (dto.partId && dto.quantity != null && dto.quantity > 0) {
          const wo = await tx.maintWorkOrder.findUnique({
            where: { woId: id },
            select: { woNumber: true },
          });
          await tx.maintPartStockMovement.create({
            data: {
              partId: dto.partId,
              woId: id,
              movementType: "out" as never,
              quantity: dto.quantity,
              unitCost,
              note: `WO ${wo?.woNumber ?? id}: ${partName}`,
              createdBy: uid,
            },
          });
        }
        await tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: uid,
            eventType: "user_note",
            comment: `Dodat deo: ${partName}`,
          },
        });
        return row;
      },
      // ── 3.0 ─────────────────────────────────────────────────────────────
      // `maint_wo_parts_all` CHECK + `maint_stock_movements_insert` CHECK dele
      // isti izraz (nalog vidljiv ∧ tehničar naviše ∧ created_by = ja).
      // 🔴 `current_stock += delta` NEMA trigger u 3.0 — postoji SAMO u
      // `applyPartStockMovement`. Bez tog poziva ledger raste, a zaliha stoji.
      async (tx, scope) => {
        await this.assertWoWritable30(tx, scope, id, "maint_wo_parts_all");
        const catalog = dto.partId
          ? await tx.maintPart.findUnique({
              where: { partId: dto.partId },
              select: { name: true, unit: true, unitCost: true },
            })
          : null;
        const partName = (catalog?.name ?? dto.partName).trim();
        const unit = dto.unit?.trim() || catalog?.unit || null;
        const unitCost = catalog
          ? (catalog.unitCost ?? null)
          : (dto.unitCost ?? null);
        const row = await tx.maintWoPart.create({
          data: {
            woId: id,
            partName,
            partId: dto.partId ?? null,
            quantity: dto.quantity ?? null,
            unit,
            unitCost,
            supplier: dto.supplier ?? null,
          },
        });
        if (dto.partId && dto.quantity != null && dto.quantity > 0) {
          const wo = await tx.maintWorkOrder.findUnique({
            where: { woId: id },
            select: { woNumber: true },
          });
          await tx.maintPartStockMovement.create({
            data: {
              partId: dto.partId,
              woId: id,
              movementType: "out",
              quantity: dto.quantity,
              unitCost,
              note: `WO ${wo?.woNumber ?? id}: ${partName}`,
              createdBy: scope.userId,
            },
          });
          // AFTER INSERT `maint_apply_part_stock_movement` — u istoj transakciji,
          // kao u sy15. Zaliha SME u minus (skriveno pravilo 16).
          await this.fns.applyPartStockMovement(tx, {
            partId: dto.partId,
            movementType: "out",
            quantity: dto.quantity,
          });
        }
        await tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: scope.userId,
            eventType: "user_note",
            comment: `Dodat deo: ${partName}`,
          },
        });
        return row;
      },
    );
  }

  /** Dodaj vreme rada (labor) na WO + `user_note` audit event (paritet 1.0 :729-735). */
  createWoLabor(email: string, id: string, dto: WorkOrderLaborDto) {
    if (!Number.isFinite(dto.minutes) || dto.minutes <= 0) {
      throw new UnprocessableEntityException("Minuti rada moraju biti > 0");
    }
    return this.idem30(
      email,
      dto.clientEventId,
      "odrzavanje.create-wo-labor",
      async (tx) => {
        const uid = await this.uid(tx);
        const minutes = Math.round(dto.minutes);
        const row = await tx.maintWoLabor.create({
          data: {
            woId: id,
            technicianId: uid,
            minutes,
            notes: dto.notes ?? null,
          },
        });
        await tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: uid,
            eventType: "user_note",
            comment: `Dodato vreme rada: ${minutes} min${
              dto.notes ? ` — ${dto.notes}` : ""
            }`,
          },
        });
        return row;
      },
      // ── 3.0 ── `maint_wo_labor_all` CHECK: nalog vidljiv ∧ tehničar naviše.
      async (tx, scope) => {
        await this.assertWoWritable30(tx, scope, id, "maint_wo_labor_all");
        const minutes = Math.round(dto.minutes);
        const row = await tx.maintWoLabor.create({
          data: {
            woId: id,
            technicianId: scope.userId,
            minutes,
            notes: dto.notes ?? null,
          },
        });
        await tx.maintWoEvent.create({
          data: {
            woId: id,
            actor: scope.userId,
            eventType: "user_note",
            comment: `Dodato vreme rada: ${minutes} min${
              dto.notes ? ` — ${dto.notes}` : ""
            }`,
          },
        });
        return row;
      },
    );
  }

  // ==========================================================================
  // SKRETNICA UPISNOG PUTA (sy15 ↔ 3.0) za vozila, vozače i zalihe
  // ==========================================================================
  //
  // `runIdem` (gore) je skretnica za IDEMPOTENTNE „create" akcije, a `tri30` +
  // `scope30` (gore, uz čitanja) su zajednički temelj 3.0 grane. Ovde je ono što
  // je UPISU svojstveno:
  //
  //   1. `withUser30` — parnjak `runIdem`-a za sve OSTALE upise (PATCH / DELETE /
  //      upsert / RPC), u JEDNOJ 3.0 transakciji;
  //   2. `idem30` — `runIdem` predaje `fn30` samo `tx`, a skoro svaki 3.0 upis uz
  //      `tx` traži i `MaintScope`; ovaj omotač ga učitava UNUTAR transakcije
  //      (ponovljen zahtev sa istim ključem ga i ne izvršava).
  //
  // 🔴 Zašto se scope čita a ne pretpostavlja: u sy15 su prava sprovodile 102 RLS
  // politike pod `SET LOCAL ROLE authenticated`. 3.0 nema RLS — kad gejt izostane,
  // prava TIHO nestaju: upis prolazi, samo upisuje red koji sy15 nikad ne bi primila.

  /**
   * Ne-idempotentan upis — JEDAN ulaz za oba izvora, isto kao `runIdem`.
   *
   *   `ODRZAVANJE_IZVOR=sy15` (PODRAZUMEVANO) — `withUserMapped` (RLS presuđuje red).
   *   `ODRZAVANJE_IZVOR=3.0`                  — `fn30` u 3.0 transakciji, sa
   *                                             učitanim `MaintScope`-om.
   *
   * 🔴 Prisustvo `fn30` je OZNAKA DA JE PUTANJA PRENETA (isto pravilo kao kod
   * `runIdem`): bez njega putanja pod `3.0` i dalje pada sa 503 — to je brana,
   * ne kvar. Zato `withUserMapped` (koji nosi `assertPorted`) ostaje netaknut.
   *
   * 🔴 SVE u JEDNOJ transakciji: u sy15 su ovi upisi bili jedna naredba plus
   * AFTER trigeri iz iste transakcije. Prepis mora zadržati atomičnost, inače
   * npr. `maint_part_stock_movements` red ostane bez `current_stock` korekcije.
   */
  // ⚠️ DVA tipska parametra, ne jedan: `Sy15Tx` i `OdrzavanjeTx` su klijenti DVE
  // Prisma šeme, pa isti red ima različit tip (`updated_by` je `uuid` u sy15,
  // `Int` u 3.0). Zajednički `T` bi zato bio greška prevoda na svakoj putanji
  // koja vraća red. Pozivalac dobija uniju — a to i JESTE istina o odgovoru.
  private async withUser30<T, U = T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
    fn30?: (tx: OdrzavanjeTx, s: MaintScope) => Promise<U>,
    opts?: { timeoutMs?: number },
  ): Promise<T | U> {
    // `tri30` je ISTA kapija kao kod čitanja: prekidač na `3.0` I sve tri
    // zavisnosti prisutne. Uz nju `fn30` — bez tela 3.0 grane putanja NIJE
    // preneta i pod `3.0` pada na 503 (brana, ne kvar).
    if (fn30 && this.tri30) {
      const { db } = this.tri();
      try {
        const s = await this.scope30(email);
        return await db.$transaction(
          async (tx) => fn30(tx, s),
          opts?.timeoutMs != null ? { timeout: opts.timeoutMs } : undefined,
        );
      } catch (e) {
        this.rethrowSy15(e);
      }
    }
    // Pod `sy15` — netaknuto. Pod `3.0` bez `fn30` (ili bez zavisnosti) —
    // `withUserMapped` odmah baca 503 kroz `assertPorted`.
    return this.withUserMapped(email, fn);
  }

  /**
   * Tipski most `fn30` → `runIdem`. `MaintScope` NE čita — njega učitava
   * `runIdem` PRE nego što otvori transakciju registra idempotencije (v. tamo:
   * čitanje scope-a iz transakcije traži drugu konekciju i pod opterećenjem
   * zaključava pool).
   *
   * ⚠️ Kast `as T` je JEDINO mesto gde se gubi tipska veza sy15↔3.0 reda, i tu
   * je namerno: `runIdem` (zajednički za ceo modul) traži da obe grane vrate
   * ISTI tip, a 3.0 red to po konstrukciji nije (v. `withUser30`). Odgovor
   * klijentu je JSON i oblik mu pinuju spec-ovi, ne prevodilac.
   */
  private idemMost30<T>(
    fn30: (tx: OdrzavanjeTx, s: MaintScope) => Promise<unknown>,
  ): (tx: IdempotencyTx, s: MaintScope) => Promise<T> {
    return async (tx, s) => (await fn30(tx, s)) as T;
  }

  /** Jedan izraz za `RAISE EXCEPTION 'Nemaš ovlašćenje…'` iz sy15 funkcija. */
  private assert30(ok: boolean, poruka: string): void {
    if (!ok) throw new ForbiddenException(poruka);
  }

  /** `NULLIF(x, '')` iz sy15 funkcija — prazan string je NULL, ne vrednost. */
  private prazanUNull(v?: string | null): string | null {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  }

  /**
   * `maint_asset_visible(asset_id)` nad KONKRETNIM redom — u sy15 ga je nosio
   * `USING` svake SELECT politike, pa ga upis nije morao pisati. Vraća `false`
   * i kad sredstva nema (tada pozivalac dobija 404, ne 403).
   */
  private async assetVidljivo30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    assetId: string,
  ): Promise<boolean> {
    const a = await tx.maintAsset.findUnique({
      where: { assetId },
      select: { assetType: true, machine: { select: { machineCode: true } } },
    });
    if (!a) return false;
    return this.az.assetVisible(s, {
      assetType: a.assetType,
      machineCode: a.machine?.machineCode ?? null,
    });
  }

  /**
   * Zajednička brana upisa nad sredstvom: 404 kad ga nema, 403 kad nije vidljivo
   * ili pozivalac nema pravo pisanja. Redosled je bitan — „nema ga" se ne sme
   * prikazati kao „nemaš pravo" (i obrnuto: tuđe sredstvo se ne sme odati).
   */
  private async assertAssetWrite30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    assetId: string,
    what: string,
  ): Promise<void> {
    const postoji = (await tx.maintAsset.count({ where: { assetId } })) > 0;
    if (!postoji) throw new NotFoundException(`${what} ne postoji`);
    if (!(await this.assetVidljivo30(tx, s, assetId))) {
      throw new ForbiddenException(`Nemate pravo nad: ${what}`);
    }
    this.assert30(this.az.canWriteStock(s), `Nemate pravo nad: ${what}`);
  }

  // ---------- Vozila (RPC create/archive/restore + details + pod-entiteti) ----------

  createVehicle(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_vehicle",
      "create-vehicle",
      "vehicle",
    );
  }
  createItAsset(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_it_asset",
      "create-it-asset",
      "it",
    );
  }
  createFacility(email: string, dto: CreateMaintAssetDto) {
    return this.createAssetViaRpc(
      email,
      dto,
      "create_maint_facility",
      "create-facility",
      "facility",
    );
  }

  private createAssetViaRpc(
    email: string,
    dto: CreateMaintAssetDto,
    fn: string,
    action: string,
    kind: "vehicle" | "it" | "facility",
  ) {
    return this.runIdem(
      email,
      dto.clientEventId,
      `odrzavanje.${action}`,
      async (tx) => {
        // Argumenti su TEXT (fn potpisi su text) — kast u enum radi SAMA fn.
        // Živa create_maint_vehicle je taj kast propuštala → 42804 na svakom
        // kreiranju vozila (04.08.2026); fix + pin:
        // docs/migration/FIX_VOZILA_CREATE_STATUS_CAST.sql (schema.spec pinuje kast).
        const rows = await tx.$queryRaw<{ id: string | null }[]>(
          Prisma.sql`SELECT public.${Prisma.raw(fn)}(
          ${dto.assetCode.trim()}, ${dto.name.trim()}, ${dto.status ?? "running"},
          ${dto.manufacturer ?? null}, ${dto.model ?? null}, ${dto.serialNumber ?? null},
          ${dto.supplier ?? null}, ${dto.assetNotes ?? null},
          ${JSON.stringify(dto.details ?? {})}::jsonb) AS id`,
        );
        return { assetId: rows[0]?.id ?? null };
      },
      {
        fn30: this.idemMost30((tx, s) => this.createAsset30(tx, s, dto, kind)),
      },
    );
  }

  /**
   * 3.0 prepis `create_maint_vehicle` / `create_maint_it_asset` /
   * `create_maint_facility` (izvor: `docs/design/authz-snapshots/talasF-fn-defs-2026-07-12.sql`).
   *
   * Sve tri funkcije imaju ISTI oblik: gejt → dve validacije → `maint_assets`
   * INSERT → `maint_*_details` INSERT, atomski. Zato je ovde jedan prepis sa tri
   * grane detalja, a ne tri kopije.
   *
   * 🔴 `NULLIF(x, '')` iz izvora znači: PRAZAN STRING JE NULL. Prepis koji bi
   * upisao `''` napravio bi red koji izgleda popunjeno a nije — i `COALESCE`
   * provere nizvodno (npr. „ima li tablice") bi ga primile kao vrednost.
   */
  private async createAsset30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    dto: CreateMaintAssetDto,
    kind: "vehicle" | "it" | "facility",
  ): Promise<{ assetId: string | null }> {
    const naziv =
      kind === "vehicle" ? "vozila" : kind === "it" ? "IT opreme" : "objekta";
    this.assert30(
      this.az.canWriteStock(s),
      `Nemaš ovlašćenje za kreiranje ${naziv} (potreban je ERP admin/menadzment ili maint chief/admin)`,
    );
    const assetCode = (dto.assetCode ?? "").trim();
    const name = (dto.name ?? "").trim();
    if (!assetCode)
      throw new UnprocessableEntityException(`Šifra ${naziv} je obavezna`);
    if (!name)
      throw new UnprocessableEntityException(`Naziv ${naziv} je obavezan`);

    const asset = await tx.maintAsset.create({
      data: {
        assetType: kind,
        assetCode,
        name,
        // `COALESCE(NULLIF(p_status, ''), 'running')`
        status: (dto.status ?? "").trim() || "running",
        manufacturer: this.prazanUNull(dto.manufacturer),
        model: this.prazanUNull(dto.model),
        serialNumber: this.prazanUNull(dto.serialNumber),
        supplier: this.prazanUNull(dto.supplier),
        notes: this.prazanUNull(dto.assetNotes),
        active: true,
        updatedBy: s.userId,
      },
      select: { assetId: true },
    });

    const d: Record<string, unknown> = dto.details ?? {};
    if (kind === "vehicle") {
      await tx.maintVehicleDetails.create({
        data: {
          assetId: asset.assetId,
          ...this.pickVehicleDetails(d),
          updatedBy: s.userId,
        },
      });
    } else if (kind === "it") {
      await tx.maintItAssetDetails.create({
        data: {
          assetId: asset.assetId,
          ...this.pickItDetails(d),
          updatedBy: s.userId,
        },
      });
    } else {
      await tx.maintFacilityDetails.create({
        data: {
          assetId: asset.assetId,
          ...this.pickFacilityDetails(d),
          // ✅ Kolona koje u sy15 NEMA (v. `upsertFacilityDetails`) — pod `3.0`
          // se objekat konačno može sačuvati sa katastarskim parcelama.
          cadastralParcels: this.pickCadastralParcels(d),
          updatedBy: s.userId,
        },
      });
    }
    return { assetId: asset.assetId };
  }

  archiveVehicle(email: string, assetId: string, reason: string) {
    return this.rpcBool(
      email,
      "archive_maint_vehicle",
      Prisma.sql`${assetId}::uuid, ${reason}`,
      (tx, s) =>
        this.arhivirajSredstvo30(tx, s, assetId, reason, ["vehicle"], {
          gejt: "Nemaš ovlašćenje za arhiviranje vozila",
          razlog:
            "Razlog arhiviranja je obavezan (npr. prodato, rashodovano, vraćeno leasingu)",
        }),
    );
  }
  restoreVehicle(email: string, assetId: string) {
    return this.rpcBool(
      email,
      "restore_maint_vehicle",
      Prisma.sql`${assetId}::uuid`,
      (tx, s) =>
        this.vratiSredstvo30(
          tx,
          s,
          assetId,
          ["vehicle"],
          "Nemaš ovlašćenje za vraćanje vozila u upotrebu",
        ),
    );
  }
  /** archive/restore IT+objekti (isti RPC za oba; guard asset_type IN it/facility). */
  archiveAsset(email: string, assetId: string, reason: string) {
    return this.rpcBool(
      email,
      "archive_maint_asset",
      Prisma.sql`${assetId}::uuid, ${reason}`,
      (tx, s) =>
        this.arhivirajSredstvo30(tx, s, assetId, reason, ["it", "facility"], {
          gejt: "Nemaš ovlašćenje za arhiviranje sredstva",
          razlog: "Razlog arhiviranja je obavezan",
        }),
    );
  }
  restoreAsset(email: string, assetId: string) {
    return this.rpcBool(
      email,
      "restore_maint_asset",
      Prisma.sql`${assetId}::uuid`,
      (tx, s) =>
        this.vratiSredstvo30(
          tx,
          s,
          assetId,
          ["it", "facility"],
          "Nemaš ovlašćenje za vraćanje sredstva u upotrebu",
        ),
    );
  }

  /**
   * 3.0 prepis `archive_maint_vehicle` / `archive_maint_asset`.
   * ⚠️ `archived_at = COALESCE(archived_at, now())` — ponovljeno arhiviranje NE
   * pomera datum otpisa (prepis, ne previd); menja se samo razlog i akter.
   */
  private async arhivirajSredstvo30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    assetId: string,
    reason: string,
    tipovi: string[],
    poruke: { gejt: string; razlog: string },
  ): Promise<boolean> {
    this.assert30(this.az.canWriteStock(s), poruke.gejt);
    if (!assetId)
      throw new UnprocessableEntityException("asset_id je obavezan");
    if (!reason || reason.trim().length === 0)
      throw new UnprocessableEntityException(poruke.razlog);
    const red = await tx.maintAsset.findFirst({
      where: { assetId, assetType: { in: tipovi } },
      select: { archivedAt: true },
    });
    if (!red) return false; // `ROW_COUNT = 0` -> `RETURN false`, ne greška
    const { count } = await tx.maintAsset.updateMany({
      where: { assetId, assetType: { in: tipovi } },
      data: {
        archivedAt: red.archivedAt ?? new Date(),
        archiveReason: reason.trim(),
        archivedBy: s.userId,
        active: false,
        updatedBy: s.userId,
        updatedAt: new Date(),
      },
    });
    return count > 0;
  }

  /** 3.0 prepis `restore_maint_vehicle` / `restore_maint_asset`. */
  private async vratiSredstvo30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    assetId: string,
    tipovi: string[],
    gejt: string,
  ): Promise<boolean> {
    this.assert30(this.az.canWriteStock(s), gejt);
    const { count } = await tx.maintAsset.updateMany({
      where: { assetId, assetType: { in: tipovi } },
      data: {
        archivedAt: null,
        archiveReason: null,
        archivedBy: null,
        active: true,
        updatedBy: s.userId,
        updatedAt: new Date(),
      },
    });
    return count > 0;
  }

  private rpcBool(
    email: string,
    fn: string,
    args: Prisma.Sql,
    fn30?: (tx: OdrzavanjeTx, s: MaintScope) => Promise<boolean>,
  ) {
    return this.withUser30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ ok: boolean }[]>(
          Prisma.sql`SELECT public.${Prisma.raw(fn)}(${args}) AS ok`,
        );
        return { data: { ok: rows[0]?.ok === true } };
      },
      fn30 ? async (tx, s) => ({ data: { ok: await fn30(tx, s) } }) : undefined,
    );
  }

  /**
   * PATCH core `maint_assets` reda (HIGH#2 paritet 1.0 `patchMaintAsset`) — vozilo/IT/objekat.
   * `location_id`/`responsible_user_id` create RPC NE prima → ovo je jedini put da se postave
   * (1.0 to radi naknadnim patch-om). `null` = unassign; undefined = ne diraj. Row-odluka
   * (asset_visible ∧ erp/chief/admin — `maint_assets_update` RLS) presuđuje DB (42501→403).
   */
  async patchAssetCore(email: string, assetId: string, dto: PatchAssetCoreDto) {
    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.manufacturer !== undefined
        ? { manufacturer: dto.manufacturer }
        : {}),
      ...(dto.model !== undefined ? { model: dto.model } : {}),
      ...(dto.serialNumber !== undefined
        ? { serialNumber: dto.serialNumber }
        : {}),
      ...(dto.supplier !== undefined ? { supplier: dto.supplier } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists = (await tx.maintAsset.count({ where: { assetId } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintAsset.updateMany({
          where: { assetId },
          data: {
            ...patch,
            ...(dto.status !== undefined
              ? { status: dto.status as never }
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
      },
      async (tx, s) => {
        // 🔴 `maint_assets_update` je UŽE od ostalih write politika sredstva:
        // `maint_is_erp_admin() ∨ chief/admin` — BEZ menadzment/magacioner.
        // Zato ovde `canWriteCatalog`, a NE `canWriteStock` (koji važi za detalje).
        const exists = (await tx.maintAsset.count({ where: { assetId } })) > 0;
        if (!exists)
          throw new NotFoundException(`Sredstvo ${assetId} ne postoji`);
        this.assert30(
          this.az.canWriteCatalog(s),
          `Nemate pravo nad: Sredstvo ${assetId}`,
        );
        const { count } = await tx.maintAsset.updateMany({
          where: { assetId },
          data: {
            ...patch,
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            // 🔴 `responsible_user_id` je ISTI ŠAV kao `auth_user_id` vozača:
            // uuid u sy15, `users.id` (Int) u 3.0. `null` = razduži.
            ...(dto.responsibleUserId !== undefined
              ? {
                  responsibleUserId:
                    dto.responsibleUserId == null
                      ? null
                      : this.profileUserId30(dto.responsibleUserId),
                }
              : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Sredstvo ${assetId}`);
        return { data: await tx.maintAsset.findUnique({ where: { assetId } }) };
      },
    );
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

  /**
   * Allowlist kolona `maint_it_asset_details` — JEDAN izvor za create i upsert.
   *
   * ⚠️ ŠIRI JE OD sy15 `create_maint_it_asset` (koji zna samo 13 polja): kolone
   * 065/066/067 i 071 (cpu, ram, toner, UPS…) u sy15 postoje ali ih CREATE fn
   * ne upisuje, pa ih je korisnik morao uneti drugi put kroz „izmeni". Pod `3.0`
   * ih upisuje i create — to je NADSKUP, bez gubitka i bez promene prava.
   */
  private pickItDetails(d: Record<string, unknown>) {
    const s = (k: string) =>
      d[k] == null || d[k] === "" ? null : String(d[k]);
    return {
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
      // Polja po tipu uređaja (065 računar / 066 štampač / 067 switch) —
      // kolone dodate kroz ZAHTEV_065_066_067_IT_OPREMA_POLJA.sql.
      cpu: s("cpu"),
      motherboard: s("motherboard"),
      ram: s("ram"),
      gpu: s("gpu"),
      officeLocation: s("office_location"),
      tonerCartridges: s("toner_cartridges"),
      unifiPorts: s("unifi_ports"),
      // Zahtev 071 (UPS snaga / firmver mrežne opreme) —
      // kolone dodate kroz ZAHTEV_071_IT_OPREMA_UPS_AP.sql.
      powerRating: s("power_rating"),
      firmwareVersion: s("firmware_version"),
    };
  }

  /**
   * Allowlist kolona `maint_facility_details` — SAMO 14 kolona koje postoje i u
   * sy15. „Katastarske parcele" NISU ovde namerno: ta kolona u sy15 NE POSTOJI
   * (v. `upsertFacilityDetails`), pa bi je sy15 grana oborila sa 42703 → 500.
   * 3.0 grana je dodaje posebno.
   */
  private pickFacilityDetails(d: Record<string, unknown>) {
    const s = (k: string) =>
      d[k] == null || d[k] === "" ? null : String(d[k]);
    const n = (k: string) =>
      d[k] == null || d[k] === "" ? null : Number(d[k]);
    return {
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
    };
  }

  /** „Katastarske parcele" — POSTOJI SAMO u 3.0 (v. `upsertFacilityDetails`). */
  private pickCadastralParcels(d: Record<string, unknown>): string | null {
    const v = d["cadastral_parcels"];
    if (typeof v !== "string") return null;
    return v.trim() === "" ? null : v;
  }

  /** Upsert details vozila (PK asset_id; paritet upsertMaintVehicleDetails). */
  async upsertVehicleDetails(
    email: string,
    assetId: string,
    dto: DetailsUpsertDto,
  ) {
    return this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        const base = {
          ...this.pickVehicleDetails(dto.details),
          updatedBy: uid,
        };
        const row = await tx.maintVehicleDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
      async (tx, s) => {
        // `maint_vehicle_details_insert/update` CHECK: asset_visible ∧ write krug.
        await this.assertAssetWrite30(tx, s, assetId, `Vozilo ${assetId}`);
        const base = {
          ...this.pickVehicleDetails(dto.details),
          updatedBy: s.userId,
        };
        const row = await tx.maintVehicleDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
    );
  }

  patchVehicleTollTag(email: string, assetId: string, dto: TollTagDto) {
    return this.withUser30(
      email,
      async (tx) => {
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
      },
      async (tx, s) => {
        await this.assertAssetWrite30(tx, s, assetId, `Vozilo ${assetId}`);
        const exists =
          (await tx.maintVehicleDetails.count({ where: { assetId } })) > 0;
        const { count } = await tx.maintVehicleDetails.updateMany({
          where: { assetId },
          data: {
            tollTagSerial: dto.tollTagSerial ?? null,
            tollTagProvider: dto.tollTagProvider ?? null,
            tollTagNotes: dto.tollTagNotes ?? null,
            updatedBy: s.userId,
          },
        });
        this.assertAffected(exists, count, `Detalji vozila ${assetId}`);
        return { data: { ok: true } };
      },
    );
  }

  patchVehicleShelf(email: string, assetId: string, dto: ShelfDto) {
    const patch = {
      ...(dto.hasPartsSet !== undefined
        ? { hasPartsSet: dto.hasPartsSet }
        : {}),
      ...(dto.partsShelf !== undefined
        ? { partsShelf: dto.partsShelf || null }
        : {}),
      ...(dto.partsNotes !== undefined
        ? { partsNotes: dto.partsNotes || null }
        : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleDetails.count({ where: { assetId } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintVehicleDetails.updateMany({
          where: { assetId },
          data: { ...patch, updatedBy: uid },
        });
        this.assertAffected(exists, count, `Detalji vozila ${assetId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        await this.assertAssetWrite30(tx, s, assetId, `Vozilo ${assetId}`);
        const exists =
          (await tx.maintVehicleDetails.count({ where: { assetId } })) > 0;
        const { count } = await tx.maintVehicleDetails.updateMany({
          where: { assetId },
          data: { ...patch, updatedBy: s.userId },
        });
        this.assertAffected(exists, count, `Detalji vozila ${assetId}`);
        return { data: { ok: true } };
      },
    );
  }

  // ---------- Foto vozila (storage proxy F2-P4a; 1.0-kompatibilne putanje) ----------

  /**
   * Upload glavne fotografije vozila (paritet 1.0 uploadVehiclePhoto → uploadMaintDocument):
   *   1) `maint_documents` red (entity_type='asset', category='vehicle_photo') pod RLS-om,
   *      na 1.0-kompatibilnu putanju `documents/asset/<assetId>/<uuid>_<safeName>` (meta PRE
   *      bajtova → bez orphan-a, isto kao uploadDocument/uploadMachineFile);
   *   2) upload bajtova u bucket `maint-machine-files`;
   *   3) upsert `maint_vehicle_details.primary_photo_storage_path` na tu putanju.
   * Vidljivost/pravo presuđuje sy15 RLS kroz `withUserRls` (asset SELECT + doc/details write).
   */
  async uploadVehiclePhoto(
    email: string,
    assetId: string,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException(
        "Očekivana slika (multipart `file`)",
      );
    }
    // Samo JPG/PNG: karton vozila prikazuje foto kroz `<img>`, pa PDF i HEIC nemaju
    // gde da se vide. Presuđuje sadržaj — `image/heic` etiketiran kao `image/jpeg`
    // je ranije prolazio kroz `startsWith("image/")` i ostajao nevidljiv zauvek.
    const { contentType } = assertAttachment(file, {
      allow: IMAGE_ATTACHMENT_FORMATS,
    });
    const uuid = randomUUID().replace(/-/g, "").slice(0, 16);
    const storagePath = `documents/asset/${assetId}/${uuid}_${this.safeFileName(file.originalname)}`;
    // Meta PRE bajtova: RLS INSERT enforce + provera da je asset VIDLJIVO vozilo
    // (findFirst assetType='vehicle' → 404 kad ne postoji/nevidljivo; paritet findVehicle).
    // 🔴 STORAGE OSTAJE U sy15 I POD `3.0` — menja se SAMO gde živi meta red.
    // Šema putanje (`documents/asset/<assetId>/<uuid>_<ime>`) se NE SME dirati:
    // stare fotografije su zapisane u `primary_photo_storage_path` i jedini način
    // da ih 3.0 nađe je da putanja ostane doslovno ista.
    const meta = await this.withUser30(
      email,
      async (tx) => {
        const asset = await tx.maintAsset.findFirst({
          where: { assetId, assetType: "vehicle" },
          select: { assetId: true },
        });
        if (!asset)
          throw new NotFoundException(
            `Vozilo ${assetId} ne postoji ili nije vidljivo`,
          );
        const uid = await this.uid(tx);
        return tx.maintDocument.create({
          data: {
            entityType: "asset" as never,
            entityId: assetId,
            assetId,
            fileName: file.originalname,
            storagePath,
            mimeType: contentType,
            sizeBytes: BigInt(file.buffer.length),
            category: "vehicle_photo",
            description: "Glavna fotografija vozila",
            uploadedBy: uid,
          },
        });
      },
      async (tx, s) => {
        const asset = await tx.maintAsset.findFirst({
          where: { assetId, assetType: "vehicle" },
          select: { assetId: true },
        });
        if (!asset)
          throw new NotFoundException(
            `Vozilo ${assetId} ne postoji ili nije vidljivo`,
          );
        // `maint_documents_insert` CHECK = uploaded_by = uid ∧ document_visible.
        await this.assertAssetWrite30(tx, s, assetId, `Vozilo ${assetId}`);
        return tx.maintDocument.create({
          data: {
            entityType: "asset",
            entityId: assetId,
            assetId,
            fileName: file.originalname,
            storagePath,
            mimeType: contentType,
            sizeBytes: BigInt(file.buffer.length),
            category: "vehicle_photo",
            description: "Glavna fotografija vozila",
            uploadedBy: s.userId,
          },
        });
      },
    );
    try {
      await this.storage.upload(
        MAINT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        contentType,
        false,
      );
    } catch (e) {
      await this.withUser30(
        email,
        async (tx) => {
          await tx.maintDocument.deleteMany({
            where: { documentId: meta.documentId },
          });
        },
        async (tx) => {
          await tx.maintDocument.deleteMany({
            where: { documentId: meta.documentId },
          });
        },
      ).catch(() => {});
      throw e;
    }
    // Postavi pointer glavne fotografije (paritet 1.0 PATCH primary_photo_storage_path).
    // Upsert jer details red praktično uvek postoji za vozilo, ali je bezbedno i kad ne.
    await this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        await tx.maintVehicleDetails.upsert({
          where: { assetId },
          create: {
            assetId,
            primaryPhotoStoragePath: storagePath,
            updatedBy: uid,
          },
          update: { primaryPhotoStoragePath: storagePath, updatedBy: uid },
        });
      },
      async (tx, s) => {
        await tx.maintVehicleDetails.upsert({
          where: { assetId },
          create: {
            assetId,
            primaryPhotoStoragePath: storagePath,
            updatedBy: s.userId,
          },
          update: { primaryPhotoStoragePath: storagePath, updatedBy: s.userId },
        });
      },
    );
    return {
      data: { ...this.withNumSize(meta), primaryPhotoStoragePath: storagePath },
    };
  }

  /**
   * Presigned URL glavne fotografije vozila (paritet 1.0 getVehiclePhotoSignedUrl, 1h).
   * 404 čisto kad vozilo nema fotografiju ili nije vidljivo (RLS SELECT presuđuje PRE potpisa).
   */
  async vehiclePhotoUrl(email: string, assetId: string) {
    const nemaVozila = () =>
      new NotFoundException(`Vozilo ${assetId} ne postoji ili nije vidljivo`);
    const path = await this.withUser30(
      email,
      async (tx) => {
        const asset = await tx.maintAsset.findFirst({
          where: { assetId, assetType: "vehicle" },
          select: { assetId: true },
        });
        if (!asset) throw nemaVozila();
        const details = await tx.maintVehicleDetails.findUnique({
          where: { assetId },
          select: { primaryPhotoStoragePath: true },
        });
        const p = details?.primaryPhotoStoragePath ?? null;
        if (!p) throw new NotFoundException("Vozilo nema fotografiju");
        return p;
      },
      async (tx, s) => {
        // Pod sy15 je vidljivost presudio RLS SELECT; u 3.0 mora eksplicitno,
        // PRE potpisivanja — potpisan URL zaobilazi svaku dalju proveru.
        const asset = await tx.maintAsset.findFirst({
          where: { assetId, assetType: "vehicle" },
          select: { assetId: true },
        });
        if (!asset) throw nemaVozila();
        if (!(await this.assetVidljivo30(tx, s, assetId))) throw nemaVozila();
        const details = await tx.maintVehicleDetails.findUnique({
          where: { assetId },
          select: { primaryPhotoStoragePath: true },
        });
        const p = details?.primaryPhotoStoragePath ?? null;
        if (!p) throw new NotFoundException("Vozilo nema fotografiju");
        return p;
      },
    );
    return { data: await this.storage.signUrl(MAINT_BUCKET, path, 3600) };
  }

  /**
   * Ukloni glavnu fotografiju vozila: skini pointer iz details + best-effort brisanje
   * bajtova (1.0 semantika — meta-pointer je izvor istine, blob je propratni). Idempotentno:
   * već-prazan pointer (ili nepostojeći details red) vraća `ok` bez greške.
   */
  async deleteVehiclePhoto(email: string, assetId: string) {
    const path = await this.withUser30(
      email,
      async (tx) => {
        const details = await tx.maintVehicleDetails.findUnique({
          where: { assetId },
          select: { primaryPhotoStoragePath: true },
        });
        const p = details?.primaryPhotoStoragePath ?? null;
        if (!p) return null; // nema šta da se ukloni — idempotentno ok
        const uid = await this.uid(tx);
        const { count } = await tx.maintVehicleDetails.updateMany({
          where: { assetId },
          data: { primaryPhotoStoragePath: null, updatedBy: uid },
        });
        // Red je vidljiv (findUnique ga vratio) ali UPDATE politika odbila → 403.
        if (count === 0)
          throw new ForbiddenException(
            `Nemate pravo nad: Foto vozila ${assetId}`,
          );
        return p;
      },
      async (tx, s) => {
        const details = await tx.maintVehicleDetails.findUnique({
          where: { assetId },
          select: { primaryPhotoStoragePath: true },
        });
        const p = details?.primaryPhotoStoragePath ?? null;
        if (!p) return null;
        await this.assertAssetWrite30(tx, s, assetId, `Foto vozila ${assetId}`);
        await tx.maintVehicleDetails.updateMany({
          where: { assetId },
          data: { primaryPhotoStoragePath: null, updatedBy: s.userId },
        });
        return p;
      },
    );
    if (path) await this.storage.remove(MAINT_BUCKET, path);
    return { data: { ok: true } };
  }

  // ---------- IT/objekti details upsert (allowlist) ----------

  async upsertItDetails(email: string, assetId: string, dto: DetailsUpsertDto) {
    const d = dto.details;
    return this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        const base = { ...this.pickItDetails(d), updatedBy: uid };
        const row = await tx.maintItAssetDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
      async (tx, s) => {
        await this.assertAssetWrite30(tx, s, assetId, `IT oprema ${assetId}`);
        const base = { ...this.pickItDetails(d), updatedBy: s.userId };
        const row = await tx.maintItAssetDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
    );
  }

  async upsertFacilityDetails(
    email: string,
    assetId: string,
    dto: DetailsUpsertDto,
  ) {
    const d = dto.details;
    // ═══════════════════════════════════════════════════════════════════
    // 🔴 ZATEČEN KVAR, POPRAVLJEN 06.08.2026 — „Objekti" NIKAD nisu radili
    // ═══════════════════════════════════════════════════════════════════
    // U sy15 grani je ovde stajalo `cadastralParcels: s("cadastral_parcels")`,
    // a kolone `cadastral_parcels` u ŽIVOJ sy15 NEMA — izmereno `pg_attribute`:
    // `maint_facility_details` tamo ima TAČNO 14 kolona i ta nije među njima.
    // Prisma je kolonu ipak slala u INSERT/UPDATE (model `prisma/sy15.prisma`
    // ju je deklarisao), baza je vraćala 42703, a `rethrowSy15` taj SQLSTATE
    // ne mapira → 500. Zato na produkciji `maint_assets` tipa `facility` ima
    // 0 redova i `maint_facility_details` 0 redova — modul Objekti nije mogao
    // da sačuva NIJEDAN red otkad postoji.
    //
    // ✅ POD `3.0` KOLONA POSTOJI (FE je nudi kao „Katastarske parcele"), pa je
    // 3.0 grana ISPOD i upisuje — preklop taj ekran usput popravlja u punom
    // obimu. sy15 grana je i dalje bez nje: tamo bi je oborila baza.
    return this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        const base = { ...this.pickFacilityDetails(d), updatedBy: uid };
        const row = await tx.maintFacilityDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
      async (tx, s) => {
        await this.assertAssetWrite30(tx, s, assetId, `Objekat ${assetId}`);
        const base = {
          ...this.pickFacilityDetails(d),
          cadastralParcels: this.pickCadastralParcels(d),
          updatedBy: s.userId,
        };
        const row = await tx.maintFacilityDetails.upsert({
          where: { assetId },
          create: { assetId, ...base },
          update: base,
        });
        return { data: row };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          // `maint_vehicle_tires_write` = asset_visible ∧ (erp adm/mgmt ∨ chief/admin).
          await this.assertAssetWrite30(tx, s, assetId, `Vozilo ${assetId}`);
          return tx.maintVehicleTire.create({
            data: {
              assetId,
              season: dto.season,
              dimension: dto.dimension,
              count: dto.count,
              status: dto.status ?? "koriscene",
              shelfCode: dto.shelfCode ?? null,
              installedOnVehicle: dto.installedOnVehicle === true,
              purchasedAt: this.toDbDate(dto.purchasedAt) ?? null,
              notes: dto.notes ?? null,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateTire(email: string, tireId: string, dto: UpdateTireDto) {
    const patch = {
      ...(dto.dimension !== undefined ? { dimension: dto.dimension } : {}),
      ...(dto.count !== undefined ? { count: dto.count } : {}),
      ...(dto.shelfCode !== undefined ? { shelfCode: dto.shelfCode } : {}),
      ...(dto.installedOnVehicle !== undefined
        ? { installedOnVehicle: dto.installedOnVehicle }
        : {}),
      ...(dto.purchasedAt !== undefined
        ? { purchasedAt: this.toDbDate(dto.purchasedAt) }
        : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleTire.count({ where: { tireSetId: tireId } })) >
          0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintVehicleTire.updateMany({
          where: { tireSetId: tireId },
          data: {
            ...patch,
            ...(dto.season !== undefined
              ? { season: dto.season as never }
              : {}),
            ...(dto.status !== undefined
              ? { status: dto.status as never }
              : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Guma ${tireId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const red = await tx.maintVehicleTire.findUnique({
          where: { tireSetId: tireId },
          select: { assetId: true },
        });
        if (!red) throw new NotFoundException(`Guma ${tireId} ne postoji`);
        await this.assertAssetWrite30(tx, s, red.assetId, `Guma ${tireId}`);
        await tx.maintVehicleTire.updateMany({
          where: { tireSetId: tireId },
          data: {
            ...patch,
            ...(dto.season !== undefined ? { season: dto.season } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  async deleteTire(email: string, tireId: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleTire.count({ where: { tireSetId: tireId } })) >
          0;
        const { count } = await tx.maintVehicleTire.deleteMany({
          where: { tireSetId: tireId },
        });
        this.assertAffected(exists, count, `Guma ${tireId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const red = await tx.maintVehicleTire.findUnique({
          where: { tireSetId: tireId },
          select: { assetId: true },
        });
        if (!red) throw new NotFoundException(`Guma ${tireId} ne postoji`);
        await this.assertAssetWrite30(tx, s, red.assetId, `Guma ${tireId}`);
        await tx.maintVehicleTire.deleteMany({ where: { tireSetId: tireId } });
        return { data: { ok: true } };
      },
    );
  }

  // ---------- Servisni plan vozila + generisanje WO ----------

  // `async` da bi i sinhrona validacija intervala izašla kao odbijeno obećanje —
  // pozivalac (controller/test) dobija JEDAN oblik greške, ne dva (073/26).
  async createVehicleServicePlan(
    email: string,
    assetId: string,
    dto: CreateVehicleServicePlanDto,
  ) {
    /* 073/26: `0` = korisnikov način da kaže „ne vodi se po tome" → NULL, ne greška.
       Ostaje samo pravilo koje i baza čuva (maint_vsp_at_least_one_interval) — plan
       bez ijednog intervala nikad ne bi dospeo, pa nikad ne bi ni napravio nalog. */
    const intervalKm = normalizeInterval(dto.intervalKm, "km") ?? null;
    const intervalMonths =
      normalizeInterval(dto.intervalMonths, "months") ?? null;
    assertAtLeastOneInterval({ intervalKm, intervalMonths });
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
            intervalKm,
            intervalMonths,
            lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
            lastDoneKm: dto.lastDoneKm ?? null,
            vehicleServiceCategory:
              (dto.vehicleServiceCategory as never) ?? null,
            priority: (dto.priority ?? "p4_planirano") as never,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            plannedCost: dto.plannedCost ?? null,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
      {
        fn30: this.idemMost30(async (tx, s) => {
          // `maint_vsp_insert` = erp adm/mgmt ∨ chief/admin (BEZ asset_visible).
          this.assert30(
            this.az.canWriteStock(s),
            "Nemate pravo nad: Plan servisa vozila",
          );
          return tx.maintVehicleServicePlan.create({
            data: {
              assetId,
              name: dto.name.trim(),
              intervalKm,
              intervalMonths,
              lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
              lastDoneKm: dto.lastDoneKm ?? null,
              vehicleServiceCategory: dto.vehicleServiceCategory ?? null,
              priority: dto.priority ?? "p4_planirano",
              notes: dto.notes ?? null,
              active: dto.active ?? true,
              plannedCost: dto.plannedCost ?? null,
              createdBy: s.userId,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateVehicleServicePlan(
    email: string,
    planId: string,
    dto: UpdateVehicleServicePlanDto,
  ) {
    /* 073/26: intervali se normalizuju PRE transakcije (0 → NULL = „ne vodi se po
       tome"), a pravilo „bar jedan interval" se proverava nad EFEKTIVNIM stanjem —
       izostavljen ključ zadržava staru vrednost, pa izmena imena ne sme da traži
       ponovni unos intervala. Bez ovoga je brisanje oba intervala udaralo pravo u
       DB CHECK i izlazilo kao sirova greška. */
    const patchKm = normalizeInterval(dto.intervalKm, "km");
    const patchMonths = normalizeInterval(dto.intervalMonths, "months");
    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(patchKm !== undefined ? { intervalKm: patchKm } : {}),
      ...(patchMonths !== undefined ? { intervalMonths: patchMonths } : {}),
      ...(dto.lastDoneAt !== undefined
        ? { lastDoneAt: this.toDbDate(dto.lastDoneAt) }
        : {}),
      ...(dto.lastDoneKm !== undefined ? { lastDoneKm: dto.lastDoneKm } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.plannedCost !== undefined
        ? { plannedCost: dto.plannedCost }
        : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const current = await tx.maintVehicleServicePlan.findUnique({
          where: { planId },
          select: { intervalKm: true, intervalMonths: true },
        });
        const exists = current !== null;
        if (exists) {
          assertAtLeastOneInterval(
            { intervalKm: patchKm, intervalMonths: patchMonths },
            current,
          );
        }
        const uid = await this.uid(tx);
        const { count } = await tx.maintVehicleServicePlan.updateMany({
          where: { planId },
          data: {
            ...patch,
            ...(dto.vehicleServiceCategory !== undefined
              ? { vehicleServiceCategory: dto.vehicleServiceCategory as never }
              : {}),
            ...(dto.priority !== undefined
              ? { priority: dto.priority as never }
              : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Plan servisa ${planId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const current = await tx.maintVehicleServicePlan.findUnique({
          where: { planId },
          select: { intervalKm: true, intervalMonths: true },
        });
        if (!current)
          throw new NotFoundException(`Plan servisa ${planId} ne postoji`);
        // 073/26 — pravilo „bar jedan interval" nad EFEKTIVNIM stanjem, PRE upisa.
        assertAtLeastOneInterval(
          { intervalKm: patchKm, intervalMonths: patchMonths },
          current,
        );
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Plan servisa ${planId}`,
        );
        await tx.maintVehicleServicePlan.updateMany({
          where: { planId },
          data: {
            ...patch,
            ...(dto.vehicleServiceCategory !== undefined
              ? { vehicleServiceCategory: dto.vehicleServiceCategory }
              : {}),
            ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  async deleteVehicleServicePlan(email: string, planId: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleServicePlan.count({ where: { planId } })) > 0;
        const { count } = await tx.maintVehicleServicePlan.deleteMany({
          where: { planId },
        });
        this.assertAffected(exists, count, `Plan servisa ${planId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintVehicleServicePlan.count({ where: { planId } })) > 0;
        if (!exists)
          throw new NotFoundException(`Plan servisa ${planId} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Plan servisa ${planId}`,
        );
        await tx.maintVehicleServicePlan.deleteMany({ where: { planId } });
        return { data: { ok: true } };
      },
    );
  }

  // ---------- AI: čitanje računa iz servisa (predlog, ne upis) ----------

  /**
   * Sa fotografije/PDF-a računa servisne radionice izvuče iznos, servisera, datum,
   * kilometražu i stavke. **Ništa ne upisuje** — vraća predlog koji čovek potvrđuje
   * običnim PATCH-om nad nalogom. Razlog: AI ne sme sam da menja novčani podatak, a
   * ovako i greška u čitanju ostaje bezopasna.
   *
   * `woId` služi samo kao provera prava (RLS SELECT nad nalogom) i za kontekst.
   */
  async readServiceInvoice(
    email: string,
    woId: string,
    files: Express.Multer.File[],
  ) {
    if (!this.ai) {
      throw new ServiceUnavailableException(
        "AI čitanje računa nije konfigurisano na serveru.",
      );
    }
    if (!files.length) {
      throw new UnprocessableEntityException(
        "Priloži bar jednu fotografiju ili PDF računa (multipart `files`).",
      );
    }
    if (files.length > RACUN_MAX_FAJLOVA) {
      throw new UnprocessableEntityException(
        `Najviše ${RACUN_MAX_FAJLOVA} fajlova po računu.`,
      );
    }
    // Pravo: ako korisnik ne sme da vidi nalog, ne sme ni da troši AI budžet na njega.
    const wo = await this.withUser30(
      email,
      async (tx) => {
        const row = await tx.maintWorkOrder.findUnique({
          where: { woId },
          select: { woId: true, title: true, assetId: true },
        });
        if (!row) throw new NotFoundException(`Radni nalog ${woId} ne postoji`);
        return row;
      },
      async (tx, s) => {
        const row = await tx.maintWorkOrder.findUnique({
          where: { woId },
          select: {
            woId: true,
            title: true,
            assetId: true,
            assignedTo: true,
            reportedBy: true,
            asset: {
              select: {
                assetType: true,
                machine: { select: { machineCode: true } },
              },
            },
          },
        });
        if (!row) throw new NotFoundException(`Radni nalog ${woId} ne postoji`);
        // `maint_wo_select` = `maint_wo_row_visible(asset, assigned, reported)`.
        const vidljiv = this.az.woRowVisible(s, {
          assignedTo: row.assignedTo,
          reportedBy: row.reportedBy,
          asset: row.asset
            ? {
                assetType: row.asset.assetType,
                machineCode: row.asset.machine?.machineCode ?? null,
              }
            : null,
        });
        if (!vidljiv)
          throw new NotFoundException(`Radni nalog ${woId} ne postoji`);
        return { woId: row.woId, title: row.title, assetId: row.assetId };
      },
    );

    const content: unknown[] = [
      {
        type: "text",
        text:
          `Račun se odnosi na radni nalog: ${fenceUserInput(wo.title)}.\n` +
          `Priloženo fajlova: ${files.length}. Pročitaj ih kao jedan račun ` +
          `(više strana istog dokumenta).`,
      },
    ];
    for (const f of files) {
      const b64 = f.buffer.toString("base64");
      if (b64.length > RACUN_MAX_FAJL_B64) {
        throw new UnprocessableEntityException(
          `„${f.originalname}" je prevelik (max ~4 MB po fajlu).`,
        );
      }
      const mime = f.mimetype ?? "";
      if (mime === RACUN_PDF_MIME) {
        content.push({
          type: "document",
          source: { type: "base64", media_type: RACUN_PDF_MIME, data: b64 },
        });
      } else if (RACUN_VISION_MIME.includes(mime)) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: b64 },
        });
      } else {
        throw new UnprocessableEntityException(
          `„${f.originalname}": dozvoljeni su PDF i slike (JPG, PNG, WEBP, GIF).`,
        );
      }
    }

    const envModel = process.env.ODRZAVANJE_RACUN_AI_MODEL ?? "";
    const fallback = (RACUN_AI_ALLOWED_MODELS as readonly string[]).includes(
      envModel,
    )
      ? envModel
      : RACUN_AI_DEFAULT_MODEL;
    // Registar (Podešavanja → AI modeli) ima prednost; bez njega ide env/podrazumevani.
    const resolved = this.policy
      ? await this.policy.resolve(AI_TASK.ODRZAVANJE_RACUN, fallback)
      : { model: fallback };
    const model = (RACUN_AI_ALLOWED_MODELS as readonly string[]).includes(
      resolved.model,
    )
      ? resolved.model
      : fallback;

    const res = await this.ai.extractWithTool({
      model,
      system: `${RACUN_AI_SYSTEM_PROMPT}\n\n${ODRZAVANJE_INJECTION_FENCE}`,
      tool: RACUN_AI_TOOL,
      content,
      maxTokens: 4000,
      // `ai_usage_log.user_id` je numerički ID iz GLAVNE baze; sy15 `auth.uid()` je
      // UUID i ne uklapa se — otud mapiranje po e-mailu (null = poziv se i dalje meri,
      // samo bez korisnika).
      ctx: {
        module: AI_MODULE.ODRZAVANJE_RACUN,
        userId: await this.appUserId(email),
      },
    });
    return {
      data: normalizeRacunOut(res.toolInput),
      meta: { model: res.model, usage: res.usage },
    };
  }

  /** e-mail → numerički `users.id` glavne baze (za merenje AI potrošnje). */
  private async appUserId(email: string): Promise<number | null> {
    if (!this.prisma) return null;
    try {
      const u = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      return u?.id ?? null;
    } catch {
      return null; // merenje ne sme da obori čitanje računa
    }
  }

  /**
   * Generiši WO iz overdue/due_soon plana vozila (RPC; anti-duplikat has_open_wo).
   * DB fn ne zna za `planned_cost` — posle nje prepisujemo očekivanu cenu iz plana u
   * `estimated_cost` novih naloga, da planirana cena ne ostane mrtav podatak. Radi se u
   * app sloju namerno: `ensure_vehicle_service_wos` je živa PROD funkcija koju ne diramo.
   */
  ensureVehicleServiceWos(email: string, assetId?: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ n: number }[]>(
          Prisma.sql`SELECT public.ensure_vehicle_service_wos(${assetId ?? null}::uuid) AS n`,
        );
        const created = Number(rows[0]?.n ?? 0);
        if (created > 0) await this.seedEstimatedCostFromPlan(tx, "vehicle");
        return { data: { created } };
      },
      async (tx, s) => {
        // 🔴 Idempotencija je U SAMOM prepisu (`has_open_wo = FALSE` u view-u):
        // drugi uzastopni poziv za isto sredstvo daje 0 novih naloga.
        const created = await this.fns.ensureVehicleServiceWos(tx, s, assetId);
        if (created > 0) await this.seedEstimatedCost30(tx, "vehicle");
        return { data: { created } };
      },
    );
  }

  /**
   * Prepiše `planned_cost` plan stavke u `estimated_cost` naloga koji su iz nje nastali,
   * ali još nemaju procenu. Idempotentno (uslov `estimated_cost IS NULL`) i usko:
   * dira samo otvorene naloge sa vezom na plan.
   */
  private async seedEstimatedCostFromPlan(
    tx: Sy15Tx,
    kind: "vehicle" | "asset",
  ): Promise<void> {
    const link =
      kind === "vehicle"
        ? Prisma.sql`wo.service_plan_id = p.plan_id`
        : Prisma.sql`wo.asset_service_plan_id = p.plan_id`;
    const table =
      kind === "vehicle"
        ? Prisma.sql`public.maint_vehicle_service_plan`
        : Prisma.sql`public.maint_asset_service_plan`;
    await tx.$executeRaw(Prisma.sql`
      UPDATE public.maint_work_orders wo
         SET estimated_cost = p.planned_cost
        FROM ${table} p
       WHERE ${link}
         AND p.planned_cost IS NOT NULL
         AND wo.estimated_cost IS NULL
         AND wo.status NOT IN ('zavrsen', 'otkazan')
    `);
  }

  /**
   * 3.0 parnjak `seedEstimatedCostFromPlan`. Isti SQL — imena tabela i kolona su
   * u 3.0 nepromenjena — ali drugi klijent (`OdrzavanjeTx`) i drugi `Prisma`
   * namespace, pa se metod ne može deliti sa sy15 granom.
   */
  private async seedEstimatedCost30(
    tx: OdrzavanjeTx,
    kind: "vehicle" | "asset",
  ): Promise<void> {
    const link =
      kind === "vehicle"
        ? P30.sql`wo.service_plan_id = p.plan_id`
        : P30.sql`wo.asset_service_plan_id = p.plan_id`;
    const table =
      kind === "vehicle"
        ? P30.sql`public.maint_vehicle_service_plan`
        : P30.sql`public.maint_asset_service_plan`;
    await tx.$executeRaw(P30.sql`
      UPDATE public.maint_work_orders wo
         SET estimated_cost = p.planned_cost
        FROM ${table} p
       WHERE ${link}
         AND p.planned_cost IS NOT NULL
         AND wo.estimated_cost IS NULL
         AND wo.status NOT IN ('zavrsen', 'otkazan')
    `);
  }

  // ---------- Delovi po vozilu (link/unlink/patch) ----------

  /**
   * `maint_pv_insert`/`maint_pv_update` = erp adm/mgmt ∨ chief/admin/**technician**.
   * ⚠️ ŠIRE od `canWriteStock` (tehničar sme da veže deo za vozilo), a
   * `maint_pv_delete` je UŽE (bez tehničara) — zato dva različita izraza.
   */
  private mozePisatiVezuDeoVozilo(s: MaintScope): boolean {
    return this.az.canWriteStock(s) || s.profileRole === "technician";
  }

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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(
            this.mozePisatiVezuDeoVozilo(s),
            "Nemate pravo nad: Veza deo↔vozilo",
          );
          return tx.maintPartVehicle.create({
            data: {
              assetId,
              partId: dto.partId,
              qtyMin: dto.qtyMin ?? null,
              notes: dto.notes ?? null,
              createdBy: s.userId,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updatePartVehicleLink(
    email: string,
    assetId: string,
    partId: string,
    dto: UpdatePartLinkDto,
  ) {
    const patch = {
      ...(dto.qtyMin !== undefined ? { qtyMin: dto.qtyMin } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintPartVehicle.updateMany({
          where: { assetId, partId },
          data: { ...patch, updatedBy: uid, updatedAt: new Date() },
        });
        this.assertAffected(exists, count, `Veza deo↔vozilo`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
        if (!exists) throw new NotFoundException(`Veza deo↔vozilo ne postoji`);
        this.assert30(
          this.mozePisatiVezuDeoVozilo(s),
          "Nemate pravo nad: Veza deo↔vozilo",
        );
        await tx.maintPartVehicle.updateMany({
          where: { assetId, partId },
          data: { ...patch, updatedBy: s.userId, updatedAt: new Date() },
        });
        return { data: { ok: true } };
      },
    );
  }

  async unlinkPartFromVehicle(email: string, assetId: string, partId: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
        const { count } = await tx.maintPartVehicle.deleteMany({
          where: { assetId, partId },
        });
        this.assertAffected(exists, count, `Veza deo↔vozilo`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintPartVehicle.count({ where: { assetId, partId } })) > 0;
        if (!exists) throw new NotFoundException(`Veza deo↔vozilo ne postoji`);
        // 🔴 `maint_pv_delete` NEMA tehničara — brisanje veze je uže od izmene.
        this.assert30(
          this.az.canWriteStock(s),
          "Nemate pravo nad: Veza deo↔vozilo",
        );
        await tx.maintPartVehicle.deleteMany({ where: { assetId, partId } });
        return { data: { ok: true } };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          // 🔴 `maint_booking_insert` je NAJŠIRA write politika modula:
          // erp adm/mgmt ∨ chief/admin/technician/**operator** — vozilo rezerviše
          // i operater. Sužavanje na `canWriteStock` bi oborilo carpool.
          this.assert30(
            this.az.canWriteStock(s) ||
              s.profileRole === "technician" ||
              s.profileRole === "operator",
            "Nemate pravo nad: Rezervacija vozila",
          );
          return tx.maintVehicleBooking.create({
            data: {
              assetId,
              driverId: dto.driverId ?? null,
              startAt: new Date(dto.startAt),
              endAt: new Date(dto.endAt),
              purpose: dto.purpose ?? null,
              status: dto.status ?? "planirana",
              notes: dto.notes ?? null,
              createdBy: s.userId,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateBooking(email: string, bookingId: string, dto: UpdateBookingDto) {
    const patch = {
      ...(dto.startAt !== undefined ? { startAt: new Date(dto.startAt) } : {}),
      ...(dto.endAt !== undefined ? { endAt: new Date(dto.endAt) } : {}),
      ...(dto.driverId !== undefined ? { driverId: dto.driverId } : {}),
      ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleBooking.count({ where: { bookingId } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintVehicleBooking.updateMany({
          where: { bookingId },
          data: {
            ...patch,
            ...(dto.status !== undefined
              ? { status: dto.status as never }
              : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Rezervacija ${bookingId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const red = await tx.maintVehicleBooking.findUnique({
          where: { bookingId },
          select: { createdBy: true },
        });
        if (!red)
          throw new NotFoundException(`Rezervacija ${bookingId} ne postoji`);
        // 🔴 „Moja rezervacija je moja" — `maint_booking_update` ima granu
        // `created_by = uid()`. Bez nje operater ne bi mogao da izmeni ni svoju.
        this.assert30(
          this.az.canUpdateBooking(s, red.createdBy),
          `Nemate pravo nad: Rezervacija ${bookingId}`,
        );
        await tx.maintVehicleBooking.updateMany({
          where: { bookingId },
          data: {
            ...patch,
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  async deleteBooking(email: string, bookingId: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintVehicleBooking.count({ where: { bookingId } })) > 0;
        const { count } = await tx.maintVehicleBooking.deleteMany({
          where: { bookingId },
        });
        this.assertAffected(exists, count, `Rezervacija ${bookingId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintVehicleBooking.count({ where: { bookingId } })) > 0;
        if (!exists)
          throw new NotFoundException(`Rezervacija ${bookingId} ne postoji`);
        // ⚠️ `maint_booking_delete` NEMA granu „moja rezervacija": brisanje je
        // uže od izmene (erp adm/mgmt ∨ chief/admin). Prepis doslovan.
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Rezervacija ${bookingId}`,
        );
        await tx.maintVehicleBooking.deleteMany({ where: { bookingId } });
        return { data: { ok: true } };
      },
    );
  }

  /** Ručni run rokova vozila (RPC; dedupe u DB → idempotentan). */
  vehicleDeadlineCheck(email: string, dto: DeadlineCheckDto) {
    return this.withUser30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<
          { enqueued: number; skipped: number }[]
        >(
          Prisma.sql`SELECT * FROM public.maint_check_vehicle_deadlines(${dto.lookaheadDays ?? 30}::int)`,
        );
        const r = rows[0];
        return {
          data: {
            enqueued: Number(r?.enqueued ?? 0),
            skipped: Number(r?.skipped ?? 0),
          },
        };
      },
      // ⚠️ Bez role-gejta — `maint_check_vehicle_deadlines` je u sy15 DEFINER
      // funkcija BEZ ijedne provere prava (izmereno u fn-defs snapshot-u); modul
      // gejtuje HTTP guard. Dodavanje gejta ovde bilo bi tiha promena ponašanja.
      //
      // 🔴 Dedupe je u `postojiRok` (entitet + `deadline_kind` + `deadline_date`
      // uz `status IN ('queued','sent')`) — dva uzastopna poziva za isti rok
      // upisuju TAČNO JEDAN red u `maint_notification_log`, drugi ide u `skipped`.
      // Bez toga bi vozači svakog dana dobijali isto obaveštenje.
      async (tx) => ({
        data: await this.fns.checkVehicleDeadlines(
          tx,
          dto.lookaheadDays ?? 30,
        ),
      }),
      // Tri petlje (vozila, vozači, dokumenta) + `enqueue` po nalazu probijaju
      // podrazumevanih 5 s Prisma transakcije na punom skupu.
      { timeoutMs: 60_000 },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(
            this.az.canWriteStock(s),
            "Nemate pravo nad: Vlasnik vozila",
          );
          return tx.maintVehicleOwner.create({
            data: {
              name: dto.name.trim(),
              ownerType: dto.ownerType ?? "spoljni",
              contact: dto.contact ?? null,
              notes: dto.notes ?? null,
              active: true,
              updatedBy: s.userId,
            },
          });
        }),
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          // 🔴 VOZAČ JE LIČNI PODATAK (JMBG, adresa, lekarski). `maint_drivers_insert`
          // = erp adm/mgmt ∨ chief/admin — UŽE od `maint_drivers_select`
          // (`canReadAllDrivers`, koji uključuje i tehničara/operatera).
          this.assert30(this.az.canWriteStock(s), "Nemate pravo nad: Vozač");
          // 🔴 `auth_user_id` je u 3.0 `users.id` (Int), a DTO nosi sy15 uuid.
          // Prevod ovde NE POSTOJI: spoljni vozač ionako nema nalog, a interni se
          // vezuje kroz `lookupEmployees` (numerički id). Zato se ne-numerička
          // vrednost odbija umesto da tiho padne u NULL i „odveže" vozača.
          const authUserId = this.authUserId30(dto.authUserId, dto.isInternal);
          return tx.maintDriver.create({
            data: {
              fullName: dto.fullName.trim(),
              isInternal: dto.isInternal !== false,
              authUserId,
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
              createdBy: s.userId,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  /**
   * `maint_drivers.auth_user_id`: u sy15 `auth.users.id` (uuid), u 3.0 `users.id`
   * (Int) — odluka 2 seobe. DTO je pisan za sy15, pa vrednost mora da se pročita
   * kao broj; sve što nije broj je greška, NIKAD tiho `null`.
   *
   * Spoljni vozač (`isInternal === false`) uvek dobija `null` — to je skriveno
   * pravilo 11 (DB CHECK), isto u obe baze.
   */
  private authUserId30(
    raw: string | null | undefined,
    isInternal: boolean | undefined,
  ): number | null {
    if (isInternal === false) return null;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!this.jeIdKorisnika30(n)) {
      throw new UnprocessableEntityException(
        `„${raw}" nije korisnički ID iz 3.0 baze (očekivan je broj) — izaberi zaposlenog iz liste`,
      );
    }
    return n;
  }

  async updateDriver(email: string, id: string, dto: UpdateDriverDto) {
    // Polja koja su ista u obe baze (bez `auth_user_id` — v. `authUserId30`).
    const patch = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
      ...(dto.isInternal !== undefined ? { isInternal: dto.isInternal } : {}),
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
        ? { medicalCheckValidUntil: this.toDbDate(dto.medicalCheckValidUntil) }
        : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.jmbg !== undefined ? { jmbg: dto.jmbg } : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
    // Skriveno pravilo 11 (DB CHECK): spoljni vozač NE sme imati auth_user_id.
    // Kad payload nosi is_internal=false → auth_user_id se forsira na null (paritet
    // insertMaintDriver, maintenance.js:2836); inače se postavlja ako je zadat (null = odveži).
    const diraAuthUserId =
      dto.isInternal === false || dto.authUserId !== undefined;
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        const uid = await this.uid(tx);
        const authUserIdPatch =
          dto.isInternal === false
            ? { authUserId: null }
            : dto.authUserId !== undefined
              ? { authUserId: dto.authUserId }
              : {};
        const { count } = await tx.maintDriver.updateMany({
          where: { driverId: id },
          data: {
            ...patch,
            ...authUserIdPatch,
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Vozač ${id}`);
        return {
          data: await tx.maintDriver.findUnique({ where: { driverId: id } }),
        };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Vozač ${id} ne postoji`);
        // `maint_drivers_update` = erp adm/mgmt ∨ chief/admin. 🔴 NIJE
        // `canReadAllDrivers`: tehničar/operater vozača VIDI, ali ga NE MENJA.
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Vozač ${id}`,
        );
        const authUserIdPatch = diraAuthUserId
          ? { authUserId: this.authUserId30(dto.authUserId, dto.isInternal) }
          : {};
        await tx.maintDriver.updateMany({
          where: { driverId: id },
          data: {
            ...patch,
            ...authUserIdPatch,
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return {
          data: await tx.maintDriver.findUnique({ where: { driverId: id } }),
        };
      },
    );
  }

  archiveDriver(email: string, id: string, reason: string) {
    return this.withUser30(
      email,
      async (tx) => {
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
      },
      async (tx, s) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Vozač ${id} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Vozač ${id}`,
        );
        await tx.maintDriver.updateMany({
          where: { driverId: id },
          data: {
            archivedAt: new Date(),
            archiveReason: reason.trim(),
            active: false,
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  restoreDriver(email: string, id: string) {
    return this.withUser30(
      email,
      async (tx) => {
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
      },
      async (tx, s) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Vozač ${id} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Vozač ${id}`,
        );
        await tx.maintDriver.updateMany({
          where: { driverId: id },
          data: {
            archivedAt: null,
            archiveReason: null,
            active: true,
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  /** Hard-delete vozača (RLS: erp adm/mgmt ∨ SAMO maint admin profil — chief NE, §2.5.9). */
  async deleteDriver(email: string, id: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        const { count } = await tx.maintDriver.deleteMany({
          where: { driverId: id },
        });
        this.assertAffected(exists, count, `Vozač ${id}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintDriver.count({ where: { driverId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Vozač ${id} ne postoji`);
        // 🔴 `maint_drivers_delete` je UŽE od izmene: erp adm/mgmt ∨ SAMO maint
        // `admin` profil — `chief` NE sme (§2.5.9). Zato `canDeleteDriver`, a ne
        // `canWriteStock`; brisanje vozača briše i PII trag zauvek.
        this.assert30(
          this.az.canDeleteDriver(s),
          `Nemate pravo nad: Vozač ${id}`,
        );
        await tx.maintDriver.deleteMany({ where: { driverId: id } });
        return { data: { ok: true } };
      },
    );
  }

  // ---------- Servisni plan IT/objekti + generisanje WO ----------

  async createAssetServicePlan(
    email: string,
    assetId: string,
    dto: CreateAssetServicePlanDto,
  ) {
    /* 073/26: `interval_months` je NOT NULL + CHECK > 0 — 0/prazno je do sada
       izlazilo kao sirova greška baze umesto poruke koja kaže šta da se uradi. */
    const intervalMonths = normalizeAssetIntervalMonths(dto.intervalMonths, {
      required: true,
    })!;
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
            intervalMonths,
            lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
            priority: (dto.priority ?? "p4_planirano") as never,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
            plannedCost: dto.plannedCost ?? null,
            createdBy: uid,
            updatedBy: uid,
          },
        });
      },
      {
        fn30: this.idemMost30(async (tx, s) => {
          // `maint_asp_write` je [ALL] politika: isti izraz za I/U/D.
          this.assert30(
            this.az.canWriteStock(s),
            "Nemate pravo nad: Plan servisa sredstva",
          );
          return tx.maintAssetServicePlan.create({
            data: {
              assetId,
              name: dto.name.trim(),
              intervalMonths,
              lastDoneAt: this.toDbDate(dto.lastDoneAt) ?? null,
              priority: dto.priority ?? "p4_planirano",
              notes: dto.notes ?? null,
              active: dto.active ?? true,
              plannedCost: dto.plannedCost ?? null,
              createdBy: s.userId,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateAssetServicePlan(
    email: string,
    planId: string,
    dto: UpdateAssetServicePlanDto,
  ) {
    const patchMonths = normalizeAssetIntervalMonths(dto.intervalMonths, {
      required: false,
    });
    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(patchMonths !== undefined ? { intervalMonths: patchMonths } : {}),
      ...(dto.lastDoneAt !== undefined
        ? { lastDoneAt: this.toDbDate(dto.lastDoneAt) }
        : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.plannedCost !== undefined
        ? { plannedCost: dto.plannedCost }
        : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintAssetServicePlan.updateMany({
          where: { planId },
          data: {
            ...patch,
            ...(dto.priority !== undefined
              ? { priority: dto.priority as never }
              : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Plan servisa ${planId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
        if (!exists)
          throw new NotFoundException(`Plan servisa ${planId} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Plan servisa ${planId}`,
        );
        await tx.maintAssetServicePlan.updateMany({
          where: { planId },
          data: {
            ...patch,
            ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return { data: { ok: true } };
      },
    );
  }

  async deleteAssetServicePlan(email: string, planId: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
        const { count } = await tx.maintAssetServicePlan.deleteMany({
          where: { planId },
        });
        this.assertAffected(exists, count, `Plan servisa ${planId}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintAssetServicePlan.count({ where: { planId } })) > 0;
        if (!exists)
          throw new NotFoundException(`Plan servisa ${planId} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Plan servisa ${planId}`,
        );
        await tx.maintAssetServicePlan.deleteMany({ where: { planId } });
        return { data: { ok: true } };
      },
    );
  }

  ensureAssetServiceWos(email: string, assetId?: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ n: number }[]>(
          Prisma.sql`SELECT public.ensure_asset_service_wos(${assetId ?? null}::uuid) AS n`,
        );
        const created = Number(rows[0]?.n ?? 0);
        if (created > 0) await this.seedEstimatedCostFromPlan(tx, "asset");
        return { data: { created } };
      },
      async (tx, s) => {
        // Idempotentno kao i vozilski parnjak: `has_open_wo = FALSE` u view-u.
        const created = await this.fns.ensureAssetServiceWos(tx, s, assetId);
        if (created > 0) await this.seedEstimatedCost30(tx, "asset");
        return { data: { created } };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(this.az.canWriteStock(s), "Nemate pravo nad: Deo");
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
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updatePart(email: string, id: string, dto: UpdatePartDto) {
    const patch = {
      ...(dto.partCode !== undefined ? { partCode: dto.partCode } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
      ...(dto.supplierId !== undefined ? { supplierId: dto.supplierId } : {}),
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
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintPart.count({ where: { partId: id } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintPart.updateMany({
          where: { partId: id },
          data: { ...patch, updatedBy: uid, updatedAt: new Date() },
        });
        this.assertAffected(exists, count, `Deo ${id}`);
        return {
          data: await tx.maintPart.findUnique({ where: { partId: id } }),
        };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintPart.count({ where: { partId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Deo ${id} ne postoji`);
        this.assert30(this.az.canWriteStock(s), `Nemate pravo nad: Deo ${id}`);
        await tx.maintPart.updateMany({
          where: { partId: id },
          data: { ...patch, updatedBy: s.userId, updatedAt: new Date() },
        });
        return {
          data: await tx.maintPart.findUnique({ where: { partId: id } }),
        };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          // `maint_stock_movements_insert` = created_by = uid ∧ (erp adm/mgmt ∨
          // technician/chief/admin) ∧ (wo_id IS NULL ∨ nalog je vidljiv).
          this.assert30(
            this.az.canWriteStock(s) || s.profileRole === "technician",
            "Nemate pravo nad: Kretanje zaliha",
          );
          if (dto.woId) await this.assertWoVidljiv30(tx, s, dto.woId);
          const red = await tx.maintPartStockMovement.create({
            data: {
              partId,
              woId: dto.woId ?? null,
              movementType: dto.movementType,
              quantity: dto.quantity,
              unitCost: dto.unitCost ?? null,
              note: dto.note ?? null,
              createdBy: s.userId,
            },
          });
          // ═══════════════════════════════════════════════════════════════
          // 🔴 OVAJ POZIV JE OBAVEZAN — 3.0 NEMA TRIGGER
          // ═══════════════════════════════════════════════════════════════
          // U sy15 `maint_apply_part_stock_movement` je AFTER INSERT trigger, pa
          // je `current_stock` održavala baza. U 3.0 tog trigera NEMA (mereno:
          // migracija prenosi 23 mehanička trigera, ovaj nije među njima) —
          // postoji SAMO kao `OdrzavanjeFnService.applyPartStockMovement`.
          // Upis u ledger mimo ovog poziva TIHO razilazi `current_stock` sa
          // zbirom kretanja: nema greške, nema loga, i vidi se tek na popisu.
          // Zato je u ISTOJ transakciji — ledger i stanje su jedan potez.
          await this.fns.applyPartStockMovement(tx, {
            partId,
            movementType: dto.movementType,
            quantity: dto.quantity,
          });
          return red;
        }),
      },
    );
  }

  /**
   * `maint_wo_row_visible(...)` nad konkretnim nalogom — u sy15 ga je nosio
   * `EXISTS (…)` u WITH CHECK klauzuli, pa ga kod nije morao pisati.
   */
  private async assertWoVidljiv30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    woId: string,
  ): Promise<void> {
    const wo = await tx.maintWorkOrder.findUnique({
      where: { woId },
      select: {
        assignedTo: true,
        reportedBy: true,
        asset: {
          select: {
            assetType: true,
            machine: { select: { machineCode: true } },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${woId} ne postoji`);
    const vidljiv = this.az.woRowVisible(s, {
      assignedTo: wo.assignedTo,
      reportedBy: wo.reportedBy,
      asset: wo.asset
        ? {
            assetType: wo.asset.assetType,
            machineCode: wo.asset.machine?.machineCode ?? null,
          }
        : null,
    });
    if (!vidljiv)
      throw new ForbiddenException(`Nemate pravo nad: Radni nalog ${woId}`);
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(
            this.az.canWriteStock(s),
            "Nemate pravo nad: Dobavljač",
          );
          return tx.maintSupplier.create({
            data: {
              name: dto.name.trim(),
              contact: dto.contact ?? null,
              email: dto.email ?? null,
              phone: dto.phone ?? null,
              notes: dto.notes ?? null,
              active: dto.active ?? true,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateSupplier(email: string, id: string, dto: UpdateSupplierDto) {
    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.contact !== undefined ? { contact: dto.contact } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintSupplier.count({ where: { supplierId: id } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintSupplier.updateMany({
          where: { supplierId: id },
          data: { ...patch, updatedBy: uid, updatedAt: new Date() },
        });
        this.assertAffected(exists, count, `Dobavljač ${id}`);
        return {
          data: await tx.maintSupplier.findUnique({
            where: { supplierId: id },
          }),
        };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintSupplier.count({ where: { supplierId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Dobavljač ${id} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Dobavljač ${id}`,
        );
        await tx.maintSupplier.updateMany({
          where: { supplierId: id },
          data: { ...patch, updatedBy: s.userId, updatedAt: new Date() },
        });
        return {
          data: await tx.maintSupplier.findUnique({
            where: { supplierId: id },
          }),
        };
      },
    );
  }

  // ---------- CMMS lokacije (≠ loc_locations) ----------

  // 🔴 `maint_locations` (CMMS stablo) NIJE `loc_locations` (domen Lokacije,
  // korak 3 gašenja sy15). Zamena tabela ne bi dala nikakvu grešku — samo
  // pogrešno stablo u padajućoj listi sredstava. Ovde se dira ISKLJUČIVO
  // `maint_locations`; most ka `loc_locations` je `OdrzavanjeLokacijeMostService`
  // i on se ovde NE poziva.

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
      {
        fn30: this.idemMost30(async (tx, s) => {
          // `maint_locations_insert` = erp_admin ∨ chief/admin — 🔴 UŽE od
          // `canWriteStock` (menadzment/magacioner NE menjaju CMMS stablo).
          this.assert30(
            this.az.canWriteCatalog(s),
            "Nemate pravo nad: CMMS lokacija",
          );
          return tx.maintLocation.create({
            data: {
              name: dto.name.trim(),
              code: dto.code?.trim() || null,
              locationType: dto.locationType?.trim() || "lokacija",
              parentLocationId: dto.parentLocationId ?? null,
              active: dto.active ?? true,
            },
          });
        }),
      },
    );
  }

  async updateLocation(email: string, id: string, dto: UpdateLocationDto) {
    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.code !== undefined ? { code: dto.code || null } : {}),
      ...(dto.locationType !== undefined
        ? { locationType: dto.locationType }
        : {}),
      ...(dto.parentLocationId !== undefined
        ? { parentLocationId: dto.parentLocationId }
        : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintLocation.count({ where: { locationId: id } })) > 0;
        const { count } = await tx.maintLocation.updateMany({
          where: { locationId: id },
          data: { ...patch, updatedAt: new Date() },
        });
        this.assertAffected(exists, count, `Lokacija ${id}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        const exists =
          (await tx.maintLocation.count({ where: { locationId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Lokacija ${id} ne postoji`);
        this.assert30(
          this.az.canWriteCatalog(s),
          `Nemate pravo nad: Lokacija ${id}`,
        );
        await tx.maintLocation.updateMany({
          where: { locationId: id },
          data: { ...patch, updatedAt: new Date() },
        });
        return { data: { ok: true } };
      },
    );
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
    // 🔴 Putanja se NE MENJA pod `3.0` — bajtovi ostaju u sy15 storage-u, a
    // `storage_path` je jedina veza sa njima (v. `uploadVehiclePhoto`).
    const storagePath = `documents/${dto.entityType}/${dto.entityId}/${uuid}_${this.safeFileName(file.originalname)}`;
    const veze = {
      assetId: dto.entityType === "asset" ? dto.entityId : null,
      woId: dto.entityType === "work_order" ? dto.entityId : null,
      incidentId: dto.entityType === "incident" ? dto.entityId : null,
      preventiveTaskId:
        dto.entityType === "preventive_task" ? dto.entityId : null,
      driverId: dto.entityType === "driver" ? dto.entityId : null,
    };
    const zajednicko = {
      entityId: dto.entityId,
      ...veze,
      fileName: file.originalname,
      storagePath,
      mimeType: file.mimetype ?? null,
      sizeBytes: BigInt(file.buffer.length),
      category: dto.category ?? null,
      description: dto.description ?? null,
      validUntil: this.toDbDate(dto.validUntil) ?? null,
    };
    const meta = await this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        return tx.maintDocument.create({
          data: {
            entityType: dto.entityType as never,
            ...zajednicko,
            uploadedBy: uid,
          },
        });
      },
      async (tx, s) => {
        // `maint_documents_insert` CHECK = uploaded_by = uid ∧ document_visible.
        await this.assertDocumentVisible30(tx, s, dto.entityType, dto.entityId);
        return tx.maintDocument.create({
          data: {
            entityType: dto.entityType,
            ...zajednicko,
            uploadedBy: s.userId,
          },
        });
      },
    );
    try {
      await this.storage.upload(
        MAINT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype || "application/octet-stream",
        false,
      );
    } catch (e) {
      await this.withUser30(
        email,
        async (tx) => {
          await tx.maintDocument.deleteMany({
            where: { documentId: meta.documentId },
          });
        },
        async (tx) => {
          await tx.maintDocument.deleteMany({
            where: { documentId: meta.documentId },
          });
        },
      ).catch(() => {});
      throw e;
    }
    return { data: this.withNumSize(meta) };
  }

  /**
   * `maint_document_visible(entity_type, asset, wo, incident, task, driver)` nad
   * entitetom KOJI SE TEK PRILAŽE. Kaskada ide istim redosledom kao izvor;
   * `ELSE FALSE` znači da dokument bez ijedne poznate veze ne prolazi.
   */
  private async assertDocumentVisible30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const odbij = () =>
      new ForbiddenException(`Nemate pravo nad: ${entityType} ${entityId}`);
    if (entityType === "asset") {
      if (!(await this.assetVidljivo30(tx, s, entityId))) throw odbij();
      return;
    }
    if (entityType === "work_order") {
      await this.assertWoVidljiv30(tx, s, entityId);
      return;
    }
    if (entityType === "incident") {
      const inc = await tx.maintIncident.findUnique({
        where: { id: entityId },
        select: {
          machineCode: true,
          asset: {
            select: {
              assetType: true,
              machine: { select: { machineCode: true } },
            },
          },
        },
      });
      if (!inc) throw new NotFoundException(`Kvar ${entityId} ne postoji`);
      const ok = this.az.incidentRowVisible(s, {
        machineCode: inc.machineCode,
        asset: inc.asset
          ? {
              assetType: inc.asset.assetType,
              machineCode: inc.asset.machine?.machineCode ?? null,
            }
          : null,
      });
      if (!ok) throw odbij();
      return;
    }
    if (entityType === "preventive_task") {
      // 🔴 Izvor NE gleda `tasks.asset_id` nego SREDSTVO MAŠINE zadatka
      // (join po `machine_code`) — v. `documentListWhere`.
      const t = await tx.maintTask.findUnique({
        where: { id: entityId },
        select: { machineCode: true },
      });
      if (!t) throw new NotFoundException(`Zadatak ${entityId} ne postoji`);
      if (!this.az.machineVisible(s, t.machineCode)) throw odbij();
      return;
    }
    if (entityType === "driver") {
      const d = await tx.maintDriver.findUnique({
        where: { driverId: entityId },
        select: { authUserId: true },
      });
      if (!d) throw new NotFoundException(`Vozač ${entityId} ne postoji`);
      // 🔴 Per-red grana: vozač bez ijedne role vidi (i prilaže na) SVOJ red.
      const ok =
        this.az.canReadAllDrivers(s) ||
        (d.authUserId != null && d.authUserId === s.userId);
      if (!ok) throw odbij();
      return;
    }
    throw odbij(); // `ELSE FALSE`
  }

  /** Vidljivost POSTOJEĆEG dokumenta — ista kaskada, ali po redu iz baze. */
  private async assertExistingDocumentVisible30(
    tx: OdrzavanjeTx,
    s: MaintScope,
    documentId: string,
  ): Promise<{ storagePath: string; deletedAt: Date | null }> {
    const doc = await tx.maintDocument.findUnique({
      where: { documentId },
      select: {
        storagePath: true,
        deletedAt: true,
        entityType: true,
        entityId: true,
      },
    });
    if (!doc) throw new NotFoundException(`Dokument ${documentId} ne postoji`);
    await this.assertDocumentVisible30(tx, s, doc.entityType, doc.entityId);
    return { storagePath: doc.storagePath, deletedAt: doc.deletedAt };
  }

  updateDocument(email: string, id: string, dto: UpdateDocumentDto) {
    const patch = {
      ...(dto.validUntil !== undefined
        ? { validUntil: this.toDbDate(dto.validUntil) }
        : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintDocument.count({ where: { documentId: id } })) > 0;
        const { count } = await tx.maintDocument.updateMany({
          where: { documentId: id },
          data: patch,
        });
        this.assertAffected(exists, count, `Dokument ${id}`);
        return { data: { ok: true } };
      },
      async (tx, s) => {
        await this.assertExistingDocumentVisible30(tx, s, id);
        await tx.maintDocument.updateMany({
          where: { documentId: id },
          data: patch,
        });
        return { data: { ok: true } };
      },
    );
  }

  async deleteDocument(email: string, id: string) {
    const path = await this.withUser30(
      email,
      async (tx) => {
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
      },
      async (tx, s) => {
        const doc = await this.assertExistingDocumentVisible30(tx, s, id);
        await tx.maintDocument.updateMany({
          where: { documentId: id },
          data: { deletedAt: new Date() },
        });
        return doc.storagePath;
      },
    );
    if (path) await this.storage.remove(MAINT_BUCKET, path);
    return { data: { ok: true } };
  }

  /** Presigned URL dokumenta (RLS SELECT presuđuje vidljivost PRE potpisivanja). */
  async signDocument(email: string, id: string) {
    const path = await this.withUser30(
      email,
      async (tx) => {
        const row = await tx.maintDocument.findUnique({
          where: { documentId: id },
          select: { storagePath: true, deletedAt: true },
        });
        if (!row || row.deletedAt)
          throw new NotFoundException(`Dokument ${id} ne postoji`);
        return row.storagePath;
      },
      async (tx, s) => {
        // Vidljivost PRE potpisa — potpisan URL više ne prolazi kroz prava.
        const doc = await this.assertExistingDocumentVisible30(tx, s, id);
        if (doc.deletedAt)
          throw new NotFoundException(`Dokument ${id} ne postoji`);
        return doc.storagePath;
      },
    );
    return { data: await this.storage.signUrl(MAINT_BUCKET, path, 300) };
  }

  // ---------- Podešavanja / notifikaciona pravila / retry ----------

  updateSettings(email: string, dto: UpdateSettingsDto) {
    const patch = {
      ...(dto.autoCreateWoMajor !== undefined
        ? { autoCreateWoMajor: dto.autoCreateWoMajor }
        : {}),
      ...(dto.autoCreateWoCritical !== undefined
        ? { autoCreateWoCritical: dto.autoCreateWoCritical }
        : {}),
      ...(dto.safetyMarkerRequiresWo !== undefined
        ? { safetyMarkerRequiresWo: dto.safetyMarkerRequiresWo }
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
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const uid = await this.uid(tx);
        await tx.maintSettings.updateMany({
          where: { id: 1 },
          data: {
            ...patch,
            ...(dto.defaultWoPriority !== undefined
              ? { defaultWoPriority: dto.defaultWoPriority as never }
              : {}),
            ...(dto.notificationChannels !== undefined
              ? { notificationChannels: dto.notificationChannels as never }
              : {}),
            updatedBy: uid,
            updatedAt: new Date(),
          },
        });
        return {
          data: await tx.maintSettings.findUnique({ where: { id: 1 } }),
        };
      },
      async (tx, s) => {
        // ⚠️ `maint_settings_update` je UŽE od `maint_settings_select`: čitaju i
        // operater/tehničar, menjaju samo erp adm/mgmt ∨ chief/admin.
        this.assert30(
          this.az.canWriteStock(s),
          "Nemate pravo nad: Podešavanja održavanja",
        );
        await tx.maintSettings.updateMany({
          where: { id: 1 },
          data: {
            ...patch,
            ...(dto.defaultWoPriority !== undefined
              ? { defaultWoPriority: dto.defaultWoPriority }
              : {}),
            ...(dto.notificationChannels !== undefined
              ? { notificationChannels: dto.notificationChannels }
              : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        // 🔴 Čita se kroz `fn.settings(tx)`, ne sirovim `findUnique`: kad reda
        // `id = 1` nema, sy15 funkcije su radile sa `SETTINGS_FALLBACK`-om, pa
        // odgovor mora pokazati ONO PO ČEMU MODUL STVARNO RADI, a ne `null`.
        return { data: await this.fns.settings(tx) };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(
            this.az.canWriteStock(s),
            "Nemate pravo nad: Pravilo obaveštavanja",
          );
          return tx.maintNotificationRule.create({
            data: {
              eventType: dto.eventType ?? "incident_created",
              severity: dto.severity ?? null,
              assetType: dto.assetType ?? null,
              targetRole: dto.targetRole ?? null,
              channel: dto.channel ?? "in_app",
              delayMinutes: dto.delayMinutes ?? 0,
              escalationLevel: dto.escalationLevel ?? 0,
              enabled: dto.enabled ?? true,
              notes: dto.notes ?? null,
              updatedBy: s.userId,
            },
          });
        }),
      },
    );
  }

  async updateNotificationRule(
    email: string,
    id: string,
    dto: UpdateNotificationRuleDto,
  ) {
    const patch = {
      ...(dto.eventType !== undefined ? { eventType: dto.eventType } : {}),
      ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
      ...(dto.delayMinutes !== undefined
        ? { delayMinutes: dto.delayMinutes }
        : {}),
      ...(dto.escalationLevel !== undefined
        ? { escalationLevel: dto.escalationLevel }
        : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    return this.withUser30(
      email,
      async (tx) => {
        const exists =
          (await tx.maintNotificationRule.count({ where: { ruleId: id } })) > 0;
        const uid = await this.uid(tx);
        const { count } = await tx.maintNotificationRule.updateMany({
          where: { ruleId: id },
          data: {
            ...patch,
            ...(dto.assetType !== undefined
              ? { assetType: dto.assetType as never }
              : {}),
            ...(dto.targetRole !== undefined
              ? { targetRole: dto.targetRole as never }
              : {}),
            ...(dto.channel !== undefined
              ? { channel: dto.channel as never }
              : {}),
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
      },
      async (tx, s) => {
        const exists =
          (await tx.maintNotificationRule.count({ where: { ruleId: id } })) > 0;
        if (!exists) throw new NotFoundException(`Pravilo ${id} ne postoji`);
        this.assert30(
          this.az.canWriteStock(s),
          `Nemate pravo nad: Pravilo ${id}`,
        );
        await tx.maintNotificationRule.updateMany({
          where: { ruleId: id },
          data: {
            ...patch,
            ...(dto.assetType !== undefined
              ? { assetType: dto.assetType }
              : {}),
            ...(dto.targetRole !== undefined
              ? { targetRole: dto.targetRole }
              : {}),
            ...(dto.channel !== undefined ? { channel: dto.channel } : {}),
            updatedBy: s.userId,
            updatedAt: new Date(),
          },
        });
        return {
          data: await tx.maintNotificationRule.findUnique({
            where: { ruleId: id },
          }),
        };
      },
    );
  }

  /** Retry pale notifikacije (RPC: failed → queued; erp-admin ∨ chief/admin). Dispatch OSTAJE MRTAV (F1). */
  retryNotification(email: string, id: string) {
    return this.withUser30(
      email,
      async (tx) => {
        const rows = await tx.$queryRaw<{ ok: boolean }[]>(
          Prisma.sql`SELECT public.maint_notification_retry(${id}::uuid) AS ok`,
        );
        return { data: { requeued: rows[0]?.ok === true } };
      },
      // Gejt i `LEAST(attempts, 7)` su U SAMOM prepisu (`notificationRetry`) —
      // ovde se ne ponavljaju da se ne raziđu sa izvorom.
      async (tx, s) => ({
        data: { requeued: await this.fns.notificationRetry(tx, s, id) },
      }),
    );
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
    return this.withUser30(
      email,
      async (tx) => {
        await this.assertErpAdmin(tx);
        const data = await tx.maintUserProfile.findMany({
          orderBy: { fullName: "asc" },
          take: 500,
        });
        return { data };
      },
      async (tx, s) => {
        this.assert30(
          this.az.isErpAdmin(s),
          "Samo ERP admin vidi profile održavanja",
        );
        const data = await tx.maintUserProfile.findMany({
          orderBy: { fullName: "asc" },
          take: 500,
        });
        return { data };
      },
    );
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
      {
        fn30: this.idemMost30(async (tx, s) => {
          this.assert30(
            this.az.isErpAdmin(s),
            "Samo ERP admin sme da menja profile održavanja",
          );
          // 🔴 `userId` je u 3.0 `users.id` (Int); DTO ga već nosi kao broj
          // (`@IsInt`), ali ovde je i jedina razlika prema sy15 uuid-u.
          const userId = this.profileUserId30(dto.userId);
          const existing = await tx.maintUserProfile.findUnique({
            where: { userId },
          });
          if (existing) {
            throw new ConflictException(
              "Profil sa ovim korisničkim ID-em već postoji (koristi izmenu)",
            );
          }
          return tx.maintUserProfile.create({
            data: {
              userId,
              fullName: dto.fullName.trim(),
              role: dto.role,
              assignedMachineCodes: (dto.assignedMachineCodes ?? [])
                .map((c) => c.trim())
                .filter(Boolean),
              phone: dto.phone ?? null,
              telegramChatId: dto.telegramChatId ?? null,
              active: dto.active !== false,
            },
          });
        }),
      },
    );
  }

  /** `maint_user_profiles.user_id`: uuid u sy15, `users.id` (Int) u 3.0. */
  private profileUserId30(raw: string | number): number {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!this.jeIdKorisnika30(n)) {
      throw new UnprocessableEntityException(
        `„${raw}" nije korisnički ID iz 3.0 baze (očekivan je broj)`,
      );
    }
    return n;
  }

  /**
   * `users.id` je PG `int4`, a DTO regex `[0-9]+` NEMA gornju granicu.
   * `Number.isInteger(1e20)` je `true`, pa bi „99999999999999999999" prošlo
   * proveru i palo tek u Prisma sloju kao 500 — isti kvar kao P2023, samo na
   * drugom kraju šava. Zato opseg int4 (pozitivan deo) proverava KOD.
   */
  private jeIdKorisnika30(n: number): boolean {
    return Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
  }

  /**
   * Izmena profila. Guard = ERP admin (SoD; menadzment/magacioner NE smeju).
   * `role`/`active` menja ionako samo erp-admin (DB trigger). Idempotentan PATCH.
   */
  async updateProfile(email: string, id: string, dto: UpdateProfileDto) {
    const patch = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
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
    };
    return this.withUser30(
      email,
      async (tx) => {
        await this.assertErpAdmin(tx);
        const exists =
          (await tx.maintUserProfile.count({ where: { userId: id } })) > 0;
        const { count } = await tx.maintUserProfile.updateMany({
          where: { userId: id },
          data: {
            ...patch,
            ...(dto.role !== undefined ? { role: dto.role as never } : {}),
            updatedAt: new Date(),
          },
        });
        this.assertAffected(exists, count, `Profil ${id}`);
        return {
          data: await tx.maintUserProfile.findUnique({ where: { userId: id } }),
        };
      },
      async (tx, s) => {
        this.assert30(
          this.az.isErpAdmin(s),
          "Samo ERP admin sme da menja profile održavanja",
        );
        const userId = this.profileUserId30(id);
        const stari = await tx.maintUserProfile.findUnique({
          where: { userId },
          select: { role: true, active: true },
        });
        if (!stari) throw new NotFoundException(`Profil ${id} ne postoji`);
        // 🔴 Trigger `maint_profiles_guard_role` (BEFORE UPDATE) — u 3.0 postoji
        // SAMO kao `assertProfileRoleChange`. Bez njega bi RLS grana „menjam svoj
        // red" (koju erp-admin gejt ovde ionako pokriva) ostala bez druge brane.
        this.fns.assertProfileRoleChange(s, stari, {
          role: dto.role,
          active: dto.active,
        });
        await tx.maintUserProfile.updateMany({
          where: { userId },
          data: {
            ...patch,
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            updatedAt: new Date(),
          },
        });
        return {
          data: await tx.maintUserProfile.findUnique({ where: { userId } }),
        };
      },
    );
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
    const gde = {
      isActive: true,
      ...(term
        ? {
            OR: [
              { fullName: { contains: term, mode: "insensitive" as const } },
              { firstName: { contains: term, mode: "insensitive" as const } },
              { lastName: { contains: term, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const izbor = {
      id: true,
      fullName: true,
      firstName: true,
      lastName: true,
      email: true,
    };
    // ═══════════════════════════════════════════════════════════════════════
    // 🔴 NIJE PRENETO — I TO JE MERENJE, NE PROPUST
    // ═══════════════════════════════════════════════════════════════════════
    // `employees` je KADROVSKA tabela i u 3.0 bazi JE NEMA (provereno u
    // `prisma/schema.prisma`: nijedan model ne mapira `employees`; postoji samo
    // `WorkerEmployeeMap`, što je druga stvar). Kadrovska je korak 4 gašenja sy15
    // i seli se sa svojim domenom — a i zamrznuta je do seobe.
    //
    // Zato ovaj put pod `3.0` GLASNO pada sa 503 (`withUserMapped` →
    // `assertPorted`), umesto da tiho vrati praznu listu. Prazna lista bi u
    // driver modalu izgledala kao „nema takvog zaposlenog", pa bi se vozači
    // unosili ručno i ostajali bez veze sa nalogom — tiho i nepovratno.
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.employee.findMany({
        where: gde,
        select: izbor,
        orderBy: { lastName: "asc" },
        take: 500,
      });
      return { data };
    });
  }
}
