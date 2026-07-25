/**
 * Poslovna godina/datum u FIKSNOJ zoni Europe/Belgrade (DB audit DB-031).
 *
 * Prod baza i Node kontejner rade u UTC (izmereno 25.07.2026), pa
 * `new Date().getFullYear()` oko ponoći/Nove godine vraća UTC godinu:
 * dokument knjižen 1.1. u 00:30 po Beogradu bi otišao u PROŠLOGODIŠNJU
 * sekvencu numeracije `NNNN/god`. Svi brojači zato godinu izvode odavde.
 *
 * Intl sa eksplicitnim timeZone je jedini TZ-podatak koji Node garantuje
 * bez env TZ podešavanja (ICU baza); nema ručnih offset računa (DST-safe).
 *
 * Srodnik: modules/scheduler/belgrade-time.ts (puni parts API za cron
 * računicu) — ovde je namerno samo godina, da common ne zavisi od modula.
 */
const BUSINESS_TZ = "Europe/Belgrade";

const yearFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
});

/** Kalendarska godina datog trenutka po Europe/Belgrade (default: sada). */
export function businessYear(at: Date = new Date()): number {
  return Number.parseInt(yearFmt.format(at), 10);
}
