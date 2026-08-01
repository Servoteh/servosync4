'use client';

/*
 * Izbor NAJBOLJEG zadnjeg objektiva na Android multi-lens telefonima — port 1.0
 * `src/services/cameraPicker.js` (nastao kroz terenski debug Samsung A17/A26;
 * vidi 1.0 docs/SCAN_ANALIZA_A17_A26.md). Problem: `facingMode:'environment'`
 * na A-seriji vraća BILO KOJI od 2–4 zadnja objektiva — često macro sa fiksnim
 * fokusom ~3 cm → preview „radi" a barkod se nikad ne dekodira.
 *
 * Strategija (1.0 paritet):
 *   1. Samo Android web (iPhone/desktop imaju jedan logički back — facingMode dosta).
 *   2. Enumeriši zadnje kamere; 0 labela (permisija još nije data) → warm-up
 *      getUserMedia pa re-enumeracija; tačno 1 zadnja → null (facingMode je optimalan).
 *   3. Za svaku kandidatkinju otvori kratak probe stream, pročitaj capabilities
 *      i ODMAH zatvori; skoruj (torch je najjači signal — macro/ultrawide/depth
 *      gotovo nikad nemaju LED; kvadratni ≤1080 senzor = 2MP macro/depth…).
 *   4. Tie-break = POSLEDNJI u enumeraciji (proizvođači main stavljaju kasnije).
 *   5. Keš u localStorage 30 dana (probe košta ~200-600ms po kameri); ručni izbor
 *      korisnika (manual) ima prednost i auto-picker ga NIKAD ne prebriše.
 *
 * KAMERA-HIGIJENA (31.07/01.08): probe-ovi su niz brzih open/close ciklusa nad
 * ISTIM senzorom — bez pauze između njih Samsung ROM vrati NotReadableError na
 * drugoj/trećoj kameri i picker izabere pogrešnu (ili nijednu). Zato: pauza posle
 * warm-up-a i između probe-ova, jedan retry na prolaznu grešku, a ako uzorak i
 * dalje nije potpun — rezultat važi za sesiju ali se NE kešira.
 */

const CACHE_KEY = 'ss3_scan_camera_v1';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const MIN_SCORE_TO_USE_CACHE = 3;
/** Retry probe-a na prolaznu grešku (OS još drži senzor prethodnog probe-a). */
const PROBE_RETRY_MS = 700;
/** Skor kandidata koji je DISKVALIFIKOVAN (front kamera) — ne bira se ni kad je sam. */
const DISQUALIFIED_SCORE = -99;

function isIOSWebKitUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  const u = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(u)) return true;
  return u.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Pauza posle stop()-a pre novog getUserMedia — NAMERNO lokalna kopija (ne uvozi
 * se `cameraCooldownMs` iz `barcode-decoder` da lib↔lib zavisnost ne postane
 * ciklična i da picker ne vuče ZXing tipove). iOS grana ne postoji jer picker na
 * iOS-u i ne radi (`shouldRunCameraPicker`).
 */
function pickerCooldownMs(): number {
  if (typeof navigator === 'undefined') return 120;
  if (/SamsungBrowser/i.test(navigator.userAgent || '')) return 450;
  return 120; // minimum i na „dobrom" Android Chrome-u
}

/** Samo Android browser (ne iOS, ne desktop) — jedini teren gde picker vredi. */
export function shouldRunCameraPicker(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return false;
  if (isIOSWebKitUA()) return false;
  return /Android/i.test(navigator.userAgent || '');
}

const BAD_LENS_LABEL = /\b(macro|ultra|ultra[-\s]?wide|telephoto|depth|tof|fish[-\s]?eye)\b/i;
const FRONT_LABEL = /\b(front|user|face)\b/i;

interface CamCaps {
  torch?: boolean;
  focusMode?: string[];
  focusDistance?: { max?: number };
  width?: { max?: number };
  height?: { max?: number };
  facingMode?: string[];
}

