/**
 * Reversi — FE helperi za bulk import (RC-43/45/47/56).
 *
 * Port 1.0 `src/ui/reversi/bulkImportModal.js` (normHeader / fixMojibake /
 * normalizeDate / column-def po tipu / mapRow / validateRow / downloadTemplate).
 * Čisti FE helperi — bez React-a, bez mreže. BE mapiranja rade novi hookovi
 * (`useBulkImportCuttingTools`, `useAnalyzeReversals`, `useExecuteReversals`).
 */

/** BOM prefiks za CSV — Excel prepoznaje UTF-8 tek uz BOM. */
export const CSV_BOM = '﻿';

export type ImportType = 'hand' | 'cutting' | 'revers';

/** Jedna kolona uvoza: ključ + prikazna labela + tip vrednosti + aliasi zaglavlja. */
export interface ImportCol {
  key: string;
  label: string;
  required?: boolean;
  type?: 'date' | 'number';
  aliases: string[];
}

/** Generički mapirani red — vrednosti su string ili number (posle mapRow). */
export type ImportRow = Record<string, string | number>;

/* ─── Definicije kolona po tipu (paritet 1.0 HAND/CUTTING/REVERS_COLS) ─── */

export const HAND_COLS: ImportCol[] = [
  { key: 'oznaka', label: 'Oznaka', required: true, aliases: ['oznaka', 'sifra', 'šifra', 'kod', 'code'] },
  { key: 'naziv', label: 'Naziv', required: true, aliases: ['naziv', 'name', 'opis', 'description'] },
  { key: 'kategorija', label: 'Kategorija', aliases: ['kategorija', 'category', 'tip', 'vrsta', 'podgrupa', 'klasa'] },
  { key: 'serijski_broj', label: 'Serijski broj', aliases: ['serijski', 'serijski broj', 'sn', 'serial', 'serial number'] },
  { key: 'datum_kupovine', label: 'Datum kupovine', type: 'date', aliases: ['datum', 'datum kupovine', 'datum nabavke', 'purchase date', 'date'] },
  { key: 'napomena', label: 'Napomena', aliases: ['napomena', 'note', 'notes', 'remark', 'pribor'] },
];

export const CUTTING_COLS: ImportCol[] = [
  { key: 'oznaka', label: 'Oznaka', required: true, aliases: ['oznaka', 'sifra', 'šifra', 'kod', 'code'] },
  { key: 'naziv', label: 'Naziv', required: true, aliases: ['naziv', 'name', 'opis', 'description'] },
  { key: 'klasa', label: 'Klasa', aliases: ['klasa', 'class', 'tip', 'vrsta'] },
  { key: 'jedinica', label: 'Jedinica', aliases: ['jedinica', 'jedinica mere', 'jm', 'unit', 'jed mere'] },
  { key: 'kompatibilne_masine', label: 'Kompatibilne mašine', aliases: ['masine', 'mašine', 'machines', 'kompatibilne masine', 'kompatibilne mašine'] },
  { key: 'pocetna_kolicina', label: 'Početna količina', type: 'number', aliases: ['kolicina', 'količina', 'qty', 'pocetna', 'pocetno stanje', 'početno stanje', 'stanje'] },
  { key: 'minimalna_zaliha', label: 'Minimalna zaliha', type: 'number', aliases: ['minimalna zaliha', 'min zaliha', 'minimalna količina', 'minimum', 'min', 'reorder level'] },
  { key: 'napomena', label: 'Napomena', aliases: ['napomena', 'note', 'opis dodatni', 'notes'] },
];

export const REVERS_COLS: ImportCol[] = [
  { key: 'tip', label: 'Tip dokumenta', required: true, aliases: ['tip', 'type', 'doc_type', 'tip dokumenta'] },
  { key: 'datum', label: 'Datum izdavanja', type: 'date', aliases: ['datum', 'date', 'datum izdavanja', 'issued at', 'issued_at'] },
  { key: 'primalac_tip', label: 'Tip primaoca', required: true, aliases: ['primalac tip', 'recipient_type', 'tip primaoca'] },
  { key: 'primalac', label: 'Primalac (ime / mašina / firma)', required: true, aliases: ['primalac', 'recipient', 'recipient_name', 'ime primaoca'] },
  { key: 'masina', label: 'Mašina (rj_code)', aliases: ['masina', 'mašina', 'machine', 'rj_code', 'rj code'] },
  { key: 'alat_oznaka_ili_barkod', label: 'Alat (oznaka ili barkod)', required: true, aliases: ['alat', 'oznaka', 'barkod', 'barcode', 'sifra', 'šifra'] },
  { key: 'kolicina', label: 'Količina', type: 'number', aliases: ['kolicina', 'količina', 'qty', 'qty_issued'] },
  { key: 'rok_povracaja', label: 'Rok povraćaja', type: 'date', aliases: ['rok', 'rok povracaja', 'rok povraćaja', 'expected return', 'return_date'] },
  { key: 'napomena', label: 'Napomena', aliases: ['napomena', 'note', 'notes'] },
];

