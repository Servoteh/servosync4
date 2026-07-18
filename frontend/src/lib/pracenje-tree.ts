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
