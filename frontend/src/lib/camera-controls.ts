/**
 * Zajedničke kontrole kamere za sve skener-ljuske (zoom, torch, autofokus).
 *
 * KOREN (Nenad, 05.08.2026, terenska proba): „na A16 nišan ne radi, na ostalim
 * Samsung A-serijama ne rade **zoom i autofocus**, na S26 skenira lepo — a
 * ranije u 1.0 smo imali i zoom i autofocus". Merenje 1.0
 * (`servoteh-plan-montaze@main`) je pokazalo da 1.0 zoom/torch/AF drži u
 * `src/services/barcode.js` (`buildController`) i da ga SVAKA ljuska poziva
 * (`setupZoomUI` u `lokacije/scanModal.js:1377` i `reversi/scanOverlay.js:311`).
 * U 3.0 je ta logika bila prekopirana SAMO u lokacije i reversi ljusku, dok su
 * montaža (`kartica-scan-overlay`) i mob-održavanje (`maint-scan-overlay`)
 * ostale BEZ zoom-a i torch-a (a održavanje i bez tap-fokusa) — otud prijava.
 *
 * Ovaj modul je JEDAN izvor te logike (pouka „RN brojevi = jedan izvor": kad se
 * deljena logika kopira, popravka se primeni na jednom mestu a ostala tiho
 * zaostanu). Postojeće lokacije/reversi ljuske se NAMERNO ne prepisuju — one
 * rade na terenu i tvrdo pravilo 04.08. je da se uređajima koji rade ponašanje
 * ne menja; ovde je ported IDENTIČNO ponašanje za ljuske koje ga nemaju.
 *
 * PARITET SA 1.0 (izmereno, ne pretpostavljeno):
 *  - torch: 1.0 `buildController.toggleTorch` ima `if (isAndroidWebPlatform())
 *    return false` → torch je na Androidu NAMERNO ugašen (nepouzdan na budget
 *    ROM-ovima), radi samo na iOS/desktop. Isto ovde.
 *  - zoom: 1.0 `getZoom`/`setZoom` imaju `if (isAndroidWebPlatform() &&
 *    !isAndroidChromeBrowser()) return null/false` → zoom radi na Android
 *    Chrome-u, iOS-u i desktopu; Samsung Internet / Firefox Android nemaju
 *    hardverski zoom. Isto ovde.
 *  - zoom se primenjuje DEBOUNCE-ovano na 220 ms (1.0 `setZoom`), a posle
 *    uspešne primene se na Android Chrome-u PONOVO okida AF — promena zoom-a
 *    tamo razbija fokus pa kadar ostane mutan (1.0 `runRefocusAfterZoom`).
 *  - AF: 1.0 NE forsira `continuous` kad je uređaj već na `auto`/`continuous`
 *    (Samsung smart AF; forsiranje je oborilo i S26 — 1.0 revert e126868).
 *  - 1.0 NEMA periodično re-okidanje AF-a; ovde postoji samo za „AF-slep"
 *    profil (v. `isAfBlindAndroid`) i uz kill-switch.
 */

import { isAndroidWeb, isIOSWebKit, safeApplyFlatCompat } from './barcode-decoder';
import { getDeviceModelHint, primeDeviceModelHint } from './device-model';

export { getDeviceModelHint, primeDeviceModelHint };

/** Kratka oznaka za dijagnostički red: model ili `UA-skriven`. */
export function deviceModelLabel(): string {
  const m = getDeviceModelHint();
  if (m) return m;
  if (typeof navigator === 'undefined') return '?';
  if (isIOSWebKit()) return 'iOS';
  return isAndroidWeb() ? 'Android(UA-skriven)' : 'desktop';
}

/** Samsung A16/A17 profil — potvrđeno problematični modeli (04.08./05.08.). */
export function matchesSamsungAProblemModel(): boolean {
  const hay = `${getDeviceModelHint()} ${
    typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  }`;
  return /\bSM-A1[67]\d/i.test(hay);
}

