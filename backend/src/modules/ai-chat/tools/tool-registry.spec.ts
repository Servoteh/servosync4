import { PERMISSIONS } from "../../../common/authz/permissions";
import { SYSTEM_PROMPT } from "../ai-tools";
import {
  AI_TOOLS,
  CORE_TOOLS,
  SY15_TOOLS,
  TOOL_DEFS,
  findTool,
  isToolAllowed,
  makeRegistry,
  toolsForScope,
} from "./index";

/**
 * TALAS AI-1, tačka 2 — GARANCIJA POKLAPANJA. Pre ovog talasa su definicija
 * (`TOOL_DEFS`) i izvršenje (`rpcSql` switch) bili u dva fajla: alat je mogao da
 * postoji u šemi bez handlera i to bi puklo tek u produkciji, na korisniku.
 * Ovaj spec je brana — nepoklapanje pada OVDE, ne u runtime-u.
 */
describe("registar alata — poklapanje definicije i handlera", () => {
  it("svako ime iz definicija ima handler", () => {
    for (const def of TOOL_DEFS) {
      const tool = findTool(def.name);
      expect(tool).toBeDefined();
      expect(typeof tool?.execute).toBe("function");
    }
  });

  it("svaki handler iz registra ima definiciju (ime, opis, šema)", () => {
    const defNames = new Set(TOOL_DEFS.map((d) => d.name));
    for (const tool of AI_TOOLS) {
      expect(defNames.has(tool.name)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.schema).toHaveProperty("type", "object");
      expect(["read", "write"]).toContain(tool.kind);
      expect(tool.scopes.length).toBeGreaterThan(0);
    }
    expect(TOOL_DEFS).toHaveLength(AI_TOOLS.length);
  });

  it("nepoznato ime nema handler (model ume da izmisli alat)", () => {
    expect(findTool("izmisljen_alat")).toBeUndefined();
  });

  it("duplo ime u registru pada odmah (ne tiho gazi handler)", () => {
    const jedan = SY15_TOOLS[0];
    expect(() => makeRegistry([jedan, jedan])).toThrow(/Duplo ime/);
  });

  it("sy15 alati NEMAJU app-permisiju — pravo im i dalje presuđuje RLS", () => {
    // 20 portovanih iz 1.0 + `trosak_sredstva` (03.08.2026). I novi čita sy15 kroz
    // `withUserRls`, pa važi isto pravilo: red presuđuje RLS, ne app-permisija.
    expect(SY15_TOOLS).toHaveLength(21);
    for (const t of SY15_TOOLS) expect(t.requiredPermission).toBeUndefined();
  });

  it("svaki alat nad glavnom bazom je read-only I traži permisiju", () => {
    expect(CORE_TOOLS.length).toBeGreaterThan(0);
    for (const t of CORE_TOOLS) {
      expect(t.kind).toBe("read");
      // Glavna baza nema RLS — bez permisije alat ne bi imao NIJEDNU branu.
      expect(t.requiredPermission).toBeTruthy();
    }
  });

  it("sistem prompt pominje svaki nov alat (inače ga model ne koristi)", () => {
    for (const t of CORE_TOOLS) expect(SYSTEM_PROMPT).toContain(t.name);
  });
});

describe("toolsForScope — filter po permisijama korisnika", () => {
  const IME = "nadji_radni_nalog";

  it("korisnik SA permisijom dobija alat", () => {
    const names = toolsForScope("personal", new Set([PERMISSIONS.RN_READ])).map(
      (t) => t.name,
    );
    expect(names).toContain(IME);
  });

  it("korisnik BEZ permisije NE dobija alat", () => {
    const names = toolsForScope("personal", new Set(["nesto.drugo"])).map(
      (t) => t.name,
    );
    expect(names).not.toContain(IME);
    // …ali sy15 alati mu i dalje stoje na raspolaganju (nepromenjeno ponašanje).
    expect(names).toContain("go_saldo");
    expect(names).toHaveLength(SY15_TOOLS.length);
  });

  it("nepoznat skup permisija = FAIL-CLOSED (ništa iz glavne baze)", () => {
    const names = toolsForScope("personal", undefined).map((t) => t.name);
    for (const t of CORE_TOOLS) expect(names).not.toContain(t.name);
  });

  it("permisija ne otvara alat u pogrešnoj niti (deljena projektna nit)", () => {
    const sve = new Set(
      AI_TOOLS.map((t) => t.requiredPermission ?? "").filter(Boolean),
    );
    const names = toolsForScope("project", sve).map((t) => t.name);
    for (const t of CORE_TOOLS) expect(names).not.toContain(t.name);
    expect(names).toHaveLength(6); // 1.0 paritet: 6 deljenih alata
  });

  it("isToolAllowed presuđuje isto što i toolsForScope (jedna brana, dva mesta)", () => {
    const tool = findTool(IME);
    expect(tool).toBeDefined();
    expect(
      isToolAllowed(tool!, "personal", new Set([PERMISSIONS.RN_READ])),
    ).toBe(true);
    expect(isToolAllowed(tool!, "personal", new Set())).toBe(false);
    expect(isToolAllowed(tool!, "personal", undefined)).toBe(false);
    expect(
      isToolAllowed(tool!, "project", new Set([PERMISSIONS.RN_READ])),
    ).toBe(false);
  });
});
