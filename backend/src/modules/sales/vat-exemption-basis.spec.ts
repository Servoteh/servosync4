import { Prisma } from "@prisma/client";
import {
  exemptionCaseFor,
  exemptionFor,
  NEMA_TEXT,
  resolveExemption,
  type ExemptionCase,
} from "./vat-exemption";
import {
  basisAllowsSef,
  VAT_EXEMPTION_BASIS_CODES,
  type VatExemptionBasisRef,
} from "./vat-exemption-basis";
import { UblBuilderService } from "./sef/ubl-builder.service";

/**
 * OSNOV PORESKOG OSLOBOĐENJA — PAPIR I E-FAKTURA MORAJU DA GOVORE ISTO.
 * =============================================================================
 *
 * 🔴 KVAR ZBOG KOG OVAJ FAJL POSTOJI (zatečeno stanje do 05.08.2026): za IZVOZ ROBE je
 * papir štampao „član 24. stav 1 tačka 2", a e-faktura slala `PDV-RS-24-1-5` i razlog
 * „čl. 24 st. 1 tač. 5". Dva različita pravna osnova za isti posao istom kupcu, na dva
 * dokumenta koja su oba original.
 *
 * Zašto to nijedan zatečeni test nije uhvatio: papir je meren prema papiru
 * (`templates/*.spec.ts`), a UBL prema UBL-u (`ubl-builder.service.spec.ts`) — nijedan
 * nije imao razloga da UPOREDI dva izvora. Zato prvi describe ispod ne meri ni papir ni
 * XML nego SAGLASNOST: iz kog se člana citira na jednom i na drugom mestu.
 *
 * `citedArticle` je srce testa: iz obe zapisne forme (srpski tekst „člana 24. stav 1
 * tačka 2" / „čl. 24 st. 1 tač. 5", i SEF šifra `PDV-RS-24-1-5`) izvlači isti
 * normalizovan oblik `24-1-2`, pa se mogu porediti bez obzira na formulaciju.
 */

/**
 * Iz teksta ili SEF šifre izvuci (član, stav, tačka) → `„24-1-2"`.
 * `null` = tekst ne citira nijedan član (npr. „NEMA").
 *
 * Namerno prihvata SVE oblike koji se u ovom modulu pojavljuju, jer test ne sme da pada
 * na formulaciju: cilj je da uhvati razliku u BROJU, ne u načinu pisanja.
 */
export function citedArticle(text: string | null | undefined): string | null {
  if (!text) return null;

  // 1) SEF šifra: `PDV-RS-24-1-5` → `24-1-5`.
  const sef = /PDV-RS-(\d+(?:-\d+)*)/.exec(text);
  if (sef) return sef[1];

  // 2) Srpski tekst: „član/čl. N", pa opciono „stav/st. N", pa opciono „tačka/tač./t. N".
  //
  // ⚠️ BEZ `\b` PRED „čl": JavaScript `\b` računa granicu po ASCII slovima, a `č` nije
  // ASCII — pa između razmaka i `č` granice NEMA i `\bčl` ne pogađa NIJEDAN naš tekst.
  // Prva verzija ovog testa je zbog toga svuda vraćala `null` i time LAŽNO tvrdila
  // saglasnost; uhvatio je opisni test iznad („citat iz teksta …"), koji zato i postoji.
  // Nastavak reči je slobodan (`član`/`člana`/`članom`/`čl.`), jer se u tekstovima
  // pojavljuju svi padeži.
  const SRP = "[a-zšđčćž]*";
  const article = new RegExp(`čl(?:an${SRP})?\\.?\\s*(\\d+)`, "i").exec(text);
  if (!article) return null;
  const parts = [article[1]];

  const rest = text.slice(article.index + article[0].length);
  const paragraph = new RegExp(`\\bst(?:av${SRP})?\\.?\\s*(\\d+)`, "i").exec(rest);
  if (paragraph) {
    parts.push(paragraph[1]);
    const point = new RegExp(
      `ta[čc](?:${SRP})?\\.?\\s*(\\d+)|\\bt\\.\\s*(\\d+)`,
      "i",
    ).exec(rest.slice(paragraph.index + paragraph[0].length));
    if (point) parts.push(point[1] ?? point[2]);
  }
  return parts.join("-");
}

