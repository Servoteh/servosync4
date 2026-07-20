// ============================================================================
// Praćenje proizvodnje — RN ekran (ekran 3) helperi (čiste funkcije).
// Port 1.0: pageHeader.js (formatKkQty, countLate) + tab1Pozicije.js
// (computeOpChips, buildTree). Wire format = get_pracenje_rn positions/operations.
// „Usko grlo" = prva nezavršena operacija u redosledu (samo jedna).
// ============================================================================

import type { Primopredaja } from '@/api/pracenje';

/** Sirova operacija iz get_pracenje_rn positions[].operations[]. */
export interface RnOperacija {
  tp_operacija_id?: string | number | null;
  operacija_kod?: string | null;
  naziv?: string | null;
  work_center?: string | null;
  planirano_komada?: number | string | null;
  prijavljeno_komada?: number | string | null;
  status?: string | null;
  poslednja_prijava_at?: string | null;
  /** docx §4.9: datum završetka operacije (poslednji DOBAR/završen ZK) — ISO / null. */
  completed_at?: string | null;
  is_final_control?: boolean;
  source?: string | null;
  bigtehn_work_order_id?: number | string | null;
  operacija_broj?: number | string | null;
  machine_code?: string | null;
  [k: string]: unknown;
}

/** Sirova pozicija iz get_pracenje_rn positions[]. */
export interface RnPozicija {
  id?: string | number | null;
  parent_id?: string | number | null;
  sifra_pozicije?: string | null;
  naziv?: string | null;
  kolicina_plan?: number | string | null;
  progress_pct?: number | null;
  drawing_no?: string | null;
  has_crtez_file?: boolean;
  operations?: RnOperacija[];
  [k: string]: unknown;
}

/** RN header (get_pracenje_rn.header). */
export interface RnHeader {
  radni_nalog_id?: string | null;
  rn_broj?: string | null;
  masina_linija?: string | null;
  radni_nalog_naziv?: string | null;
  /** = projects.id (== `?predmet=` itemId; O1 predmet_aktivacije.project_id) — za „Nazad" u tabelu. */
  projekat_id?: number | string | null;
  projekat_naziv?: string | null;
  kupac?: string | null;
  datum_isporuke?: string | null;
  koordinator?: string | null;
  napomena?: string | null;
  /** docx §4.10: dokument primopredaje (zamena za „rok izrade" u RN pogledu; null = nema). */
  primopredaja?: Primopredaja | null;
  [k: string]: unknown;
}

/** RN summary (get_pracenje_rn.summary). */
export interface RnSummary {
  pozicija_total?: number | null;
  operacija_total?: number | null;
  nije_krenulo?: number | null;
  u_toku?: number | null;
  zavrseno?: number | null;
  blokirano?: number | null;
  lansirana_kolicina?: number | string | null;
  zavrsena_kolicina_kk?: number | string | null;
  [k: string]: unknown;
}

function fmtQty(v: unknown): string | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

/** „X / Y" završena/lansirana količina iz KK (1.0 formatKkQty). */
export function formatKkQty(summary: RnSummary | undefined): string {
  const s = summary ?? {};
  const y = fmtQty(s.lansirana_kolicina);
  const x = fmtQty(s.zavrsena_kolicina_kk);
  if (x == null && y == null) return '—';
  if (x == null) return `— / ${y}`;
  if (y == null) return x;
  return `${x} / ${y}`;
}

/** Broj aktivnosti operativnog plana koje kasne (1.0 countLate). */
export function countLate(activities: Array<{ kasni?: boolean }>): number {
  return (activities ?? []).filter((a) => a.kasni).length;
}

export interface OpChip {
  op: RnOperacija;
  idx: number;
  status: string;
  pct: number;
  isFinal: boolean;
  isBottleneck: boolean;
}

/**
 * Čipovi operacija (DOSLOVNO 1.0 computeOpChips): pct po prijavljeno/planirano;
 * bottleneck = PRVA operacija koja nije „zavrseno" (samo jedna).
 */
export function computeOpChips(operations: RnOperacija[] | undefined): OpChip[] {
  const ops = Array.isArray(operations) ? operations : [];
  let bottleneckMarked = false;
  return ops.map((op, idx) => {
    const planned = Number(op.planirano_komada);
    const done = Number(op.prijavljeno_komada ?? 0);
    let pct: number;
    if (Number.isFinite(planned) && planned > 0) pct = Math.max(0, Math.min(100, Math.round((done / planned) * 100)));
    else pct = done > 0 ? 100 : 0;
    const status = String(op.status ?? 'nije_krenulo');
    const isBottleneck = !bottleneckMarked && status !== 'zavrseno';
    if (isBottleneck) bottleneckMarked = true;
    return { op, idx, status, pct, isFinal: !!op.is_final_control, isBottleneck };
  });
}

export interface RnTreeNode {
  item: RnPozicija;
  children: RnTreeNode[];
}

