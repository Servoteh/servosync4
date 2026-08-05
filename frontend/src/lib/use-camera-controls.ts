'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AF_KICK_INTERVAL_MS,
  applyTorch,
  applyZoom,
  buildScanDiag,
  mapPointerToVideoNormalized,
  primeDeviceModelHint,
  readTorchSupport,
  readZoomCapability,
  refocusAfterZoom,
  shouldAutoZoomOnStart,
  shouldPeriodicAfKick,
  tapFocusAt,
  type ScanDiag,
  type ZoomCap,
} from './camera-controls';
import { isAndroidWeb } from './barcode-decoder';

/**
 * React omotač oko `lib/camera-controls` — zoom klizač, torch dugme, tap-fokus i
 * dijagnostika, jednom napisani za sve skener-ljuske.
 *
 * ZAŠTO HOOK, A NE KOPIJA PO LJUSCI: 3.0 je zoom/torch/AF imao prekopiran u
 * lokacije i reversi ljusku, a montaža i mob-održavanje su ostale bez njega —
 * i te dve su drift-ovale i u tap-fokusu (v. `mapPointerToVideoNormalized`).
 * Pouka „jedan izvor" iz registra numeracije RN-ova: deljena logika u kopijama
 * se popravi na jednom mestu, ostale tiho zaostanu.
 *
 * Ljuska zove `attach(track)` kad kamera krene i `detach()` na gašenju.
 */

export type { ScanDiag };

export interface FocusRing {
  x: number;
  y: number;
  id: number;
  ok: boolean;
}

/**
 * Odmak od `play()` do čitanja capability-ja i primene zoom-a. 1.0 koristi 800 ms
 * (`setTimeout(() => setupZoomUI(), 800)` — lokacije `scanModal.js:949`, reversi
 * `scanOverlay.js:435`); 3.0 je imao 500 ms, što je na sporim ROM-ovima znalo da
 * uhvati još prazne `getCapabilities()`.
 */
export const CAPS_READY_MS = 800;
/** Drugi pokušaj ako su capabilities i na 800 ms još prazne. */
export const CAPS_RETRY_MS = 1200;

