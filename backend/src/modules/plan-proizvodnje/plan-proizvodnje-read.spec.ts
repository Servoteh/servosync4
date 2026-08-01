import { Prisma } from "@prisma/client";
import { PlanProizvodnjeReadService } from "./plan-proizvodnje-read.service";
import { getDepartment, type DepartmentDef } from "./departments";

/**
 * Read sloj — struktura generisanog SQL-a (bez DB): dept matching, effective_machine_code
 * filter, i kanon `v_production_operations_effective` (M3 string id-jevi, M6 završna
 * kontrola, auto_sort_bucket, G4, kooperacija). Semantika nad podacima je verifikovana
 * seeded-live probom (izveštaj) — ovde su strukturne invarijante.
 */
function makeSvc() {
  const svc = new PlanProizvodnjeReadService(
    {} as never,
    {} as never,
  );
  const priv = svc as unknown as {
    machineMatch: (d: DepartmentDef) => Prisma.Sql | null;
    deptWhere: (slug: string) => Prisma.Sql;
    effectiveOpsInner: (baseFilter: Prisma.Sql) => Prisma.Sql;
  };
  return { priv };
}

describe("dept matching (machineMatch / deptWhere)", () => {
  it("čisto kod-based odeljenje: effective_machine_code, bez opis_rada", () => {
    const { priv } = makeSvc();
    const out = priv.machineMatch(getDepartment("glodanje")!);
    expect(out?.sql).toContain("effective_machine_code");
    expect(out?.sql ?? "").not.toContain("opis_rada");
  });

  it("name-pattern grana se OR-uje sa kod-matchingom", () => {
    const { priv } = makeSvc();
    const out = priv.machineMatch({
      slug: "t",
      label: "T",
      kind: "machines",
      machinePrefixes: ["3"],
      operationNamePatterns: ["bravar"],
    });
    expect(out?.sql).toContain("opis_rada ILIKE");
    expect(out?.sql).toContain("effective_machine_code");
    expect(out?.sql).toContain(" OR ");
  });

  it("deptWhere('sve') = prazno (bez dodatnog filtera)", () => {
    const { priv } = makeSvc();
    expect(priv.deptWhere("sve").sql.trim()).toBe("");
  });

  it("deptWhere('ostalo') = komplement imenovanih (NOT COALESCE(...))", () => {
    const { priv } = makeSvc();
    expect(priv.deptWhere("ostalo").sql).toContain("NOT COALESCE");
  });

  it("deptWhere('struganje') nosi exclude 21.1/21.2", () => {
    const { priv } = makeSvc();
    expect(priv.deptWhere("struganje").sql).toContain("NOT IN");
  });
});

describe("effectiveOpsInner — kanon v_production_operations_effective", () => {
  const sql = () => makeSvc().priv.effectiveOpsInner(Prisma.empty).sql;

  it("M3: line_id/work_order_id izlaze kao ::text (FE string ugovor)", () => {
    const s = sql();
    expect(s).toContain("base.line_id_raw::text AS line_id");
    expect(s).toContain("base.wo_raw::text AS work_order_id");
  });

  it("M6: završna kontrola po native significant_for_finishing (NE 8.3 heuristika)", () => {
    const s = sql();
    expect(s).toContain("significant_for_finishing");
    expect(s).not.toContain("~ '^8"); // sy15 _pracenje_line_is_final_control heuristika
  });

  it("M7: MES-aktivan = predmet aktivan (predmet_aktivacije.is_active)", () => {
    expect(sql()).toContain("predmet_aktivacije pa");
    expect(sql()).toContain("pa.is_active IS TRUE");
  });

  it("real_seconds (kanon #2): Σ EPOCH(finished−entered) FILTER(finished>entered)", () => {
    const s = sql();
    expect(s).toContain("EXTRACT(EPOCH FROM (t.finished_at - t.entered_at))");
    expect(s).toContain("FILTER (WHERE t.finished_at > t.entered_at)");
  });

  it("G4: dorada/škart iz tech_processes.quality_type_id (1=dorada, 2=škart)", () => {
    const s = sql();
    expect(s).toContain("t.quality_type_id = 1");
    expect(s).toContain("t.quality_type_id = 2");
    expect(s).toContain("t.quality_type_id IN (1, 2)");
  });

  it("auto_sort_bucket 1-8 + kooperacija (auto ⋈ grupa RJ, manual overlay)", () => {
    const s = sql();
    expect(s).toContain("auto_sort_bucket");
    expect(s).toContain("is_cooperation_effective");
    expect(s).toContain("plan_proizvodnje_auto_cooperation_groups g");
  });

  it("plan_rn_final_control_done: komada_total ≤ sum ≤ komada_total*1.5", () => {
    const s = sql();
    expect(s).toContain("plan_rn_final_control_done");
    expect(s).toContain("* 1.5");
  });

  it("baseFilter se ubacuje u najdublju WHERE granu (perf: mašinski filter pre laterala)", () => {
    const withFilter = makeSvc()
      .priv.effectiveOpsInner(Prisma.sql`AND l.work_order_id = 42`).sql;
    // Filter tekst dolazi PRE prvog LATERAL join-a (u base subquery-ju).
    const idxFilter = withFilter.indexOf("l.work_order_id =");
    const idxLateral = withFilter.indexOf("LEFT JOIN LATERAL");
    expect(idxFilter).toBeGreaterThan(0);
    expect(idxFilter).toBeLessThan(idxLateral);
  });
});

