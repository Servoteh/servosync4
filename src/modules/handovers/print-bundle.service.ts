import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { PrismaService } from "../../prisma/prisma.service";
import { byId, uniqueIds } from "../../common/relations";

/**
 * ISO A formati u mm (portret: kraća × duža strana). Redosled = redosled
 * poklapanja i grupa u odgovoru (veliki formati / ploter prvo — legacy paritet:
 * EPSON SC-T2100 za A0–A2, HP LaserJet za A4; izbor štampača je na browseru).
 */
const ISO_A_FORMATS = [
  { name: "A0", shortMm: 841, longMm: 1189 },
  { name: "A1", shortMm: 594, longMm: 841 },
  { name: "A2", shortMm: 420, longMm: 594 },
  { name: "A3", shortMm: 297, longMm: 420 },
  { name: "A4", shortMm: 210, longMm: 297 },
] as const;

export type IsoAFormat = (typeof ISO_A_FORMATS)[number]["name"];
export type PageFormat = IsoAFormat | "custom";

const PAGE_FORMATS: PageFormat[] = [
  ...ISO_A_FORMATS.map((f) => f.name),
  "custom",
];

/** PDF point → mm (1 pt = 1/72 inča). */
const PT_TO_MM = 25.4 / 72;
/** Tolerancija poklapanja sa ISO A dimenzijama (±mm) — realni crteži odstupaju. */
const FORMAT_TOLERANCE_MM = 6;
/**
 * Upper bound for the sum of source PDF sizes in one merge (KB). pdf-lib keeps
 * the whole merged document (plus the serialized buffer) in heap, so an
 * unbounded merge can take the Node process down; checked from sizeKb metadata
 * before any blob is loaded.
 */
const MERGE_MAX_TOTAL_KB = 200 * 1024;

export interface PrintBundleItem {
  drawingId: number;
  /** null kad `drawingId` ne postoji u `drawings` (nema DB FK-a — batch-resolve). */
  drawingNumber: string | null;
  revision: string | null;
  name: string | null;
  /** `handover_draft_items.exclude_from_handover` — stavka se NE štampa. */
  excluded: boolean;
  hasPdf: boolean;
  /** `octet_length(pdf_binary)` u KB (raw SQL, blob se NE učitava); null bez PDF-a. */
  sizeKb: number | null;
  /** Detektovan format prve strane; 'custom' i za nečitljiv PDF; null bez PDF-a ili za isključenu stavku. */
  pageFormat: PageFormat | null;
}

export interface PrintBundleGroup {
  format: PageFormat;
  count: number;
  drawingIds: number[];
}

export interface PrintBundleQuery {
  /** Jedan od 'A0'|'A1'|'A2'|'A3'|'A4'|'custom' — štampaj samo taj format. */
  format?: string;
  /** CSV lista drawingId-jeva (npr. "1,2,3") — štampaj samo izabrane. */
  drawingIds?: string;
}

/** Bezbedan token za `Content-Disposition` filename (draftNumber je `G-yymmdd-nnn`, ali defanzivno). */
function sanitizeFileToken(value: string): string {
  return value.replace(/[^\w.-]+/g, "_") || "bundle";
}

/**
 * Print bundle (P3) — štampa svih crteža nacrta/primopredaje odjednom.
 *
 * Zajednički helper za OBA nivoa: nacrt (`handover_drafts` → sve ne-isključene
 * stavke, dedup po crtežu) i primopredaja (`drawing_handovers` → taj JEDAN
 * crtež). PDF izvori su blobovi u `drawing_pdfs` (ključ drawing_number +
 * revision — isto kao pdm.service.ts `getPdfContent`).
 *
 * Memorija: metapodaci (hasPdf/sizeKb) idu kroz raw SQL sa `octet_length` BEZ
 * učitavanja bloba; blobovi se za detekciju formata i spajanje učitavaju
 * SEKVENCIJALNO, jedan po jedan, i referenca se pušta odmah posle obrade
 * (bundle je realno do ~40 stavki).
 */
