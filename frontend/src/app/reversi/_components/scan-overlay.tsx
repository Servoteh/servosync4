'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Flashlight, RefreshCw, Camera } from 'lucide-react';
import { lookupBarcode, type BarcodeKind, type BarcodeResult } from '@/api/reversi';
import { useEscapeLayer } from '@/components/ui-kit/escape-layer';
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
import { hardResetApp } from '@/lib/app-hard-reset';

/**
 * Formati ŽIVE kamere — **bez `qr_code`** (ISPRAVKA 02.08.2026, regresija na iPhone-u).
 *
 * Reversi nalepnice (ALAT-…, RZN-…, ZADU-M-…, ID kartica) su UVEK gust 1D Code128; u
 * 1.0 `codeType:'qr'` postoji samo za police u Lokacijama, a reversi ljuska bezuslovno
 * bira profil `item` (`plan-montaze/src/ui/reversi/scanOverlay.js:157`). Zatečeni
 * `qr_code` u ovoj listi je na iPhone-u skretao ceo dekoder na POGREŠAN put — jsQR
 * hibrid (`barcode-decoder.ts:431`): kadar se skraćuje na 1280 px, jsQR se vrti na
 * ~78 ms, a 1D ZXing pokušaj ide tek svakih ~400 ms. Bez QR-a isti kod ide na čist
 * ZXing `item` put (~28 ms po pokušaju) nad 2880×1620 kadrom — ~2,25× više piksela i
 * ~14× više pokušaja u sekundi. Uz to `buildVideoConstraints` dobija profil `'item'`
 * (a ne `'mixed'`), pa iOS uopšte i traži tu rezoluciju.
 */
const LIVE_FORMATS: DecodeFormat[] = ['code_128', 'code_39', 'ean_13'];

/**
 * „Slikaj barkod" (still-image) put sme da zadrži `qr_code`: tamo brzina nije kritična
 * (jedan prolaz kroz `decodeImageFile`, nema rAF petlje), a slika iz galerije/Viber-a
 * ume da bude QR sa nekog starijeg kartona.
 */
const IMAGE_FORMATS: DecodeFormat[] = [...LIVE_FORMATS, 'qr_code'];

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

