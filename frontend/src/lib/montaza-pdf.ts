import { apiBlob } from '@/api/client';

/**
 * Otvori PDF crteža Plana montaže (chip „Veza sa crtežima").
 *
 * Od 07.08.2026 crteži dolaze iz 3.0 `drawing_pdfs` (bytea u bazi) umesto iz sy15
 * storage bucket-a. Ranije je BE vraćao POTPISAN URL koji je nosio autorizaciju u
 * samom linku, pa je `window.open(url)` radio. Sada je izvor auth-gated API ruta
 * (`montaza.drawings_read`), pa se bajtovi MORAJU povući kroz `apiBlob`
 * (Authorization header) i prikazati iz blob URL-a — `window.open` na tu rutu
 * pada 401. Isti kućni obrazac kao `@/lib/pracenje-pdf` i `@/api/pdm.ts`.
 *
 * Ključ je broj crteža sa revizijom (`1029486_C`) — ono što faza nosi u
 * `linkedDrawings`; nema round-tripa kroz `/sign` jer je kod ujedno i ključ.
 */
export async function openMontazaDrawingPdf(code: string): Promise<void> {
  const blob = await apiBlob(`/v1/montaza/lookups/drawings/pdf/content?code=${encodeURIComponent(code)}`);
  const url = URL.createObjectURL(
    blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }),
  );
  window.open(url, '_blank', 'noopener');
  // Revoke tek kad novi tab stigne da učita blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