/**
 * DA LI DVA CITATA GOVORE RAZLIČITO — a ne samo različito PRECIZNO.
 *
 * `24-1-2` vs `24-1-5` = PROTIVREČNOST (različita tačka istog stava) → to je kvar.
 * `24` vs `24-2`        = ista tvrdnja, samo je jedna grublja → nije kvar.
 *
 * Razlika je bitna, jer zatečeni `export-service` razlog navodi samo „čl. 24 ZPDV" dok
 * papir navodi „član 24. stav 2". To nije neslaganje nego nedorečenost — i ne sme da
 * obori test koji lovi PROTIVREČNOST, inače bi se pravi kvar utopio u šumu.
 */
export function citationsContradict(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null || b === null) return false;
  const x = a.split("-");
  const y = b.split("-");
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return true;
  return false;
}

/**
 * SEMENA ŠIFARNIKA — ogledalo `INSERT`-a iz migracije
 * `20260805230000_sifarnik_osnova_oslobodjenja`.
 *
 * ⚠️ ZAŠTO PREPIS, A NE ČITANJE IZ BAZE: ovo je čist test (bez baze), a merena tvrdnja je
 * o SAGLASNOSTI TRI POLJA JEDNOG REDA — ona važi za vrednost, ne za način dopreme. Kad
 * knjigovođa doda red kroz šifarnik, isti invariant se meri nad njegovim redom istim
 * `citedArticle`-om; ovde stoje potvrđeni redovi iz odgovora 8, 9 i 10.
 */
const SEED: readonly VatExemptionBasisRef[] = [
  {
    code: VAT_EXEMPTION_BASIS_CODES.EXPORT_GOODS,
    name: "Izvoz dobara (čl. 24 st. 1 t. 2)",
    paperText:
      "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
    sefCode: "PDV-RS-24-1-2",
    sefReason: "Izvoz dobara (čl. 24 st. 1 tač. 2 ZPDV)",
    goesToSef: false,
  },
  {
    code: VAT_EXEMPTION_BASIS_CODES.FREE_ZONE,
    name: "Unos dobara u slobodnu zonu (čl. 24 st. 1 t. 5)",
    paperText:
      "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 5 Zakona o PDV.",
    sefCode: "PDV-RS-24-1-5",
    sefReason: "Unos dobara u slobodnu zonu (čl. 24 st. 1 tač. 5 ZPDV)",
    goesToSef: true,
  },
  {
    code: VAT_EXEMPTION_BASIS_CODES.INWARD_PROCESSING,
    name: "Oplemenjivanje — povraćaj robe ino primaocu (čl. 24 st. 1 t. 7)",
    paperText:
      "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 7 Zakona o PDV.",
    sefCode: "PDV-RS-24-1-7",
    sefReason: "Oplemenjivanje dobara (čl. 24 st. 1 tač. 7 ZPDV)",
    goesToSef: false,
  },
  {
    code: VAT_EXEMPTION_BASIS_CODES.DOMESTIC_EXEMPT,
    name: "Domaći oslobođen promet (čl. 24 st. 1 t. 5)",
    paperText:
      "Napomena o poreskom oslobođenju: Oslobođeno PDV-a na osnovu člana 24 stav 1 tačka 5 o PDV-u",
    sefCode: "PDV-RS-24-1-5",
    sefReason: "Oslobođen promet (čl. 24 st. 1 tač. 5 ZPDV)",
    goesToSef: true,
  },
  {
    code: VAT_EXEMPTION_BASIS_CODES.SERVICE_OUTSIDE_RS,
    name: "Usluga izvršena u inostranstvu (čl. 12 st. 3)",
    paperText:
      "PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u (mesto prometa usluge je van teritorije Republike Srbije)",
    sefCode: null,
    sefReason: "Mesto prometa usluge je van teritorije RS (čl. 12 st. 3 ZPDV)",
    goesToSef: false,
  },
  {
    code: VAT_EXEMPTION_BASIS_CODES.SERVICE_FOREIGN_TAXPAYER,
    name: "Usluga u RS za stranog poreskog obveznika (čl. 12 st. 3)",
    paperText:
      "PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u",
    sefCode: null,
    sefReason: "Mesto prometa usluge se određuje po čl. 12 st. 3 ZPDV",
    goesToSef: false,
  },
];