export function useCameraControls(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Poruka radniku kad telefon ne dozvoljava ručno izoštravanje (jednom po sesiji). */
  onNoFocus?: (msg: string) => void;
}) {
  const { videoRef, onNoFocus } = opts;
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const zoomTimerRef = useRef(0);
  const afTimerRef = useRef(0);
  const noFocusSaidRef = useRef(false);
  const onNoFocusRef = useRef(onNoFocus);
  useEffect(() => {
    onNoFocusRef.current = onNoFocus;
  });

  const [zoom, setZoomCap] = useState<ZoomCap | null>(null);
  const [zoomValue, setZoomValue] = useState(1);
  // Ogledala state-a za čitanje iz callback-ova (−/+ dugmad, debounce) bez
  // ponovnog vezivanja handler-a i bez bočnih efekata u state updater-ima.
  const zoomCapRef = useRef<ZoomCap | null>(null);
  const zoomValueRef = useRef(1);
  zoomCapRef.current = zoom;
  zoomValueRef.current = zoomValue;
  const [torchSupported, setTorchSupported] = useState(false);
  const torchSupportedRef = useRef(false);
  torchSupportedRef.current = torchSupported;
  const [torchOn, setTorchOn] = useState(false);
  // Generacija `attach`-a — obara zakasneli retry kad je kamera u međuvremenu
  // puštena (pozadina, promena objektiva, zatvaranje skenera).
  const genRef = useRef(0);
  // Šta je u ovoj generaciji već odrađeno — čuva retry od dvostruke primene.
  const zoomDoneRef = useRef(false);
  const kickDoneRef = useRef(false);
  const [focusRing, setFocusRing] = useState<FocusRing | null>(null);
  const [diag, setDiag] = useState<ScanDiag>({
    model: '?',
    lens: '—',
    af: '—',
    zoom: '—',
    roi: false,
    roiPending: null,
  });

  // Model se razrešava ASINHRONO (UA-CH) — grej ga čim se hook montira, da bude
  // spreman pre nego što kamera krene i pre `attach`-a dekodera.
  useEffect(() => {
    primeDeviceModelHint();
  }, []);

  const lensPickedRef = useRef(false);
  // STVARNO stanje nišan-gejta u ovoj sesiji — dolazi sa `VideoDecoderHandle`
  // (`roiGateActive`), a NE iz `shouldLimitScanToReticle()` uživo: prekidač u
  // panelu menja sessionStorage odmah, dok dekoder svoju odluku drži do sledećeg
  // otvaranja skenera. Bez ovoga red laže baš o onome što se meri.
  const roiActiveRef = useRef(false);
  const refreshDiag = useCallback((zoomValue?: number) => {
    setDiag(
      buildScanDiag(trackRef.current, {
        lensPicked: lensPickedRef.current,
        roiGate: roiActiveRef.current,
        zoomValue,
      }),
    );
  }, []);

  /** Ljuska ovo zove sa `handle.roiGateActive` čim dekoder krene. */
  const reportRoiGate = useCallback(
    (active: boolean) => {
      roiActiveRef.current = active;
      refreshDiag();
    },
    [refreshDiag],
  );

  const stopAfKick = useCallback(() => {
    if (afTimerRef.current) {
      clearInterval(afTimerRef.current);
      afTimerRef.current = 0;
    }
  }, []);

  /**
   * Jedna evaluacija profila uređaja: klizač + torch + auto-zoom + periodični AF.
   * Zove je i prvi prolaz i retry — zato je IDEMPOTENTNA po generaciji
   * (`zoomDoneRef` / `kickDoneRef`), pa retry dopuni samo ono što prvi put nije
   * moglo da se pročita, a ništa se ne primenjuje dvaput.
   *
   * Vraća zoom koji treba prikazati u dijagnostici (ili `undefined`).
   */
  const evaluateProfile = useCallback(
    async (track: MediaStreamTrack, myGen: number): Promise<number | undefined> => {
      let zoomNow: number | undefined;

      if (!torchSupportedRef.current) setTorchSupported(readTorchSupport(track));

      const cap = readZoomCapability(track);
      if (cap && !zoomDoneRef.current) {
        zoomDoneRef.current = true;
        setZoomCap(cap);
        zoomNow = cap.current;
        // KLJUČNO za tvrdo pravilo „uređaji koji rade se ne diraju": klizač kreće
        // od ZATEČENE vrednosti uređaja i ništa se ne primenjuje dok radnik ne
        // pomeri klizač. Auto-zoom je izuzetak samo za profil koji danas ne radi.
        if (shouldAutoZoomOnStart(track)) {
          const auto = Math.min(cap.max, Math.max(cap.min, 2));
          zoomNow = auto;
          setZoomValue(auto);
          const ok = await applyZoom(track, auto);
          // 1.0 `runRefocusAfterZoom`: zoom na Android Chrome-u razbija AF.
          if (ok) await refocusAfterZoom(track);
        } else {
          setZoomValue(cap.current);
        }
      }

      // `applyZoom`/`refocusAfterZoom` su async — ako je `detach` u međuvremenu
      // odradio, generacija se ne poklapa i interval se NE sme postaviti, inače
      // bi kucao nad puštenom kamerom do kraja sesije.
      if (genRef.current !== myGen) {
        stopAfKick();
        return zoomNow;
      }
      if (!kickDoneRef.current && shouldPeriodicAfKick(track)) {
        kickDoneRef.current = true;
        stopAfKick();
        afTimerRef.current = window.setInterval(() => {
          const t = trackRef.current;
          if (!t || t.readyState !== 'live') return;
          void tapFocusAt(t, 0.5, 0.5);
        }, AF_KICK_INTERVAL_MS);
      }
      return zoomNow;
    },
    [stopAfKick],
  );

  /**
   * Ljuska ovo zove kad je stream živ. **Mora se zvati POSLE
   * `applyAndroidPostStartTuning` (uz `await`), ne paralelno**: `applyConstraints`
   * ZAMENJUJE skup ograničenja, pa bi tuning (ekspozicija + AF) i auto-zoom u
   * trci gazili jedan drugog — i to baš na AF-slepim uređajima koje pokušavamo
   * da popravimo.
   *
   * `generation` obara zakasneli retry kad je kamera u međuvremenu puštena.
   */
  const attach = useCallback(
    async (track: MediaStreamTrack | null, info?: { lensPicked?: boolean }) => {
      trackRef.current = track;
      lensPickedRef.current = Boolean(info?.lensPicked);
      noFocusSaidRef.current = false;
      const myGen = ++genRef.current;
      setTorchOn(false);
      if (!track) {
        setZoomCap(null);
        setTorchSupported(false);
        refreshDiag();
        return;
      }
      zoomDoneRef.current = false;
      kickDoneRef.current = false;

      const zoomNow = await evaluateProfile(track, myGen);
      refreshDiag(zoomNow);

      // RETRY kad capabilities kasne: na Androidu `getCapabilities()` ume da
      // vrati prazan objekat dok se pipeline ne slegne. Retry ponavlja PUNU
      // evaluaciju profila (klizač + auto-zoom + AF kick), ne samo klizač —
      // inače bi na A16 čije caps kasne (tačno ciljni uređaj) radnik dobio
      // klizač na 1× i NIKAD auto-2× ni periodično izoštravanje.
      if (!zoomDoneRef.current || !kickDoneRef.current) {
        window.setTimeout(() => {
          const t = trackRef.current;
          if (!t || genRef.current !== myGen || t.readyState !== 'live') return;
          void (async () => {
            const late = await evaluateProfile(t, myGen);
            if (genRef.current === myGen) refreshDiag(late);
          })();
        }, CAPS_RETRY_MS);
      }
    },
    [refreshDiag, evaluateProfile],
  );

  const detach = useCallback(() => {
    genRef.current++; // obara `attach` koji je u letu i zakasneli caps-retry
    stopAfKick();
    if (zoomTimerRef.current) {
      clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = 0;
    }
    trackRef.current = null;
  }, [stopAfKick]);

  useEffect(() => detach, [detach]);

  /** Klizač: UI odmah, hardver debounce-ovano na 220 ms (1.0 `setZoom`). */
  const changeZoom = useCallback((value: number) => {
    setZoomValue(value);
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(async () => {
      zoomTimerRef.current = 0;
      const track = trackRef.current;
      if (!track) return;
      const ok = await applyZoom(track, value);
      if (ok) await refocusAfterZoom(track);
      refreshDiag(value);
    }, 220);
  }, [refreshDiag]);

  /**
   * −/+ dugmad. Trenutni opseg i vrednost se čitaju iz REF-a, ne iz state
   * updater-a: pozivanje `changeZoom` unutar `setState(fn)` je bočni efekat u
   * čistoj funkciji — React ga u StrictMode-u pozove dvaput, pa bi jedan klik
   * dvaput pomerio zoom.
   */
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const cap = zoomCapRef.current;
      if (!cap) return;
      const step = cap.step || 0.1;
      const next = Math.min(cap.max, Math.max(cap.min, zoomValueRef.current + dir * step));
      changeZoom(next);
    },
    [changeZoom],
  );

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    const ok = await applyTorch(track, next);
    if (ok) setTorchOn(next);
  }, [torchOn]);

  /**
   * Tap-to-focus na `<video>`. Prsten je POTVRDA IZOŠTRAVANJA, ne potvrda tapa:
   * na iOS-u WebKit ne izlaže `focusMode`/`pointsOfInterest` pa se ne crta ništa
   * (iPhone tok netaknut), a na Androidu tap uvek dobija odziv.
   */
  const onVideoPointerDown = useCallback(
    async (e: { clientX: number; clientY: number }) => {
      const track = trackRef.current;
      const v = videoRef.current;
      if (!track || !v) return;
      const rect = v.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const m = mapPointerToVideoNormalized(v, e.clientX, e.clientY);
      const applied = m ? await tapFocusAt(track, m.x, m.y) : false;
      if (!applied && !isAndroidWeb()) return; // iOS: ćuti (prsten bi lagao)
      if (!applied && !noFocusSaidRef.current) {
        noFocusSaidRef.current = true;
        onNoFocusRef.current?.(
          'Ovaj telefon ne dozvoljava ručno izoštravanje — menjaj rastojanje (10-15 cm).',
        );
      }
      const id = Date.now();
      setFocusRing({ ...at, id, ok: applied });
      window.setTimeout(() => setFocusRing((r) => (r?.id === id ? null : r)), 600);
      refreshDiag();
    },
    [videoRef, refreshDiag],
  );

  return {
    zoom,
    zoomValue,
    changeZoom,
    stepZoom,
    torchSupported,
    torchOn,
    toggleTorch,
    focusRing,
    onVideoPointerDown,
    diag,
    reportRoiGate,
    attach,
    detach,
  };
}