// ── Platforma (paritet 1.0 barcode.js:269-314) ──────────────────────────────

/** Android Chrome (ne Firefox/Samsung Internet/Edge) — jedini Android sa pouzdanim zoom-om. */
export function isAndroidChromeBrowser(): boolean {
  if (!isAndroidWeb()) return false;
  const u = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/Firefox|SamsungBrowser|EdgA/i.test(u)) return false;
  return /Chrome\//.test(u);
}

/** 1.0 `isAndroidWebCameraTorchZoomHidden` — Android web krije torch/zoom. */
export function isTorchZoomHiddenPlatform(): boolean {
  return isAndroidWeb();
}

// ── Capability čitanje ──────────────────────────────────────────────────────

interface CamCaps {
  zoom?: { min?: number; max?: number; step?: number };
  torch?: boolean;
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
  pointsOfInterest?: unknown;
}
interface CamSettings {
  zoom?: number;
  torch?: boolean;
  focusMode?: string;
}

function caps(track: MediaStreamTrack): CamCaps {
  try {
    return (track.getCapabilities?.() ?? {}) as CamCaps;
  } catch {
    return {};
  }
}
function settings(track: MediaStreamTrack): CamSettings {
  try {
    return (track.getSettings?.() ?? {}) as CamSettings;
  } catch {
    return {};
  }
}

export interface ZoomCap {
  min: number;
  max: number;
  step: number;
  /** Zatečena vrednost zoom-a NA UREĐAJU (ne postavljamo je mi). */
  current: number;
}

/**
 * Da li je zoom KLIZAČ sakriven odlukom platforme (1.0 paritet: Android bez
 * Chrome-a — Samsung Internet, Firefox — nema pouzdan hardverski zoom).
 * Hardver i dalje može da ima zoom; ovo je odluka o UI-ju, ne o sposobnosti.
 */
export function isZoomControlHiddenByPlatform(): boolean {
  return isTorchZoomHiddenPlatform() && !isAndroidChromeBrowser();
}

/**
 * Zoom opseg kakav UREĐAJ prijavljuje, BEZ platformskog gejta — samo za
 * dijagnostiku. Dijagnostika mora da govori istinu o hardveru; ako ovde
 * primenimo gejt klizača, red bi na Samsung Internetu pisao „zum: nema" iako
 * reversi ljuska tamo stvarno primeni 2× (i tako je i bilo pre ove ispravke).
 */
export function readZoomCapabilityRaw(track: MediaStreamTrack | null): ZoomCap | null {
  if (!track) return null;
  const z = caps(track).zoom;
  if (!z || typeof z !== 'object') return null;
  const min = Number(z.min ?? 1);
  const max = Number(z.max ?? 1);
  const step = Number(z.step ?? 0.1);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= min + 0.01) return null; // fiksni zoom → sakrij UI (1.0 setupZoomUI)
  const cur = Number(settings(track).zoom ?? min);
  return {
    min,
    max,
    step: Number.isFinite(step) && step > 0 ? step : 0.1,
    current: Number.isFinite(cur) ? Math.min(max, Math.max(min, cur)) : min,
  };
}

/**
 * Zoom opseg za KLIZAČ: hardver + platformski gejt. `current` je ZATEČENA
 * vrednost — pozivalac je koristi kao početnu poziciju klizača, čime se
 * uređajima koji rade ništa ne menja.
 */
export function readZoomCapability(track: MediaStreamTrack | null): ZoomCap | null {
  if (isZoomControlHiddenByPlatform()) return null;
  return readZoomCapabilityRaw(track);
}

/** Primeni zoom (bez debounce-a — debounce drži hook/pozivalac). */
export async function applyZoom(track: MediaStreamTrack | null, value: number): Promise<boolean> {
  if (!track || isZoomControlHiddenByPlatform()) return false;
  return safeApplyFlatCompat(track, { zoom: value });
}