const bySeedCode = (code: string): VatExemptionBasisRef => {
  const row = SEED.find((r) => r.code === code);
  if (!row) throw new Error(`Nema semena za šifru ${code}.`);
  return row;
};

// ─────────────────────────────────────────────────────────────────────────────

describe("citedArticle — čita član i iz teksta i iz SEF šifre", () => {
  // Test alata pre testa tvrdnje: ako `citedArticle` ne čita jedan od oblika, ceo fajl
  // bi „prošao" tako što bi svuda vratio `null` — tj. lažno bi tvrdio saglasnost.
  it.each([
    ["PDV-RS-24-1-2", "24-1-2"],
    ["PDV-RS-24-1-5", "24-1-5"],
    ["Izvoz dobara (čl. 24 st. 1 tač. 2 ZPDV)", "24-1-2"],
    [
      "Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
      "24-1-2",
    ],
    [
      "Oslobođeno PDV-a na osnovu člana 24 stav 1 tačka 5 o PDV-u",
      "24-1-5",
    ],
    ["PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u", "12-3"],
    ["član 10. stav 2. tačka 1. Zakona o PDV-u", "10-2-1"],
  ])("citat iz teksta [%s] je %s", (text, expected) => {
    expect(citedArticle(text)).toBe(expected);
  });

  it("tekst bez člana ne izmišlja citat", () => {
    expect(citedArticle(NEMA_TEXT)).toBeNull();
    expect(citedArticle(null)).toBeNull();
  });
});

