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
   *
   * bwip-js NE upisuje `width`/`height` na koren, samo `viewBox` (npr. `0 0 576 63`),
   * pa je unutrašnji odnos stranica određen brojem modula — dakle DUŽINOM sadržaja.
   * Zbog toga `opts.height` NE određuje odštampanu visinu: kad pdfmake skalira SVG na
   * zadatu širinu uz očuvanje odnosa stranica, duži sadržaj daje niži barkod.
   *
   * @param value tekst barkoda (npr. `RNZ:2597:06/93-4:0:A`)
   * @param opts.height visina modula u bwip-js jedinicama (default 9) — utiče SAMO na
   *   unutrašnji `viewBox`, ne na odštampanu visinu kad se koristi `stretch`
   * @param opts.stretch upisuje `preserveAspectRatio="none"` na koren SVG-a, čime
   *   renderer razvlači simbol na TAČNO onaj okvir koji pdfmake node zada
   *   (`width` + `height`), umesto da ga uklapa uz očuvanje odnosa stranica.
   *
   *   Zašto je to bezbedno za skener: Code 128 se čita isključivo iz ODNOSA širina
   *   crta i praznina. Razvlačenje je afino i po x osi UNIFORMNO — svaka crta se množi
   *   istim faktorom `sx = širina_okvira / viewBox_širina` — pa odnosi ostaju netaknuti.
   *   Po y osi crte samo postaju više/niže, što simbologija ne čita. Isto je radio i
   *   legacy QBigTehn: ActiveBarcode kontrola sa `SizeMode = 1` (stretch na okvir).
   *
   *   Napomena: sa `fit` placementom `preserveAspectRatio="none"` je no-op, jer `fit`
   *   već daje okvir sa istim odnosom stranica (sx === sy).
   */
  code128Svg(
    value: string,
    opts?: { height?: number; stretch?: boolean },
  ): string {
    const text = String(value ?? "").trim();
    if (!text)
      throw new Error("BarcodeService.code128Svg: prazna vrednost barkoda.");
    const svg = toSVG({
      bcid: "code128",
      text,
      height: opts?.height ?? 9,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0,
    });
    return opts?.stretch ? withoutAspectRatio(svg) : svg;
  }
}

/**
 * Dodaje `preserveAspectRatio="none"` na `<svg>` koren (idempotentno). Radi nad
 * korenskim tagom, ne nad celim dokumentom, da ne dira `<path>` elemente.
 */
function withoutAspectRatio(svg: string): string {
  if (/<svg\b[^>]*\bpreserveAspectRatio=/.test(svg)) return svg;
  return svg.replace(/<svg\b/, '<svg preserveAspectRatio="none"');
}
