import { OdrzavanjeAuthzService, type MaintScope } from "./odrzavanje-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Paritet-testovi 3.0 parnjaka sy15 RLS-a i gejt funkcija održavanja.
 *
 * ZAŠTO OVAJ FAJL POSTOJI: u sy15 row-scope sprovodi 102 RLS politike, pa ga kod
 * NIJE duplirao. U 3.0 RLS-a nema — prava sada zavise ISKLJUČIVO od ovog servisa,
 * a greška u njemu se ne vidi kao pad nego kao TIHO ŠIRA prava (operater vidi sve
 * mašine) ili tiho uža (svi izgube pristup). Zato je svako pravilo pinovano
 * posebno, sa telom sy15 funkcije kao izvorom istine (`pg_get_functiondef`,
 * izvučeno sa žive baze 06.08.2026).
 */

const svc = new OdrzavanjeAuthzService({} as unknown as PrismaService);

function scope(p: Partial<MaintScope> = {}): MaintScope {
  return {
    userId: 1,
    erpRoles: new Set<string>(),
    profileRole: null,
    assignedMachineCodes: [],
    ...p,
  };
}

describe("ERP gejtovi (user_roles / users.role unija)", () => {
  it("isErpAdmin: samo rola `admin`", () => {
    expect(svc.isErpAdmin(scope({ erpRoles: new Set(["admin"]) }))).toBe(true);
    expect(svc.isErpAdmin(scope({ erpRoles: new Set(["menadzment"]) }))).toBe(
      false,
    );
    expect(svc.isErpAdmin(scope())).toBe(false);
  });

  it("🔴 isErpAdminOrManagement UKLJUČUJE i `magacioner` (ime funkcije laže)", () => {
    for (const r of ["admin", "menadzment", "magacioner"]) {
      expect(
        svc.isErpAdminOrManagement(scope({ erpRoles: new Set([r]) })),
      ).toBe(true);
    }
    expect(
      svc.isErpAdminOrManagement(scope({ erpRoles: new Set(["monter"]) })),
    ).toBe(false);
  });

  it("hasFloorReadAccess: 7 rola sa poda (prepis sy15 spiska)", () => {
    for (const r of [
      "admin",
      "pm",
      "leadpm",
      "menadzment",
      "magacioner",
      "monter",
      "tim_lider",
    ]) {
      expect(svc.hasFloorReadAccess(scope({ erpRoles: new Set([r]) }))).toBe(
        true,
      );
    }
    // `kontrolor` NIJE u spisku — izmereno: to je jedina razlika prema sy15
    // (`kontrola@servoteh.com`), i odluka je prosleđena, ne doneta.
    expect(
      svc.hasFloorReadAccess(scope({ erpRoles: new Set(["kontrolor"]) })),
    ).toBe(false);
    expect(
      svc.hasFloorReadAccess(scope({ erpRoles: new Set(["inzenjer"]) })),
    ).toBe(false);
  });
});

describe("maint_machine_visible — jedini per-red scope u modulu", () => {
  it("rola sa poda vidi svaku mašinu", () => {
    const s = scope({ erpRoles: new Set(["menadzment"]) });
    expect(svc.machineVisible(s, "3.12")).toBe(true);
    expect(svc.machineVisible(s, "bilo-sta")).toBe(true);
  });

  it("chief/technician/management/admin profil vidi svaku mašinu", () => {
    for (const r of ["chief", "technician", "management", "admin"] as const) {
      expect(svc.machineVisible(scope({ profileRole: r }), "3.12")).toBe(true);
    }
  });

  it("operater vidi SAMO dodeljene mašine", () => {
    const s = scope({
      profileRole: "operator",
      assignedMachineCodes: ["3.12", "4.01"],
    });
    expect(svc.machineVisible(s, "3.12")).toBe(true);
    expect(svc.machineVisible(s, "4.01")).toBe(true);
    expect(svc.machineVisible(s, "9.99")).toBe(false);
  });

  it("🔴 operater sa PRAZNOM listom ne vidi NIJEDNU (cardinality > 0)", () => {
    // Zamka: prepis bez `cardinality(...) > 0` pretvorio bi „nema dodeljene
    // mašine" u „vidi sve" — tiho proširenje prava koje nijedan test ne bi hvatao.
    const s = scope({ profileRole: "operator", assignedMachineCodes: [] });
    expect(svc.machineVisible(s, "3.12")).toBe(false);
    expect(svc.machineVisible(s, null)).toBe(false);
  });

  it("bez ijedne role i bez profila: ne vidi ništa", () => {
    expect(svc.machineVisible(scope(), "3.12")).toBe(false);
  });
});

