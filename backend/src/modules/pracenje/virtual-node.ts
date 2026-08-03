/**
 * VIRTUELNI SKLOP — kodiranje id-ja čvora (zahtev 053/26, paket 2).
 *
 * Ručno napravljen sklop („sklop koji NEMA radni nalog ni tehnologiju") NIJE red u
 * `work_orders` — RN registar, numeracija i MRP ostaju netaknuti. Živi u app-owned
 * tabeli `pracenje_virtuelni_sklopovi`, a u stablu praćenja se pojavljuje kao čvor sa
 * NEGATIVNIM id-jem: virtuelni sklop `id = 7` je u API-ju `node_id = -7`.
 *
 * Zašto negativni id, a ne string prefiks („v7"): ceo lanac (SQL `path_idrn` int[],
 * `reparentNodes`, FE `pracenje-tree` mape/putanje/sklapanje, `pracenje_structure_overrides`
 * čije su OBE kolone goli `Int` bez FK-a) radi nad JEDNIM numeričkim prostorom ključeva.
 * Negativan opseg je disjunktan sa `work_orders.id` (SERIAL ≥ 1), pa se ništa ne menja
 * ni u tipovima ni u algoritmima — samo se dodaje čitanje predznaka.
 *
 * ⚠️ Ogledalo ovog fajla na FE je `frontend/src/lib/pracenje-virtual.ts` — izmena ide u OBA.
 */

/** true = čvor je virtuelni sklop (app-owned), a NE `work_orders.id`. */
export function isVirtualNode(id: number | null | undefined): boolean {
  return typeof id === "number" && Number.isFinite(id) && id < 0;
}

/** node_id (-7) → `pracenje_virtuelni_sklopovi.id` (7). Definisano samo za virtuelne čvorove. */
export function virtualDbId(nodeId: number): number {
  return -nodeId;
}

/** `pracenje_virtuelni_sklopovi.id` (7) → node_id (-7). */
export function virtualNodeId(dbId: number): number {
  return -dbId;
}

/** Dozvoljeni tipovi virtuelnog sklopa (isti bedževi kao ekran: glavni/pod/zav). */
export const VIRTUELNI_SKLOP_TIPOVI = ["glavni", "pod", "zav"] as const;
export type VirtuelniSklopTip = (typeof VIRTUELNI_SKLOP_TIPOVI)[number];
