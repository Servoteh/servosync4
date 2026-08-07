import {
  OdrzavanjeAuthzService,
  type MaintScope,
} from "./odrzavanje-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * READ-SCOPE — paritet 3.0 sloja sa 102 RLS politike žive sy15.
 *
 * ZAŠTO POSEBAN FAJL: `odrzavanje-authz.service.spec.ts` pokriva GEJTOVE
 * (`maint_is_erp_admin`, `maint_machine_visible`…). Ovde je pokriveno ono što je
 * u sy15 radio RLS nad SVAKOM tabelom — a to je jedini deo seobe koji, ako se
 * pogreši, NE PADA nego tiho vraća VIŠE redova nego što sme.
 *
 * Svako pravilo ima DVA testa, kao što traži nalog: „vidi svoje” i
 * „NE vidi tuđe”. Izvor istine su `qual` izrazi povučeni sa žive sy15
 * (`pg_policies`, 06.08.2026) — citirani su iznad svake grupe.
 */

const svc = new OdrzavanjeAuthzService({} as unknown as PrismaService);

function scope(p: Partial<MaintScope> = {}): MaintScope {
  return {
    userId: 7,
    erpRoles: new Set<string>(),
    profileRole: null,
    assignedMachineCodes: [],
    ...p,
  };
}

/** Operater sa dve dodeljene mašine — jedini profil sa PRAVIM per-red scope-om. */
const OPERATER = scope({
  userId: 7,
  profileRole: "operator",
  assignedMachineCodes: ["3.12", "6.1"],
});
/** Operater kome nijedna mašina nije dodeljena (zamka „nema dodeljene = vidi sve”). */
const OPERATER_BEZ = scope({ userId: 8, profileRole: "operator" });
/** Tehničar BEZ ERP role — grana `M ∧ ¬N` koju je prva verzija promašila. */
const TEHNICAR = scope({ userId: 9, profileRole: "technician" });
/** Šef — vidi sve, i mašine i vozila. */
const SEF = scope({ userId: 10, profileRole: "chief" });
/** ERP admin — vidi sve preko `user_roles`, bez maint profila. */
const ADMIN = scope({ userId: 11, erpRoles: new Set(["admin"]) });

describe("maint_machines / maint_checks / maint_tasks / mmf / override — maint_machine_visible(machine_code)", () => {
  it("operater VIDI svoje mašine (filter `in` nosi baš njegove šifre)", () => {
    expect(svc.machineScopedWhere(OPERATER)).toEqual({
      machineCode: { in: ["3.12", "6.1"] },
    });
  });

  it("🔴 operater NE VIDI tuđu mašinu — filter je zatvoren spisak, ne 'sve'", () => {
    const w = svc.machineScopedWhere(OPERATER);
    expect(w?.machineCode.in).not.toContain("8.2");
    expect(svc.machineVisible(OPERATER, "8.2")).toBe(false);
  });

  it("🔴 operater BEZ dodeljenih mašina ne vidi NIJEDNU (prazan `in`, ne `undefined`)", () => {
    // `cardinality(...) > 0` je uslov u sy15 — prepis bez njega bi „nema
    // dodeljene mašine" pretvorio u „vidi sve”.
    expect(svc.machineScopedWhere(OPERATER_BEZ)).toEqual({
      machineCode: { in: [] },
    });
    expect(svc.machineScopedWhere(OPERATER_BEZ)).not.toBeUndefined();
  });

  it("šef/tehničar/admin vide sve — `undefined` (bez sužavanja)", () => {
    for (const s of [SEF, TEHNICAR, ADMIN]) {
      expect(svc.machineScopedWhere(s)).toBeUndefined();
    }
  });
});

describe("maint_machine_notes — `deleted_at IS NULL AND maint_machine_visible(...)`", () => {
  it("🔴 soft-delete filter ULAZI U UPIT i kad nema sužavanja po mašini", () => {
    // U sy15 ga nosi RLS, pa ga kod nigde ne piše. Bez ovoga bi obrisane
    // napomene pod `3.0` tiho iskrsle nazad u listi.
    expect(svc.machineNotesWhere(SEF)).toEqual({ deletedAt: null });
  });

  it("operater: soft-delete filter I spisak mašina zajedno", () => {
    expect(svc.machineNotesWhere(OPERATER)).toEqual({
      deletedAt: null,
      machineCode: { in: ["3.12", "6.1"] },
    });
  });
});

