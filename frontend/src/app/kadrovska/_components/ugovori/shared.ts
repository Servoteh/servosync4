import { toCyrillic } from '@/lib/hr-pdf';
import { formatDate } from '@/lib/format';
import type { Tone } from '@/components/ui-kit/status-badge';
import type { Contract } from '@/api/kadrovska';

// Deljeni helperi Ugovori taba (port 1.0 contractsTab.js + hrDocPdf.js/contractPdf.js
// pomoćnih funkcija): tipovi ugovora, status iz datuma, srpsko trajanje/ćirilizacija,
// generisanje brojeva dokumenata. Bez DOM-a (čist TS) — koriste ih forma i generatori.

export const CON_TYPE_OPTS: { v: string; l: string }[] = [
  { v: 'neodredjeno', l: 'Neodređeno vreme' },
  { v: 'odredjeno', l: 'Određeno vreme' },
  { v: 'probni', l: 'Probni rad' },
  { v: 'privremeno', l: 'Privremeni' },
  { v: 'delo', l: 'Ugovor o delu' },
  { v: 'student', l: 'Student' },
  { v: 'praksa', l: 'Praksa' },
  { v: 'ostalo', l: 'Ostalo' },
];

export const CON_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  CON_TYPE_OPTS.map((o) => [o.v, o.l]),
);

/** Tipovi za koje se generiše PDF Ugovor o radu (probni/praksa/delo… nemaju šablon). */
export const CONTRACT_PDF_TYPES = new Set(['neodredjeno', 'odredjeno']);

