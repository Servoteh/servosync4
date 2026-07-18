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

  it("go_istorija (20. alat): u SYSTEM_PROMPT-u + VERBATIM opis + pozicija posle go_pregled", () => {
    expect(SYSTEM_PROMPT).toContain(
      "go_istorija (istorija GO PO SVIM GODINAMA",
    );
    expect(SYSTEM_PROMPT).toContain("stara evidencija za starije godine");
    const d = desc("go_istorija");
    for (const frag of [
      "ISTORIJA godišnjeg odmora PO SVIM GODINAMA",
      "ranije evidentirano",
      "PLANIRANI (odobreni budući) periodi",
      "staru evidenciju",
      "Bez employee_id → pozivalac",
    ]) {
      expect(d).toContain(frag);
    }
    // Ista pozicija u nizu kao 1.0 edge: odmah posle go_pregled, pre projekat_info.
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names.indexOf("go_istorija")).toBe(names.indexOf("go_pregled") + 1);
    expect(names.indexOf("projekat_info")).toBe(
      names.indexOf("go_istorija") + 1,
    );
    expect(TOOL_DEFS).toHaveLength(20);
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
    expect(proj).not.toContain("go_istorija"); // lični alat — NIJE u deljenoj niti
    expect(toolsForScope("personal")).toHaveLength(TOOL_DEFS.length);
  });
});
