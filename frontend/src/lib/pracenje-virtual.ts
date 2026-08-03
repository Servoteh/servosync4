// Praćenje proizvodnje — VIRTUELNI (ručno napravljen) sklop, zahtev 053/26 paket 2.
//
// Sklop koji NEMA radni nalog ni tehnologiju u sistemu nije red u `work_orders` — živi u
// app-owned tabeli `pracenje_virtuelni_sklopovi`, a u stablu praćenja se pojavljuje kao
// čvor sa NEGATIVNIM `node_id` (id 7 → node_id -7). Zahvaljujući tome ceo FE lanac
// (`pracenje-tree` mape/putanje/sklapanje, poredak, izvozi) radi bez ijedne izmene —
// jedan numerički prostor ključeva, disjunktan sa `work_orders.id` (SERIAL ≥ 1).
//
// ⚠️ Ogledalo BE fajla `backend/src/modules/pracenje/virtual-node.ts` — izmena ide u OBA.

import type { IzvestajRow } from '@/api/pracenje';

/** true = čvor je virtuelni sklop (app-owned), a NE `work_orders.id`. */
export function isVirtualNode(id: number | string | null | undefined): boolean {
  if (id === null || id === undefined || id === '') return false;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isFinite(n) && n < 0;
}

/** node_id (-7) → id ručnog sklopa u bazi (7). Definisano samo za virtuelne čvorove. */
export function virtualDbId(nodeId: number | string): number {
  return -Number(nodeId);
}

/**
 * Da li je RED izveštaja ručno napravljen sklop. Primaran izvor je BE zastavica
 * `is_virtual` (emituje je SVAKI red, i pravi i virtuelni); predznak `node_id` je
 * fallback za stari keširan odgovor bez te zastavice.
 */
export function rowIsVirtual(r: IzvestajRow): boolean {
  if (typeof r.is_virtual === 'boolean') return r.is_virtual;
  return isVirtualNode(r.node_id as number | string | null | undefined);
}

/** Tipovi ručnog sklopa (bedževi ekrana) — isti katalog kao BE DTO. */
export const VIRTUELNI_SKLOP_TIPOVI = [
  { v: 'glavni', label: 'Glavni sklop' },
  { v: 'pod', label: 'Podsklop' },
  { v: 'zav', label: 'Zav. sklop' },
] as const;
