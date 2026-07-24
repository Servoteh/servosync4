/**
 * OCR nalepnice (broj predmeta / TP) kad barkod ne uspe — paritet 1.0
 * services/labelOcr.js + lib/barcodeParse.js parsePredmetTpFromLabelText.
 *
 * Čisti deo (crop + parsiranje teksta) je bez zavisnosti. Sam OCR engine
 * (tesseract.js@5.1.1) je bundle-ovan (lazy import), a worker/core-wasm/traineddata
 * se SELF-HOST-uju iz `public/tesseract/` (vidi `localTesseractOptions`) — bez
 * runtime CDN povlačenja, pa OCR radi offline / na LAN bake-u i pod on-prem CSP-om.
 * Opcioni `window.Tesseract` (self-host UMD) i dalje pobeđuje ako ga instalacija ubaci.
 */

export interface ParsedLabel {
  orderNo: string;
  itemRefId: string;
  drawingNo: string;
  format: 'ocr';
  raw: string;
}

/**
 * Parsiraj „broj predmeta / TP" iz OCR teksta (paritet 1.0 parsePredmetTpFromLabelText).
 * Traži par cifara razdvojen kosom/pomoćnim znakom (OCR često lomi „/" u \ - | I l).
 */
export function parsePredmetTpFromLabelText(raw: string): ParsedLabel | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/ /g, ' ').trim();
  if (!t) return null;

  const tryMatch = (s: string, pattern: RegExp): ParsedLabel | null => {
    const m = s.match(pattern);
    if (!m) return null;
    const orderNo = m[1].replace(/\D/g, '').slice(0, 8);
    const tp = m[2].replace(/\D/g, '').slice(0, 8);
    if (!orderNo || !tp) return null;
    return { orderNo, itemRefId: tp, drawingNo: '', format: 'ocr', raw: `${orderNo}/${tp}` };
  };

  // Tipičan OCR: cifre + razdvajač (/ \ - _ | I l) + cifre.
  const sep = '[/\\\\\\-_|Il]{1,4}';
  const core = new RegExp(`(\\d{1,8})\\s*${sep}\\s*(\\d{1,8})`, 'i');

  const blocks = [t, ...t.split(/[\r\n]+/)];
  for (const block of blocks) {
    const hit = tryMatch(block, core);
    if (hit) return hit;
  }

  // Retko: OCR slomi kosu crtu → dva broja razdvojena razmakom u istoj liniji.
  const loose = t.match(/\b(\d{3,8})\s+(\d{2,8})\b/g);
  if (loose) {
    for (const frag of loose) {
      const m = frag.match(/\b(\d{3,8})\s+(\d{2,8})\b/);
      if (m) {
        const orderNo = m[1].slice(0, 8);
        const tp = m[2].slice(0, 8);
        if (orderNo.length >= 3 && tp.length >= 2) {
          return { orderNo, itemRefId: tp, drawingNo: '', format: 'ocr', raw: `${orderNo}/${tp}` };
        }
      }
    }
  }
  return null;
}

/**
 * Iseci gornji desni ugao video kadra (gde je obično „Broj predmeta / TP") →
 * canvas za OCR (paritet 1.0 cropTopRightLabelRegion).
 */
export function cropTopRightLabelRegion(
  video: HTMLVideoElement,
  opts: { widthFraction?: number; heightFraction?: number } = {},
): HTMLCanvasElement | null {
  if (!video || video.readyState < 2) return null;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const wf = opts.widthFraction ?? 0.45;
  const hf = opts.heightFraction ?? 0.28;
  const rw = Math.max(64, Math.floor(w * wf));
  const rh = Math.max(48, Math.floor(h * hf));
  const sx = w - rw;
  const sy = 0;

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(video, sx, sy, rw, rh, 0, 0, rw, rh);
  } catch {
    return null;
  }
  return canvas;
}

// ── Engine: bundlovan tesseract.js@5.1.1 (lazy, 1.0 paritet) sa opcionim
// self-host UMD override-om (window.Tesseract, ako je instalacija ubacila svoj).

