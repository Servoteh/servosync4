import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeRevision,
  parseImportXml,
  parsePdmDate,
  parseQuantity,
  parseWeight,
  isProcurementMarking,
  PdmXmlStructureError,
  validateParsedFile,
  XML_STRUCTURE_ERROR,
  type ParsedPdmFile,
} from "./pdm-xml-parser";

/**
 * Kontrakt fixture: KOPIJA _analiza/pdm-xml-primeri/1126982_B.xml (stvarni
 * PDM export, 146 KB, sklop sa 4+ nivoa BOM-a) — UTF-8 BEZ deklaracije i
 * BEZ BOM-a, atributi sa razmacima, mešan State, nenumerički id-jevi.
 */
const FIXTURE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "pdm",
  "1126982_B.xml",
);

/** Minimalan validan <document> za sintetičke testove. */
function docXml(
  id: string,
  opts: {
    rev?: string;
    oznaka?: string;
    state?: string;
    rc?: string;
    weight?: string;
    pdmweid?: string;
  } = {},
  refs = "",
): string {
  const attrs: Record<string, string> = {
    Revision: opts.rev ?? "A",
    Oznaka: opts.oznaka ?? id,
    State: opts.state ?? "Odobreno",
    "Reference Count": opts.rc ?? "1.000000",
    Weight: opts.weight ?? "1.00",
    Naziv: `Deo ${id}`,
  };
  const attrXml = Object.entries(attrs)
    .map(([name, value]) => `<attribute name="${name}" value="${value}"/>`)
    .join("");
  const refsXml = refs ? `<references>${refs}</references>` : "";
  return (
    `<document aliasset="XMLSet" id="${id}" idattribute="Number" ` +
    `idcfgname="Default" pdmweid="${opts.pdmweid ?? "1"}">` +
    `<configuration name="Default" quantity="1">${attrXml}${refsXml}` +
    `</configuration></document>`
  );
}

function fileXml(docs: string): string {
  return (
    `<xml><transactions><transaction date="1783676510" ` +
    `type="wf_export_document_attributes" vaultname="Servoteh">${docs}` +
    `</transaction></transactions></xml>`
  );
}

describe("parseImportXml — kontrakt fixture 1126982_B.xml", () => {
  let parsed: ParsedPdmFile;

  beforeAll(() => {
    // Kontrakt §2.8: EKSPLICITNO UTF-8 dekodiranje buffera (bez deklaracije).
    const buffer = readFileSync(FIXTURE_PATH);
    parsed = parseImportXml(buffer.toString("utf8"));
  });

  it("čita transaction/@date kao epoch sekunde", () => {
    expect(parsed.transactionDate).toEqual(new Date(1783676510 * 1000));
  });

  it("vraća sve pojave dokumenata (109) sa jednim root-om 1126982 rev B", () => {
    expect(parsed.rows).toHaveLength(109);
    const roots = parsed.rows.filter((r) => r.isRoot);
    expect(roots).toHaveLength(1);
    expect(roots[0].docId).toBe("1126982");
    expect(roots[0].revision).toBe("B");
    expect(roots[0].parentDocId).toBeNull();
    expect(roots[0].hasReferences).toBe(true);
  });

  it("root ima 15 direktnih komponenti; ukupno 108 BOM ivica", () => {
    const rootChildren = parsed.rows.filter((r) => r.parentDocId === "1126982");
    expect(rootChildren).toHaveLength(15);
    expect(parsed.rows.filter((r) => r.parentDocId !== null)).toHaveLength(108);
  });

  it("nenumerički id-jevi (K00693, EGE2) su stringovi sa količinom iz Reference Count", () => {
    const k = parsed.rows.find(
      (r) => r.docId === "K00693" && r.parentDocId === "1126982",
    );
    expect(k).toBeDefined();
    expect(k!.quantity).toBe(5); // Reference Count "5.000000"
    expect(parsed.rows.some((r) => r.docId === "EGE2")).toBe(true);
  });

  it("ugnježdeni sklop: K16725 ima decu K16724 i K16723", () => {
    const children = parsed.rows
      .filter((r) => r.parentDocId === "K16725")
      .map((r) => r.docId);
    expect(children).toContain("K16724");
    expect(children).toContain("K16723");
  });

  it("prazna revizija → 'A' (63 pojave u fajlu)", () => {
    const defaulted = parsed.rows.filter(
      (r) => (r.attrs["Revision"] ?? "") === "" && r.revision === "A",
    );
    expect(defaulted).toHaveLength(63);
  });

  it("trim vrednosti: ZiliS sa ugrađenim newline (S&#xA;) → 'S'", () => {
    const doc = parsed.rows.find((r) => r.docId === "1126930");
    expect(doc).toBeDefined();
    expect(doc!.attrs["ZiliS"]).toBe("S");
  });

  it("UTF-8 dijakritici prežive dekodiranje (Đorđe Arsić, Č4732)", () => {
    const root = parsed.rows.find((r) => r.isRoot)!;
    expect(root.attrs["DesignBy"]).toBe("Đorđe Arsić");
    expect(parsed.rows.some((r) => r.attrs["Materijal"] === "Č4732")).toBe(
      true,
    );
  });

  it("Weight: prazan → 0 (K00693), decimalni parsiran (EGE2 0.02)", () => {
    const k = parsed.rows.find((r) => r.docId === "K00693")!;
    expect(k.attrs["Weight"]).toBe("");
    expect(k.weight).toBe(0);
    const ege = parsed.rows.find((r) => r.docId === "EGE2")!;
    expect(ege.weight).toBe(0.02);
  });

  it("atributi sa razmacima se čitaju po imenu (Approved by, Reference Count)", () => {
    const root = parsed.rows.find((r) => r.isRoot)!;
    expect(root.attrs["Approved by"]).toBe("Igor Voštić");
    expect(root.attrs["Reference Count"]).toBe("1.000000");
    expect(root.attrs["Document Number"]).toBe("1207786");
  });

  it("validacija prolazi: State mešano ODOBRENO/Odobreno je case-insensitive validan", () => {
    const states = new Set(parsed.rows.map((r) => r.attrs["State"]));
    expect(states.has("ODOBRENO")).toBe(true);
    expect(states.has("Odobreno")).toBe(true);
    expect(validateParsedFile(parsed)).toEqual([]);
  });
});