describe("machineOps — 040/26 server-side crtež/RN filter", () => {
  function svcWithCapture() {
    const calls: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        calls.push(sql);
        return [] as unknown[];
      }),
    };
    const svc = new PlanProizvodnjeReadService(prisma as never, {} as never);
    const priv = svc as unknown as {
      machineOps: (m: string, l: number, o: number, q?: string) => Promise<unknown>;
    };
    return { priv, calls };
  }

  it("q prisutan → ILIKE broj_crteza/rn_ident_broj u WHERE (dohvat i iza prvih 100 RN)", async () => {
    const { priv, calls } = svcWithCapture();
    await priv.machineOps("12.1", 100, 0, "12345");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("broj_crteza ILIKE");
    expect(calls[0].sql).toContain("rn_ident_broj ILIKE");
    // filter je parametrizovan (bez string concat) — vrednost je bind, ne literal.
    expect(calls[0].values).toContain("%12345%");
  });

  it("q prazan → bez ILIKE filtera (ceo red mašine)", async () => {
    const { priv, calls } = svcWithCapture();
    await priv.machineOps("12.1", 100, 0, "");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain("broj_crteza ILIKE");
  });

  it("q izostavljen → bez ILIKE filtera", async () => {
    const { priv, calls } = svcWithCapture();
    await priv.machineOps("12.1", 100, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain("broj_crteza ILIKE");
  });

  it("prazna mašina → nema query-ja (rani izlaz)", async () => {
    const { priv, calls } = svcWithCapture();
    const res = (await priv.machineOps("", 100, 0, "x")) as {
      data: { rows: unknown[]; has_more: boolean };
    };
    expect(calls).toHaveLength(0);
    expect(res.data.rows).toEqual([]);
    expect(res.data.has_more).toBe(false);
  });
});

/**
 * Gant (zahtev 046/26 F0+F1) — strukturne invarijante feed-a: planirana polja izlaze iz
 * overlay-a, hala dolazi iz RUČNOG šifrarnika (LEFT JOIN, ne izvođenje iz šifre mašine),
 * trajanje je COALESCE(override, TPZ + TK × kom), a završenost COALESCE(override, kucanja).
 */
describe("gant feed (046/26)", () => {
  function makeGanttSvc() {
    const calls: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        calls.push(sql);
        return [];
      }),
    } as never;
    const svc = new PlanProizvodnjeReadService(prisma, {} as never);
    return { svc, calls };
  }

  it("effectiveOpsInner nosi planirana polja + halu + izvedeno trajanje/završenost", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql;
    expect(sql).toContain("planned_start_at");
    expect(sql).toContain("planned_end_at");
    expect(sql).toContain("predecessor_work_order_id");
    // hala = ručni šifrarnik po EFEKTIVNOJ mašini (poštuje reassign), bez izvođenja iz šifre
    expect(sql).toContain("LEFT JOIN plan_proizvodnje_machine_halls mh ON mh.machine_code = base.effective_machine_code");
    expect(sql).toContain("effective_duration_minutes");
    expect(sql).toContain("is_completed_effective");
  });

  it("trajanje = COALESCE(override, TPZ + TK × komada)", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql.replace(/\s+/g, " ");
    expect(sql).toContain("COALESCE( base.planned_duration_minutes, (COALESCE(base.tpz_min, 0) + COALESCE(base.tk_min, 0) * COALESCE(base.komada_total, 0))::int )");
  });

  it("gantt() zadržava i ZATVORENE stavke koje su već na osi (planned_start_at IS NOT NULL)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("OR planned_start_at IS NOT NULL");
    expect(sql).toContain("effective_machine_code IS NOT NULL");
  });

  it("gantt(hall='-') filtrira grupu bez hale", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { hall: "-" });
    expect(calls[0].sql.replace(/\s+/g, " ")).toContain("hall IS NULL");
  });

  it("gantt(hall=…) je parametrizovan (bez interpolacije u SQL tekst)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { hall: "Hala 1", machine: "G01", q: "9400" });
    expect(calls[0].values).toEqual(expect.arrayContaining(["Hala 1", "G01", "%9400%"]));
    expect(calls[0].sql).not.toContain("Hala 1");
  });

  it("machineHalls() vraća SVE mašine (LEFT JOIN šifrarnika), ne samo dodeljene", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.machineHalls("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("FROM operations m");
    expect(sql).toContain("LEFT JOIN plan_proizvodnje_machine_halls mh");
  });
});
