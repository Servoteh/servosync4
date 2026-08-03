'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useEscapeLayer } from '@/components/ui-kit/escape-layer';
import {
  applyAndroidPostStartTuning,
  attachVideoDecoder,
  buildVideoConstraints,
  cameraCooldownMs,
  isCameraDecodeSupported,
  isIOSWebKit,
  isSamsungInternetBrowser,
  preloadVideoDecoder,
  type DecodeFormat,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';
import { pickPreferredBackCamera, shouldRunCameraPicker } from '@/lib/camera-picker';
import { ScanReticle } from '@/components/ui-kit/scan-reticle';
import { ScanHint } from '@/components/ui-kit/scan-hint';
import { useVisualViewportFix } from '@/lib/use-visual-viewport-fix';
import { useScanPanelInset } from '@/lib/use-scan-panel-inset';
import { useHidScanBuffer } from '@/lib/use-hid-scan-buffer';

/**
 * Punoekranski QR/barkod skener sredstava za mobilno Održavanje (H21). Za razliku od
 * lokacije/reversi ScanOverlay-a (koji razrešavaju kroz svoj BE lookup), maint skener
 * VRAĆA sirov kod pozivaocu — uparivanje ide lokalno protiv GET /maintenance/assets
 * (asset_code, case-insensitive) kao u 1.0 myMaintenance.js:363-373.
 *
 * Dekodiranje kroz decode-engine (@/lib/barcode-decoder): BarcodeDetector (Chromium)
 * / ZXing / jsQR hibrid — radi i na iPhone/Firefox/Safari. HID/ručni unos ostaje.
 * Odštampane QR nalepnice enkodiraju URL karton-rute pa pozivalac vadi poslednji
 * segment putanje — sirov kod se svejedno predaje ovde.
 *
 * Android higijena kamere (31.07, isti paket kao glavna ljuska — 1.0 barcode.js):
 * cooldown pre getUserMedia, capability picker sočiva, retry na prolaznu grešku,
 * post-start tuning (anti-glare + AF) i release na pagehide/visibilitychange —
 * uz OBAVEZAN put nazad: povratak u prvi plan (visible/pageshow) ponovo pokreće
 * celu start-sekvencu, generacijski zaštićenu od preklapanja startova.
 */

/** QR nalepnice sredstava + 1D fallback (isti set za preload i za dekoder). */
const SCAN_FORMATS: DecodeFormat[] = ['qr_code', 'code_128', 'code_39', 'ean_13'];

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

  // Plutajući donji panel se MERI i predaje nišanu kao donji odmak — inače panel
  // (z-10, lebdi preko kadra) prekrije nišan na malom ekranu.
  const [panelRef, panelInset] = useScanPanelInset<HTMLDivElement>();

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
    // 1.0 lekcija: gejt je getUserMedia, NE BarcodeDetector (iPhone → ZXing/jsQR).
    if (!isCameraDecodeSupported()) {
      say('Kamera nije dostupna u ovom pregledaču (getUserMedia/HTTPS) — ukucaj šifru ili koristi HID čitač.', 'error');
      return;
    }
    // Dekoder chunk (ZXing ~250KB) se vuče LAZY — zagrej ga paralelno sa kamerom
    // (Android od 1.0 kanona 3cffea5 ide na ZXing put, ne na BarcodeDetector).
    preloadVideoDecoder(SCAN_FORMATS);

    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;
    let tuneTimer = 0;
    // Generacija starta kamere (isti obrazac kao `decoderSeq` u glavnoj ljusci):
    // `release()` je podiže, pa svaki start KOJI JE U LETU (cooldown, picker
    // probe, retry pauza, lazy ZXing chunk) sam odustane čim ga pretekne noviji
    // — uključujući i kameru puštenu zato što je stranica otišla u pozadinu.
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

    // iOS release higijena (1.0 releaseVideoStream): pause → stop → srcObject null
    // (NotReadableError guard). Koristi je i retry i cleanup i pagehide.
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

        // Rezolucija (1.0 lekcija): bez ideals-a iOS daje 640×480 — 1D ne dekodira.
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
        const v = videoRef.current;
        if (!v) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
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
        say('Usmeri kameru na QR nalepnicu sredstva');

        // Anti-glare ekspozicija + AF (samo Android) TEK kad se pipeline slegne —
        // constraint-i odmah po play() ume da budu tiho odbačeni (1.0 lekcija).
        const track = stream.getVideoTracks()[0];
        if (track) {
          tuneTimer = window.setTimeout(() => void applyAndroidPostStartTuning(track), 500);
        }

        const handle = await attachVideoDecoder({
          video: v,
          formats: SCAN_FORMATS,
          onRaw: (raw) => resolve(raw),
          isStopped: () => aborted(),
        });
        if (aborted()) handle.stop();
        else decoder = handle;
      } catch {
        if (aborted()) return; // tuđi start / zatvaranje — bez lažne greške
        say('Kamera nije dostupna — dozvoli pristup ili ukucaj šifru.', 'error');
      }
    };

    void startCamera();

    // Pozadina / zaključan ekran mora da PUSTI kameru — inače povratak u tab daje
    // zamrznut preview ili NotReadableError (isto kao glavna ljuska). POVRATAK je
    // zato obavezno morao da dobije i put NAZAD: bez ovoga je overlay posle svakog
    // odlaska u pozadinu ostajao trajno crn, bez ijednog dugmeta za restart.
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
    };
  }, [resolve, say]);

  // Skener je najgornji modalni sloj dok je otvoren — Esc zatvara NJEGA i ne
  // curi na sloj ispod. Sopstveni capture-slušalac na `window` je zatvarao oba,
  // jer `stopPropagation` ne zaustavlja slušaoce na istom čvoru
  // (v. `ui-kit/escape-layer.ts`).
  useEscapeLayer(true, () => cbRef.current.onClose());

  // HID/Bluetooth čitač dok je skener otvoren: polje ručnog unosa NIJE fokusirano na
  // telefonu (`autoFocus` je pod `pointer: fine` gardom), a globalni hvatač radnog
  // stola ćuti dok je otvoren `[aria-modal]` sloj — a ovaj overlay je baš to.
  useHidScanBuffer(true, (code) => resolve(code));

  return (
    // FULL-BLEED KADAR (S3, 02.08.2026) — v. `reversi/_components/scan-overlay.tsx`:
    // 1.0 drži kameru preko celog ekrana (`.loc-scan-video`, legacy.css:4634), a
    // kontrole lebde preko nje; `flex flex-col` sa neprozirnom donjom trakom je na
    // telefonu jeo trećinu kadra.
    <div ref={rootRef} className="fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label={title}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      {/* QR karton sredstva → kvadratni nišan; laser je 1D pomagalo, pa je ovde ugašen. */}
      {cameraOn && <ScanReticle variant="qr" laser={false} bottomInset={panelInset} />}

      {/* `pointer-events-none` na traci, `auto` na dugmetu: traka je providan gradijent
          preko kadra, pa tap kroz nju mora da stigne do `<video>`. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] text-white">
        <span className="text-md font-semibold">{title}</span>
        <button type="button" onClick={onClose} aria-label="Zatvori" className="pointer-events-auto rounded-full p-1 hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* `pointer-events-none` na omotaču + `auto` na kontrolama (prazan prostor panela
          propušta tap na kadar); izmerena visina drži nišan iznad panela. */}
      <div
        ref={panelRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 space-y-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom,0px))] text-white"
      >
        {/* S4: instrukcija radniku (1.0 `.loc-scan-hint`) — 3.0 je do sada nije imao. */}
        {cameraOn && <ScanHint extra="QR karton drži ceo u prozoru nišana" />}
        {status && (
          <p className={statusKind === 'error' ? 'text-sm text-status-danger' : 'text-sm text-white/80'} aria-live="polite">
            {status}
          </p>
        )}
        <form
          className="pointer-events-auto flex gap-2"
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
            // autoFocus samo uz miš/HID čitač — na telefonu bi soft tastatura
            // pokrila kadar pre skena (isti gard kao u lokacijskoj ljusci).
            autoFocus={
              typeof window === 'undefined' ||
              !window.matchMedia('(pointer: coarse)').matches
            }
          />
          <button type="submit" className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-white">
            Nađi
          </button>
        </form>
      </div>
    </div>
  );
}
