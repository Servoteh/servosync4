import { apiBlob } from '@/api/client';

/**
 * The drawing/skica sign endpoints now return an auth-gated content route
 * (`/api/v1/plan-proizvodnje/.../pdf/content`, class-gated by `plan_proizvodnje.read`)
 * instead of a presigned sy15 storage URL. That route needs the JWT bearer, so a raw
 * `window.open`/`<img src>` would 401. Pull the bytes with `apiBlob` (which attaches the
 * bearer) and hand back a blob URL — same house pattern as `@/lib/pracenje-pdf.ts`.
 *
 * `apiBlob` prepends the API base (which already includes `/api`), so the leading `/api`
 * of the returned absolute path is stripped to a base-relative `/v1/...` path.
 */
function toApiBlobPath(signedUrl: string): string {
  return signedUrl.replace(/^\/api(?=\/)/, '');
}

/** Fetch a drawing/skica as an object URL (caller revokes when done). */
export async function fetchDrawingObjectUrl(signedUrl: string): Promise<string> {
  const blob = await apiBlob(toApiBlobPath(signedUrl));
  return URL.createObjectURL(blob);
}

/** Open a drawing/skica PDF in a new tab, auth-gated. */
export async function openDrawingInTab(signedUrl: string): Promise<void> {
  const url = await fetchDrawingObjectUrl(signedUrl);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