describe("🔴 SAGLASNOST PAPIRA I E-FAKTURE — isti dokument, isti osnov", () => {
  /**
   * 🔴 OVO JE TEST KOJI PADA NA ZATEČENOM KODU. `exemptionFor("export-goods")` je vraćao
   * `paperText` sa čl. 24 st. 1 **tač. 2** i `sefCode`/`sefReason` sa **tač. 5**.
   * Knjigovođa je presudio da je tačka 2 tačna (odgovor 8), pa je ispravljena šifra.
   */
  it.each([
    "domestic-exempt",
    "export-goods",
    "export-service",
    "domestic-reverse-charge",
    "outside-scope-service",
  ] as ExemptionCase[])(
    "izveden osnov [%s] — papir, razlog i šifra citiraju ISTI član",
    (kind) => {
      const basis = exemptionFor(kind);
      expect(basis).not.toBeNull();

      const paper = citedArticle(basis!.paperText);
      const reason = citedArticle(basis!.sefReason);
      const code = citedArticle(basis!.sefCode);

      // Papir i razlog za SEF ne smeju da PROTIVREČE (grublji citat je dopušten) —
      // inače kupac dobija dve različite pravne tvrdnje za jedan posao.
      expect(citationsContradict(paper, reason)).toBe(false);
      // Šifra (BT-121) je MAŠINSKI oblik istog citata i nju SEF čita kao merodavnu, pa
      // za nju grublje nije dovoljno: kad postoji, mora se poklopiti sa papirom u dlaku.
      // 🔴 OVDE JE PADAO ZATEČENI KOD: `export-goods` papir 24-1-2 vs šifra 24-1-5.
      if (code !== null) expect(code).toBe(paper);
    },
  );

  it("izvoz dobara je čl. 24 st. 1 t. 2 na SVA TRI mesta (bio 2 na papiru, 5 na SEF-u)", () => {
    const basis = exemptionFor("export-goods");
    expect(citedArticle(basis!.paperText)).toBe("24-1-2");
    expect(citedArticle(basis!.sefReason)).toBe("24-1-2");
    expect(basis!.sefCode).toBe("PDV-RS-24-1-2");
  });

  it.each(SEED.map((r) => [r.code, r] as const))(
    "red šifarnika [%s] — papir, razlog i šifra citiraju ISTI član",
    (_code, row) => {
      const paper = citedArticle(row.paperText);
      const reason = citedArticle(row.sefReason);
      const code = citedArticle(row.sefCode);

      // Redovi šifarnika su potvrđeni odgovorima, pa se od njih traži PUNA saglasnost:
      // knjigovođa je za njih dao i član i stav i tačku.
      expect(paper).not.toBeNull();
      expect(reason).toBe(paper);
      if (code !== null) expect(code).toBe(paper);
    },
  );

  /**
   * KRAJ DO KRAJA: isti dokument prolazi kroz OBA puta — kroz `resolveExemption` (papir) i
   * kroz `UblBuilderService.build` (XML) — i iz oba se izvuče citirani član.
   *
   * Do 05.08.2026. bi ovaj test pao na SVAKOJ izvoznoj fakturi: XML je nosio
   * `PDV-RS-24-1-5`, a papir čl. 24 st. 1 t. 2.
   */
  it.each([
    ["bez izabranog osnova (izvedeno)", null],
    [
      "sa izabranim osnovom — slobodna zona",
      bySeedCode(VAT_EXEMPTION_BASIS_CODES.FREE_ZONE),
    ],
    [
      "sa izabranim osnovom — oplemenjivanje",
      bySeedCode(VAT_EXEMPTION_BASIS_CODES.INWARD_PROCESSING),
    ],
  ])(
    "izvozna faktura %s: član na papiru = član u UBL-u",
    (_naziv, basis: VatExemptionBasisRef | null) => {
      const paperText = resolveExemption({
        basis,
        fallbackCase: exemptionCaseFor({
          isExport: true,
          isService: false,
          vatTotalIsZero: true,
        }),
      }).paperText;

      const xml = buildExportXml(basis);

      const paperArticle = citedArticle(paperText);
      expect(paperArticle).not.toBeNull();

      // Iz XML-a se čita ŠIFRA (BT-121) i TEKST razloga (BT-120), oba nezavisno.
      const xmlCode = /<cbc:TaxExemptionReasonCode>([^<]+)</.exec(xml)?.[1];
      const xmlReason = /<cbc:TaxExemptionReason>([^<]+)</.exec(xml)?.[1];
      expect(xmlCode).toBeDefined();
      expect(citedArticle(xmlCode)).toBe(paperArticle);
      expect(citedArticle(xmlReason)).toBe(paperArticle);
    },
  );

  it("domaći oslobođen promet više ne ide na SEF bez šifre (BT-121 je bio prazan)", () => {
    const basis = bySeedCode(VAT_EXEMPTION_BASIS_CODES.DOMESTIC_EXEMPT);
    const resolved = resolveExemption({
      basis,
      fallbackCase: exemptionCaseFor({
        isExport: false,
        isService: false,
        vatTotalIsZero: true,
      }),
    });
    // Zatečeno stanje: `exemptionFor("domestic-exempt").sefCode === null`, a papir je
    // štampao „osnov se utvrđuje po dokumentu" — opis situacije umesto pravnog osnova.
    expect(resolved.sefCode).toBe("PDV-RS-24-1-5");
    expect(citedArticle(resolved.paperText)).toBe("24-1-5");
  });
});

