/**
 * Reversi — perzistencija bulk-import sesija reversa (RC-55).
 *
 * Čuva poslednjih 5 uspešnih uvoza u browser `localStorage` (ključ
 * `reversi:importSessions`) da bi korisnik mogao da ih stornira (vrati u magacin)
 * iz `ImportRollbackDialog`. Sesije su per-browser (ne dele se između uređaja).
 * Port 1.0 `bulkImportModal.js` (importSession + loadImportSessions/save...).
 */

const KEY = 'reversi:importSessions';
const CAP = 5;

/** Jedna sesija izvršenog uvoza reversa. `docIds` = kreirani dokumenti (za storno). */
export interface ImportSession {
  id: string;
  finishedAt: string;
  docIds: string[];
  newCatalogIds: string[];
  ok: number;
  fail: number;
}

function isSession(v: unknown): v is ImportSession {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { docIds?: unknown }).docIds)
  );
}

/** Učitaj sesije (najnovija prva). Nevalidan/pokvaren storage → prazna lista. */
export function loadSessions(): ImportSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSession);
  } catch {
    return [];
  }
}

/** Prepiši celu listu (već ograničenu na CAP). Tiho ignoriši pun storage. */
export function saveSessions(arr: ImportSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(arr.slice(0, CAP)));
  } catch {
    /* localStorage pun / nedostupan — ignoriši */
  }
}

/** Dodaj novu sesiju na vrh (unshift) i zadrži samo poslednjih CAP. */
export function pushSession(session: ImportSession): void {
  const arr = loadSessions();
  arr.unshift(session);
  saveSessions(arr.slice(0, CAP));
}

/** Ukloni sesiju po id-u (posle uspešnog storna ili „Zaboravi"). */
export function removeSession(id: string): void {
  saveSessions(loadSessions().filter((s) => s.id !== id));
}

/** Kreiraj id za novu sesiju (timestamp + random sufiks). */
export function newSessionId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