/** `track.getSettings()` — deo polja nije u lib.dom (torch/facingMode). */
interface CamSettings {
  torch?: boolean;
  facingMode?: string;
}

/**
 * Skor objektiva iz capabilities + labele (1.0 scoreCameraCapabilities, testiran):
 * veći = verovatnije GLAVNA zadnja kamera. `settings` je opciono (`getSettings()`
 * istog track-a) i pokriva dva slučaja koje capabilities same propuštaju:
 *   • torch signal — deo Android ROM-ova ne prijavi `caps.torch:true`, ali track
 *     ima `settings.torch` (obično `false`); i samo POSTOJANJE polja znači da
 *     objektiv ima LED, tj. da je glavni (1.0 paritet);
 *   • front kamera koja se provukla kroz filter labela (prazna labela pre
 *     permisije) — `facingMode:'user'` je diskvalifikacija, ne minus poen.
 */
export function scoreCameraCapabilities(
  caps: CamCaps | null,
  label: string,
  settings?: CamSettings | null,
): number {
  let score = 0;
  const l = String(label || '');
  // Front kamera nikad nije kandidat — makar labela bila prazna/lažna.
  const facing = [
    ...(Array.isArray(caps?.facingMode) ? caps!.facingMode.map(String) : []),
    String(settings?.facingMode || ''),
  ]
    .join(' ')
    .toLowerCase();
  if (facing.includes('user')) return DISQUALIFIED_SCORE;
  // Torch = najjači signal glavnog objektiva; caps ILI puko postojanje settings polja.
  if (caps?.torch === true || (settings && settings.torch !== undefined)) score += 3;
  if (caps) {
    const fm = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    if (fm.includes('continuous') || fm.includes('auto')) score += 2;
    const fdMax = Number(caps.focusDistance?.max);
    if (Number.isFinite(fdMax)) {
      if (fdMax > 5) score += 2; // može da fokusira daleko = nije macro
      else if (fdMax > 0 && fdMax <= 0.3) score -= 2; // fiksni bliski fokus = macro
    }
    const maxW = Number(caps.width?.max);
    const maxH = Number(caps.height?.max);
    if (Number.isFinite(maxW) && Number.isFinite(maxH)) {
      if (maxW === maxH && maxW <= 1080) score -= 2; // kvadratni 2MP macro/depth senzor
      else if (maxW >= 1920 || maxH >= 1080) score += 1;
    }
  }
  if (BAD_LENS_LABEL.test(l)) score -= 2;
  if (l && !FRONT_LABEL.test(l)) score += 1;
  return score;
}

/**
 * Keširan izbor. `deviceId: ''` je NEGATIVAN keš: discovery je odrađen ali nije
 * dao ubedljivog pobednika (najbolji skor < `MIN_SCORE_TO_USE_CACHE`) → sledeći
 * put idi ODMAH na `facingMode` umesto da se ponovo troši ~200-600ms po kameri.
 */
interface CachedChoice {
  deviceId: string;
  label?: string;
  score: number;
  manual?: boolean;
  fp: string;
  at: number;
}

function fingerprint(): string {
  try {
    return `${(navigator.userAgent || '').slice(0, 200)}|h${screen.height}|d${window.devicePixelRatio}`;
  } catch {
    return 'fp';
  }
}

function readCache(): CachedChoice | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as CachedChoice;
    if (!p || typeof p.deviceId !== 'string' || p.fp !== fingerprint()) return null;
    if (Date.now() - (p.at || 0) > CACHE_TTL_MS) return null;
    // Negativan zapis (deviceId === '') je VALIDAN odgovor „koristi facingMode";
    // prag skora se primenjuje samo na pozitivne auto-izbore.
    if (p.deviceId && !p.manual && (p.score ?? 0) < MIN_SCORE_TO_USE_CACHE) return null;
    return p;
  } catch {
    return null;
  }
}

