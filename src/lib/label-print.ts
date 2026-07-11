/**
 * Štampa termalnih nalepnica (MODULE_SPEC_kontrola §6, MODULE_SPEC_stampa §6).
 *
 * PRIMARNI put (2026-07-10): BACKEND — `POST /v1/tech-processes/labels/print` šalje RAW
 * TSPL2 sa servera direktno na TCP 9100 štampača. Razlog: Chrome „Local Network Access"
 * blokira fetch sa HTTPS strane ka `http://localhost` (per-PC proxy je zato nepouzdan);
 * backend put radi sa SVAKOG uređaja (i telefon/tablet), bez ikakvog podešavanja terminala.
 *
 * FALLBACK: lokalni label-proxy (`tools/label-proxy`, port iz 1.0) — koristi se samo ako
 * backend štampa padne (npr. server ne vidi štampač), a browser sme localhost.
 */

import { apiFetch, ApiError } from '@/api/client';
import { buildTspLabelProgram, type TspLabelFields } from './tspl2';

/**
 * URL proxy-ja se bira U RUNTIME-U (isti obrazac kao API base u `client.ts`), jer
 * jedan statični build služi sve terminale, a proxy je uvek LOKALNI (localhost) na
 * svakom pogonskom računaru:
 *   1. eksplicitni override `window.__SERVOSYNC_LABEL_PROXY_URL__` (iz `/config.js`) → pobeđuje;
 *   2. podrazumevano `http://localhost:8765/print` (Chrome dozvoljava http→localhost sa HTTPS strane);
 *   3. bez window-a (prerender/testovi) → build env `NEXT_PUBLIC_LABEL_PROXY_URL`, pa localhost default.
 * Terminal koji NE vrti proxy → fetch padne, `printControlLabels` vrati `{ok:false}` (kiosk to javi).
 */
const DEFAULT_PROXY_URL = 'http://localhost:8765/print';

declare global {
  interface Window {
    /** Opcioni runtime override URL-a label-proxy-ja (vidi public/config.js). */
    __SERVOSYNC_LABEL_PROXY_URL__?: string;
  }
}

function resolveProxyUrl(): string {
  if (typeof window !== 'undefined') {
    const override = window.__SERVOSYNC_LABEL_PROXY_URL__?.trim();
    return override ? override.replace(/\/+$/, '') : DEFAULT_PROXY_URL;
  }
  return process.env.NEXT_PUBLIC_LABEL_PROXY_URL || DEFAULT_PROXY_URL;
}

export interface LabelPrintResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pošalji već sastavljen TSPL2 program štampaču: prvo kroz BACKEND (radi svuda),
 * pa fallback na lokalni proxy. Ne baca — vraća `{ok, reason}`.
 */
export async function dispatchNetworkLabelPrint(
  tspl2: string,
  meta?: Record<string, unknown>,
): Promise<LabelPrintResult> {
  // 1) Backend put (HTTPS ka API-ju — nema Chrome localhost blokada).
  let backendReason: string;
  try {
    await apiFetch<{ data: { ok: boolean } }>('/v1/tech-processes/labels/print', {
      method: 'POST',
      body: JSON.stringify({ tspl2, copies: meta?.copies }),
    });
    return { ok: true };
  } catch (e) {
    backendReason =
      e instanceof ApiError || e instanceof Error ? e.message : String(e);
  }

  // 2) Fallback: lokalni label-proxy (samo ako browser sme localhost);
  // `resolveProxyUrl` uvek vrati ne-prazan URL (override ili localhost default).
  const url = resolveProxyUrl();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'tech_process', payload: { tspl2, ...meta } }),
    });
    if (r.ok) return { ok: true };
    return { ok: false, reason: `server: ${backendReason} · proxy: http_${r.status}` };
  } catch (e) {
    const proxyReason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `server: ${backendReason} · proxy: ${proxyReason}` };
  }
}

/** dd-mm-yy (format datuma na legacy nalepnici). */
export function labelDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Sastavi TSPL za `copies` identičnih nalepnica (jedna po komadu) i pošalji proxy-ju.
 * `fields.datum` se popunjava tekućim datumom ako nije zadat.
 */
export async function printControlLabels(args: {
  fields: TspLabelFields;
  barcode: string;
  copies: number;
}): Promise<LabelPrintResult> {
  const copies = Math.max(1, Math.floor(args.copies || 1));
  const fields: TspLabelFields = {
    ...args.fields,
    datum: args.fields.datum ?? labelDate(),
  };
  const tspl2 = buildTspLabelProgram({ fields, barcodeValue: args.barcode, copies });
  return dispatchNetworkLabelPrint(tspl2, { copies });
}
