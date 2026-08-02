'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import {
  attachVideoDecoder,
  buildVideoConstraints,
  decodeImageFile,
  isCameraDecodeSupported,
  isIOSWebKit,
  type DecodeFormat,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';
import { ScanReticle } from '@/components/ui-kit/scan-reticle';
import { ScanHint } from '@/components/ui-kit/scan-hint';
import { useVisualViewportFix } from '@/lib/use-visual-viewport-fix';

/**
 * Punoekranski skener KARTICE KOJA PRATI DEO do montaže (zahtev 034/26).
 *
 * Kartica nosi isti Code128 koji pogon štampa na nalepnici (`RNZ:0:{ident}:0:0`), pa je
 * ovo 1D skener: format-lista je bez QR-a, a profil rezolucije `'item'` (na iPhone-u
 * 2880×1620 — gust Code128 ne dekodira na 1080p). Dekodiranje ide isključivo kroz
 * decode-engine `@/lib/barcode-decoder` (BarcodeDetector / ZXing / jsQR po platformi);
 * gejt je `getUserMedia`, NIKAD BarcodeDetector — inače iPhone lažno javlja „nema kamere".
 *
 * Razlika u odnosu na maint/lokacije overlay: `onCode` je ASINHRON i sme da baci. Dok
 * traje razrešavanje na backendu skener ostaje otvoren; na grešku (nepoznat ident,
 * pogrešan barkod) prikazuje poruku i pušta novi pokušaj — montažer ne mora da ponovo
 * otvara kameru. Zatvara se tek kad lookup uspe.
 *
 * Fallback-ovi su namerni: ručni unos (HID čitač / kucanje) i „Slikaj barkod" (loše
 * svetlo na terenu, `decodeImageFile` — 11 pokušaja sa pojačanjem kontrasta).
 */

/** Kartica je 1D (Code128). ITF/EAN su tu za slučaj starijih nalepnica. */
const FORMATS: DecodeFormat[] = ['code_128', 'code_39', 'itf', 'ean_13'];

function normalize(raw: string): string {
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) t = t.slice(1, -1);
  const zw = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
  return [...t].filter((ch) => !zw.has(ch.codePointAt(0)!)).join('').trim();
}

export function KarticaScanOverlay({
  title = '📷 Skeniraj karticu dela',
  onCode,
  onClose,
}: {
  title?: string;
  /** Razrešavanje skeniranog koda. Baci grešku → skener ostaje otvoren sa porukom. */
  onCode: (code: string) => Promise<void>;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<'info' | 'error'>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);

  // Safari URL traka guta gornji deo kadra (1.0 lekcija) — do 02.08. je ovo imala
  // samo lokacijska ljuska; sada je zajednički hook (v. `use-visual-viewport-fix`).
  useVisualViewportFix(rootRef);

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

  const resolve = useCallback(
    (raw: string) => {
      const code = normalize(raw);
      if (!code || busyRef.current) return;
      const now = Date.now();
      // Isti kod u roku od 1,5s = isti sken (rAF petlja okine više puta).
      if (code === lastRef.current.code && now - lastRef.current.at < 1500) return;
      lastRef.current = { code, at: now };
      busyRef.current = true;
      navigator.vibrate?.(80);
      say('Tražim podatke o delu…');
      void (async () => {
        try {
          await cbRef.current.onCode(code);
          cbRef.current.onClose();
        } catch (e) {
          // Ostajemo otvoreni: montažer usmeri kameru na drugi barkod ili ukuca ručno.
          say(e instanceof Error ? e.message : 'Kartica nije prepoznata.', 'error');
          lastRef.current = { code: '', at: 0 }; // dozvoli ponovni sken istog koda
          busyRef.current = false;
        }
      })();
    },
    [say],
  );

  useEffect(() => {
    // 1.0 lekcija: gejt je getUserMedia, NE BarcodeDetector (iPhone → ZXing).
    if (!isCameraDecodeSupported()) {
      say(
        'Kamera nije dostupna u ovom pregledaču (getUserMedia/HTTPS) — ukucaj RN ručno ili koristi HID čitač.',
        'error',
      );
      return;
    }
    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;

    (async () => {
      try {
        // Rezolucija (1.0 lekcija): bez ideals-a iOS daje 640×480 — 1D ne dekodira.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...buildVideoConstraints('item'), facingMode: 'environment' },
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
        say('Usmeri kameru na barkod sa kartice dela');
        const handle = await attachVideoDecoder({
          video: v,
          formats: FORMATS,
          onRaw: (raw) => resolve(raw),
          isStopped: () => stopped,
        });
        if (stopped) handle.stop();
        else decoder = handle;
      } catch {
        say('Kamera nije dostupna — dozvoli pristup ili ukucaj RN ručno.', 'error');
      }
    })();

    return () => {
      stopped = true;
      try {
        decoder?.stop();
      } catch {
        /* ignore */
      }
      // iOS release higijena (1.0): pause → stop → srcObject null (NotReadableError guard).
      if (isIOSWebKit()) {
        try {
          videoRef.current?.pause();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.load();
        }
      } catch {
        /* ignore */
      }
    };
  }, [resolve, say]);

  // Escape u CAPTURE fazi + stopPropagation: zatvara skener, a NE roditeljski Dialog.
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

  /** Fallback za loše svetlo: fotografija barkoda → ZXing sa pojačanjem kontrasta. */
  async function onPickPhoto(file: File | undefined) {
    if (!file) return;
    say('Čitam barkod sa slike…');
    try {
      const raw = await decodeImageFile(file, FORMATS);
      if (!raw) {
        say('Sa slike nije pročitan barkod — probaj bliže ili ukucaj RN ručno.', 'error');
        return;
      }
      resolve(raw);
    } catch {
      say('Sa slike nije pročitan barkod — probaj ponovo.', 'error');
    }
  }

  return (
    // FULL-BLEED KADAR (S3, 02.08.2026) — v. `reversi/_components/scan-overlay.tsx`:
    // 1.0 drži kameru preko celog ekrana (`.loc-scan-video`, legacy.css:4634), a
    // kontrole lebde preko nje; `flex flex-col` sa neprozirnom donjom trakom je na
    // telefonu jeo trećinu kadra.
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Barkod RN kartice je 1D → široki nišan sa laserom (isto kao lokacije/reversi). */}
      {cameraOn && <ScanReticle variant="barcode" />}

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] text-white">
        <span className="text-md font-semibold">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zatvori"
          className="rounded-full p-1 hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 space-y-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom,0px))] text-white">
        {/* S4: instrukcija radniku (1.0 `.loc-scan-hint`) — 3.0 je do sada nije imao. */}
        {cameraOn && <ScanHint extra={'Ne ide iz ruke? Probaj „Slikaj barkod" ispod'} />}
        {status && (
          <p
            className={
              statusKind === 'error' ? 'text-sm text-status-danger' : 'text-sm text-white/80'
            }
            aria-live="polite"
          >
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
            placeholder="Ukucaj barkod (RNZ:…) → Enter"
            // autoFocus samo uz miš/HID čitač — na telefonu bi soft tastatura
            // pokrila kadar pre skena (isti gard kao u lokacijskoj ljusci).
            autoFocus={
              typeof window === 'undefined' ||
              !window.matchMedia('(pointer: coarse)').matches
            }
          />
          <button
            type="submit"
            className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Nađi
          </button>
        </form>

        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-white/30 px-3 py-2 text-sm text-white/90 hover:bg-white/10">
          <ImageIcon className="h-4 w-4" />
          Slikaj barkod (loše svetlo)
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              void onPickPhoto(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