describe("parseImportXml — struktura i normalizacija (sintetički XML)", () => {
  it("nevalidan XML → PdmXmlStructureError sa legacy porukom", () => {
    expect(() => parseImportXml("ovo nije xml <")).toThrow(
      PdmXmlStructureError,
    );
    expect(() => parseImportXml("ovo nije xml <")).toThrow(XML_STRUCTURE_ERROR);
  });

  it("pogrešan root / bez transakcije → PdmXmlStructureError", () => {
    expect(() => parseImportXml("<foo><bar/></foo>")).toThrow(
      PdmXmlStructureError,
    );
    expect(() =>
      parseImportXml("<xml><transactions></transactions></xml>"),
    ).toThrow(PdmXmlStructureError);
  });

  it("nenumerički transaction/@date → transactionDate null (bez fail-a)", () => {
    const xml = fileXml(docXml("100")).replace(
      'date="1783676510"',
      'date="nije-broj"',
    );
    expect(parseImportXml(xml).transactionDate).toBeNull();
  });

  it("Weight nenumerički → -1 (legacy IsNumeric paritet)", () => {
    const xml = fileXml(docXml("100", { weight: "n/a" }));
    expect(parseImportXml(xml).rows[0].weight).toBe(-1);
  });

  it("Reference Count se zaokružuje sa min 1", () => {
    const xml = fileXml(docXml("100", {}, docXml("200", { rc: "0.400000" })));
    const child = parseImportXml(xml).rows.find((r) => r.docId === "200")!;
    expect(child.quantity).toBe(1);
  });
});

