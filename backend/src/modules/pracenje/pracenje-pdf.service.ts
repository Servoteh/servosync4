import { Injectable, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { PdmService } from "../pdm/pdm.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Praćenje-scoped stream stored drawing PDF-a (RN side-panel, docx #12).
 *
 * Zašto zaseban servis a ne PDM ruta: `GET /pdm/drawings/:id/pdf/content` je pod
 * `PDM_READ`, a odluka O7 (PLAN_PRACENJE_PROIZVODNJE_2026-07 §6) kaže da SVI
 * prijavljeni u praćenju vide PDF crteža — pogon ima `pracenje.read` ali NE
 * `PDM_READ` / `can_read_production_drawings`, pa bi na PDM ruti dobio 403. Zato
 * praćenje ima sopstvenu rutu (kontroler gejtuje samo `pracenje.read`), a ovaj
 * servis nosi čitanje/strim.
 *
 * Sadržaj se čita iz istih 2.0 tabela (`drawings`/`drawing_pdfs`) preko
 * `PdmService.getPdfContent` — jedan put čitanja, bez dupliranja bytea logike;
 * 404 (crtež ne postoji ili nema uskladišten PDF) se prosleđuje iz PDM servisa.
 */
@Injectable()
export class PracenjePdfService {
  constructor(
    private readonly pdm: PdmService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Strimuje uskladišten PDF crteža za praćenje (uvek `inline` — prikaz u
   * browser tab-u kroz `window.open`, bez `download` varijante). Postavlja
   * `Content-Type: application/pdf` + `Content-Disposition: inline` sa ASCII
   * fallback + RFC 5987 `filename*` (dijakritici u imenu → Node setHeader inače
   * baca ERR_INVALID_CHAR/500). Vraća `StreamableFile` koji kontroler prosleđuje.
   *
   * SEC-02: best-effort audit pristupa (ko, kada, koji crtež). O7 svesno širi
   * pristup (IP izložen i prihvaćen) → trag pristupa je mitigacija, isti obrazac
   * kao PDM/tech-processes rute (`metadata.route = 'pracenje'`). Pad audita NE
   * sme da obori strim.
   */
  async streamDrawingPdf(
    id: number,
    res: Response,
    user: { userId: number; email: string } | undefined,
  ): Promise<StreamableFile> {
    void this.prisma.auditLog
      .create({
        data: {
          action: "DRAWING-PDF-ACCESS",
          entityType: "drawing",
          entityId: String(id),
          actorUserId: user?.userId ?? null,
          actorUsername: user?.email ?? null,
          metadata: { route: "pracenje", download: false },
        },
      })
      .catch(() => {});

    const { buffer, fileName } = await this.pdm.getPdfContent(id);
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "crtez.pdf";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    });
    return new StreamableFile(buffer);
  }
}