@Injectable()
export class PrintBundleService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ NACRT NIVO

  /** `GET /handover-drafts/:id/print-bundle` — pregled crteža za štampu + grupe po formatu. */
  async draftBundle(draftId: number) {
    const { items } = await this.loadDraftContext(draftId);
    await this.probeFormats(items);
    return { data: this.summarize(items) };
  }

  /** `GET /handover-drafts/:id/print-bundle/pdf` — JEDAN spojen PDF (svi / ?format= / ?drawingIds=). */
  async draftBundlePdf(
    draftId: number,
    query: PrintBundleQuery,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { draft, items } = await this.loadDraftContext(draftId);
    return this.mergeSelection(
      items,
      query,
      `nacrt-${sanitizeFileToken(draft.draftNumber)}`,
    );
  }

  // ---------------------------------------------------- PRIMOPREDAJA NIVO

  /** `GET /handovers/:id/print-bundle` — bundle od JEDNOG crteža te primopredaje (isti oblik odgovora). */
  async handoverBundle(handoverId: number) {
    const { items } = await this.loadHandoverContext(handoverId);
    await this.probeFormats(items);
    return { data: this.summarize(items) };
  }

  /** `GET /handovers/:id/print-bundle/pdf` — PDF crteža te primopredaje (per-RN štampa). */
  async handoverBundlePdf(
    handoverId: number,
    query: PrintBundleQuery,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { handover, items } = await this.loadHandoverContext(handoverId);
    return this.mergeSelection(items, query, `primopredaja-${handover.id}`);
  }

  // ----------------------------------------------------------- učitavanje

  /**
   * Stavke nacrta za štampu: SVE stavke (isključene ostaju u listi sa
   * `excluded: true` da ih UI prikaže), dedup po crtežu — isti crtež u više
   * stavki je jedan u bundle-u; ako je bar jedna pojava ne-isključena, crtež
   * se štampa. Redosled = prva pojava (id asc) — isti redosled važi u PDF-u.
   */
  private async loadDraftContext(draftId: number) {
    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id: draftId },
      select: { id: true, draftNumber: true },
    });
    if (!draft) throw new NotFoundException(`Nacrt ${draftId} ne postoji.`);

    const rows = await this.prisma.handoverDraftItem.findMany({
      where: { draftId },
      select: { id: true, drawingId: true, excludeFromHandover: true },
      orderBy: { id: "asc" },
    });

    const byDrawing = new Map<
      number,
      { drawingId: number; excluded: boolean }
    >();
    for (const r of rows) {
      const existing = byDrawing.get(r.drawingId);
      if (!existing)
        byDrawing.set(r.drawingId, {
          drawingId: r.drawingId,
          excluded: r.excludeFromHandover,
        });
      else if (existing.excluded && !r.excludeFromHandover)
        existing.excluded = false;
    }

    const items = await this.buildEntries([...byDrawing.values()]);
    return { draft, items };
  }

  /** Primopredaja je PO JEDNOM crtežu → bundle od jedne (nikad isključene) stavke. */
  private async loadHandoverContext(handoverId: number) {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id: handoverId },
      select: { id: true, drawingId: true },
    });
    if (!handover)
      throw new NotFoundException(`Primopredaja ${handoverId} ne postoji.`);

    const items = await this.buildEntries([
      { drawingId: handover.drawingId, excluded: false },
    ]);
    return { handover, items };
  }

  /** Batch-resolve crteža (drawingId bez DB FK-a — orphan → null polja) + PDF metapodaci. */
  private async buildEntries(
    refs: { drawingId: number; excluded: boolean }[],
  ): Promise<PrintBundleItem[]> {
    const ids = uniqueIds(refs.map((r) => r.drawingId));
    const drawings = ids.length
      ? byId(
          await this.prisma.drawing.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              drawingNumber: true,
              revision: true,
              name: true,
            },
          }),
        )
      : new Map<number, never>();
    const pdfMeta = await this.loadPdfMeta([...drawings.values()]);

    return refs.map((ref) => {
      const drawing = drawings.get(ref.drawingId) ?? null;
      const meta = drawing
        ? pdfMeta.get(this.pdfKey(drawing.drawingNumber, drawing.revision))
        : undefined;
      const hasPdf = meta?.hasBinary ?? false;
      return {
        drawingId: ref.drawingId,
        drawingNumber: drawing?.drawingNumber ?? null,
        revision: drawing?.revision ?? null,
        name: drawing?.name ?? null,
        excluded: ref.excluded,
        hasPdf,
        sizeKb: hasPdf ? (meta?.sizeKb ?? null) : null,
        pageFormat: null, // popunjava probeFormats / detekcija pri spajanju
      };
    });
  }

  private pdfKey(drawingNumber: string, revision: string): string {
    return `${drawingNumber}\u0000${revision}`;
  }

  /**
   * PDF metapodaci iz `drawing_pdfs` — namerno raw SQL sa `octet_length` da se
   * `pdf_binary` (bytea, i po više MB) NIKAD ne učitava za spisak; isti razlog
   * kao `findPdfMeta` u pdm.service.ts.
   */
  private async loadPdfMeta(
    drawings: { drawingNumber: string; revision: string }[],
  ) {
    const map = new Map<
      string,
      { hasBinary: boolean; sizeKb: number | null }
    >();
    if (!drawings.length) return map;

    const pairs = Prisma.join(
      drawings.map((d) => Prisma.sql`(${d.drawingNumber}, ${d.revision})`),
    );
    const rows = await this.prisma.$queryRaw<
      {
        drawing_number: string;
        revision: string;
        has_binary: boolean;
        size_kb: number | null;
      }[]
    >`
      SELECT drawing_number, revision,
             (pdf_binary IS NOT NULL) AS has_binary,
             CEIL(octet_length(pdf_binary) / 1024.0)::int AS size_kb
      FROM drawing_pdfs
      WHERE (drawing_number, revision) IN (${pairs})
    `;
    for (const r of rows) {
      map.set(this.pdfKey(r.drawing_number, r.revision), {
        hasBinary: r.has_binary,
        sizeKb: r.size_kb,
      });
    }
    return map;
  }

  private async loadPdfBinary(
    drawingNumber: string,
    revision: string,
  ): Promise<Buffer | null> {
    const pdf = await this.prisma.drawingPdf.findUnique({
      where: { drawingNumber_revision: { drawingNumber, revision } },
      select: { pdfBinary: true },
    });
    return pdf?.pdfBinary ? Buffer.from(pdf.pdfBinary) : null;
  }

  // -------------------------------------------------------------- formati

  /**
   * Detekcija formata (prva strana, MediaBox + Rotate) za ne-isključene stavke
   * sa PDF-om. Blobovi SEKVENCIJALNO, jedan po jedan; isključene stavke se
   * preskaču (ne troši se memorija na crteže koji se ne štampaju).
   */
  private async probeFormats(items: PrintBundleItem[]) {
    for (const item of items) {
      if (item.excluded || !item.hasPdf) continue;
      if (item.drawingNumber === null || item.revision === null) continue;
      const bytes = await this.loadPdfBinary(item.drawingNumber, item.revision);
      if (!bytes) {
        // Metapodaci su rekli da blob postoji, a učitavanje kaže da ne — utrka
        // sa paralelnim brisanjem/izmenom; tretiraj kao "nema PDF-a".
        item.hasPdf = false;
        item.sizeKb = null;
        continue;
      }
      item.pageFormat = await this.detectPageFormat(bytes);
    }
  }

  /**
   * Format prve strane: MediaBox (`getSize`) + Rotate, u mm, orijentaciono-
   * agnostično (portret/pejzaž isto), tolerancija ±6mm po obe dimenzije.
   * Nevalidan/nečitljiv PDF → 'custom' (`hasPdf` ostaje true — sadržaj postoji,
   * samo se ne da klasifikovati).
   */
  private async detectPageFormat(bytes: Uint8Array): Promise<PageFormat> {
    try {
      const doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      if (doc.getPageCount() === 0) return "custom";
      return this.classifyFirstPage(doc);
    } catch {
      return "custom";
    }
  }

  private classifyFirstPage(doc: PDFDocument): PageFormat {
    const page = doc.getPage(0);
    const { width, height } = page.getSize();
    // Rotate 90/270 zamenjuje efektivne dimenzije — za orijentaciono-agnostično
    // poklapanje svejedno, ali MediaBox+Rotate je definisan ugovor detekcije.
    const rotated = page.getRotation().angle % 180 !== 0;
    const widthMm = (rotated ? height : width) * PT_TO_MM;
    const heightMm = (rotated ? width : height) * PT_TO_MM;
    const shortMm = Math.min(widthMm, heightMm);
    const longMm = Math.max(widthMm, heightMm);
    for (const f of ISO_A_FORMATS) {
      if (
        Math.abs(shortMm - f.shortMm) <= FORMAT_TOLERANCE_MM &&
        Math.abs(longMm - f.longMm) <= FORMAT_TOLERANCE_MM
      )
        return f.name;
    }
    return "custom";
  }

  // ------------------------------------------------------------- odgovori

  /** `{ items, groups, missingCount }` — grupe samo ne-isključene sa PDF-om, redom A0→A4→custom. */
  private summarize(items: PrintBundleItem[]) {
    const byFormat = new Map<PageFormat, number[]>();
    for (const item of items) {
      if (item.excluded || !item.hasPdf || !item.pageFormat) continue;
      const list = byFormat.get(item.pageFormat) ?? [];
      list.push(item.drawingId);
      byFormat.set(item.pageFormat, list);
    }
    const groups: PrintBundleGroup[] = [];
    for (const format of PAGE_FORMATS) {
      const drawingIds = byFormat.get(format);
      if (drawingIds?.length)
        groups.push({ format, count: drawingIds.length, drawingIds });
    }
    const missingCount = items.filter((i) => !i.excluded && !i.hasPdf).length;
    return { items, groups, missingCount };
  }

  // -------------------------------------------------------------- spajanje

  /** Express parses a duplicated query param into an array — reject with 422, not a TypeError/500. */
  private singleQueryParam(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string")
      throw new UnprocessableEntityException(
        `Parametar '${name}' sme biti naveden najviše jednom.`,
      );
    return value;
  }

  /** `?format=` XOR `?drawingIds=` (oba → 422); bez oba = svi crteži sa PDF-om. */
  private parseQuery(query: PrintBundleQuery): {
    format: PageFormat | null;
    requestedIds: number[] | null;
  } {
    const rawFormat = this.singleQueryParam(query.format, "format")?.trim();
    const rawIds = this.singleQueryParam(
      query.drawingIds,
      "drawingIds",
    )?.trim();
    if (rawFormat && rawIds !== undefined)
      throw new UnprocessableEntityException(
        "Navedite ili ?format ili ?drawingIds — ne oba.",
      );
    if (rawFormat && !PAGE_FORMATS.includes(rawFormat as PageFormat))
      throw new UnprocessableEntityException(
        `Nepoznat format '${rawFormat}' — dozvoljeno: ${PAGE_FORMATS.join(", ")}.`,
      );

    let requestedIds: number[] | null = null;
    if (rawIds !== undefined) {
      const parts = rawIds
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const ids = parts.map((p) => Number.parseInt(p, 10));
      if (!parts.length || ids.some((n) => Number.isNaN(n) || n <= 0))
        throw new UnprocessableEntityException(
          "drawingIds mora biti lista pozitivnih celih brojeva razdvojenih zarezom (npr. ?drawingIds=1,2,3).",
        );
      requestedIds = [...new Set(ids)];
    }
    return {
      format: rawFormat ? (rawFormat as PageFormat) : null,
      requestedIds,
    };
  }

  /**
   * JEDAN spojen PDF (pdf-lib `copyPages`), redosled kao u `items`. Spajanje je
   * sekvencijalno — u svakom trenutku je u memoriji najviše jedan izvorni blob
   * (+ rastući spojeni dokument); reference na izvor se puštaju odmah.
   */
  private async mergeSelection(
    items: PrintBundleItem[],
    query: PrintBundleQuery,
    baseName: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { format, requestedIds } = this.parseQuery(query);

    // Isključene stavke se NE štampaju (legacy paritet exclude_from_handover).
    const printable = items.filter((i) => !i.excluded);

    let selection: PrintBundleItem[];
    if (requestedIds) {
      const known = new Set(printable.map((i) => i.drawingId));
      const foreign = requestedIds.filter((id) => !known.has(id));
      if (foreign.length)
        throw new UnprocessableEntityException(
          `Crtež(i) ${foreign.join(", ")} ne pripadaju ovom nacrtu/primopredaji (ili su isključeni iz primopredaje).`,
        );
      const wanted = new Set(requestedIds);
      // Redosled kao u items, ne kao u query parametru.
      selection = printable.filter((i) => wanted.has(i.drawingId));
      const withoutPdf = selection.filter((i) => !i.hasPdf);
      if (withoutPdf.length)
        throw new UnprocessableEntityException(
          `Crtež(i) ${withoutPdf
            .map((i) => i.drawingNumber ?? String(i.drawingId))
            .join(", ")} nemaju uskladišten PDF.`,
        );
    } else {
      selection = printable.filter((i) => i.hasPdf);
    }
    if (!selection.length)
      throw new UnprocessableEntityException(
        "Nijedan crtež sa PDF-om nije u izabranom skupu — nema šta da se štampa.",
      );
    // Memory guard from metadata only — no blob is loaded to compute this.
    const totalKb = selection.reduce((sum, i) => sum + (i.sizeKb ?? 0), 0);
    if (totalKb > MERGE_MAX_TOTAL_KB)
      throw new UnprocessableEntityException(
        `Izabrani crteži imaju ukupno ~${Math.ceil(totalKb / 1024)} MB — maksimum za jedno spajanje je ${MERGE_MAX_TOTAL_KB / 1024} MB. Štampajte u manjim grupama (izbor crteža ili po formatu).`,
      );

    const merged = await PDFDocument.create();
    for (const item of selection) {
      if (item.drawingNumber === null || item.revision === null) continue; // orphan → hasPdf=false, ne stiže ovde
      const bytes = await this.loadPdfBinary(item.drawingNumber, item.revision);
      if (!bytes) {
        if (requestedIds)
          throw new UnprocessableEntityException(
            `Crtež ${item.drawingNumber} nema uskladišten PDF.`,
          );
        continue; // utrka meta vs. blob — preskoči, ne ruši ceo bundle
      }
      let source: PDFDocument;
      try {
        source = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
      } catch {
        // Nečitljiv PDF se u pregledu klasifikuje kao 'custom' — za ISO format
        // filter dakle NE pripada traženoj grupi (preskoči); eksplicitno tražen
        // (drawingIds / format=custom / sve) → 422 da štampa ne "proguta" crtež.
        if (format && format !== "custom") continue;
        throw new UnprocessableEntityException(
          `PDF crteža ${item.drawingNumber} je nečitljiv i ne može se spojiti — štampajte ga pojedinačno iz PDM-a.`,
        );
      }
      if (format) {
        const pageFormat =
          source.getPageCount() === 0
            ? "custom"
            : this.classifyFirstPage(source);
        if (pageFormat !== format) continue;
      }
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    }
    if (merged.getPageCount() === 0)
      throw new UnprocessableEntityException(
        format
          ? `Nijedan crtež nije u formatu ${format} — nema šta da se štampa.`
          : "Izabrani crteži nemaju nijednu PDF stranu — nema šta da se štampa.",
      );

    const buffer = Buffer.from(await merged.save());
    const suffix = format ?? (requestedIds ? "izbor" : "sve");
    return { buffer, fileName: `${baseName}-${suffix}.pdf` };
  }
}
