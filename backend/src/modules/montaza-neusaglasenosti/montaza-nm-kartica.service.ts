import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { sanitizeDrawingNo } from "../../common/drawings";
import { parseBarcode } from "../tech-processes/barcode";

/**
 * Skeniranje kartice koja prati deo do montaže (zahtev 034/26) + razrešavanje crteža
 * prijave.
 *
 * FORMAT BARKODA SE NE IZMIŠLJA: kartica nosi isti Code128 koji pogon štampa na
 * nalepnici — `RNZ:0:{identNumber}:0:0` (`formatLabelBarcode`), dok A4 papir RN-a nosi
 * pun oblik `RNZ:{projectId}:{ident}:{variant}:{revision}` (`formatOrderBarcode`).
 * Oba se parsiraju POSTOJEĆIM `parseBarcode` iz tech-processes (čista funkcija, bez DI i
 * bez baze) — tako keyboard-wedge tolerancija (SR raspored tastature, ';'→':') i pravilo
 * „tačno 4 separatora" ostaju na JEDNOM mestu. Modul time ne dobija spregu sa
 * TechProcesses servisom, samo sa util fajlom.
 *
 * ZAMKA (ident ≠ interni id): `identNumber` je poslovni broj RN-a i NIJE jedinstven —
 * isti ident može postojati u više predmeta. Zato lookup vraća `matchCount` i, kad je
 * višeznačno, popunjava samo polja koja su ista kod svih kandidata.
 *
 * ZAMKA (dva id-prostora predmeta): `projectNumber` se vraća kao TEKST i namerno se NE
 * vraća nikakav `projectId` — predmet u prijavi bira montaža picker (`montaza/lookups/predmeti`),
 * čiji id dolazi iz drugog izvora nego `work_orders.project_id`. Mešanje ta dva id-a bi
 * upisalo tuđi ref.
 */
@Injectable()
export class MontazaNmKarticaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /montaza/neusaglasenosti/lookup/kartica?code=…` — razreši skeniranu karticu u
   * polja prijave. 400 za neispravan barkod (poruka iz `parseBarcode` prikazuje očitano),
   * 422 za barkod operacije, 404 kad ident ne postoji.
   */
  async lookupKartica(rawCode: string) {
    const decoded = parseBarcode(rawCode ?? "");
    if (decoded.type !== "nalog")
      throw new UnprocessableEntityException(
        "Skeniran je barkod OPERACIJE (S:…). Na kartici dela je barkod naloga (RNZ:…).",
      );

    const identNumber = decoded.fields.identNumber.trim();
    if (!identNumber)
      throw new UnprocessableEntityException(
        "Barkod nema ident broj naloga — skenirajte karticu dela ponovo.",
      );

    // Kratka nalepnica nosi projectId=0 i variant=0 (ne staje pun oblik na 80mm) —
    // po varijanti se NE filtrira, a po predmetu samo kad ga barkod stvarno nosi.
    const scannedProjectId = decoded.fields.projectId;
    const rows = await this.prisma.workOrder.findMany({
      where: {
        identNumber,
        ...(scannedProjectId > 0 ? { projectId: scannedProjectId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        identNumber: true,
        drawingNumber: true,
        partName: true,
        projectId: true,
      },
      take: 50,
    });

    if (!rows.length)
      throw new NotFoundException(
        `Radni nalog za ident ${identNumber} nije pronađen. Unesite podatke ručno.`,
      );

    // Kad ident „udara" u više naloga, vraćamo samo ono u čemu su SVI saglasni —
    // bolje prazno polje nego pogrešan crtež u prijavi neusaglašenosti.
    const drawingNumber = uniformValue(rows.map((r) => r.drawingNumber));
    const partName = uniformValue(rows.map((r) => r.partName));
    const projectId = uniformValue(rows.map((r) => String(r.projectId)));

    let projectNumber: string | null = null;
    if (projectId && Number(projectId) > 0) {
      const project = await this.prisma.project.findUnique({
        where: { id: Number(projectId) },
        select: { projectNumber: true },
      });
      projectNumber = project?.projectNumber?.trim() || null;
    }

    return {
      data: {
        identNumber,
        /** Ide u polje „Radni nalog (RN)" prijave. */
        workOrderCode: identNumber,
        drawingNumber: drawingNumber ? sanitizeDrawingNo(drawingNumber) : null,
        partName,
        projectNumber,
        matchCount: rows.length,
      },
    };
  }

  /**
   * Crtež prijave: `drawing_number` (tekst) → `drawings.id` + da li PDF uopšte postoji.
   * ISTA logika kao praćenje `crtezSignUrl` (sanitizacija → tačan broj → bazni broj pre
   * „_" → najnovija revizija), samo unutar montaža modula da bi gate ostao
   * `montaza.neusaglasenosti.read` (praćenje traži `pracenje.read`, koji ceo montaža
   * krug nema — isti razlog zbog kog kiosk ima svoju PDF rutu pod TEHNOLOGIJA_READ).
   */
  async resolveDrawing(
    drawingNumber: string | null | undefined,
  ): Promise<{ id: number; revision: string; hasPdf: boolean } | null> {
    const clean = sanitizeDrawingNo(drawingNumber ?? "");
    if (!clean) return null;
    const base = clean.split("_")[0].trim() || clean;

    const drawing = await this.prisma.drawing.findFirst({
      where: { OR: [{ drawingNumber: clean }, { drawingNumber: base }] },
      orderBy: [{ drawingNumber: "desc" }, { revision: "desc" }],
      select: { id: true, drawingNumber: true, revision: true },
    });
    if (!drawing) return null;

    // Postojanje PDF-a bez učitavanja bajtova (obrazac `resolveCardDrawing`).
    const pdf = await this.prisma.drawingPdf.findFirst({
      where: {
        drawingNumber: drawing.drawingNumber,
        revision: drawing.revision,
        pdfBinary: { not: null },
      },
      select: { drawingNumber: true },
    });

    return { id: drawing.id, revision: drawing.revision, hasPdf: !!pdf };
  }
}

/** Vrednost kad su SVI kandidati saglasni (i neprazni); inače null. */
function uniformValue(values: (string | null)[]): string | null {
  const cleaned = values.map((v) => (v ?? "").trim()).filter(Boolean);
  if (!cleaned.length) return null;
  const first = cleaned[0];
  if (cleaned.length !== values.length) return null;
  return cleaned.every((v) => v === first) ? first : null;
}
