// Praćenje proizvodnje — efektivno stablo sa ručnim override-om roditelja (1:1 port
// 1.0 src/lib/pracenjeTree.js, Faza C v2). Deli se između tabele praćenja (ekran)
// i izvoza (XLSX/PDF) da svi prate isti (re-parentovan) raspored kao ekran.

import type { IzvestajRow } from '@/api/pracenje';

/** Ključ efektivnog roditelja: ručni override ako postoji, inače BigTehn parent. */
export function effParentKey(r: IzvestajRow): string | null {
  const has = r.has_parent_override === true;
  const p = has ? r.parent_override_rn_id : (r as { parent_node_id?: unknown }).parent_node_id;
  return p !== null && p !== undefined ? String(p) : null;
}

export interface ParentOverrideResult {
  rows: IzvestajRow[];
  parentIds: Set<string>;
}

/**
 * Primeni ručne override-e roditelja: re-sortiraj stablo i preračunaj nivo.
 * Bez ijednog override-a vraća originalni redosled (nula promene).
 */
export function applyParentOverrides(rowsAll: IzvestajRow[] | null | undefined): ParentOverrideResult {
  const list = Array.isArray(rowsAll) ? rowsAll : [];
  const idSet = new Set(list.map((r) => String(r.node_id)));
  const childrenOf = new Map<string, IzvestajRow[]>();
  for (const r of list) {
    let pk = effParentKey(r);
    if (pk === null || !idSet.has(pk)) pk = '__root__';
    if (!childrenOf.has(pk)) childrenOf.set(pk, []);
    childrenOf.get(pk)!.push(r);
  }
  const parentIds = new Set([...childrenOf.keys()].filter((k) => k !== '__root__'));
  const hadOverride = list.some((r) => r.has_parent_override === true);
  if (!hadOverride) return { rows: list, parentIds };

  const out: IzvestajRow[] = [];
  const visited = new Set<string>();
  const walk = (key: string, depth: number): void => {
    for (const r of childrenOf.get(key) || []) {
      const id = String(r.node_id);
      if (visited.has(id)) continue; // zaštita od ciklusa
      visited.add(id);
      out.push({ ...r, level: depth });
      walk(id, depth + 1);
    }
  };
  walk('__root__', 0);
  for (const r of list) {
    if (!visited.has(String(r.node_id))) out.push({ ...r, level: Number(r.level || 0) });
  }
  return { rows: out, parentIds };
}

/** Skup potomaka čvora (po efektivnom roditelju) — za zabranu ciklusa pri premeštanju. */
export function descendantsOf(rowsAll: IzvestajRow[] | null | undefined, nodeId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const r of rowsAll || []) {
    const pk = effParentKey(r);
    if (pk === null) continue;
    if (!childrenOf.has(pk)) childrenOf.set(pk, []);
    childrenOf.get(pk)!.push(String(r.node_id));
  }
  const desc = new Set<string>();
  const stack = [String(nodeId)];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf.get(cur) || []) {
      if (!desc.has(c)) {
        desc.add(c);
        stack.push(c);
      }
    }
  }
  return desc;
}

// ── Rollup % gotovosti + % mašinske obrade i vidljivost stabla (F3, docx §4.1/§4.3/
//    §4.4, odluka O5). Deljeno ekran (predmet-view) ↔ izvoz (pracenje-export). ──────

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Mapa efektivni_roditelj → deca (koristi ručni override roditelja, isto kao ekran). */
export function buildChildrenMap(rows: IzvestajRow[]): Map<string, IzvestajRow[]> {
  const idSet = new Set(rows.map((r) => String(r.node_id)));
  const childrenOf = new Map<string, IzvestajRow[]>();
  for (const r of rows) {
    let pk = effParentKey(r);
    if (pk === null || !idSet.has(pk)) pk = '__root__';
    if (!childrenOf.has(pk)) childrenOf.set(pk, []);
    childrenOf.get(pk)!.push(r);
  }
  return childrenOf;
}

/** Mapa čvor → efektivni roditelj (null za koren) — za predke i sklapanje. */
export function buildParentMap(rows: IzvestajRow[]): Map<string, string | null> {
  const idSet = new Set(rows.map((r) => String(r.node_id)));
  const parentOf = new Map<string, string | null>();
  for (const r of rows) {
    let pk = effParentKey(r);
    if (pk === null || !idSet.has(pk)) pk = null;
    parentOf.set(String(r.node_id), pk);
  }
  return parentOf;
}