function writeCache(c: Omit<CachedChoice, 'fp' | 'at'>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...c, fp: fingerprint(), at: Date.now() }));
  } catch {
    /* storage blokiran — picker radi bez keša */
  }
}

/** Ručni izbor korisnika (📷 cycle) — prednost nad auto-pickerom do isteka TTL-a. */
export function rememberManualCameraChoice(deviceId: string, label: string): void {
  writeCache({ deviceId, label, score: 99, manual: true });
}

/**
 * Da li picker uopšte ima zapis za ovaj uređaj (pozitivan, negativan ili ručni).
 * Koriste ga ljuske sa SOPSTVENIM (starijim) kešom ručnog izbora da ga jednokratno
 * prenesu u zajednički keš — inače bi ostali skeneri „ispravljali" korisnika.
 */
export function hasStoredCameraChoice(): boolean {
  return readCache() !== null;
}

async function enumerateBackCameras(): Promise<MediaDeviceInfo[]> {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const vids = devs.filter((d) => d.kind === 'videoinput');
  const labeled = vids.filter((d) => !!d.label);
  // Bez labela (permisija još nije data) vraćamo SVE — filtriranje nema osnov.
  if (labeled.length === 0) return vids;
  return vids.filter((d) => !FRONT_LABEL.test(d.label || ''));
}

async function deviceStillExists(deviceId: string): Promise<boolean> {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.some((d) => d.kind === 'videoinput' && d.deviceId === deviceId);
  } catch {
    return false;
  }
}

interface Probe {
  deviceId: string;
  label: string;
  score: number;
}

/** Prolazna greška (OS još drži senzor prethodnog probe-a) vs prava — 1.0 obrazac. */
function isTransientProbeError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  const re = /NotReadableError|AbortError|TrackStartError|could not start video source/i;
  return re.test(String(e?.name || '')) || re.test(String(e?.message || ''));
}

async function probeCameraOnce(deviceId: string): Promise<Probe> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Probe bez video track-a');
    let caps: CamCaps | null = null;
    try {
      caps = (track.getCapabilities?.() ?? null) as CamCaps | null;
    } catch {
      caps = null;
    }
    let settings: CamSettings | null = null;
    try {
      settings = (track.getSettings?.() ?? null) as CamSettings | null;
    } catch {
      settings = null;
    }
    const label = track.label || '';
    return { deviceId, label, score: scoreCameraCapabilities(caps, label, settings) };
  } finally {
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
  }
}

/**
 * Probe sa JEDNIM retry-jem na prolaznu grešku. `transient:true` znači da kamera
 * nije izmerena zbog zauzeća (a ne zato što je odbila constraint) — pozivalac
 * tada zna da mu je uzorak nepotpun.
 */
async function probeCamera(
  deviceId: string,
): Promise<{ probe: Probe | null; transient: boolean }> {
  try {
    return { probe: await probeCameraOnce(deviceId), transient: false };
  } catch (e) {
    if (!isTransientProbeError(e)) return { probe: null, transient: false };
  }
  await sleep(PROBE_RETRY_MS);
  try {
    return { probe: await probeCameraOnce(deviceId), transient: false };
  } catch {
    return { probe: null, transient: true };
  }
}

/** Discovery koji je U LETU — v. `pickPreferredBackCamera`. */
let inFlightPick: Promise<string | null> | null = null;

/**
 * Vrati deviceId NAJBOLJE zadnje kamere ili null (= koristi facingMode ideal).
 * Skupo pri prvom pozivu (probe po kameri) — rezultat se kešira 30 dana; pri
 * slabom rezultatu se kešira NEGATIVNO, pa sledeći poziv odmah vrati null bez
 * ijednog probe-a (v. `CachedChoice`).
 *
 * PARALELNI POZIVI SE SPAJAJU (01.08): probe je niz open/close ciklusa nad istim
 * senzorom, pa bi dva istovremena discovery-ja (npr. zagrevanje pri zatvaranju
 * skenera + ljuska koju je korisnik odmah ponovo otvorio) jedan drugom oteli
 * kameru — oba uzorka „transient", oba bez keša, i još izabran nasumičan
 * objektiv. Drugi pozivalac zato dobija ISTI promise, ne novi ciklus.
 */