describe("maint_assets — maint_asset_visible(asset_id)", () => {
  it("šef i admin vide sva sredstva (bez sužavanja)", () => {
    expect(svc.assetListWhere(SEF)).toBeUndefined();
    expect(svc.assetListWhere(ADMIN)).toBeUndefined();
  });

  it("🔴 TEHNICAR bez ERP role: SVE mašine, ali NIJEDNO vozilo/IT/objekat", () => {
    // Ovo je grana `M ∧ ¬N`. Prva verzija je ovde vraćala filter po dodeljenim
    // šiframa (kojih tehničar nema) → tehničar nije video NIJEDNO sredstvo.
    expect(svc.machineVisibleForAll(TEHNICAR)).toBe(true);
    expect(svc.nonMachineVisible(TEHNICAR)).toBe(false);
    expect(svc.assetListWhere(TEHNICAR)).toEqual({ assetType: "machine" });
  });

  it("operater VIDI sredstvo svoje mašine, a NE VIDI tuđe ni vozila", () => {
    expect(svc.assetListWhere(OPERATER)).toEqual({
      assetType: "machine",
      machine: { machineCode: { in: ["3.12", "6.1"] } },
    });
    expect(
      svc.assetVisible(OPERATER, { assetType: "machine", machineCode: "3.12" }),
    ).toBe(true);
    expect(
      svc.assetVisible(OPERATER, { assetType: "machine", machineCode: "8.2" }),
    ).toBe(false);
    expect(svc.assetVisible(OPERATER, { assetType: "vehicle" })).toBe(false);
  });

  it("deca sredstva (planovi, gume, rezervacije, detalji) nasleđuju isti scope", () => {
    expect(svc.assetScopedWhere(OPERATER)).toEqual({
      asset: {
        assetType: "machine",
        machine: { machineCode: { in: ["3.12", "6.1"] } },
      },
    });
    expect(svc.assetScopedWhere(SEF)).toBeUndefined();
  });
});

describe("maint_work_orders — maint_wo_row_visible(asset, assigned, reported)", () => {
  it("🔴 „moj nalog je uvek moj”: disjunkcija dodeljeni ∨ prijavilac ∨ sredstvo", () => {
    const w = svc.workOrderListWhere(OPERATER);
    expect(w).toEqual({
      OR: [
        { assignedTo: 7 },
        { reportedBy: 7 },
        {
          asset: {
            assetType: "machine",
            machine: { machineCode: { in: ["3.12", "6.1"] } },
          },
        },
      ],
    });
  });

  it("operater VIDI nalog koji je sam prijavio na TUĐOJ mašini", () => {
    expect(
      svc.woRowVisible(OPERATER, {
        assignedTo: null,
        reportedBy: 7,
        asset: { assetType: "machine", machineCode: "8.2" },
      }),
    ).toBe(true);
  });

  it("🔴 operater NE VIDI tuđi nalog na tuđoj mašini", () => {
    expect(
      svc.woRowVisible(OPERATER, {
        assignedTo: 99,
        reportedBy: 99,
        asset: { assetType: "machine", machineCode: "8.2" },
      }),
    ).toBe(false);
  });

  it("deca naloga (events/labor/parts) nose isti scope kroz relaciju", () => {
    expect(svc.woChildWhere(OPERATER)).toEqual({
      workOrder: svc.workOrderListWhere(OPERATER),
    });
    expect(svc.woChildWhere(SEF)).toBeUndefined();
  });
});

describe("maint_incidents / maint_incident_events", () => {
  it("incident na sredstvu ide kroz asset-scope, bez sredstva kroz mašinu", () => {
    const w = svc.incidentListWhere(OPERATER) as {
      OR: Record<string, unknown>[];
    };
    expect(w.OR).toHaveLength(2);
    expect(w.OR[1]).toEqual({
      assetId: null,
      machineCode: { in: ["3.12", "6.1"] },
    });
  });

  it("operater vidi svoj kvar na svojoj mašini, ne i na tuđoj", () => {
    expect(
      svc.incidentRowVisible(OPERATER, { machineCode: "3.12", asset: null }),
    ).toBe(true);
    expect(
      svc.incidentRowVisible(OPERATER, { machineCode: "8.2", asset: null }),
    ).toBe(false);
  });

  it("🔴 ASIMETRIJA: trag kvara gleda maint_machine_visible, NE incident_row_visible", () => {
    // `maint_inc_events_select` u sy15 proverava SAMO `machine_visible(i.machine_code)`.
    // Prepis „po analogiji sa maint_incidents” bi tiho PROŠIRIO prava na kvarove
    // nad vozilima/IT/objektima.
    expect(svc.incidentEventWhere(OPERATER)).toEqual({
      incident: { machineCode: { in: ["3.12", "6.1"] } },
    });
    // Šef vidi sve mašine -> nema sužavanja ni na tragu.
    expect(svc.incidentEventWhere(SEF)).toBeUndefined();
  });
});

