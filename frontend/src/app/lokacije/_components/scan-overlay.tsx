'use client';

import { useEffect, useRef, useState } from 'react';
import {
  X,
  Zap,
  SwitchCamera,
  Image as ImageIcon,
  RotateCcw,
  ZoomIn,
  Repeat,
  Check,
  Type,
} from 'lucide-react';
import { lookupLocBarcode, type LocBarcodeKind, type LocBarcodeResult } from '@/api/lokacije';
import { useEscapeLayer } from '@/components/ui-kit/escape-layer';
import {
  cropTopRightLabelRegion,
  isOcrEngineAvailable,
  parsePredmetTpFromLabelText,
  recognizeLabelText,
  terminateLabelOcrWorker,
} from '@/lib/label-ocr';
import {
  attachVideoDecoder,
  buildVideoConstraints,
  decodeImageFile,
  isCameraDecodeSupported,
  pickPreferredRaw,
  preloadVideoDecoder,
  shouldLimitScanToReticle,
  type DecodeFormat,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';
import {
  hasStoredCameraChoice,
  pickPreferredBackCamera,
  rememberManualCameraChoice,
  shouldRunCameraPicker,
} from '@/lib/camera-picker';
import {
  looksLikeLocItemBarcode,
  looksLikeOperationBarcode,
  OPERATION_BARCODE_HINT,
} from '@/lib/loc-barcode-shape';
import { buildScanDiag, primeDeviceModelHint, type ScanDiag } from '@/lib/camera-controls';
import { ScanDiagLine } from '@/components/ui-kit/scan-camera-controls';
import { ScanReticle } from '@/components/ui-kit/scan-reticle';
import { ScanHint } from '@/components/ui-kit/scan-hint';
import { useVisualViewportFix } from '@/lib/use-visual-viewport-fix';
import { useScanPanelInset } from '@/lib/use-scan-panel-inset';
import { useHidScanBuffer } from '@/lib/use-hid-scan-buffer';
import { confirmHardResetApp, HARD_RESET_LABEL } from '@/lib/app-hard-reset';

/*
 * Punoekranski skener barkoda za Lokacije — pun port bogatog 1.0 scanModal-a
 * (src/ui/lokacije/scanModal.js, 2757 lin) na 2.0 stack. Dekodiranje ide kroz
 * zajednički decode-engine (`@/lib/barcode-decoder`): BarcodeDetector (Chromium)
 * / ZXing (iPhone item, Firefox, Safari desktop) / jsQR hibrid (iOS + QR) — pa
 * kamera RADI i na iPhone-u (1.0 lekcija: gejt je getUserMedia, ne BarcodeDetector).
 * HID/„Unesi ručno" put ostaje. Napredni kamera-režimi iznad toga:
 *   • Multi-lens izbor objektiva (Samsung A-serija macro/ultra-wide fix) sa
 *     zapamćenim izborom + auto-skok sa „lošeg" objektiva (label + capability heuristika)
 *     + capability picker (`@/lib/camera-picker`) za PRVI izbor sočiva na Androidu.
 *   • Otvaranje kamere sa retry-jem na prolazne greške (NotReadableError/AbortError/
 *     TrackStartError) i duplim rAF-om posle release-a — 1.0 barcode.js:1120-1144.
 *   • Zoom (auto 2× + slider/±) gde uređaj izlaže track zoom capability (Android Chrome/desktop).
 *   • Baterijska lampa (torch) toggle (gde je podržan; Android web ga skriva kao 1.0).
 *   • Tap-to-focus na video (single-shot pointsOfInterest) + vizuelni focus ring.
 *   • Kontinuirano/batch skeniranje (multi-scan sesija — skener ostaje otvoren, lista pogodaka).
 *   • „Iz slike" dekodiranje (BarcodeDetector nad ImageBitmap fajla — screenshot iz Viber-a/mejla).
 *   • iOS Safari rukovanje: playsinline, visualViewport korekcija (URL bar), CriOS/FxiOS blok,
 *     standalone-PWA detekcija, Samsung Internet release pauze, pagehide/visibility cleanup.
 *   • Dijagnostika kamere (front/back + rezolucija + objektiv N/M), app verzija, „Osveži app"
 *     (hard reload), i mapiranje sirovih getUserMedia grešaka u čitljive poruke.
 *
 * `accept` filtrira dozvoljene tipove; dvokoračni tok stavka→destinacija roditelj
 * bira otvaranjem skenera dvaput (accept=['ITEM'] pa accept=['SHELF']). SHELF poruka
 * pariteta (nejednoznačna polica) prikazuje se kao greška, ne rezultat. BE
 * (lookupLocBarcode) razrešava RNZ/short/compact (stavka) + LP:/„HALA - POLICA"/šifra
 * police (destinacija) i radi BigTehn/ERP dopunu — pa je pre-popuna forme posao
 * roditelja (movement-dialog) preko onResult; skener predaje razrešeni rezultat.
 */

// ── Nativni BarcodeDetector ────────────────────────────────────────────────
interface DetectedBarcode {
  rawValue: string;
  format?: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorStatic {
  getSupportedFormats?: () => Promise<string[]>;
}
type BarcodeDetectorCtor = (new (opts?: { formats?: string[] }) => BarcodeDetectorLike) &
  BarcodeDetectorStatic;

function getDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

// ── Prošireni tipovi za eksperimentalne kamera-constraint-e ─────────────────
// lib.dom nema torch/zoom/focusMode/pointsOfInterest/exposureCompensation ni na
// constraint-ima ni na capabilities/settings — deklarišemo ih ovde i kastujemo.
type RangeCap = { min?: number; max?: number; step?: number };
interface CamCapabilities {
  torch?: boolean;
  zoom?: RangeCap | number;
  focusMode?: string[];
  pointsOfInterest?: unknown;
  exposureCompensation?: RangeCap;
  width?: { min?: number; max?: number };
  height?: { min?: number; max?: number };
}
interface CamSettings {
  torch?: boolean;
  zoom?: number;
  focusMode?: string;
  deviceId?: string;
  width?: number;
  height?: number;
}
type FlatConstraint = Record<string, unknown>;

// ── Platform detekcija (paritet scanModal.js / barcode.js) ──────────────────
function ua(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
}
/** Safari na iPhone/iPad (uklj. iPadOS koji lažira Mac UA — `ontouchend`). */
function isIOSWebPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const u = ua();
  if (/iPad|iPhone|iPod/i.test(u)) return true;
  return u.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document;
}
function isAndroidWebPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Android/i.test(ua())) return true;
  try {
    const uad = (navigator as unknown as { userAgentData?: { mobile?: boolean; brands?: { brand?: string }[] } })
      .userAgentData;
    if (uad?.mobile === true && Array.isArray(uad.brands)) {
      const brands = uad.brands.map((b) => String(b.brand || '')).join(' ');
      if (/Android/i.test(brands)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
function isAndroidChromeBrowser(): boolean {
  if (!isAndroidWebPlatform()) return false;
  const u = ua();
  if (/Firefox|SamsungBrowser|EdgA/i.test(u)) return false;
  return /Chrome\//.test(u);
}
function isSamsungInternetBrowser(): boolean {
  return /SamsungBrowser/i.test(ua());
}
/** Android web skriva torch/zoom kao u 1.0 (nepouzdano na budget ROM-ovima). */
function isAndroidWebCameraTorchZoomHidden(): boolean {
  return isAndroidWebPlatform();
}

function normalize(raw: string): string {
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) t = t.slice(1, -1);
  const zw = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
  return [...t].filter((ch) => !zw.has(ch.codePointAt(0)!)).join('').trim();
}

const KIND_HINT: Record<LocBarcodeKind, string> = {
  ITEM: 'Stavka (predmet/TP)',
  SHELF: 'Polica / lokacija',
  OPERATION: 'Barkod operacije (prijava rada)',
  UNKNOWN: 'Nepoznat format',
};

const APP_VERSION =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_BUILD_ID
    ? process.env.NEXT_PUBLIC_BUILD_ID
    : 'dev';

// ── Mapiranje getUserMedia grešaka u čitljive poruke (paritet scanModal.js) ─
function cameraBlockedUserHint(): string {
  if (isAndroidWebPlatform()) {
    return '🚫 Kamera je blokirana — Podešavanja → Aplikacije → tvoj pregledač (Chrome, Samsung Internet…) → Dozvole → Kamera → Dozvoli, pa osveži stranicu';
  }
  if (isIOSWebPlatform()) {
    return '🚫 Kamera je blokirana — Podešavanja → Safari → Kamera → Dozvoli, pa otvori link ponovo';
  }
  return '🚫 Kamera je blokirana — u adresnoj traci klikni ikonicu kamere i dozvoli pristup, ili u podešavanjima pregledača: privatnost / dozvole za sajt → Kamera';
}
function formatCameraError(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name || '';
  const msg = e?.message || String(err);
  if (name === 'NotAllowedError' || /denied|blocked/i.test(msg)) return cameraBlockedUserHint();
  if (name === 'NotFoundError' || /no.*camera|not found/i.test(msg))
    return '🚫 Nije pronađena kamera na uređaju';
  if (name === 'NotReadableError' || /in use|busy/i.test(msg)) {
    return isIOSWebPlatform()
      ? '🚫 Kamera je zauzeta — zatvori FaceTime ili Kamera aplikaciju i probaj ponovo'
      : '🚫 Kamera je zauzeta — zatvori druge aplikacije koje koriste kameru i probaj ponovo';
  }
  if (name === 'SecurityError' || /secure|https/i.test(msg))
    return '🚫 Kamera radi samo preko HTTPS — otvori sa `https://…`';
  return `⚠ Kamera: ${msg}`;
}

/** iOS Safari „rupe" koje blokiraju kameru PRE getUserMedia-a. */
function detectIOSCameraPitfalls(): { blocker?: string; warning?: string } {
  if (!isIOSWebPlatform()) return {};
  const u = ua();
  if (/CriOS|FxiOS|EdgiOS/i.test(u)) {
    return {
      blocker:
        '🚫 Chrome/Firefox na iPhone-u ne može kameru. Otvori isti link u Safari-ju (tamna ikona kompasa).',
    };
  }
  const isStandalone =
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (isStandalone) {
    const m = u.match(/OS (\d+)[_.](\d+)/);
    const major = m ? parseInt(m[1], 10) : 0;
    const minor = m ? parseInt(m[2], 10) : 0;
    if (major && (major < 16 || (major === 16 && minor < 4))) {
      return {
        blocker:
          `🚫 iOS ${major}.${minor} ne dopušta kameru u „Add to Home Screen" aplikaciji. ` +
          'Ukloni ikonu sa home screen-a i otvori u Safari tabu, ili ažuriraj iOS na 16.4+.',
      };
    }
    return { warning: 'iOS standalone (16.4+) — ako ne radi, probaj u Safari tabu' };
  }
  return {};
}

// Tvrdo osvežavanje („Resetuj aplikaciju", do 02.08.2026 „Osveži app") =
// `lib/app-hard-reset.ts` (zajedničko sa reversi ljuskom).
// Ovde je do 02.08.2026 stajala lokalna kopija koja je brisala SVE SW registracije i
// SVE keševe origin-a — uključujući 1.0-ine (v. JSDoc u tom modulu).

/** Klijent → normalizovane [0,1] koordinate video kadra kod object-fit:cover. */
function mapPointerToVideoNormalizedPlane(
  videoEl: HTMLVideoElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = videoEl.getBoundingClientRect();
  const vw = videoEl.videoWidth || 0;
  const vh = videoEl.videoHeight || 0;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  if (!rect.width || !rect.height) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  if (!vw || !vh) return { x: clamp(px / rect.width), y: clamp(py / rect.height) };
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = (rect.width - dispW) / 2;
  const offY = (rect.height - dispH) / 2;
  return { x: clamp((px - offX) / dispW), y: clamp((py - offY) / dispH) };
}

/** applyConstraints sa advanced/flat kompat pokušajima (Android voli advanced). */
async function safeApplyFlat(
  track: MediaStreamTrack,
  flat: FlatConstraint,
  isAndroid: boolean,
): Promise<boolean> {
  if (!track?.applyConstraints) return false;
  const attempts = isAndroid
    ? [
        () => track.applyConstraints({ advanced: [flat] } as unknown as MediaTrackConstraints),
        () => track.applyConstraints(flat as unknown as MediaTrackConstraints),
      ]
    : [
        () => track.applyConstraints(flat as unknown as MediaTrackConstraints),
        () => track.applyConstraints({ advanced: [flat] } as unknown as MediaTrackConstraints),
      ];
  for (const run of attempts) {
    try {
      await run();
      return true;
    } catch {
      /* pokušaj sledeći oblik */
    }
  }
  return false;
}

/** „Loš" zadnji objektiv po labeli (macro/ultra-wide/depth). */
function isObviouslyBadBackLens(label: string): boolean {
  return /\b(macro|ultra|ultra[-\s]?wide|telephoto|depth|tof|fish[-\s]?eye)\b/.test(
    String(label || '').toLowerCase(),
  );
}
/** Capability-heuristika: kvadratni ≤1080 senzor = tipičan macro/depth. */
function isCapabilityBadLens(track: MediaStreamTrack | null): boolean {
  if (!track?.getCapabilities) return false;
  const caps = track.getCapabilities() as unknown as CamCapabilities;
  const settings = (track.getSettings?.() as unknown as CamSettings) || {};
  const maxW = Number(caps.width?.max || settings.width || 0);
  const maxH = Number(caps.height?.max || settings.height || 0);
  if (maxW <= 0 || maxH <= 0) return false;
  return maxW === maxH && maxW <= 1080;
}

/** Kamera izbor keš (localStorage) — zapamti user-ov objektiv 30 dana. */
const CAM_CHOICE_KEY = 'loc_scan_cam_choice_v1';
const CAM_CHOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function readCamChoice(): { deviceId: string; label: string } | null {
  try {
    const raw = localStorage.getItem(CAM_CHOICE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { deviceId?: string; label?: string; at?: number };
    if (!p?.deviceId) return null;
    if (p.at && Date.now() - p.at > CAM_CHOICE_TTL_MS) return null;
    return { deviceId: p.deviceId, label: p.label || '' };
  } catch {
    return null;
  }
}
function writeCamChoice(deviceId: string, label: string): void {
  try {
    localStorage.setItem(CAM_CHOICE_KEY, JSON.stringify({ deviceId, label, at: Date.now() }));
  } catch {
    /* quota — ignore */
  }
}

/**
 * Zagrevanje capability-pickera PRI ZATVARANJU skenera (01.08).
 *
 * ZAŠTO: na Chrome-u/Androidu pre nego što je kamera ijednom odobrena,
 * `enumerateDevices()` vraća JEDAN placeholder bez labele — picker tada
 * strukturno ne može da radi (`backs.length <= 1` → null), pa je PRVA sesija na
 * multi-lens telefonu uvek `facingMode` lutrija (Samsung A-serija ume da vrati
 * macro objektiv: preview radi, barkod se nikad ne dekodira). Posle prve sesije
 * permisija POSTOJI i labele su vidljive — pa se izbor može izmeriti mirno, dok
 * niko ne skenira, i keširati za sledeće otvaranje (svih ljuski, keš je zajednički).
 *
 * Zove se iz cleanup-a TEK POSLE `stopStream()` — probe otvara kameru, pa naš
 * stream mora prvo da bude pušten; povrh toga se čeka OS cooldown, inače prvi
 * probe padne NotReadableError i picker uzorak ostane nepotpun (tada se namerno
 * NE kešira). Sve je fire-and-forget: ništa se ne čeka i ništa se ne prijavljuje.
 */
function warmCameraPickerAfterClose(): void {
  if (typeof window === 'undefined') return;
  if (!shouldRunCameraPicker() || hasStoredCameraChoice()) return;
  window.setTimeout(() => {
    // Stranica je u međuvremenu otišla u pozadinu (ili je drugi skener već upisao
    // izbor) — ne otimaj kameru u pozadini i ne troši probe bez potrebe.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (hasStoredCameraChoice()) return;
    void pickPreferredBackCamera().catch(() => {
      /* best-effort zagrevanje — regularni put i dalje radi bez keša */
    });
  }, 600);
}

type StatusKind = 'info' | 'ok' | 'warn' | 'error';
type BatchRow = { code: string; kind: LocBarcodeKind; at: number };

interface ScanCtrl {
  resolve: (raw: string) => Promise<void>;
  handleFile: (file: File) => Promise<void>;
  ocrScan: () => Promise<void>;
  cycleLens: () => Promise<void>;
  toggleTorch: () => Promise<void>;
  setZoom: (v: number) => void;
  tapFocus: (clientX: number, clientY: number) => Promise<void>;
  restart: () => Promise<void>;
}

/**
 * @param continuous  Kada je `true`, skener startuje u batch (multi-scan) režimu i
 *   NE zatvara se posle pogotka — svaki rezultat ide u onResult i u vidljivu listu.
 *   Default `false` (jednokratno: onResult → onClose), pa postojeći pozivaoci rade isto.
 *   Korisnik može i u toku rada da uključi „Neprekidno" prekidačem.
 */
export function ScanOverlay({
  title = 'Skeniraj barkod',
  accept = ['ITEM', 'SHELF'],
  continuous = false,
  onResult,
  onClose,
}: {
  title?: string;
  accept?: LocBarcodeKind[];
  continuous?: boolean;
  onResult: (r: LocBarcodeResult) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ctrlRef = useRef<ScanCtrl | null>(null);
  // Okvir nišana → `acceptRegion` dekodera (nišan-gejt, SAMO Samsung A-serija:
  // v. `shouldLimitScanToReticle` u `lib/barcode-decoder`). Na svim ostalim
  // uređajima getter se nikad ne poziva i ponašanje je identično dosadašnjem.
  const reticleBoxRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<StatusKind>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [diag, setDiag] = useState<ScanDiag | null>(null);
  const [iosBlocker, setIosBlocker] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomCap, setZoomCap] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoomValue, setZoomValue] = useState(1);
  const [lens, setLens] = useState<{ count: number; idx: number }>({ count: 0, idx: -1 });
  const [continuousOn, setContinuousOn] = useState(!!continuous);
  const [results, setResults] = useState<BatchRow[]>([]);
  // `ok:false` = tap je primljen ali uređaj NE podržava ručno izoštravanje (v. `tapFocus`).
  const [focusRing, setFocusRing] = useState<{
    x: number;
    y: number;
    id: number;
    ok: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const acceptItem = accept.includes('ITEM');

  // Plutajući donji panel: meri se i predaje nišanu kao donji odmak — inače panel
  // (z-10, do 62% visine) prekrije nišan na malom ekranu (v. `use-scan-panel-inset`).
  const [panelRef, panelInset] = useScanPanelInset<HTMLDivElement>();

  // Props se prosleđuju kao inline literali (nov identitet svaki render); držimo ih
  // u ref-u da kamera-efekat (mount-only) ne restartuje kameru na svaki render roditelja.
  const cbRef = useRef({ accept, onResult, onClose });
  useEffect(() => {
    cbRef.current = { accept, onResult, onClose };
  });

  // Skener je najgornji modalni sloj dok je otvoren — Esc zatvara NJEGA, i ne
  // curi na dijalog ispod (v. `ui-kit/escape-layer.ts`).
  useEscapeLayer(true, () => cbRef.current.onClose());

  // Safari URL traka guta gornji deo kadra. Isti kod je do 02.08.2026 stajao inline
  // u kamera-efektu ISPOD (`needsVV`/`bindVV`) i postojao je SAMO ovde — izvučen je
  // u `@/lib/use-visual-viewport-fix` i primenjen i u reversi / mob-održavanje /
  // montaža ljusci, koje su ga do sada nisu imale.
  useVisualViewportFix(rootRef);

  // HID/Bluetooth čitač dok je skener otvoren: polje ručnog unosa NIJE fokusirano na
  // telefonu (`autoFocus` je pod `pointer: fine` gardom — soft tastatura bi pokrila
  // kadar), a globalni hvatač radnog stola ćuti dok je otvoren `[aria-modal]` sloj.
  // Bez ovog lokalnog bafera keyboard-wedge sken pada u prazno (v. `use-hid-scan-buffer`).
  useHidScanBuffer(true, (code) => void ctrlRef.current?.resolve(code));

  const continuousRef = useRef(continuousOn);
  useEffect(() => {
    continuousRef.current = continuousOn;
  }, [continuousOn]);

  useEffect(() => {
    const pitfalls = detectIOSCameraPitfalls();
    if (pitfalls.warning) console.warn('[scan] iOS:', pitfalls.warning);

    // Mutable engine state (u closure-u efekta — bez re-render zavisnosti).
    let stopped = false;
    // Decode-engine (lib/barcode-decoder): BarcodeDetector / ZXing / jsQR hibrid
    // — bira se po platformi, pa iPhone (WebKit bez BarcodeDetector-a) RADI.
    let decoder: VideoDecoderHandle | null = null;
    let decoderSeq = 0; // poništava zakasneli async attach posle restarta kamere
    let zoomTimer = 0;
    let backCams: MediaDeviceInfo[] = [];
    let curDeviceId: string | null = null;
    let autoSwitchAttempts = 0;
    let forcedBackDone = false; // one-shot: force-back kamera se pokušava najviše jednom
    const busyRef = { v: false };
    const cameraOnRef = { v: false };
    const lastRef = { code: '', at: 0 };
    // Kontinuirani re-arm: isti kod se ponovo prihvata TEK kad napusti kadar (miss ili
    // drugi kod duže od REARM_GAP_MS), ne po isteku fiksnog tajmera — stacionarni barkod
    // se NE duplira. REPEAT_GUARD_MS = kratki anti-double gard za ručni/HID unos.
    const REARM_GAP_MS = 900;
    const REPEAT_GUARD_MS = 700;
    // DVA ODVOJENA re-arm slota (ISPRAVKA 01.08): prihvaćen i odbijen kod se pamte
    // nezavisno. Ranije je postojao jedan slot koji je `resolve` punio PRE BE
    // lookup-a, pa je odbijen kod (barkod operacije `S:…` iz susednog reda na
    // štampanom RN-u, tuđi tip u ovom koraku…) IZBACIVAO prihvaćeni nalog iz slota
    // — čim se nalog vrati u kadar, u kontinuiranom režimu bi bio obrađen DRUGI PUT.
    // Odbijeni kod svejedno mora da ima svoj slot: bez njega bi stacionaran pogrešan
    // barkod terao BE lookup na svaki frejm (mrežni spam + treperenje poruke).
    const heldRef = { code: '', seenAt: 0 }; // poslednji PRIHVAĆEN kod
    const rejectedRef = { code: '', seenAt: 0 }; // poslednji ODBIJEN kod
    let saidNoFocusSupport = false; // jednom po sesiji (v. `tapFocus`)

    const say = (msg: string, kind: StatusKind = 'info') => {
      setStatus(msg);
      setStatusKind(kind);
    };

    const getTrack = (): MediaStreamTrack | null => {
      const ms = videoRef.current?.srcObject;
      if (!(ms instanceof MediaStream)) return null;
      return ms.getVideoTracks()[0] || null;
    };

    // (`position:fixed` prati LAYOUT viewport a kamera VISUAL — korekcija je od
    // 02.08.2026 u zajedničkom hook-u `useVisualViewportFix`, pozvanom iznad.)

    const stopStream = () => {
      decoderSeq++;
      try {
        decoder?.stop();
      } catch {
        /* ignore */
      }
      decoder = null;
      // 1.0 releaseVideoStream: na iOS-u prvo pause() — WebKit inače ume da
      // zadrži pipeline i sledeći getUserMedia vrati NotReadableError.
      if (isIOSWebPlatform()) {
        try {
          videoRef.current?.pause();
        } catch {
          /* ignore */
        }
      }
      const ms = videoRef.current?.srcObject;
      if (ms instanceof MediaStream) {
        for (const t of ms.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
      }
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.load();
        }
      } catch {
        /* ignore */
      }
      setTorchOn(false);
    };

    // Dva rAF ciklusa posle release-a kamere (1.0 barcode.js: „release pa dva
    // frejma"): tek kad kompozitor obradi dva frejma je prethodni video pipeline
    // stvarno srušen — inače sledeći getUserMedia na Androidu/SI ume da vrati
    // NotReadableError ili zaglavljen (crn) stream.
    const twoRafs = (): Promise<void> =>
      new Promise<void>((r) => {
        if (typeof requestAnimationFrame !== 'function') {
          r();
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      });

    // „Kamera zauzeta" odmah po otvaranju NIJE trajna greška (1.0 barcode.js:1120-1144):
    // OS oslobađa senzor sa zakašnjenjem posle prethodne sesije/aplikacije, pa
    // isti constraints iz drugog pokušaja prolaze. Proveravamo i name i poruku —
    // pregledači ih različito pune (Chrome: „Could not start video source").
    const isTransientCameraError = (err: unknown): boolean => {
      const e = err as { name?: string; message?: string } | null;
      const re = /NotReadableError|AbortError|TrackStartError|could not start video source/i;
      return re.test(String(e?.name || '')) || re.test(String(e?.message || ''));
    };

    // Formati po koraku (ITEM-only nema QR) — jedno mesto za kameru, sliku i preload.
    const decodeFormats = (): DecodeFormat[] =>
      cbRef.current.accept.includes('SHELF')
        ? ['code_128', 'code_39', 'itf', 'ean_13', 'qr_code']
        : ['code_128', 'code_39', 'itf', 'ean_13'];

    // ── BE razrešavanje (paritet: ITEM/SHELF/UNKNOWN poruke iz 1.0) ──────────
    const resolve = async (raw: string): Promise<void> => {
      const code = normalize(raw);
      if (!code || busyRef.v) return;
      const now = Date.now();
      // Kratki gard protiv slučajnog dvostrukog slanja VEĆ PRIHVAĆENOG koda
      // (ručni/HID); kontinuirani kamera-put re-arm rešava „napustio kadar" gejt
      // u decode petlji (heldRef/rejectedRef).
      if (code === lastRef.code && now - lastRef.at < REPEAT_GUARD_MS) return;
      busyRef.v = true;
      setBusy(true);
      // Slotovi se pune TEK PO ISHODU (v. deklaracije iznad): dok lookup traje,
      // ponovljeni pogoci istog koda su ionako odbijeni `busyRef` gardom.
      let accepted = false;
      try {
        const { data } = await lookupLocBarcode(code);
        // Barkod OPERACIJE (`S:…`) nije „nepoznat format" nego POGREŠAN RED na
        // papiru — reci tačno gde je barkod naloga (poruka dolazi sa BE-a, pa su
        // mobilni i desktop identični; `OPERATION_BARCODE_HINT` je fallback).
        if (data.kind === 'OPERATION') {
          say(data.message ?? OPERATION_BARCODE_HINT, 'warn');
          return;
        }
        if (data.kind === 'UNKNOWN') {
          // Stariji backend (pre `kind:'OPERATION'`) vrati UNKNOWN — prepoznaj lokalno.
          if (looksLikeOperationBarcode(code)) {
            say(OPERATION_BARCODE_HINT, 'warn');
            return;
          }
          say(`Nepoznat format: ${code}`, 'error');
          return;
        }
        if (!cbRef.current.accept.includes(data.kind)) {
          say(`${KIND_HINT[data.kind]} nije dozvoljen u ovom koraku`, 'error');
          return;
        }
        // SHELF nejednoznačan / nerazrešen → poruka pariteta, ne prosleđuj.
        if (data.kind === 'SHELF' && !data.record) {
          say(data.message ?? `Lokacija ${code} nije jednoznačno razrešena`, 'error');
          return;
        }
        if (data.kind === 'ITEM' && (!data.records || data.records.length === 0))
          say(`Stavka ${code} nije trenutno smeštena (nema aktivnog placement-a)`, 'info');
        accepted = true;
        navigator.vibrate?.(80);
        cbRef.current.onResult(data);
        if (continuousRef.current) {
          setResults((prev) => [{ code, kind: data.kind, at: now }, ...prev].slice(0, 50));
          say(`✓ Dodato: ${code} — nastavi skeniranje`, 'ok');
        } else {
          cbRef.current.onClose();
        }
      } catch (e) {
        say(e instanceof Error ? e.message : 'Greška pri razrešavanju.', 'error');
      } finally {
        // Slot se meri od KRAJA obrade (BE roundtrip ume da traje) — dekoder tek
        // odavde nadalje ponovo javlja isti kod, pa se re-arm prozor računa odatle.
        const done = Date.now();
        if (accepted) {
          lastRef.code = code;
          lastRef.at = done;
          heldRef.code = code; // latch: prihvaćen kod se ne obrađuje dok ne izađe iz kadra
          heldRef.seenAt = done;
          if (rejectedRef.code === code) rejectedRef.code = ''; // više nije odbijen
        } else {
          // Odbijen (ili pao) kod ima SVOJ slot — prihvaćeni ostaje netaknut.
          rejectedRef.code = code;
          rejectedRef.seenAt = done;
        }
        busyRef.v = false;
        setBusy(false);
      }
    };

    // ── Koji kod iz kadra je „naš" (ispravka 30.07: kamera je uzimala PRVI) ──
    // Na štampanom radnom nalogu barkodovi operacija stoje jedan pod drugim (u
    // štampi je čak dodato razmicanje jer su operateri „omašivali sken"), pa
    // nativni detektor ume da vrati SUSEDNI red. Kako su barkodovi operacija
    // međusobno slični i NISU jedinstveni (`S:{op}:{rc}:0:{rev}` je isti za svaki
    // nalog revizije A sa istom operacijom na istom radnom centru), promašaj se
    // NE VIDI. Zato dekoderu dajemo predikat izbora:
    //   • korak stavke (accept samo ITEM) → uzmi RNZ/short/compact, preskoči `S:`;
    //   • ostali koraci → barem nikad ne biraj `S:` kad u kadru ima drugog koda.
    // Kad NIJEDAN kod ne zadovolji predikat, dekoder vraća prvi kao i dosad — pa
    // korisnik i dalje dobije konkretnu poruku (kind:'OPERATION'), ne tišinu.
    const preferMatching = (raw: string): boolean => {
      const acc = cbRef.current.accept;
      if (acc.includes('ITEM') && !acc.includes('SHELF'))
        return looksLikeLocItemBarcode(raw);
      return !looksLikeOperationBarcode(raw);
    };

    // ── Live decode: „kod napustio kadar" gejt nad pogocima decode-engine-a ──
    // Engine (native rAF / ZXing / jsQR hibrid) javlja SAMO pogotke, pa se
    // odsustvo koda meri od poslednjeg viđenja: isti kod posle pauze duže od
    // REARM_GAP_MS = kod je izlazio iz kadra → prihvati ponovo (re-arm);
    // isti kod bez pauze = stacionaran u kadru → ignoriši (bez dupliranja).
    /**
     * Gejt nad JEDNIM slotom. `true` = ovaj pogodak se ignoriše (kod je i dalje u
     * kadru). Usput stari slot koji niko nije video duže od REARM_GAP_MS — tako
     * dva slota (prihvaćen/odbijen) žive nezavisno i nijedan ne blokira drugi.
     */
    const gateSlot = (slot: { code: string; seenAt: number }, nrv: string, now: number): boolean => {
      if (slot.code === nrv) {
        if (now - slot.seenAt > REARM_GAP_MS) {
          slot.code = ''; // napustio kadar → re-arm
          return false;
        }
        slot.seenAt = now;
        return true;
      }
      if (slot.code && now - slot.seenAt > REARM_GAP_MS) slot.code = '';
      return false;
    };
    const onDecoderRaw = (raw: string) => {
      if (stopped) return;
      const nrv = normalize(raw);
      if (!nrv) return;
      const now = Date.now();
      // OBA slota se gejtuju (bez short-circuit-a — i drugi mora da ostari/osveži se).
      const heldHit = gateSlot(heldRef, nrv, now);
      const rejectedHit = gateSlot(rejectedRef, nrv, now);
      if (heldHit || rejectedHit) return;
      void resolve(raw);
    };

    // ── AF fix + anti-glare (best-effort, Android) — paritet barcode.js ──────
    const applyAFBestEffort = async (track: MediaStreamTrack) => {
      if (!isAndroidWebPlatform() || !track.getCapabilities) return;
      const caps = track.getCapabilities() as unknown as CamCapabilities;
      const modes = Array.isArray(caps.focusMode) ? caps.focusMode.map(String) : [];
      if (!modes.length) return;
      const cur = String((track.getSettings?.() as unknown as CamSettings)?.focusMode || '').toLowerCase();
      if (cur === 'auto' || cur === 'continuous') return; // smart AF — ne diramo
      if (modes.includes('continuous'))
        await safeApplyFlat(track, { focusMode: 'continuous' }, true);
      else if (modes.includes('single-shot') && 'pointsOfInterest' in caps)
        await safeApplyFlat(
          track,
          { focusMode: 'single-shot', pointsOfInterest: [{ x: 0.5, y: 0.5 }] },
          true,
        );
    };
    const applyAntiGlare = async (track: MediaStreamTrack) => {
      if (!isAndroidWebPlatform() || !track.getCapabilities) return;
      const caps = track.getCapabilities() as unknown as CamCapabilities;
      const ec = caps.exposureCompensation;
      if (!ec || typeof ec !== 'object') return;
      const min = Number(ec.min);
      const max = Number(ec.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= -0.05) return;
      await safeApplyFlat(
        track,
        { exposureCompensation: Math.max(min, Math.min(max, -0.45)) },
        true,
      );
    };

    // ── Zoom UI (auto 2× + slider); Android non-Chrome nema pouzdan zoom ─────
    const setupZoom = async (track: MediaStreamTrack) => {
      if (isAndroidWebCameraTorchZoomHidden() && !isAndroidChromeBrowser()) {
        setZoomCap(null);
        return;
      }
      const caps = (track.getCapabilities?.() as unknown as CamCapabilities) || {};
      const z = caps.zoom;
      if (!z || typeof z !== 'object') {
        setZoomCap(null);
        return;
      }
      const min = Number(z.min ?? 1);
      const max = Number(z.max ?? 1);
      const step = Number(z.step ?? 0.1);
      if (max <= min + 0.01) {
        setZoomCap(null);
        return;
      }
      const auto = Math.min(max, Math.max(min, 2));
      setZoomCap({ min, max, step });
      setZoomValue(auto);
      const ok = await safeApplyFlat(track, { zoom: auto }, isAndroidWebPlatform());
      // 1.0 runRefocusAfterZoom važi i za POČETNI auto-zoom, ne samo za klizač:
      // promena zoom-a na Android Chrome-u razbija AF, pa bi prvi kadar ostao
      // mutan i skener „gluv" dok korisnik sam ne tapne fokus.
      if (ok && !stopped && isAndroidChromeBrowser()) await applyAFBestEffort(track);
    };
    const applyZoomDebounced = (value: number) => {
      if (isAndroidWebPlatform() && !isAndroidChromeBrowser()) return;
      if (zoomTimer) clearTimeout(zoomTimer);
      zoomTimer = window.setTimeout(async () => {
        zoomTimer = 0;
        const track = getTrack();
        if (!track) return;
        const ok = await safeApplyFlat(track, { zoom: value }, isAndroidWebPlatform());
        // 1.0 runRefocusAfterZoom: promena zoom-a na Android Chrome-u razbija AF
        // (kadar ostane mutan i dekoder „gluv"), pa posle uspešne primene ponovo
        // nateramo fokus. iOS/desktop to ne traže — tamo AF prati zoom sam.
        if (ok && !stopped && isAndroidChromeBrowser()) await applyAFBestEffort(track);
        refreshScanDiag(value);
      }, 220);
    };

    // ── Torch (Android web skriva; paritet 1.0) ─────────────────────────────
    const detectTorch = (track: MediaStreamTrack) => {
      if (isAndroidWebPlatform()) {
        setTorchSupported(false);
        return;
      }
      const caps = (track.getCapabilities?.() as unknown as CamCapabilities) || {};
      const supported =
        (navigator.mediaDevices?.getSupportedConstraints?.() as unknown as { torch?: boolean }) || {};
      setTorchSupported('torch' in caps || supported.torch === true);
    };
    const toggleTorch = async () => {
      const track = getTrack();
      if (!track || isAndroidWebPlatform()) return;
      const settings = (track.getSettings?.() as unknown as CamSettings) || {};
      const next = !settings.torch;
      const ok = await safeApplyFlat(track, { torch: next }, false);
      if (ok) setTorchOn(next);
    };

    // ── Multi-lens: lista objektiva, cikliranje, auto-skok sa lošeg ─────────
    const enumerateBackCams = async (): Promise<MediaDeviceInfo[]> => {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        return devs.filter((d) => {
          if (d.kind !== 'videoinput') return false;
          const l = String(d.label || '').toLowerCase();
          return !l || !/front|user|face/.test(l);
        });
      } catch {
        return [];
      }
    };
    const refreshLensList = async (track: MediaStreamTrack) => {
      const cams = await enumerateBackCams();
      backCams = cams;
      const s = (track.getSettings?.() as unknown as CamSettings) || {};
      const curId = s.deviceId || curDeviceId || '';
      let idx = curId ? cams.findIndex((c) => c.deviceId === curId) : -1;
      if (idx < 0 && track.label) idx = cams.findIndex((c) => c.label === track.label);
      setLens({ count: cams.length, idx });
    };
    const cycleLens = async (manualPick = true): Promise<void> => {
      if (backCams.length < 2) return;
      if (manualPick) autoSwitchAttempts = Math.max(0, backCams.length); // user preuzima kontrolu
      const s = (getTrack()?.getSettings?.() as unknown as CamSettings) || {};
      const curId = s.deviceId || curDeviceId || '';
      const curIdx = curId ? backCams.findIndex((c) => c.deviceId === curId) : -1;
      const next = curIdx >= 0 ? (curIdx + 1) % backCams.length : 0;
      const dev = backCams[next];
      if (!dev?.deviceId) return;
      say(`📷 Prebacujem na: ${dev.label || `objektiv ${next + 1}`}…`);
      const opened = await startCamera(dev.deviceId);
      // KEŠ TEK POSLE USPEHA (ISPRAVKA 01.08): ranije su se oba keša pisala PRE
      // `startCamera`, pa je objektiv koji se NE otvori (nestao, zauzet, odbijen
      // constraint) trovao i ovaj ekran i zajednički picker keš narednih 30 dana —
      // korisnik bi na svakom sledećem otvaranju dobijao kameru koja ne radi, bez
      // ijednog načina da to poništi osim brisanja podataka sajta.
      if (opened && manualPick) {
        writeCamChoice(dev.deviceId, dev.label || '');
        // Isti izbor upiši i u keš capability-pickera (lib/camera-picker) —
        // inače bi auto-picker pri sledećem otvaranju „ispravljao" korisnika.
        rememberManualCameraChoice(dev.deviceId, dev.label || '');
      }
    };
    const autoSwitchBadLens = async (track: MediaStreamTrack) => {
      if (backCams.length < 2) return;
      const maxAttempts = backCams.length - 1;
      if (autoSwitchAttempts >= maxAttempts) return;
      if (!isObviouslyBadBackLens(track.label || '') && !isCapabilityBadLens(track)) return;
      autoSwitchAttempts += 1;
      say(`🔄 Automatski tražim glavni objektiv (pokušaj ${autoSwitchAttempts}/${maxAttempts})…`);
      await cycleLens(false);
    };

    // ── Dijagnostika: front/back + rezolucija + objektiv N/M ────────────────
    const reportDiag = (track: MediaStreamTrack) => {
      try {
        const s = (track.getSettings?.() as unknown as CamSettings) || {};
        const label = track.label || '(bez labele)';
        const looksFront = /front|user|face/i.test(label);
        const parts = [
          looksFront ? '⚠ FRONT kamera' : '✓ back kamera',
          `${s.width || '?'}×${s.height || '?'}`,
        ];
        // Objektiv N/M iz ŽIVIH lokala efekta (backCams + track), ne iz React `lens`
        // state-a — mount-closure bi bio zastareo pa se sufiks nikad ne bi prikazao.
        const count = backCams.length;
        const curId = s.deviceId || curDeviceId || '';
        let idx = curId ? backCams.findIndex((c) => c.deviceId === curId) : -1;
        if (idx < 0 && track.label) idx = backCams.findIndex((c) => c.label === track.label);
        if (!looksFront && count >= 2 && idx >= 0)
          parts.push(`objektiv ${idx + 1}/${count}`);
        say(parts.join(' · ') + ' — drži kod u centru', looksFront ? 'warn' : 'ok');
        if (looksFront) void tryForceBackCamera();
      } catch {
        /* ignore */
      }
    };
    const tryForceBackCamera = async () => {
      if (forcedBackDone) return; // one-shot — bez beskonačnog restart ciklusa
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter((d) => d.kind === 'videoinput');
        if (cams.length < 2) return;
        // Samo ako STVARNO postoji ne-front objektiv i nije već aktivan — bez
        // fallback-a na „poslednji kandidat" (koji je i sam mogao biti front → petlja).
        const back = cams.find((d) => !/front|user|face/i.test(d.label));
        if (!back?.deviceId || back.deviceId === curDeviceId) return;
        forcedBackDone = true;
        await startCamera(back.deviceId);
      } catch {
        /* ignore */
      }
    };

    /**
     * Dijagnostički red za teren (05.08.2026) — v. `ScanDiagLine`. Zove se i
     * posle promene zuma i posle tap-fokusa, ne samo na paljenju kamere: red
     * koji se ne osvežava pokazuje zastarelo stanje baš dok se meri.
     */
    const refreshScanDiag = (zoomValue?: number) => {
      setDiag(
        buildScanDiag(getTrack(), {
          lensPicked: Boolean(curDeviceId),
          roiGate: shouldLimitScanToReticle(),
          zoomValue,
        }),
      );
    };

    const afterCameraReady = async (track: MediaStreamTrack | null) => {
      if (!track || stopped) return;
      detectTorch(track);
      await applyAntiGlare(track);
      await applyAFBestEffort(track);
      await refreshLensList(track);
      await setupZoom(track);
      reportDiag(track);
      refreshScanDiag();
      await autoSwitchBadLens(track);
    };

    // ── Start / restart kamere (deviceId override za lens/force-back) ────────
    /**
     * Vraća `true` SAMO kad je otvoren i pušten baš TRAŽENI `deviceId` — to je
     * ugovor za pozivaoca koji na osnovu ishoda pamti izbor objektiva
     * (`cycleLens`). Fallback na `facingMode` (traženi objektiv nestao/zauzet)
     * NIJE uspeh: keširati taj deviceId značilo bi zaključati korisnika 30 dana
     * na kameru koja se ne otvara.
     * `reason: 'resume'` = povratak iz pozadine (v. `onResume`) — samo utišava
     * poruku „Prebacujem objektiv…", tok je isti.
     */
    const startCamera = async (
      deviceId?: string,
      reason?: 'resume',
    ): Promise<boolean> => {
      if (stopped) return false;
      // 1.0 lekcija (isScanSupported): podrška se gejtuje SAMO na getUserMedia.
      // BarcodeDetector NIJE uslov — iPhone/Firefox dobijaju ZXing/jsQR put.
      if (!isCameraDecodeSupported()) {
        say(
          'Kamera nije dostupna u ovom pregledaču (getUserMedia) — proveri HTTPS, ili koristi HID čitač / ručni unos.',
          'error',
        );
        return false;
      }
      stopStream();
      // `stopStream` podiže decoderSeq — pamtimo „našu" generaciju da zakasneli
      // async koraci (picker probe, retry pauze) prestanu čim neko drugi (cycleLens,
      // force-back, zatvaranje) pokrene svoj start.
      let startSeq = decoderSeq;
      const aborted = () => stopped || startSeq !== decoderSeq;
      // Samsung Internet: OS release prethodne sesije kasni 350-450ms; iOS WebKit
      // traži ~180ms pre novog getUserMedia (1.0 barcode.js:298-314 / 772-774).
      // 450ms je KANON (isto što vraća `cameraCooldownMs()` koji koriste maint i
      // reversi ljuska i picker) — na 350ms je Samsung Internet i dalje umeo da
      // vrati NotReadableError na drugom skenu u sesiji.
      if (isSamsungInternetBrowser()) await new Promise((r) => setTimeout(r, 450));
      else if (isIOSWebPlatform()) await new Promise((r) => setTimeout(r, 180));
      // …a povrh pauze i dva rAF ciklusa: pauza pokriva OS, rAF pokriva pipeline.
      await twoRafs();
      if (aborted()) return false;

      const acceptShelf = cbRef.current.accept.includes('SHELF');
      const formats: DecodeFormat[] = decodeFormats();
      // iOS item profil = 2880×1620 (RNZ Code128 na 1080p nema dovoljno piksela
      // za ZXing — 1.0 fd252cb/e48b763); ostalo 1920×1080.
      const videoBase: MediaTrackConstraints = buildVideoConstraints(
        acceptShelf ? 'mixed' : 'item',
      );

      // ── Capability picker: PRVI izbor sočiva na Android multi-lens telefonima ─
      // Bez ovoga `facingMode:'environment'` na Samsung A-seriji ume da vrati macro
      // objektiv (fiksni fokus ~3cm) → preview radi, barkod se nikad ne dekodira.
      // Prednost imaju: eksplicitan deviceId (cycleLens/force-back) i zapamćen
      // ručni izbor ove ljuske — picker se pita SAMO kad izbora nema.
      let pickedDeviceId: string | null = null;
      if (!deviceId && !readCamChoice() && shouldRunCameraPicker()) {
        say('📷 Biram najbolji objektiv…');
        try {
          pickedDeviceId = await pickPreferredBackCamera();
        } catch {
          pickedDeviceId = null; // pad pickera = nastavi starim putem (facingMode)
        }
        if (aborted()) return false;
      }
      const useDeviceId = deviceId ?? pickedDeviceId ?? null;
      // Prati da li je na kraju otvoren BAŠ traženi objektiv (v. JSDoc iznad).
      let openedRequested = !!useDeviceId;

      const constraints: MediaStreamConstraints = {
        video: useDeviceId
          ? { ...videoBase, deviceId: { exact: useDeviceId } }
          : { ...videoBase, facingMode: { ideal: 'environment' } },
      };

      // Otvaranje sa RETRY-jem (1.0 barcode.js:1120-1144): na prolaznu grešku
      // („kamera zauzeta" jer OS još drži senzor) pusti stream, sačekaj 700ms +
      // dva frejma i probaj JOŠ JEDNOM istim constraint-ima. Samsung Internet je
      // najgori pa dobija dva ponavljanja. Tek kad se pokušaji istroše ide
      // postojeći fallback (keširani deviceId → environment) i formatCameraError.
      const openStream = async (c: MediaStreamConstraints): Promise<MediaStream> => {
        const maxRetries = isSamsungInternetBrowser() ? 2 : 1;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            // PRVO provera, TEK ONDA stopStream(): ako je neko drugi (cycleLens,
            // force-back, zatvaranje) već podigao decoderSeq, ovaj retry je mrtav —
            // njegov stopStream bi ubio TUĐI živi stream, a `startSeq = decoderSeq`
            // bi mu „ukrao" generaciju i nastavio da radi kao da je aktuelan.
            if (aborted()) throw lastErr ?? new Error('Skener je zatvoren');
            const expected = decoderSeq + 1;
            stopStream();
            // Re-arm SAMO kad je bump napravio baš ovaj retry (inače je između
            // provere i stopStream-a neko drugi preuzeo — ostajemo abortirani).
            if (decoderSeq === expected) startSeq = decoderSeq;
            await new Promise((r) => setTimeout(r, 700));
            await twoRafs();
            if (aborted()) throw lastErr ?? new Error('Skener je zatvoren');
            say(`📷 Kamera je bila zauzeta — pokušavam ponovo (${attempt}/${maxRetries})…`);
          }
          // Ne otvaraj kameru za mrtvu generaciju (uklj. prvi pokušaj: između
          // pickera/pauza i ovog reda je mogao stići cycleLens ili zatvaranje).
          if (aborted()) throw lastErr ?? new Error('Skener je zatvoren');
          try {
            return await navigator.mediaDevices.getUserMedia(c);
          } catch (e) {
            lastErr = e;
            if (!isTransientCameraError(e)) throw e;
          }
        }
        throw lastErr;
      };

      // Poruka prati NAMERU korisnika (ručni cycle), ne to što je picker izabrao
      // deviceId — inače bi prvo otvaranje na Androidu pisalo „Prebacujem objektiv".
      // Pri povratku iz pozadine ostaje „Vraćam kameru…" koje je već postavio `onResume`.
      if (reason !== 'resume') say(deviceId ? 'Prebacujem objektiv…' : '📷 Tražim kameru…');
      let stream: MediaStream;
      try {
        stream = await openStream(constraints);
      } catch (e) {
        // Mrtva generacija (drugi start / zatvaranje) — bez fallback getUserMedia-a
        // i bez poruke: aktuelan start ima svoj tok i svoju poruku.
        if (aborted()) return false;
        // Ako je izabrani (keširan/picker) deviceId nestao, probaj default environment.
        if (useDeviceId) {
          try {
            stream = await openStream({
              video: { ...videoBase, facingMode: { ideal: 'environment' } },
            });
            openedRequested = false; // otvoren je fallback, ne traženi objektiv
          } catch (e2) {
            if (aborted()) return false; // isti razlog kao gore — poruka pripada novom startu
            say(formatCameraError(e2), 'error');
            return false;
          }
        } else {
          say(formatCameraError(e), 'error');
          return false;
        }
      }
      if (aborted()) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const v = videoRef.current;
      if (!v) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      v.srcObject = stream;
      try {
        v.setAttribute('playsinline', '');
        // Stariji iOS WebKit (i neki Android WebView-i) gledaju SAMO prefiksovani
        // atribut — bez njega video ide u fullscreen plejer i sken „nestane".
        v.setAttribute('webkit-playsinline', '');
        v.playsInline = true;
        v.muted = true;
        await v.play();
      } catch {
        /* autoplay guard — muted playsInline obično prolazi */
      }
      // `play()` je asinhron: dok se čekao, mogao je krenuti NOVI start (cycleLens,
      // force-back, povratak iz pozadine) ili zatvaranje skenera. Bez ove provere
      // stale start ide dalje i u `++decoderSeq` ispod KRADE generaciju aktuelnom
      // startu — dekoder aktuelnog starta se tada sam ugasi (`isStopped`), a mi
      // ostajemo zakačeni na kadar koji smo taman ugasili. Isti guard postoji u
      // maint (maint-scan-overlay:248-251) i reversi ljusci (:390-393).
      if (aborted()) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const track = stream.getVideoTracks()[0] ?? null;
      curDeviceId =
        useDeviceId ?? (track?.getSettings() as unknown as CamSettings)?.deviceId ?? null;
      cameraOnRef.v = true;
      setCameraOn(true);
      say(acceptShelf ? 'Usmeri kameru na barkod police / naloga' : 'Usmeri kameru na barkod nalepnice');

      // Decode-engine bira put po platformi (native / ZXing / jsQR hibrid) i
      // kači se na NAŠ već pokrenut <video> — lens/zoom/torch ostaju naši.
      const mySeq = ++decoderSeq;
      try {
        const handle = await attachVideoDecoder({
          video: v,
          formats,
          onRaw: onDecoderRaw,
          isStopped: () => stopped || mySeq !== decoderSeq,
          // Više kodova u kadru → biraj format koji ovaj korak očekuje (N3).
          preferMatching,
          // Nišan-gejt (04.08, „Samsung promaši sken za ~2 cm"): na SM-A profilu
          // pogodak čiji je centar van prozora nišana se ignoriše — dekoder je
          // dotad čitao CEO frejm (uklj. ~35% nevidljivog kadra sa svake strane
          // kod object-fit:cover), pa je hvatao susedni kod van prozora.
          acceptRegion: () => reticleBoxRef.current?.getBoundingClientRect() ?? null,
        });
        if (stopped || mySeq !== decoderSeq) {
          handle.stop(); // restart/close u toku lazy učitavanja ZXing-a
        } else {
          decoder = handle;
          if (handle.path !== 'native') console.info('[scan] decode put:', handle.path);
        }
      } catch (e) {
        say(
          'Dekoder nije mogao da se učita (mreža?) — koristi „Iz slike" ili ručni unos. (' +
            (e instanceof Error ? e.message : String(e)) +
            ')',
          'error',
        );
      }

      window.setTimeout(() => void afterCameraReady(getTrack()), 500);
      return openedRequested;
    };

    // ── Decode iz slike — 1.0 paritet: ZXing 11-pokušaja pipeline (radi i na
    // iPhone-u!); nativni BarcodeDetector je samo BRZI prvi pokušaj gde postoji.
    const handleFile = async (file: File): Promise<void> => {
      if (!/^image\//.test(file.type || '')) {
        say('⚠ Odaberi fajl tipa slike (JPG / PNG).', 'warn');
        return;
      }
      say('🔍 Čitam sliku…');
      const formats: DecodeFormat[] = decodeFormats();
      try {
        // Brzi pokušaj nativnim detektorom (Chromium) — jedan detect, bez pipeline-a.
        const Ctor = getDetectorCtor();
        if (Ctor) {
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(file);
            let detector: BarcodeDetectorLike;
            try {
              detector = new Ctor({ formats });
            } catch {
              detector = new Ctor();
            }
            const found = await detector.detect(bitmap);
            // Screenshot celog RN-a lako sadrži i barkodove operacija — isti izbor
            // kao u kamera-petlji (bez pogotka po predikatu ostaje prvi, kao pre).
            const hitRaw = pickPreferredRaw(
              found.map((f) => (f?.rawValue ? String(f.rawValue) : '')),
              preferMatching,
            );
            if (hitRaw) {
              navigator.vibrate?.(80);
              await resolve(hitRaw);
              return;
            }
          } catch {
            /* padni na ZXing pipeline ispod */
          } finally {
            bitmap?.close?.();
          }
        }
        // 1.0 anti-glare pipeline: original + grayscale-kontrast + upscale varijante,
        // Code128-only reader pre punog (folija / gusti RNZ / Viber screenshot).
        const hit = await decodeImageFile(file, formats);
        if (hit) {
          navigator.vibrate?.(80);
          await resolve(hit);
        } else {
          say('❌ Na slici nema prepoznatljivog barkoda — probaj oštriju / veću sliku ili ručni unos.', 'warn');
        }
      } catch (e) {
        say('⚠ Greška pri čitanju slike: ' + (e instanceof Error ? e.message : String(e)), 'error');
      }
    };

    // ── OCR tekst (gornji desni ugao nalepnice → broj predmeta / TP) ─────────
    // Paritet 1.0 applyOcrFromVideo: kad barkod ne uspe, radnik usmeri gornji
    // desni ugao liste i pročita se „predmet/TP". Parsirani par se komponuje u
    // „orderNo/tp" i propušta kroz isti BE lookup (resolve) kao skenirani ITEM.
    const ocrScan = async (): Promise<void> => {
      const v = videoRef.current;
      if (!v || !cameraOnRef.v) {
        say('Prvo pokreni kameru, pa probaj OCR.', 'warn');
        return;
      }
      if (!isOcrEngineAvailable()) {
        say(
          'OCR tekst nije konfigurisan na ovoj instalaciji — koristi barkod, „Iz slike" ili ručni unos.',
          'warn',
        );
        return;
      }
      say('Čitam tekst (OCR)… može potrajati nekoliko sekundi prvi put', 'info');
      try {
        const canvas = cropTopRightLabelRegion(v);
        if (!canvas) {
          say('Sačekaj da kamera stabilizuje kadar, pa probaj ponovo.', 'warn');
          return;
        }
        const res = await recognizeLabelText(canvas);
        if ('error' in res) {
          say(
            res.error === 'engine_missing'
              ? 'OCR tekst nije konfigurisan — koristi barkod / ručni unos.'
              : 'OCR nije uspeo — probaj zum ili ručni unos.',
            'warn',
          );
          return;
        }
        const parsed = parsePredmetTpFromLabelText(res.text);
        if (!parsed) {
          say('Nije prepoznat „broj predmeta / TP". Usmeri gornji desni ugao liste ili unesi ručno.', 'warn');
          return;
        }
        navigator.vibrate?.(80);
        await resolve(parsed.raw); // „orderNo/tp" → BE lookup (isti put kao skenirani ITEM)
      } catch (e) {
        say('OCR greška: ' + (e instanceof Error ? e.message : String(e)), 'error');
      }
    };

    // ── Tap-to-focus ────────────────────────────────────────────────────────
    /**
     * ISPRAVKA 02.08.2026 (S5): prsten se crta SAMO kad je fokus zaista primenjen.
     *
     * WebKit ne izlaže ni `focusMode` ni `pointsOfInterest`, pa na iPhone-u nijedan
     * od ovih `applyConstraints` poziva ne uradi ništa. Zatečeni kod je prsten
     * postavljao ODMAH, pre svake provere — radnik je dobijao zelenu potvrdu da je
     * izoštrio i onda čekao fokus koji ne dolazi. 1.0 to radi ispravno
     * (`barcode.js:1231-1265` vraća `false`; `scanModal.js:2669-2693` crta prsten
     * samo na `true`). Prsten je uz to prebojen iz `--status-success` (zeleno =
     * „uspelo") u neutralnu belu — semantika uspeha se ne troši na potez kamere.
     *
     * DOPUNA (ista sesija, regresija na Androidu): „ništa se ne crta" je na iOS-u
     * tačno (tamo tap-fokus strukturno ne postoji, pa lažna potvrda šteti), ali je na
     * ANDROIDU napravilo mrtvo dugme — telefon koji izlaže samo `continuous` (a to je
     * čest Android Chrome slučaj, gde `applyAFBestEffort` već drži `continuous` pa
     * ponovna primena nema smisla) na tap ne uradi i ne pokaže NIŠTA, i radnik ne zna
     * da li je promašio metu ili aplikacija ne radi. Zato Android uvek dobija odziv:
     * puna bela linija = fokus zatražen i prihvaćen, isprekidana prigušena = „tap
     * primljen, ovaj telefon ne dozvoljava ručno izoštravanje" (uz jednu poruku po
     * sesiji, da radnik zna da menja RASTOJANJE umesto da tapka).
     */
    const tapFocus = async (clientX: number, clientY: number): Promise<void> => {
      const track = getTrack();
      const v = videoRef.current;
      if (!track || !v) return;
      const caps = (track.getCapabilities?.() as unknown as CamCapabilities) || {};
      const modes = Array.isArray(caps.focusMode) ? caps.focusMode.map(String) : [];
      const rect = v.getBoundingClientRect();
      const at = { x: clientX - rect.left, y: clientY - rect.top };

      const showRing = (ok: boolean) => {
        const id = Date.now();
        setFocusRing({ ...at, id, ok });
        window.setTimeout(() => setFocusRing((r) => (r?.id === id ? null : r)), 600);
      };
      /** Fokus nije primenjen: na Androidu daj vidljiv odziv, na iOS-u ćuti (S5). */
      const reportNoFocus = () => {
        if (!isAndroidWebPlatform()) return;
        showRing(false);
        if (!saidNoFocusSupport) {
          saidNoFocusSupport = true;
          say('Ovaj telefon ne dozvoljava ručno izoštravanje — menjaj rastojanje (10-15 cm).', 'warn');
        }
      };

      if (!(modes.includes('single-shot') && 'pointsOfInterest' in caps)) {
        if (modes.includes('continuous') && !isAndroidChromeBrowser()) {
          const ok = await safeApplyFlat(track, { focusMode: 'continuous' }, isAndroidWebPlatform());
          if (ok) showRing(true);
          else reportNoFocus();
          return;
        }
        reportNoFocus();
        return;
      }
      const m = mapPointerToVideoNormalizedPlane(v, clientX, clientY);
      if (!m) return;
      const ok = await safeApplyFlat(
        track,
        { focusMode: 'single-shot', pointsOfInterest: [{ x: m.x, y: m.y }] },
        isAndroidWebPlatform(),
      );
      if (ok) showRing(true);
      else reportNoFocus();
      if (ok && modes.includes('continuous') && !isAndroidChromeBrowser()) {
        await new Promise((r) => setTimeout(r, 320));
        await safeApplyFlat(track, { focusMode: 'continuous' }, isAndroidWebPlatform());
      }
      refreshScanDiag(); // `focusMode` se posle tapa menja — red mora da to pokaže
    };

    // ── Izloži imperativne kontrole ka JSX handlerima ───────────────────────
    ctrlRef.current = {
      resolve,
      handleFile,
      ocrScan,
      cycleLens: () => cycleLens(true),
      toggleTorch,
      setZoom: (v: number) => {
        setZoomValue(v);
        applyZoomDebounced(v);
      },
      tapFocus,
      // `startCamera` vraća „da li je otvoren traženi objektiv" — ljusci to ovde
      // ne treba, pa se ishod namerno guta (ugovor kontrole ostaje Promise<void>).
      restart: async () => {
        await startCamera();
      },
    };

    // ── Globalni event-i ────────────────────────────────────────────────────
    // Esc NIJE ovde — skener je modalni sloj i prijavljuje se `useEscapeLayer`-u
    // (v. `ui-kit/escape-layer.ts`), da Esc zatvori samo njega a ne i dijalog
    // ispod. Sopstveni capture-slušalac je zatvarao oba.
    //
    // (Spajanje 01.08.2026: `main` je na ovom mestu i dalje imao sopstveni
    // `keydown` slušalac; on se NE vraća — zamenjen je gornjim slojem, koji je
    // uveden baš zato što je Esc zatvarao i skener i dijalog ispod njega.)
    //
    // Pozadina / zaključan ekran / prelazak u drugu aplikaciju mora da PUSTI
    // kameru — inače povratak daje zamrznut preview ili NotReadableError.
    const onPageHide = () => {
      try {
        stopStream();
      } catch {
        /* ignore */
      }
      // Bez ovoga retikla i status i dalje „glume" živu kameru nad crnim <video>.
      cameraOnRef.v = false;
      setCameraOn(false);
    };
    /**
     * Put NAZAD (ISPRAVKA 01.08 — obrazac maint ljuske, maint-scan-overlay:289-300):
     * ranije je postojala samo `hidden` grana, pa je posle zaključavanja ekrana,
     * prelaska u drugu aplikaciju ili Android „Iz slike" file picker-a (koji takođe
     * okida `hidden`!) kamera ostajala TRAJNO crna — a `cameraOn` je ostajao `true`,
     * pa su retikla i status glumili da skener radi. U magacinu je to svakodnevno.
     *
     * Gejt je ŽIVI stream (`getTrack()`), pa dupli okidač (`pageshow` + `visibilitychange`
     * stižu jedan za drugim na bfcache povratku) ne pravi dva starta. A i kad bi ga
     * napravio — start koji je u letu još nema `srcObject` — kolabira ga generacijska
     * disciplina: `startCamera` odmah zove `stopStream()` koji podiže `decoderSeq`,
     * pa stariji start na prvoj `aborted()` proveri sam odustane i ugasi svoj stream.
     */
    const onResume = () => {
      if (stopped || pitfalls.blocker) return; // zatvoreno / iOS blokada (kamera nikad nije ni krenula)
      if (getTrack()) return; // kamera je već živa — ništa se nije ni gasilo
      say('📷 Vraćam kameru…');
      // Zadrži objektiv koji je bio aktivan (ručni cycle / picker izbor) — bez
      // ovoga bi se na Androidu ponovo plaćao pun picker probe ciklus.
      void startCamera(curDeviceId ?? undefined, 'resume');
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onPageHide();
      else onResume();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onResume); // bfcache povratak (iOS Safari)
    document.addEventListener('visibilitychange', onVisibility);

    // ── Init ────────────────────────────────────────────────────────────────
    // Dekoder chunk se vuče LAZY (ZXing ~250KB) — pokreni ga ODMAH, paralelno sa
    // traženjem kamere: Android sada ide na ZXing put (1.0 kanon 3cffea5), pa bi
    // bez ovoga prvi sken na pogonskoj mreži čekao mrežu sa upaljenim preview-om.
    // I „Iz slike" put koristi isti chunk, pa se isplati i kad je kamera blokirana.
    preloadVideoDecoder(decodeFormats());
    // Model uređaja se razrešava ASINHRONO (UA-CH) — Chrome ga u UA krije.
    primeDeviceModelHint();
    if (pitfalls.blocker) {
      setIosBlocker(pitfalls.blocker);
      say(pitfalls.blocker, 'error');
    } else {
      const saved = readCamChoice();
      // Most ka zajedničkom kešu pickera: ova ljuska ima STARIJI sopstveni keš
      // ručnog izbora (`loc_scan_cam_choice_v1`, od pre postojanja camera-pickera).
      // Ako korisnik već ima svoj objektiv ovde, a picker nema nikakav zapis —
      // prenesi ga jednokratno, da maint/reversi skeneri vide isti izbor umesto
      // da auto-picker „ispravlja" korisnika na svakom drugom ekranu.
      if (saved?.deviceId && !hasStoredCameraChoice())
        rememberManualCameraChoice(saved.deviceId, saved.label || '');
      void startCamera(saved?.deviceId);
    }

    return () => {
      stopped = true;
      if (zoomTimer) clearTimeout(zoomTimer);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onVisibility);
      stopStream();
      void terminateLabelOcrWorker();
      ctrlRef.current = null;
      // Kamera je TEK SADA slobodna → zagrej picker za sledeće otvaranje (v. JSDoc).
      warmCameraPickerAfterClose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusClass =
    statusKind === 'error'
      ? 'text-status-danger'
      : statusKind === 'warn'
        ? 'text-status-warn'
        : statusKind === 'ok'
          ? 'text-status-success'
          : 'text-white/80';

  const showCycle = lens.count >= 2 && !iosBlocker;

  return (
    // FULL-BLEED KADAR (S3, 02.08.2026): 1.0 drži kameru preko CELOG ekrana
    // (`.loc-scan-video` = `position:absolute; inset:0`, legacy.css:4634) a kontrole
    // lebde preko nje sa gradijentom (`.loc-scan-topbar`, :4695; `.loc-scan-hint`,
    // :4720; `.loc-scan-status`, mobile.css:807). Zatečeni `flex flex-col` sa
    // neprozirnim trakama je na telefonu jeo ~trećinu visine kadra, pa je isti
    // barkod izgledao manji nego u 1.0 i nišan nije stajao na sredini EKRANA.
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Topbar — `pointer-events-none` na traci, `auto` na dugmadima: traka je
          providan gradijent preko kadra, pa tap kroz nju mora da stigne do `<video>`
          (tap-to-focus). Bez toga gornja ~56 px kadra ne prima fokus. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-gradient-to-b from-black/55 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] text-white">
        <span className="text-md truncate font-semibold">{title}</span>
        <div className="pointer-events-auto flex items-center gap-1">
          {showCycle && (
            <button
              type="button"
              onClick={() => void ctrlRef.current?.cycleLens()}
              aria-label="Sledeći objektiv"
              title={`Objektiv ${lens.idx >= 0 ? lens.idx + 1 : '?'}/${lens.count} — tap za sledeći (ako je preview mutan)`}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-white/10"
            >
              <SwitchCamera className="h-5 w-5" />
              {lens.idx >= 0 ? `${lens.idx + 1}/${lens.count}` : lens.count}
            </button>
          )}
          {torchSupported && (
            <button
              type="button"
              onClick={() => void ctrlRef.current?.toggleTorch()}
              aria-label="Baterijska lampa"
              aria-pressed={torchOn}
              className="rounded-full p-1 hover:bg-white/10"
              style={{ opacity: torchOn ? 1 : 0.6 }}
            >
              <Zap className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Zatvori"
            className="rounded-full p-1 hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Video + retikla + focus ring — kadar je full-bleed ispod svih kontrola */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
        onPointerDown={(e) => void ctrlRef.current?.tapFocus(e.clientX, e.clientY)}
      />
      {cameraOn && !iosBlocker && (
        <ScanReticle variant="barcode" bottomInset={panelInset} frameRef={reticleBoxRef} />
      )}
      {focusRing && (
        <div
          // Neutralna bela, NE `--status-success`: zeleno je u ovom sistemu potvrda
          // ishoda (v. DESIGN_SYSTEM §7), a ovo je samo znak da je fokus zatražen
          // i prihvaćen. 1.0 iz istog razloga koristi žutu (`#ffd84a`).
          // Isprekidan i prigušen prsten = tap primljen, ali uređaj ne podržava ručno
          // izoštravanje (samo Android — v. `tapFocus`).
          className={`pointer-events-none absolute z-10 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
            focusRing.ok ? 'border-white/90' : 'border-dashed border-white/40'
          }`}
          style={{ left: focusRing.x, top: focusRing.y, animation: 'ping 0.6s ease-out' }}
          aria-hidden
        />
      )}
      {iosBlocker && (
        <div className="absolute inset-0 z-10 grid place-items-center p-6 text-center text-sm text-white/90">
          <p className="max-w-sm whitespace-pre-line">{iosBlocker}</p>
        </div>
      )}

      {/* Donji panel: zoom, hint, status, alati, ručni unos, batch lista — sve
          LEBDI preko kadra (1.0 obrazac). `max-h`/scroll je brana da panel na
          malom ekranu ne naraste previše; da nišan NE padne pod njega brine
          izmerena visina (`panelRef` → `bottomInset` nišana).
          `pointer-events-none` na omotaču + `auto` na svakoj kontroli: prazan
          prostor panela (i njegov providan gornji gradijent) propušta tap na
          `<video>` — inače donjih ~60% kadra ne prima tap-to-focus. */}
      <div
        ref={panelRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 max-h-[62%] space-y-2 overflow-y-auto bg-gradient-to-t from-black/90 via-black/75 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom,0px))] text-white"
      >
        {/* Zoom slider — samo kad uređaj izlaže track zoom capability */}
        {zoomCap && (
          <div className="flex items-center justify-center gap-2">
            <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-control bg-black/60 px-3 py-2 text-white">
              <ZoomIn className="h-4 w-4 shrink-0" />
              <button
                type="button"
                aria-label="Smanji zoom"
                className="px-2 text-lg leading-none"
                onClick={() =>
                  ctrlRef.current?.setZoom(Math.max(zoomCap.min, zoomValue - (zoomCap.step || 0.1) * 5))
                }
              >
                −
              </button>
              <input
                type="range"
                aria-label="Zoom"
                min={zoomCap.min}
                max={zoomCap.max}
                step={zoomCap.step || 0.1}
                value={zoomValue}
                onChange={(e) => ctrlRef.current?.setZoom(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <button
                type="button"
                aria-label="Povećaj zoom"
                className="px-2 text-lg leading-none"
                onClick={() =>
                  ctrlRef.current?.setZoom(Math.min(zoomCap.max, zoomValue + (zoomCap.step || 0.1) * 5))
                }
              >
                +
              </button>
              <span className="w-10 shrink-0 text-right text-xs">{zoomValue.toFixed(1)}×</span>
            </div>
          </div>
        )}

        {/* S4: instrukcija radniku (1.0 `.loc-scan-hint`, scanModal.js:302-309) —
            3.0 je do 02.08.2026 nije imao ni u jednoj ljusci. Čim u „neprekidnoj"
            sesiji padne PRVI sken, hint se gasi: radnik koji je već skenirao zna kako
            se drži telefon, a tri reda teksta tada samo dižu panel preko nišana. */}
        {cameraOn && !iosBlocker && !(continuousOn && results.length > 0) && (
          <ScanHint
            extra={
              acceptItem
                ? 'Ne ide? Probaj „Iz slike" ili OCR na gornji desni ugao (predmet/TP)'
                : 'Ne ide? Probaj „Iz slike" (približi da barkod zauzme kadar)'
            }
          />
        )}

        {status && (
          <p className={`text-sm whitespace-pre-line ${statusClass}`} aria-live="polite">
            {status}
          </p>
        )}

        {/* Red alata: `pointer-events-auto` ide na SVAKO dugme pojedinačno, ne na
            red — razmaci između dugmadi tako ostaju tap-to-focus površina. */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-white/70">
          <span>Tap na kadar = fokus</span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="pointer-events-auto flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
          >
            <ImageIcon className="h-4 w-4" /> Iz slike
          </button>
          {acceptItem && (
            <button
              type="button"
              onClick={() => void ctrlRef.current?.ocrScan()}
              className="pointer-events-auto flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
              title="Pročitaj broj predmeta / TP iz gornjeg desnog ugla nalepnice (OCR)"
            >
              <Type className="h-4 w-4" /> OCR tekst
            </button>
          )}
          <button
            type="button"
            onClick={() => setContinuousOn((v) => !v)}
            aria-pressed={continuousOn}
            className={`pointer-events-auto flex items-center gap-1 rounded-control border px-2 py-1 hover:bg-white/10 ${
              continuousOn ? 'border-accent text-accent' : 'border-white/20'
            }`}
            title="Neprekidno skeniranje — skener ostaje otvoren posle svakog pogotka"
          >
            <Repeat className="h-4 w-4" /> Neprekidno {continuousOn ? '✓' : ''}
          </button>
          <span className="ml-auto text-white/40">app v{APP_VERSION}</span>
          <button
            type="button"
            // TVRDO osvežavanje (verzija aplikacije), različito i po imenu i po ikoni od
            // mekog „Osveži" (podaci) u zaglavlju `/mob` — v. `lib/app-hard-reset.ts`.
            // Odjavljuje SAMO 3.0 SW/keševe; 1.0 (`/sw.js`, `/m/*`) se ne dira.
            onClick={() => confirmHardResetApp(() => setStatus('♻ Resetujem aplikaciju…'))}
            className="pointer-events-auto flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
            aria-label={HARD_RESET_LABEL}
            title={`${HARD_RESET_LABEL} — povuci najnoviju verziju (kad ekran radi „po starom")`}
          >
            <RotateCcw className="h-4 w-4" /> Resetuj app
          </button>
        </div>

        {/* Dijagnostički red za teren (05.08.2026): model (Chrome ga krije u UA, pa
            se dovlači kroz UA-CH), izbor sočiva, stanje AF-a, zum i da li je
            nišan-gejt aktivan. Bez ovoga se prijava „ne radi na A16" ne može
            razlučiti od „gejt je tiho odbio pogodak". */}
        {cameraOn && diag && <ScanDiagLine diag={diag} />}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void ctrlRef.current?.handleFile(f);
          }}
        />

        <form
          className="pointer-events-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) {
              void ctrlRef.current?.resolve(manual);
              setManual('');
            }
          }}
        >
          <input
            className="flex-1 rounded-control border border-white/30 bg-white/10 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-white"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Ručni unos / HID čitač → Enter"
            // autoFocus samo na uređajima sa mišem/HID čitačem (kiosk PC): na
            // telefonu bi programatski fokus u tap gestu digao soft tastaturu
            // PREKO kamere pre svakog skena. Tap u polje i dalje otvara tastaturu.
            autoFocus={
              typeof window === 'undefined' ||
              !window.matchMedia('(pointer: coarse)').matches
            }
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Traži
          </button>
        </form>

        {continuousOn && results.length > 0 && (
          <div className="pointer-events-auto max-h-32 space-y-1 overflow-y-auto rounded-control border border-white/15 bg-white/5 p-2 text-xs">
            <div className="flex items-center justify-between text-white/60">
              <span>Skenirano u sesiji: {results.length}</span>
              <button type="button" onClick={() => setResults([])} className="underline">
                Očisti listu
              </button>
            </div>
            {results.map((r) => (
              <div key={`${r.code}-${r.at}`} className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 shrink-0 text-status-success" />
                <span className="font-mono">{r.code}</span>
                <span className="ml-auto text-white/40">{KIND_HINT[r.kind]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
