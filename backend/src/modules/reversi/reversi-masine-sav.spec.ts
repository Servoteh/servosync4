import { ReversiService } from "./reversi.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { LabelPrintService } from "../../common/printing/label-print.service";
import type { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";

/**
 * ŠAV REVERSI -> ODRŽAVANJE (`v_rev_machines` nad `maint_machines`).
 *
 * Reversi mašine NE POSEDUJU — čitaju ih iz tuđeg domena kroz view. FK graf taj
 * šav ne pokazuje (0 inbound FK-ova ka `maint_*`); našao ga je `pg_depend`.
 * Pod `ODRZAVANJE_IZVOR=3.0` mašine su u 3.0, pa čitanje iz sy15 kopije daje
 * ZASTARELO stanje — tiho, bez ijedne greške.
 *
 * 🔴 Ovde je pinovan i ZATEČEN KVAR nađen usput: `lookupBarcode` je za nalepnicu
 * „ZADU-M-…" tražio kolonu `rj_code`, koje u `v_rev_machines` NEMA (izmereno
 * `pg_attribute` nad živom sy15) — skeniranje mašine je padalo sa 42703 → 500.
 */

const KOLONE_VIEWA = [
  "machine_code",
  "name",
  "type",
  "manufacturer",
  "model",
  "serial_number",
  "year_of_manufacture",
  "year_commissioned",
  "location",
  "department_id",
  "power_kw",
  "notes",
  "tracked",
  "archived_at",
];

function fakeSy15(odgovori: unknown[][] = []) {
  const upiti: string[] = [];
  const sy15 = {
    db: {
      $queryRaw: async (q: { strings?: string[] }) => {
        upiti.push((q.strings ?? []).join("?"));
        return odgovori.shift() ?? [];
      },
      revTool: { findMany: async () => [] },
      revCuttingToolCatalog: { findMany: async () => [] },
    },
  } as unknown as Sy15Service;
  return { sy15, upiti };
}

function fakePrisma(masine: Record<string, unknown>[] = []) {
  return {
    maintMachine: {
      findMany: async () => masine,
      findUnique: async ({ where }: { where: { machineCode: string } }) =>
        masine.find((m) => m.machineCode === where.machineCode) ?? null,
    },
  } as unknown as PrismaService;
}

const LABEL = {} as unknown as LabelPrintService;
const NA_3_0 = { isThreeZero: true } as unknown as OdrzavanjeSourceService;
const NA_SY15 = { isThreeZero: false } as unknown as OdrzavanjeSourceService;

describe("reportMachines — izvor mašina prati ODRZAVANJE_IZVOR", () => {
  it("pod `sy15` čita `v_rev_machines` (nepromenjeno)", async () => {
    const { sy15, upiti } = fakeSy15([[{ machine_code: "3.12", name: "Strug" }], [], []]);
    const svc = new ReversiService(sy15, LABEL, NA_SY15, fakePrisma());
    await svc.reportMachines();
    expect(upiti[0]).toContain("v_rev_machines");
  });

  it("🔴 pod `3.0` čita 3.0 `maint_machines` i NE dodiruje sy15 view", async () => {
    const { sy15, upiti } = fakeSy15([[], []]);
    const prisma = fakePrisma([
      {
        machineCode: "3.12",
        name: "Strug",
        type: null,
        manufacturer: null,
        model: null,
        serialNumber: "SN1",
        yearOfManufacture: 2001,
        yearCommissioned: 2002,
        location: "Hala 1",
        departmentId: "03",
        powerKw: null,
        notes: null,
        tracked: true,
        archivedAt: null,
      },
    ]);
    const svc = new ReversiService(sy15, LABEL, NA_3_0, prisma);
    const out = (await svc.reportMachines()) as {
      data: Record<string, unknown>[];
    };
    expect(upiti.every((u) => !u.includes("v_rev_machines"))).toBe(true);
    expect(out.data).toHaveLength(1);
  });

  it("🔴 oblik reda je ISTI u oba položaja — svih 14 kolona view-a, snake_case", async () => {
    const prisma = fakePrisma([
      {
        machineCode: "3.12",
        name: "Strug",
        type: "CNC",
        manufacturer: "X",
        model: "Y",
        serialNumber: "SN1",
        yearOfManufacture: 2001,
        yearCommissioned: 2002,
        location: "Hala 1",
        departmentId: "03",
        powerKw: null,
        notes: "n",
        tracked: true,
        archivedAt: null,
      },
    ]);
    const { sy15 } = fakeSy15([[], []]);
    const svc = new ReversiService(sy15, LABEL, NA_3_0, prisma);
    const out = (await svc.reportMachines()) as {
      data: Record<string, unknown>[];
    };
    for (const k of KOLONE_VIEWA) {
      expect(Object.keys(out.data[0])).toContain(k);
    }
  });

  it("arhivirana mašina se PROSLEĐUJE sa `archived_at` (FE filtrira, RB-52/53)", async () => {
    const prisma = fakePrisma([
      {
        machineCode: "9.9",
        name: "Stara",
        type: null,
        manufacturer: null,
        model: null,
        serialNumber: null,
        yearOfManufacture: null,
        yearCommissioned: null,
        location: null,
        departmentId: null,
        powerKw: null,
        notes: null,
        tracked: false,
        archivedAt: new Date("2026-01-01"),
      },
    ]);
    const { sy15 } = fakeSy15([[], []]);
    const out = (await new ReversiService(
      sy15,
      LABEL,
      NA_3_0,
      prisma,
    ).reportMachines()) as { data: Record<string, unknown>[] };
    expect(out.data[0].archived_at).toBeInstanceOf(Date);
  });
});

describe("🔴 lookupBarcode ZADU-M-… — zatečen kvar `rj_code`", () => {
  it("pod `sy15` upit više NE traži nepostojeću kolonu `rj_code` u FROM/WHERE", async () => {
    const { sy15, upiti } = fakeSy15([[{ rj_code: "3.12", name: "Strug" }]]);
    const svc = new ReversiService(sy15, LABEL, NA_SY15, fakePrisma());
    const out = await svc.lookupBarcode("ZADU-M-3_12");
    expect(out.data.kind).toBe("MACHINE");
    // Kolona view-a je `machine_code`; `rj_code` sme da bude SAMO alias izlaza.
    expect(upiti[0]).toContain("machine_code AS rj_code");
    expect(upiti[0]).toContain("WHERE machine_code =");
  });

  it("podvlaka u nalepnici postaje tačka (RC-29)", async () => {
    const prisma = fakePrisma([{ machineCode: "3.12", name: "Strug" }]);
    const { sy15 } = fakeSy15();
    const out = await new ReversiService(
      sy15,
      LABEL,
      NA_3_0,
      prisma,
    ).lookupBarcode("ZADU-M-3_12");
    expect(out.data.record).toEqual({ rj_code: "3.12", name: "Strug" });
  });

  it("🔴 ugovor prema FE-u ostaje `rj_code` i pod 3.0 (ne menja se usput)", async () => {
    const prisma = fakePrisma([{ machineCode: "6.1", name: "Brusilica" }]);
    const { sy15 } = fakeSy15();
    const out = await new ReversiService(
      sy15,
      LABEL,
      NA_3_0,
      prisma,
    ).lookupBarcode("ZADU-M-6_1");
    expect(Object.keys(out.data.record as object)).toEqual(["rj_code", "name"]);
  });

  it("nepoznata mašina daje `record: null`, ne grešku", async () => {
    const { sy15 } = fakeSy15();
    const out = await new ReversiService(
      sy15,
      LABEL,
      NA_3_0,
      fakePrisma(),
    ).lookupBarcode("ZADU-M-NEMA");
    expect(out.data).toEqual({
      kind: "MACHINE",
      barcode: "ZADU-M-NEMA",
      record: null,
    });
  });
});