describe("maint_asset_visible — mašine per-red, ostalo sve-ili-ništa", () => {
  const masina = { assetType: "machine", machineCode: "3.12" };
  const vozilo = { assetType: "vehicle" as const, machineCode: null };

  it("mašinsko sredstvo delegira na machineVisible", () => {
    const op = scope({ profileRole: "operator", assignedMachineCodes: ["3.12"] });
    expect(svc.assetVisible(op, masina)).toBe(true);
    expect(
      svc.assetVisible(op, { assetType: "machine", machineCode: "9.99" }),
    ).toBe(false);
  });

  it("🔴 operater sa dodeljenom mašinom NE VIDI vozila (nema per-red scope-a)", () => {
    const op = scope({ profileRole: "operator", assignedMachineCodes: ["3.12"] });
    expect(svc.assetVisible(op, vozilo)).toBe(false);
  });

  it("chief/management/admin i pod vide sva ne-mašinska sredstva", () => {
    expect(svc.assetVisible(scope({ profileRole: "chief" }), vozilo)).toBe(true);
    expect(
      svc.assetVisible(scope({ erpRoles: new Set(["magacioner"]) }), vozilo),
    ).toBe(true);
  });

  it("null sredstvo = nevidljivo (default deny)", () => {
    expect(svc.assetVisible(scope({ erpRoles: new Set(["admin"]) }), null)).toBe(
      false,
    );
  });
});

describe("maint_wo_row_visible — „moj nalog je uvek moj\"", () => {
  const tudjaMasina = { assetType: "machine", machineCode: "9.99" };

  it("dodeljeni vidi nalog i kad sredstvo ne vidi", () => {
    const op = scope({
      userId: 7,
      profileRole: "operator",
      assignedMachineCodes: ["3.12"],
    });
    expect(
      svc.woRowVisible(op, {
        assignedTo: 7,
        reportedBy: 99,
        asset: tudjaMasina,
      }),
    ).toBe(true);
  });

  it("prijavilac vidi nalog i kad sredstvo ne vidi", () => {
    const op = scope({ userId: 7, profileRole: "operator" });
    expect(
      svc.woRowVisible(op, {
        assignedTo: null,
        reportedBy: 7,
        asset: tudjaMasina,
      }),
    ).toBe(true);
  });

  it("tuđi nalog na nevidljivom sredstvu = nevidljiv", () => {
    const op = scope({ userId: 7, profileRole: "operator" });
    expect(
      svc.woRowVisible(op, {
        assignedTo: 8,
        reportedBy: 9,
        asset: tudjaMasina,
      }),
    ).toBe(false);
  });
});

