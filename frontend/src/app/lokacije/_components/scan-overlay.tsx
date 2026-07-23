'use client';

import { useEffect, useRef, useState } from 'react';
import {
  X,
  Zap,
  SwitchCamera,
  Image as ImageIcon,
  RefreshCw,
  ZoomIn,
  Repeat,
  Check,
  Type,
} from 'lucide-react';
import { lookupLocBarcode, type LocBarcodeKind, type LocBarcodeResult } from '@/api/lokacije';
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
  type DecodeFormat,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';

/*
 * Punoekranski skener barkoda za Lokacije — pun port bogatog 1.0 scanModal-a
 * (src/ui/lokacije/scanModal.js, 2757 lin) na 2.0 stack. Dekodiranje ide kroz
 * zajednički decode-engine (`@/lib/barcode-decoder`): BarcodeDetector (Chromium)
 * / ZXing (iPhone item, Firefox, Safari desktop) / jsQR hibrid (iOS + QR) — pa
 * kamera RADI i na iPhone-u (1.0 lekcija: gejt je getUserMedia, ne BarcodeDetector).
 * HID/„Unesi ručno" put ostaje. Napredni kamera-režimi iznad toga:
 *   • Multi-lens izbor objektiva (Samsung A-serija macro/ultra-wide fix) sa
 *     zapamćenim izborom + auto-skok sa „lošeg" objektiva (label + capability heuristika).
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

/** Hard reset klijenta (2.0 nema SW, ali unregister/caches best-effort + cache-bust). */
async function forceAppReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n).catch(() => false)));
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}

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

  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<StatusKind>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [iosBlocker, setIosBlocker] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomCap, setZoomCap] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoomValue, setZoomValue] = useState(1);
  const [lens, setLens] = useState<{ count: number; idx: number }>({ count: 0, idx: -1 });
  const [continuousOn, setContinuousOn] = useState(!!continuous);
  const [results, setResults] = useState<BatchRow[]>([]);
  const [focusRing, setFocusRing] = useState<{ x: number; y: number; id: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const acceptItem = accept.includes('ITEM');

  // Props se prosleđuju kao inline literali (nov identitet svaki render); držimo ih
  // u ref-u da kamera-efekat (mount-only) ne restartuje kameru na svaki render roditelja.
  const cbRef = useRef({ accept, onResult, onClose });
  useEffect(() => {
    cbRef.current = { accept, onResult, onClose };
  });
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
    let vvUnbind: (() => void) | null = null;
    const busyRef = { v: false };
    const cameraOnRef = { v: false };
    const lastRef = { code: '', at: 0 };
    // Kontinuirani re-arm: isti kod se ponovo prihvata TEK kad napusti kadar (miss ili
    // drugi kod duže od REARM_GAP_MS), ne po isteku fiksnog tajmera — stacionarni barkod
    // se NE duplira. REPEAT_GUARD_MS = kratki anti-double gard za ručni/HID unos.
    const REARM_GAP_MS = 900;
    const REPEAT_GUARD_MS = 700;
    const heldRef = { code: '', seenAt: 0 };

    const say = (msg: string, kind: StatusKind = 'info') => {
      setStatus(msg);
      setStatusKind(kind);
    };

    const getTrack = (): MediaStreamTrack | null => {
      const ms = videoRef.current?.srcObject;
      if (!(ms instanceof MediaStream)) return null;
      return ms.getVideoTracks()[0] || null;
    };

    // `position:fixed` prati LAYOUT viewport (uklj. URL bar prostor); kamera prati
    // VISUAL viewport pa retikla „pobegne" iznad vidljivog kadra na iOS/Samsung.
    // Vezujemo overlay na visualViewport dimenzije i pratimo resize/scroll.
    const needsVV = () =>
      typeof window !== 'undefined' &&
      typeof window.visualViewport !== 'undefined' &&
      (isIOSWebPlatform() || isAndroidWebPlatform());
    const bindVV = () => {
      const vv = window.visualViewport;
      const el = rootRef.current;
      if (!vv || !el) return;
      const apply = () => {
        el.style.position = 'fixed';
        el.style.top = `${vv.offsetTop}px`;
        el.style.left = `${vv.offsetLeft}px`;
        el.style.width = `${vv.width}px`;
        el.style.height = `${vv.height}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      };
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      vvUnbind = () => {
        vv.removeEventListener('resize', apply);
        vv.removeEventListener('scroll', apply);
        for (const k of ['top', 'left', 'width', 'height', 'right', 'bottom'] as const)
          el.style.removeProperty(k);
      };
    };

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

    // ── BE razrešavanje (paritet: ITEM/SHELF/UNKNOWN poruke iz 1.0) ──────────
    const resolve = async (raw: string): Promise<void> => {
      const code = normalize(raw);
      if (!code || busyRef.v) return;
      const now = Date.now();
      // Kratki gard protiv slučajnog dvostrukog slanja (ručni/HID); kontinuirani
      // kamera-put re-arm rešava „napustio kadar" gejt u decode petlji (heldRef).
      if (code === lastRef.code && now - lastRef.at < REPEAT_GUARD_MS) return;
      lastRef.code = code;
      lastRef.at = now;
      heldRef.code = code; // latch: isti kod u kadru se ne procesira dok ne izađe
      heldRef.seenAt = now;
      busyRef.v = true;
      setBusy(true);
      try {
        const { data } = await lookupLocBarcode(code);
        if (data.kind === 'UNKNOWN') {
          say(`Nepoznat format: ${code}`, 'error');
          return;
        }
        if (!cbRef.current.accept.includes(data.kind)) {
          say(`${KIND_HINT[data.kind]} nije dozvoljen u ovom koraku`, 'error');
          return;
        }
        // SHELF nejednoznačan / nerazrešen → poruka pariteta, ne prosleđuj.
        if (data.kind === 'SHELF' && !data.record) {
          say(data.message ?? `Polica ${code} nije jednoznačno razrešena`, 'error');
          return;
        }
        if (data.kind === 'ITEM' && (!data.records || data.records.length === 0))
          say(`Stavka ${code} nije trenutno smeštena (nema aktivnog placement-a)`, 'info');
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
        busyRef.v = false;
        setBusy(false);
      }
    };

    // ── Live decode: „kod napustio kadar" gejt nad pogocima decode-engine-a ──
    // Engine (native rAF / ZXing / jsQR hibrid) javlja SAMO pogotke, pa se
    // odsustvo koda meri od poslednjeg viđenja: isti kod posle pauze duže od
    // REARM_GAP_MS = kod je izlazio iz kadra → prihvati ponovo (re-arm);
    // isti kod bez pauze = stacionaran u kadru → ignoriši (bez dupliranja).
    const onDecoderRaw = (raw: string) => {
      if (stopped) return;
      const nrv = normalize(raw);
      if (!nrv) return;
      const now = Date.now();
      if (nrv === heldRef.code) {
        if (now - heldRef.seenAt > REARM_GAP_MS) {
          heldRef.code = '';
        } else {
          heldRef.seenAt = now;
          return;
        }
      } else if (heldRef.code && now - heldRef.seenAt > REARM_GAP_MS) {
        heldRef.code = '';
      }
      if (nrv !== heldRef.code) void resolve(raw);
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
      await safeApplyFlat(track, { zoom: auto }, isAndroidWebPlatform());
    };
    const applyZoomDebounced = (value: number) => {
      if (isAndroidWebPlatform() && !isAndroidChromeBrowser()) return;
      if (zoomTimer) clearTimeout(zoomTimer);
      zoomTimer = window.setTimeout(async () => {
        zoomTimer = 0;
        const track = getTrack();
        if (!track) return;
        await safeApplyFlat(track, { zoom: value }, isAndroidWebPlatform());
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
      if (manualPick) writeCamChoice(dev.deviceId, dev.label || '');
      await startCamera(dev.deviceId);
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

    const afterCameraReady = async (track: MediaStreamTrack | null) => {
      if (!track || stopped) return;
      detectTorch(track);
      await applyAntiGlare(track);
      await applyAFBestEffort(track);
      await refreshLensList(track);
      await setupZoom(track);
      reportDiag(track);
      await autoSwitchBadLens(track);
    };

    // ── Start / restart kamere (deviceId override za lens/force-back) ────────
    const startCamera = async (deviceId?: string): Promise<void> => {
      if (stopped) return;
      // 1.0 lekcija (isScanSupported): podrška se gejtuje SAMO na getUserMedia.
      // BarcodeDetector NIJE uslov — iPhone/Firefox dobijaju ZXing/jsQR put.
      if (!isCameraDecodeSupported()) {
        say(
          'Kamera nije dostupna u ovom pregledaču (getUserMedia) — proveri HTTPS, ili koristi HID čitač / ručni unos.',
          'error',
        );
        return;
      }
      stopStream();
      // Samsung Internet: OS release prethodne sesije kasni ~350ms; iOS WebKit
      // traži ~180ms pre novog getUserMedia (1.0 barcode.js:772-774).
      if (isSamsungInternetBrowser()) await new Promise((r) => setTimeout(r, 350));
      else if (isIOSWebPlatform()) await new Promise((r) => setTimeout(r, 180));
      if (stopped) return;

      const acceptShelf = cbRef.current.accept.includes('SHELF');
      const formats: DecodeFormat[] = acceptShelf
        ? ['code_128', 'code_39', 'itf', 'ean_13', 'qr_code']
        : ['code_128', 'code_39', 'itf', 'ean_13'];
      // iOS item profil = 2880×1620 (RNZ Code128 na 1080p nema dovoljno piksela
      // za ZXing — 1.0 fd252cb/e48b763); ostalo 1920×1080.
      const videoBase: MediaTrackConstraints = buildVideoConstraints(
        acceptShelf ? 'mixed' : 'item',
      );
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { ...videoBase, deviceId: { exact: deviceId } }
          : { ...videoBase, facingMode: { ideal: 'environment' } },
      };

      say(deviceId ? 'Prebacujem objektiv…' : '📷 Tražim kameru…');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        // Ako je izabrani (keširan) deviceId nestao, probaj default environment.
        if (deviceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { ...videoBase, facingMode: { ideal: 'environment' } },
            });
          } catch (e2) {
            say(formatCameraError(e2), 'error');
            return;
          }
        } else {
          say(formatCameraError(e), 'error');
          return;
        }
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const v = videoRef.current;
      if (!v) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      v.srcObject = stream;
      try {
        v.setAttribute('playsinline', '');
        v.playsInline = true;
        v.muted = true;
        await v.play();
      } catch {
        /* autoplay guard — muted playsInline obično prolazi */
      }
      const track = stream.getVideoTracks()[0] ?? null;
      curDeviceId =
        deviceId ?? (track?.getSettings() as unknown as CamSettings)?.deviceId ?? null;
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
    };

    // ── Decode iz slike — 1.0 paritet: ZXing 11-pokušaja pipeline (radi i na
    // iPhone-u!); nativni BarcodeDetector je samo BRZI prvi pokušaj gde postoji.
    const handleFile = async (file: File): Promise<void> => {
      if (!/^image\//.test(file.type || '')) {
        say('⚠ Odaberi fajl tipa slike (JPG / PNG).', 'warn');
        return;
      }
      say('🔍 Čitam sliku…');
      const acceptShelf = cbRef.current.accept.includes('SHELF');
      const formats: DecodeFormat[] = acceptShelf
        ? ['code_128', 'code_39', 'itf', 'ean_13', 'qr_code']
        : ['code_128', 'code_39', 'itf', 'ean_13'];
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
            if (found[0]?.rawValue) {
              navigator.vibrate?.(80);
              await resolve(found[0].rawValue);
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
    const tapFocus = async (clientX: number, clientY: number): Promise<void> => {
      const track = getTrack();
      const v = videoRef.current;
      if (!track || !v) return;
      const caps = (track.getCapabilities?.() as unknown as CamCapabilities) || {};
      const modes = Array.isArray(caps.focusMode) ? caps.focusMode.map(String) : [];
      const rect = v.getBoundingClientRect();
      setFocusRing({ x: clientX - rect.left, y: clientY - rect.top, id: Date.now() });
      window.setTimeout(() => setFocusRing((r) => (r && Date.now() - r.id >= 550 ? null : r)), 600);
      if (!(modes.includes('single-shot') && 'pointsOfInterest' in caps)) {
        if (modes.includes('continuous') && !isAndroidChromeBrowser())
          await safeApplyFlat(track, { focusMode: 'continuous' }, isAndroidWebPlatform());
        return;
      }
      const m = mapPointerToVideoNormalizedPlane(v, clientX, clientY);
      if (!m) return;
      await safeApplyFlat(
        track,
        { focusMode: 'single-shot', pointsOfInterest: [{ x: m.x, y: m.y }] },
        isAndroidWebPlatform(),
      );
      if (modes.includes('continuous') && !isAndroidChromeBrowser()) {
        await new Promise((r) => setTimeout(r, 320));
        await safeApplyFlat(track, { focusMode: 'continuous' }, isAndroidWebPlatform());
      }
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
      restart: () => startCamera(),
    };

    // ── Globalni event-i ────────────────────────────────────────────────────
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cbRef.current.onClose();
      }
    };
    const onPageHide = () => {
      try {
        stopStream();
      } catch {
        /* ignore */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onPageHide();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);

    // ── Init ────────────────────────────────────────────────────────────────
    if (pitfalls.blocker) {
      setIosBlocker(pitfalls.blocker);
      say(pitfalls.blocker, 'error');
    } else {
      if (needsVV()) bindVV();
      const saved = readCamChoice();
      void startCamera(saved?.deviceId);
    }

    return () => {
      stopped = true;
      if (zoomTimer) clearTimeout(zoomTimer);
      if (vvUnbind) vvUnbind();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      stopStream();
      void terminateLabelOcrWorker();
      ctrlRef.current = null;
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
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Topbar */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 text-white">
        <span className="text-md truncate font-semibold">{title}</span>
        <div className="flex items-center gap-1">
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

      {/* Video + retikla + focus ring */}
      <div className="relative flex-1 overflow-hidden bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
          onPointerDown={(e) => void ctrlRef.current?.tapFocus(e.clientX, e.clientY)}
        />
        {cameraOn && !iosBlocker && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-40 w-72 rounded-panel border-2 border-white/70" />
          </div>
        )}
        {focusRing && (
          <div
            className="pointer-events-none absolute h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-status-success"
            style={{ left: focusRing.x, top: focusRing.y, animation: 'ping 0.6s ease-out' }}
            aria-hidden
          />
        )}
        {iosBlocker && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/90">
            <p className="max-w-sm whitespace-pre-line">{iosBlocker}</p>
          </div>
        )}
        {/* Zoom slider — samo kad uređaj izlaže track zoom capability */}
        {zoomCap && (
          <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2 px-6">
            <div className="flex w-full max-w-md items-center gap-2 rounded-control bg-black/60 px-3 py-2 text-white">
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
      </div>

      {/* Donji panel: status, alati, ručni unos, batch lista */}
      <div className="space-y-3 bg-black/80 px-4 py-4 text-white">
        {status && (
          <p className={`text-sm whitespace-pre-line ${statusClass}`} aria-live="polite">
            {status}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 text-xs text-white/70">
          <span>Tap na video = fokus</span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
          >
            <ImageIcon className="h-4 w-4" /> Iz slike
          </button>
          {acceptItem && (
            <button
              type="button"
              onClick={() => void ctrlRef.current?.ocrScan()}
              className="flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
              title="Pročitaj broj predmeta / TP iz gornjeg desnog ugla nalepnice (OCR)"
            >
              <Type className="h-4 w-4" /> OCR tekst
            </button>
          )}
          <button
            type="button"
            onClick={() => setContinuousOn((v) => !v)}
            aria-pressed={continuousOn}
            className={`flex items-center gap-1 rounded-control border px-2 py-1 hover:bg-white/10 ${
              continuousOn ? 'border-accent text-accent' : 'border-white/20'
            }`}
            title="Neprekidno skeniranje — skener ostaje otvoren posle svakog pogotka"
          >
            <Repeat className="h-4 w-4" /> Neprekidno {continuousOn ? '✓' : ''}
          </button>
          <span className="ml-auto text-white/40">app v{APP_VERSION}</span>
          <button
            type="button"
            onClick={() => {
              setStatus('♻ Osvežavam aplikaciju…');
              void forceAppReload().catch(() => window.location.reload());
            }}
            className="flex items-center gap-1 rounded-control border border-white/20 px-2 py-1 hover:bg-white/10"
            title="Hard refresh — očisti keš klijenta (npr. kad autofill radi po starom)"
          >
            <RefreshCw className="h-4 w-4" /> Osveži app
          </button>
        </div>

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
          className="flex gap-2"
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
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-control border border-white/15 bg-white/5 p-2 text-xs">
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
