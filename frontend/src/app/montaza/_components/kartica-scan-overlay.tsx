'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';
import {
  applyAndroidPostStartTuning,
  attachVideoDecoder,
  buildVideoConstraints,
  cameraCooldownMs,
  decodeImageFile,
  isAndroidWeb,
  isCameraDecodeSupported,
  isIOSWebKit,
  isSamsungInternetBrowser,
  preloadVideoDecoder,
  safeApplyFlatCompat,
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
 * Punoekranski skener KARTICE KOJA PRATI DEO do montaže (zahtev 034/26).
 *
 * Kartica nosi isti Code128 koji pogon štampa na nalepnici (`RNZ:0:{ident}:0:0`), pa je
 * ovo 1D skener; profil rezolucije je `'item'` (na iPhone-u 2880×1620 — gust Code128 ne
 * dekodira na 1080p). Dekodiranje ide isključivo kroz decode-engine
 * `@/lib/barcode-decoder` (BarcodeDetector / ZXing / jsQR po platformi); gejt je
 * `getUserMedia`, NIKAD BarcodeDetector — inače iPhone lažno javlja „nema kamere".
 *
 * Razlika u odnosu na maint/lokacije overlay: `onCode` je ASINHRON i sme da baci. Dok
 * traje razrešavanje na backendu skener ostaje otvoren; na grešku (nepoznat ident,
 * pogrešan barkod) prikazuje poruku i pušta novi pokušaj — montažer ne mora da ponovo
 * otvara kameru. Zatvara se tek kad lookup uspe.
 *
 * Android higijena kamere (04.08.2026, nastavak 034/26 — Zoran: „neće da izoštri; kad
 * uspe, izađe greška"): ISTI paket kao lokacije/reversi/maint ljuske iz 14e042b7 —
 * cooldown pre getUserMedia, capability picker sočiva (`@/lib/camera-picker` — na
 * Samsung A-seriji `facingMode` ume da vrati macro objektiv fiksnog fokusa ~3 cm),
 * retry na prolaznu grešku, post-start tuning (anti-glare + continuous AF, samo
 * Android) i release na pagehide/visibilitychange sa obaveznim povratkom
 * (visible/pageshow → nova start-sekvenca), generacijski zaštićeno od preklapanja
 * startova. Uz to tap-to-focus (obrazac reversi ljuske): na iOS-u, gde ručni fokus
 * strukturno ne postoji, ne crta se ništa — iPhone tok je netaknut.
 *
 * Fallback-ovi su namerni: ručni unos (HID čitač / kucanje) i „Slikaj barkod" (loše
 * svetlo na terenu, `decodeImageFile` — 11 pokušaja sa pojačanjem kontrasta).
 */

/**
 * SAMO `code_128` (ISPRAVKA 04.08.2026 — Zoranova prijava „kad uspe, izađe greška").
 *
 * Kartica dela postoji isključivo kao Code128: kratka termalna nalepnica
 * `RNZ:0:{ident}:0:0` (`formatLabelBarcode`) i pun A4 oblik
 * `RNZ:{projectId}:{ident}:{variant}:{revision}` (`formatOrderBarcode` →
 * `BarcodeService.code128Svg`); i legacy 1.0 nalepnica je isti Code128 kratki oblik
 * (backend `tech-processes/barcode.ts`). Backend lookup
 * (`montaza-nm-kartica.service.ts` → `parseBarcode`) traži marker `RNZ` + tačno 4
 * separatora `:` — a azbuke Code39/ITF/EAN-13 znak `:` NEMAJU (Code39: A–Z, cifre,
 * `-.$/+%`; ITF/EAN: samo cifre), pa sken tih simbologija NIKAD ne može da prođe
 * lookup. Zatečeni `code_39` (simbologija bez checksum-a) je uz to iz delimičnog
 * kadra dekodovao smeće tipa „RNSREV+/~" → svaki takav „uspešan" sken = poruka o
 * grešci preko skenera. `itf`/`ean_13` su uklonjeni istim dokazom — „starije
 * nalepnice" u tim simbologijama ne postoje. Važi i za „Slikaj barkod" put.
 */
const FORMATS: DecodeFormat[] = ['code_128'];

// focusMode/pointsOfInterest nisu u standardnom TS lib.dom — proširujemo lokalno.
interface CamCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
}

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
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const [status, setStatus] = useState('Tražim kameru…');
  const [statusKind, setStatusKind] = useState<'info' | 'error'>('info');
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  // `ok:false` = tap primljen, ali uređaj ne podržava ručno izoštravanje (v. `tapFocus`).
  const [focusRing, setFocusRing] = useState<{
    x: number;
    y: number;
    id: number;
    ok: boolean;
  } | null>(null);
  const noFocusSaidRef = useRef(false);

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
    // Dekoder chunk (ZXing ~250KB) se vuče LAZY — zagrej ga paralelno sa kamerom
    // (Android od 1.0 kanona 3cffea5 ide na ZXing put, ne na BarcodeDetector).
    preloadVideoDecoder(FORMATS);

    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;
    let tuneTimer = 0;
    // Generacija starta kamere (isti obrazac kao maint/reversi ljuska): `release()`
    // je podiže, pa svaki start KOJI JE U LETU (cooldown, picker probe, retry pauza,
    // lazy ZXing chunk) sam odustane čim ga pretekne noviji — uključujući i kameru
    // puštenu zato što je stranica otišla u pozadinu.
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
        // ne dekodira („neće da izoštri"). Pad pickera = stari (facingMode) put.
        // `shouldRunCameraPicker` je false na iOS-u i desktop-u — iPhone netaknut.
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
        const base = buildVideoConstraints('item');
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
        trackRef.current = stream.getVideoTracks()[0] ?? null;
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
        say('Usmeri kameru na barkod sa kartice dela');

        // Anti-glare ekspozicija + AF (SAMO Android — helper sam gejtuje na
        // `isAndroidWeb`, iOS ostaje netaknut) TEK kad se pipeline slegne —
        // constraint-i odmah po play() umeju da budu tiho odbačeni (1.0 lekcija).
        const track = trackRef.current;
        if (track) {
          tuneTimer = window.setTimeout(() => void applyAndroidPostStartTuning(track), 500);
        }

        const handle = await attachVideoDecoder({
          video: v,
          formats: FORMATS,
          onRaw: (raw) => resolve(raw),
          isStopped: () => aborted(),
        });
        if (aborted()) handle.stop();
        else decoder = handle;
      } catch {
        if (aborted()) return; // tuđi start / zatvaranje — bez lažne greške
        say('Kamera nije dostupna — dozvoli pristup ili ukucaj RN ručno.', 'error');
      }
    };

    void startCamera();

    // Pozadina / zaključan ekran mora da PUSTI kameru — inače povratak u tab daje
    // zamrznut preview ili NotReadableError (paritet maint/reversi ljuske). POVRATAK
    // je obavezan: `hidden` ovde okida i „Slikaj barkod" (file picker!), pa bi bez
    // resume-a jedan tap na fallback trajno ugasio živi skener.
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

  // HID/Bluetooth čitač dok je skener otvoren: polje ručnog unosa NIJE fokusirano na
  // telefonu (`autoFocus` je pod `pointer: fine` gardom), a globalni hvatač radnog
  // stola ćuti dok je otvoren `[aria-modal]` sloj — a ovaj overlay je baš to.
  useHidScanBuffer(true, (code) => resolve(code));

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

  /**
   * Tap-to-focus — isti obrazac kao reversi ljuska (S5 ispravka 02.08.2026):
   * prsten je POTVRDA IZOŠTRAVANJA, ne potvrda tapa. Na iOS-u WebKit ne izlaže ni
   * `focusMode` ni `pointsOfInterest`, pa se bez primenjenog constraint-a ne crta
   * ništa (iPhone tok netaknut); na Androidu tap uvek dobija odziv: puna bela =
   * fokus primenjen, isprekidana prigušena = „tap primljen, telefon ne dozvoljava
   * ručno izoštravanje" (uz jednu poruku po sesiji).
   */
  async function tapFocus(e: React.PointerEvent<HTMLVideoElement>) {
    const track = trackRef.current;
    const v = videoRef.current;
    if (!track || !v) return;
    const rect = v.getBoundingClientRect();
    const caps = (track.getCapabilities?.() ?? {}) as CamCapabilities;
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode.map(String) : [];
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    let applied = false;
    if (modes.includes('single-shot') && 'pointsOfInterest' in caps) {
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      applied = await safeApplyFlatCompat(track, {
        focusMode: 'single-shot',
        pointsOfInterest: [{ x, y }],
      });
      if (applied && modes.includes('continuous')) {
        await new Promise((r) => setTimeout(r, 320));
        await safeApplyFlatCompat(track, { focusMode: 'continuous' });
      }
    } else if (modes.includes('continuous')) {
      applied = await safeApplyFlatCompat(track, { focusMode: 'continuous' });
    }
    if (!applied && !isAndroidWeb()) return;
    if (!applied && !noFocusSaidRef.current) {
      noFocusSaidRef.current = true;
      say('Ovaj telefon ne dozvoljava ručno izoštravanje — menjaj rastojanje (10-15 cm).');
    }
    const id = Date.now();
    setFocusRing({ ...at, id, ok: applied });
    window.setTimeout(() => setFocusRing((r) => (r?.id === id ? null : r)), 600);
  }

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
        onPointerDown={(e) => void tapFocus(e)}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Barkod RN kartice je 1D → široki nišan sa laserom (isto kao lokacije/reversi). */}
      {cameraOn && <ScanReticle variant="barcode" bottomInset={panelInset} />}
      {focusRing && (
        <div
          // Isprekidan i prigušen prsten = tap primljen, ali uređaj ne podržava ručno
          // izoštravanje (samo Android — v. `tapFocus`).
          className={`pointer-events-none absolute z-10 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
            focusRing.ok ? 'border-white/90' : 'border-dashed border-white/40'
          }`}
          style={{ left: focusRing.x, top: focusRing.y }}
          aria-hidden
        />
      )}

      {/* `pointer-events-none` na traci, `auto` na dugmetu: traka je providan gradijent
          preko kadra, pa tap kroz nju mora da stigne do `<video>` (tap-to-focus). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] text-white">
        <span className="text-md font-semibold">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zatvori"
          className="pointer-events-auto rounded-full p-1 hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* `pointer-events-none` na omotaču + `auto` na svakoj kontroli (prazan prostor
          panela propušta tap na kadar); izmerena visina drži nišan iznad panela. */}
      <div
        ref={panelRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 space-y-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom,0px))] text-white"
      >
        {/* S4: instrukcija radniku (1.0 `.loc-scan-hint`) — 3.0 je do sada nije imao. */}
        {cameraOn && <ScanHint extra={'Tap na kadar = fokus · „Slikaj barkod" kad ne ide iz ruke'} />}
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

        <label className="pointer-events-auto flex cursor-pointer items-center justify-center gap-2 rounded-control border border-white/30 px-3 py-2 text-sm text-white/90 hover:bg-white/10">
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
