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

  // ── 069/26: gotovost po DOBRIM komadima + oznaka škarta ────────────────────
  it("069: gotovost broji SAMO dobre komade (dorada i škart ispadaju iz zbira)", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql.replace(/\s+/g, " ");
    // Brojač dobrih: DOSLOVNO `= 0`, isti izraz kao praćenje/tech-processes — ne
    // „sve što nije 1/2", da buduća 4. vrsta kvaliteta ne bi u planu prošla kao dobra.
    expect(sql).toContain("COALESCE(SUM(t.piece_count) FILTER (WHERE t.quality_type_id = 0), 0) AS good_done");
    // Kvačica: ručna presuda planera → pa količina DOBRIH ≥ plan.
    expect(sql).toContain("COALESCE(base.planned_done, CASE WHEN base.komada_total IS NOT NULL AND base.komada_total > 0");
    expect(sql).toContain("THEN COALESCE(tr.good_done, 0) >= base.komada_total");
    // Zastavica kioska preživljava SAMO kao grana za nemerljivu količinu.
    expect(sql).toContain("ELSE COALESCE(tr.is_done, false) END) AS is_completed_effective");
  });

  it("069: sirova zastavica `is_done_in_bigtehn` ostaje NETAKNUTA (OPEN_OPS ne sme da se pomeri)", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql.replace(/\s+/g, " ");
    // Lista „Po mašini" filtrira po ovome — da promena pravila gotovosti ne bi mogla
    // ništa da vrati u listu niti da izbaci iz nje.
    expect(sql).toContain("COALESCE(tr.is_done, false) AS is_done_in_bigtehn");
  });

  it("069: oznaka škarta stoji dok škart NIJE nadoknađen (isti izraz gotovosti)", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql.replace(/\s+/g, " ");
    expect(sql).toContain("(COALESCE(g4.scrap_pieces, 0) > 0 AND NOT (COALESCE(base.planned_done,");
    expect(sql).toContain(") AS scrap_outstanding");
    // Izraz gotovosti se pojavljuje DVA puta — kvačica i oznaka moraju iz istog izvora.
    const hits = sql.split("THEN COALESCE(tr.good_done, 0) >= base.komada_total").length - 1;
    expect(hits).toBe(2);
  });

  it("069: `komada_done` ostaje ZBIR SVIH kvaliteta (tuđi brojači se ne pomeraju)", () => {
    const { priv } = makeSvc();
    const sql = priv.effectiveOpsInner(Prisma.empty).sql.replace(/\s+/g, " ");
    expect(sql).toContain("SELECT SUM(t.piece_count) AS komada_done,");
    expect(sql).toContain("COALESCE(tr.komada_done, 0)::bigint AS komada_done");
    expect(sql).toContain("COALESCE(tr.good_done, 0)::bigint AS komada_done_good");
  });

  it("069: gant feed nosi dobre komade + škart (inače dijalog piše 100/100 bez kvačice)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("komada_done_good");
    expect(sql).toContain("scrap_outstanding");
    expect(sql).toContain("scrap_pieces");
    expect(sql).toContain("rework_pieces");
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

  /**
   * 070/26 — „Ređaj po" ima DVA režima i podrazumevani MORA ostati kao pre 070/26:
   * stari klijent (i svaki koji ne šalje `sort`) dobija današnji ekran. Prva dva ključa
   * su u oba režima grupna → `LIMIT` seče najviše JEDNU mašinu, na čemu počiva FE brana.
   */
  const ORDER_TERMIN =
    "ORDER BY hall ASC NULLS LAST, effective_machine_code ASC, planned_start_at ASC NULLS LAST, shift_sort_order ASC NULLS LAST, rok_izrade ASC NULLS LAST, rn_ident_broj ASC, operacija ASC";
  const ORDER_RUCNI =
    "ORDER BY hall ASC NULLS LAST, effective_machine_code ASC, shift_sort_order ASC NULLS LAST, planned_start_at ASC NULLS LAST, rok_izrade ASC NULLS LAST, rn_ident_broj ASC, operacija ASC";

  it("gantt() bez `sort` = PODRAZUMEVANO po terminu (nepromenjeno stanje pre 070/26)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain(ORDER_TERMIN);
    expect(sql).not.toContain(ORDER_RUCNI);
  });

  it("gantt(sort='rucni') stavlja RUČNI redosled smene pre planiranog početka", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { sort: "rucni" });
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain(ORDER_RUCNI);
    expect(sql).not.toContain(ORDER_TERMIN);
  });

  it("gantt(sort=<nepoznato>) pada na podrazumevani poredak (bez 400)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { sort: "bilo-sta" });
    expect(calls[0].sql.replace(/\s+/g, " ")).toContain(ORDER_TERMIN);
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

  // 046/26-A4: picker pretraga mimo LIMIT 5000 truncation-a (prod: 16.394 kandidata).
  it("gantt(scope='sve') skida open-ops filter i sortira po RN + operaciji", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { q: "1083492", scope: "sve" });
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).not.toContain("OR planned_start_at IS NOT NULL");
    expect(sql).toContain("ORDER BY rn_ident_broj ASC, operacija ASC");
    expect(calls[0].values).toEqual(expect.arrayContaining(["%1083492%"]));
  });

  it("gantt(scope='sve') bez q od bar 2 znaka → 400 (zaštita od full-dump pretrage)", async () => {
    const { svc } = makeGanttSvc();
    await expect(
      svc.gantt("pm@servoteh.com", { scope: "sve", q: "1" }),
    ).rejects.toThrow("scope=sve");
    await expect(svc.gantt("pm@servoteh.com", { scope: "sve" })).rejects.toThrow(
      "scope=sve",
    );
  });

  it("gantt bez scope zadržava open-ops granu (postojeći feed netaknut)", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { q: "1083492" });
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("OR planned_start_at IS NOT NULL");
    expect(sql).toContain("ORDER BY hall ASC NULLS LAST");
  });

  it("gant kolone nose picker status polja (rn_zavrsen/kooperacija/arhiva/završna kontrola) — A4", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com", { q: "1083492", scope: "sve" });
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("rn_zavrsen");
    expect(sql).toContain("is_cooperation_effective");
    expect(sql).toContain("overlay_archived_at");
    // scope=sve skida i EFF_FILTER — bez ove kolone FE ne ume da objasni ZAŠTO
    // RN kroz završnu kontrolu (M6) nije za dodavanje i nudio bi živ „Dodaj"
    // (izmereno na produ 03.08.2026: 537 takvih operacija). Kolona mora biti u
    // GANTT_COLS SELECT listi (odmah iza overlay_archived_at), ne samo negde u
    // podupitu — od C2 spoljni SELECT je `g.*, sklop_*`, pa se ne seče do prvog FROM.
    expect(sql).toContain("overlay_archived_at, plan_rn_final_control_done FROM (");
  });

  // 046/26-C2: kolona „Sklop" — efektivni roditelj po 053 strukturi praćenja.
  it("gant feed nosi kolonu Sklop (override → auto sastavnica; virtuelni = negativan id) — C2", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("AS sklop_node_id");
    expect(sql).toContain("AS sklop_naziv");
    expect(sql).toContain("AS sklop_rn_ident");
    // Override grana mora biti CASE po POSTOJANJU reda (parent NULL = ručni koren →
    // bez sklopa), a NE COALESCE — COALESCE bi ručni koren tiho vratio na auto-roditelja.
    expect(sql).toContain(
      "WHEN EXISTS (SELECT 1 FROM pracenje_structure_overrides",
    );
    expect(sql).toContain("FROM work_order_components c");
    // Negativan id = virtuelni sklop (053 paket 2) — naziv iz žive (nesoft-obrisane) tabele.
    expect(sql).toContain("vs.id = -pid.parent_id AND vs.deleted_at IS NULL");
    // Dete sa više auto-roditelja (prod: 72) → deterministički najmanji work_order_id.
    expect(sql).toContain("ORDER BY c.work_order_id ASC LIMIT 1");
  });

  it("sklop lateral se primenjuje POSLE LIMIT-a (max 5000 evaluacija, ne nad celim feed-om) — C2", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    // Wrapper `) g` (kraj isečenog podupita) mora doći PRE sklop join lanca.
    expect(sql.indexOf(") g")).toBeGreaterThan(-1);
    expect(sql.indexOf("pracenje_structure_overrides")).toBeGreaterThan(
      sql.indexOf(") g"),
    );
  });

  // Paket B: dijalog stavke prikazuje KO/KADA je ručno označio spremnost — pečat
  // mora da izađe kroz gant feed (uz postojeći is_ready_manual flag).
  it("gant kolone nose pečat ručnog override-a spremnosti (ko/kada) — Paket B", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    // Od C2 je spoljni SELECT `g.*, sklop_*` (wrapper), pa PRVI ` FROM ` dolazi odmah
    // iza njega — slice do prvog FROM više ne hvata GANTT_COLS. Kolone se zato traže
    // kao susedni niz iz GANTT_COLS liste (bez `base.` prefiksa — podupit ih nosi
    // prefiksovane, pa goli niz jedinstveno pogađa SELECT listu; isti obrazac kao A4).
    expect(sql).toContain("is_ready_manual, ready_override_at, ready_override_by,");
  });

  // 079/26: kartica pozicije nudi broj crteža kao link na PDF — ali samo kad crtež
  // postoji (prod 05.08.2026: 107 od 218 naloga u planu ima PDF sadržaj). Kolona je
  // odavno u `effectiveOpsInner` i u ALL_COLS; jedino ju je GANT feed preskakao, pa je
  // kartica nije ni imala. Bez nje FE bira između mrtvog linka na polovini pozicija i
  // nijednog linka — traži se susedni niz iz GANTT_COLS liste (isti obrazac kao A4/B).
  it("gant kolone nose has_bigtehn_drawing (postoji li PDF crteža) — 079/26", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.gantt("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("rn_ident_broj, broj_crteza, has_bigtehn_drawing,");
  });

  it("machineHalls() vraća SVE mašine (LEFT JOIN šifrarnika), ne samo dodeljene", async () => {
    const { svc, calls } = makeGanttSvc();
    await svc.machineHalls("pm@servoteh.com");
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("FROM operations m");
    expect(sql).toContain("LEFT JOIN plan_proizvodnje_machine_halls mh");
  });
});
