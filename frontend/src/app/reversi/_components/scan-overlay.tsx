'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Flashlight, RefreshCw, Camera } from 'lucide-react';
import { lookupBarcode, type BarcodeKind, type BarcodeResult } from '@/api/reversi';
import {
  attachVideoDecoder,
  buildVideoConstraints,
  decodeImageFile,
  isCameraDecodeSupported,
  isIOSWebKit,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';

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
    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;

    (async () => {
      try {
        // Rezolucija OBAVEZNA (1.0 lekcija): bez ideals-a iOS daje 640×480 pa
        // ZXing/jsQR nemaju piksele za Code128. 'mixed' = 1080p (QR+1D profil).
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...buildVideoConstraints('mixed'), facingMode: 'environment' },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        setCameraOn(true);
        say(hint);

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

        const handle = await attachVideoDecoder({
          video: v,
          formats: ['code_128', 'code_39', 'ean_13', 'qr_code'],
          onRaw: (raw) => void resolve(raw),
          isStopped: () => stopped,
        });
        if (stopped) handle.stop();
        else decoder = handle;
      } catch (e) {
        // getUserMedia pad → poruka; pad učitavanja dekodera (mreža) → posebna.
        const msg = e instanceof Error ? e.message : String(e);
        say(
          /zxing|import|module|network/i.test(msg)
            ? 'Dekoder nije mogao da se učita (mreža?) — koristi „Slikaj barkod" ili ručni unos.'
            : 'Kamera nije dostupna — dozvoli pristup, koristi „Slikaj barkod" ili ručni unos.',
          'error',
        );
      }
    })();

    return () => {
      stopped = true;
      try {
        decoder?.stop();
      } catch {
        /* ignore */
      }
      // iOS release higijena (1.0 releaseVideoStream): pause → stop → srcObject
      // null; bez toga sledeće otvaranje ume da padne NotReadableError.
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
      detectorRef.current = null;
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.load();
        }
      } catch {
        /* ignore */
      }
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
          const detector = detectorRef.current ?? new Ctor({ formats: ['code_128', 'code_39', 'ean_13', 'qr_code'] });
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
      const hit = await decodeImageFile(file, ['code_128', 'code_39', 'ean_13', 'qr_code']);
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
