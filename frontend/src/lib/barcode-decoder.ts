'use client';

/*
 * Zajednički barkod DECODE-ENGINE — 1:1 port know-how-a iz 1.0
 * `src/services/barcode.js` (ServoSync 1.0, ispečen kroz ~17 iteracija na
 * stvarnim telefonima u pogonu; vidi docs/SCAN_ANALIZA_A17_A26.md u 1.0 repou).
 *
 * ZAŠTO POSTOJI: nativni `BarcodeDetector` API postoji SAMO na Chromium-u
 * (Android/desktop Chrome/Edge). iPhone (WebKit — Safari i SVI iOS pregledači)
 * ga NEMA, pa skener koji gejtuje na `BarcodeDetector` pogrešno javi „kamera
 * nije podržana" iako kamera radi. 1.0 lekcija: podrška se gejtuje ISKLJUČIVO
 * na `getUserMedia`, a dekoder se bira po platformi:
 *   • BarcodeDetector — gde postoji (Chromium; 3.0 status-quo koji u pogonu radi);
 *   • ZXing (`@zxing/browser@0.1.5` + `@zxing/library@0.21.3` — PINOVANO, stariji
 *     API!) — svuda gde nativnog nema: iPhone item/1D, Firefox, Safari desktop;
 *   • jsQR hibrid — iOS + QR: ZXing kontinuirano nad <video> na WebKit-u skoro
 *     nikad ne nađe QR (1.0 komentar), pa se QR čita jsQR-om sa canvas snapshot-a
 *     (na 78 ms), a 1D paralelno ZXing `decodeFromCanvas` (na 400 ms).
 *
 * Prenete 1.0 lekcije koje se lako izgube (NE uklanjati bez čitanja istorije):
 *   • `isDecodeMissError` preko instanceof + `kind` stringa — esbuild/terser
 *     mangl-uju imena klasa (`err.name === 'NotFoundException'` PUCA na prod
 *     build-u → trajni lažni crveni error; 1.0 commit 4bdc8d7).
 *   • ZXing hints: item = CODE_128 + CODE_39 (suženo ~2× brže od punog seta),
 *     TRY_HARDER na mobilnom (1.0 fd252cb: bez toga RNZ Code128 na iPhone-u
 *     nikad ne dekodira); QR-mix profil dodaje QR_CODE + ITF.
 *   • Reader opcije (1.0 barcode.js:167-189): item {28ms pokušaj, 150ms posle
 *     pogotka, 5s video timeout}; QR-mix {60, 280, 7.5s}.
 *   • Slika iz fajla: SAMO ZXing (nikad BarcodeDetector) + 11 canvas pokušaja
 *     (6× grayscale+kontrast 1.28–2.55, 5× upscale 2.05–3.65) i Code128-only
 *     reader PRE punog — folija/odsjaj/gusti kodovi (1.0 948bce0 + e48b763).
 *   • Sve biblioteke se učitavaju LAZY (ZXing ~250KB gzip) — tek pri prvom
 *     dekodiranju, ne pri učitavanju stranice.
 */

import type {
  BarcodeFormat as ZXBarcodeFormat,
  DecodeHintType as ZXDecodeHintType,
} from '@zxing/library';
import type { BrowserMultiFormatReader as ZXBrowserMultiFormatReader } from '@zxing/browser';

export type DecodeFormat = 'code_128' | 'code_39' | 'itf' | 'ean_13' | 'qr_code';

// ── Podrška / platforma ─────────────────────────────────────────────────────

/** Paritet 1.0 `isScanSupported` (barcode.js:261): SAMO getUserMedia — nikad BarcodeDetector. */
export function isCameraDecodeSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function hasNativeBarcodeDetector(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined'
  );
}

/** Safari na iPhone/iPad (uklj. iPadOS koji lažira Mac UA — `ontouchend`). */
export function isIOSWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const u = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(u)) return true;
  return u.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document;
}

function isMobileLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isIOSWebKit() || /Android/i.test(navigator.userAgent || '');
}

