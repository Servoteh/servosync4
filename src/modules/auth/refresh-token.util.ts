import { createHash, randomBytes } from "node:crypto";

/**
 * Refresh token helpers (BACKEND_RULES §7, roadmap Faza B.1).
 *
 * Sirovi token = 48 nasumičnih bajtova (Node `crypto.randomBytes`, ne Web Crypto)
 * kodiranih base64url. U bazu ide SAMO SHA-256 hex hash (`tokenHash`), nikad sirovi
 * token — krađa baze ne otkriva upotrebljive tokene.
 */

/** Broj nasumičnih bajtova u sirovom refresh tokenu (pre base64url kodiranja). */
const REFRESH_TOKEN_BYTES = 48;

/** Default TTL kad `REFRESH_TOKEN_TTL_DAYS` nije postavljen (spec: 30 dana klizno). */
const DEFAULT_TTL_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Novi sirovi refresh token (base64url, ~64 znaka). Vraća se klijentu samo jednom. */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hex hash sirovog tokena — vrednost koja se čuva/pretražuje u `token_hash`. */
export function hashRefreshToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * TTL u danima iz `REFRESH_TOKEN_TTL_DAYS` (default 30). Nevalidne/nepozitivne
 * vrednosti padaju na default — nikad se ne izda token koji je odmah istekao.
 */
export function refreshTokenTtlDays(): number {
  const raw = (process.env.REFRESH_TOKEN_TTL_DAYS ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
}

/** Trenutak isteka za nov token: `from` + TTL dana (default now). */
export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + refreshTokenTtlDays() * MS_PER_DAY);
}

/** Prag za higijensko čišćenje: redovi istekli pre više od 60 dana su bezbedni za brisanje. */
export function refreshTokenPruneBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - 60 * MS_PER_DAY);
}