export interface NodeRollup {
  /** % gotovosti = Σ efektivno_završeno / Σ lansirano (0–100) ili null (nema lansirano). */
  pct: number | null;
  /** % mašinske obrade = Σ masinska_done / Σ masinska_total (0–100) ili null. */
  masPct: number | null;
  /** true = list (pozicija bez podstabla) — % je sopstveni; inače rollup po podstablu. */
  isLeaf: boolean;
}

/**
 * Rollup po čvoru (odluka O5): list = sopstveno završeno/lansirano; sklop = ponderisan
 * količinom = Σ(završeno)/Σ(lansirano) po potomcima-listovima (ekvivalent proseku
 * pozicija ponderisanom lansiranom količinom — poklapa se sa Excel primerom iz docx-a).
 * % mašinske ide istim principom nad mašinskim brojiocima (BE `masinska_done/total`).
 * BE `zavrsena_kolicina` je već efektivno (override>auto, „kompletirano"→100%, klamp na
 * lansirano), pa auto-pravilo (docx §4.7) ulazi u % bez FE trika. Anti-ciklus guard
 * (re-parent override teorijski može da napravi petlju).
 */
export function computeRollups(rows: IzvestajRow[] | null | undefined): Map<string, NodeRollup> {
  const list = Array.isArray(rows) ? rows : [];
  const childrenOf = buildChildrenMap(list);
  const byId = new Map(list.map((r) => [String(r.node_id), r] as const));
  const agg = new Map<string, { zav: number; lans: number; masDone: number; masTot: number }>();
  const visiting = new Set<string>();

  const aggregate = (id: string): { zav: number; lans: number; masDone: number; masTot: number } => {
    const cached = agg.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { zav: 0, lans: 0, masDone: 0, masTot: 0 };
    visiting.add(id);
    const kids = childrenOf.get(id) ?? [];
    const a = { zav: 0, lans: 0, masDone: 0, masTot: 0 };
    if (kids.length > 0) {
      for (const k of kids) {
        const ka = aggregate(String(k.node_id));
        a.zav += ka.zav;
        a.lans += ka.lans;
        a.masDone += ka.masDone;
        a.masTot += ka.masTot;
      }
    } else {
      const r = byId.get(id);
      if (r) {
        const lans = Math.max(toNum(r.lansirana_kolicina) ?? 0, 0);
        const zav = Math.max(toNum(r.zavrsena_kolicina) ?? 0, 0);
        a.lans = lans;
        // O5 ponder je lansirana količina — list BEZ nje ne doprinosi rollup-u ni u
        // brojiocu (inače bi neklampovana ručna količina na poziciji sa null
        // lansiranom napumpala % roditelja; review nalaz). Sopstveni % tog lista je
        // ionako null (lans=0).
        a.zav = lans > 0 ? Math.min(zav, lans) : 0;
        const masTot = toNum(r.masinska_total);
        a.masTot = masTot != null && masTot > 0 ? masTot : 0;
        a.masDone =
          a.masTot > 0
            ? Math.min(Math.max(toNum(r.masinska_done) ?? 0, 0), a.masTot)
            : 0;
      }
    }
    visiting.delete(id);
    agg.set(id, a);
    return a;
  };

  const out = new Map<string, NodeRollup>();
  for (const r of list) {
    const id = String(r.node_id);
    const isLeaf = (childrenOf.get(id) ?? []).length === 0;
    const a = aggregate(id);
    const pct = a.lans > 0 ? Math.min(100, Math.round((100 * a.zav) / a.lans)) : null;
    const masPct = a.masTot > 0 ? Math.min(100, Math.round((100 * a.masDone) / a.masTot)) : null;
    out.set(id, { pct, masPct, isLeaf });
  }
  return out;
}

/** Skup svih predaka datih čvorova (prikaz konteksta sklopa pri filtriranju). */
export function collectAncestors(rows: IzvestajRow[], nodeIds: Set<string>): Set<string> {
  const parentOf = buildParentMap(rows);
  const out = new Set<string>();
  for (const start of nodeIds) {
    let cur = parentOf.get(start) ?? null;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      out.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  return out;
}

/** Redovi vidljivi posle sklapanja: red je skriven ako mu je BILO KOJI predak sklopljen. */
export function visibleRows(rows: IzvestajRow[], collapsed: Set<string> | null | undefined): IzvestajRow[] {
  if (!collapsed || collapsed.size === 0) return rows;
  const parentOf = buildParentMap(rows);
  const out: IzvestajRow[] = [];
  for (const r of rows) {
    let cur = parentOf.get(String(r.node_id)) ?? null;
    const guard = new Set<string>();
    let hidden = false;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      if (collapsed.has(cur)) {
        hidden = true;
        break;
      }
      cur = parentOf.get(cur) ?? null;
    }
    if (!hidden) out.push(r);
  }
  return out;
}