interface TesseractWorkerLike {
  recognize: (img: CanvasImageSource) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
}
interface TesseractGlobal {
  createWorker: (
    lang?: string,
    oem?: number,
    opts?: Record<string, unknown>,
  ) => Promise<TesseractWorkerLike>;
}

function getWindowEngine(): TesseractGlobal | null {
  if (typeof window === 'undefined') return null;
  const t = (window as unknown as { Tesseract?: TesseractGlobal }).Tesseract;
  return t && typeof t.createWorker === 'function' ? t : null;
}

/** Koren self-host tesseract asseta (public/tesseract/ → out/tesseract/ u static export-u). */
const OCR_ASSET_BASE = '/tesseract';

/**
 * Minimalni WASM modul za detekciju SIMD (v128) podrške — isti bajtovi kao
 * `wasm-feature-detect`. Bira SIMD core kad je podržan (Chrome 91+), inače pada
 * na ne-SIMD build. `WebAssembly.validate` je sinhron i bezbedan (bez instanciranja).
 */
const WASM_SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
);
function wasmSimdSupported(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
}

/**
 * Self-host putanje za tesseract.js — worker, core-wasm i traineddata iz
 * `public/tesseract/` (root-relativne; `resolvePaths` ih razrešava na origin,
 * pa rade i preko Cloudflare-a i na LAN bake-u). Bez ovoga tesseract.js@5 vuče
 * ~11MB asseta sa jsDelivr CDN-a → pada offline/na LAN-u i pod on-prem CSP-om.
 *   • worker.min.js  — tesseract.js/dist
 *   • *-core-*.wasm.js — tesseract.js-core (SIMD ili ne-SIMD; wasm je embed-ovan)
 *   • eng.traineddata.gz — tessdata_fast (langPath je direktorijum; gzip=true default)
 */
function localTesseractOptions(): Record<string, unknown> {
  return {
    logger: () => {},
    workerPath: `${OCR_ASSET_BASE}/worker.min.js`,
    corePath: wasmSimdSupported()
      ? `${OCR_ASSET_BASE}/tesseract-core-simd.wasm.js`
      : `${OCR_ASSET_BASE}/tesseract-core.wasm.js`,
    langPath: OCR_ASSET_BASE,
  };
}

/**
 * OCR je uvek „dostupan" u browseru — tesseract.js je bundlovan (lazy import),
 * a worker/core-wasm/traineddata se self-host-uju iz `public/tesseract/`
 * (`localTesseractOptions`) → radi offline i na LAN bake-u (nema CDN povlačenja).
 */
export function isOcrEngineAvailable(): boolean {
  return typeof window !== 'undefined';
}

let workerPromise: Promise<TesseractWorkerLike> | null = null;
async function getWorker(): Promise<TesseractWorkerLike> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // 1.0 paritet: createWorker('eng', 1, …) — barcode.js/labelOcr.js. OEM 1 = LSTM_ONLY.
      // Self-host asseti (workerPath/corePath/langPath) → offline/LAN, on-prem CSP.
      const opts = localTesseractOptions();
      const win = getWindowEngine();
      if (win) return win.createWorker('eng', 1, opts);
      const mod = await import('tesseract.js');
      return (mod as unknown as TesseractGlobal).createWorker('eng', 1, opts);
    })().catch((e) => {
      // Pad inicijalizacije (offline CDN za wasm/traineddata) NE sme da „zacementira"
      // OCR do kraja sesije — sledeći pokušaj kreće ispočetka.
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/** Oslobodi OCR worker (npr. pri zatvaranju skenera). */
export async function terminateLabelOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* ignore */
  }
  workerPromise = null;
}

/**
 * OCR nad canvasom → prepoznat tekst. Vraća {error:'engine_missing'} kad engine
 * nije provisioniran (UI tada degradira na barkod / ručni unos).
 */
export async function recognizeLabelText(
  canvas: HTMLCanvasElement,
): Promise<{ text: string } | { error: string }> {
  if (!canvas?.width || !canvas.height) return { error: 'empty_frame' };
  if (!isOcrEngineAvailable()) return { error: 'engine_missing' };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return { text: typeof data.text === 'string' ? data.text : '' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'recognize_failed' };
  }
}
