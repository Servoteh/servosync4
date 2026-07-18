/**
 * JWT tajna — FAIL-CLOSED (SEC-01, Faza 2 analize Tehnologije).
 *
 * Ranije je i potpisivanje (auth.module) i verifikacija (jwt.strategy) padalo na
 * javno poznat literal `dev_change_me` kad `JWT_SECRET` nije postavljen. Tiho
 * podizanje bez env-a = svako može da potpiše admin token (rola dolazi iz tokena).
 * Zato: ako tajna nije postavljena ili je očiti placeholder — bootstrap PADA,
 * umesto da aplikacija radi sa poznatom tajnom.
 */
const PLACEHOLDERI = new Set([
  "dev_change_me",
  "change_me_in_production",
  "changeme",
  "",
]);

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || PLACEHOLDERI.has(secret.trim())) {
    throw new Error(
      "JWT_SECRET nije postavljen (ili je placeholder). Postavi jaku tajnu u okruženju — bootstrap je zaustavljen radi bezbednosti (SEC-01).",
    );
  }
  return secret;
}
