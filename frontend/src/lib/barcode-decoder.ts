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

/** Android browser (ne iOS WebKit) — teren gde BarcodeDetector ume da laže. */
export function isAndroidWeb(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !isIOSWebKit() && /Android/i.test(navigator.userAgent || '');
}

/** Samsung Internet — treba mu 350–450ms „cooldown" posle stop() pre novog getUserMedia. */
export function isSamsungInternetBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /SamsungBrowser/i.test(navigator.userAgent || '');
}

/**
 * Debug prekidač dekodera (port 1.0 `loc_scan_decode_mode` — neprocenjiv na
 * terenu): sessionStorage `ss3_scan_decode_mode` ∈ 'auto' | 'zxing' | 'native'.
 */
export type DecodeMode = 'auto' | 'zxing' | 'native';
export function getDecodeModeOverride(): DecodeMode {
  try {
    const v = sessionStorage.getItem('ss3_scan_decode_mode');
    return v === 'zxing' || v === 'native' ? v : 'auto';
  } catch {
    return 'auto';
  }
}
export function setDecodeModeOverride(mode: DecodeMode): void {
  try {
    sessionStorage.setItem('ss3_scan_decode_mode', mode);
  } catch {
    /* ignore */
  }
}

// ── Nišan-gejt: „skenira se samo ono što je u prozoru nišana" ───────────────

/**
 * Da li se pogoci dekodera OGRANIČAVAJU na prozor nišana (v. `acceptRegion` u
 * `attachVideoDecoder`) — SAMO potvrđeno problematični modeli (Samsung A16/A17,
 * UA `SM-A16x`/`SM-A17x`) na Android web-u.
 *
 * IZMERENI KOREN (04.08.2026, prijava „Samsung promaši sken za ~2 cm u odnosu
 * na prikazani prozor", A16/A17, mob premeštanje): dekoder na SVIM putevima
 * (BarcodeDetector / ZXing `decodeFromVideoElement` / jsQR hibrid) čita CEO
 * video frejm, a nišan je ČISTO VIZUELAN — u 3.0 i identično u 1.0
 * (`barcode.js:808` crta pun kadar; „presentation" režim menja samo CSS).
 * Povrh toga je prikaz `object-fit: cover` ISEČAK frejma: na A16 (frejm
 * 1280×720, ekran 412×800 portret) vidljivo je samo 371/1280 kolona (29%) —
 * dekoder čita i ~455 px NEVIDLJIVOG kadra sa svake strane (≈5–7 cm scene na
 * 10–15 cm daljine). Na štampanom RN-u / regalu gde barkodovi stoje na ~2 cm
 * jedan od drugog, dekoder tako uhvati SUSEDNI kod van prozora (često i van
 * ekrana) — korisnik vidi „promašaj od par cm".
 *
 * ZAŠTO GEJT, A NE UNIVERZALNA POPRAVKA: pun-frejm dekod nije mapping-greška
 * nego zatečeno ponašanje SVIH uređaja — na S26/iPhone je baš to „radi
 * perfektno" (tvrd uslov 04.08: tamo se ništa ne menja). Svako pravo poravnanje
 * zone i nišana MENJA ponašanje (kod van prozora prestaje da se čita), pa
 * univerzalni no-op dokaz strukturno ne postoji. Zato: gejt po profilu
 * (camera-picker obrazac — A-serija je i tamo problematični teren), svuda
 * drugde je ubačeni kod USPAVAN (gejt vrati `null` → identičan tok kao pre).
 *
 * Debug prekidač (terenska proba, isti obrazac kao `ss3_scan_decode_mode`):
 * sessionStorage `ss3_scan_roi_gate` = `'on'` (forsiraj i van A-serije) /
 * `'off'` (ugasi i na A-seriji). Čita se pri KAČENJU dekodera — promena važi
 * od sledećeg otvaranja skenera.
 */
