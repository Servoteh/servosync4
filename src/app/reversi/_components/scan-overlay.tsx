'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { lookupBarcode, type BarcodeKind, type BarcodeResult } from '@/api/reversi';

// Nativni BarcodeDetector (Chrome/Edge/Android WebView; nije u Firefox/Safari desktop).
// Bez eksternih zavisnosti — HID čitač i „Unesi ručno" su fallback svuda.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

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
 * Punoekranski skener barkoda — paritet 1.0 openReversiScanOverlay (kamera →
 * razrešavanje kroz BE → onResult). `accept` filtrira dozvoljene tipove
 * (npr. samo HAND za Izdaj alat). Uz kameru: HID čitač kuca u polje „Ručni
 * unos", pa isti tok razrešavanja.
 */
export function ScanOverlay({
  title = 'Skeniraj barkod',
  accept = ['HAND', 'CUTTING', 'EMPLOYEE'],
  onResult,
  onClose,
}: {
  title?: string;
  accept?: BarcodeKind[];
  onResult: (r: BarcodeResult) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<'info' | 'error'>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);

  // Roditelj prosleđuje `accept`/`onResult`/`onClose` kao inline literale (nov
  // identitet na svaki render). Držimo ih u ref-u da `resolve` i kamera-efekat
  // ostanu stabilni — inače se kamera gasi i ponovo pali na svaki render roditelja.
  const cbRef = useRef({ accept, onResult, onClose });
  useEffect(() => {
    cbRef.current = { accept, onResult, onClose };
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
      busyRef.current = true;
      try {
        const { data } = await lookupBarcode(code);
        if (data.kind === 'UNKNOWN') return say(`Nepoznat format: ${code}`, 'error');
        if (!cbRef.current.accept.includes(data.kind))
          return say(`${KIND_HINT[data.kind]} nije dozvoljen u ovom koraku`, 'error');
        if (!data.record) return say(`Barkod ${code} nije u evidenciji`, 'error');
        navigator.vibrate?.(80);
        cbRef.current.onResult(data);
        cbRef.current.onClose();
      } catch (e) {
        say(e instanceof Error ? e.message : 'Greška pri razrešavanju.', 'error');
      } finally {
        busyRef.current = false;
      }
    },
    [say],
  );

  // Kamera + petlja detekcije.
  useEffect(() => {
    const Ctor = getDetectorCtor();
    if (!Ctor) {
      say('Kamera-skener nije podržan u ovom pregledaču — koristi HID čitač ili ručni unos.', 'error');
      return;
    }
    let raf = 0;
    let stopped = false;
    const detector = new Ctor({ formats: ['code_128', 'code_39', 'ean_13', 'qr_code'] });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        setCameraOn(true);
        say('Usmeri kameru na barkod nalepnice');
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found[0]?.rawValue) await resolve(found[0].rawValue);
          } catch {
            /* prazan frejm — ignoriši */
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
      } catch {
        say('Kamera nije dostupna — dozvoli pristup ili koristi ručni unos.', 'error');
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [resolve, say]);

  // Esc zatvara SAMO skener. Capture-faza + stopPropagation presreće događaj pre
  // roditeljskog Dialog-a (koji takođe sluša window keydown) — inače jedan Esc
  // sruši i skener i ceo tok Izdaj.
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

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-md font-semibold">{title}</span>
        <button type="button" onClick={onClose} aria-label="Zatvori" className="rounded-full p-1 hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {cameraOn && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="h-40 w-72 rounded-panel border-2 border-white/70" />
          </div>
        )}
      </div>

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
        </form>
      </div>
    </div>
  );
}