// ── ZXing lazy modul + hints/opcije (1.0 paritet) ───────────────────────────

interface ZXingMod {
  BrowserMultiFormatReader: typeof ZXBrowserMultiFormatReader;
  BarcodeFormat: typeof ZXBarcodeFormat;
  DecodeHintType: typeof ZXDecodeHintType;
  NotFoundException: new (...a: unknown[]) => Error;
  ChecksumException: new (...a: unknown[]) => Error;
  FormatException: new (...a: unknown[]) => Error;
}

let zxingModP: Promise<ZXingMod> | null = null;
function loadZXing(): Promise<ZXingMod> {
  if (!zxingModP) {
    zxingModP = Promise.all([import('@zxing/browser'), import('@zxing/library')]).then(
      ([b, l]) => ({
        BrowserMultiFormatReader: b.BrowserMultiFormatReader,
        BarcodeFormat: l.BarcodeFormat,
        DecodeHintType: l.DecodeHintType,
        NotFoundException: l.NotFoundException as unknown as ZXingMod['NotFoundException'],
        ChecksumException: l.ChecksumException as unknown as ZXingMod['ChecksumException'],
        FormatException: l.FormatException as unknown as ZXingMod['FormatException'],
      }),
    );
  }
  return zxingModP;
}

/**
 * „Decode-miss" (nije-našao-kod u frejmu) vs prava greška — MINIFIKACIJA-SAFE
 * (1.0 commit 4bdc8d7): instanceof + statički `kind`/`getKind()` string, nikad
 * `err.name` (esbuild mangl-uje imena klasa u jednoslovna).
 */
function isDecodeMissError(zx: ZXingMod, err: unknown): boolean {
  if (!err) return false;
  if (
    err instanceof zx.NotFoundException ||
    err instanceof zx.ChecksumException ||
    err instanceof zx.FormatException
  )
    return true;
  const kindOf = (e: unknown): string => {
    const anyE = e as { getKind?: () => string; kind?: string };
    try {
      if (typeof anyE?.getKind === 'function') return String(anyE.getKind());
    } catch {
      /* ignore */
    }
    return String(anyE?.kind ?? '');
  };
  return /NotFoundException|ChecksumException|FormatException/.test(kindOf(err));
}

function toZXFormats(zx: ZXingMod, formats: DecodeFormat[]): ZXBarcodeFormat[] {
  const map: Record<DecodeFormat, ZXBarcodeFormat> = {
    code_128: zx.BarcodeFormat.CODE_128,
    code_39: zx.BarcodeFormat.CODE_39,
    itf: zx.BarcodeFormat.ITF,
    ean_13: zx.BarcodeFormat.EAN_13,
    qr_code: zx.BarcodeFormat.QR_CODE,
  };
  return formats.map((f) => map[f]);
}

function buildHints(zx: ZXingMod, formats: DecodeFormat[], tryHarder: boolean) {
  const hints = new Map<ZXDecodeHintType, unknown>();
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, toZXFormats(zx, formats));
  if (tryHarder) hints.set(zx.DecodeHintType.TRY_HARDER, true);
  return hints as Map<ZXDecodeHintType, never>;
}

/** Reader opcije — 1.0 barcode.js:167-189 (item vs QR-mix profil). */
function readerOptions(hasQr: boolean) {
  return hasQr
    ? { delayBetweenScanAttempts: 60, delayBetweenScanSuccess: 280, tryPlayVideoTimeout: 7500 }
    : { delayBetweenScanAttempts: 28, delayBetweenScanSuccess: 150, tryPlayVideoTimeout: 5000 };
}

// ── Video decode: jedinstven ulaz za sve skener ljuske ──────────────────────

export interface VideoDecoderHandle {
  /** Koji je put aktivan — za dijagnostiku/status poruku. */
  path: 'native' | 'zxing' | 'ios-qr-hybrid';
  stop: () => void;
}

interface NativeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

