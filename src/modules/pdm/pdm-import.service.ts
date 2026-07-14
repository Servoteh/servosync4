import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { alignIdSequence } from "../../common/db-sequences";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  isProcurementMarking,
  normalizeRevision,
  parseImportXml,
  PdmXmlStructureError,
  validateParsedFile,
  type ParsedPdmFile,
  type PdmDocRow,
} from "./pdm-xml-parser";

/**
 * Multipart fajl iz multer memory storage-a (@nestjs/platform-express).
 * Lokalni interfejs — @types/multer namerno NE postoji u repou.
 */
export interface UploadedMultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface PdmImportStats {
  documentsInFile: number;
  drawingsCreated: number;
  drawingsUpdated: number;
  drawingsSkipped: number;
  bomEdgesCreated: number;
  oldRevisionRelinks: number;
  /** Ceo fajl preskočen jer root (broj, revizija) već postoji u drawings. */
  skippedExisting: boolean;
  errors: string[];
}

export interface PdmImportResult {
  importId: number;
  fileName: string;
  success: boolean;
  statusMessage: string;
  stats: PdmImportStats;
}

/**
 * Ime PDF fajla nosi (broj, reviziju): `{BrojCrteza}_{Revizija}.pdf` ili
 * `{BrojCrteza}.pdf` — legacy potvrda: PDM_PDFCommon.bas gradi temp
 * `~{Broj}_{Rev}.pdf` (l.170/388/463), a XML fajlovi nose isti obrazac
 * (1126982_B.xml). Sufiks posle POSLEDNJEG `_` sa 1–3 znaka = revizija;
 * inače ceo naziv = broj, revizija "A".
 */
export function parsePdfFileName(originalName: string): {
  drawingNumber: string;
  revision: string;
} {
  const base = originalName.replace(/\.pdf$/i, "").trim();
  const idx = base.lastIndexOf("_");
  if (idx > 0) {
    const suffix = base.slice(idx + 1);
    if (suffix.length >= 1 && suffix.length <= 3)
      return { drawingNumber: base.slice(0, idx), revision: suffix };
  }
  return { drawingNumber: base, revision: "A" };
}

/** Trim + prazno → null + isecanje na dužinu kolone (izbegava PG overflow 500). */
function clip(value: string | null | undefined, max: number): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/** Isecanje obaveznih (NOT NULL) kolona bez null fallback-a. */
function clipRequired(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Multer (busboy) latin1-dekodira `originalname` kad klijent ne pošalje
 * UTF-8 flag — non-ASCII ime (š/đ/č) stiže kao mojibake. Re-dekodiranje
 * latin1→utf8 vraća originalno ime; čist ASCII i već ispravno dekodirana
 * imena (znak van latin1 opsega) prolaze netaknuti, a nevalidna UTF-8
 * sekvenca (U+FFFD posle re-dekodiranja) zadržava sirovo ime.
 */
export function decodeOriginalName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name; // čist ASCII
  for (const ch of name) if (ch.codePointAt(0)! > 0xff) return name; // već UTF-8
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded;
}

/** Ključ dedup-a dokumenata u fajlu: (docId, revizija normalizovana). */
function docKey(docId: string, revision: string): string {
  return `${docId}\u0000${revision}`;
}

/**
 * Nativni PDM intake (P4 cutover — zamena legacy 10-min skripti):
 *  - XML tok: parse → validacije (SVE-ILI-NIŠTA) → root dedup → upsert
 *    crteža + §6.6 delete/recreate BOM-a + relink starih revizija, sve u
 *    JEDNOJ transakciji po fajlu;
 *  - PDF intake: upsert u drawing_pdfs po (broj, revizija) — crtež NE MORA
 *    postojati (PDF sme stići pre XML-a, kao legacy PDM_PDFCrtezi);
 *  - log red u drawing_import_log se piše VAN transakcije, UVEK (i za PDF,
 *    prefiks "PDF: " — ista tabela, generičke kolone; heuristika u
 *    pdm.service.findDrawing „fileName startsWith broj" ga prikazuje na
 *    detalju crteža).
 *
 * Poslovna greška (validacija, loš XML) → HTTP 200 + success:false — bridge
 * i UI čitaju flag (paritet legacy log semantike). 400 samo za nedostajući
 * fajl / pogrešan tip; 413 preko multer limita.
 */