export function shouldLimitScanToReticle(): boolean {
  try {
    const v = sessionStorage.getItem('ss3_scan_roi_gate');
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch {
    /* storage blokiran — odluči po profilu */
  }
  if (!isAndroidWeb()) return false; // iPhone/desktop: NIKAD (tvrd uslov)
  // SAMO potvrđeno problematični modeli: A16 (SM-A16x) i A17 (SM-A17x).
  // Lista se širi SAMO po potvrđenoj prijavi po modelu; A26 potvrđeno radi bez
  // gejta (Nenad, 04.08) — NE širiti na celu A-seriju. S-serija (SM-S…),
  // Note (SM-N…), tableti (SM-T…) i ostali Androidi ne prolaze.
  return /\bSM-A1[67]\d/i.test(typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
}

/** Pravougaonik u VIDEO pikselima (intrinsic `videoWidth`×`videoHeight` prostor). */
export interface VideoPxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Klijent-rect (CSS px, `getBoundingClientRect`) → pravougaonik u VIDEO
 * pikselima, za `<video>` sa `object-fit: cover` i podrazumevanim
 * `object-position` (centar) — što su SVE skener ljuske (`absolute inset-0
 * h-full w-full object-cover`).
 *
 * Letterbox/cover matematika:
 *   scale = max(dispW/vidW, dispH/vidH)
 *   offX  = (dispW − vidW·scale) / 2   (≤ 0 kad cover seče horizontalno)
 *   offY  = (dispH − vidH·scale) / 2
 *   videoX = (cssX − offX) / scale · videoY = (cssY − offY) / scale
 * (ista klasa računa kao `mapPointerToVideoNormalizedPlane` u lokacije ljusci
 * za tap-to-focus — ovde za pravougaonik nišana.)
 *
 * PRIMER (A16, frejm 1280×720, ekran 412×800 portret): scale = max(412/1280,
 * 800/720) = 1,111 · offX = (412 − 1422,2)/2 = −505,1 · offY = 0. Nišan
 * `min(92vw,420px)` = 379,0×118,5 CSS px centriran → u video px: 341,1×106,7
 * na x∈[469,5; 810,6], y∈[306,7; 413,3] — od 1280×720 frejma koji dekoder čita.
 *
 * Oba recta dolaze iz istog layout-a (video i nišan su u istom overlay korenu),
 * pa se `useVisualViewportFix` translacija korena PONIŠTAVA u razlici.
 * Vraća `null` (fail-open — pozivalac tada NE gejtuje) kad video još nema
 * metrike ili je presek prazan/degenerisan.
 */
export function mapClientRectToVideoRect(
  video: HTMLVideoElement,
  rect: DOMRectReadOnly,
): VideoPxRect | null {
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  if (!vr.width || !vr.height) return null;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2;
  const offY = (vr.height - vh * scale) / 2;
  const x1 = Math.max(0, Math.min(vw, (rect.left - vr.left - offX) / scale));
  const y1 = Math.max(0, Math.min(vh, (rect.top - vr.top - offY) / scale));
  const x2 = Math.max(0, Math.min(vw, (rect.right - vr.left - offX) / scale));
  const y2 = Math.max(0, Math.min(vh, (rect.bottom - vr.top - offY) / scale));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < 8 || h < 8) return null; // degenerisan presek — fail-open
  return { x: x1, y: y1, w, h };
}

/**
 * Margina prihvata oko nišana (od njegove širine/visine, sa SVAKE strane):
 * gejt je po CENTRU koda, pa margina pokriva drhtaj ruke / kod malo preko ivice.
 * Na A16 (nišan 341×107 video px): X ±51 px (≈0,8 cm scene), Y ±27 px (≈0,4 cm)
 * → susedni kod na ~2 cm od nišana (≈120 px) ostaje ODBIJEN.
 */
const RETICLE_MARGIN_X_FRAC = 0.15;
const RETICLE_MARGIN_Y_FRAC = 0.25;
/** Keš mapiranog nišana — layout se ne meri na svaki frejm (30–60 fps). */
const RETICLE_ROI_CACHE_MS = 200;

type RoiCenterGate = (cx: number, cy: number) => boolean;

/**
 * Fabrika gejta „centar pogotka u prozoru nišana" za jedan attach.
 * Vraća getter koji na svaki poziv da AKTUELAN gejt (nišan se pomera uživo —
 * donji panel raste/pada) ili `null` = ne gejtuj (profil van gejta, nema
 * regiona, video bez metrika…). SVE je fail-open: nijedan pad merenja ne sme
 * da ućutka skener.
 */
function createReticleGate(
  video: HTMLVideoElement,
  acceptRegion?: () => DOMRectReadOnly | null,
): () => RoiCenterGate | null {
  if (!acceptRegion || !shouldLimitScanToReticle()) return () => null;
  let cache: { at: number; gate: RoiCenterGate | null } | null = null;
  return () => {
    const now = Date.now();
    if (cache && now - cache.at < RETICLE_ROI_CACHE_MS) return cache.gate;
    let gate: RoiCenterGate | null = null;
    try {
      const rect = acceptRegion();
      const roi = rect ? mapClientRectToVideoRect(video, rect) : null;
      if (roi) {
        const mx = roi.w * RETICLE_MARGIN_X_FRAC;
        const my = roi.h * RETICLE_MARGIN_Y_FRAC;
        const x1 = roi.x - mx;
        const x2 = roi.x + roi.w + mx;
        const y1 = roi.y - my;
        const y2 = roi.y + roi.h + my;
        gate = (cx, cy) => cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
      }
    } catch {
      gate = null;
    }
    cache = { at: now, gate };
    return gate;
  };
}

/** Centar ZXing result-points niza (video px — capture canvas je 1:1 sa videom). */
function centerOfResultPoints(
  pts: unknown,
): { x: number; y: number } | null {
  if (!Array.isArray(pts) || pts.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of pts as Array<{ getX?: () => number; getY?: () => number }>) {
    try {
      const x = typeof p?.getX === 'function' ? Number(p.getX()) : NaN;
      const y = typeof p?.getY === 'function' ? Number(p.getY()) : NaN;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        sx += x;
        sy += y;
        n += 1;
      }
    } catch {
      /* tačka bez koordinata — preskoči */
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

/**
 * Da li uopšte probati nativni BarcodeDetector — 1.0 KANON (barcode.js:415-428 +
 * commit 3cffea5): na Android web-u default je ZXING, ne BarcodeDetector. Razlozi
 * iz terena (Samsung A-serija): API postoji ali delegira na Google Play Services
 * barcode modul koji ume da fali/ne radi → `detect()` zauvek prazan ili baca, a
 * simptom je „kamera radi, nikad ne skenira". 1.0 je posle debug-a ostavio BD
 * samo kao eksplicitni opt-in; 3.0 ga zadržava na DESKTOP Chromium-u (tamo radi)
 * i kroz debug override.
 *
 * `preferNative` je taj OPT-IN, per-profil kao u 1.0 (scanOverlay.js:431): ekran
 * čije nalepnice nativni put čita bolje sme da ga traži i na Androidu. Bezbedno
 * je tek od 31.07 jer BD put ima sanity (`getSupportedFormats`) + watchdog koji
 * na uzastopne greške servisa vruće prelazi na ZXing bez restarta kamere.
 * Debug override (`ss3_scan_decode_mode`) je i dalje JAČI od `preferNative`.
 */
export function shouldUseNativeDetector(preferNative?: boolean): boolean {
  if (!hasNativeBarcodeDetector()) return false;
  const mode = getDecodeModeOverride();
  if (mode === 'zxing') return false;
  if (mode === 'native') return true;
  // auto: Android → ZXing (1.0 kanon), osim kad ekran eksplicitno traži nativni;
  // desktop Chromium → BD.
  if (isAndroidWeb()) return preferNative === true;
  return true;
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
  detect: (
    source: CanvasImageSource,
  ) => Promise<{ rawValue: string; boundingBox?: DOMRectReadOnly }[]>;
}

/** Koliko se čeka `BarcodeDetector.getSupportedFormats()` pre nego što je servis proglašen mrtvim. */
const BD_SANITY_TIMEOUT_MS = 1500;

/**
 * Izbor MEĐU više kodova u istom kadru (dodato 30.07 — „kamera uzima prvi barkod
 * iz kadra"). Na štampanom radnom nalogu barkodovi operacija stoje jedan pod
 * drugim, pa nativni `BarcodeDetector` lako vrati SUSEDNI red umesto barkoda
 * naloga; kako su barkodovi operacija međusobno slični i nisu jedinstveni,
 * promašaj se ne vidi.
 *
 * PONAŠANJE BEZ PREDIKATA JE BIT-EXACT KAO PRE: `prefer == null` → `values[0]`
 * (isto što je radio `found[0]?.rawValue`, uključujući prazan prvi element koji
 * ljuska ionako odbacuje). Sa predikatom: prvi NEPRAZAN kod koji ga zadovolji, a
 * ako nijedan ne zadovolji — ipak `values[0]` (pa ljuska/backend daju konkretnu
 * poruku o pogrešnom barkodu, umesto tišine). Predikat koji baci grešku se
 * ignoriše — pozivaočev kod ne sme da obori decode petlju.
 */
export function pickPreferredRaw(
  values: readonly string[],
  prefer?: (raw: string) => boolean,
): string {
  const first = values[0] ?? '';
  if (!prefer) return first;
  for (const v of values) {
    if (!v) continue;
    try {
      if (prefer(v)) return v;
    } catch {
      /* predikat pozivaoca ne sme da obori dekoder */
    }
  }
  return first;
}

/**
 * Zakači dekoder na VEĆ pokrenut <video> (stream-om upravlja pozivalac — lens
 * picker/zoom/torch ostaju netaknuti). Bira put po 1.0 pravilima:
 *   1. nativni BarcodeDetector SAMO gde je pouzdan — desktop Chromium ili debug
 *      override (v. `shouldUseNativeDetector`; 1.0 kanon 3cffea5: na ANDROID
 *      web-u default je ZXing jer Samsung BD API ume tiho da ne radi) — uz
 *      getSupportedFormats() sanity i no-hit-na-grešku watchdog → ZXing,
 *   2. iOS + QR u formatima → jsQR hibrid (canvas: jsQR/78ms + ZXing-1D/400ms),
 *   3. inače ZXing `decodeFromVideoElement` (ANDROID, iPhone item, Firefox…).
 * `onRaw` prima SIROV string — dedup/re-arm i BE lookup ostaju u ljusci.
 *
 * `preferMatching` je OPCIONO i menja izbor kada u kadru ima VIŠE kodova: na
 * nativnom putu bira među kodovima istog frejma (vidi `pickPreferredRaw`), a na
 * ZXing putu radi kao MEKI filter sa fallback-om (vidi `attachZXingToVideo`) —
 * ZXing javlja jedan kod po pogotku, pa se „pogrešan" kratko zadrži da bi se
 * sačekao pravi. Bez predikata je ponašanje bit-po-bit isto kao pre.
 */
export async function attachVideoDecoder(opts: {
  video: HTMLVideoElement;
  formats: DecodeFormat[];
  onRaw: (raw: string) => void;
  /** Ljuska javlja da li je još živa (stop-guard za async init). */
  isStopped?: () => boolean;
  /** Kad je u kadru više kodova — koji je „naš" (ekranu odgovarajući) format. */
  preferMatching?: (raw: string) => boolean;
  /**
   * Traži nativni BarcodeDetector i na Androidu (per-profil opt-in, 1.0 kanon —
   * v. `shouldUseNativeDetector`). Bez ovoga Android ostaje na ZXing-u.
   */
  preferNative?: boolean;
  /**
   * Klijent-rect VIZUELNOG nišana (okvir `ScanReticle`) — getter, jer se nišan
   * pomera uživo (donji panel raste/pada). Kad je gejt aktivan
   * (`shouldLimitScanToReticle()` — SAMO Samsung A-serija / debug prekidač),
   * pogodak čiji CENTAR padne van tog prozora (+margina) se IGNORIŠE kao da
   * koda nema — dekoderska zona i nišan tako postaju isti pravougaonik u video
   * prostoru. Svuda van gejta (S26, iPhone, desktop…) je ovo polje INERTNO:
   * getter se nikad ne zove i tok je identičan kao bez njega.
   */
  acceptRegion?: () => DOMRectReadOnly | null;
}): Promise<VideoDecoderHandle> {
  const { video, formats, onRaw, preferMatching, acceptRegion } = opts;
  const isStopped = opts.isStopped ?? (() => false);
  // Gejt „centar pogotka u nišanu" — `() => null` svuda van SM-A profila.
  const roiGate = createReticleGate(video, acceptRegion);

  // 1) Nativni BarcodeDetector — desktop Chromium / debug override / ekran koji
  //    ga eksplicitno traži (`preferNative`). Na Androidu NIJE default (1.0 kanon
  //    3cffea5): Samsung A-serija ima BD API koji delegira na GmsCore barcode
  //    modul — kad on fali, detect() zauvek vraća prazno ili BACA, a simptom u
  //    pogonu je „kamera radi, nikad ne skenira".
  if (shouldUseNativeDetector(opts.preferNative)) {
    const BD = (window as unknown as {
      BarcodeDetector: (new (o?: { formats?: string[] }) => NativeDetectorLike) & {
        getSupportedFormats?: () => Promise<string[]>;
      };
    }).BarcodeDetector;
    // Sanity (rupa i u 1.0): prazan getSupportedFormats() = servis iza API-ja mrtav.
    // TIMEOUT (01.08): mrtav GmsCore barcode modul ume da NIKAD ne razreši ovaj
    // poziv — bez trke sa tajmerom bi ceo `attachVideoDecoder` visio zauvek, pa bi
    // ljuska imala živ preview BEZ ijednog dekodera („kamera radi, ne skenira").
    // Istek se tretira kao nesposoban servis → ZXing put, isto kao prazan odgovor.
    let bdSane = true;
    try {
      if (typeof BD.getSupportedFormats === 'function') {
        let t = 0;
        const sup = await Promise.race([
          BD.getSupportedFormats(),
          new Promise<null>((r) => {
            t = window.setTimeout(() => r(null), BD_SANITY_TIMEOUT_MS);
          }),
        ]);
        if (t) clearTimeout(t);
        if (!Array.isArray(sup) || sup.length === 0) bdSane = false;
      }
    } catch {
      bdSane = false;
    }
    let detector: NativeDetectorLike | null = null;
    if (bdSane) {
      try {
        detector = new BD({ formats });
      } catch {
        try {
          detector = new BD();
        } catch {
          detector = null;
        }
      }
    }
    if (detector) {
      let rafId = 0;
      let live = true;
      let consecErrors = 0;
      // Ljuska je pozvala handle.stop() — mora da važi i za ZXing swap koji je u
      // letu (inače bi `await attachZXingToVideo` zakačio SIROČE petlju nad video
      // elementom koji ljuska upravo gasi; `isStopped` pokriva samo ljuskin flag,
      // a ovaj put se gasi i „lokalno", npr. pri zameni dekodera).
      let stopRequested = false;
      const dead = () => stopRequested || isStopped();
      const det = detector;
      // Mutabilan handle — watchdog sme da zameni put bez restarta ljuske/streama.
      const handle: VideoDecoderHandle = {
        path: 'native',
        stop: () => {
          stopRequested = true;
          live = false;
          cancelAnimationFrame(rafId);
        },
      };
      const swapToZXing = async () => {
        live = false;
        cancelAnimationFrame(rafId);
        console.warn('[decoder] BarcodeDetector servis ne radi — prelazim na ZXing');
        if (dead()) return;
        try {
          const inner = await attachZXingToVideo(video, formats, onRaw, dead, preferMatching, roiGate);
          // Ljuska je u međuvremenu (lazy ZXing chunk ume da traje) zatvorila skener
          // → ugasi tek pokrenutu petlju i NE diraj handle.
          if (dead()) {
            inner.stop();
            return;
          }
          handle.path = inner.path;
          handle.stop = () => {
            stopRequested = true;
            inner.stop();
          };
        } catch (e) {
          console.warn('[decoder] ZXing fallback nije uspeo:', e);
        }
      };
      const tick = async () => {
        if (!live || dead()) return;
        try {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const found = await det.detect(video);
            // `detect()` je asinhron: ljuska je DOK JE ON BIO U LETU mogla da
            // zatvori skener ili da restartuje kameru (novi start = nova
            // generacija) — pogodak iz starog kadra tada ne sme da ode u `onRaw`
            // (1.0 guard barcode.js:1031). Bez ovoga zatvoren skener ume da
            // „ispali" još jedan rezultat u roditelja posle zatvaranja.
            if (dead()) return;
            consecErrors = 0; // uspešan poziv servisa (i prazan kadar je uspeh)
            // Nišan-gejt (SM-A profil): kod čiji je centar van prozora nišana se
            // odbacuje PRE izbora — `boundingBox` je u istom (intrinsic video)
            // prostoru kao mapirani nišan. Bez geometrije = fail-open.
            const gate = roiGate();
            const hits = gate
              ? found.filter((f) => {
                  const b = f?.boundingBox;
                  if (!b) return true;
                  return gate(b.x + b.width / 2, b.y + b.height / 2);
                })
              : found;
            // Više kodova u kadru (npr. susedni red operacije na štampanom RN-u) →
            // pozivalac kroz `preferMatching` bira svoj format; bez predikata = prvi.
            const raw = pickPreferredRaw(
              hits.map((f) => (f?.rawValue ? String(f.rawValue) : '')),
              preferMatching,
            );
            if (raw) onRaw(raw);
          }
        } catch {
          // detect() koji BACA nije „nema koda u kadru" (to je prazan niz) — to je
          // servis koji ne radi („Barcode detection service unavailable"). Posle 10
          // uzastopnih grešaka vrući prelaz na ZXing umesto večitog gluvog skenera.
          //
          // SVESNO NIJE POKRIVENO: varijanta kvara u kojoj `detect()` uredno
          // resolve-uje ali VEČNO vraća prazan niz (GmsCore modul „instaliran a
          // neispravan"). Nema signala na koji bi se watchdog okačio — prazan niz
          // je nerazlučiv od legitimno praznog kadra (radnik koji traži barkod ili
          // drži telefon u džepu), pa bi svaki tajmer pre ili kasnije lažno okinuo
          // swap, a swap gasi i pali dekoder usred skeniranja. Ublaženja umesto
          // toga: `getSupportedFormats()` sanity pre starta (hvata većinu mrtvih
          // instalacija), nativni put NIJE Android default nego opt-in po ekranu
          // (`preferNative`), a na terenu ostaju izlazi bez koda — „Iz slike"/
          // „Slikaj barkod", ručni unos i debug prekidač `ss3_scan_decode_mode`
          // = 'zxing' koji taj telefon trajno prebaci na ZXing.
          consecErrors += 1;
          if (consecErrors >= 10) {
            void swapToZXing();
            return;
          }
        }
        if (live && !dead()) rafId = requestAnimationFrame(() => void tick());
      };
      rafId = requestAnimationFrame(() => void tick());
      return handle;
    }
  }

  const hasQr = formats.includes('qr_code');
  const oneD = formats.filter((f) => f !== 'qr_code');

  // 2) iOS + QR → jsQR hibrid (1.0 startIosLocationShelfQrHybrid, barcode.js:694-877).
  if (isIOSWebKit() && hasQr) {
    const IOS_JSQR_EVERY_MS = 78; // 1.0 barcode.js:681
    const IOS_ONED_ZX_MS = 400; // 1.0 barcode.js:682
    const [{ default: jsQR }, zx] = await Promise.all([import('jsqr'), loadZXing()]);
    // 1D set se sužava ISTO kao na čistom ZXing putu (:541-544): sve sa naših
    // nalepnica je Code128, suženje je ~2× brže i manje sklono lažnom ITF čitanju
    // gustog Code128 — a ovde je brzina još kritičnija, jer 1D pokušaj u hibridu
    // ionako dolazi na red tek svakih ~400 ms. Hibrid radi samo na iOS-u (uvek
    // „mobile"), pa `isMobileLike()` gejt sa ZXing puta ovde nije potreban.
    // Fallback na pun `oneD` je za slučaj da pozivalac uopšte ne traži Code128/39
    // — bez njega bi takva ljuska ostala potpuno bez 1D čitanja.
    const narrowedOneD = oneD.filter((f) => f === 'code_128' || f === 'code_39');
    const hybridOneD = narrowedOneD.length ? narrowedOneD : oneD;
    const oneDReader = hybridOneD.length
      ? new zx.BrowserMultiFormatReader(buildHints(zx, hybridOneD, true), readerOptions(false))
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
            // Nišan-gejt: na iOS-u NIJE u profilu (`shouldLimitScanToReticle` je
            // `false` bez debug prekidača) → `gate == null` i tok je identičan
            // starom. Kad ga terenska proba upali: koordinate su u DOWNSCALE
            // canvas prostoru, pa se centar vraća u video px po osi (vw/cw, vh/ch);
            // gejtovan QR pada na 1D granu kao da QR-a nema.
            const gate = roiGate();
            let qrText = qr?.data ? String(qr.data) : '';
            if (qrText && gate && qr) {
              const l = qr.location;
              const cx =
                ((l.topLeftCorner.x + l.topRightCorner.x + l.bottomLeftCorner.x + l.bottomRightCorner.x) / 4) *
                (vw / cw);
              const cy =
                ((l.topLeftCorner.y + l.topRightCorner.y + l.bottomLeftCorner.y + l.bottomRightCorner.y) / 4) *
                (vh / ch);
              if (Number.isFinite(cx) && Number.isFinite(cy) && !gate(cx, cy)) qrText = '';
            }
            if (qrText) onRaw(qrText);
            else if (oneDReader && now - lastOneDAt >= IOS_ONED_ZX_MS) {
              lastOneDAt = now;
              try {
                const res = (
                  oneDReader as unknown as {
                    decodeFromCanvas: (c: HTMLCanvasElement) => {
                      getText: () => string;
                      getResultPoints?: () => unknown;
                    };
                  }
                ).decodeFromCanvas(canvas);
                let text = res?.getText() || '';
                if (text && gate) {
                  const c = centerOfResultPoints(res.getResultPoints?.());
                  if (c && !gate(c.x * (vw / cw), c.y * (vh / ch))) text = '';
                }
                if (text) onRaw(text);
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

  // 3) ZXing nad <video> (ANDROID default — 1.0 kanon / iPhone item / Firefox…).
  return attachZXingToVideo(video, formats, onRaw, isStopped, preferMatching, roiGate);
}

/** Koliko se „pogrešan" kod drži pre nego što se ipak pusti (v. `preferMatching`). */
const ZX_PREFER_HOLD_MS = 400;

/**
 * ZXing `decodeFromVideoElement` put — izdvojen da bi ga koristio i BD watchdog
 * (vrući fallback bez restarta streama). Kadenca/hints = 1.0 paritet: item mobile
 * 28ms/150ms + TRY_HARDER + suženi formati; QR-mix 60ms/280ms.
 *
 * `preferMatching` (ISPRAVKA 01.08 — vraća N3 fix od 30.07 na Android, gde je
 * ZXing default): na štampanom radnom nalogu barkodovi operacija (`S:…`) stoje
 * jedan pod drugim iznad/ispod barkoda naloga, pa dekoder lako uhvati SUSEDNI
 * red; kako su ti kodovi međusobno slični i nisu jedinstveni, promašaj se ne
 * vidi. Nativni put bira među kodovima ISTOG frejma (`pickPreferredRaw`), ali
 * ZXing javlja po jedan kod, pa je ovde predikat MEKI FILTER SA FALLBACK-OM:
 *   • pogodak koji zadovoljava predikat (ili predikata nema) → `onRaw` odmah;
 *   • pogodak koji ga NE zadovoljava se ZADRŽI i ne javlja — sledećih ~400ms
 *     kamera ima priliku da uhvati pravi red; „istek" se meri na SLEDEĆEM pozivu
 *     callback-a, a ZXing ga zove neprekidno (promašaj 28-60ms, ponovljen pogodak
 *     150-280ms — v. `readerOptions`), pa zadržani kod ne može da ostane zarobljen;
 *   • ako pravi ne stigne, zadržani se pusti JEDNOM — ljuska tada daje svoju
 *     „pogrešan red / barkod operacije" poruku umesto tišine (isto kao pre fix-a).
 */
async function attachZXingToVideo(
  video: HTMLVideoElement,
  formats: DecodeFormat[],
  onRaw: (raw: string) => void,
  isStopped: () => boolean,
  preferMatching?: (raw: string) => boolean,
  roiGate?: () => RoiCenterGate | null,
): Promise<VideoDecoderHandle> {
  // Nišan-gejt getter — `null` gejt (profil van SM-A / bez regiona) = stari tok.
  const gateOf = roiGate ?? (() => null);
  const hasQr = formats.includes('qr_code');
  const oneD = formats.filter((f) => f !== 'qr_code');
  const zx = await loadZXing();
  // Item profil: suženi formati (CODE_128+CODE_39 brzina, 1.0 fd252cb/9388c8a);
  // TRY_HARDER na mobilnom (iPhone RNZ inače ne dekodira).
  //
  // SVESNA RAZLIKA OD ZATEČENOG BD PONAŠANJA: nativni detektor je na živoj kameri
  // čitao i `itf`/`ean_13` iz prosleđenog seta; ovde se na mobilnom item profilu
  // set namerno sužava na Code128+Code39 jer je to 1.0 kanon (sve što se skenira
  // sa nalepnice — RNZ, crtež, polica — je Code128), a suženje je ~2× brže i
  // manje sklono lažnom ITF čitanju gustog Code128. Pun set ostaje na „Iz slike"
  // putu (`decodeImageFile`), gde brzina nije kritična.
  const liveFormats: DecodeFormat[] =
    !hasQr && isMobileLike()
      ? oneD.filter((f) => f === 'code_128' || f === 'code_39')
      : formats;
  const reader = new zx.BrowserMultiFormatReader(
    buildHints(zx, liveFormats.length ? liveFormats : formats, isMobileLike()),
    readerOptions(hasQr),
  );
  // Zadržani „pogrešan" pogodak (v. JSDoc iznad) — najviše jedan u datom trenutku.
  let held: { raw: string; at: number } | null = null;
  let controls: { stop: () => void };
  try {
    controls = await reader.decodeFromVideoElement(video, (result, err) => {
      if (isStopped()) return;
      const now = Date.now();
      let text = result?.getText() || '';
      // Nišan-gejt (SM-A profil): capture canvas ZXing-a je 1:1 sa video px
      // (`createCaptureCanvas` = videoWidth×videoHeight; OneDReader na TRY_HARDER
      // reverse dekodu vraća ogledalo tačaka — koordinate su uvek u pravom
      // prostoru). Pogodak čiji je CENTAR van prozora nišana postaje PROMAŠAJ:
      // ne javlja se i NE ulazi u held slot — kao da koda u kadru nema. Bez
      // result-points geometrije = fail-open (pogodak prolazi kao do sada).
      if (text) {
        const gate = gateOf();
        if (gate) {
          const c = centerOfResultPoints(result?.getResultPoints?.());
          if (c && !gate(c.x, c.y)) text = '';
        }
      }
      if (text) {
        let matches = true;
        if (preferMatching) {
          try {
            matches = preferMatching(text);
          } catch {
            matches = true; // predikat pozivaoca ne sme da obori dekoder
          }
        }
        if (matches) {
          held = null; // pravi kod uvek poništava zadržani
          onRaw(text);
          return;
        }
        // Nov „pogrešan" kod počinje svoj prozor; isti se NE osvežava (inače bi
        // stacionaran susedni red zauvek odlagao fallback poruku).
        if (!held || held.raw !== text) held = { raw: text, at: now };
      } else if (err && !isDecodeMissError(zx, err)) {
        // Prava greška (ne miss) — samo log; ljuska ima svoj error-put za kameru.
        console.warn('[decoder] zxing:', err);
      }
      if (held && now - held.at >= ZX_PREFER_HOLD_MS) {
        const raw = held.raw;
        held = null;
        onRaw(raw);
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

/**
 * Zagrevanje dekoder chunk-ova PRE otvaranja skener overlay-a — fire-and-forget.
 *
 * ZAŠTO: ZXing se učitava LAZY (~250KB gzip) tek pri prvom dekodiranju, pa je u
 * 1.0 postojao poznat simptom „crn ekran / kamera radi ali ništa ne skenira dok
 * se chunk vuče" na slaboj pogonskoj mreži. Od prelaska Androida sa
 * BarcodeDetector-a na ZXing (v. `shouldUseNativeDetector`) to više nije edge
 * case nego SVAKI Android telefon u pogonu — zato ljuske ovo zovu na mount,
 * paralelno sa `getUserMedia` (dok korisnik čeka permisiju/preview, chunk stiže).
 *
 * Ne vraća promise i NIKAD ne baca: pozivalac ne sme ništa da čeka, a neuspeh
 * (mreža) se svejedno prijavljuje na regularnom putu kad dekoder zatreba.
 */
export function preloadVideoDecoder(formats: DecodeFormat[]): void {
  if (typeof window === 'undefined') return;
  // Namerno BEZ `preferNative`: ekran koji traži nativni put na Androidu i dalje
  // može da sklizne na ZXing (watchdog kad GmsCore barcode modul ne radi), pa mu
  // zagrejan chunk treba. Gate ostaje samo za teren gde je nativni put siguran
  // (desktop Chromium / debug override) — tamo se chunk stvarno ne vuče.
  if (shouldUseNativeDetector()) return; // nativni put ne vuče nikakav chunk
  // `.catch` je obavezan — golo `void loadZXing()` bi na padu mreže dalo
  // unhandled rejection u konzoli (i Sentry šum), a ovde je pad očekivan.
  loadZXing().catch(() => {
    /* best-effort zagrevanje */
  });
  if (isIOSWebKit() && formats.includes('qr_code')) {
    // iOS QR ide kroz jsQR hibrid — i taj chunk ima smisla zagrejati.
    import('jsqr').catch(() => {
      /* best-effort zagrevanje */
    });
  }
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

// ── Android post-start tuning (1.0 barcode.js:484-659) ─────────────────────

/**
 * `applyConstraints` compat wrapper (1.0 `safeApplyFlatCompat`, barcode.js:484-506):
 * na ANDROIDU prvo `{advanced:[flat]}` pa flat; svuda drugde obrnuto. Redosled je
 * load-bearing — pogrešan na Samsungu tiho ignoriše torch/zoom/focus podešavanja.
 */
export async function safeApplyFlatCompat(
  track: MediaStreamTrack,
  flat: Record<string, unknown>,
): Promise<boolean> {
  const attempts: MediaTrackConstraints[] = isAndroidWeb()
    ? [{ advanced: [flat] } as MediaTrackConstraints, flat as MediaTrackConstraints]
    : [flat as MediaTrackConstraints, { advanced: [flat] } as MediaTrackConstraints];
  for (const c of attempts) {
    try {
      await track.applyConstraints(c);
      return true;
    } catch {
      /* probaj sledeći oblik */
    }
  }
  return false;
}

/**
 * Best-effort štelovanje ZADNJE kamere posle starta — SAMO Android (1.0 lekcije
 * sa Samsung A17/A26; iOS je namerno izuzet). Zvati kad je video spreman
 * (`loadedmetadata`), nikad pre. Sve je try/catch — pad ne sme da obori sken.
 *
 * 1. Anti-glare: `exposureCompensation` ≈ −0.45 (tamniji kadar = manje specular
 *    odsjaja kroz providnu foliju na nalepnici) — 1.0 barcode.js:640-659.
 * 2. AF: ako je focusMode već `auto`/`continuous` — NE DIRATI (Samsung smart AF:
 *    PDAF + laser + scene detection; forsiranje je pokvarilo i S26 — 1.0 revert
 *    e126868). `manual`/prazan → probaj `continuous`, pa `single-shot` + centar
 *    POI (1.0 barcode.js:588-632).
 */
export async function applyAndroidPostStartTuning(track: MediaStreamTrack): Promise<void> {
  if (!isAndroidWeb()) return;
  interface Caps {
    exposureCompensation?: { min?: number; max?: number };
    focusMode?: string[];
  }
  let caps: Caps = {};
  try {
    caps = (track.getCapabilities?.() ?? {}) as Caps;
  } catch {
    caps = {};
  }
  // 1) Anti-glare ekspozicija.
  try {
    const ec = caps.exposureCompensation;
    const min = Number(ec?.min);
    const max = Number(ec?.max);
    if (ec && Number.isFinite(min) && min < -0.05) {
      const target = Math.max(min, Math.min(Number.isFinite(max) ? max : 0, -0.45));
      await safeApplyFlatCompat(track, { exposureCompensation: target });
    }
  } catch {
    /* best-effort */
  }
  // 2) AF režim.
  try {
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    let current = '';
    try {
      current = String(
        (track.getSettings?.() as { focusMode?: string } | undefined)?.focusMode ?? '',
      );
    } catch {
      current = '';
    }
    if (current === 'auto' || current === 'continuous') return; // Samsung smart AF — ne diraj
    if (modes.includes('continuous')) {
      await safeApplyFlatCompat(track, { focusMode: 'continuous' });
    } else if (modes.includes('single-shot')) {
      await safeApplyFlatCompat(track, {
        focusMode: 'single-shot',
        pointsOfInterest: [{ x: 0.5, y: 0.5 }],
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Pauza PRE novog getUserMedia posle stop() — Samsung Internet oslobađa kameru sa
 * ~200-400ms kašnjenja (1.0 barcode.js:298-314); bez pauze drugi sken u sesiji
 * vraća NotReadableError ili zaglavljen stream. iOS ima svoju manju pauzu.
 */
export function cameraCooldownMs(): number {
  if (isSamsungInternetBrowser()) return 450;
  if (isIOSWebKit()) return 180;
  return 0;
}