export interface ImportTypeDef {
  id: ImportType;
  label: string;
  cols: ImportCol[];
}

export const IMPORT_TYPES: ImportTypeDef[] = [
  { id: 'hand', label: 'Ručni alat / oprema', cols: HAND_COLS },
  { id: 'cutting', label: 'Rezni alat', cols: CUTTING_COLS },
  { id: 'revers', label: 'Reversi (izdati)', cols: REVERS_COLS },
];

export function colsFor(type: ImportType): ImportCol[] {
  return (IMPORT_TYPES.find((t) => t.id === type) ?? IMPORT_TYPES[0]).cols;
}

/* ─── Helperi ────────────────────────────────────────────────────────── */

/** Zaglavlje → normalizovan oblik: trim + lower + `_`→space + skini dijakritike. */
export function normHeader(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Detektuj i popravi mojibake (UTF-8 bajtovi pročitani kao Windows-1252).
 * Tipičan obrazac: `š`→`Å¡`, `č`→`Ä`, `Ø`→`Ã˜`. Ako string sadrži >=2 takva
 * pattern-a, primeni reverse: encode kao Latin-1, decode kao UTF-8.
 */
export function fixMojibake(s: unknown): string {
  if (typeof s !== 'string' || s.length < 2) return typeof s === 'string' ? s : String(s ?? '');
  if (!/[ÃÅÂÄ]/.test(s)) return s;
  const patterns: RegExp[] = [
    /Ä‡/, /Ä‘/, /Ä/g, /Å¡/, /Å¾/, /Å /, /Å½/,
    /Ã/g, /Ã‚/, /Ã©/, /Ã«/, /Â°/, /Ã˜/, /Â­/,
  ];
  let hits = 0;
  for (const p of patterns) {
    if (p.global) {
      const m = s.match(p);
      if (m) hits += m.length;
    } else if (p.test(s)) {
      hits += 1;
    }
    if (hits >= 2) break;
  }
  if (hits < 2) return s;
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c > 0xff) return s; /* nije čisti cp1252 — odustani */
      bytes[i] = c;
    }
    const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (fixed && fixed !== s && !fixed.includes('�')) return fixed;
    return s;
  } catch {
    return s;
  }
}

/** DD.MM.YYYY / DD/MM/YYYY / ISO / Date → ISO 'YYYY-MM-DD' (prazno ako nevalidno). */
export function normalizeDate(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  return '';
}

/**
 * Mapiraj sirove redove (iz XLSX/CSV) na `ImportRow` po kolonama tipa. Zaglavlja
 * se poklapaju po labeli / ključu / aliasu (dijakritici i case nebitni). Vrednosti
 * se čiste: date→ISO, number→broj, ostalo→trim + fixMojibake.
 */
export function mapRow(raw: Record<string, unknown>[], cols: ImportCol[]): ImportRow[] {
  const headerMap = new Map<string, ImportCol>();
  const firstKeys = Object.keys(raw[0] ?? {});
  for (const hk of firstKeys) {
    const n = normHeader(fixMojibake(hk));
    const col = cols.find(
      (c) =>
        normHeader(c.label) === n ||
        normHeader(c.key) === n ||
        c.aliases.some((a) => normHeader(a) === n),
    );
    if (col) headerMap.set(hk, col);
  }
  return raw.map((src) => {
    const r: ImportRow = {};
    for (const [hk, col] of headerMap.entries()) {
      let v: unknown = src[hk];
      if (v === undefined || v === null) v = '';
      if (col.type === 'date') {
        r[col.key] = normalizeDate(v);
      } else if (col.type === 'number') {
        const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
        r[col.key] = Number.isFinite(n) ? n : 0;
      } else {
        r[col.key] = fixMojibake(String(v).trim());
      }
    }
    return r;
  });
}