/**
 * Da li uređaj ima torch. 1.0 ga na Androidu NAMERNO krije (`toggleTorch`
 * vraća `false` pre svake provere) — ostaje iOS/desktop.
 */
export function readTorchSupport(track: MediaStreamTrack | null): boolean {
  if (!track) return false;
  if (isTorchZoomHiddenPlatform()) return false;
  const c = caps(track);
  let supported: { torch?: boolean } = {};
  try {
    supported = (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}) as { torch?: boolean };
  } catch {
    supported = {};
  }
  return 'torch' in c || supported.torch === true;
}

export async function applyTorch(track: MediaStreamTrack | null, on: boolean): Promise<boolean> {
  if (!track || isTorchZoomHiddenPlatform()) return false;
  return safeApplyFlatCompat(track, { torch: on });
}

// ── Autofokus ───────────────────────────────────────────────────────────────

export function readFocusModes(track: MediaStreamTrack | null): string[] {
  if (!track) return [];
  const m = caps(track).focusMode;
  return Array.isArray(m) ? m.map(String) : [];
}

export function currentFocusMode(track: MediaStreamTrack | null): string {
  if (!track) return '';
  return String(settings(track).focusMode ?? '').toLowerCase();
}

/**
 * „AF-slep" Android: uređaj NE izlaže nijedan koristan automatski režim fokusa
 * (`continuous`/`auto`). To je izmereni profil budget Samsung A-serije iz 1.0
 * analize (`docs/SCAN_ANALIZA_A17_A26.md`, tabela capability-ja: „focusMode
 * array — ponekad ne izlaže / ne izlaže"), dok S-serija izlaže `continuous +
 * auto`. Gejt je po SPOSOBNOSTI, ne po imenu modela — otporan je na Chrome koji
 * krije model u UA.
 *
 * Posledica: S26 (izlaže auto/continuous) i iPhone (nije Android) su VAN profila
 * — na njima se ništa ne menja, što je tvrd uslov 04.08.
 *
 * 🔴 PRAZAN `focusMode` NIJE PRESUDA (ispravka posle review-a): `getCapabilities()`
 * na Androidu ume da vrati prazan objekat dok se pipeline ne slegne — ista stvar
 * zbog koje zoom/torch čitamo tek posle tuning-a. Kad bi „nema modova" značilo
 * „AF-slep", S26 i Honor bi u montaži/održavanju dobili auto 2× + `refocusAfterZoom`
 * (dakle AF lock na startu) samo zato što smo pitali prerano — pravo obaranje
 * uređaja koji rade. 1.0 na istom mestu radi SUPROTNO: kad `modes` nije izložen,
 * `ensureProperAFModeBestEffort` samo loguje i IZLAZI (barcode.js:593-598).
 * A16 se time ne gubi — pokriva ga `matchesSamsungAProblemModel()` grana
 * u `shouldAutoZoomOnStart`.
 */
export function isAfBlindAndroid(track: MediaStreamTrack | null): boolean {
  if (!track || !isAndroidWeb()) return false;
  const cur = currentFocusMode(track);
  if (cur === 'auto' || cur === 'continuous') return false;
  const modes = readFocusModes(track);
  if (!modes.length) return false; // caps nisu izložene → nema presude (1.0 paritet)
  return !modes.includes('continuous') && !modes.includes('auto');
}

/**
 * Klijentske koordinate → normalizovane [0,1] koordinate VIDEO kadra kod
 * `object-fit: cover` (kopija iz lokacijske ljuske, `scan-overlay.tsx:245`).
 *
 * Load-bearing: kadar je isečen, pa `(clientX - rect.left) / rect.width` NIJE
 * tačka u frejmu — na portretnom telefonu promašuje i po 30% širine. 1.0 zato
 * `tapFocus` provlači kroz `mapPointerToVideoNormalizedPlane`
 * (barcode.js:1236-1241); montaža i reversi ljuska su računale sirov odnos pa je
 * telefon izoštravao POGREŠNU tačku — jedan od korena prijave „autofocus ne radi".
 */
