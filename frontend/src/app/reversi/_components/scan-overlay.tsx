'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Flashlight, RefreshCw, Camera } from 'lucide-react';
import { lookupBarcode, type BarcodeKind, type BarcodeResult } from '@/api/reversi';
import {
  applyAndroidPostStartTuning,
  attachVideoDecoder,
  buildVideoConstraints,
  cameraCooldownMs,
  decodeImageFile,
  isCameraDecodeSupported,
  isIOSWebKit,
  isSamsungInternetBrowser,
  preloadVideoDecoder,
  type DecodeFormat,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';
import { pickPreferredBackCamera, shouldRunCameraPicker } from '@/lib/camera-picker';

/** Formati skenera reversa (isti set za živu kameru, „Slikaj barkod" i preload). */
const SCAN_FORMATS: DecodeFormat[] = ['code_128', 'code_39', 'ean_13', 'qr_code'];

// Nativni BarcodeDetector (Chrome/Edge/Android WebView) — brzi put; tamo gde ga
// nema (iPhone/Firefox/Safari) decode-engine (@/lib/barcode-decoder) daje ZXing/jsQR.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource | ImageBitmap) => Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

// torch/zoom/focusMode nisu u standardnom TS lib.dom — proširujemo lokalno.
interface CamRange {
  min: number;
  max: number;
  step?: number;
}
interface CamCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: CamRange;
  focusMode?: string[];
}
interface CamConstraint {
  torch?: boolean;
  zoom?: number;
  focusMode?: string;
  pointsOfInterest?: { x: number; y: number }[];
}

/** torch/zoom/focus nisu u tipovima lib.dom — obavij u `advanced` uz siguran cast. */
function advanced(c: CamConstraint): MediaTrackConstraints {
  return { advanced: [c] as unknown as MediaTrackConstraintSet[] };
}

function getDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

function normalize(raw: string): string {
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) t = t.slice(1, -1);
  const zw = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
  return [...t].filter((ch) => !zw.has(ch.codePointAt(0)!)).join('').trim();
}

const KIND_HINT: Record<BarcodeKind, string> = {
  HAND: 'Ručni alat',
  CUTTING: 'Rezni alat',
  EMPLOYEE: 'Kartica radnika',
  UNKNOWN: 'Nepoznat format',
};

/**
 * „Ažuriraj app" (RB-60) — odjavi service worker + obriši keš + reload sa cache-bust
 * parametrom. Kada mobilni SW servira stari bundle, ovo je jedini pouzdan izlaz.
 */
async function forceAppReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    }
  } catch {
    /* ignore */
  }
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n).catch(() => {})));
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}

/**
 * Punoekranski skener barkoda — paritet 1.0 `openReversiScanOverlay` (RB-60). Kamera
 * (BarcodeDetector) + torch, auto-zoom ~2× sa klizačem, tap-fokus, „Slikaj barkod"
 * still-image fallback i „Ažuriraj app". `accept` filtrira dozvoljene tipove;
 * `acceptUnknown` propušta nepoznat format (npr. ZADU-M- šifra mašine). `continuous`
 * drži skener otvoren posle svakog uspešnog skena (čipovi + dedup u sesiji).
 *
 * Dekodiranje: decode-engine (@/lib/barcode-decoder) — BarcodeDetector (Chromium),
 * ZXing (iPhone/Firefox/Safari), jsQR hibrid (iOS QR); still-image = ZXing 11-pokušaja
 * pipeline. Paritet 1.0 dekodera je time potpun (22.07 — iPhone incident).
 *
 * Android higijena kamere (31.07, isti paket kao glavna ljuska — 1.0 barcode.js):
 * cooldown pre getUserMedia, capability picker sočiva (`@/lib/camera-picker`), retry
 * na prolaznu grešku, post-start tuning (anti-glare + AF) i release na
 * pagehide/visibilitychange — uz OBAVEZAN put nazad: povratak u prvi plan
 * (visible/pageshow) ponovo pokreće celu start-sekvencu (bez toga bi i „Slikaj
 * barkod" trajno ugasio kameru), generacijski zaštićen od preklapanja startova.
 * Dekoder na Androidu ide na NATIVNI put (`preferNative`, 1.0 per-profil kanon —
 * gust 1D Code128). Auto-zoom 2× i tap-fokus ostaju nepromenjeni.
 */
