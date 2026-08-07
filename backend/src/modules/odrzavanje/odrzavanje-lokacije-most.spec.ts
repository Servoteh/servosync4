import { OdrzavanjeLokacijeMostService } from "./odrzavanje-lokacije-most.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";

/**
 * MOST ka `loc_locations` — paritet trigera `maint_machines_sync_to_loc`.
 *
 * ZAŠTO SE OVO TESTIRA POSEBNO: ovo je JEDINI upis održavanja u sy15 pod
 * `ODRZAVANJE_IZVOR=3.0`, i jedini deo seobe koji NAMERNO odstupa od izvora
 * (fail-soft posle commit-a umesto u istoj transakciji). Ako se pogreši, mašina
 * tiho izostane iz stabla lokacija — a Reversi i mobilne lokacije to ne prijave.
 */

function fake(loc: { postoji?: boolean; hala?: boolean } = {}) {
  const upiti: { sql: string; vals: unknown[] }[] = [];
  const zapis = (q: { strings?: string[]; sql?: string; values?: unknown[] }) => {
    const sql = q.sql ?? (q.strings ?? []).join("?");
    upiti.push({ sql, vals: q.values ?? [] });
    return sql;
  };
  const sy15 = {
    db: {
      $queryRaw: async (q: never) => {
        const sql = zapis(q);
        // Redosled provera u kodu: postojanje reda mašine, pa hala.
        if (sql.includes("location_code = $") || sql.includes("location_code")) {
          if (upiti.length === 1 && loc.postoji !== undefined) {
            return loc.postoji ? [{ id: "L1" }] : [];
          }
          return loc.hala === false ? [] : [{ id: "HALA" }];
        }
        return [];
      },
      $executeRaw: async (q: never) => {
        zapis(q);
        return 1;
      },
    },
  } as unknown as Sy15Service;
  return { sy15, upiti };
}

const NA_3_0 = { isThreeZero: true } as unknown as OdrzavanjeSourceService;
const NA_SY15 = { isThreeZero: false } as unknown as OdrzavanjeSourceService;

describe("aktivan() — most radi SAMO pod 3.0", () => {
  it("pod `sy15` posao i dalje radi DB triger", () => {
    const { sy15 } = fake();
    expect(new OdrzavanjeLokacijeMostService(sy15, NA_SY15).aktivan()).toBe(false);
  });

  it("pod `3.0` most preuzima posao", () => {
    const { sy15 } = fake();
    expect(new OdrzavanjeLokacijeMostService(sy15, NA_3_0).aktivan()).toBe(true);
  });

  it("🔴 bez prekidača most je NEAKTIVAN (bezbedan smer — kao `sy15`)", () => {
    const { sy15 } = fake();
    expect(new OdrzavanjeLokacijeMostService(sy15).aktivan()).toBe(false);
  });
});

describe("INSERT grana", () => {
  it("arhivirana ili nepraćena mašina se PRESKAČE (isto pravilo kao seed)", async () => {
    const { sy15, upiti } = fake();
    const most = new OdrzavanjeLokacijeMostService(sy15, NA_3_0);
    const a = await most.syncMachineToLoc(
      { machineCode: "3.12", name: "S", archivedAt: new Date(), tracked: true },
      "INSERT",
    );
    const b = await most.syncMachineToLoc(
      { machineCode: "3.12", name: "S", archivedAt: null, tracked: false },
      "INSERT",
    );
    expect(a.akcija).toBe("preskoceno");
    expect(b.akcija).toBe("preskoceno");
    expect(upiti).toHaveLength(0);
  });

  it("aktivna praćena mašina se upisuje kao dete hale po `maint_machine_dept_code`", async () => {
    const { sy15, upiti } = fake({ hala: true });
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "Brusilica", archivedAt: null, tracked: true },
      "INSERT",
    );
    expect(out.akcija).toBe("insert");
    // Prvi upit traži halu — za 6.1 to je M.BRU.
    expect(upiti[0].vals).toContain("M.BRU");
    // Drugi upit je INSERT sa `ON CONFLICT DO NOTHING` (idempotencija).
    expect(upiti[1].sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("🔴 kad hale NEMA: upozorenje i preskakanje — NE obara upis mašine", async () => {
    const { sy15 } = fake({ hala: false });
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: null, tracked: true },
      "INSERT",
    );
    // Izvor tu radi `RAISE WARNING`, ne exception.
    expect(out).toEqual({ ok: true, akcija: "preskoceno" });
  });

  it("mašina bez naziva dobija naziv `Mašina <šifra>`", async () => {
    const { sy15, upiti } = fake({ hala: true });
    await new OdrzavanjeLokacijeMostService(sy15, NA_3_0).syncMachineToLoc(
      { machineCode: "6.1", name: "   ", archivedAt: null, tracked: true },
      "INSERT",
    );
    expect(upiti[1].vals).toContain("Mašina 6.1");
  });
});

describe("UPDATE grana", () => {
  it("red koji NE postoji, a mašina je sada aktivna -> ponaša se kao INSERT", async () => {
    const { sy15, upiti } = fake({ postoji: false, hala: true });
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: null, tracked: true },
      "UPDATE",
    );
    expect(out.akcija).toBe("insert");
    expect(upiti.some((u) => u.sql.includes("INSERT INTO"))).toBe(true);
  });

  it("red ne postoji, a mašina je arhivirana -> ništa (ne vaskrsava lokaciju)", async () => {
    const { sy15, upiti } = fake({ postoji: false });
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: new Date(), tracked: true },
      "UPDATE",
    );
    expect(out.akcija).toBe("preskoceno");
    expect(upiti.filter((u) => u.sql.includes("INSERT INTO"))).toHaveLength(0);
  });

  it("🔴 arhiviranje mašine gasi lokaciju (`is_active = false`)", async () => {
    const { sy15, upiti } = fake({ postoji: true });
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: new Date(), tracked: true },
      "UPDATE",
    );
    expect(out.akcija).toBe("update");
    expect(upiti[1].vals).toContain(false);
  });

  it("nepraćena mašina se takođe gasi (pravilo je `archived IS NULL AND tracked`)", async () => {
    const { sy15, upiti } = fake({ postoji: true });
    await new OdrzavanjeLokacijeMostService(sy15, NA_3_0).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: null, tracked: false },
      "UPDATE",
    );
    expect(upiti[1].vals).toContain(false);
  });
});

describe("🔴 fail-soft — svesno odstupanje od izvora", () => {
  it("greška tuđe baze se LOGUJE, ne diže: mašina je već sačuvana u 3.0", async () => {
    const sy15 = {
      db: {
        $queryRaw: async () => {
          throw new Error("sy15 nedostupan");
        },
        $executeRaw: async () => 0,
      },
    } as unknown as Sy15Service;
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "6.1", name: "B", archivedAt: null, tracked: true },
      "UPDATE",
    );
    expect(out).toEqual({ ok: false, akcija: "preskoceno" });
  });

  it("prazna šifra ne pravi nijedan upit", async () => {
    const { sy15, upiti } = fake();
    const out = await new OdrzavanjeLokacijeMostService(
      sy15,
      NA_3_0,
    ).syncMachineToLoc(
      { machineCode: "  ", name: "B", archivedAt: null, tracked: true },
      "INSERT",
    );
    expect(out.akcija).toBe("preskoceno");
    expect(upiti).toHaveLength(0);
  });
});