/**
 * Zakači dekoder na VEĆ pokrenut <video> (stream-om upravlja pozivalac — lens
 * picker/zoom/torch ostaju netaknuti). Bira put po 1.0 pravilima:
 *   1. nativni BarcodeDetector ako postoji (Chromium — 3.0 status-quo),
 *   2. iOS + QR u formatima → jsQR hibrid (canvas: jsQR/78ms + ZXing-1D/400ms),
 *   3. inače ZXing `decodeFromVideoElement` (iPhone item, Firefox, Safari desktop).
 * `onRaw` prima SIROV string — dedup/re-arm i BE lookup ostaju u ljusci.
 */
export async function attachVideoDecoder(opts: {
  video: HTMLVideoElement;
  formats: DecodeFormat[];
  onRaw: (raw: string) => void;
  /** Ljuska javlja da li je još živa (stop-guard za async init). */
  isStopped?: () => boolean;
}): Promise<VideoDecoderHandle> {
  const { video, formats, onRaw } = opts;
  const isStopped = opts.isStopped ?? (() => false);

  // 1) Nativni BarcodeDetector (rAF nad <video> — isti loop kao dosadašnji 3.0).
  if (hasNativeBarcodeDetector()) {
    const Ctor = (window as unknown as {
      BarcodeDetector: new (o?: { formats?: string[] }) => NativeDetectorLike;
    }).BarcodeDetector;
    let detector: NativeDetectorLike | null = null;
    try {
      detector = new Ctor({ formats });
    } catch {
      try {
        detector = new Ctor();
      } catch {
        detector = null;
      }
    }
    if (detector) {
      let rafId = 0;
      let live = true;
      const det = detector;
      const tick = async () => {
        if (!live || isStopped()) return;
        try {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const found = await det.detect(video);
            const raw = found[0]?.rawValue ? String(found[0].rawValue) : '';
            if (raw) onRaw(raw);
          }
        } catch {
          /* prazan frejm — decode miss */
        }
        if (live && !isStopped()) rafId = requestAnimationFrame(() => void tick());
      };
      rafId = requestAnimationFrame(() => void tick());
      return {
        path: 'native',
        stop: () => {
          live = false;
          cancelAnimationFrame(rafId);
        },
      };
    }
  }

  const hasQr = formats.includes('qr_code');
  const oneD = formats.filter((f) => f !== 'qr_code');

  // 2) iOS + QR → jsQR hibrid (1.0 startIosLocationShelfQrHybrid, barcode.js:694-877).
  if (isIOSWebKit() && hasQr) {
    const IOS_JSQR_EVERY_MS = 78; // 1.0 barcode.js:681
    const IOS_ONED_ZX_MS = 400; // 1.0 barcode.js:682
    const [{ default: jsQR }, zx] = await Promise.all([import('jsqr'), loadZXing()]);
    const oneDReader = oneD.length
      ? new zx.BrowserMultiFormatReader(buildHints(zx, oneD, true), readerOptions(false))
      : null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let live = true;
    let rafId = 0;
    let lastQrAt = 0;
    let lastOneDAt = 0;
    // 1.0 (barcode.js:800-808): snapshot se SKALIRA na max stranu 1280 (min 280)
    // pre jsQR/ZXing — pun 1080p+ getImageData na 78ms guši WebKit main thread,
    // a jsQR na downscale-u čita bolje. Canvas se NE realocira dok je ista veličina.
    const HYBRID_MAX_PX = 1280;
    const tick = () => {
      if (!live || isStopped()) return;
      const now = Date.now();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (ctx && vw && vh && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (now - lastQrAt >= IOS_JSQR_EVERY_MS) {
          lastQrAt = now;
          const f = Math.min(1, HYBRID_MAX_PX / Math.max(vw, vh));
          const cw = Math.max(280, Math.round(vw * f));
          const ch = Math.max(280, Math.round(vh * f));
          if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
          }
          ctx.drawImage(video, 0, 0, cw, ch);
          try {
            const img = ctx.getImageData(0, 0, cw, ch);
            const qr = jsQR(img.data, cw, ch, { inversionAttempts: 'attemptBoth' });
            if (qr?.data) onRaw(String(qr.data));
            else if (oneDReader && now - lastOneDAt >= IOS_ONED_ZX_MS) {
              lastOneDAt = now;
              try {
                const res = (
                  oneDReader as unknown as { decodeFromCanvas: (c: HTMLCanvasElement) => { getText: () => string } }
                ).decodeFromCanvas(canvas);
                if (res?.getText()) onRaw(res.getText());
              } catch (e) {
                if (!isDecodeMissError(zx, e)) console.warn('[decoder] zxing 1D:', e);
              }
            }
          } catch {
            /* getImageData na praznom frejmu */
          }
        }
      }
      if (live && !isStopped()) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return {
      path: 'ios-qr-hybrid',
      stop: () => {
        live = false;
        cancelAnimationFrame(rafId);
      },
    };
  }

  // 3) ZXing nad <video> (iPhone item / Firefox / Safari desktop).
  const zx = await loadZXing();
  // Item profil: suženi formati (CODE_128+CODE_39 brzina, 1.0 fd252cb/9388c8a);
  // TRY_HARDER na mobilnom (iPhone RNZ inače ne dekodira).
  const liveFormats: DecodeFormat[] =
    !hasQr && isMobileLike()
      ? oneD.filter((f) => f === 'code_128' || f === 'code_39')
      : formats;
  const reader = new zx.BrowserMultiFormatReader(
    buildHints(zx, liveFormats.length ? liveFormats : formats, isMobileLike()),
    readerOptions(hasQr),
  );
  let controls: { stop: () => void };
  try {
    controls = await reader.decodeFromVideoElement(video, (result, err) => {
      if (isStopped()) return;
      if (result?.getText()) onRaw(result.getText());
      else if (err && !isDecodeMissError(zx, err)) {
        // Prava greška (ne miss) — samo log; ljuska ima svoj error-put za kameru.
        console.warn('[decoder] zxing:', err);
      }
    });
  } catch (e) {
    // 0.1.5 ume da REJECTUJE sirovom vrednošću (npr. `false` na video timeout) —
    // normalizuj u Error da ljuska ne ispiše „false" korisniku.
    throw e instanceof Error
      ? e
      : new Error('ZXing nije uspeo da pokrene video decode (timeout?)');
  }
  return {
    path: 'zxing',
    stop: () => {
      try {
        controls.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── Slika iz fajla: ZXing 11-pokušaja pipeline (1.0 decodeBarcodeFromFile) ──

/**
 * Nacrtaj sliku na canvas uz 1.0 LIMITE VELIČINE (barcode.js:1278-1339): bez
 * njih 12MP iPhone fotka ×3.65 = ~162MP canvas → iOS WebKit blank/OOM i ceo
 * pipeline tiho ne dekodira ništa. `maxSide` seče najdužu stranu; `maxPixels`
 * dodatno steže upscale pokušaje (1.0: maxDim=4000, maxPixels=6.500.000, min 280).
 */
function drawToCanvas(
  img: HTMLImageElement,
  scale: number,
  grayscaleContrast: number | null,
  maxSide: number,
  maxPixels: number,
): HTMLCanvasElement | null {
  try {
    let w = Math.max(1, Math.round(img.naturalWidth * scale));
    let h = Math.max(1, Math.round(img.naturalHeight * scale));
    const side = Math.max(w, h);
    if (side > maxSide) {
      const f = maxSide / side;
      w = Math.round(w * f);
      h = Math.round(h * f);
    }
    if (w * h > maxPixels) {
      const f = Math.sqrt(maxPixels / (w * h));
      w = Math.round(w * f);
      h = Math.round(h * f);
    }
    const MIN_SIDE = 280; // 1.0 donja granica — ispod toga barkod nema šanse
    if (Math.min(w, h) < MIN_SIDE) {
      const f = MIN_SIDE / Math.min(w, h);
      w = Math.round(w * f);
      h = Math.round(h * f);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = w > img.naturalWidth; // upscale gladak, downscale/1:1 veran
    ctx.drawImage(img, 0, 0, w, h);
    if (grayscaleContrast != null) {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      const f = grayscaleContrast;
      for (let i = 0; i < px.length; i += 4) {
        const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = Math.max(0, Math.min(255, (g - 128) * f + 128));
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(data, 0, 0);
    }
    return canvas;
  } catch {
    // WebKit canvas limit / OOM na ovom pokušaju → preskoči, sledeća varijanta.
    return null;
  }
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      res(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error('Slika ne može da se učita (format?)'));
    };
    img.src = url;
  });
}

/**
 * Dekodiraj barkod iz slike (fajl iz galerije / „Take Photo") — RADI I NA
 * iPHONE-u (čist ZXing, bez BarcodeDetector-a). 1.0 anti-glare pipeline:
 * originalna + 6× grayscale-kontrast (1.28–2.55) + 5× upscale (2.05–3.65)
 * varijante; za SVAKU prvo Code128-only reader (gusti RNZ kroz foliju), pa puni.
 * Vraća sirov string ili null (nije-našao).
 */
export async function decodeImageFile(
  file: File,
  formats: DecodeFormat[],
): Promise<string | null> {
  const zx = await loadZXing();
  const img = await loadImageFromFile(file);
  const reader128 = new zx.BrowserMultiFormatReader(
    buildHints(zx, ['code_128'], true),
    readerOptions(false),
  );
  const readerAll = new zx.BrowserMultiFormatReader(
    buildHints(zx, formats, true),
    readerOptions(formats.includes('qr_code')),
  );
  const tryCanvas = (canvas: HTMLCanvasElement): string | null => {
    for (const r of [reader128, readerAll]) {
      try {
        const res = (
          r as unknown as { decodeFromCanvas: (c: HTMLCanvasElement) => { getText: () => string } }
        ).decodeFromCanvas(canvas);
        const text = res?.getText();
        if (text) return text;
      } catch (e) {
        if (!isDecodeMissError(zx, e)) console.warn('[decoder] slika:', e);
      }
    }
    return null;
  };

  // 1.0 redosled pokušaja: original → grayscale-kontrast serija (opadajući
  // maxSide 4400→3000) → upscale serija (maxDim 4000, maxPixels 6.5M).
  const GRAY_MAX_SIDES = [4400, 4000, 3800, 3400, 3000, 3000];
  const attempts: Array<() => HTMLCanvasElement | null> = [
    () => drawToCanvas(img, 1, null, 4400, 20_000_000),
    ...[1.28, 1.55, 1.8, 2.05, 2.3, 2.55].map(
      (f, i) => () => drawToCanvas(img, 1, f, GRAY_MAX_SIDES[i] ?? 3000, 20_000_000),
    ),
    ...[2.05, 2.45, 2.85, 3.25, 3.65].map(
      (s) => () => drawToCanvas(img, s, 1.8, 4000, 6_500_000),
    ),
  ];
  for (const build of attempts) {
    const canvas = build();
    if (canvas) {
      const hit = tryCanvas(canvas);
      if (hit) return hit;
    }
    // Pusti event-loop da diše (11 canvas prolaza ume da traje na telefonu).
    await new Promise((r) => setTimeout(r, 0));
  }
  return null;
}

/** Rezolucija kamere po 1.0 `buildMobileCameraVideoConstraints` (barcode.js:117-152). */
export function buildVideoConstraints(profile: 'item' | 'mixed'): MediaTrackConstraints {
  // iOS ITEM (RNZ Code128): 2880×1620 — na 1080p bar ima premalo piksela pa
  // ZXing nikad ne dekodira (1.0 fd252cb → e48b763). Ostale platforme 1080p.
  if (isIOSWebKit() && profile === 'item') {
    return {
      width: { ideal: 2880 },
      height: { ideal: 1620 },
      frameRate: { ideal: 30, max: 30 },
    };
  }
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  };
}