describe("maint_drivers — per-red grana ", () => {
  it("vozač BEZ ijedne role vidi SVOJ red", () => {
    const vozac = scope({ userId: 42 });
    expect(svc.canReadAllDrivers(vozac)).toBe(false);
    expect(svc.driverListWhere(vozac)).toEqual({ authUserId: 42 });
  });

  it("🔴 vozač BEZ role NE VIDI tuđi red (filter nije `undefined`)", () => {
    expect(svc.driverListWhere(scope({ userId: 42 }))).not.toBeUndefined();
  });

  it("operater/tehničar/šef/magacioner vide sve vozače", () => {
    for (const s of [
      OPERATER,
      TEHNICAR,
      SEF,
      scope({ erpRoles: new Set(["magacioner"]) }),
    ]) {
      expect(svc.driverListWhere(s)).toBeUndefined();
    }
  });
});

describe("maint_user_profiles — `uid() = user_id ∨ erp_admin`", () => {
  it("običan korisnik vidi SVOJ profil", () => {
    expect(svc.userProfileListWhere(OPERATER)).toEqual({ userId: 7 });
  });

  it("🔴 običan korisnik NE VIDI tuđe CMMS role ni dodeljene mašine", () => {
    expect(svc.userProfileListWhere(SEF)).toEqual({ userId: 10 });
    // Ni šef ovde nije izuzetak — politika zna SAMO za erp_admin.
    expect(svc.userProfileListWhere(ADMIN)).toBeUndefined();
  });
});

describe("maint_documents — kaskada `maint_document_visible` sa ELSE FALSE", () => {
  it("dokument bez ijedne veze se NE VIDI (ELSE FALSE)", () => {
    expect(
      svc.documentVisible(OPERATER, {
        asset: null,
        workOrder: null,
        incident: null,
        preventiveTaskAsset: null,
        driver: null,
      }),
    ).toBe(false);
  });

  it("kaskada poštuje redosled: sredstvo pre naloga, nalog pre incidenta", () => {
    // Sredstvo je tuđe -> `false`, iako bi nalog (moj) dao `true`. Isti redosled
    // kao `CASE WHEN p_asset_id IS NOT NULL THEN …` u izvoru.
    expect(
      svc.documentVisible(OPERATER, {
        asset: { assetType: "machine", machineCode: "8.2" },
        workOrder: { assignedTo: 7, reportedBy: 7, asset: null },
        incident: null,
        preventiveTaskAsset: null,
        driver: null,
      }),
    ).toBe(false);
  });

  it("dokument vozača: sam vozač ga vidi i bez ijedne role", () => {
    const vozac = scope({ userId: 42 });
    expect(
      svc.documentVisible(vozac, {
        asset: null,
        workOrder: null,
        incident: null,
        preventiveTaskAsset: null,
        driver: { authUserId: 42 },
      }),
    ).toBe(true);
    expect(
      svc.documentVisible(vozac, {
        asset: null,
        workOrder: null,
        incident: null,
        preventiveTaskAsset: null,
        driver: { authUserId: 43 },
      }),
    ).toBe(false);
  });

  it("lista dokumenata: admin bez sužavanja, operater sa pet grana", () => {
    expect(svc.documentListWhere(ADMIN)).toBeUndefined();
    const w = svc.documentListWhere(OPERATER) as { OR: unknown[] };
    expect(w.OR).toHaveLength(5);
  });

  it("🔴 grana preventivnog zadatka ide kroz MAŠINU zadatka, ne kroz tasks.asset_id", () => {
    const w = svc.documentListWhere(OPERATER) as {
      OR: Record<string, unknown>[];
    };
    expect(w.OR[3]).toMatchObject({
      preventiveTaskId: { not: null },
      preventiveTask: { machineCode: { in: ["3.12", "6.1"] } },
    });
  });
});

