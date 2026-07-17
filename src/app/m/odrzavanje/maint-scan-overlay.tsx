'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Punoekranski QR/barkod skener sredstava za mobilno Održavanje (H21). Za razliku od
 * lokacije/reversi ScanOverlay-a (koji razrešavaju kroz svoj BE lookup), maint skener
 * VRAĆA sirov kod pozivaocu — uparivanje ide lokalno protiv GET /maintenance/assets
 * (asset_code, case-insensitive) kao u 1.0 myMaintenance.js:363-373.
 *
 * BarcodeDetector (Chrome/Edge/Android WebView). Na pregledaču bez njega (Firefox/Safari
 * desktop) skener tiho javlja „nije dostupan — ukucaj šifru" i ostaje ručni unos / HID
 * čitač (skriveno pravilo §5.1). Odštampane QR nalepnice enkodiraju URL karton-rute pa
 * pozivalac vadi poslednji segment putanje — sirov kod se svejedno predaje ovde.
 */

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

export function MaintScanOverlay({
  title = '📷 Skeniraj QR sredstva',
  onCode,
  onClose,
}: {
  title?: string;
  onCode: (code: string) => void;
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

  // Roditelj prosleđuje callback-ove kao inline literale (nov identitet svaki render);
  // držimo ih u ref-u da kamera-efekat ostane stabilan (bez gašenja/paljenja kamere).
  const cbRef = useRef({ onCode, onClose });
  useEffect(() => {
    cbRef.current = { onCode, onClose };
  });

  const say = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setStatus(msg);
    setStatusKind(kind);
  }, []);

  const resolve = useCallback((raw: string) => {
    const code = normalize(raw);
    if (!code || busyRef.current) return;
    const now = Date.now();
    if (code === lastRef.current.code && now - lastRef.current.at < 1500) return;
    lastRef.current = { code, at: now };
    busyRef.current = true;
    navigator.vibrate?.(80);
    cbRef.current.onCode(code);
    cbRef.current.onClose();
  }, []);

  useEffect(() => {
    const Ctor = getDetectorCtor();
    if (!Ctor) {
      say('Skener nije dostupan u ovom pregledaču — ukucaj šifru ili koristi HID čitač.', 'error');
      return;
    }
    let raf = 0;
    let stopped = false;
    const detector = new Ctor({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
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
        say('Usmeri kameru na QR nalepnicu sredstva');
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found[0]?.rawValue) resolve(found[0].rawValue);
          } catch {
            /* prazan frejm — ignoriši */
          }
          if (!stopped) raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
      } catch {
        say('Kamera nije dostupna — dozvoli pristup ili ukucaj šifru.', 'error');
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [resolve, say]);

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
            <div className="h-56 w-56 rounded-panel border-2 border-white/70" />
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
              resolve(manual);
              setManual('');
            }
          }}
        >
          <input
            className="flex-1 rounded-control border border-white/30 bg-white/10 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-white"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Ukucaj šifru sredstva → Enter"
            autoFocus
          />
          <button type="submit" className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white">
            Nađi
          </button>
        </form>
      </div>
    </div>
  );
}