// „Ažuriraj app" (RB-60) = `lib/app-hard-reset.ts` (zajednički sa lokacijskom ljuskom).
// Ovde je do 02.08.2026 stajala lokalna kopija koja je brisala SVE SW registracije i
// SVE keševe origin-a — a origin nosi i proksiranu 1.0 (v. JSDoc u tom modulu).

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
 * Dekoder ide ISTIM putem kao ostale tri ljuske: na Androidu ZXing (1.0 kanon), na
 * desktop Chromium-u nativni BarcodeDetector. Auto-zoom 2× i tap-fokus nepromenjeni.
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
  const rootRef = useRef<HTMLDivElement>(null);
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
  // (z-10, lebdi preko kadra) prekrije nišan na malom ekranu (v. `use-scan-panel-inset`).
  const [panelRef, panelInset] = useScanPanelInset<HTMLDivElement>();

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
    // Dekoder chunk (ZXing ~250KB) se vuče LAZY — zagrej ga paralelno sa kamerom
    // (Android od 1.0 kanona 3cffea5 ide na ZXing put, ne na BarcodeDetector).
    preloadVideoDecoder(LIVE_FORMATS);

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
      // Lampa se GASI zajedno sa track-om (torch je constraint na streamu), pa
      // `torchOn` mora da padne s njim: bez ovoga posle povratka iz pozadine UI
      // i dalje pokazuje upaljenu lampu nad ugašenim LED-om — korisnik onda tapne
      // dugme (koje šalje torch:false) i tek DRUGI tap upali svetlo.
      setTorchOn(false);
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
        // ZXing nema piksele za Code128. Profil je `'item'` (1.0 scanOverlay.js:157
        // bezuslovno `decodeProfile:'item'`) → na iPhone-u 2880×1620; do 02.08. je
        // ovde stajao `'mixed'` (1080p, QR+1D) pa je gust RNZ/ALAT- kod na iPhone-u
        // imao premalo piksela po crtici.
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
          formats: LIVE_FORMATS,
          onRaw: (raw) => void resolve(raw),
          isStopped: () => aborted(),
          // BEZ `preferNative` (02.08.2026): ovaj ekran je jedini tražio nativni
          // BarcodeDetector i na Androidu (i u APK WebView-u), izvan ZXing kanona koji
          // 1.0 koristi i koji je na terenu dokazan. Nepokriven režim je bio „detect()
          // uredno resolve-uje a VEČNO vraća prazan niz" (mrtav GmsCore barcode modul):
          // watchdog u engine-u broji GREŠKE, a prazan niz nije greška — nerazlučiv je
          // od praznog kadra, pa nema signala na koji bi se okačio. Simptom u pogonu:
          // „kamera radi, ne skenira", bez ijedne poruke. Debug prekidač
          // `ss3_scan_decode_mode='native'` i dalje forsira nativni put kad zatreba.
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

  // Esc zatvara SAMO skener. Skener se otvara POSLE roditeljskog dijaloga, pa je
  // na vrhu steka slojeva i Esc je njegov (v. `ui-kit/escape-layer.ts`).
  // Ranije je ovde stajao sopstveni capture-slušalac na `window`: `stopPropagation`
  // ne zaustavlja slušaoce na ISTOM čvoru, pa su se okidali i skener i dijalog i
  // ceo tok skeniranja se zatvarao.
  useEscapeLayer(true, () => cbRef.current.onClose());

  // HID/Bluetooth čitač dok je skener otvoren: polje ručnog unosa NIJE fokusirano na
  // telefonu (`autoFocus` je pod `pointer: fine` gardom), a globalni hvatač radnog
  // stola (`lib/reversi-global-scanner.ts`) namerno ćuti dok je otvoren `[aria-modal]`
  // sloj — a ovaj overlay je baš to. Bez lokalnog bafera sken pada u prazno.
  useHidScanBuffer(true, (code) => void resolve(code));

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

  /**
   * Tap-to-focus (S5, ISPRAVKA 02.08.2026 — prsten je LAGAO na iOS-u).
   *
   * WebKit ne izlaže ni `focusMode` ni `pointsOfInterest`, pa na iPhone-u nijedan
   * `applyConstraints` ne uradi ništa. Zatečeni kod je prsten crtao BEZUSLOVNO
   * („vizuelna potvrda tapa"), pa je radnik dobijao potvrdu da je izoštrio i čekao
   * fokus koji nikad ne dolazi. 1.0 to radi ispravno: `barcode.js:1231-1265` vraća
   * `false` kad uređaj ništa od toga ne podržava, a `scanModal.js:2669-2693` /
   * `scanOverlay.js:479-491` crtaju prsten SAMO na `true`.
   *
   * Uz to je ispravljen i sam constraint: bio je `focusMode:'manual'` (koji ni na
   * Androidu nije podržan), sada je 1.0 sekvenca `single-shot` + `pointsOfInterest`
   * uz povratak na `continuous`, i to samo kad ih uređaj zaista izlaže.
   *
   * DOPUNA (regresija na Androidu): „ne crtaj ništa" važi SAMO za iOS, gde tap-fokus
   * strukturno ne postoji pa bi prsten lagao. Na Androidu je to napravilo potpuno
   * mrtvo dugme — telefon bez `single-shot`/`pointsOfInterest` na tap ne uradi i ne
   * pokaže ništa, i radnik ne zna da li je promašio ili je aplikacija pukla. Zato
   * Android uvek dobija odziv: puna bela = fokus primenjen, isprekidana prigušena =
   * „tap primljen, ovaj telefon ne dozvoljava ručno izoštravanje".
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
    // Prsten je POTVRDA IZOŠTRAVANJA, ne potvrda tapa — na iOS-u se bez primenjenog
    // constraint-a ne crta ništa, pa radnik odmah zna da mora da menja rastojanje.
    if (!applied && !isAndroidWeb()) return;
    if (!applied && !noFocusSaidRef.current) {
      noFocusSaidRef.current = true;
      say('Ovaj telefon ne dozvoljava ručno izoštravanje — menjaj rastojanje (10-15 cm).');
    }
    const id = Date.now();
    setFocusRing({ ...at, id, ok: applied });
    window.setTimeout(() => setFocusRing((r) => (r?.id === id ? null : r)), 600);
  }

  async function onPickPhoto(file: File) {
    say('Dekodiram sliku…');
    try {
      // Brzi pokušaj nativnim detektorom (Chromium); iPhone/Firefox → ZXing pipeline.
      const Ctor = getDetectorCtor();
      if (Ctor) {
        try {
          const detector = detectorRef.current ?? new Ctor({ formats: IMAGE_FORMATS });
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
      const hit = await decodeImageFile(file, IMAGE_FORMATS);
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
    // FULL-BLEED KADAR (S3, 02.08.2026): do sada je ovo bio `flex flex-col` — topbar
    // i neprozirna donja traka su JELI visinu, pa je na iPhone 390×844 živa slika
    // padala na ~60-70% ekrana i barkod je izgledao manji nego u 1.0 (radnik onda
    // menja rastojanje umesto da skenira). 1.0 je full-bleed: `.loc-scan-video`
    // (legacy.css:4634) je `position:absolute; inset:0`, a topbar/hint/status/zoom
    // LEBDE preko kadra sa gradijentom (`.loc-scan-topbar`, legacy.css:4695).
    <div ref={rootRef} className="fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label={title}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        playsInline
        muted
        onPointerDown={(e) => void tapFocus(e)}
        className="absolute inset-0 h-full w-full object-cover"
      />
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

      {/* `pointer-events-none` na traci, `auto` na dugmadima: traka je providan
          gradijent preko kadra, pa tap kroz nju mora da stigne do `<video>` (fokus). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] text-white">
        <span className="text-md font-semibold">{title}</span>
        <div className="pointer-events-auto flex items-center gap-1">
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
            // Odjavljuje SAMO 3.0 SW/keševe — 1.0 (`/sw.js`, `/m/*`) se ne dira.
            onClick={() => void hardResetApp()}
            aria-label="Ažuriraj app"
            title="Ažuriraj app (odjavi 3.0 SW + obriši 3.0 keš)"
            className="rounded-full p-1.5 text-white hover:bg-white/10"
          >
            <RefreshCw className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Zatvori" className="rounded-full p-1.5 text-white hover:bg-white/10">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>

      {/* Sve kontrole LEBDE preko kadra (1.0 obrazac) — gradijent umesto neprozirne
          trake, pa se kamera vidi i ispod njih. `pointer-events-none` na omotaču +
          `auto` na svakoj kontroli: prazan prostor panela propušta tap na `<video>`
          (tap-to-focus), a izmerena visina panela drži nišan iznad njega. */}
      <div
        ref={panelRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 space-y-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom,0px))] text-white"
      >
        {continuous && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <span key={c.barcode} className="tnums rounded-full bg-white/15 px-2 py-0.5 text-2xs text-white">
                {c.barcode} · {c.label}
              </span>
            ))}
          </div>
        )}

        {zoom && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-control bg-black/55 px-2 py-1">
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

        {/* S4: instrukcija radniku (1.0 `.loc-scan-hint`) — 3.0 je do sada nije imao.
            Gasi se čim u kontinualnoj sesiji padne PRVI sken: radnik koji je već
            skenirao zna kako se drži telefon, a tri reda tada samo dižu panel. */}
        {cameraOn && !(continuous && chips.length > 0) && (
          <ScanHint extra={'Tap na kadar = fokus · „Slikaj barkod" kad ne ide iz ruke'} />
        )}

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
            // autoFocus SAMO na uređajima sa mišem/HID čitačem (kiosk PC) — isti
            // gard kao u lokacijskoj ljusci. Na telefonu bi programatski fokus
            // podigao soft tastaturu PREKO kadra pre svakog skena, a uz
            // `useVisualViewportFix` bi to i skupilo ceo overlay na vidljivi deo.
            autoFocus={
              typeof window === 'undefined' ||
              !window.matchMedia('(pointer: coarse)').matches
            }
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