describe("validateParsedFile — paritet ProveriXMLFajl (SVE-ILI-NIŠTA)", () => {
  it("nedostaje Oznaka / Reference Count / id → greške", () => {
    const noOznaka = parseImportXml(fileXml(docXml("100", { oznaka: "  " })));
    expect(validateParsedFile(noOznaka).join(" ")).toContain("Oznaka");

    const noRc = parseImportXml(fileXml(docXml("100", { rc: " " })));
    expect(validateParsedFile(noRc).join(" ")).toContain("Reference Count");
  });

  it("State van {odobreno, izmena bez revizije} → greška; case-insensitive prolazi", () => {
    const bad = parseImportXml(fileXml(docXml("100", { state: "U izradi" })));
    expect(validateParsedFile(bad).join(" ")).toContain("State");

    const okUpper = parseImportXml(
      fileXml(docXml("100", { state: "IZMENA BEZ REVIZIJE" })),
    );
    expect(validateParsedFile(okUpper)).toEqual([]);
  });

  it("docId / Oznaka duži od 20 znakova → greška", () => {
    const longId = "X".repeat(21);
    const errors = validateParsedFile(
      parseImportXml(fileXml(docXml(longId, { oznaka: "OK" }))),
    );
    expect(errors.join(" ")).toContain("20");
  });

  it("Revision duža od 3 znaka → greška (kolona VarChar(3), bez tihog sečenja)", () => {
    const errors = validateParsedFile(
      parseImportXml(fileXml(docXml("100", { rev: "ABCD" }))),
    );
    expect(errors.join(" ")).toContain("Revision");

    const ok = validateParsedFile(
      parseImportXml(fileXml(docXml("100", { rev: "A2b" }))),
    );
    expect(ok).toEqual([]);
  });

  it("duplikat po (Oznaka, Revision, ParentDocID) → „četvrti uslov'", () => {
    const dup = parseImportXml(
      fileXml(docXml("100", {}, docXml("200") + docXml("200"))),
    );
    const errors = validateParsedFile(dup);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("četvrti uslov");
  });

  it("ISTI deo pod DVA roditelja NIJE duplikat (kao u stvarnom fajlu)", () => {
    const xml = fileXml(
      docXml("100", {}, docXml("300", {}, docXml("400")) + docXml("400")),
    );
    expect(validateParsedFile(parseImportXml(xml))).toEqual([]);
  });

  it("ponovljeno CELO podstablo pod drugim roditeljem NIJE duplikat (K16725 obrazac)", () => {
    // Isti sklop 300 (sa detetom 400) pod root-om I pod 500 — „četvrti
    // uslov" važi po POJAVI roditelja, ne po docId roditelja.
    const sub = docXml("300", {}, docXml("400"));
    const xml = fileXml(docXml("100", {}, sub + docXml("500", {}, sub)));
    expect(validateParsedFile(parseImportXml(xml))).toEqual([]);
  });
});

describe("pomoćne normalizacije", () => {
  it("normalizeRevision: prazno/razmaci → 'A', trim inače", () => {
    expect(normalizeRevision("")).toBe("A");
    expect(normalizeRevision("  ")).toBe("A");
    expect(normalizeRevision(undefined)).toBe("A");
    expect(normalizeRevision(" B ")).toBe("B");
  });

  it("parseWeight: ''→0, nenumerički→-1, '0.00'→0", () => {
    expect(parseWeight("")).toBe(0);
    expect(parseWeight("abc")).toBe(-1);
    expect(parseWeight("0.00")).toBe(0);
    expect(parseWeight("8.64")).toBe(8.64);
  });

  it("parseQuantity: round + min 1 + nevalidno → 1", () => {
    expect(parseQuantity("5.000000")).toBe(5);
    expect(parseQuantity("2.6")).toBe(3);
    expect(parseQuantity("0.2")).toBe(1);
    expect(parseQuantity("")).toBe(1);
    expect(parseQuantity("xyz")).toBe(1);
  });

  it("parsePdmDate: sva 4 haotična formata iz istog fajla + null na neuspeh", () => {
    expect(parsePdmDate("10.07.2026")).toEqual(new Date(Date.UTC(2026, 6, 10)));
    expect(parsePdmDate("7.6.2024.")).toEqual(new Date(Date.UTC(2024, 5, 7)));
    expect(parsePdmDate("24-Nov-23")).toEqual(new Date(Date.UTC(2023, 10, 24)));
    expect(parsePdmDate("7/15/2025")).toEqual(new Date(Date.UTC(2025, 6, 15)));
    expect(parsePdmDate("")).toBeNull();
    expect(parsePdmDate("31.02.2026")).toBeNull();
    expect(parsePdmDate("danas")).toBeNull();
  });

  it("isProcurementMarking: bilo koji ne-cifra znak → nabavka (legacy Like)", () => {
    expect(isProcurementMarking("K00693")).toBe(true);
    expect(isProcurementMarking("EGE2")).toBe(true);
    expect(isProcurementMarking("1126982")).toBe(false);
    expect(isProcurementMarking("112-698")).toBe(true);
  });
});
