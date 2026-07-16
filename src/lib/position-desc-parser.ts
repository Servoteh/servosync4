// Parser za „bulk paste" opisa pozicija — PORT iz 1.0 `src/lib/positionDescParser.js`.
//
// Format (case-insensitive, tolerantno na razmake i dijakritike):
//
//   == Šef proizvodnje ==
//   [Opis]
//   Kratak pasus...
//
//   [Očekivanja]
//   - Stavka 1
//   - Stavka 2
//
//   [Odgovornosti]
//   - ...
//
//   [Obaveze]
//   - ...
//
//   == Vođa smene ==
//   ...
//
// Pravila:
//   - Linija koja počinje sa `== ` i završava sa ` ==` (ili samo `==`) — naziv pozicije.
//     Može i samo `== Naziv` (bez završnog `==`).
//   - Linija u uglastim zagradama `[Naziv sekcije]` — sekcija.
//     Sve između sekcija ide u trenutnu sekciju kao markdown.
//   - Dozvoljeni nazivi sekcija (case-insensitive, sa/bez dijakritika):
//       Opis / Sažetak                 → summaryMd
//       Očekivanja                      → expectationsMd
//       Odgovornosti                    → responsibilitiesMd
//       Obaveze / Dužnosti              → dutiesMd
//
// Napomena o casing-u (3.0): 2.0 BE prima/vraća camelCase, pa parser proizvodi
// camelCase ključeve (razlika od 1.0 koji je pisao snake_case direktno u PostgREST).

const SECTION_ALIASES: Record<string, ParsedSectionKey> = {
  opis: 'summaryMd',
  sazetak: 'summaryMd',
  sažetak: 'summaryMd',
  ocekivanja: 'expectationsMd',
  očekivanja: 'expectationsMd',
  odgovornosti: 'responsibilitiesMd',
  obaveze: 'dutiesMd',
  duznosti: 'dutiesMd',
  dužnosti: 'dutiesMd',
};

export type ParsedSectionKey = 'summaryMd' | 'expectationsMd' | 'responsibilitiesMd' | 'dutiesMd';

const SECTION_KEYS: ParsedSectionKey[] = ['summaryMd', 'expectationsMd', 'responsibilitiesMd', 'dutiesMd'];

export interface ParsedPosition {
  name: string;
  summaryMd?: string;
  expectationsMd?: string;
  responsibilitiesMd?: string;
  dutiesMd?: string;
  warnings?: string[];
}

function normalizeSectionLabel(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Sklanja vodeće „[" i prateće „]" iz linije sekcije; vraća label ili null. */
function parseSectionHeader(line: string): string | null {
  const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  if (!m) return null;
  return m[1].trim();
}

/** Da li je linija „== Naziv ==" ili „== Naziv"? Vraća naziv ili null. */
function parsePositionHeader(line: string): string | null {
  const m = /^\s*==\s*(.+?)\s*(?:==)?\s*$/.exec(line);
  if (!m) return null;
  const name = m[1].replace(/\s*==\s*$/, '').trim();
  return name || null;
}

export function parsePositionDescriptions(text: string): ParsedPosition[] {
  if (!text || typeof text !== 'string') return [];

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedPosition[] = [];
  let cur: (ParsedPosition & { warnings: string[] }) | null = null;
  let curSection: ParsedSectionKey | null = null;
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (!cur || !curSection) {
      buffer = [];
      return;
    }
    // Trim trailing blank lines
    while (buffer.length && !buffer[buffer.length - 1].trim()) buffer.pop();
    // Trim leading blank lines
    while (buffer.length && !buffer[0].trim()) buffer.shift();
    const md = buffer.join('\n').trim();
    if (md) {
      // Append (ako je sekcija punjena više puta) — retko, ali sigurno.
      const prev = cur[curSection];
      cur[curSection] = prev ? (prev + '\n\n' + md).trim() : md;
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const posName = parsePositionHeader(rawLine);
    if (posName) {
      flushBuffer();
      cur = { name: posName, warnings: [] };
      curSection = null;
      out.push(cur);
      continue;
    }

    const sectionLabel = parseSectionHeader(rawLine);
    if (sectionLabel !== null) {
      flushBuffer();
      if (!cur) {
        // Sekcija pre prve pozicije — preskači.
        curSection = null;
        continue;
      }
      const norm = normalizeSectionLabel(sectionLabel);
      const key = SECTION_ALIASES[norm];
      if (!key) {
        cur.warnings.push(`Nepoznata sekcija "${sectionLabel}" — preskačem.`);
        curSection = null;
      } else {
        curSection = key;
      }
      continue;
    }

    // Obična linija — akumuliraj u buffer.
    if (cur && curSection) buffer.push(rawLine);
    // Ako nema cur ili nema sekcije — tihi skip (možda komentari pre prve pozicije).
  }

  flushBuffer();

  // Cleanup: ukloni prazne warnings nizove
  for (const p of out) {
    if (Array.isArray(p.warnings) && p.warnings.length === 0) delete p.warnings;
  }

  return out;
}

/**
 * Normalizacija imena pozicije za match sa DB. Trim + lowercase + ukloni dijakritike + collapse whitespace.
 */
export function normalizePositionName(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

export interface DbPositionLike {
  id: number;
  name: string;
}
export interface MatchResult<T extends DbPositionLike> {
  matched: { parsed: ParsedPosition; db: T }[];
  unmatched: ParsedPosition[];
}

/**
 * Spari listu parsiranih pozicija (iz `parsePositionDescriptions`) sa listom
 * pozicija iz DB (`[{id, name}, ...]`). Vraća {matched, unmatched}.
 */
export function matchPositions<T extends DbPositionLike>(parsed: ParsedPosition[], dbPositions: T[]): MatchResult<T> {
  const dbByNorm = new Map<string, T>();
  for (const p of dbPositions) {
    dbByNorm.set(normalizePositionName(p.name), p);
  }
  const matched: { parsed: ParsedPosition; db: T }[] = [];
  const unmatched: ParsedPosition[] = [];
  for (const p of parsed) {
    const db = dbByNorm.get(normalizePositionName(p.name));
    if (db) matched.push({ parsed: p, db });
    else unmatched.push(p);
  }
  return { matched, unmatched };
}

/** Da li parsirana pozicija ima ikakav sadržaj? */
export function parsedHasContent(p: ParsedPosition): boolean {
  return SECTION_KEYS.some((k) => p[k] && String(p[k]).trim());
}