describe("maint_document_visible — kaskada + default DENY", () => {
  const prazno = {
    asset: null,
    workOrder: null,
    incident: null,
    preventiveTaskAsset: null,
    driver: null,
  };

  it("🔴 dokument bez ijedne veze je NEVIDLJIV i administratoru (ELSE FALSE)", () => {
    expect(
      svc.documentVisible(scope({ erpRoles: new Set(["admin"]) }), prazno),
    ).toBe(false);
  });

  it("dokument vozača: vidi ga i SAM vozač preko auth_user_id", () => {
    const s = scope({ userId: 42 });
    expect(
      svc.documentVisible(s, { ...prazno, driver: { authUserId: 42 } }),
    ).toBe(true);
    expect(
      svc.documentVisible(s, { ...prazno, driver: { authUserId: 43 } }),
    ).toBe(false);
  });

  it("dokument naloga nasleđuje pravilo „moj nalog\"", () => {
    const s = scope({ userId: 7, profileRole: "operator" });
    expect(
      svc.documentVisible(s, {
        ...prazno,
        workOrder: {
          assignedTo: 7,
          reportedBy: null,
          asset: { assetType: "machine", machineCode: "9.99" },
        },
      }),
    ).toBe(true);
  });
});

describe("write pravila koja RLS više ne brani", () => {
  it("🔴 pravilo 24h: operater/tehničar menja SVOJE samo prvih 24 sata", () => {
    const now = new Date("2026-08-06T12:00:00Z");
    const op = scope({ userId: 5, profileRole: "operator" });
    const svez = { authorId: 5, createdAt: new Date("2026-08-06T02:00:00Z") };
    const star = { authorId: 5, createdAt: new Date("2026-08-04T02:00:00Z") };
    expect(svc.canEditOwnWithin24h(op, svez, now)).toBe(true);
    expect(svc.canEditOwnWithin24h(op, star, now)).toBe(false);
    // Tuđe ne sme ni u prva 24 sata.
    expect(
      svc.canEditOwnWithin24h(op, { authorId: 6, createdAt: svez.createdAt }, now),
    ).toBe(false);
    // chief/admin nemaju vremensko ograničenje.
    expect(
      svc.canEditOwnWithin24h(scope({ profileRole: "chief" }), star, now),
    ).toBe(true);
  });

  it("🔴 rolu/aktivnost profila menja SAMO erp_admin (guard trigger)", () => {
    // Bez ovog guarda RLS UPDATE politika („svoj red") dozvoljava eskalaciju
    // privilegija: korisnik bi sebi postavio role='admin'.
    expect(svc.canChangeProfileRole(scope({ profileRole: "admin" }))).toBe(false);
    expect(svc.canChangeProfileRole(scope({ profileRole: "chief" }))).toBe(false);
    expect(
      svc.canChangeProfileRole(scope({ erpRoles: new Set(["admin"]) })),
    ).toBe(true);
  });

  it("nalog se ne otvara na tuđe ime (reported_by = ja)", () => {
    const s = scope({ userId: 5, profileRole: "technician" });
    expect(svc.canCreateWorkOrder(s, 5)).toBe(true);
    expect(svc.canCreateWorkOrder(s, 6)).toBe(false);
  });

  it("prijavu kvara sme SVAKO ulogovan — ali samo u svoje ime", () => {
    const niko = scope({ userId: 5 });
    expect(svc.canReportIncident(niko, 5)).toBe(true);
    expect(svc.canReportIncident(niko, 6)).toBe(false);
  });

  it("🔴 fajlove na prijavu kači SAMO prijavilac (skriveno pravilo DEFINER fn-a)", () => {
    const s = scope({ userId: 5, erpRoles: new Set(["admin"]) });
    // Ni administrator ne sme — `maint_attach_incident_files` nema role-guard,
    // samo `WHERE i.reported_by = auth.uid()`.
    expect(svc.canAttachIncidentFiles(s, 5)).toBe(true);
    expect(svc.canAttachIncidentFiles(s, 6)).toBe(false);
    expect(svc.canAttachIncidentFiles(s, null)).toBe(false);
  });

  it("kontrolu upisuje sam izvršilac i samo na vidljivoj mašini", () => {
    const op = scope({
      userId: 5,
      profileRole: "operator",
      assignedMachineCodes: ["3.12"],
    });
    expect(svc.canCreateCheck(op, 5, "3.12")).toBe(true);
    expect(svc.canCreateCheck(op, 5, "9.99")).toBe(false);
    expect(svc.canCreateCheck(op, 6, "3.12")).toBe(false);
  });

  it("„moja rezervacija je moja\"", () => {
    const s = scope({ userId: 5 });
    expect(svc.canUpdateBooking(s, 5)).toBe(true);
    expect(svc.canUpdateBooking(s, 6)).toBe(false);
    expect(svc.canUpdateBooking(scope({ profileRole: "chief" }), 6)).toBe(true);
  });

  it("🔴 brisanje vozača je UŽE od izmene — chief NE sme", () => {
    expect(svc.canDeleteDriver(scope({ profileRole: "chief" }))).toBe(false);
    expect(svc.canDeleteDriver(scope({ profileRole: "admin" }))).toBe(true);
    expect(
      svc.canDeleteDriver(scope({ erpRoles: new Set(["menadzment"]) })),
    ).toBe(true);
  });

  it("🔴 trajno brisanje mašine: ŠIRE od preimenovanja, ali ne za operatera/tehničara", () => {
    for (const r of ["admin", "menadzment", "magacioner"]) {
      expect(svc.canDeleteMachineHard(scope({ erpRoles: new Set([r]) }))).toBe(
        true,
      );
    }
    expect(svc.canDeleteMachineHard(scope({ profileRole: "chief" }))).toBe(
      true,
    );
    expect(svc.canDeleteMachineHard(scope({ profileRole: "admin" }))).toBe(
      true,
    );
    // Tehničar popravlja mašine — ne briše ih iz kataloga; operater pogotovo ne.
    expect(svc.canDeleteMachineHard(scope({ profileRole: "technician" }))).toBe(
      false,
    );
    expect(
      svc.canDeleteMachineHard(
        scope({ profileRole: "operator", assignedMachineCodes: ["3.12"] }),
      ),
    ).toBe(false);
    expect(svc.canDeleteMachineHard(scope())).toBe(false);
  });

  it("🔴 ko sme da briše mašinu, tu mašinu i VIDI (mereno nad celim katalogom rola)", () => {
    // Ovo je razlog što u koraku 1 hard-delete-a scope nije dovoljan, nego mora
    // GEJT: svaka rola koju `canDeleteMachineHard` pušta ionako prolazi
    // `machineVisible`, pa bi „skupi samo vidljive fajlove" pustilo BAŠ SVE.
    // Ako se spisak rola ikad razdvoji, ovaj test pada i scope postaje živ.
    const kandidati: MaintScope[] = [
      ...["admin", "menadzment", "magacioner", "monter", "pm", "kontrolor"].map(
        (r) => scope({ erpRoles: new Set([r]) }),
      ),
      ...(
        ["operator", "technician", "chief", "management", "admin"] as const
      ).map((r) => scope({ profileRole: r })),
    ];
    for (const s of kandidati) {
      if (svc.canDeleteMachineHard(s)) {
        expect(svc.machineVisible(s, "3.12")).toBe(true);
      }
    }
  });

  it("zatvaranje incidenta je POSEBNO pravo (odvojeno od izmene)", () => {
    expect(svc.canCloseIncident(scope({ profileRole: "technician" }))).toBe(
      false,
    );
    expect(svc.canCloseIncident(scope({ profileRole: "chief" }))).toBe(true);
    expect(
      svc.canCloseIncident(scope({ erpRoles: new Set(["magacioner"]) })),
    ).toBe(true);
  });
});

