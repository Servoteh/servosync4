/**
 * OCR nalepnice (broj predmeta / TP) kad barkod ne uspe — paritet 1.0
 * services/labelOcr.js + lib/barcodeParse.js parsePredmetTpFromLabelText.
 *
 * Čisti deo (crop + parsiranje teksta) je bez zavisnosti. Sam OCR engine
 * (Tesseract) NIJE bundle-ovan u 2.0 (izbegavamo runtime CDN/WASM povlačenje
 * ~15MB traineddata pod on-prem CSP-om). `recognizeLabelText` koristi engine
 * SAMO ako je prisutan kao `window.Tesseract` (self-host UMD build); u
 * suprotnom vraća {error:'engine_missing'} pa UI degradira na barkod / ručni
 * unos bez pada. Engine-provisioning je zabeležen kao BE/infra follow-up.
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

/**
 * OCR je uvek „dostupan" u browseru — tesseract.js je bundlovan (lazy import,
 * kao u 1.0). Napomena: worker/wasm/traineddata se pri PRVOJ upotrebi vuku sa
 * CDN-a (default tesseract.js putanje) — na offline LAN telefonu prvi OCR pada
 * u `ocr_failed` (isti kompromis kao 1.0 web).
 */
export function isOcrEngineAvailable(): boolean {
  return typeof window !== 'undefined';
}

let workerPromise: Promise<TesseractWorkerLike> | null = null;
async function getWorker(): Promise<TesseractWorkerLike> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const win = getWindowEngine();
      if (win) return win.createWorker('eng', 1, { logger: () => {} });
      const mod = await import('tesseract.js');
      // 1.0 paritet: createWorker('eng', 1, {logger:()=>{}}) — barcode.js/labelOcr.js.
      return (mod as unknown as TesseractGlobal).createWorker('eng', 1, { logger: () => {} });
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