export function mapPointerToVideoNormalized(
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

/**
 * Tap-to-focus (1.0 `buildController.tapFocus`): `single-shot` + tačka interesa,
 * pa posle 320 ms povratak na `continuous` — ali NE na Android Chrome-u, gde
 * `continuous` posle `single-shot` „zaključa" mutan fokus za blisku nalepnicu
 * (1.0 barcode.js:548-552, 1256-1258).
 *
 * @param nx,ny normalizovane koordinate (0..1) u ravni video frejma
 * @returns da li je constraint stvarno primenjen (prsten = potvrda fokusa)
 */
export async function tapFocusAt(
  track: MediaStreamTrack | null,
  nx: number,
  ny: number,
): Promise<boolean> {
  if (!track) return false;
  const c = caps(track);
  const modes = readFocusModes(track);
  const x = Math.min(1, Math.max(0, nx));
  const y = Math.min(1, Math.max(0, ny));
  if (modes.includes('single-shot') && 'pointsOfInterest' in c) {
    const ok = await safeApplyFlatCompat(track, {
      focusMode: 'single-shot',
      pointsOfInterest: [{ x, y }],
    });
    if (!ok) return false;
    // 320 ms se čeka BEZUSLOVNO (1.0 barcode.js:1255): to je vreme da AF ciklus
    // odradi posao. Uslovljavanje te pauze `continuous` granom značilo bi da na
    // Android Chrome-u odmah javljamo „izoštreno" dok objektiv još putuje.
    await new Promise((r) => setTimeout(r, 320));
    if (modes.includes('continuous') && !isAndroidChromeBrowser()) {
      await safeApplyFlatCompat(track, { focusMode: 'continuous' });
    }
    return true;
  }
  if (modes.includes('continuous') && !isAndroidChromeBrowser()) {
    return safeApplyFlatCompat(track, { focusMode: 'continuous' });
  }
  return false;
}

/**
 * Ponovo nateraj fokus posle promene zoom-a — 1.0 `runRefocusAfterZoom`. Samo
 * Android Chrome: tamo promena zoom-a razbija AF pa kadar ostane mutan i dekoder
 * „gluv"; iOS/desktop sami prate zoom.
 */
export async function refocusAfterZoom(track: MediaStreamTrack | null): Promise<void> {
  if (!track || !isAndroidChromeBrowser()) return;
  await tapFocusAt(track, 0.5, 0.5);
}

// ── Terenski prekidači (sessionStorage, isti obrazac kao ss3_scan_decode_mode) ─

/** Prekidači koje teren pali/gasi iz dijagnostičkog panela (v. `ScanDiagLine`). */
export const SCAN_FLAGS = ['ss3_scan_roi_gate', 'ss3_scan_autozoom', 'ss3_scan_af_kick'] as const;
export type ScanFlag = (typeof SCAN_FLAGS)[number];
export type ScanFlagValue = 'on' | 'off' | null;

export function readScanFlag(key: ScanFlag | string): ScanFlagValue {
  try {
    const v = sessionStorage.getItem(key);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

/** `null` = vrati na automatiku (obriši ključ). */
export function writeScanFlag(key: ScanFlag, value: ScanFlagValue): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage blokiran — nema šta da se upiše */
  }
}

const flag = readScanFlag;

/**
 * Da li na startu automatski postaviti ~2× zoom.
 *
 * 1.0 to radi BEZUSLOVNO u `setupZoomUI` (lokacije i reversi), i te dve ljuske u
 * 3.0 već imaju isto ponašanje — NE dira se. Za ljuske koje zoom tek dobijaju
 * (montaža, mob-održavanje) auto-zoom se pali SAMO na „AF-slepom" Android
 * profilu, tj. tamo gde skeniranje danas ne uspeva. Na svemu ostalom klizač
 * kreće od ZATEČENE vrednosti uređaja → nula promene ponašanja za S26, iPhone i
 * Honor (koji rade).
 *
 * Prekidači: `ss3_scan_autozoom = 'on' | 'off'`.
 */
export function shouldAutoZoomOnStart(track: MediaStreamTrack | null): boolean {
  const f = flag('ss3_scan_autozoom');
  if (f === 'on') return true;
  if (f === 'off') return false;
  if (!isAndroidChromeBrowser()) return false; // zoom pouzdan samo tu (1.0 paritet)
  return isAfBlindAndroid(track) || matchesSamsungAProblemModel();
}

/**
 * Periodično re-okidanje AF-a. **Nije 1.0 paritet** — 1.0 fokus okida samo na
 * tap i posle zoom-a. Zato je uključeno SAMO za „AF-slep" profil koji izlaže
 * `single-shot` (uređaj bez ijednog automatskog režima: bez ovoga fokus ostaje
 * na onome što je zateklo pri startu i radnik mora da tapka). Kill-switch:
 * `ss3_scan_af_kick = 'off'`.
 */
export function shouldPeriodicAfKick(track: MediaStreamTrack | null): boolean {
  const f = flag('ss3_scan_af_kick');
  if (f === 'off') return false;
  if (!track) return false;
  if (f === 'on') return readFocusModes(track).includes('single-shot');
  return isAfBlindAndroid(track) && readFocusModes(track).includes('single-shot');
}

export const AF_KICK_INTERVAL_MS = 2500;

// ── Dijagnostika za teren ───────────────────────────────────────────────────

export interface ScanDiag {
  /** Model uređaja ili `Android(UA-skriven)` — Chrome krije model u UA. */
  model: string;
  /** Da li je sočivo birao capability-picker. */
  lens: string;
  /** Stanje autofokusa: zatečeni režim + ponuđeni režimi + „AF-slep" oznaka. */
  af: string;
  /** Trenutni zoom i opseg. */
  zoom: string;
  /** Da li je nišan-gejt aktivan u ovoj sesiji. */
  roi: boolean;
}

/**
 * Snimak stanja kamere za dijagnostički red (05.08.2026). Bez ovoga se problem sa
 * skenerom na konkretnom telefonu gađa naslepo: model Chrome krije, a da li je
 * picker izabrao sočivo, da li je AF uopšte primenjen i da li je nišan-gejt
 * aktivan nije se videlo NIGDE — ni u aplikaciji ni u prijavi sa terena.
 */
export function buildScanDiag(
  track: MediaStreamTrack | null,
  info?: { lensPicked?: boolean; roiGate?: boolean; zoomValue?: number },
): ScanDiag {
  const modes = readFocusModes(track);
  const cur = currentFocusMode(track);
  // RAW opseg: dijagnostika opisuje HARDVER. Kroz gejtovani `readZoomCapability`
  // bi na Samsung Internetu pisalo „nema" iako reversi ljuska tamo stvarno
  // primeni 2× — red bi lagao baš na uređaju koji pokušavamo da izmerimo.
  const cap = readZoomCapabilityRaw(track);
  const zoomNow = info?.zoomValue ?? cap?.current;
  const hidden = isZoomControlHiddenByPlatform();
  return {
    model: deviceModelLabel(),
    lens: track ? (info?.lensPicked ? 'picker' : 'podrazumevano') : '—',
    af: track
      ? `${cur || '—'}${modes.length ? ` [${modes.join('/')}]` : ' [bez caps]'}${
          isAfBlindAndroid(track) ? ' AF-slep' : ''
        }`
      : '—',
    zoom: cap
      ? `${(zoomNow ?? cap.min).toFixed(1)}× (${cap.min.toFixed(1)}–${cap.max.toFixed(1)})${
          hidden ? ', klizač skriven' : ''
        }`
      : 'nema',
    roi: Boolean(info?.roiGate),
  };
}