describe("read-scope liste", () => {
  it("operater dobija `in` filter po dodeljenim šiframa", () => {
    const op = scope({
      profileRole: "operator",
      assignedMachineCodes: ["3.12", "4.01"],
    });
    expect(svc.machineListWhere(op)).toEqual({
      machineCode: { in: ["3.12", "4.01"] },
    });
  });

  it("operater bez dodela dobija PRAZAN `in` → nula redova (kao RLS)", () => {
    const op = scope({ profileRole: "operator", assignedMachineCodes: [] });
    expect(svc.machineListWhere(op)).toEqual({ machineCode: { in: [] } });
  });

  it("rola sa poda nema sužavanje (undefined)", () => {
    expect(
      svc.machineListWhere(scope({ erpRoles: new Set(["menadzment"]) })),
    ).toBeUndefined();
  });

  it("🔴 outbox obaveštenja NE vidi magacioner (uže od erp_admin_or_management)", () => {
    expect(
      svc.canReadNotificationLog(scope({ erpRoles: new Set(["magacioner"]) })),
    ).toBe(false);
    expect(
      svc.canReadNotificationLog(scope({ erpRoles: new Set(["admin"]) })),
    ).toBe(true);
    expect(svc.canReadNotificationLog(scope({ profileRole: "chief" }))).toBe(
      true,
    );
  });

  it("delove/dobavljače vidi pod + tehničar naviše", () => {
    expect(svc.canReadStock(scope({ profileRole: "technician" }))).toBe(true);
    expect(svc.canReadStock(scope({ profileRole: "operator" }))).toBe(false);
    expect(
      svc.canReadStock(scope({ erpRoles: new Set(["monter"]) })),
    ).toBe(true);
  });
});