@Injectable()
export class PdmImportService {
  private readonly logger = new Logger(PdmImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- XML

  async importXml(
    file: UploadedMultipartFile | undefined,
    sourcePath: string | undefined,
    user: AuthUser,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException(
        'Nedostaje XML fajl (multipart polje "file")',
      );

    const fileName = decodeOriginalName(file.originalname);
    const filePath = sourcePath?.trim() || `upload:${user.email}`;
    const stats: PdmImportStats = {
      documentsInFile: 0,
      drawingsCreated: 0,
      drawingsUpdated: 0,
      drawingsSkipped: 0,
      bomEdgesCreated: 0,
      oldRevisionRelinks: 0,
      skippedExisting: false,
      errors: [],
    };

    // Kontrakt §2.8: UTF-8 BEZ XML deklaracije i BEZ BOM-a → eksplicitno
    // dekodiranje (sax rešava numeričke entitete tipa &#xA; u ZiliS).
    // Eventualni BOM (U+FEFF) se defanzivno skida — sax bi na njemu pukao.
    let xmlText = file.buffer.toString("utf8");
    if (xmlText.charCodeAt(0) === 0xfeff) xmlText = xmlText.slice(1);

    let parsed: ParsedPdmFile;
    try {
      parsed = parseImportXml(xmlText);
    } catch (error) {
      if (!(error instanceof PdmXmlStructureError)) throw error;
      return this.failXml(fileName, filePath, error.message, stats);
    }
    stats.documentsInFile = parsed.rows.length;

    // Validacije — paritet ProveriXMLFajl: SVE-ILI-NIŠTA.
    const validationErrors = validateParsedFile(parsed);
    if (validationErrors.length) {
      stats.errors = validationErrors;
      return this.failXml(
        fileName,
        filePath,
        validationErrors.join("; "),
        stats,
      );
    }

    // Root dedup (paritet UveziPDM_XMLFajl l.100–105): root (broj, revizija)
    // već u drawings → CEO FAJL SKIP, uspešan ne-kritičan log.
    const root = parsed.rows.find((r) => r.isRoot);
    if (!root)
      return this.failXml(fileName, filePath, "XML nema root dokument", stats);
    const existingRoot = await this.prisma.drawing.findUnique({
      where: {
        drawingNumber_revision: {
          drawingNumber: root.docId,
          revision: root.revision,
        },
      },
      select: { id: true },
    });
    if (existingRoot) {
      stats.skippedExisting = true;
      stats.drawingsSkipped = parsed.rows.length;
      const statusMessage = "Crtež već postoji — fajl preskočen";
      const importId = await this.writeLog({
        fileName,
        filePath,
        success: true,
        statusMessage,
        isCritical: false,
      });
      return {
        data: { importId, fileName, success: true, statusMessage, stats },
      };
    }

    // Upsert tok — JEDNA transakcija po fajlu; log ide VAN nje.
    try {
      await this.prisma.$transaction(
        async (tx) => this.runUpsert(tx, parsed, user, stats),
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (error) {
      // Konkurentan uvoz ISTOG novog fajla (bridge run + ručni upload): root
      // dedup je VAN transakcije, pa drugi upis pada na uq constraint (P2002).
      // Prvi commit je pobedio — poslovni ishod "već postoji", ne 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        stats.skippedExisting = true;
        stats.drawingsSkipped = parsed.rows.length;
        const statusMessage =
          "Crtež već postoji (konkurentan uvoz) — fajl preskočen";
        const importId = await this.writeLog({
          fileName,
          filePath,
          success: true,
          statusMessage,
          isCritical: false,
        });
        return {
          data: { importId, fileName, success: true, statusMessage, stats },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`XML import "${fileName}" failed: ${message}`);
      await this.writeLog({
        fileName,
        filePath,
        success: false,
        statusMessage: `Neočekivana greška pri upisu: ${message}`,
        isCritical: true,
      });
      throw error; // neočekivano → 500 (BACKEND_RULES §6)
    }

    const statusMessage =
      `Uvezeno ${stats.drawingsCreated + stats.drawingsUpdated} crteža ` +
      `(${stats.drawingsCreated} novih, ${stats.drawingsUpdated} ažuriranih), ` +
      `${stats.bomEdgesCreated} BOM veza, ${stats.oldRevisionRelinks} prevezivanja starih revizija` +
      (stats.errors.length ? `; upozorenja: ${stats.errors.join("; ")}` : "");
    const importId = await this.writeLog({
      fileName,
      filePath,
      success: true,
      statusMessage,
      isCritical: false,
    });
    return {
      data: { importId, fileName, success: true, statusMessage, stats },
    };
  }

  /** Upsert crteža + BOM unutar transakcije (redosled: dedup → upsert → §6.6 → relink). */
  private async runUpsert(
    tx: Prisma.TransactionClient,
    parsed: ParsedPdmFile,
    user: AuthUser,
    stats: PdmImportStats,
  ): Promise<void> {
    // Sync/finalni uvoz pune obe tabele EKSPLICITNIM legacy id-jevima, pa
    // autoincrement bez poravnanja kolidira (P2002 → 500) na prvom nativnom
    // insert-u — ista bomba viđena uživo 11.07 na drawing_import_log.
    await alignIdSequence(tx, "drawings");
    await alignIdSequence(tx, "drawing_components");

    const now = new Date();

    // (1) Dedup dokumenata po (docId, revizija) — prva pojava nosi atribute.
    const uniqueDocs = new Map<string, PdmDocRow>();
    for (const row of parsed.rows) {
      const key = docKey(row.docId, row.revision);
      if (!uniqueDocs.has(key)) uniqueDocs.set(key, row);
    }

    // (2)+(3) Upsert po dokumentu (§6.6: UPDATE ne dira createdAt; NABAVKA
    // flag = Oznaka sadrži ne-cifru — BEZ upisa u artikle, otvorena odluka
    // BACKEND_RULES §11.1).
    const idByKey = new Map<string, number>();
    const idByDocId = new Map<string, number>();
    const upserted: { docId: string; revision: string; id: number }[] = [];
    for (const [key, row] of uniqueDocs) {
      const data = this.drawingData(row, parsed.transactionDate, user);
      const existing = await tx.drawing.findUnique({
        where: {
          drawingNumber_revision: {
            drawingNumber: row.docId,
            revision: data.revision,
          },
        },
        select: { id: true },
      });
      let id: number;
      if (existing) {
        await tx.drawing.update({ where: { id: existing.id }, data });
        id = existing.id;
        stats.drawingsUpdated += 1;
      } else {
        const created = await tx.drawing.create({
          data: { ...data, createdAt: now },
          select: { id: true },
        });
        id = created.id;
        stats.drawingsCreated += 1;
      }
      idByKey.set(key, id);
      if (!idByDocId.has(row.docId)) idByDocId.set(row.docId, id);
      upserted.push({ docId: row.docId, revision: row.revision, id });
    }

    // (4) §6.6 delete/recreate komponenti SAMO za dokumente koji su u OVOM
    // fajlu roditelji (imaju <references>) — listovi ne diraju postojeći BOM.
    const parentDrawingIds = [
      ...new Set(
        parsed.rows
          .filter((r) => r.hasReferences)
          .map((r) => idByDocId.get(r.docId))
          .filter((id): id is number => id !== undefined),
      ),
    ];
    if (parentDrawingIds.length)
      await tx.drawingComponent.deleteMany({
        where: { parentDrawingId: { in: parentDrawingIds } },
      });

    // (6) Insert ivica iz fajla — dedup po (parent, child, rev) jer se CELO
    // podstablo ponavlja pod svakim roditeljem (§2.8: „dedup po (Oznaka,
    // Revision, ParentDocID) kao legacy"; prva pojava nosi količinu).
    // Nerazrešiv par → errors[] bez aborta reda.
    const edges: Prisma.DrawingComponentCreateManyInput[] = [];
    const edgeKeys = new Set<string>();
    for (const row of parsed.rows) {
      if (row.parentDocId === null) continue;
      const edgeKey = `${row.parentDocId}|${docKey(row.docId, row.revision)}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      const parentId = idByDocId.get(row.parentDocId);
      const childId = idByKey.get(docKey(row.docId, row.revision));
      if (parentId === undefined || childId === undefined) {
        stats.errors.push(
          `BOM veza ${row.parentDocId} → ${row.docId} nerazrešiva — preskočena`,
        );
        continue;
      }
      edges.push({
        parentDrawingId: parentId,
        childDrawingId: childId,
        requiredQuantity: row.quantity,
      });
    }
    if (edges.length) await tx.drawingComponent.createMany({ data: edges });
    stats.bomEdgesCreated = edges.length;

    // (5) Preusmeravanje starih revizija u BOM-u (port ZameniIDCrtezaStare-
    // RevizijeUKomponentama l.786+; važi i za ROOT kao legacy l.121–123).
    // Kad uvoz kreira NOVU NAJVIŠU reviziju parta, sve postojeće BOM veze koje
    // pokazuju na STARIJE revizije istog broja crteža — u drawing_components I
    // u drawing_assemblies — preusmeravaju se na novi red; revizija SKLOPA
    // (parentDrawingId) se NE dira. Ako uvezena revizija NIJE najviša (npr.
    // stigla je starija), ne dira se ništa. Matching revizija SVUDA
    // normalizovan prazan→"A" (svesna ispravka legacy nedoslednosti u
    // PopuniKomponentePDMCrteza). Roditelji iz OVOG fajla su već prevezani kroz
    // delete/recreate — ovde se hvataju SVI OSTALI.
    for (const u of upserted) {
      const others = await tx.drawing.findMany({
        where: { drawingNumber: u.docId, id: { not: u.id } },
        select: { id: true, revision: true },
      });
      // Preusmeravaj samo kad je uvezena revizija strogo najviša za taj broj
      // crteža (string poredjenje normalizovanih revizija, kao handover modul).
      const newRev = normalizeRevision(u.revision);
      const isHighest = others.every(
        (o) => normalizeRevision(o.revision) < newRev,
      );
      if (!isHighest) continue;
      const oldIds = others.map((o) => o.id);
      if (!oldIds.length) continue;

      // drawing_components: prevezivanje childDrawingId na novi red. Dedup po
      // (parent, child) ručno — nema unique constrainta, pa bi slepi update
      // napravio dupli red kad parent već ima vezu na novu reviziju.
      let relinkedComponents = 0;
      const staleComponents = await tx.drawingComponent.findMany({
        where: { childDrawingId: { in: oldIds } },
        select: { id: true, parentDrawingId: true },
      });
      for (const edge of staleComponents) {
        const duplicate = await tx.drawingComponent.findFirst({
          where: {
            parentDrawingId: edge.parentDrawingId,
            childDrawingId: u.id,
            id: { not: edge.id },
          },
          select: { id: true },
        });
        if (duplicate)
          await tx.drawingComponent.delete({ where: { id: edge.id } });
        else
          await tx.drawingComponent.update({
            where: { id: edge.id },
            data: { childDrawingId: u.id },
          });
        relinkedComponents += 1;
      }

      // drawing_assemblies: isti princip (childDrawingId → novi red, dedup po
      // (parent, child)); revizija sklopa (parentDrawingId) ostaje netaknuta.
      let relinkedAssemblies = 0;
      const staleAssemblies = await tx.drawingAssembly.findMany({
        where: { childDrawingId: { in: oldIds } },
        select: { id: true, parentDrawingId: true },
      });
      for (const edge of staleAssemblies) {
        const duplicate = await tx.drawingAssembly.findFirst({
          where: {
            parentDrawingId: edge.parentDrawingId,
            childDrawingId: u.id,
            id: { not: edge.id },
          },
          select: { id: true },
        });
        if (duplicate)
          await tx.drawingAssembly.delete({ where: { id: edge.id } });
        else
          await tx.drawingAssembly.update({
            where: { id: edge.id },
            data: { childDrawingId: u.id },
          });
        relinkedAssemblies += 1;
      }

      stats.oldRevisionRelinks += relinkedComponents + relinkedAssemblies;
      if (relinkedComponents || relinkedAssemblies)
        this.logger.log(
          `BOM repoint ${u.docId} rev ${u.revision}: ` +
            `${relinkedComponents} komponenti, ${relinkedAssemblies} sklopova (od starijih revizija)`,
        );
    }
  }

  /** Mapiranje PDM atributa → kolone drawings (paritet UpisiPDMSklopoveUTabeluCrtezi). */
  private drawingData(
    row: PdmDocRow,
    transactionDate: Date | null,
    user: AuthUser,
  ) {
    const a = row.attrs;
    return {
      externalId: clipRequired(row.pdmWeId ?? "", 20),
      transactionDate,
      designDate: row.designDate,
      designedBy: clip(a["DesignBy"], 50),
      approvedDate: row.approvedDate,
      approvedBy: clip(a["Approved by"], 50),
      drawingNumber: row.docId,
      revision: clipRequired(row.revision, 3),
      quantity: row.quantity,
      catalogNumber: clipRequired(a["Bb_Kataloski_broj"] ?? "", 50),
      name: clipRequired(a["Naziv"] || "NEMA PODATAK", 255),
      material: clip(a["Materijal"], 255),
      workOrderRef: clip(a["RN"], 20),
      dimensions: clip(a["Dimenzije"], 255),
      marking: clipRequired(a["Oznaka"] ?? "", 20),
      weight: row.weight,
      fileName: clip(a["Name"], 500),
      pdmStatus: clipRequired(a["State"] ?? "", 20),
      comment: clip(a["Comment"], 255),
      whereUsed: clip(a["WhereUsed"], 255),
      projectName: clip(a["Naziv_projekta"], 255),
      signature: clipRequired(user.email, 50),
      statusId: 0,
      isProcurement: isProcurementMarking(a["Oznaka"] ?? ""),
    };
  }

  /** Neuspeh validacije/strukture → kritičan log + HTTP 200 sa success:false. */
  private async failXml(
    fileName: string,
    filePath: string,
    statusMessage: string,
    stats: PdmImportStats,
  ) {
    const importId = await this.writeLog({
      fileName,
      filePath,
      success: false,
      statusMessage,
      isCritical: true,
    });
    return {
      data: { importId, fileName, success: false, statusMessage, stats },
    };
  }

  // ---------------------------------------------------------------- PDF

  async importPdf(
    file: UploadedMultipartFile | undefined,
    fields: {
      drawingNumber?: string;
      revision?: string;
      sourcePath?: string;
    },
    user: AuthUser,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException(
        'Nedostaje PDF fajl (multipart polje "file")',
      );
    // Magic bytes — sadržaj mora biti PDF bez obzira na ekstenziju/mimetype.
    if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-")
      throw new BadRequestException(
        "Fajl nije PDF (ne počinje sa %PDF- zaglavljem)",
      );

    const fileName = decodeOriginalName(file.originalname);

    // Eksplicitna form polja imaju PREDNOST nad parsiranjem imena fajla.
    const fromName = parsePdfFileName(fileName);
    const drawingNumber =
      fields.drawingNumber?.trim() || fromName.drawingNumber;
    const revision = fields.revision?.trim() || fromName.revision;

    if (!drawingNumber)
      throw new BadRequestException("Broj crteža se ne može odrediti");
    if (drawingNumber.length > 100)
      throw new BadRequestException("Broj crteža duži od 100 znakova");
    if (revision.length > 10)
      throw new BadRequestException("Revizija duža od 10 znakova");

    const where = { drawingNumber_revision: { drawingNumber, revision } };
    const sizeKb = Math.round(file.size / 1024);
    const uploadedBy = clipRequired(user.email, 50);
    const now = new Date();
    // Prisma 6 Bytes traži ArrayBuffer-backed Uint8Array (Buffer je
    // ArrayBufferLike) — kopija je jednokratna po uvozu.
    const pdfBinary = new Uint8Array(file.buffer);

    // Crtež NE MORA postojati u drawings — PK (broj, revizija) je nezavisan
    // kao legacy PDM_PDFCrtezi (PDF sme stići pre XML-a); informativni flag.
    const [existingPdf, existingDrawing] = await Promise.all([
      this.prisma.drawingPdf.findUnique({
        where,
        select: { drawingNumber: true },
      }),
      this.prisma.drawing.findUnique({ where, select: { id: true } }),
    ]);
    const replaced = existingPdf !== null;
    const drawingExists = existingDrawing !== null;

    await this.prisma.drawingPdf.upsert({
      where,
      create: {
        drawingNumber,
        revision,
        fileName: clip(fileName, 255),
        uploadedAt: now,
        sizeKb,
        uploadedBy,
        pdfBinary,
      },
      update: {
        fileName: clip(fileName, 255),
        uploadedAt: now,
        sizeKb,
        uploadedBy,
        pdfBinary,
      },
    });

    const statusMessage =
      `PDF: ${drawingNumber} rev ${revision}, ${sizeKb} KB` +
      (replaced ? " (zamenjen postojeći)" : "");
    const importId = await this.writeLog({
      fileName,
      filePath: fields.sourcePath?.trim() || `upload:${user.email}`,
      success: true,
      statusMessage,
      isCritical: false,
    });

    // ISTI kontrakt kao XML tok: bridge (`data.success === true`) i UI
    // (`!r.success`) ZAHTEVAJU flag — bez njega se svaki uspešan PDF uvoz
    // tretira kao odbijen.
    return {
      data: {
        importId,
        fileName,
        success: true,
        statusMessage,
        drawingNumber,
        revision,
        sizeKb,
        replaced,
        drawingExists,
      },
    };
  }

  // ---------------------------------------------------------------- LOG

  /** Log red u drawing_import_log — VAN transakcije, id = importId u odgovoru. */
  private async writeLog(entry: {
    fileName: string;
    filePath: string;
    success: boolean;
    statusMessage: string;
    isCritical: boolean;
  }): Promise<number> {
    // Tabela je sync-ovana sa eksplicitnim legacy id-jevima — poravnaj sekvencu
    // pre svakog nativnog upisa (uzrok prod 500 P2002 11.07).
    await alignIdSequence(this.prisma, "drawing_import_log");
    const log = await this.prisma.drawingImportLog.create({
      data: {
        fileName: clipRequired(entry.fileName, 255),
        filePath: clipRequired(entry.filePath, 1024),
        success: entry.success,
        // VarChar(1000) — spojeni razlozi se seku da upis nikad ne pukne.
        statusMessage: clipRequired(entry.statusMessage, 1000),
        isCritical: entry.isCritical,
      },
      select: { id: true },
    });
    return log.id;
  }
}
