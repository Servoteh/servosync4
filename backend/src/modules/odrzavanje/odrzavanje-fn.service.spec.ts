import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import {
  OdrzavanjeAuthzService,
  type MaintScope,
} from "./odrzavanje-authz.service";
import { maintMachineDeptCode } from "./maint-dept-code";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Paritet-testovi prepisa sy15 DEFINER funkcija i LOGIČKIH trigera održavanja.
 *
 * ZAŠTO OVAJ FAJL POSTOJI: 11 trigera koje migracija namerno NE prenosi više ne
 * postoje u bazi — postoje SAMO kao pozivi iz servisa. Greška u njima se ne vidi
 * kao pad nego kao nedostajući trag, nenapravljen nalog ili nepomereno stanje
 * zaliha. Svako pravilo je zato pinovano posebno, sa telom sy15 funkcije kao
 * izvorom istine (`pg_get_functiondef`, živa baza, 06.08.2026).
 */

function scope(p: Partial<MaintScope> = {}): MaintScope {
  return {
    userId: 7,
    erpRoles: new Set<string>(),
    profileRole: null,
    assignedMachineCodes: [],
    ...p,
  };
}

const ADMIN = scope({ userId: 1, erpRoles: new Set(["admin"]) });
const SEF = scope({ userId: 2, profileRole: "chief" });
const TEHNICAR = scope({ userId: 3, profileRole: "technician" });
const OPERATER = scope({ userId: 4, profileRole: "operator" });

/** Minimalni lažni Prisma klijent — beleži pozive da bi se proverio REDOSLED. */
type Poziv = { model: string; op: string; args: unknown };