export function pickPreferredBackCamera(): Promise<string | null> {
  if (!inFlightPick) {
    inFlightPick = runCameraDiscovery().finally(() => {
      inFlightPick = null;
    });
  }
  return inFlightPick;
}

async function runCameraDiscovery(): Promise<string | null> {
  if (!shouldRunCameraPicker()) return null;

  const cached = readCache();
  if (cached) {
    if (!cached.deviceId) return null; // negativan keš — bez probe-ova, facingMode
    if (await deviceStillExists(cached.deviceId)) return cached.deviceId;
  }

  const cooldown = pickerCooldownMs();
  let backs = await enumerateBackCameras();
  // Labele su prazne dok korisnik ne odobri kameru bar jednom — warm-up stream
  // samo da odblokira labele (1.0 obrazac), pa odmah stop + re-enumeracija.
  if (backs.length > 1 && backs.every((d) => !d.label)) {
    try {
      const warm = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      warm.getTracks().forEach((t) => t.stop());
    } catch {
      return null; // permisija odbijena — neka regularni put prijavi grešku
    }
    // Senzor je upravo pušten: bez pauze prvi probe na Samsungu vraća
    // NotReadableError i kandidat ispada iz uzorka.
    await sleep(cooldown);
    backs = await enumerateBackCameras();
  }
  if (backs.length <= 1) return null; // facingMode je već optimalan

  const probes: Probe[] = [];
  let anyTransient = false;
  let first = true;
  for (const d of backs) {
    if (!first) await sleep(cooldown); // pauza IZMEĐU probe-ova (isti razlog)
    first = false;
    const { probe, transient } = await probeCamera(d.deviceId);
    if (probe) probes.push(probe);
    if (transient) anyTransient = true;
  }
  if (probes.length === 0) return null;

  // Diskvalifikovani (front) kandidati ne ulaze u izbor ni kao „najbolji od loših" —
  // vratiti front kameru je gore od `facingMode:'environment'` fallback-a.
  const eligible = probes.filter((p) => p.score > DISQUALIFIED_SCORE);
  if (eligible.length === 0) {
    if (!anyTransient) writeCache({ deviceId: '', label: '', score: DISQUALIFIED_SCORE });
    return null;
  }

  // Stabilan sort po skoru; tie-break = POSLEDNJI u enumeraciji (main je kasnije).
  let best = eligible[0];
  for (const p of eligible) if (p.score >= best.score) best = p;

  if (anyTransient) {
    // Uzorak je nepotpun (bar jedna kamera nije izmerena ni iz drugog pokušaja) —
    // pobednik važi za OVU sesiju, ali se ne pamti: sutra bi mogao biti pogrešan
    // objektiv zaključan na 30 dana.
    console.warn('[camera-picker] nepotpun uzorak (zauzeta kamera) — rezultat se ne kešira');
  } else if (best.score >= MIN_SCORE_TO_USE_CACHE) {
    writeCache({ deviceId: best.deviceId, label: best.label, score: best.score });
  } else {
    // Nijedan objektiv nije ubedljiv → negativan keš (sledeći put odmah facingMode).
    writeCache({ deviceId: '', label: '', score: best.score });
  }
  // 1.0 ponašanje: sesija u kojoj je discovery upravo odrađen KORISTI pobednika i
  // kad je skor nizak — izmeren objektiv je i tada bolji nasumičan izbor od onoga
  // što `facingMode` vrati na multi-lens A-seriji.
  return best.deviceId;
}