/** Hijerarhija pozicija po parent_id (1.0 buildTree). */
export function buildRnTree(positions: RnPozicija[]): RnTreeNode[] {
  const nodes = new Map<string, RnTreeNode>();
  for (const p of positions ?? []) nodes.set(String(p.id), { item: p, children: [] });
  const roots: RnTreeNode[] = [];
  nodes.forEach((node) => {
    const parentId = node.item.parent_id;
    const pk = parentId == null ? '' : String(parentId);
    if (pk && nodes.has(pk)) nodes.get(pk)!.children.push(node);
    else roots.push(node);
  });
  return roots;
}

export function shortName(name: unknown, len = 22): string {
  const s = String(name ?? '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

// ---------------------------------------------------------------- Filteri pozicija (docx §4.10)

/** Tri-stanje DA/NE filter: sve · samo DA · samo NE. */
export type PozicijeDaNe = 'all' | 'da' | 'ne';

export interface PozicijeFilter {
  /** Pretraga po poziciji: šifra / naziv / broj crteža. */
  search: string;
  /** Mašinska obrada DA/NE. */
  masinska: PozicijeDaNe;
  /** Površinska zaštita DA/NE. */
  povrsinska: PozicijeDaNe;
}

export const EMPTY_POZICIJE_FILTER: PozicijeFilter = { search: '', masinska: 'all', povrsinska: 'all' };

export function isPozicijeFilterActive(f: PozicijeFilter): boolean {
  return f.search.trim() !== '' || f.masinska !== 'all' || f.povrsinska !== 'all';
}

// Klasifikacija operacija za DA/NE filtere. NAPOMENA: get_pracenje_rn op_payload NE nosi
// `without_process` (za razliku od izvestaj redova koji njime dele mašinsku/površinsku), pa je
// klasifikacija ovde IMENSKA heuristika nad nazivom radnog centra (best-effort, prati duh O5):
// kontrola se isključuje, površinska zaštita se prepoznaje po ključnim rečima presvlake/premaza,
// a mašinska = svaka preostala (ne-kontrolna, ne-površinska) operacija.
const CONTROL_RE = /kontrol/i;
const SURFACE_RE =
  /galvan|cink|pocink|plastif|eloks|anodiz|hrom|nikl|farb|bojen|lakir|praškas|praskas|prašen|prasen|premaz|presvlač|presvlac|fosfat|brunir|termičk|termick|zaštit|zastit/i;

function opText(o: RnOperacija): string {
  return `${o.naziv ?? ''} ${o.work_center ?? ''} ${o.operacija_kod ?? ''}`;
}
function isControlOp(o: RnOperacija): boolean {
  return o.is_final_control === true || CONTROL_RE.test(opText(o));
}
function isSurfaceOp(o: RnOperacija): boolean {
  return o.is_final_control !== true && SURFACE_RE.test(opText(o));
}
function isMachiningOp(o: RnOperacija): boolean {
  return !isControlOp(o) && !isSurfaceOp(o);
}

export function positionHasMachining(p: RnPozicija): boolean {
  return (p.operations ?? []).some(isMachiningOp);
}
export function positionHasSurface(p: RnPozicija): boolean {
  return (p.operations ?? []).some(isSurfaceOp);
}

function positionSearchText(p: RnPozicija): string {
  return `${p.sifra_pozicije ?? ''} ${p.naziv ?? ''} ${p.drawing_no ?? ''}`.toLowerCase();
}
function matchesDaNe(has: boolean, want: PozicijeDaNe): boolean {
  return want === 'all' || (want === 'da' ? has : !has);
}

/**
 * Filtriraj pozicije po pretrazi / mašinskoj / površinskoj. Da bi stablo (`buildRnTree`)
 * ostalo koherentno, zadržava se i CEO lanac predaka svakog pogotka (predak se prikazuje kao
 * kontekst i kad sam ne zadovoljava filter). Bez aktivnog filtera vraća ulaz netaknut.
 */
export function filterRnPositions(positions: RnPozicija[], f: PozicijeFilter): RnPozicija[] {
  if (!isPozicijeFilterActive(f)) return positions;
  const q = f.search.trim().toLowerCase();
  const byId = new Map<string, RnPozicija>();
  for (const p of positions) byId.set(String(p.id), p);

  const matches = (p: RnPozicija): boolean => {
    if (q && !positionSearchText(p).includes(q)) return false;
    if (!matchesDaNe(positionHasMachining(p), f.masinska)) return false;
    if (!matchesDaNe(positionHasSurface(p), f.povrsinska)) return false;
    return true;
  };

  const keep = new Set<string>();
  for (const p of positions) {
    if (!matches(p)) continue;
    // Popni se uz lanac predaka (guard od ciklusa kroz lokalni `seen`).
    let cur: RnPozicija | undefined = p;
    const seen = new Set<string>();
    while (cur) {
      const id = String(cur.id);
      if (seen.has(id)) break;
      seen.add(id);
      keep.add(id);
      const pid: string | null = cur.parent_id == null ? null : String(cur.parent_id);
      cur = pid ? byId.get(pid) : undefined;
    }
  }
  return positions.filter((p) => keep.has(String(p.id)));
}
