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
    if (!text) throw new Error("BarcodeService.code128Svg: prazna vrednost barkoda.");
    return toSVG({
      bcid: "code128",
      text,
      height: opts?.height ?? 9,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
    });
  }
}