function fakeDb(odgovori: Record<string, unknown[]> = {}) {
  const pozivi: Poziv[] = [];
  const red = (model: string, op: string) => {
    const kljuc = `${model}.${op}`;
    const niz = odgovori[kljuc];
    return async (args: unknown) => {
      pozivi.push({ model, op, args });
      if (Array.isArray(niz)) return niz.length > 1 ? niz.shift() : niz[0];
      return niz ?? null;
    };
  };
  const model = (ime: string) => ({
    findUnique: red(ime, "findUnique"),
    findFirst: red(ime, "findFirst"),
    findMany: red(ime, "findMany"),
    create: red(ime, "create"),
    createMany: red(ime, "createMany"),
    update: red(ime, "update"),
    updateMany: red(ime, "updateMany"),
    delete: red(ime, "delete"),
    deleteMany: red(ime, "deleteMany"),
    count: red(ime, "count"),
    upsert: red(ime, "upsert"),
  });
  const db = {
    pozivi,
    maintSettings: model("maintSettings"),
    maintAsset: model("maintAsset"),
    maintMachine: model("maintMachine"),
    maintIncident: model("maintIncident"),
    maintIncidentEvent: model("maintIncidentEvent"),
    maintWorkOrder: model("maintWorkOrder"),
    maintWoEvent: model("maintWoEvent"),
    maintTask: model("maintTask"),
    maintCheck: model("maintCheck"),
    maintPart: model("maintPart"),
    maintMachineNote: model("maintMachineNote"),
    maintMachineFile: model("maintMachineFile"),
    maintMachineStatusOverride: model("maintMachineStatusOverride"),
    maintMachineDeletionLog: model("maintMachineDeletionLog"),
    maintNotificationLog: model("maintNotificationLog"),
    maintNotificationRule: model("maintNotificationRule"),
    maintUserProfile: model("maintUserProfile"),
    maintVehicleServicePlan: model("maintVehicleServicePlan"),
    maintAssetServicePlan: model("maintAssetServicePlan"),
    maintVehicleDetails: model("maintVehicleDetails"),
    maintDriver: model("maintDriver"),
    maintDocument: model("maintDocument"),
    $queryRaw: red("raw", "queryRaw"),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

function svc(db: ReturnType<typeof fakeDb>) {
  const prisma = db as unknown as PrismaService;
  return new OdrzavanjeFnService(prisma, new OdrzavanjeAuthzService(prisma));
}

// ═══════════════════════════════════════════════════════════════════════════
// Trigeri nad incidentima
// ═══════════════════════════════════════════════════════════════════════════

describe("maint_incidents_set_asset_fields (BEFORE IU) — denormalizacija", () => {
  it("bez `asset_id` traži sredstvo preko MAŠINE i dopunjava tip", async () => {
    const db = fakeDb({
      "maintMachine.findFirst": [
        { asset: { assetId: "A1", assetType: "machine", assetCode: "3.12" } },
      ],
    });
    const out = await svc(db).incidentSetAssetFields(db as never, {
      machineCode: "3.12",
      assetId: null,
    });
    expect(out).toEqual({
      machineCode: "3.12",
      assetId: "A1",
      assetType: "machine",
    });
  });

  it("prazan `machine_code` se dopunjava ŠIFROM SREDSTVA (vozilo prijavljeno po tablicama)", async () => {
    const db = fakeDb({
      "maintAsset.findUnique": [
        { assetId: "A2", assetType: "vehicle", assetCode: "V-001" },
      ],
    });
    const out = await svc(db).incidentSetAssetFields(db as never, {
      machineCode: "   ",
      assetId: "A2",
    });
    expect(out.machineCode).toBe("V-001");
    expect(out.assetType).toBe("vehicle");
  });

  it("🔴 kad se sredstvo NE nađe, polja ostaju netaknuta (izvor ne dira NEW)", async () => {
    const db = fakeDb({ "maintMachine.findFirst": [null] });
    const out = await svc(db).incidentSetAssetFields(db as never, {
      machineCode: "NEPOZNATA",
      assetId: null,
    });
    expect(out).toEqual({
      machineCode: "NEPOZNATA",
      assetId: null,
      assetType: null,
    });
  });
});

describe("maint_incidents_log_changes (AFTER IU) — revizioni trag", () => {
  it("🔴 INSERT upisuje TAČNO JEDAN red `created` (izvor odmah radi RETURN NEW)", async () => {
    const db = fakeDb();
    await svc(db).incidentLogChanges(db as never, {
      incidentId: "I1",
      actor: 7,
      op: "INSERT",
      neu: { status: "open", assignedTo: 5 },
    });
    const upisi = db.pozivi.filter((p) => p.model === "maintIncidentEvent");
    expect(upisi).toHaveLength(1);
    expect((upisi[0].args as { data: { eventType: string } }).data.eventType).toBe(
      "created",
    );
  });

  it("UPDATE beleži i promenu statusa i promenu dodele — dva reda", async () => {
    const db = fakeDb();
    await svc(db).incidentLogChanges(db as never, {
      incidentId: "I1",
      actor: 7,
      op: "UPDATE",
      old: { status: "open", assignedTo: null },
      neu: { status: "in_progress", assignedTo: 9 },
    });
    const tipovi = db.pozivi
      .filter((p) => p.model === "maintIncidentEvent")
      .map((p) => (p.args as { data: { eventType: string } }).data.eventType);
    expect(tipovi).toEqual(["status_change", "assigned"]);
  });

  it("UPDATE bez ijedne praćene promene ne upisuje ništa", async () => {
    const db = fakeDb();
    await svc(db).incidentLogChanges(db as never, {
      incidentId: "I1",
      actor: 7,
      op: "UPDATE",
      old: { status: "open", assignedTo: 3 },
      neu: { status: "open", assignedTo: 3 },
    });
    expect(db.pozivi.filter((p) => p.model === "maintIncidentEvent")).toHaveLength(
      0,
    );
  });
});

describe("maint_incidents_autocreate_work_order (AFTER I) — auto nalog", () => {
  const podrazumevana = {
    "maintSettings.findUnique": [null], // -> fallback vrednosti iz izvora
    "maintMachine.findFirst": [{ assetId: "A1" }],
    "maintWorkOrder.create": [{ woId: "WO1" }],
  };

  it("critical kvar otvara nalog `p1_zastoj` u statusu `potvrden` i vezuje ga", async () => {
    const db = fakeDb(podrazumevana);
    const wo = await svc(db).incidentAutocreateWorkOrder(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      severity: "critical",
      safetyMarker: false,
      title: "Ne pali",
      description: null,
      reportedBy: 4,
      assignedTo: null,
      workOrderId: null,
    });
    expect(wo).toBe("WO1");
    const create = db.pozivi.find(
      (p) => p.model === "maintWorkOrder" && p.op === "create",
    );
    const d = (create?.args as { data: Record<string, unknown> }).data;
    expect(d.priority).toBe("p1_zastoj");
    expect(d.status).toBe("potvrden");
    expect(d.type).toBe("incident");
    // Povratna veza `maint_incidents.work_order_id` — bez nje kvar ostaje „bez naloga".
    expect(
      db.pozivi.some((p) => p.model === "maintIncident" && p.op === "update"),
    ).toBe(true);
  });

  it("🔴 `minor` kvar bez bezbednosnog rizika NE otvara nalog (tih izlaz)", async () => {
    const db = fakeDb(podrazumevana);
    const wo = await svc(db).incidentAutocreateWorkOrder(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      severity: "minor",
      safetyMarker: false,
      title: "Škripi",
      description: null,
      reportedBy: 4,
      assignedTo: null,
      workOrderId: null,
    });
    expect(wo).toBeNull();
    expect(
      db.pozivi.some((p) => p.model === "maintWorkOrder" && p.op === "create"),
    ).toBe(false);
  });

  it("🔴 bezbednosni rizik otvara nalog i za `minor` (safety_marker_requires_wo)", async () => {
    const db = fakeDb(podrazumevana);
    const wo = await svc(db).incidentAutocreateWorkOrder(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      severity: "minor",
      safetyMarker: true,
      title: "Otvoren orman",
      description: null,
      reportedBy: 4,
      assignedTo: null,
      workOrderId: null,
    });
    expect(wo).toBe("WO1");
    const d = (
      db.pozivi.find((p) => p.model === "maintWorkOrder" && p.op === "create")
        ?.args as { data: Record<string, unknown> }
    ).data;
    expect(d.priority).toBe("p1_zastoj");
  });

  it("🔴 sredstvo se ne može razrešiti -> tih izlaz, prijava OSTAJE sačuvana", async () => {
    const db = fakeDb({
      "maintSettings.findUnique": [null],
      "maintMachine.findFirst": [null],
    });
    const wo = await svc(db).incidentAutocreateWorkOrder(db as never, {
      id: "I1",
      machineCode: "NEMA",
      assetId: null,
      severity: "critical",
      safetyMarker: false,
      title: "x",
      description: null,
      reportedBy: 4,
      assignedTo: null,
      workOrderId: null,
    });
    expect(wo).toBeNull();
  });

  it("nalog koji već postoji se NE duplira", async () => {
    const db = fakeDb(podrazumevana);
    const wo = await svc(db).incidentAutocreateWorkOrder(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      severity: "critical",
      safetyMarker: false,
      title: "x",
      description: null,
      reportedBy: 4,
      assignedTo: null,
      workOrderId: "POSTOJI",
    });
    expect(wo).toBeNull();
  });
});

