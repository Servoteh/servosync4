import { apiBlob } from "@/api/client";

/**
 * Open a drawing PDF via the pracenje-scoped route (odluka O7 — `pracenje.read`
 * alone, no PDM gate). The endpoint needs the JWT bearer, so the bytes are pulled
 * through `apiBlob` (Authorization header) and shown from a blob URL — same house
 * pattern as `@/api/pdm.ts` openDrawingPdf.
 *
 * Contract shared by predmet-view (klik na crtež u tabeli) and rn-view (side panel).
 */
export async function openPracenjeDrawingPdf(drawingId: number): Promise<void> {
  const blob = await apiBlob(`/v1/pracenje/crtez/${drawingId}/pdf/content`);
  const url = URL.createObjectURL(
    blob.type === "application/pdf"
      ? blob
      : new Blob([blob], { type: "application/pdf" }),
  );
  window.open(url, "_blank", "noopener");
  // Revoke after the new tab has had a chance to load the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
