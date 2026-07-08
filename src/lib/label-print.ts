/**
 * Štampa termalnih nalepnica preko lokalnog label-proxy-ja (MODULE_SPEC_kontrola §6,
 * MODULE_SPEC_stampa §6). Port iz ServoSync 1.0 (`dispatchOptionalNetworkLabelPrint`).
 *
 * Proxy je Node servis na pogonskom računaru (`servoteh-plan-montaze/tools/label-proxy`)
 * koji prima JSON sa `payload.tspl2` i piše RAW TSPL2 u TCP 9100 na TSC ML340P —
 * zaobilazi browser/driver print. URL se konfiguriše po terminalu:
 *   `NEXT_PUBLIC_LABEL_PROXY_URL` (npr. http://localhost:8765/print).
 * Ako nije postavljen → `{ ok:false, reason:'no_proxy_url' }` (UI to javi; bez tihe greške).
 */

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

/** Uvek postoji URL (override ili localhost default) — zadržano radi kompatibilnosti poziva. */
export function isLabelProxyConfigured(): boolean {
  return !!resolveProxyUrl();
}

/** Pošalji već sastavljen TSPL2 program proxy-ju (POST JSON). */
export async function dispatchNetworkLabelPrint(
  tspl2: string,
  meta?: Record<string, unknown>,
): Promise<LabelPrintResult> {
  const url = resolveProxyUrl();
  if (!url) return { ok: false, reason: 'no_proxy_url' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'tech_process', payload: { tspl2, ...meta } }),
    });
    return { ok: r.ok, reason: r.ok ? undefined : `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
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