describe("maint_incidents_enqueue_notify (AFTER I) — obaveštenja", () => {
  it("🔴 bez ijednog pravila upisuje se JEDAN `in_app` red (fallback grana)", async () => {
    const db = fakeDb({
      "maintSettings.findUnique": [null],
      "maintNotificationRule.findMany": [[]],
      "maintNotificationLog.create": [{ id: "N1" }],
    });
    const n = await svc(db).incidentEnqueueNotify(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      assetType: "machine",
      severity: "critical",
      status: "open",
      title: "Ne pali",
      reportedBy: 4,
      assignedTo: null,
    });
    expect(n).toBe(0);
    const upis = db.pozivi.find(
      (p) => p.model === "maintNotificationLog" && p.op === "create",
    );
    expect(
      (upis?.args as { data: { channel: string } }).data.channel,
    ).toBe("in_app");
  });

  it("`minor` kvar ne šalje ništa (izvor traži major/critical)", async () => {
    const db = fakeDb({ "maintSettings.findUnique": [null] });
    const n = await svc(db).incidentEnqueueNotify(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      assetType: "machine",
      severity: "minor",
      status: "open",
      title: "x",
      reportedBy: 4,
      assignedTo: null,
    });
    expect(n).toBe(0);
    expect(
      db.pozivi.some((p) => p.model === "maintNotificationLog"),
    ).toBe(false);
  });

  it("pravilo sa kašnjenjem pomera `scheduled_at` i `next_attempt_at`", async () => {
    const db = fakeDb({
      "maintSettings.findUnique": [null],
      "maintNotificationRule.findMany": [
        [
          {
            ruleId: "R1",
            channel: "email",
            delayMinutes: 15,
            escalationLevel: 0,
            targetRole: "chief",
          },
        ],
      ],
      "maintNotificationLog.create": [{ id: "N1" }],
    });
    const n = await svc(db).incidentEnqueueNotify(db as never, {
      id: "I1",
      machineCode: "3.12",
      assetId: null,
      assetType: "machine",
      severity: "major",
      status: "open",
      title: "x",
      reportedBy: 4,
      assignedTo: null,
    });
    expect(n).toBe(1);
    const upd = db.pozivi.find(
      (p) => p.model === "maintNotificationLog" && p.op === "update",
    );
    expect(upd).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trigeri nad mašinama, profilima i zalihama
// ═══════════════════════════════════════════════════════════════════════════

describe("maint_machines_ensure_asset (BEFORE I)", () => {
  it("🔴 poštuje već popunjen `asset_id` (o tome visi `machine_rename`)", async () => {
    const db = fakeDb();
    const out = await svc(db).machineEnsureAsset(db as never, {
      assetId: "POSTOJI",
      machineCode: "3.12",
      name: "Strug",
      responsibleUserId: null,
      manufacturer: null,
      model: null,
      serialNumber: null,
      notes: null,
      archivedAt: null,
    });
    expect(out).toBe("POSTOJI");
    expect(db.pozivi).toHaveLength(0);
  });

  it("preuzima postojeće sredstvo po šifri, neosetljivo na velika slova", async () => {
    const db = fakeDb({ "maintAsset.findFirst": [{ assetId: "A9" }] });
    const out = await svc(db).machineEnsureAsset(db as never, {
      assetId: null,
      machineCode: "3.12",
      name: "Strug",
      responsibleUserId: null,
      manufacturer: null,
      model: null,
      serialNumber: null,
      notes: null,
      archivedAt: null,
    });
    expect(out).toBe("A9");
    const arg = db.pozivi[0].args as {
      where: { assetCode: { mode: string } };
    };
    expect(arg.where.assetCode.mode).toBe("insensitive");
  });

  it("pravi novo sredstvo; arhivirana mašina dobija `active = false`", async () => {
    const db = fakeDb({
      "maintAsset.findFirst": [null],
      "maintAsset.create": [{ assetId: "NOVO" }],
    });
    const out = await svc(db).machineEnsureAsset(db as never, {
      assetId: null,
      machineCode: "9.9",
      name: "Stara",
      responsibleUserId: 5,
      manufacturer: null,
      model: null,
      serialNumber: null,
      notes: null,
      archivedAt: new Date("2026-01-01"),
    });
    expect(out).toBe("NOVO");
    const d = (
      db.pozivi.find((p) => p.op === "create")?.args as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(d.active).toBe(false);
    expect(d.status).toBe("running");
  });
});

describe("maint_profiles_guard_role (BEFORE U) — brana od samododele role", () => {
  const db = fakeDb();
  it("🔴 običan korisnik NE SME sebi da promeni rolu ni aktivnost", () => {
    expect(() =>
      svc(db).assertProfileRoleChange(
        OPERATER,
        { role: "operator", active: true },
        { role: "admin" },
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      svc(db).assertProfileRoleChange(
        OPERATER,
        { role: "operator", active: false },
        { active: true },
      ),
    ).toThrow(ForbiddenException);
  });

  it("🔴 ni ŠEF ne sme — guard zna SAMO za ERP admina", () => {
    expect(() =>
      svc(db).assertProfileRoleChange(
        SEF,
        { role: "operator", active: true },
        { role: "chief" },
      ),
    ).toThrow(ForbiddenException);
  });

  it("ERP admin sme; izmena ostalih polja prolazi svima", () => {
    expect(() =>
      svc(db).assertProfileRoleChange(
        ADMIN,
        { role: "operator", active: true },
        { role: "chief" },
      ),
    ).not.toThrow();
    expect(() =>
      svc(db).assertProfileRoleChange(
        OPERATER,
        { role: "operator", active: true },
        {},
      ),
    ).not.toThrow();
  });
});

describe("maint_apply_part_stock_movement (AFTER I) — current_stock += delta", () => {
  it.each([
    ["in", 1],
    ["return", 1],
    ["adjustment", 1],
    ["out", -1],
  ])("`%s` daje predznak %s", async (tip, znak) => {
    const db = fakeDb();
    await svc(db).applyPartStockMovement(db as never, {
      partId: "P1",
      movementType: tip,
      quantity: 5,
    });
    const arg = db.pozivi[0].args as {
      data: { currentStock: { increment: Prisma.Decimal } };
    };
    expect(Number(arg.data.currentStock.increment)).toBe(5 * znak);
  });

  it("🔴 `adjustment` DODAJE, ne postavlja (prepis CASE-a, ne izbor)", async () => {
    const db = fakeDb();
    await svc(db).applyPartStockMovement(db as never, {
      partId: "P1",
      movementType: "adjustment",
      quantity: -3,
    });
    const arg = db.pozivi[0].args as {
      data: { currentStock: { increment: Prisma.Decimal } };
    };
    expect(Number(arg.data.currentStock.increment)).toBe(-3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trigeri nad radnim nalozima
// ═══════════════════════════════════════════════════════════════════════════

describe("maint_wo_log_field_changes (BEFORE U)", () => {
  it("beleži SAMO status, dodelu i prioritet", async () => {
    const db = fakeDb();
    await svc(db).woLogFieldChanges(db as never, {
      woId: "WO1",
      actor: 7,
      old: { status: "novi", assignedTo: null, priority: "p4_planirano" },
      neu: {
        status: "u_radu",
        assignedTo: 9,
        priority: "p1_zastoj",
      },
    });
    expect(
      db.pozivi.map((p) => (p.args as { data: { eventType: string } }).data.eventType),
    ).toEqual(["status_change", "assigned_change", "priority_change"]);
  });

  it("izmena drugog polja (npr. opisa) ne pravi trag", async () => {
    const db = fakeDb();
    await svc(db).woLogFieldChanges(db as never, {
      woId: "WO1",
      actor: 7,
      old: { status: "novi", assignedTo: 1, priority: "p4_planirano" },
      neu: {},
    });
    expect(db.pozivi).toHaveLength(0);
  });
});

describe("zatvaranje roka plana servisa (2 trigera)", () => {
  it("vozilo: prelaz u `zavrsen` upisuje datum i km, ali km ČUVA staru vrednost kad nova nema", async () => {
    const db = fakeDb({
      "maintVehicleServicePlan.findUnique": [{ lastDoneKm: 120_000 }],
    });
    await svc(db).woVehicleServicePlanCompletion(db as never, {
      servicePlanId: "PL1",
      status: "zavrsen",
      oldStatus: "u_radu",
      completedAt: new Date("2026-08-06T10:00:00Z"),
      odometerKmAtService: null,
      updatedBy: 7,
    });
    const upd = db.pozivi.find((p) => p.op === "update");
    const d = (upd?.args as { data: Record<string, unknown> }).data;
    expect(d.lastDoneKm).toBe(120_000);
  });

  it("🔴 nalog koji je VEĆ bio `zavrsen` ne pomera plan (traži se PRELAZ)", async () => {
    const db = fakeDb();
    await svc(db).woVehicleServicePlanCompletion(db as never, {
      servicePlanId: "PL1",
      status: "zavrsen",
      oldStatus: "zavrsen",
      completedAt: new Date(),
      odometerKmAtService: 5,
      updatedBy: 7,
    });
    expect(db.pozivi).toHaveLength(0);
  });

  it("plan sredstva: `updated_by` je AKTER, ne `NEW.updated_by` (razlika od vozilskog)", async () => {
    const db = fakeDb();
    await svc(db).woAssetServicePlanCompletion(
      db as never,
      {
        assetServicePlanId: "AP1",
        status: "zavrsen",
        oldStatus: "u_radu",
        completedAt: null,
      },
      42,
    );
    const d = (db.pozivi[0].args as { data: Record<string, unknown> }).data;
    expect(d.updatedBy).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFINER funkcije
// ═══════════════════════════════════════════════════════════════════════════

describe("maint_machine_rename — gejt, 7 tabela dece i ogledalo sredstva", () => {
  function dbZaRename() {
    return fakeDb({
      "maintMachine.findUnique": [
        {
          machineCode: "3.12",
          name: "Strug",
          assetId: "A1",
          type: null,
          manufacturer: null,
          model: null,
          serialNumber: null,
          yearOfManufacture: null,
          yearCommissioned: null,
          location: null,
          departmentId: null,
          powerKw: null,
          weightKg: null,
          notes: null,
          tracked: true,
          archivedAt: null,
          source: "manual",
          createdAt: new Date("2026-01-01"),
        },
        null, // druga provera: nova šifra je slobodna
      ],
      "maintTask.updateMany": [{ count: 2 }],
      "maintCheck.updateMany": [{ count: 3 }],
      "maintIncident.updateMany": [{ count: 4 }],
      "maintMachineNote.updateMany": [{ count: 5 }],
      "maintMachineStatusOverride.updateMany": [{ count: 6 }],
      "maintNotificationLog.updateMany": [{ count: 7 }],
      "maintMachineFile.updateMany": [{ count: 8 }],
      "maintAsset.findUnique": [{ assetCode: "3.12" }],
      "maintAsset.findFirst": [null],
    });
  }

  it("🔴 gejt je UŽI od brisanja: `magacioner` (erp_admin_or_management) NE sme", async () => {
    const db = dbZaRename();
    await expect(
      svc(db).machineRename(
        db as never,
        scope({ erpRoles: new Set(["magacioner"]) }),
        "3.12",
        "3.13",
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("prelazi svih 7 tabela dece i vraća brojeve", async () => {
    const db = dbZaRename();
    const out = await svc(db).machineRename(db as never, ADMIN, "3.12", "3.13");
    expect(out).toMatchObject({
      old_code: "3.12",
      new_code: "3.13",
      tasks: 2,
      checks: 3,
      incidents: 4,
      notes: 5,
      overrides: 6,
      notifications: 7,
      files: 8,
      asset_code_renamed: true,
    });
  });

  it("🔴 kopija mašine NOSI `asset_id` — bez toga bi nastalo prazno novo sredstvo", async () => {
    const db = dbZaRename();
    await svc(db).machineRename(db as never, ADMIN, "3.12", "3.13");
    const create = db.pozivi.find(
      (p) => p.model === "maintMachine" && p.op === "create",
    );
    expect((create?.args as { data: { assetId: string } }).data.assetId).toBe("A1");
  });

  it("🔴 stari red se briše TEK NA KRAJU (deca moraju da nađu novi red — nema FK)", async () => {
    const db = dbZaRename();
    await svc(db).machineRename(db as never, ADMIN, "3.12", "3.13");
    const iCreate = db.pozivi.findIndex(
      (p) => p.model === "maintMachine" && p.op === "create",
    );
    const iDelete = db.pozivi.findIndex(
      (p) => p.model === "maintMachine" && p.op === "delete",
    );
    const iDeca = db.pozivi.findIndex((p) => p.model === "maintTask");
    expect(iCreate).toBeLessThan(iDeca);
    expect(iDeca).toBeLessThan(iDelete);
  });

  it("nepostojeća mašina -> 404; ista šifra -> 422", async () => {
    const db = fakeDb({ "maintMachine.findUnique": [null] });
    await expect(
      svc(db).machineRename(db as never, ADMIN, "NEMA", "X"),
    ).rejects.toThrow(NotFoundException);
    await expect(
      svc(db).machineRename(db as never, ADMIN, "3.12", "3.12"),
    ).rejects.toThrow(/same/);
  });
});

describe("maint_machine_delete_hard", () => {
  function dbZaDelete() {
    return fakeDb({
      "maintMachine.findUnique": [{ machineCode: "3.12", name: "Strug" }],
      "maintTask.count": [1],
      "maintCheck.count": [2],
      "maintIncident.count": [3],
      "maintMachineNote.count": [4],
      "maintMachineFile.count": [5],
      "maintMachineStatusOverride.count": [6],
      "maintIncident.findMany": [[{ id: "I1" }]],
    });
  }

  it("🔴 gejt je ŠIRI od preimenovanja — `magacioner` SME da briše", async () => {
    const db = dbZaDelete();
    const out = await svc(db).machineDeleteHard(
      db as never,
      scope({ erpRoles: new Set(["magacioner"]) }),
      "m@x",
      "3.12",
      "trajno rashodovana",
    );
    expect(out.ok).toBe(true);
  });

  it("razlog kraći od 5 znakova se odbija (22023 u izvoru)", async () => {
    const db = dbZaDelete();
    await expect(
      svc(db).machineDeleteHard(db as never, ADMIN, "m@x", "3.12", "kratko"),
    ).resolves.toBeDefined();
    await expect(
      svc(db).machineDeleteHard(db as never, ADMIN, "m@x", "3.12", "abc"),
    ).rejects.toThrow(/razlog/);
  });

  it("🔴 trag brisanja se upisuje PRE brisanja i nosi brojače dece", async () => {
    const db = dbZaDelete();
    await svc(db).machineDeleteHard(
      db as never,
      ADMIN,
      "n@x",
      "3.12",
      "rashodovana",
    );
    const iLog = db.pozivi.findIndex((p) => p.model === "maintMachineDeletionLog");
    const iDel = db.pozivi.findIndex(
      (p) => p.model === "maintMachine" && p.op === "delete",
    );
    expect(iLog).toBeGreaterThanOrEqual(0);
    expect(iLog).toBeLessThan(iDel);
    const d = (db.pozivi[iLog].args as { data: Record<string, unknown> }).data;
    expect(d.relatedCounts).toMatchObject({ tasks: 1, files: 5 });
    expect(d.deletedByEmail).toBe("n@x");
  });

  it("🔴 tragovi kvarova se brišu PRE samih kvarova", async () => {
    const db = dbZaDelete();
    await svc(db).machineDeleteHard(
      db as never,
      ADMIN,
      "n@x",
      "3.12",
      "rashodovana",
    );
    const iEv = db.pozivi.findIndex((p) => p.model === "maintIncidentEvent");
    const iInc = db.pozivi.findIndex(
      (p) => p.model === "maintIncident" && p.op === "deleteMany",
    );
    expect(iEv).toBeLessThan(iInc);
  });
});

describe("maint_create_preventive_work_order", () => {
  it("🔴 vraća POSTOJEĆI nalog umesto da napravi nov (idempotencija u fn)", async () => {
    const db = fakeDb({
      "maintTask.findFirst": [{ id: "T1", machineCode: "3.12", title: "t" }],
      "maintMachine.findFirst": [{ assetId: "A1" }],
      "maintWorkOrder.findFirst": [{ woId: "STARI" }],
    });
    const wo = await svc(db).createPreventiveWorkOrder(db as never, TEHNICAR, "T1");
    expect(wo).toBe("STARI");
    expect(
      db.pozivi.some((p) => p.model === "maintWorkOrder" && p.op === "create"),
    ).toBe(false);
  });

  it("nov nalog dobija i `preventive_auto_wo` trag", async () => {
    const db = fakeDb({
      "maintTask.findFirst": [
        { id: "T1", machineCode: "3.12", title: "Podmazivanje", instructions: "…" },
      ],
      "maintMachine.findFirst": [{ assetId: "A1" }],
      "maintWorkOrder.findFirst": [null],
      "maintSettings.findUnique": [null],
      "maintWorkOrder.create": [{ woId: "NOVI" }],
    });
    const wo = await svc(db).createPreventiveWorkOrder(db as never, SEF, "T1");
    expect(wo).toBe("NOVI");
    const ev = db.pozivi.find((p) => p.model === "maintWoEvent");
    expect((ev?.args as { data: { eventType: string } }).data.eventType).toBe(
      "preventive_auto_wo",
    );
  });

  it("operater nema pravo; nepostojeći zadatak -> 404", async () => {
    const db = fakeDb({ "maintTask.findFirst": [null] });
    await expect(
      svc(db).createPreventiveWorkOrder(db as never, OPERATER, "T1"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc(db).createPreventiveWorkOrder(db as never, SEF, "T1"),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("maint_attach_incident_files — najskrivenije pravilo modula", () => {
  it("🔴 fajlove kači SAMO prijavilac — ni admin ne može na tuđu prijavu", async () => {
    const db = fakeDb({ "maintIncident.findFirst": [null] });
    const ok = await svc(db).attachIncidentFiles(db as never, ADMIN, "I1", ["u1"]);
    expect(ok).toBe(false);
    // Filter mora da nosi `reportedBy` pozivaoca.
    const arg = db.pozivi[0].args as { where: Record<string, unknown> };
    expect(arg.where.reportedBy).toBe(1);
  });

  it("spaja URL-ove bez duplikata i vraća true", async () => {
    const db = fakeDb({
      "maintIncident.findFirst": [{ id: "I1", attachmentUrls: ["a", "b"] }],
    });
    const ok = await svc(db).attachIncidentFiles(db as never, OPERATER, "I1", [
      "b",
      "c",
    ]);
    expect(ok).toBe(true);
    const upd = db.pozivi.find((p) => p.op === "update");
    expect(
      (upd?.args as { data: { attachmentUrls: string[] } }).data.attachmentUrls,
    ).toEqual(["a", "b", "c"]);
  });

  it("prazan spisak URL-ova vraća false BEZ upita", async () => {
    const db = fakeDb();
    expect(await svc(db).attachIncidentFiles(db as never, OPERATER, "I1", [])).toBe(
      false,
    );
    expect(db.pozivi).toHaveLength(0);
  });
});

describe("maint_notification_retry", () => {
  it("🔴 `attempts` se spušta na 7 da bi ga dequeue opet uzeo", async () => {
    const db = fakeDb({ "maintNotificationLog.findUnique": [{ attempts: 8 }] });
    await svc(db).notificationRetry(db as never, ADMIN, "N1");
    const d = (
      db.pozivi.find((p) => p.op === "update")?.args as {
        data: Record<string, unknown>
      }
    ).data;
    expect(d.attempts).toBe(7);
    expect(d.status).toBe("queued");
    expect(d.error).toBeNull();
  });

  it("manji broj pokušaja se ZADRŽAVA (LEAST, ne postavljanje)", async () => {
    const db = fakeDb({ "maintNotificationLog.findUnique": [{ attempts: 2 }] });
    await svc(db).notificationRetry(db as never, ADMIN, "N1");
    const d = (
      db.pozivi.find((p) => p.op === "update")?.args as {
        data: Record<string, unknown>
      }
    ).data;
    expect(d.attempts).toBe(2);
  });

  it("tehničar nema pravo (gejt traži erp_admin ∨ chief ∨ admin profil)", async () => {
    const db = fakeDb();
    await expect(
      svc(db).notificationRetry(db as never, TEHNICAR, "N1"),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("maint_dispatch_fanout", () => {
  it("critical cilja chief I management, ostalo samo chief", async () => {
    const db = fakeDb({
      "maintNotificationLog.findUnique": [
        {
          id: "N1",
          channel: "whatsapp",
          subject: "s",
          body: "b",
          relatedEntityType: "maint_incident",
          relatedEntityId: "I1",
          machineCode: "3.12",
          escalationLevel: 0,
          payload: { severity: "critical" },
        },
      ],
      "maintUserProfile.findMany": [
        [{ userId: 2, fullName: "Šef", phone: "060" }],
      ],
    });
    const n = await svc(db).dispatchFanout(db as never, "N1");
    expect(n).toBe(1);
    const q = db.pozivi.find((p) => p.model === "maintUserProfile")?.args as {
      where: { role: { in: string[] } };
    };
    expect(q.where.role.in).toEqual(["chief", "management"]);
  });

  it("🔴 roditelj se zatvara i kad NEMA nijednog primaoca (inače večno visi u redu)", async () => {
    const db = fakeDb({
      "maintNotificationLog.findUnique": [
        {
          id: "N1",
          channel: "whatsapp",
          subject: "s",
          body: "b",
          relatedEntityType: null,
          relatedEntityId: null,
          machineCode: null,
          escalationLevel: 0,
          payload: {},
        },
      ],
      "maintUserProfile.findMany": [[]],
    });
    const n = await svc(db).dispatchFanout(db as never, "N1");
    expect(n).toBe(0);
    const d = (
      db.pozivi.find(
        (p) => p.model === "maintNotificationLog" && p.op === "update",
      )?.args as { data: Record<string, unknown> }
    ).data;
    expect(d.status).toBe("sent");
    expect(d.error).toBe("FANOUT_DONE: 0 recipients");
  });
});

describe("maint_assignable_users", () => {
  it("🔴 `management` NIJE u spisku (rukovodstvo ne izvršava naloge)", async () => {
    const db = fakeDb({ "maintUserProfile.findMany": [[]] });
    await svc(db).assignableUsers(db as never);
    const q = db.pozivi[0].args as { where: { role: { in: string[] } } };
    expect(q.where.role.in).toEqual(["operator", "technician", "chief", "admin"]);
    expect(q.where.role.in).not.toContain("management");
  });
});

describe("ensure_*_service_wos — gejt i tip naloga", () => {
  it("operater nema pravo ni za jedan od dva", async () => {
    const db = fakeDb();
    await expect(
      svc(db).ensureVehicleServiceWos(db as never, OPERATER),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc(db).ensureAssetServiceWos(db as never, OPERATER),
    ).rejects.toThrow(ForbiddenException);
  });

  it("🔴 objekat dobija nalog tipa `inspekcija`, ostalo `preventiva`", async () => {
    const db = fakeDb({
      "raw.queryRaw": [
        [
          {
            plan_id: "P1",
            asset_id: "A1",
            asset_type: "facility",
            name: "Godišnji pregled",
            interval_months: 12,
            priority: "p4_planirano",
            next_due_at: null,
          },
          {
            plan_id: "P2",
            asset_id: "A2",
            asset_type: "it",
            name: "Servis",
            interval_months: 6,
            priority: "p4_planirano",
            next_due_at: null,
          },
        ],
      ],
    });
    const n = await svc(db).ensureAssetServiceWos(db as never, TEHNICAR);
    expect(n).toBe(2);
    const tipovi = db.pozivi
      .filter((p) => p.model === "maintWorkOrder" && p.op === "create")
      .map((p) => (p.args as { data: { type: string } }).data.type);
    expect(tipovi).toEqual(["inspekcija", "preventiva"]);
  });

  it("tehničar SME da generiše naloge iz plana (gejt ga izričito nabraja)", async () => {
    const db = fakeDb({ "raw.queryRaw": [[]] });
    await expect(
      svc(db).ensureVehicleServiceWos(db as never, TEHNICAR),
    ).resolves.toBe(0);
  });
});

describe("maint_machines_import_from_cache — NAMERNO nije prepisana", () => {
  it("🔴 pada GLASNO umesto da tiho uveze nula mašina (bigtehn_machines_cache nije u 3.0)", () => {
    const db = fakeDb();
    expect(() => svc(db).importFromCacheNijePreneto()).toThrow(
      /bigtehn_machines_cache/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Šav ka AI-asistentu
// ═══════════════════════════════════════════════════════════════════════════

describe("ai_chat_prijavi_kvar (3.0) — šav AI -> održavanje", () => {
  it("prazan naslov vraća `prazno` bez ijednog upita", async () => {
    const db = fakeDb();
    const out = await svc(db).aiPrijaviKvar(4, { masina: "3.12", naslov: "  " });
    expect(out.error).toBe("prazno");
    expect(db.pozivi).toHaveLength(0);
  });

  it("nerazrešeno sredstvo vraća `nema_sredstva` i NE piše", async () => {
    const db = fakeDb({ "raw.queryRaw": [[], []] });
    const out = await svc(db).aiPrijaviKvar(4, {
      masina: "NEPOSTOJECA",
      naslov: "Kvar",
    });
    expect(out.error).toBe("nema_sredstva");
    expect(db.pozivi.some((p) => p.op === "create")).toBe(false);
  });

  it("🔴 prijava prolazi kroz ISTE trigere kao ekran (trag + auto-nalog + obaveštenje)", async () => {
    const db = fakeDb({
      "raw.queryRaw": [[{ machine_code: "3.12", asset_id: "A1", name: "Strug" }]],
      "maintMachine.findFirst": [{ assetId: "A1" }],
      "maintAsset.findUnique": [
        { assetId: "A1", assetType: "machine", assetCode: "3.12" },
      ],
      "maintIncident.create": [
        {
          id: "I1",
          machineCode: "3.12",
          assetId: "A1",
          assetType: "machine",
          severity: "critical",
          status: "open",
          title: "Ne pali",
          description: null,
          reportedBy: 4,
          assignedTo: null,
          safetyMarker: false,
          workOrderId: null,
        },
      ],
      "maintSettings.findUnique": [null],
      "maintWorkOrder.create": [{ woId: "WO1" }],
      "maintNotificationRule.findMany": [[]],
      "maintNotificationLog.create": [{ id: "N1" }],
      "maintIncident.findUnique": [{ workOrderId: "WO1" }],
      "maintWorkOrder.findUnique": [{ woNumber: "WO-2026-00135" }],
    });
    const out = await svc(db).aiPrijaviKvar(4, {
      masina: "3.12",
      naslov: "Ne pali",
      ozbiljnost: "critical",
    });
    expect(out.ok).toBe(true);
    expect(out.radni_nalog).toBe("WO-2026-00135");
    expect(String(out.poruka)).toContain("mašinu 3.12");
    expect(db.pozivi.some((p) => p.model === "maintIncidentEvent")).toBe(true);
    expect(
      db.pozivi.some((p) => p.model === "maintWorkOrder" && p.op === "create"),
    ).toBe(true);
    expect(db.pozivi.some((p) => p.model === "maintNotificationLog")).toBe(true);
  });

  it("🔴 nevalidna ozbiljnost tiho postaje `minor` (kao neuspeo cast enuma u sy15)", async () => {
    const db = fakeDb({
      "raw.queryRaw": [[{ machine_code: "3.12", asset_id: "A1", name: "S" }]],
      "maintMachine.findFirst": [{ assetId: "A1" }],
      "maintAsset.findUnique": [
        { assetId: "A1", assetType: "machine", assetCode: "3.12" },
      ],
      "maintIncident.create": [
        {
          id: "I1",
          machineCode: "3.12",
          assetId: "A1",
          assetType: "machine",
          severity: "minor",
          status: "open",
          title: "x",
          description: null,
          reportedBy: 4,
          assignedTo: null,
          safetyMarker: false,
          workOrderId: null,
        },
      ],
      "maintSettings.findUnique": [null],
      "maintIncident.findUnique": [{ workOrderId: null }],
    });
    // Opis alata nudi „important", kojeg u skupu nema.
    await svc(db).aiPrijaviKvar(4, {
      masina: "3.12",
      naslov: "x",
      ozbiljnost: "important",
    });
    const d = (
      db.pozivi.find((p) => p.model === "maintIncident" && p.op === "create")
        ?.args as { data: Record<string, unknown> }
    ).data;
    expect(d.severity).toBe("minor");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Čist prepis `maint_machine_dept_code`
// ═══════════════════════════════════════════════════════════════════════════

describe("maint_machine_dept_code — most ka Lokacijama", () => {
  it.each([
    ["1.10", "M.SEC"],
    ["4.11", "M.BRA"],
    ["5.11", "M.FAR"],
    ["17.1", "M.CAM"],
    ["8.2", "M.AZI"],
    ["10.3", "M.ERO"],
    ["6.1", "M.BRU"],
    ["6", "M.BRU"],
    ["3.5", "M.GLO"],
    ["2.7", "M.STR"],
  ])("%s -> %s", (kod, hala) => {
    expect(maintMachineDeptCode(kod)).toBe(hala);
  });

  it("🔴 granični slučajevi koje redosled CASE-a čuva", () => {
    // 6.8 je izričito izuzet iz brušenja.
    expect(maintMachineDeptCode("6.8")).toBe("M.OST");
    // 5.9 i 5.10 NISU u spisku farbanja.
    expect(maintMachineDeptCode("5.9")).toBe("M.OST");
    expect(maintMachineDeptCode("5.10")).toBe("M.OST");
    // 21.x (3D štampa) ne sme u struganje.
    expect(maintMachineDeptCode("21.1")).toBe("M.OST");
    expect(maintMachineDeptCode("21")).toBe("M.OST");
    // 8.1 nije ažistiranje — samo 8.2 jeste.
    expect(maintMachineDeptCode("8.1")).toBe("M.OST");
    // Prazno / null.
    expect(maintMachineDeptCode("")).toBe("M.OST");
    expect(maintMachineDeptCode(null)).toBe("M.OST");
  });
});