describe("Ravne role-kapije čitanja (bez per-red scope-a)", () => {
  it("outbox (`maint_notification_log`): magacioner NE vidi, šef vidi", () => {
    expect(
      svc.canReadNotificationLog(scope({ erpRoles: new Set(["magacioner"]) })),
    ).toBe(false);
    expect(svc.canReadNotificationLog(SEF)).toBe(true);
  });

  it("pravila obaveštavanja su ŠIRA od outbox-a — magacioner ih vidi", () => {
    const magacioner = scope({ erpRoles: new Set(["magacioner"]) });
    expect(svc.canReadNotificationRules(magacioner)).toBe(true);
    expect(svc.canReadNotificationLog(magacioner)).toBe(false);
  });

  it("🔴 `maint_settings` NE daje pristup profilu `management` (zatečena nedoslednost sy15)", () => {
    expect(svc.canReadSettings(scope({ profileRole: "management" }))).toBe(false);
    expect(svc.canReadSettings(scope({ profileRole: "operator" }))).toBe(true);
    expect(svc.canReadSettings(scope({ profileRole: "technician" }))).toBe(true);
  });

  it("trag brisanja mašina vidi i `management`, a operater ne", () => {
    expect(svc.canReadDeletionLog(scope({ profileRole: "management" }))).toBe(true);
    expect(svc.canReadDeletionLog(OPERATER)).toBe(false);
  });

  it("magacin (`maint_parts`/`suppliers`/`movements`/`locations`): operater NE vidi", () => {
    expect(svc.canReadStock(OPERATER)).toBe(false);
    expect(svc.canReadStock(TEHNICAR)).toBe(true);
  });
});

describe("🔴 scope za `security_invoker` view-ove — mora u UPIT", () => {
  it("machineScopeSql: šef bez sužavanja, operater po šiframa, operater bez mašina = FALSE", () => {
    expect(svc.machineScopeSql(SEF)).toBeNull();
    const w = svc.machineScopeSql(OPERATER);
    expect(w?.sql).toContain("machine_code");
    expect(w?.values).toEqual([["3.12", "6.1"]]);
    expect(svc.machineScopeSql(OPERATER_BEZ)?.sql).toBe("FALSE");
  });

  it("machineScopeSql poštuje alias kolone (view-ovi je zovu isto, ali join-ovi ne)", () => {
    expect(svc.machineScopeSql(OPERATER, "d.machine_code")?.sql).toContain(
      "d.machine_code",
    );
  });

  it("🔴 view-ovi vozila/IT/objekata: pravilo je , pa je FALSE tacan parnjak", () => {
    expect(svc.nonMachineViewScopeSql(SEF)).toBeNull();
    // Tehničar vidi sve mašine, ali NE vozila — view vozila mu mora dati nula redova.
    expect(svc.nonMachineViewScopeSql(TEHNICAR)?.sql).toBe("FALSE");
    expect(svc.nonMachineViewScopeSql(OPERATER)?.sql).toBe("FALSE");
  });

  it("driversViewScopeSql: bez role -> samo svoj red", () => {
    const w = svc.driversViewScopeSql(scope({ userId: 42 }));
    expect(w?.sql).toContain("auth_user_id");
    expect(w?.values).toEqual([42]);
    expect(svc.driversViewScopeSql(OPERATER)).toBeNull();
  });

  it("partsViewScopeSql: operater ne vidi magacin ni kroz view", () => {
    expect(svc.partsViewScopeSql(OPERATER)?.sql).toBe("FALSE");
    expect(svc.partsViewScopeSql(TEHNICAR)).toBeNull();
  });

  it("🔴 KPI kartica (`v_maint_cmms_daily_summary`) sme SAMO onome ko vidi sve", () => {
    // U sy15 su brojke bile sužene RLS-om; nesužene bi operateru odale stanje
    // cele firme („7 otvorenih kvarova”) iako sme da vidi jednu mašinu.
    expect(svc.canReadFullSummary(ADMIN)).toBe(true);
    expect(svc.canReadFullSummary(SEF)).toBe(true);
    expect(svc.canReadFullSummary(TEHNICAR)).toBe(false);
    expect(svc.canReadFullSummary(OPERATER)).toBe(false);
  });

  it("viewWhere spaja fragment u WHERE, a bez fragmenta ne dodaje ništa", () => {
    expect(svc.viewWhere(null).sql).toBe("");
    expect(svc.viewWhere(svc.machineScopeSql(OPERATER)).sql).toContain("WHERE");
  });
});
