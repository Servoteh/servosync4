// Plan montaže — konstante (port 1:1 iz 1.0 src/lib/constants.js).
// Vrednosti su UGOVOR sa 1.0 (labele checkova, statusi, palete) — ne menjati bez
// svesne odluke; menjanje ovde znači odstupanje od 1.0 pariteta.

/** 4 statusa faze (index 0..3). */
export const STATUSES = ['Nije počelo', 'U toku', 'Završeno', 'Na čekanju'] as const;

/** 8 checkova spremnosti — PUNE labele (tooltip + kolone). */
export const CHECK_LABELS = [
  'Montažni crteži',
  'Mašinske komponente',
  'Gotova roba',
  'Vijčana roba',
  'Električni materijal',
  'Alati / oprema',
  'Termin potvrđen',
  'Dostupna ekipa',
] as const;

/** Kratke labele checkova (zaglavlja kolona). */
export const CHECK_SHORT = [
  'Crteži', 'Mašin.', 'Got.rob', 'Vijci', 'Elektro', 'Alati', 'Termin', 'Ekipa',
] as const;

export const NUM_CHECKS = CHECK_LABELS.length;

export const MONTHS_SR = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
] as const;

export const DEFAULT_LOCATIONS = ['Dobanovci', 'Kruševac'] as const;

/**
 * 15 standardnih faza koje se seeduju u NOVI nalog montaže (1.0 DEFAULT_PHASES,
 * src/lib/constants.js). Redosled je ugovor sa 1.0 — sortOrder = index u nizu.
 * Tip faze (mašinska/elektro) se izvodi iz naziva ("elektro" → electrical).
 */
export const DEFAULT_PHASES = [
  'Montaža agregata',
  'Elektro montaža agregata',
  'Montaža postolja prese sa cilindrima',
  'Montaža agregata na lokaciji naručioca',
  'Povezivanje agregata sa cilindrima',
  'Montaža na batu',
  'Elektro montaža bata',
  'Kompletiranje tela prese',
  'Montaža ruke podmazivanja',
  'Elektro montaža ruke podmazivanja',
  'Montaža ruke podmazivanja (2)',
  'Postavljanje robota',
  'Postavljanje agregata podmazivanja',
  'Postavljanje kanalica',
  'Elektro povezivanje kompletne prese',
] as const;

/** Paleta boja lokacija (Gantt trake + akcenti). 18 boja, pa deterministički hash fallback. */
export const LOC_PALETTE = [
  '#4da3ff', '#7ee787', '#ffa657', '#d2a8ff', '#f778ba', '#79c0ff',
  '#f0b429', '#56d4dd', '#ff8b5d', '#a5d6a7', '#ce93d8', '#ffcb6b',
  '#90caf9', '#ef9a9a', '#80cbc4', '#b39ddb', '#ffab91', '#c5e1a5',
] as const;

/** Boja prazne lokacije (1.0 getLocationColor fallback). */
export const LOC_EMPTY_COLOR = '#5a6578';

/** Debounce snimanja izmena faze (1.0 SAVE_DEBOUNCE_MS). */
export const SAVE_DEBOUNCE_MS = 700;

/**
 * Podrazumevani vođe montaže (1.0 VODJA_DEFAULT; prazan prvi element = „bez vođe").
 * ⚠️ 1.0 rough-edge: hardkodovano, ne iz Kadrovske. 2.0 „samo bolje": kasnije lookup
 * nad zaposlenima (AUDIT §4 #2). Za sada paritet.
 */
export const VODJA_DEFAULT = [
  '',
  'Miloš Oreščanin',
  'Vladan Radivojević',
  'Stefan Mirić',
  'Slaviša Babić',
  'Goran Mlađenović',
] as const;

/** Podrazumevani odgovorni inženjeri (1.0 ENGINEERS_DEFAULT). */
export const ENGINEERS_DEFAULT = [
  '',
  'Dejan Ćirković',
  'Đorđe Arsić',
  'Igor Voštić',
  'Jovan Papić',
  'Luka Talović',
  'Marko Stojanović',
  'Milan Milovanović',
  'Milan Stojadinović',
  'Milorad Jerotić',
  'Nebojša Milošević',
  'Nikola Aksentijević',
  'Pavle Ilić',
  'Slaviša Radosavljević',
  'Tatjana Gnjidić',
  'Vladan Pavlović',
  'Vuk Radivojević',
] as const;

// ── Statusi izveštaja montera (DB CHECK, 6 vrednosti — RAZLIČITA taksonomija od faza) ──

/** Kod → prikaz statusa izveštaja (1.0 STATUS_OPCIJE). */
export const IZVESTAJ_STATUS: Record<string, string> = {
  zavrseno: 'Završeno',
  delimicno: 'Delimično završeno',
  u_toku: 'U toku',
  ceka_materijal: 'Čeka materijal',
  ceka_potvrdu: 'Čeka potvrdu klijenta',
  dodatna_intervencija: 'Potrebna dodatna intervencija',
};

export const IZVESTAJ_STATUS_DEFAULT = 'u_toku';

/** Status izveštaja → StatusBadge tone (kanonska mapa DESIGN_SYSTEM §7). */
export const IZVESTAJ_STATUS_TONE: Record<string, 'success' | 'warn' | 'info' | 'neutral' | 'danger'> = {
  zavrseno: 'success',
  delimicno: 'warn',
  u_toku: 'info',
  ceka_materijal: 'warn',
  ceka_potvrdu: 'neutral',
  dodatna_intervencija: 'danger',
};

/** Dozvoljeni AI modeli za strukturiranje izveštaja (paritet BE allowlist). */
export const IZVESTAJ_AI_MODELI: { id: string; label: string; hint?: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'preporuka za fotke' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** Maks. broj fotki po izveštaju (1.0 IZV_MAX_FOTKE, paritet BE MONTAZA_MAX_SLIKE). */
export const IZVESTAJ_MAX_FOTKE = 16;
