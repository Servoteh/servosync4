/**
 * Rate-limit za `POST /v1/dictation-inbox/claim` — zaštita od „pumpanja" sandučeta.
 *
 * PROBLEM: `claim` je destruktivan po dizajnu (uzme red i markira ga `delivered_at`,
 * bez vraćanja na „neposlato" — presuda vlasnika 29.07). Nalog sa `ai.chat` koji ga
 * poziva u petlji isprazni sanduče brže nego što čovek stigne da primeti, a delegat
 * u oblaku je izložen internetu. Bez ograničenja jedan ukraden token = tih odliv
 * svih diktata.
 *
 * REŠENJE: in-memory klizni prozor po POZIVAOCU (`users.id` iz JWT-a), BEZ nove
 * zavisnosti (BACKEND_RULES §10) — isti obrazac kao `common/login-throttle.ts`.
 * Jedan proces = jedan brojač; dovoljno za on-prem instalaciju sa jednim kontejnerom.
 *
 * Politika: MAX_CLAIMS poziva u WINDOW_MS po nalogu → 429 sa `Retry-After` sekundama.
 * Broje se SVI pozivi (i oni koji vrate `null`), jer je i prazan poll potrošnja.
 * Granica je namerno široka: agent koji radi normalno (nekoliko diktata u minutu,
 * uz poneki prazan poll) je nikad ne dodirne.
 */

const WINDOW_MS = 60 * 1000; // prozor posmatranja: 1 minut
const MAX_CLAIMS = 60; // poziva po nalogu u prozoru (prosek 1/s)
const MAX_KEYS = 10_000; // gornja granica mape (zaštita od punjenja memorije)

interface Bucket {
  hits: number;
  first: number; // početak prozora
}

const buckets = new Map<number, Bucket>();

/** Očisti istekle unose kad mapa naraste (lenjo, bez setInterval-a). */
function sweep(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) {
    if (now - b.first > WINDOW_MS) buckets.delete(k);
  }
}

/**
 * Zabeleži jedan `claim` pokušaj pozivaoca. Vraća 0 ako je prolaz dozvoljen, ili
 * broj sekundi koliko treba sačekati (>0) ako je granica probijena.
 */
export function recordClaimAttempt(userId: number, now = Date.now()): number {
  sweep(now);
  const b = buckets.get(userId);
  if (!b || now - b.first > WINDOW_MS) {
    buckets.set(userId, { hits: 1, first: now });
    return 0;
  }
  if (b.hits >= MAX_CLAIMS) {
    return Math.max(1, Math.ceil((b.first + WINDOW_MS - now) / 1000));
  }
  b.hits += 1;
  return 0;
}

/** Samo za testove — isprazni stanje. */
export function __resetClaimThrottle(): void {
  buckets.clear();
}

export const CLAIM_THROTTLE_POLICY = { WINDOW_MS, MAX_CLAIMS };
