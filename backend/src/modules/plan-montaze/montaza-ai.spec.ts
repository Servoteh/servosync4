import {
  MONTAZA_AI_ALLOWED_MODELS,
  MONTAZA_AI_TOOL,
  MONTAZA_MAX_SLIKA_B64,
  MONTAZA_MAX_SLIKE,
  MONTAZA_MAX_TEKST_CHARS,
  MONTAZA_REQUIRED_FIELDS,
  MONTAZA_STATUS_CODES,
  normalizeMontazaOut,
} from "./montaza-ai";

/**
 * Paritet edge `montaza-izvestaj-ai` (PRESUDA C6). Konstante i normalizacija MORAJU
 * biti identične 1.0 edge-u (limiti/allowlist/status/required/tool-schema).
 */
describe("montaza-ai konstante (paritet edge)", () => {
  it("model allowlist = opus/sonnet/haiku (identičan DB fn + edge)", () => {
    expect([...MONTAZA_AI_ALLOWED_MODELS]).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });
  it("limiti = 16 slika / 20000 znakova / ~4MB b64", () => {
    expect(MONTAZA_MAX_SLIKE).toBe(16);
    expect(MONTAZA_MAX_TEKST_CHARS).toBe(20000);
    expect(MONTAZA_MAX_SLIKA_B64).toBe(4 * 1024 * 1024);
  });
  it("STATUS_CODES = 6 kodova (DB CHECK paritet)", () => {
    expect([...MONTAZA_STATUS_CODES]).toEqual([
      "zavrseno",
      "delimicno",
      "u_toku",
      "ceka_materijal",
      "ceka_potvrdu",
      "dodatna_intervencija",
    ]);
  });
  it("REQUIRED_FIELDS = 6 obaveznih (za nedostajuci_podaci)", () => {
    expect(MONTAZA_REQUIRED_FIELDS).toEqual([
      "datum",
      "predmet",
      "klijent",
      "lokacija",
      "pocetak_rada",
      "kraj_rada",
    ]);
  });
  it("tool = forsiran alat `izvestaj` sa enum statusom", () => {
    expect(MONTAZA_AI_TOOL.name).toBe("izvestaj");
    const props = MONTAZA_AI_TOOL.input_schema.properties as Record<
      string,
      { enum?: string[] }
    >;
    expect(props.status.enum).toEqual([...MONTAZA_STATUS_CODES]);
  });
});

describe("normalizeMontazaOut (paritet edge normalize)", () => {
  it("nepoznat status → 'u_toku'; validan status se čuva", () => {
    expect(normalizeMontazaOut({ status: "xyz" }).status).toBe("u_toku");
    expect(normalizeMontazaOut({ status: "zavrseno" }).status).toBe("zavrseno");
  });
  it("trim string polja; fotodokumentacija filtrira redni_broj<=0", () => {
    const out = normalizeMontazaOut({
      opis_radova: "  radi  ",
      fotodokumentacija: [
        { redni_broj: 1, opis: "a" },
        { redni_broj: 0, opis: "skip" },
        { redni_broj: "2", opis: "b" },
      ],
    });
    expect(out.opis_radova).toBe("radi");
    expect(out.fotodokumentacija).toEqual([
      { redni_broj: 1, opis: "a" },
      { redni_broj: 2, opis: "b" },
    ]);
  });
  it("nedostajuci_podaci: predmet zadovoljen ako je predmet ILI naziv_projekta prisutan", () => {
    const empty = normalizeMontazaOut({});
    expect(empty.nedostajuci_podaci).toEqual([
      "datum",
      "predmet",
      "klijent",
      "lokacija",
      "pocetak_rada",
      "kraj_rada",
    ]);
    const withNaziv = normalizeMontazaOut({ naziv_projekta: "P" });
    expect(withNaziv.nedostajuci_podaci).not.toContain("predmet");
    const withPredmet = normalizeMontazaOut({ predmet: "9400/2" });
    expect(withPredmet.nedostajuci_podaci).not.toContain("predmet");
  });
  it("predmet_item_id počinje kao null (postavlja ga enrichPredmet iz baze)", () => {
    expect(normalizeMontazaOut({}).predmet_item_id).toBeNull();
  });
});
