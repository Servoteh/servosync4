import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Održavanje (CMMS) — 3.0 parnjak sy15 RLS-a i gejt funkcija.
 *
 * ⚠️ ZAŠTO OVAJ SERVIS MORA DA POSTOJI (ista pouka kao `SastanciAuthzService`):
 * u sy15 row-scope sprovodi **102 RLS politike** na 34 tabele, pa ga kod NAMERNO
 * ne duplira (doktrina A.2a — „scope se NE duplira u WHERE"; v. i komentar u
 * `common/authz/role-permissions.ts`: guard je gruba modul-kapija, a „PRAVU odluku
 * donosi DB"). 3.0 nema RLS (ODLUKE.md). Da se ovaj sloj ne napiše, prava bi
 * **TIHO nestala**: operater bi video sve mašine umesto svojih, a nijedan test to
 * ne bi primetio jer bi svi upiti i dalje vraćali redove — samo više njih.
 *
 * Tela su izvučena sa **žive sy15** (`pg_get_functiondef`, 06.08.2026), ne iz
 * dokumentacije. Prepisano je 9 gejt funkcija + read-scope 30 SELECT politika.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 JEDNO SVESNO ODSTUPANJE, IZMERENO: ODAKLE SE ČITA ERP ROLA
 *
 * sy15 gejtovi (`maint_is_erp_admin`, `maint_is_erp_admin_or_management`,
 * `maint_has_floor_read_access`) gledaju sy15 `public.user_roles` po MEJLU iz JWT-a:
 *     WHERE is_active AND project_id IS NULL AND lower(email) = lower(jwt.email)
 *
 * 3.0 `user_roles` ima DRUGI oblik (`user_id`, `scope_type`/`scope_id` — nema ni
 * `email` ni `project_id`) i, što je važnije, DRUGU POPUNJENOST. Izmereno 06.08.2026:
 *
 *   | izvor rola                                   | globalnih aktivnih redova |
 *   |----------------------------------------------|---------------------------|
 *   | sy15 `user_roles`                            | 60                        |
 *   | 3.0 `user_roles` SAM                         | **11**                    |
 *   | 3.0 `users.role` ∪ `user_roles.role`         | 71 korisnika, 17 rola     |
 *
 * Da je prepis čitao SAMO 3.0 `user_roles` (doslovan parnjak po imenu tabele),
 * `floor_read` bi pao sa 35 ljudi na ~11 — dvadesetak ljudi bi pod `3.0` tiho
 * ostalo bez pristupa održavanju. U 3.0 je PRIMARNA rola `users.role`, a
 * `user_roles` je tabela DODATNIH rola (v. memoriju „Rola-sync obara 3.0-native
 * role": prvo se gleda `users.role`).
 *
 * Zato je parnjak **UNIJA `users.role` i `user_roles.role`** (globalne, aktivne).
 * Kontrolno merenje nad živim podacima:
 *
 *   | gejt                     | sy15 danas | 3.0 (unija) |
 *   |--------------------------|-----------:|------------:|
 *   | `floor_read`             |     **35** |      **34** |
 *
 * Razlika je TAČNO JEDAN nalog: `kontrola@servoteh.com` (u 3.0 ima rolu
 * `kontrolor`, koja nije u floor-read spisku). **Niko ne DOBIJA pristup koji
 * danas nema** — greška ide u bezbednom smeru. Da li `kontrolor` treba da uđe u
 * floor-read je odluka o proizvodu, ne o seobi: prosleđena je, ne doneta
 * (v. runbook, „odluke koje čekaju Nenada").
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Role koje u sy15 daju `maint_has_floor_read_access()` (prepis, doslovno). */
const FLOOR_READ_ROLES = [
  "admin",
  "pm",
  "leadpm",
  "menadzment",
  "magacioner",
  "monter",
  "tim_lider",
] as const;

/** Role koje u sy15 daju `maint_is_erp_admin_or_management()`. */
const ERP_ADMIN_OR_MGMT_ROLES = ["admin", "menadzment", "magacioner"] as const;

/** Rola koja u sy15 daje `maint_is_erp_admin()`. */
const ERP_ADMIN_ROLE = "admin";

/** CMMS role iz `maint_user_profiles.role`. */
export type MaintProfileRole =
  | "operator"
  | "technician"
  | "chief"
  | "management"
  | "admin";

/**
 * Snimak prava pozivaoca. U sy15 su gejtovi `STABLE` pa ih planer računa jednom po
 * naredbi; ovde se učitaju jednom po zahtevu i dalje se koriste kao ČISTE funkcije
 * (bez baze) — zato su svi predikati ispod testabilni bez konekcije.
 */
export interface MaintScope {
  userId: number;
  /** Unija `users.role` + globalnih aktivnih `user_roles.role`, sve lowercase. */
  erpRoles: Set<string>;
  /** `maint_user_profiles.role` (samo ako je profil `active`), inače null. */
  profileRole: MaintProfileRole | null;
  /** `maint_user_profiles.assigned_machine_codes` (prazan niz ako nema profila). */
  assignedMachineCodes: string[];
}

@Injectable()
export class OdrzavanjeAuthzService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Učitava snimak prava. JEDINI metod koji dodiruje bazu — sve ostalo su čiste
   * funkcije nad `MaintScope`.
   */
  async loadScope(userId: number): Promise<MaintScope> {
    const [user, extraRoles, profile] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, active: true },
      }),
      this.prisma.userRole.findMany({
        where: { userId, isActive: true, scopeType: "global" },
        select: { role: true },
      }),
      this.prisma.maintUserProfile.findUnique({
        where: { userId },
        select: { role: true, active: true, assignedMachineCodes: true },
      }),
    ]);

    const erpRoles = new Set<string>();
    // Neaktivan nalog ne nosi rolu — sy15 to postiže preko `is_active` na redu.
    if (user?.active && user.role) erpRoles.add(user.role.trim().toLowerCase());
    for (const r of extraRoles) {
      if (r.role) erpRoles.add(r.role.trim().toLowerCase());
    }

    return {
      userId,
      erpRoles,
      // Profil koji NIJE aktivan ne daje rolu (`WHERE ... AND active = true`).
      profileRole:
        profile && profile.active
          ? (profile.role as MaintProfileRole)
          : null,
      assignedMachineCodes: profile?.active
        ? (profile.assignedMachineCodes ?? [])
        : [],
    };
  }

  // =========================================================================
  // Gejtovi — čist prepis sy15 tela
  // =========================================================================

  /** `maint_is_erp_admin()` */
  isErpAdmin(s: MaintScope): boolean {
    return s.erpRoles.has(ERP_ADMIN_ROLE);
  }

  /** `maint_is_erp_admin_or_management()` — ⚠️ ime laže: uključuje i `magacioner`. */
  isErpAdminOrManagement(s: MaintScope): boolean {
    return ERP_ADMIN_OR_MGMT_ROLES.some((r) => s.erpRoles.has(r));
  }

  /** `maint_has_floor_read_access()` = erp_admin ∨ rola sa poda. */
  hasFloorReadAccess(s: MaintScope): boolean {
    return (
      this.isErpAdmin(s) || FLOOR_READ_ROLES.some((r) => s.erpRoles.has(r))
    );
  }

  /** `maint_profile_role()` */
  profileRole(s: MaintScope): MaintProfileRole | null {
    return s.profileRole;
  }

  /** `maint_assigned_machine_codes()` — `coalesce(..., ARRAY[]::text[])`. */
  assignedMachineCodes(s: MaintScope): string[] {
    return s.assignedMachineCodes ?? [];
  }

  /** `maint_can_close_incident()` — zatvaranje incidenta je POSEBNO pravo. */
  canCloseIncident(s: MaintScope): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      this.isErpAdmin(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
  }

  /**
   * `maint_machine_visible(text)` — JEDINI pravi per-red scope u celom modulu.
   *
   * 🔴 Zamka koja se lako izgubi: operater sa PRAZNOM listom dodeljenih mašina ne
   * vidi NIJEDNU (`cardinality(...) > 0` je uslov, ne samo `= ANY`). Prepis bez
   * te provere pretvorio bi „nema dodeljene mašine" u „vidi sve".
   */
  machineVisible(s: MaintScope, machineCode: string | null | undefined): boolean {
    if (this.hasFloorReadAccess(s)) return true;
    if (
      s.profileRole === "chief" ||
      s.profileRole === "technician" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    ) {
      return true;
    }
    if (s.profileRole !== "operator") return false;
    const codes = this.assignedMachineCodes(s);
    if (codes.length === 0) return false;
    return machineCode != null && codes.includes(machineCode);
  }

  /**
   * `maint_asset_visible(uuid)` — za `machine` delegira na `machineVisible`
   * (preko `maint_machines.asset_id`), a za vozila/IT/objekte NEMA per-red scope:
   * vide se ili sva ili nijedno.
   */
  assetVisible(
    s: MaintScope,
    asset: { assetType: string; machineCode?: string | null } | null,
  ): boolean {
    if (!asset) return false;
    if (asset.assetType === "machine") {
      return this.machineVisible(s, asset.machineCode ?? null);
    }
    return (
      this.hasFloorReadAccess(s) ||
      this.isErpAdmin(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  /**
   * `maint_wo_row_visible(asset, assigned, reported)` — „moj nalog je uvek moj":
   * dodeljeni i prijavilac vide nalog i kad sredstvo ne vide.
   */
  woRowVisible(
    s: MaintScope,
    row: {
      assignedTo: number | null;
      reportedBy: number | null;
      asset: { assetType: string; machineCode?: string | null } | null;
    },
  ): boolean {
    if (row.assignedTo != null && row.assignedTo === s.userId) return true;
    if (row.reportedBy != null && row.reportedBy === s.userId) return true;
    return this.assetVisible(s, row.asset);
  }

  /** `maint_incident_row_visible(machine_code, asset_id)` */
  incidentRowVisible(
    s: MaintScope,
    row: {
      machineCode: string | null;
      asset: { assetType: string; machineCode?: string | null } | null;
    },
  ): boolean {
    if (row.asset) return this.assetVisible(s, row.asset);
    return this.machineVisible(s, row.machineCode);
  }

  /**
   * `maint_document_visible(...)` — kaskada po tome koji je FK popunjen.
   * 🔴 ELSE grana je **FALSE** (default deny) — dokument bez ijedne veze se ne vidi.
   */
  documentVisible(
    s: MaintScope,
    doc: {
      asset: { assetType: string; machineCode?: string | null } | null;
      workOrder: {
        assignedTo: number | null;
        reportedBy: number | null;
        asset: { assetType: string; machineCode?: string | null } | null;
      } | null;
      incident: {
        machineCode: string | null;
        asset: { assetType: string; machineCode?: string | null } | null;
      } | null;
      preventiveTaskAsset: { assetType: string; machineCode?: string | null } | null;
      driver: { authUserId: number | null } | null;
    },
  ): boolean {
    if (doc.asset) return this.assetVisible(s, doc.asset);
    if (doc.workOrder) return this.woRowVisible(s, doc.workOrder);
    if (doc.incident) return this.incidentRowVisible(s, doc.incident);
    if (doc.preventiveTaskAsset) {
      return this.assetVisible(s, doc.preventiveTaskAsset);
    }
    if (doc.driver) {
      return (
        this.hasFloorReadAccess(s) ||
        this.isErpAdminOrManagement(s) ||
        s.profileRole === "chief" ||
        s.profileRole === "admin" ||
        s.profileRole === "technician" ||
        s.profileRole === "operator" ||
        (doc.driver.authUserId != null && doc.driver.authUserId === s.userId)
      );
    }
    return false;
  }

  // =========================================================================
  // Read-scope za LISTE — Prisma `where` isečci
  // =========================================================================

  /**
   * Sužavanje liste mašina (`maint_machines` SELECT politika = `maint_machine_visible`).
   * `undefined` = nema sužavanja (pozivalac vidi sve).
   */
  machineListWhere(s: MaintScope): { machineCode: { in: string[] } } | undefined {
    if (this.machineVisibleForAll(s)) return undefined;
    // Operater bez dodeljenih mašina -> prazan `in` -> nula redova (kao RLS).
    return { machineCode: { in: this.assignedMachineCodes(s) } };
  }

  /** `true` kad pozivalac vidi SVE mašine (nema per-red sužavanja). */
  machineVisibleForAll(s: MaintScope): boolean {
    return (
      this.hasFloorReadAccess(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "technician" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  /**
   * Sužavanje liste sredstava (`maint_assets` SELECT = `maint_asset_visible`).
   *
   * Pravilo je asimetrično i to je NAMERNO (prepis, ne previd): ne-mašinska
   * sredstva nemaju per-red scope, pa pozivalac koji nema pravo na njih NE VIDI
   * NIJEDNO, a mašinska filtrira po dodeljenim šiframa.
   */
  assetListWhere(
    s: MaintScope,
  ):
    | undefined
    | { OR: ({ machine: { machineCode: { in: string[] } } } | { assetType: { not: string } })[] }
    | { machine: { machineCode: { in: string[] } } } {
    if (this.machineVisibleForAll(s) && this.nonMachineVisible(s)) return undefined;
    const clauses: (
      | { machine: { machineCode: { in: string[] } } }
      | { assetType: { not: string } }
    )[] = [];
    if (this.machineVisibleForAll(s)) {
      // Sve mašine, ali ne i ostalo — izraženo kao „tip = machine".
      clauses.push({ assetType: { not: "machine" } });
    }
    clauses.push({ machine: { machineCode: { in: this.assignedMachineCodes(s) } } });
    if (this.nonMachineVisible(s)) {
      return { OR: clauses };
    }
    return { machine: { machineCode: { in: this.assignedMachineCodes(s) } } };
  }

  /** `true` kad pozivalac vidi vozila/IT/objekte (ne-mašinska sredstva). */
  nonMachineVisible(s: MaintScope): boolean {
    return (
      this.hasFloorReadAccess(s) ||
      this.isErpAdmin(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  /**
   * Read-scope liste obaveštenja (`maint_notification_log` SELECT):
   * `erp_admin ∨ profil ∈ (chief, management, admin)`. ⚠️ Ovde NIJE
   * `erp_admin_or_management` — magacioner NE vidi outbox.
   */
  canReadNotificationLog(s: MaintScope): boolean {
    return (
      this.isErpAdmin(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  /**
   * Read-scope delova/dobavljača/kretanja/lokacija (`maint_parts`, `maint_suppliers`,
   * `maint_part_stock_movements`, `maint_locations`).
   */
  canReadStock(s: MaintScope): boolean {
    return (
      this.hasFloorReadAccess(s) ||
      s.profileRole === "technician" ||
      s.profileRole === "chief" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  // =========================================================================
  // Write pravila koja RLS više ne brani
  // =========================================================================

  /**
   * 🔴 Pravilo „24 sata" (`maint_machine_notes` i `maint_machine_files` UPDATE/DELETE).
   * Autor sa rolom `operator`/`technician` sme da menja/briše SAMO u prvih 24 h;
   * `chief`/`admin`/erp_admin bez vremenskog ograničenja. Ovo je najlakše
   * propustiti pravilo u celoj seobi — u sy15 ga nosi `USING` klauzula politike.
   */
  canEditOwnWithin24h(
    s: MaintScope,
    row: { authorId: number | null; createdAt: Date },
    now: Date = new Date(),
  ): boolean {
    if (
      this.isErpAdmin(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    ) {
      return true;
    }
    if (row.authorId == null || row.authorId !== s.userId) return false;
    if (s.profileRole !== "operator" && s.profileRole !== "technician") return false;
    const ageMs = now.getTime() - row.createdAt.getTime();
    return ageMs <= 24 * 60 * 60 * 1000;
  }

  /**
   * `maint_user_profiles` — trigger `maint_profiles_guard_role`.
   * 🔴 RLS UPDATE politika dozvoljava korisniku da menja SVOJ red; bez ovog
   * guarda bi svako sebi mogao postaviti `role='admin'` ili `active`.
   * Menjati rolu/aktivnost sme SAMO erp_admin.
   */
  canChangeProfileRole(s: MaintScope): boolean {
    return this.isErpAdmin(s);
  }

  /** `maint_work_orders` INSERT: nalog se ne otvara na tuđe ime. */
  canCreateWorkOrder(s: MaintScope, reportedBy: number): boolean {
    if (reportedBy !== s.userId) return false;
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "operator" ||
      s.profileRole === "technician" ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
  }

  /** `maint_work_orders` UPDATE: tehničar+ ; red mora ostati vidljiv i posle izmene. */
  canUpdateWorkOrder(s: MaintScope): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "technician" ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
  }

  /**
   * `maint_incidents` INSERT: jedina provera je `reported_by = uid()`.
   * NEMA role-gate — svako ulogovan sme da prijavi kvar. To je NAMERNO
   * (prepis, ne propust): prijava kvara je otvorena celoj firmi.
   */
  canReportIncident(s: MaintScope, reportedBy: number): boolean {
    return reportedBy === s.userId;
  }

  /**
   * `maint_attach_incident_files` — najskrivenije pravilo modula: DEFINER funkcija
   * nema role-guard, nego jedino `WHERE i.reported_by = auth.uid()`. Dakle fajlove
   * na prijavu kači SAMO prijavilac.
   */
  canAttachIncidentFiles(s: MaintScope, incidentReportedBy: number | null): boolean {
    return incidentReportedBy != null && incidentReportedBy === s.userId;
  }

  /** `maint_checks` INSERT: `performed_by = uid()` + mašina mora biti vidljiva. */
  canCreateCheck(
    s: MaintScope,
    performedBy: number,
    machineCode: string | null,
  ): boolean {
    return performedBy === s.userId && this.machineVisible(s, machineCode);
  }

  /** `maint_vehicle_bookings` UPDATE: „moja rezervacija je moja". */
  canUpdateBooking(s: MaintScope, createdBy: number | null): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin" ||
      (createdBy != null && createdBy === s.userId)
    );
  }

  /** `maint_drivers` DELETE je UŽE od INSERT/UPDATE — bez `chief`. */
  canDeleteDriver(s: MaintScope): boolean {
    return this.isErpAdminOrManagement(s) || s.profileRole === "admin";
  }

  /** Write nad katalogom (mašine/sredstva/zadaci/lokacije/override). */
  canWriteCatalog(s: MaintScope): boolean {
    return (
      this.isErpAdmin(s) || s.profileRole === "chief" || s.profileRole === "admin"
    );
  }

  /** Write nad delovima/dobavljačima/podešavanjima/planovima/vozačima. */
  canWriteStock(s: MaintScope): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
  }
}
