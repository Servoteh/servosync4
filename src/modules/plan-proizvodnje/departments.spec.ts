import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { DEPARTMENTS, type DepartmentDef } from "./departments";

/**
 * GAP-PM-25: dept matching dopunjen name-patternima (opis_rada ILIKE) uz kod-matching.
 * Port 1.0 loadOperationsForDept operationNamePatterns. Trenutna 1.0 taksonomija je
 * cisto kod-based (nijedno odeljenje nema patterne) — mehanizam se testira injekcijom.
 */
describe("plan-proizvodnje dept matching (machineMatch)", () => {
  const makeSvc = () => {
    const svc = new PlanProizvodnjeService(
      {} as Sy15Service,
      {} as Sy15StorageService,
    );
    // machineMatch je privatan — pristupamo kroz cast (isti obrazac kao sy15 spec).
    const call = (d: DepartmentDef) =>
      (svc as unknown as {
        machineMatch: (x: DepartmentDef) => { sql?: string } | null;
      }).machineMatch(d);
    return { call };
  };

  it("cisto kod-based odeljenje: samo effective_machine_code, bez opis_rada", () => {
    const { call } = makeSvc();
    const glodanje = DEPARTMENTS.find((d) => d.slug === "glodanje")!;
    const out = call(glodanje);
    expect(out?.sql).toContain("effective_machine_code");
    expect(out?.sql ?? "").not.toContain("opis_rada");
  });

  it("name-pattern odeljenje: opis_rada ILIKE grana se OR-uje sa kod-matchingom", () => {
    const { call } = makeSvc();
    const out = call({
      slug: "test",
      label: "Test",
      kind: "machines",
      machinePrefixes: ["3"],
      operationNamePatterns: ["bravar"],
    });
    expect(out?.sql).toContain("opis_rada ILIKE");
    expect(out?.sql).toContain("effective_machine_code");
    expect(out?.sql).toContain(" OR ");
  });

  it("samo name-patterns (bez kodova): iskljucivo opis_rada grana", () => {
    const { call } = makeSvc();
    const out = call({
      slug: "test",
      label: "Test",
      kind: "machines",
      operationNamePatterns: ["montaza"],
    });
    expect(out?.sql).toContain("opis_rada ILIKE");
    expect(out?.sql ?? "").not.toContain("effective_machine_code");
  });

  it("bez kodova i bez patterna: null (nedefinisan tab)", () => {
    const { call } = makeSvc();
    expect(call({ slug: "x", label: "X", kind: "machines" })).toBeNull();
  });

  it("1.0 taksonomija je kod-based: nijedno zivo odeljenje nema name-patterne (paritet)", () => {
    const withNames = DEPARTMENTS.filter(
      (d) => (d.operationNamePatterns?.length ?? 0) > 0,
    );
    expect(withNames).toHaveLength(0);
  });
});
