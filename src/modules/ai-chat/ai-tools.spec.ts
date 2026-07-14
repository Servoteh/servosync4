import { DATE_LINE, SYSTEM_PROMPT, TOOL_DEFS, toolsForScope } from "./ai-tools";

/**
 * VERBATIM guard (§C): sprečava da se AI prompt/opisi alata ponovo skrate. Pinuje
 * LOAD-BEARING bihevioralne instrukcije iz 1.0 edge-a (index.ts:76-352,624-630).
 */
describe("ai-tools — verbatim 1.0 prompt/opisi (anti-truncation)", () => {
  const desc = (name: string) =>
    TOOL_DEFS.find((t) => t.name === name)?.description ?? "";

  it("SYSTEM_PROMPT nosi bezbednosnu napomenu Održavanja + go_pregled format", () => {
    for (const frag of [
      "LOTO",
      "električni ormari",
      "ovlašćen tehničar",
      "preostalo_zakljucno_sa_danas",
      "Iskorišćeni dani",
      "periodi_iskorisceno",
      "NAVIGACIJA (OBAVEZNO)",
    ]) {
      expect(SYSTEM_PROMPT).toContain(frag);
    }
  });

  it("DATE_LINE nosi vremenski_status + zabranu sabiranja planirano+iskorisceno", () => {
    const d = DATE_LINE();
    expect(d).toContain("vremenski_status");
    expect(d).toContain("iskorisceno/u_toku/planirano");
    expect(d).toContain("nikad ne");
    expect(d).toContain("ukupno_iskorisceno_po_tipu");
  });

  it("odsustva_lista: legenda šifara (go/bo/pr/sp/np-nop/sv)", () => {
    const d = desc("odsustva_lista");
    for (const frag of [
      "go=godišnji",
      "bo=bolovanje",
      "pr=praznik",
      "sp=slobodan dan",
      "np/nop=neplaćeno",
      "sv=slava/verski",
    ]) {
      expect(d).toContain(frag);
    }
  });

  it("sql_upit: information_schema.columns + na sql_greska ispravi i pokušaj", () => {
    const d = desc("sql_upit");
    expect(d).toContain("information_schema.columns");
    expect(d).toContain("sql_greska");
    expect(d).toContain("SAMO ZA ADMIN/HR");
  });

  it("go_pregled: liste periodi_iskorisceno + periodi_planirano", () => {
    const d = desc("go_pregled");
    expect(d).toContain("periodi_iskorisceno");
    expect(d).toContain("periodi_planirano");
  });

  it("prijavi_kvar: potvrda pre poziva + nema_prava", () => {
    const d = desc("prijavi_kvar");
    expect(d).toContain("nema_prava");
    expect(d).toContain("potvrdu");
  });

  it("projektni scope: 6 deljenih alata, bez ličnih (GO/sati/SQL)", () => {
    // Redosled prati TOOL_DEFS (filter preserves order).
    const proj = toolsForScope("project").map((t) => t.name);
    expect(proj.sort()).toEqual(
      [
        "projekat_info",
        "pretrazi_znanje",
        "dodaj_belesku",
        "pretrazi_uputstva",
        "opis_pozicije",
        "inzenjering_pretraga",
      ].sort(),
    );
    expect(proj).not.toContain("go_saldo");
    expect(proj).not.toContain("sql_upit");
    expect(toolsForScope("personal")).toHaveLength(TOOL_DEFS.length);
  });
});
