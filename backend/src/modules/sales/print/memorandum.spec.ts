import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { BarcodeService } from "../../documents/barcode.service";
import { PdfService } from "../../documents/pdf.service";
import {
  MEMORANDUM_MAP_QR_URL,
  MEMORANDUM_STYLES,
  memorandumFooter,
  memorandumHeader,
  type MemorandumIssuer,
} from "./memorandum";

/**
 * Podaci firme prepisani sa donetih papira (STAMPA_IZLAZNIH_FAKTURA.md §1) — ovde stoje
 * kao TEST-VEKTOR, ne kao konfiguracija: u pogonu memorandum čita `companies`.
 */
const SERVOTEH: MemorandumIssuer = {
  companyName: "Servoteh d.o.o. Dobanovci",
  address: "Ugrinovačka 163",
  city: "11272 Dobanovci",
  phone: "+381 11 31 41 564; 373 29 59",
  fax: "+381 11 2399 265",
  email: "office@servoteh.rs",
  webAddress: "www.servoteh.rs",
  taxId: "101017443",
  registrationNumber: "17400169",
  registryNumber: "01117400169",
  businessActivityCode: "3320",
  aprText:
    '"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006',
};

/** Skuplja sav `text` iz pdfmake stabla, da se tvrdnje pišu nad ravnim spiskom. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    for (const key of ["stack", "columns", "table", "body"]) {
      if (o[key] != null) collectText(o[key], out);
    }
  }
  return out;
}

/** Skuplja sve `image` data URL-ove iz pdfmake stabla. */
function collectImages(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectImages(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.image === "string") out.push(o.image);
    for (const key of ["stack", "columns"]) {
      if (o[key] != null) collectImages(o[key], out);
    }
  }
  return out;
}

describe("memorandum izlazne fakture", () => {
  describe("zaglavlje strane", () => {
    it("piše red firme doslovno sa papira, uključujući `web::` sa dve dvotačke", () => {
      const texts = collectText(memorandumHeader(SERVOTEH));
      const joined = texts.join("\n");
      expect(joined).toContain("Servoteh d.o.o. Dobanovci");
      expect(joined).toContain("Ugrinovačka 163, 11272 Dobanovci");
      expect(joined).toContain("tel: +381 11 31 41 564; 373 29 59;");
      expect(joined).toContain("fax: +381 11 2399 265;");
      expect(joined).toContain("e-mail: office@servoteh.rs");
      // Original ima DVE dvotačke — dok vlasnik ne presudi drugačije, prepisuje se.
      expect(joined).toContain("web:: www.servoteh.rs");
      expect(joined).not.toContain("web: www.servoteh.rs");
    });

    it("ne udvaja tačku-zarez kad je već u bazi", () => {
      const joined = collectText(
        memorandumHeader({
          ...SERVOTEH,
          phone: "011/123-456;",
          fax: "011/123-457;",
        }),
      ).join("\n");
      expect(joined).toContain("tel: 011/123-456;");
      expect(joined).not.toContain(";;");
    });

    it("nosi logo SERVOTEH i TÜV/ISO znak", () => {
      const images = collectImages(memorandumHeader(SERVOTEH));
      expect(images).toHaveLength(2);
      for (const img of images)
        expect(img.startsWith("data:image/")).toBe(true);
    });

    it("izostavlja segment kad polje firme nije popunjeno, bez prazne labele", () => {
      const joined = collectText(
        memorandumHeader({
          companyName: "Firma d.o.o.",
          fax: null,
          webAddress: null,
        }),
      ).join("\n");
      expect(joined).toContain("Firma d.o.o.");
      expect(joined).not.toContain("fax:");
      expect(joined).not.toContain("web::");
    });
  });

  describe("podnožje strane", () => {
    const qrSvg = new BarcodeService().qrcodeSvg(MEMORANDUM_MAP_QR_URL);

    it("nosi registarski red i APR rečenicu sa papira", () => {
      const joined = collectText(memorandumFooter(SERVOTEH, { qrSvg })).join(
        "\n",
      );
      expect(joined).toContain("Matični broj: 17400169");
      expect(joined).toContain("Registarski broj: 01117400169");
      expect(joined).toContain("Šifra delatnosti: 3320");
      expect(joined).toContain("PIB: 101017443");
      expect(joined).toContain(
        "upisano u Agenciji za privredne registre pod brojem BD. 222785/2006",
      );
    });

    it("nosi partnersku traku i natpis „google mapa“ uz QR", () => {
      const content = memorandumFooter(SERVOTEH, { qrSvg });
      expect(collectImages(content)).toHaveLength(1);
      expect(collectText(content).join("\n")).toContain("google mapa");
    });

    it("bez QR-a ostaje ispravno — samo bez bloka mape", () => {
      const joined = collectText(memorandumFooter(SERVOTEH)).join("\n");
      expect(joined).toContain("Matični broj: 17400169");
      expect(joined).not.toContain("google mapa");
    });

    it("„Strana X od Y“ se prikazuje samo kad se prosledi (traži ga ino usluga)", () => {
      expect(
        collectText(memorandumFooter(SERVOTEH, { qrSvg })).join("\n"),
      ).not.toContain("Strana");
      expect(
        collectText(
          memorandumFooter(SERVOTEH, { qrSvg, pageText: "Strana 1 od 3" }),
        ).join("\n"),
      ).toContain("Strana 1 od 3");
    });

    it("ne prepisuje vodeni žig `www.BigBit.rs` sa tuđeg obrasca", () => {
      const joined = collectText(memorandumFooter(SERVOTEH, { qrSvg })).join(
        "\n",
      );
      expect(joined.toLowerCase()).not.toContain("bigbit");
    });
  });

  describe("QR kod", () => {
    it("BarcodeService pravi SVG bez nove zavisnosti", () => {
      const svg = new BarcodeService().qrcodeSvg(MEMORANDUM_MAP_QR_URL);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("</svg>");
    });

    it("odbija prazan sadržaj umesto da odštampa prazan kvadrat", () => {
      expect(() => new BarcodeService().qrcodeSvg("  ")).toThrow(
        /prazna vrednost/i,
      );
    });
  });

  /**
   * Prava provera koraka 1: memorandum mora da PROĐE kroz pdfmake. Slike su data URL-ovi,
   * a `setUrlAccessPolicy(() => false)` zabranjuje mrežu — ako bi neki asset bio spoljni
   * ili neispravno kodiran, render bi pukao baš ovde.
   */
  it("renderuje se kroz pdfmake u ispravan PDF (assets i QR embeduju se inline)", async () => {
    const qrSvg = new BarcodeService().qrcodeSvg(MEMORANDUM_MAP_QR_URL);
    const dd: TDocumentDefinitions = {
      pageSize: "A4",
      pageMargins: [32, 110, 32, 90],
      header: () => memorandumHeader(SERVOTEH),
      footer: (currentPage: number, pageCount: number) =>
        memorandumFooter(SERVOTEH, {
          qrSvg,
          pageText: `Strana ${currentPage} od ${pageCount}`,
        }),
      content: [{ text: "Proba memoranduma" }],
      styles: { ...MEMORANDUM_STYLES },
      defaultStyle: { font: "Roboto", fontSize: 9 },
    };
    const buffer = await new PdfService().render(dd);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30000);
});