export function ScanOverlay({
  title = 'Skeniraj barkod',
  hint = 'Usmeri kameru na barkod nalepnice',
  accept = ['HAND', 'CUTTING', 'EMPLOYEE'],
  acceptUnknown = false,
  continuous = false,
  onResult,
  onClose,
}: {
  title?: string;
  hint?: string;
  accept?: BarcodeKind[];
  acceptUnknown?: boolean;
  continuous?: boolean;
  onResult: (r: BarcodeResult) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  // Barkodi već prihvaćeni u kontinualnoj sesiji — isti komad ostaje u kadru pa se
  // dekoduje svakih par frejmova; bez ovoga bi bio dodat više puta.
  const acceptedRef = useRef<Set<string>>(new Set());
  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<'info' | 'error'>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [zoom, setZoom] = useState<{ min: number; max: number; step: number; value: number } | null>(null);
  const [chips, setChips] = useState<{ barcode: string; label: string }[]>([]);

  // Roditelj prosleđuje callback-e kao inline literale (nov identitet po renderu).
  // Držimo ih u ref-u da kamera-efekat i `resolve` ostanu stabilni (kamera se ne gasi
  // i ne pali na svaki render roditelja).
  const cbRef = useRef({ accept, acceptUnknown, continuous, onResult, onClose });
  useEffect(() => {
    cbRef.current = { accept, acceptUnknown, continuous, onResult, onClose };
  });

  const say = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setStatus(msg);
    setStatusKind(kind);
  }, []);

  const resolve = useCallback(
    async (raw: string) => {
      const code = normalize(raw);
      if (!code || busyRef.current) return;
      const now = Date.now();
      if (code === lastRef.current.code && now - lastRef.current.at < 1500) return;
      lastRef.current = { code, at: now };
      const cont = cbRef.current.continuous;
      if (cont && acceptedRef.current.has(code)) {
        say(`${code} je već dodat`);
        return;
      }
      busyRef.current = true;
      try {
        const { data } = await lookupBarcode(code);
        if (data.kind === 'UNKNOWN') {
          if (cbRef.current.acceptUnknown) {
            navigator.vibrate?.(80);
            cbRef.current.onResult(data);
            if (!cont) cbRef.current.onClose();
            return;
          }
          return say(`Nepoznat format: ${code}`, 'error');
        }
        if (!cbRef.current.accept.includes(data.kind))
          return say(`${KIND_HINT[data.kind]} nije dozvoljen u ovom koraku`, 'error');
        if (!data.record) return say(`Barkod ${code} nije u evidenciji`, 'error');
        navigator.vibrate?.(80);
        if (cont) {
          acceptedRef.current.add(code);
          const rec = data.record as Record<string, unknown>;
          const label =
            (rec.full_name as string) ||
            (rec.naziv as string) ||
            (rec.oznaka as string) ||
            code;
          setChips((cs) => [{ barcode: code, label: String(label) }, ...cs].slice(0, 12));
          say(`${code} · dodato`);
        }
        cbRef.current.onResult(data);
        if (!cont) cbRef.current.onClose();
      } catch (e) {
        say(e instanceof Error ? e.message : 'Greška pri razrešavanju.', 'error');
      } finally {
        busyRef.current = false;
      }
    },
    [say],
  );

  // Kamera + decode-engine (BarcodeDetector/ZXing/jsQR — radi i na iPhone-u)
  // + capabilities (torch/zoom).
  useEffect(() => {
    // 1.0 lekcija: gejt je getUserMedia, NE BarcodeDetector (iPhone → ZXing put).
    if (!isCameraDecodeSupported()) {
      say('Kamera nije dostupna u ovom pregledaču (getUserMedia/HTTPS) — koristi HID čitač, ručni unos ili „Slikaj barkod".', 'error');
      return;
    }
    // Dekoder chunk (ZXing ~250KB) se vuče LAZY — zagrej ga paralelno sa kamerom.
    // Ovaj ekran na Androidu ide nativnim putem (`preferNative`), ALI mu ZXing i
    // dalje treba kao watchdog fallback (mrtav GmsCore barcode modul), pa se
    // preload namerno ne preskače.
    preloadVideoDecoder(SCAN_FORMATS);

    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;
    let tuneTimer = 0;
    // Generacija starta kamere (isti obrazac kao `decoderSeq` u lokacije ljusci):
    // `release()` je podiže, pa svaki start KOJI JE U LETU (cooldown, picker probe,
    // retry pauza, lazy ZXing chunk) sam odustane čim ga pretekne noviji — pokriva
    // i kameru puštenu zbog odlaska u pozadinu.
    let gen = 0;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Dva rAF ciklusa posle release-a: tek tada je prethodni video pipeline srušen.
    const twoRafs = (): Promise<void> =>
      new Promise<void>((r) => {
        if (typeof requestAnimationFrame !== 'function') {
          r();
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      });

    // iOS release higijena (1.0 releaseVideoStream): pause → stop → srcObject null;
    // bez toga sledeće otvaranje ume da padne NotReadableError. Deli je retry,
    // pagehide/visibility i cleanup.
    const release = () => {
      gen++; // obara i start koji je u letu
      if (tuneTimer) {
        clearTimeout(tuneTimer);
        tuneTimer = 0;
      }
      try {
        decoder?.stop();
      } catch {
        /* ignore */
      }
      decoder = null;
      if (isIOSWebKit()) {
        try {
          videoRef.current?.pause();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      trackRef.current = null;
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.load();
        }
      } catch {
        /* ignore */
      }
    };

    // Prolazna greška (OS još drži senzor) vs prava — 1.0 barcode.js:1120-1144.
    const isTransientCameraError = (err: unknown): boolean => {
      const e = err as { name?: string; message?: string } | null;
      const re = /NotReadableError|AbortError|TrackStartError|could not start video source/i;
      return re.test(String(e?.name || '')) || re.test(String(e?.message || ''));
    };

    // CELA start-sekvenca kamere u jednoj funkciji — zove se na mount I na povratak
    // iz pozadine (v. `onResume`). Svaki `await` proverava sopstvenu generaciju.
    const startCamera = async (): Promise<void> => {
      if (stopped) return;
      let myGen = ++gen; // ovaj start je od sada „vlasnik" kamere
      const aborted = () => stopped || myGen !== gen;

      // getUserMedia sa retry-jem: pusti kameru, 700ms + dva frejma, pa isti
      // constraints još jednom (Samsung Internet dva puta — najsporiji release).
      const openStream = async (c: MediaStreamConstraints): Promise<MediaStream> => {
        const maxRetries = isSamsungInternetBrowser() ? 2 : 1;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            // PRVO provera, TEK ONDA release(): ako je noviji start (povratak iz
            // pozadine) već preuzeo, ovaj retry bi mu ubio stream i „ukrao" generaciju.
            if (aborted()) throw lastErr ?? new Error('Skener je zatvoren');
            const expected = gen + 1;
            release();
            if (gen === expected) myGen = gen; // re-arm samo ako je bump naš
            await sleep(700);
            await twoRafs();
            if (aborted()) throw lastErr ?? new Error('Skener je zatvoren');
            say(`Kamera je bila zauzeta — pokušavam ponovo (${attempt}/${maxRetries})…`);
          }
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

      try {
        // Cooldown pre PRVOG getUserMedia — Samsung Internet oslobađa kameru
        // prethodne sesije sa ~350-450ms zakašnjenja (1.0 barcode.js:298-314).
        const cd = cameraCooldownMs();
        if (cd) await sleep(cd);
        if (aborted()) return;

        // Capability picker: na Android multi-lens telefonima `facingMode` ume da
        // vrati macro objektiv (fiksni fokus ~3cm) — preview radi, barkod nikad
        // ne dekodira. Pad pickera = nastavi starim (facingMode) putem.
        let deviceId: string | null = null;
        if (shouldRunCameraPicker()) {
          try {
            deviceId = await pickPreferredBackCamera();
          } catch {
            deviceId = null;
          }
          if (aborted()) return;
        }

        // Rezolucija OBAVEZNA (1.0 lekcija): bez ideals-a iOS daje 640×480 pa
        // ZXing/jsQR nemaju piksele za Code128. 'mixed' = 1080p (QR+1D profil).
        const base = buildVideoConstraints('mixed');
        let stream: MediaStream;
        try {
          stream = await openStream({
            video: deviceId
              ? { ...base, deviceId: { exact: deviceId } }
              : { ...base, facingMode: 'environment' },
          });
        } catch (e) {
          if (!deviceId || aborted()) throw e;
          // Izabrani objektiv nestao/zauzet → default zadnja kamera (staro ponašanje).
          stream = await openStream({ video: { ...base, facingMode: 'environment' } });
        }
        if (aborted()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const v = videoRef.current;
        if (!v) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          trackRef.current = null;
          return;
        }
        v.srcObject = stream;
        // JS asercija atributa pre play() (paritet glavne ljuske): bez
        // playsinline/webkit-playsinline WebKit otvara fullscreen plejer i skena nema.
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.playsInline = true;
        v.muted = true;
        await v.play();
        if (aborted()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setCameraOn(true);
        say(hint);

        // Anti-glare ekspozicija + AF (samo Android) TEK kad se pipeline slegne —
        // constraint-i odmah po play() umeju da budu tiho odbačeni (1.0 lekcija).
        // Auto-zoom ispod ostaje netaknut; tuning ne dira zoom.
        if (track) {
          tuneTimer = window.setTimeout(() => void applyAndroidPostStartTuning(track), 500);
        }

        // Capabilities: torch + auto-zoom ~2× (paritet 1.0 setupZoomUI).
        try {
          const caps = (track?.getCapabilities?.() ?? {}) as CamCapabilities;
          if (caps.torch) setTorchSupported(true);
          if (caps.zoom && caps.zoom.max > caps.zoom.min + 0.01) {
            const step = caps.zoom.step || 0.1;
            const auto = Math.min(caps.zoom.max, Math.max(caps.zoom.min, 2));
            setZoom({ min: caps.zoom.min, max: caps.zoom.max, step, value: auto });
            await track?.applyConstraints(advanced({ zoom: auto }));
          }
        } catch {
          /* capabilities nepodržane — skener i dalje radi bez torch/zoom */
        }
        if (aborted()) return;

        const handle = await attachVideoDecoder({
          video: v,
          formats: SCAN_FORMATS,
          onRaw: (raw) => void resolve(raw),
          isStopped: () => aborted(),
          // 1.0 per-profil kanon (scanOverlay.js:431): reversi nalepnice su gust
          // 1D Code128 — na Android Chrome-u nativni BarcodeDetector pouzdanije
          // dekodira ŽIVI kadar od ZXing-a (koji na gustom kodu iz ruke promašuje).
          // Mrtav GmsCore modul pokriva watchdog u engine-u (vrući prelaz na ZXing).
          preferNative: true,
        });
        if (aborted()) handle.stop();
        else decoder = handle;
      } catch (e) {
        if (aborted()) return; // tuđi start / zatvaranje — bez lažne greške
        // getUserMedia pad → poruka; pad učitavanja dekodera (mreža) → posebna.
        const msg = e instanceof Error ? e.message : String(e);
        say(
          /zxing|import|module|network/i.test(msg)
            ? 'Dekoder nije mogao da se učita (mreža?) — koristi „Slikaj barkod" ili ručni unos.'
            : 'Kamera nije dostupna — dozvoli pristup, koristi „Slikaj barkod" ili ručni unos.',
          'error',
        );
      }
    };

    void startCamera();

    // Pozadina / zaključan ekran mora da PUSTI kameru — inače povratak u tab daje
    // zamrznut preview ili NotReadableError (paritet glavne ljuske). POVRATAK mora
    // da je VRATI: ovde `hidden` okida i „Slikaj barkod" (file picker!), pa bi bez
    // resume-a jedan tap na kameru-ikonicu trajno ugasio živi skener.
    const onHidden = () => {
      try {
        release();
      } catch {
        /* ignore */
      }
    };
    const onResume = () => {
      if (stopped || streamRef.current) return; // overlay zatvoren ili kamera već živa
      say('Vraćam kameru…');
      void startCamera();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHidden();
      else onResume();
    };
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', onResume); // bfcache povratak (iOS Safari)
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      if (tuneTimer) clearTimeout(tuneTimer);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
      detectorRef.current = null;
    };
  }, [resolve, say, hint]);

  // Esc zatvara SAMO skener. Capture-faza + stopPropagation presreće događaj pre
  // roditeljskog Dialog-a (koji takođe sluša window keydown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cbRef.current.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints(advanced({ torch: next }));
      setTorchOn(next);
    } catch {
      say('Baterijska lampa nije dostupna na ovom uređaju.', 'error');
    }
  }

  async function applyZoom(v: number) {
    setZoom((z) => (z ? { ...z, value: v } : z));
    try {
      await trackRef.current?.applyConstraints(advanced({ zoom: v }));
    } catch {
      /* ignore */
    }
  }

  async function tapFocus(e: React.PointerEvent<HTMLVideoElement>) {
    const track = trackRef.current;
    const v = videoRef.current;
    if (!track || !v) return;
    const rect = v.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // Fokus-prsten uvek (vizuelna potvrda tapa), čak i kad focusMode nije podržan.
    const ring = document.createElement('div');
    ring.style.cssText = `position:absolute;left:${e.clientX - rect.left}px;top:${e.clientY - rect.top}px;width:56px;height:56px;margin:-28px 0 0 -28px;border:2px solid rgba(255,255,255,.9);border-radius:9999px;pointer-events:none;animation:none;`;
    v.parentElement?.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
    try {
      await track.applyConstraints(advanced({ focusMode: 'manual', pointsOfInterest: [{ x, y }] }));
    } catch {
      /* tap-fokus nepodržan — prsten je i dalje vizuelna potvrda */
    }
  }

  async function onPickPhoto(file: File) {
    say('Dekodiram sliku…');
    try {
      // Brzi pokušaj nativnim detektorom (Chromium); iPhone/Firefox → ZXing pipeline.
      const Ctor = getDetectorCtor();
      if (Ctor) {
        try {
          const detector = detectorRef.current ?? new Ctor({ formats: SCAN_FORMATS });
          const bitmap = await createImageBitmap(file);
          const found = await detector.detect(bitmap);
          bitmap.close?.();
          if (found[0]?.rawValue) {
            say('');
            await resolve(found[0].rawValue);
            return;
          }
        } catch {
          /* padni na ZXing pipeline */
        }
      }
      // 1.0 anti-glare pipeline (grayscale/kontrast/upscale + Code128-first).
      const hit = await decodeImageFile(file, SCAN_FORMATS);
      if (hit) {
        say('');
        await resolve(hit);
      } else {
        say('Barkod nije prepoznat na slici — priđi bliže, drži oštro i ravno.', 'error');
      }
    } catch {
      say('Greška pri dekodiranju slike.', 'error');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-md font-semibold">{title}</span>
        <div className="flex items-center gap-1">
          {torchSupported && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-label="Baterijska lampa"
              aria-pressed={torchOn}
              className={`rounded-full p-1.5 hover:bg-white/10 ${torchOn ? 'text-status-warn' : 'text-white'}`}
            >
              <Flashlight className="h-5 w-5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => void forceAppReload()}
            aria-label="Ažuriraj app"
            title="Ažuriraj app (odjavi SW + obriši keš)"
            className="rounded-full p-1.5 text-white hover:bg-white/10"
          >
            <RefreshCw className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Zatvori" className="rounded-full p-1.5 text-white hover:bg-white/10">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          playsInline
          muted
          onPointerDown={(e) => void tapFocus(e)}
          className="h-full w-full object-cover"
        />
        {cameraOn && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-40 w-72 rounded-panel border-2 border-white/70" />
          </div>
        )}
        {continuous && chips.length > 0 && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1.5 bg-gradient-to-t from-black/80 to-transparent p-3">
            {chips.map((c) => (
              <span key={c.barcode} className="tnums rounded-full bg-white/15 px-2 py-0.5 text-2xs text-white">
                {c.barcode} · {c.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {zoom && (
        <div className="flex items-center gap-2 bg-black/80 px-4 py-2 text-white">
          <button
            type="button"
            aria-label="Smanji zoom"
            className="rounded-control bg-white/10 px-2.5 py-1 text-sm"
            onClick={() => void applyZoom(Math.max(zoom.min, zoom.value - zoom.step))}
          >
            −
          </button>
          <input
            type="range"
            min={zoom.min}
            max={zoom.max}
            step={zoom.step}
            value={zoom.value}
            aria-label="Zoom"
            className="flex-1 accent-accent"
            onChange={(e) => void applyZoom(Number(e.target.value))}
          />
          <span className="tnums w-10 text-right text-xs">{zoom.value.toFixed(1)}×</span>
          <button
            type="button"
            aria-label="Povećaj zoom"
            className="rounded-control bg-white/10 px-2.5 py-1 text-sm"
            onClick={() => void applyZoom(Math.min(zoom.max, zoom.value + zoom.step))}
          >
            +
          </button>
        </div>
      )}

      <div className="space-y-3 bg-black/80 px-4 py-4 text-white">
        {status && (
          <p className={statusKind === 'error' ? 'text-sm text-status-danger' : 'text-sm text-white/80'} aria-live="polite">
            {status}
          </p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) {
              void resolve(manual);
              setManual('');
            }
          }}
        >
          <input
            className="flex-1 rounded-control border border-white/30 bg-white/10 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-white"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Ručni unos / HID čitač → Enter"
            autoFocus
          />
          <button type="submit" className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white">
            Traži
          </button>
          <button
            type="button"
            aria-label="Slikaj barkod"
            title="Slikaj barkod (fallback bez žive kamere)"
            className="rounded-control bg-white/10 px-3 py-2 text-sm text-white"
            onClick={() => fileRef.current?.click()}
          >
            <Camera className="h-4 w-4" aria-hidden />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPickPhoto(f);
            }}
          />
        </form>
      </div>
    </div>
  );
}
