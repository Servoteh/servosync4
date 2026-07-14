// JMBG (jedinstveni matični broj građana) — validacija i parser.
// Port 1.0 `src/lib/jmbg.js` (paritet algoritma, doktrina §C).
//
// Format (13 cifara): DDMMGGG RR BBB K
//   DD  — dan rođenja (01–31) · MM — mesec (01–12)
//   GGG — poslednje 3 cifre godine; 900–999 → 1900-te, ostalo → 2000-te
//   RR  — region rođenja · BBB — redni broj; 000–499 = M, 500–999 = Ž
//   K   — kontrolna cifra (modulo 11; warn-only za legacy unose)

export interface JmbgParsed {
  birthDate: string; // ISO YYYY-MM-DD
  gender: 'M' | 'Z';
  region: string;
}

export interface JmbgValidation extends Partial<JmbgParsed> {
  valid: boolean;
  error?: string;
}

/** True ako je string tačno 13 cifara. */
export function isValidJmbgFormat(jmbg: unknown): jmbg is string {
  return typeof jmbg === 'string' && /^\d{13}$/.test(jmbg);
}

/** Validacija kontrolne cifre (modulo 11). True samo ako je i format ispravan. */
export function isValidJmbgChecksum(jmbg: string): boolean {
  if (!isValidJmbgFormat(jmbg)) return false;
  const d = jmbg.split('').map(Number);
  const sum =
    7 * d[0] + 6 * d[1] + 5 * d[2] + 4 * d[3] +
    3 * d[4] + 2 * d[5] + 7 * d[6] + 6 * d[7] +
    5 * d[8] + 4 * d[9] + 3 * d[10] + 2 * d[11];
  const m = 11 - (sum % 11);
  let expected: number;
  if (m === 11) expected = 0;
  else if (m === 10) return false; /* nemoguća kontrolna cifra */
  else expected = m;
  return expected === d[12];
}

/** Datum rođenja (ISO), pol (M/Z) i region iz JMBG-a; null ako format/datum nisu validni. */
export function parseJmbg(jmbg: string): JmbgParsed | null {
  if (!isValidJmbgFormat(jmbg)) return null;
  const dd = parseInt(jmbg.slice(0, 2), 10);
  const mm = parseInt(jmbg.slice(2, 4), 10);
  const yyy = parseInt(jmbg.slice(4, 7), 10);
  const region = jmbg.slice(7, 9);
  const rrr = parseInt(jmbg.slice(9, 12), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = yyy >= 900 ? 1000 + yyy : 2000 + yyy;
  const dt = new Date(year, mm - 1, dd);
  if (dt.getFullYear() !== year || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { birthDate: iso, gender: rrr >= 500 ? 'Z' : 'M', region };
}

/**
 * Kompletna validacija — `{ valid, error?, birthDate?, gender?, region? }`.
 * `requireChecksum` je default false: legacy zaposleni imaju nevalidnu kontrolnu
 * cifru ali su važeći (1.0 politika: checksum je warn-only).
 */
export function validateJmbg(jmbg: string | null | undefined, opts: { requireChecksum?: boolean } = {}): JmbgValidation {
  if (jmbg == null || jmbg === '') return { valid: false, error: 'JMBG je prazan.' };
  if (!isValidJmbgFormat(jmbg)) return { valid: false, error: 'JMBG mora imati tačno 13 cifara.' };
  const parsed = parseJmbg(jmbg);
  if (!parsed) return { valid: false, error: 'JMBG ima neispravan datum rođenja.' };
  if (opts.requireChecksum && !isValidJmbgChecksum(jmbg)) {
    return { valid: false, error: 'JMBG nije validan (kontrolna cifra ne odgovara).' };
  }
  return { valid: true, ...parsed };
}