describe("resolveExemption — redosled izvora", () => {
  const basis = bySeedCode(VAT_EXEMPTION_BASIS_CODES.FREE_ZONE);
  const fallbackCase: ExemptionCase = "export-goods";

  it("izabran osnov je jači od napomene vrste usluge i od izvođenja", () => {
    const r = resolveExemption({
      basis,
      serviceRevenueNote: "napomena vrste usluge",
      fallbackCase,
    });
    expect(r.source).toBe("basis");
    expect(r.paperText).toBe(basis.paperText);
    expect(r.sefCode).toBe("PDV-RS-24-1-5");
  });

  it("bez osnova važi napomena vrste usluge (samo za papir)", () => {
    const r = resolveExemption({
      serviceRevenueNote: "  napomena vrste usluge  ",
      fallbackCase: "outside-scope-service",
    });
    expect(r.source).toBe("service-revenue-type");
    expect(r.paperText).toBe("napomena vrste usluge");
    // Razlog za SEF ostaje IZVEDEN — napomena je tekst za kupca, ne BT-120.
    expect(r.sefReason).toBe(exemptionFor("outside-scope-service")!.sefReason);
  });

  it("prazna napomena vrste usluge se ne štampa kao prazan red", () => {
    const r = resolveExemption({
      serviceRevenueNote: "   ",
      fallbackCase,
    });
    expect(r.source).toBe("derived");
    expect(r.paperText).toBe(exemptionFor(fallbackCase)!.paperText);
  });

  it("bez ijednog izvora i bez oslobođenja papir ne ostaje prazan", () => {
    const r = resolveExemption({ fallbackCase: "domestic-taxed" });
    expect(r.source).toBe("none");
    expect(r.paperText).toBe(NEMA_TEXT);
    expect(r.sefCode).toBeNull();
  });
});

describe("basisAllowsSef — kapija po osnovu, ne po zastavici", () => {
  it("izvoz dobara (24.1.2) NE ide na SEF, slobodna zona (24.1.5) IDE", () => {
    // Odgovor 8, doslovno: „Za izvoz robe koristimo član 24.1.2. Takva faktura ne ide na
    // sef. Član 24.1.5 je vezan za robu koja se izdaje kod unosa dobara u slobodnu zonu.
    // Takva faktura se šalje na SEF…" — a OBA su `is_export = true`.
    expect(
      basisAllowsSef(bySeedCode(VAT_EXEMPTION_BASIS_CODES.EXPORT_GOODS)),
    ).toBe(false);
    expect(
      basisAllowsSef(bySeedCode(VAT_EXEMPTION_BASIS_CODES.FREE_ZONE)),
    ).toBe(true);
  });

  it("domaći oslobođen promet ide na SEF", () => {
    expect(
      basisAllowsSef(bySeedCode(VAT_EXEMPTION_BASIS_CODES.DOMESTIC_EXEMPT)),
    ).toBe(true);
  });

  it("bez izabranog osnova vraća null a ne true (nije izabrano nije dozvola)", () => {
    expect(basisAllowsSef(null)).toBeNull();
    expect(basisAllowsSef(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────── pomoćno

const d = (v: string | number) => new Prisma.Decimal(v);

/** Minimalna izvozna robna faktura (IZVRO) — jedna stavka, PDV nula. */
function buildExportXml(basis: VatExemptionBasisRef | null): string {
  const ubl = new UblBuilderService();
  return ubl.build({
    invoice: {
      documentType: "IZVRO",
      documentNumber: "12/26",
      documentDate: new Date("2026-08-05T00:00:00Z"),
      currency: "EUR",
      isExport: true,
      vatExemptionBasis: basis,
      netTotal: d(1000),
      vatTotal: d(0),
      grossTotal: d(1000),
      supplyDate: new Date("2026-08-05T00:00:00Z"),
    },
    items: [
      {
        lineNo: 1,
        description: "Sklop",
        unit: "Kom",
        quantity: d(1),
        unitPrice: d(1000),
        discountPercent: d(0),
        vatRateCode: "1",
        vatBase: d(1000),
        vatAmount: d(0),
        lineTotal: d(1000),
      },
    ],
    supplier: { name: "Servoteh d.o.o.", taxId: "100001111" },
    customer: { name: "Ino kupac GmbH" },
  });
}
