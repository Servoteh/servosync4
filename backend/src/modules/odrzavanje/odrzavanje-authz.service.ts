import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

/** Prisma `where` isečak nad `MaintAsset` (rezultat `assetListWhere`). */
export type AssetScopeWhere =
  | { assetType: string }
  | { assetType: string; machine: { machineCode: { in: string[] } } }
  | {
      OR: (
        | { assetType: { not: string } }
        | { machine: { machineCode: { in: string[] } } }
      )[];
    };

/** Prisma `where` isečak nad tabelom koja ima kolonu `machine_code`. */
export type MachineScopeWhere = { machineCode: { in: string[] } };

/** Prisma `where` isečak nad `MaintWorkOrder` (rezultat `workOrderListWhere`). */
export type WorkOrderScopeWhere = {
  OR: (
    | { assignedTo: number }
    | { reportedBy: number }
    | { asset: AssetScopeWhere }
  )[];
};

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

  /**
   * Gejt `maint_machine_delete_hard(code, reason)` — ŠIRI od `machine_rename`
   * (uključuje `erp_admin_or_management`, koji nosi i `magacioner`).
   *
   * 🔴 Imenovan predikat, a ne izraz prepisan na dva mesta: trajno brisanje se
   * presuđuje DVAPUT — jednom pre brisanja bajtova iz skladišta (BE korak 1) i
   * jednom u samoj `machineDeleteHard`. Dva prepisa istog uslova su se već
   * razišla (bajtovi su odlazili bez ijedne provere), pa je izvor jedan.
   */
  canDeleteMachineHard(s: MaintScope): boolean {
    return (
      this.isErpAdmin(s) ||
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
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
   * sredstva nemaju per-red scope (vide se ili sva ili nijedno), a mašinska
   * filtrira po dodeljenim šiframa.
   *
   * 🔴 ISPRAVKA 06.08.2026, mereno nad tabelom istinitosti sy15 izraza:
   * prva verzija ove metode bila je pogrešna za **tehničara bez ERP role**.
   * Neka je `M = machineVisibleForAll`, `N = nonMachineVisible`, `C` = dodeljene
   * šifre. sy15 izraz je:
   *
   *   (tip = 'machine' ∧ (M ∨ code ∈ C)) ∨ (tip ≠ 'machine' ∧ N)
   *
   * Pošto je `N ⊆ M` (svaka rola koja daje `N` daje i `M`; `erp_admin ⊆ floor_read`),
   * postoje samo TRI žive kombinacije: `M∧N` (sve), `M∧¬N` (SAMO tehničar — sve
   * mašine, nijedno vozilo/IT/objekat) i `¬M∧¬N` (operater — samo svoje mašine).
   * Stara verzija je u slučaju `M∧¬N` vraćala filter po `C`, a tehničar `C` po
   * pravilu nema → **tehničar nije video NIJEDNO sredstvo**. Greška je išla u
   * bezbednom smeru (uže), ali je modul za tu rolu bio prazan.
   */
  assetListWhere(s: MaintScope): AssetScopeWhere | undefined {
    const m = this.machineVisibleForAll(s);
    const n = this.nonMachineVisible(s);
    if (m && n) return undefined;
    // Tehničar: sve mašine, ništa od vozila/IT/objekata.
    if (m) return { assetType: "machine" };
    // (Mrtva grana po konstrukciji — `N ⊆ M`. Ostaje doslovna radi tačnosti
    // prepisa: da se skup rola sutra promeni, izraz i dalje važi.)
    if (n) {
      return {
        OR: [
          { assetType: { not: "machine" } },
          { machine: { machineCode: { in: this.assignedMachineCodes(s) } } },
        ],
      };
    }
    // Operater: samo dodeljene mašine. Prazan `in` -> nula redova (kao RLS).
    return {
      assetType: "machine",
      machine: { machineCode: { in: this.assignedMachineCodes(s) } },
    };
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
  // 🔴 PUN READ-SCOPE — 34 tabele, po SELECT politikama sa ŽIVE `pg_policies`
  // =========================================================================
  //
  // Politike su povučene sa žive sy15 06.08.2026 (`pg_policies`, `qual` odvojen
  // od `with_check`), NE iz dokumentacije. Ispod je za svaku tabelu naveden
  // izvorni `qual`, pa 3.0 parnjak. Tri tabele NEMAJU šta da se prenese i to je
  // izmereno, ne pretpostavljeno:
  //
  //   `maint_vehicle_owners`     -> `maint_vehicle_owners_select` = `true`
  //                                 (svi ulogovani vide vlasnike vozila)
  //   `maint_wo_number_counter`  -> `maint_wo_num_counter_deny` = `false` za SVE
  //                                 komande; jedini upis je kroz brojač naloga
  //                                 (`OdrzavanjeFnService.dodeliBrojNaloga`)
  //   `maint_machines_deletion_log` -> INSERT/UPDATE/DELETE su `false`; upisuje
  //                                 SAMO `maint_machine_delete_hard`
  //
  // ⚠️ Sve metode ispod vraćaju `undefined` kad NEMA sužavanja. Pozivalac ih
  // spaja u svoj `where` (`{ ...ostalo, ...scope }`), pa `undefined` znači „ne
  // dodaj ništa". Prazan `in: []` NIJE isto što i `undefined` — to je „nula
  // redova", tačan parnjak RLS-a za operatera bez dodeljenih mašina.

  /**
   * Read-scope svake tabele koja ima kolonu `machine_code` i politiku
   * `maint_machine_visible(machine_code)`:
   * `maint_checks` · `maint_tasks` · `maint_machine_files` ·
   * `maint_machine_status_override` · `maint_machine_notes`.
   *
   * (`maint_machines` ide kroz `machineListWhere` — isto pravilo, druga tabela.)
   */
  machineScopedWhere(s: MaintScope): MachineScopeWhere | undefined {
    return this.machineListWhere(s);
  }

  /**
   * `maint_machine_notes` SELECT = `deleted_at IS NULL AND maint_machine_visible(...)`.
   *
   * 🔴 Soft-delete filter je DEO POLITIKE, ne deo upita modula. U sy15 ga nosi
   * RLS, pa ga kod nigde ne piše; pod `3.0` bi obrisane napomene tiho iskrsle
   * nazad u listi da ovaj `deletedAt: null` ne uđe u upit.
   */
  machineNotesWhere(s: MaintScope): {
    deletedAt: null;
    machineCode?: { in: string[] };
  } {
    const scope = this.machineListWhere(s);
    return scope ? { deletedAt: null, ...scope } : { deletedAt: null };
  }

  /**
   * Read-scope tabela koje vise o sredstvu (`maint_asset_visible(asset_id)`):
   * `maint_asset_service_plan` · `maint_vehicle_service_plan` ·
   * `maint_part_vehicles` · `maint_vehicle_tires` · `maint_vehicle_bookings` ·
   * `maint_vehicle_details` · `maint_it_asset_details` · `maint_facility_details`.
   */
  assetScopedWhere(s: MaintScope): { asset: AssetScopeWhere } | undefined {
    const scope = this.assetListWhere(s);
    return scope ? { asset: scope } : undefined;
  }

  /**
   * `maint_work_orders` SELECT = `maint_wo_row_visible(asset_id, assigned_to, reported_by)`.
   *
   * 🔴 „Moj nalog je uvek moj": dodeljeni i prijavilac vide nalog i kad sredstvo
   * ne vide. Zato ovo NIJE prosto `assetScopedWhere` — disjunkcija mora ostati,
   * inače operater gubi iz vida nalog koji je sam prijavio na tuđoj mašini.
   */
  workOrderListWhere(s: MaintScope): WorkOrderScopeWhere | undefined {
    const scope = this.assetListWhere(s);
    if (!scope) return undefined;
    return {
      OR: [{ assignedTo: s.userId }, { reportedBy: s.userId }, { asset: scope }],
    };
  }

  /**
   * Read-scope dece radnog naloga (`maint_wo_events`, `maint_wo_labor`,
   * `maint_wo_parts`) — sve tri imaju `EXISTS (… maint_wo_row_visible …)`.
   */
  woChildWhere(
    s: MaintScope,
  ): { workOrder: WorkOrderScopeWhere } | undefined {
    const scope = this.workOrderListWhere(s);
    return scope ? { workOrder: scope } : undefined;
  }

  /**
   * `maint_incidents` SELECT = `maint_incident_row_visible(machine_code, asset_id)`
   * = `asset_id IS NOT NULL ? asset_visible(asset_id) : machine_visible(machine_code)`.
   */
  incidentListWhere(
    s: MaintScope,
  ):
    | {
        OR: (
          | { assetId: { not: null }; asset: AssetScopeWhere }
          | { assetId: null; machineCode?: { in: string[] } }
        )[];
      }
    | undefined {
    const assetScope = this.assetListWhere(s);
    if (!assetScope) return undefined;
    // 🔴 Grana `asset_id IS NULL` ide kroz `maint_machine_visible`, a ta funkcija
    // za `technician` (kao i `chief`/`management`/`admin`/floor-read) vraća TRUE
    // BEZ gledanja dodeljenih šifara — v. snimak žive baze
    // `authz-snapshots/talasF-fn-defs-2026-07-12.sql:1683`.
    // Zato je parnjak `machineListWhere` (`undefined` = bez sužavanja), a NE
    // `assignedMachineCodes`: sa njim bi tehničar, koji po pravilu nema dodeljene
    // šifre, dobio `in: []` i izgubio SVAKI incident bez sredstva — baš rola koja
    // kvarove i popravlja. Sužavanje je greška u TIHOM smeru (manje redova), pa ga
    // nijedan test tipa „ima li podataka" ne hvata.
    const machineScope = this.machineListWhere(s);
    return {
      OR: [
        { assetId: { not: null }, asset: assetScope },
        // Bez spread-a namerno: `assetId` i `machineCode` se ne sudaraju, ali
        // izričito nabrajanje sprečava da kasnija izmena tiho pregazi ključ.
        machineScope
          ? { assetId: null, machineCode: machineScope.machineCode }
          : { assetId: null },
      ],
    };
  }

  /**
   * `maint_incident_events` SELECT.
   *
   * 🔴 ASIMETRIJA KOJU JE LAKO PROMAŠITI: politika ovde gleda
   * `maint_machine_visible(i.machine_code)`, a NE `maint_incident_row_visible`.
   * Dakle trag kvara na VOZILU/IT/objektu (gde je `machine_code` šifra sredstva,
   * ne mašine) vidi se samo ako pozivalac vidi sve mašine. Prepis „po analogiji
   * sa `maint_incidents`" bi tiho PROŠIRIO prava — zato doslovno.
   */
  incidentEventWhere(
    s: MaintScope,
  ): { incident: { machineCode: { in: string[] } } } | undefined {
    const scope = this.machineListWhere(s);
    return scope ? { incident: scope } : undefined;
  }

  /**
   * `maint_drivers` SELECT = `floor_read ∨ erp_admin_or_mgmt ∨
   * profil ∈ (chief, admin, technician, operator) ∨ auth_user_id = uid()`.
   *
   * 🔴 Poslednji član je PER-RED: vozač bez ijedne od tih rola vidi SVOJ red.
   * Zato ovo nije bool nego `where`.
   */
  driverListWhere(s: MaintScope): { authUserId: number } | undefined {
    if (this.canReadAllDrivers(s)) return undefined;
    return { authUserId: s.userId };
  }

  /** Bool deo `maint_drivers_select` (bez per-red grane „ja sam taj vozač"). */
  canReadAllDrivers(s: MaintScope): boolean {
    return (
      this.hasFloorReadAccess(s) ||
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin" ||
      s.profileRole === "technician" ||
      s.profileRole === "operator"
    );
  }

  /**
   * `maint_user_profiles` SELECT = `uid() = user_id ∨ erp_admin`.
   * Bez ovoga bi svako video CMMS role i dodeljene mašine cele firme.
   */
  userProfileListWhere(s: MaintScope): { userId: number } | undefined {
    if (this.isErpAdmin(s)) return undefined;
    return { userId: s.userId };
  }

  /**
   * `maint_documents` SELECT = `maint_document_visible(...)` — kaskada po tome
   * koji je FK popunjen, ISTIM redosledom kao izvor (asset → nalog → incident →
   * preventivni zadatak → vozač), sa `ELSE FALSE` na kraju.
   *
   * 🔴 Grana preventivnog zadatka u sy15 NE gleda `tasks.asset_id` nego džoinuje
   * `maint_machines` po `machine_code` pa proverava `maint_asset_visible` nad
   * SREDSTVOM MAŠINE. Prepis po `tasks.asset_id` bi za zadatke nad vozilima dao
   * drugačiji odgovor — zato relacija ide kroz mašinu.
   *
   * `ELSE FALSE` je izražen tako što `OR` nabraja SAMO grane koje postoje:
   * dokument bez ijednog od pet FK-ova ne zadovoljava nijednu -> ne vidi se.
   */
  documentListWhere(s: MaintScope): Record<string, unknown> | undefined {
    const assetScope = this.assetListWhere(s);
    const woScope = this.workOrderListWhere(s);
    const incScope = this.incidentListWhere(s);
    const machineScope = this.machineListWhere(s);
    const driverAll = this.canReadAllDrivers(s);
    // Nema nijednog sužavanja ni na jednoj grani -> nema šta da se doda.
    if (!assetScope && !woScope && !incScope && !machineScope && driverAll) {
      return undefined;
    }
    return {
      OR: [
        { assetId: { not: null }, ...(assetScope ? { asset: assetScope } : {}) },
        {
          assetId: null,
          woId: { not: null },
          ...(woScope ? { workOrder: woScope } : {}),
        },
        {
          assetId: null,
          woId: null,
          incidentId: { not: null },
          ...(incScope ? { incident: incScope } : {}),
        },
        {
          assetId: null,
          woId: null,
          incidentId: null,
          preventiveTaskId: { not: null },
          ...(machineScope
            ? {
                preventiveTask: {
                  // Sredstvo MAŠINE zadatka, kao u sy15 (join po `machine_code`).
                  machineCode: machineScope.machineCode,
                },
              }
            : {}),
        },
        {
          assetId: null,
          woId: null,
          incidentId: null,
          preventiveTaskId: null,
          driverId: { not: null },
          ...(driverAll ? {} : { driver: { authUserId: s.userId } }),
        },
      ],
    };
  }

  /**
   * `maint_notification_rules` SELECT = `erp_admin_or_mgmt ∨
   * profil ∈ (chief, management, admin)`.
   * ⚠️ ŠIRE od `canReadNotificationLog` (magacioner vidi pravila, ali ne outbox).
   */
  canReadNotificationRules(s: MaintScope): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "management" ||
      s.profileRole === "admin"
    );
  }

  /**
   * `maint_settings` SELECT = `erp_admin_or_mgmt ∨
   * profil ∈ (operator, technician, chief, admin)`.
   *
   * 🔴 Spisak profila NE SADRŽI `management` — a `maint_settings_update` ga isto
   * ne sadrži. To je zatečena nedoslednost sy15 (rukovodstvo bez ERP role ne vidi
   * podešavanja CMMS-a), prenosi se DOSLOVNO. Popravka je odluka o proizvodu.
   */
  canReadSettings(s: MaintScope): boolean {
    return (
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "operator" ||
      s.profileRole === "technician" ||
      s.profileRole === "chief" ||
      s.profileRole === "admin"
    );
  }

  /**
   * `maint_machines_deletion_log` SELECT = `erp_admin ∨ erp_admin_or_mgmt ∨
   * profil ∈ (chief, admin, management)`. Upis je zabranjen politikom (`false`) —
   * jedini pisac je `maint_machine_delete_hard`.
   */
  canReadDeletionLog(s: MaintScope): boolean {
    return (
      this.isErpAdmin(s) ||
      this.isErpAdminOrManagement(s) ||
      s.profileRole === "chief" ||
      s.profileRole === "admin" ||
      s.profileRole === "management"
    );
  }

  // =========================================================================
  // 🔴 SCOPE ZA `security_invoker` VIEW-OVE — mora u UPIT, view ga više ne nosi
  // =========================================================================
  //
  // Izmereno na živoj sy15 (`pg_class.reloptions`): SVIH 16 `v_maint_*` view-ova
  // ima `security_invoker = true`, tj. RLS pozivaoca se primenjivao I KROZ VIEW.
  // U 3.0 RLS-a nema, pa view vraća SVE redove — scope MORA ući u `WHERE` upita
  // koji view čita. Ovo je najtiši način da prava nestanu: upit i dalje radi,
  // samo vraća više redova nego što sme.
  //
  // Ispod su SQL isečci (`Prisma.sql`) jer se view-ovi čitaju sirovim upitom.
  // Svaki vraća FRAGMENT bez `WHERE`/`AND` — pozivalac ga spaja sam.

  /**
   * Uslov nad kolonom `machine_code` view-a (`v_maint_machine_current_status`,
   * `v_maint_task_due_dates`, `v_maint_machine_last_check`).
   * `null` = nema sužavanja.
   */
  machineScopeSql(s: MaintScope, kolona = "machine_code"): Prisma.Sql | null {
    if (this.machineVisibleForAll(s)) return null;
    const codes = this.assignedMachineCodes(s);
    // Operater bez dodeljenih mašina: `= ANY('{}')` je već FALSE, ali eksplicitno
    // `FALSE` je čitljivije i ne šalje prazan niz kroz drajver.
    if (codes.length === 0) return Prisma.sql`FALSE`;
    return Prisma.sql`${Prisma.raw(kolona)} = ANY(${codes}::text[])`;
  }

  /**
   * Uslov nad kolonom `asset_id` view-a (`v_maint_vehicle_overview`,
   * `v_maint_it_overview`, `v_maint_facility_overview`, `v_maint_vehicle_bookings`,
   * `v_maint_vehicle_parts`, `v_maint_*_service_plan_due`).
   *
   * 🔴 Svi ti view-ovi vraćaju ISKLJUČIVO ne-mašinska sredstva (vozila / IT /
   * objekte), a za njih `maint_asset_visible` nema per-red scope: pravilo je
   * „sva ili nijedno" (`nonMachineVisible`). Zato je ovde odgovor bool-ski, a ne
   * lista id-jeva — i `FALSE` je tačan parnjak, ne prazna lista.
   */
  nonMachineViewScopeSql(s: MaintScope): Prisma.Sql | null {
    return this.nonMachineVisible(s) ? null : Prisma.sql`FALSE`;
  }

  /**
   * `v_maint_drivers_overview` — parnjak `maint_drivers_select`
   * (bool deo ∨ `auth_user_id = ja`).
   */
  driversViewScopeSql(s: MaintScope): Prisma.Sql | null {
    if (this.canReadAllDrivers(s)) return null;
    return Prisma.sql`auth_user_id = ${s.userId}`;
  }

  /**
   * `v_maint_parts_with_vehicles` i `v_maint_vehicle_parts` — magacin delova
   * (`maint_parts_select`). Nema per-red scope: `canReadStock` ili ništa.
   */
  partsViewScopeSql(s: MaintScope): Prisma.Sql | null {
    return this.canReadStock(s) ? null : Prisma.sql`FALSE`;
  }

  /**
   * Spaja scope fragment u `WHERE` klauzulu upita nad view-om.
   * Bez fragmenta vraća prazan `Prisma.sql` (upit ostaje nepromenjen).
   */
  viewWhere(fragment: Prisma.Sql | null): Prisma.Sql {
    return fragment ? Prisma.sql` WHERE ${fragment}` : Prisma.empty;
  }

  /**
   * 🔴 `v_maint_cmms_daily_summary` — KPI kartica.
   *
   * View je skup `count(*)` podupita nad `maint_work_orders`, `maint_incidents`,
   * `v_maint_task_due_dates` i `maint_parts`. U sy15 se izvršavao pod RLS-om
   * pozivaoca (security_invoker), pa su SVE brojke bile SUŽENE na ono što
   * pozivalac sme da vidi. U 3.0 view broji sve.
   *
   * Zato KPI pod `3.0` sme da se prikaže SAMO onome ko ionako vidi sve — a to je
   * tačno `machineVisibleForAll ∧ nonMachineVisible ∧ canReadStock`. Ostalima se
   * mora računati suženo (posao CRUD faze) ili ne prikazivati. Vraćanje
   * nesuženih brojki bilo bi curenje: „7 otvorenih kvarova" operateru koji sme
   * da vidi jednu mašinu odaje stanje cele firme.
   */
  canReadFullSummary(s: MaintScope): boolean {
    return (
      this.machineVisibleForAll(s) &&
      this.nonMachineVisible(s) &&
      this.canReadStock(s)
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