describe("loadScope — snimak prava iz 3.0 baze", () => {
  function prismaMock(opts: {
    user?: { role: string | null; active: boolean } | null;
    extra?: { role: string }[];
    profile?: {
      role: string;
      active: boolean;
      assignedMachineCodes: string[];
    } | null;
  }) {
    return {
      user: { findUnique: jest.fn().mockResolvedValue(opts.user ?? null) },
      userRole: { findMany: jest.fn().mockResolvedValue(opts.extra ?? []) },
      maintUserProfile: {
        findUnique: jest.fn().mockResolvedValue(opts.profile ?? null),
      },
    } as unknown as PrismaService;
  }

  it("🔴 spaja `users.role` I `user_roles.role` (ne samo jedno)", async () => {
    // Merenje 06.08.2026: 3.0 `user_roles` ima 11 globalnih redova, a sy15 60.
    // Da se čitalo SAMO `user_roles`, floor_read bi pao sa 35 ljudi na ~11.
    const s = new OdrzavanjeAuthzService(
      prismaMock({
        user: { role: "menadzment", active: true },
        extra: [{ role: "magacioner" }],
      }),
    );
    const sc = await s.loadScope(1);
    expect([...sc.erpRoles].sort()).toEqual(["magacioner", "menadzment"]);
    expect(s.hasFloorReadAccess(sc)).toBe(true);
  });

  it("neaktivan nalog ne nosi primarnu rolu", async () => {
    const s = new OdrzavanjeAuthzService(
      prismaMock({ user: { role: "admin", active: false } }),
    );
    const sc = await s.loadScope(1);
    expect(sc.erpRoles.size).toBe(0);
    expect(s.isErpAdmin(sc)).toBe(false);
  });

  it("🔴 NEAKTIVAN maint profil ne daje ni rolu ni dodeljene mašine", async () => {
    const s = new OdrzavanjeAuthzService(
      prismaMock({
        profile: {
          role: "chief",
          active: false,
          assignedMachineCodes: ["3.12"],
        },
      }),
    );
    const sc = await s.loadScope(1);
    expect(sc.profileRole).toBeNull();
    expect(sc.assignedMachineCodes).toEqual([]);
    expect(s.machineVisible(sc, "3.12")).toBe(false);
  });

  it("rola se normalizuje na mala slova i trim", async () => {
    const s = new OdrzavanjeAuthzService(
      prismaMock({ user: { role: "  Admin ", active: true } }),
    );
    const sc = await s.loadScope(1);
    expect(s.isErpAdmin(sc)).toBe(true);
  });
});
