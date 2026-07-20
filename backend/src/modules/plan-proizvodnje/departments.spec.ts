import {
  DEPARTMENTS,
  departmentMatchesCode,
  getDepartment,
  machineGroupSlug,
} from "./departments";

/**
 * Machine-group taksonomija — JEDINSTVEN izvor istine (`departments.ts`) za reassign
 * group-mismatch gate I dept tabove (plan §4.1-1 / §4.2 zadatak 2). `machineGroupSlug`
 * je izveden iz `DEPARTMENTS`; ovaj spec DOKAZUJE da izvedeno poklapa sy15
 * `production_machine_group_slug` CASE (kanon #1, F5b-0 izviđanje 20.07.2026).
 */
describe("machineGroupSlug (kanon #1 = sy15 production_machine_group_slug)", () => {
  const CASES: [string | null | undefined, string][] = [
    // null/prazno → ostalo
    [null, "ostalo"],
    [undefined, "ostalo"],
    ["", "ostalo"],
    ["   ", "ostalo"],
    // erodiranje 10.1–10.5
    ["10.1", "erodiranje"],
    ["10.3", "erodiranje"],
    ["10.5", "erodiranje"],
    // azistiranje 8.2
    ["8.2", "azistiranje"],
    // sečenje (eksplicitni kodovi)
    ["1.10", "secenje"],
    ["1.2", "secenje"],
    ["1.71", "secenje"],
    ["1.72", "secenje"],
    // bravarsko
    ["4.1", "bravarsko"],
    ["4.11", "bravarsko"],
    ["4.4", "bravarsko"],
    // farbanje 5.1–5.8, 5.11
    ["5.1", "farbanje"],
    ["5.8", "farbanje"],
    ["5.11", "farbanje"],
    // cam 17.0/17.1
    ["17.0", "cam"],
    ["17.1", "cam"],
    // prefiks 3 → glodanje
    ["3", "glodanje"],
    ["3.1", "glodanje"],
    ["3.12", "glodanje"],
    // prefiks 2 (sem 21.1/21.2) → struganje
    ["2", "struganje"],
    ["2.1", "struganje"],
    ["2.10", "struganje"],
    // prefiks 6 (sem 6.8) → brusenje
    ["6.1", "brusenje"],
    ["6.7", "brusenje"],
    // IZUZECI → ostalo
    ["21.1", "ostalo"],
    ["21.2", "ostalo"],
    ["6.8", "ostalo"],
    // završna/međufazna kontrola nisu grupa → ostalo
    ["8.3", "ostalo"],
    ["8.4", "ostalo"],
    // nepoznat kod → ostalo
    ["99.9", "ostalo"],
    ["1.5", "ostalo"],
  ];

  it.each(CASES)("rj_code %p → %p", (code, slug) => {
    expect(machineGroupSlug(code)).toBe(slug);
  });

  it("reassign paritet: isti izvor za dept tab i group-mismatch (nema dva mapiranja)", () => {
    // Za svaki imenovani dept, njegov reprezentativni kod se vraća baš u taj slug.
    expect(machineGroupSlug("3.1")).toBe(getDepartment("glodanje")!.slug);
    expect(machineGroupSlug("10.2")).toBe(getDepartment("erodiranje")!.slug);
    // Group-mismatch: glodanje ('3.1') vs struganje ('2.1') su RAZLIČITE grupe.
    expect(machineGroupSlug("3.1")).not.toBe(machineGroupSlug("2.1"));
    // Isti tab: dve glodanje mašine su ISTA grupa (nema mismatch).
    expect(machineGroupSlug("3.1")).toBe(machineGroupSlug("3.9"));
  });
});

describe("departmentMatchesCode (kod-based; prefiks = tačan kod ili {p}. grana)", () => {
  const glodanje = getDepartment("glodanje")!;
  const struganje = getDepartment("struganje")!;

  it("prefiks hvata tačan kod i {p}. granu, ne i dotless nastavak", () => {
    expect(departmentMatchesCode(glodanje, "3")).toBe(true);
    expect(departmentMatchesCode(glodanje, "3.1")).toBe(true);
    expect(departmentMatchesCode(glodanje, "30")).toBe(false); // ne startsWith '3.'
  });

  it("excludeMachineCodes ima prednost nad prefiksom", () => {
    expect(departmentMatchesCode(struganje, "2.1")).toBe(true);
    // 21.1 ne startsWith '2.' pa i tako ne bi ušlo; exclude je belt-and-suspenders.
    expect(departmentMatchesCode(struganje, "21.1")).toBe(false);
  });

  it("prazan kod → false", () => {
    expect(departmentMatchesCode(glodanje, "")).toBe(false);
  });
});

describe("dept taksonomija — invarijante", () => {
  it("1.0 taksonomija je kod-based: nijedno živo odeljenje nema name-patterne (paritet)", () => {
    const withNames = DEPARTMENTS.filter(
      (d) => (d.operationNamePatterns?.length ?? 0) > 0,
    );
    expect(withNames).toHaveLength(0);
  });

  it("imenovani (machines) kodovi se NE preklapaju (redosled iteracije nebitan)", () => {
    // Svaki eksplicitni kod mapira u tačno jedan named dept.
    const named = DEPARTMENTS.filter((d) => d.kind === "machines");
    for (const d of named) {
      for (const code of d.machineCodes ?? []) {
        const hits = named.filter((x) => departmentMatchesCode(x, code));
        expect(hits.map((h) => h.slug)).toEqual([d.slug]);
      }
    }
  });
});
