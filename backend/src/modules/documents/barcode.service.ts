import { Injectable } from "@nestjs/common";
import { toSVG } from "bwip-js";

/**
 * Generisanje barkoda za štampu (MODULE_SPEC_stampa §3, §7). Simbologija **Code 128**
 * — isto kao legacy QBigTehn (ActiveBarcode) i ServoSync 1.0 (jsbarcode). Server-side
 * preko `bwip-js` (pure JS, bez browsera/native kompajla). Vraća SVG (vektor) koji
 * pdfmake embeduje kao `svg` node.
 */
@Injectable()
export class BarcodeService {
  /**
   * Code 128 barkod kao SVG string.
   * @param value tekst barkoda (npr. `RNZ:2597:06/93-4:0:A`)
   * @param opts.height visina modula u mm-ekvivalentu bwip-js jedinica (default 9)
   */
  code128Svg(value: string, opts?: { height?: number }): string {
    const text = String(value ?? "").trim();
    if (!text)
      throw new Error("BarcodeService.code128Svg: prazna vrednost barkoda.");
    return toSVG({
      bcid: "code128",
      text,
      height: opts?.height ?? 9,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
    });
  }

  /**
   * QR kod kao SVG string — memorandum izlazne fakture („google mapa" u podnožju,
   * STAMPA_IZLAZNIH_FAKTURA.md §1).
   *
   * Ide kroz isti `bwip-js` kao Code 128: nova zavisnost za QR nije potrebna, a i ne
   * bi bila poželjna — pdfmake ionako ne sme na mrežu (`setUrlAccessPolicy(() => false)`),
   * pa sve mora da se napravi lokalno. SVG (vektor) je bolji izbor od bitmape jer QR
   * u podnožju ide na ~34 pt i mora ostati čitljiv i posle štampe na papir.
   *
   * @param value sadržaj koda (URL)
   * @param opts.eclevel nivo ispravke grešaka; `M` je i original sa BigBit obrasca
   */
  qrcodeSvg(value: string, opts?: { eclevel?: "L" | "M" | "Q" | "H" }): string {
    const text = String(value ?? "").trim();
    if (!text)
      throw new Error("BarcodeService.qrcodeSvg: prazna vrednost QR koda.");
    return toSVG({
      bcid: "qrcode",
      text,
      paddingwidth: 0,
      paddingheight: 0,
      // `eclevel` je BWIPP opcija same simbologije; `@types/bwip-js` je mašinski
      // generisan i opisuje samo opcije zajedničke svim kodovima, pa ga ne poznaje.
      // Radi u pogonu (bwip-js prosleđuje nepoznate ključeve BWIPP-u) — otud cast.
      ...({ eclevel: opts?.eclevel ?? "M" } as Record<string, string>),
    });
  }
}
