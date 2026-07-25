/**
 * Brute-force zaštita za /auth/login i /auth/sso (review Opus 5 — bezbednost).
 *
 * PROBLEM: API je javno dostupan (api.servosync.servoteh.com) i login nije imao
 * NIKAKVO ograničenje broja pokušaja — napadač može neograničeno probati lozinke.
 *
 * REŠENJE: in-memory klizni prozor po ključu (IP + korisničko ime), BEZ nove
 * zavisnosti (BACKEND_RULES §10 — nova zavisnost traži odobrenje). Jedan proces =
 * jedan brojač; dovoljno za on-prem instalaciju sa jednim kontejnerom.
 *
 * Politika: MAX_ATTEMPTS neuspelih u WINDOW_MS → blokada BLOCK_MS. Uspešan login
 * briše brojač. Čisti se lenjo (bez tajmera) da nema curenja memorije.
 */

const WINDOW_MS = 15 * 60 * 1000; // prozor posmatranja: 15 min
const MAX_ATTEMPTS = 10; // neuspelih pokušaja po ključu u prozoru
const BLOCK_MS = 15 * 60 * 1000; // trajanje blokade
const MAX_KEYS = 10_000; // gornja granica mape (zaštita od punjenja memorije)

interface Bucket {
  fails: number;
  first: number; // početak prozora
  blockedUntil: number; // 0 = nije blokiran
}

const buckets = new Map<string, Bucket>();

/** Očisti istekle unose kad mapa naraste (lenjo, bez setInterval-a). */
function sweep(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) {
    if (b.blockedUntil < now && now - b.first > WINDOW_MS) buckets.delete(k);
  }
}

/** Ključ: IP + identitet (da jedan napadnut nalog ne blokira ceo NAT izlaz firme). */
export function throttleKey(ip: string | undefined, identity: string | undefined): string {
  return `${ip ?? "?"}|${(identity ?? "?").toLowerCase().trim()}`;
}

/** Preostale sekunde blokade (0 = prolaz dozvoljen). */
export function loginBlockedSeconds(key: string, now = Date.now()): number {
  const b = buckets.get(key);
  if (!b || b.blockedUntil <= now) return 0;
  return Math.ceil((b.blockedUntil - now) / 1000);
}

/** Zabeleži NEUSPEO pokušaj; vraća true ako je time nastupila blokada. */
export function recordLoginFailure(key: string, now = Date.now()): boolean {
  sweep(now);
  const b = buckets.get(key);
  if (!b || now - b.first > WINDOW_MS) {
    buckets.set(key, { fails: 1, first: now, blockedUntil: 0 });
    return false;
  }
  b.fails += 1;
  if (b.fails >= MAX_ATTEMPTS) {
    b.blockedUntil = now + BLOCK_MS;
    b.fails = 0;
    b.first = now;
    return true;
  }
  return false;
}

/** Uspešan login — obriši istoriju za taj ključ. */
export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

/** Samo za testove — isprazni stanje. */
export function __resetLoginThrottle(): void {
  buckets.clear();
}

export const LOGIN_THROTTLE_POLICY = { WINDOW_MS, MAX_ATTEMPTS, BLOCK_MS };