export interface ContractStatus {
  key: 'inactive' | 'expired' | 'expiring' | 'active';
  label: string;
  tone: Tone;
  days?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Status ugovora iz datuma: active / expiring(<30d) / expired / inactive (port 1.0). */
export function contractStatus(c: Contract): ContractStatus {
  if (c.isActive === false) return { key: 'inactive', label: 'Neaktivan', tone: 'neutral' };
  if (c.dateTo) {
    const today = todayYmd();
    if (c.dateTo < today) return { key: 'expired', label: 'Istekao', tone: 'danger' };
    const diff = Math.round((Date.parse(c.dateTo) - Date.parse(today)) / 86_400_000);
    if (diff <= 30) return { key: 'expiring', label: `Ističe za ${diff} d`, tone: 'warn', days: diff };
  }
  return { key: 'active', label: 'Aktivan', tone: 'success' };
}

/* ── Trajanje / datumi ─────────────────────────────────────────────────── */

/** „Datum do" = (datum + N meseci) − 1 dan; dan klampovan na poslednji dan meseca. */
export function ymdAddMonthsMinusDay(ymd: string, months: number): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  const idx = (m - 1) + months;
  const ty = y + Math.floor(idx / 12);
  const tm = ((idx % 12) + 12) % 12;
  const lastDay = new Date(ty, tm + 1, 0).getDate();
  const dt = new Date(ty, tm, Math.min(d, lastDay));
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** N meseci od datuma (bez klampa) — bulk „produži za N meseci". */
export function ymdAddMonths(ymd: string, months: number): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setMonth(dt.getMonth() + months);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** Broj meseci od→do (identično trajanjeCyr — natpis odgovara tekstu ugovora). */
export function contractMonths(fromIso: string, toIso: string): number | null {
  if (!fromIso || !toIso) return null;
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  if (!fy || !ty) return null;
  let months = (ty - fy) * 12 + (tm - fm);
  if (td >= fd) months += 1;
  return Math.max(1, months);
}

export function mesecWord(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  if (n === 1) return 'mesec';
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'meseca';
  return 'meseci';
}

/* ── Ćirilica: stepen spreme, trajanje, iznos ──────────────────────────── */

const SS_STEPEN_RECNIK: Record<string, string> = {
  i: 'првим', '1': 'првим', ii: 'другим', '2': 'другим', iii: 'трећим', '3': 'трећим',
  iv: 'четвртим', '4': 'четвртим', v: 'петим', '5': 'петим', vi: 'шестим', '6': 'шестим',
  vii: 'седмим', '7': 'седмим', viii: 'осмим', '8': 'осмим',
};
const MESEC_RECI = ['', 'један', 'два', 'три', 'четири', 'пет', 'шест', 'седам', 'осам', 'девет',
  'десет', 'једанаест', 'дванаест', 'тринаест', 'четрнаест', 'петнаест', 'шеснаест', 'седамнаест',
  'осамнаест', 'деветнаест', 'двадесет', 'двадесет један', 'двадесет два', 'двадесет три', 'двадесет четири'];

export function stepenSpremeCyr(educationLevel: string | null | undefined): string {
  const raw = String(educationLevel || '').trim();
  if (!raw) return '________ степеном';
  const key = raw.toLowerCase().replace(/[^iv0-9]/g, '').slice(0, 4);
  const word = SS_STEPEN_RECNIK[key];
  if (word) return `${word} степеном`;
  return `${toCyrillic(raw)} степеном`;
}

function mesecWordCyr(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  if (n === 1) return 'месец';
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'месеца';
  return 'месеци';
}

/** Trajanje za određeno („6 (шест) месеци"). Ulaz = ISO datumi. */
export function trajanjeCyr(dateFrom: string | null, dateTo: string | null): string {
  if (!dateFrom || !dateTo) return '________';
  const months = contractMonths(dateFrom, dateTo);
  if (!months) return '________';
  const rec = MESEC_RECI[months];
  const unit = mesecWordCyr(months);
  return rec ? `${months} (${rec}) ${unit}` : `${months} ${unit}`;
}

/** Bruto iznos „130.638,94 динара" (sr format). */
export function formatRsd(amount: number): string {
  const n = Number(amount || 0);
  const [intPart, dec] = n.toFixed(2).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${dec} динара`;
}

const MESECI_LAT = ['januar', 'februar', 'mart', 'april', 'maj', 'jun', 'jul', 'avgust',
  'septembar', 'oktobar', 'novembar', 'decembar'];
/** „jul 2026" za sporazumni raskid (mesec prestanka). Ulaz = ISO. */
export function mesecLat(iso: string): string {
  const m = Number(String(iso || '').slice(5, 7));
  const y = String(iso || '').slice(0, 4);
  return m >= 1 && m <= 12 ? `${MESECI_LAT[m - 1]} ${y}` : '________';
}

/* ── HR dokumenta: opis poslova + broj ─────────────────────────────────── */

/** responsibilities_md → ćir. stavke (skida markere liste/bold; max N). */
export function opisStavke(md: string | null | undefined, max = 12): string[] {
  if (!md) return [];
  return String(md).replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim())
    .filter(Boolean).slice(0, max).map(toCyrillic);
}

export function docBroj(prefix: string, year: number | string, seed: string): string {
  return `${prefix}-${year}-${String(seed || '').replace(/-/g, '').slice(0, 4).toUpperCase() || '0000'}`;
}

/** Maloletno lice na referentni ISO datum (rođenje + 18 > ref). */
export function isMinorAt(birthDate: string | null | undefined, refIso: string | null | undefined): boolean {
  if (!birthDate || !refIso) return false;
  const adultAt = new Date(birthDate);
  adultAt.setFullYear(adultAt.getFullYear() + 18);
  return new Date(refIso) < adultAt;
}

/** Prikaz imena zaposlenog za dokument (full_name je već „Ime Prezime"). */
export function empDocName(fullName: string | null | undefined): string {
  return String(fullName || '').trim();
}

/** Formatiran raspon trajanja ugovora za natpis („dd.mm — dd.mm · N meseci"). */
export function durationHint(fromIso: string, toIso: string): string {
  const n = contractMonths(fromIso, toIso);
  if (!n) return '';
  return `${n} ${mesecWord(n)} (${formatDate(fromIso)} – ${formatDate(toIso)})`;
}
