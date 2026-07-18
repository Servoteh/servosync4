/**
 * Plan proizvodnje — TAB → filter mapiranje (port 1.0
 * `src/ui/planProizvodnje/departments.js`, single source of truth za odeljenja).
 * Filter je KOD-based (rj_code mašine / `effective_machine_code` operacije).
 * Prenosi se 1:1 (doktrina §C — NE redizajnirati poslovni tok); FE i BE dele istu
 * taksonomiju. `kind:'all'` = „Sve" (bez filtera) ili „Ostalo" (isFallback = ne upada
 * ni u jedan imenovani tab).
 */
export interface DepartmentDef {
  slug: string;
  label: string;
  kind: "machines" | "all";
  machineCodes?: string[];
  machinePrefixes?: string[];
  excludeMachineCodes?: string[];
  /**
   * Dodatno hvatanje operacija po NAZIVU rada (opis_rada ILIKE '%pat%') — port
   * 1.0 `loadOperationsForDept` operationNamePatterns (planProizvodnje.js:329-335).
   * OR-uje se sa kod-matchingom (mašina ILI naziv). Trenutno nijedno 1.0 odeljenje
   * ne definiše name-patterne (svi su kod-based), pa je ovo prazna grana radi
   * mehanizamskog pariteta — popuni se samo ako 1.0 dept dobije patterne.
   */
  operationNamePatterns?: string[];
  isFallback?: boolean;
}

export const DEPARTMENTS: DepartmentDef[] = [
  { slug: "sve", label: "Sve", kind: "all" },
  { slug: "glodanje", label: "Glodanje", kind: "machines", machinePrefixes: ["3"] },
  {
    slug: "struganje",
    label: "Struganje",
    kind: "machines",
    machinePrefixes: ["2"],
    excludeMachineCodes: ["21.1", "21.2"],
  },
  {
    slug: "brusenje",
    label: "Brušenje",
    kind: "machines",
    machinePrefixes: ["6"],
    excludeMachineCodes: ["6.8"],
  },
  {
    slug: "erodiranje",
    label: "Erodiranje",
    kind: "machines",
    machineCodes: ["10.1", "10.2", "10.3", "10.4", "10.5"],
  },
  { slug: "azistiranje", label: "Ažistiranje", kind: "machines", machineCodes: ["8.2"] },
  {
    slug: "secenje",
    label: "Sečenje i savijanje",
    kind: "machines",
    machineCodes: ["1.10", "1.2", "1.30", "1.40", "1.50", "1.60", "1.71", "1.72"],
  },
  {
    slug: "bravarsko",
    label: "Bravarsko",
    kind: "machines",
    machineCodes: ["4.1", "4.11", "4.12", "4.2", "4.3", "4.4"],
  },
  {
    slug: "farbanje",
    label: "Farbanje i površinska zaštita",
    kind: "machines",
    machineCodes: ["5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.11"],
  },
  { slug: "cam", label: "CAM programiranje", kind: "machines", machineCodes: ["17.0", "17.1"] },
  { slug: "ostalo", label: "Ostalo", kind: "all", isFallback: true },
];

const BY_SLUG = new Map(DEPARTMENTS.map((d) => [d.slug, d]));

export function getDepartment(slug: string): DepartmentDef | undefined {
  return BY_SLUG.get(slug);
}

/** Imenovani (machines-kind) tabovi — koristi se za „Ostalo" komplement. */
export const NAMED_DEPARTMENTS = DEPARTMENTS.filter(
  (d) => d.kind === "machines",
);
