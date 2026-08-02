import type { Prisma } from "@prisma/client";
import { assertPdfAttachment } from "./attachments/attachment-format.util";

/**
 * Zahtev 038/26 — otpremanje crteža (PDF) za RN koji je mašinska usluga bez PDM
 * crteža. Deljeno između `work-orders.service.ts` (RN već postoji →
 * `workOrderId`) i `handovers.service.ts` (primopredaja „na pisanju" PRE nego
 * što RN nastane → `handoverId`, isti obrazac kao `plan_proizvodnje_drawings`
 * bytea-u-bazi — M1, nema object storage). Deljeno na jednom mestu da obe
 * strane računaju `sizeBytes`/zaglavlja identično (bez drifta).
 */

/** Meta polja `work_order_drawing_pdfs` — bez binarnog sadržaja. */
export const DRAWING_PDF_SELECT = {
  id: true,
  workOrderId: true,
  handoverId: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  uploadedAt: true,
  uploadedBy: true,
} satisfies Prisma.WorkOrderDrawingPdfSelect;

export type DrawingPdfRow = Prisma.WorkOrderDrawingPdfGetPayload<{
  select: typeof DRAWING_PDF_SELECT;
}>;

/** `sizeBytes` (bigint/int8) → `number` za JSON odgovor (Nest ne zna da serijalizuje bigint). */
export function drawingPdfMeta(row: DrawingPdfRow) {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    handoverId: row.handoverId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
    uploadedAt: row.uploadedAt,
    uploadedBy: row.uploadedBy,
  };
}

/**
 * Magic-byte provera (`%PDF-`). MIME zaglavlje iz browsera nije pouzdano (lako se
 * falsifikuje). Tanak omotač oko `assertPdfAttachment` iz `common/attachments` —
 * jedno mesto istine za formate priloga; ovde ostaje samo radi postojećih poziva.
 */
export function assertPdfMagicBytes(
  file?: Express.Multer.File,
): asserts file is Express.Multer.File {
  assertPdfAttachment(file);
}

/**
 * `Content-Type`/`Content-Disposition` (inline) sa ASCII + RFC 5987 fallback —
 * isti obrazac kao `plan-proizvodnje-read.service.ts` `pdfHeaders`.
 */
export function drawingPdfHeaders(fileName: string, contentType: string | null) {
  const asciiName =
    fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "crtez.pdf";
  const utf8Name = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    "Content-Type": contentType || "application/pdf",
    "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
  };
}
