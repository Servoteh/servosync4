import { Injectable } from "@nestjs/common";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

/**
 * pdfmake 0.3 server-side render (MODULE_SPEC_stampa §7). pdfmake 0.3 izvozi
 * singleton (`module.exports = new pdfmake()`); `@types/pdfmake` opisuje stariji
 * browser API, pa runtime uvozimo kroz lokalni tip + `require`.
 *
 * Fontovi: Roboto (pokriva srpski Latin Extended-A: čćšžđ) učitan iz pdfmake vfs-a
 * u in-memory `virtualfs` (bez fajlova na disku). Eksterni URL resursi su zabranjeni
 * (`setUrlAccessPolicy(() => false)`).
 */
interface PdfMake03 {
  virtualfs: {
    writeFileSync(name: string, content: string, encoding?: string): void;
  };
  setFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(cb: (url: string) => boolean): void;
  createPdf(dd: TDocumentDefinitions, options?: unknown): { getBuffer(): Promise<Buffer> };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const pdfmake = require("pdfmake") as PdfMake03;
const robotoVfs = require("pdfmake/build/vfs_fonts.js") as Record<string, string>;
/* eslint-enable @typescript-eslint/no-require-imports */

@Injectable()
export class PdfService {
  private ready = false;

  constructor() {
    this.ensureFonts();
  }

  /** Registruje Roboto (iz vfs base64) i zabranjuje eksterne URL resurse. Idempotentno. */
  private ensureFonts(): void {
    if (this.ready) return;
    for (const [name, b64] of Object.entries(robotoVfs)) {
      pdfmake.virtualfs.writeFileSync(name, b64, "base64");
    }
    pdfmake.setFonts({
      Roboto: {
        normal: "Roboto-Regular.ttf",
        bold: "Roboto-Medium.ttf",
        italics: "Roboto-Italic.ttf",
        bolditalics: "Roboto-MediumItalic.ttf",
      },
    });
    // Bez učitavanja eksternih resursa (SSRF zaštita) — sav sadržaj je inline.
    pdfmake.setUrlAccessPolicy(() => false);
    this.ready = true;
  }

  /** Renderuje pdfmake definiciju dokumenta u PDF `Buffer`. */
  async render(docDefinition: TDocumentDefinitions): Promise<Buffer> {
    this.ensureFonts();
    const pdf = pdfmake.createPdf(docDefinition);
    return pdf.getBuffer();
  }
}