/** RC-56 — validacija jednog reda po tipu; vraća listu grešaka (prazno = validno). */
export function validateRow(r: ImportRow, type: ImportType): string[] {
  const errs: string[] = [];
  const cols = colsFor(type);
  const str = (k: string): string => String(r[k] ?? '').trim();
  for (const c of cols) {
    /* Datum izdavanja nije obavezan — prazan se puni današnjim datumom pri uvozu. */
    if (c.required && !str(c.key)) errs.push(`${c.label} obavezno`);
  }
  if (type === 'revers') {
    const tip = str('tip').toUpperCase();
    if (tip && !['TOOL', 'COOPERATION_GOODS', 'CUTTING_TOOL'].includes(tip)) {
      errs.push('tip mora biti TOOL/COOPERATION_GOODS/CUTTING_TOOL');
    }
    const primTip = str('primalac_tip').toUpperCase();
    if (primTip && !['EMPLOYEE', 'DEPARTMENT', 'EXTERNAL_COMPANY', 'MACHINE'].includes(primTip)) {
      errs.push('primalac_tip mora biti EMPLOYEE/DEPARTMENT/EXTERNAL_COMPANY/MACHINE');
    }
    if (primTip === 'MACHINE' && !str('masina')) {
      errs.push('masina obavezno za MACHINE primaoca');
    }
    if (tip === 'CUTTING_TOOL' && !str('masina')) {
      errs.push('mašina obavezna za CUTTING_TOOL');
    }
    // RC-56 — količina mora biti ceo broj ≥ 1 (BE ReversalRowDto.kolicina @IsInt @Min(1));
    // frakcioni red se obeleži i isključi, umesto da 400-om obori ceo batch.
    const kolRaw = str('kolicina');
    if (kolRaw) {
      const kx = Number(kolRaw.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(kx) || kx < 1) errs.push('količina mora biti ceo broj ≥ 1');
      else if (Math.floor(kx) !== kx) errs.push('količina mora biti ceo broj (kom)');
    }
  }
  if (type === 'cutting') {
    if (str('pocetna_kolicina') && Number(r.pocetna_kolicina) < 0) {
      errs.push('početna količina ne može biti negativna');
    }
    const minRaw = str('minimalna_zaliha');
    if (minRaw) {
      const mx = Number(minRaw.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(mx) || mx < 0) errs.push('minimalna zaliha mora biti broj ≥ 0');
      else if (Math.floor(mx) !== mx) errs.push('minimalna zaliha mora biti ceo broj (kom)');
    }
  }
  return errs;
}

/** RC-45 — skini CSV template (BOM + header + jedan primer red) za dati tip. */
export function downloadTemplate(type: ImportType): void {
  const cols = colsFor(type);
  const example = cols.map((c) => templateExample(type, c.key));
  const headers = cols.map((c) => c.label);
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv =
    headers.map((h) => `"${h}"`).join(',') +
    '\r\n' +
    example.map((v) => esc(String(v))).join(',') +
    '\r\n';
  const blob = new Blob([CSV_BOM + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `reversi-template-${type}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function templateExample(type: ImportType, key: string): string {
  if (type === 'hand') {
    switch (key) {
      case 'oznaka': return 'AL-001';
      case 'naziv': return 'Akumulatorska bušilica';
      case 'kategorija': return 'alat';
      case 'serijski_broj': return 'SN-12345';
      case 'datum_kupovine': return '2024-03-15';
      case 'napomena': return 'sa baterijom + punjac';
      default: return '';
    }
  }
  if (type === 'cutting') {
    switch (key) {
      case 'oznaka': return 'GL-D12-HSS';
      case 'naziv': return 'Glodalo HSS Ø12';
      case 'klasa': return 'glodalo';
      case 'jedinica': return 'kom';
      case 'kompatibilne_masine': return '8.3, 10.1';
      case 'pocetna_kolicina': return '20';
      case 'minimalna_zaliha': return '0';
      default: return '';
    }
  }
  // revers
  switch (key) {
    case 'tip': return 'TOOL';
    case 'datum': return '2026-05-01';
    case 'primalac_tip': return 'EMPLOYEE';
    case 'primalac': return 'Petar Petrović';
    case 'masina': return '';
    case 'alat_oznaka_ili_barkod': return 'AL-001';
    case 'kolicina': return '1';
    case 'rok_povracaja': return '2026-08-01';
    case 'napomena': return 'pribor: punjač';
    default: return '';
  }
}

/**
 * Minimalni CSV parser (zarez, dvostruki navodnici, `""` escape) — za .csv fajlove
 * čitane preko `file.text()` (očuvano UTF-8 kodiranje, za razliku od XLSX.read).
 * Port 1.0 `parseCsvToObjects`.
 */
export function parseCsvToObjects(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const splitCsv = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = splitCsv(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((ln) => {
    const cells = splitCsv(ln);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? '';
    });
    return obj;
  });
}

/** Split zarez/tačka-zarez liste (kompatibilne mašine / primaoci) uz trim + dedupe. */
export function parseList(raw: unknown): string[] {
  return [
    ...new Set(
      String(raw ?? '')
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}
