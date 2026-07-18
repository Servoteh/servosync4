// Reversi „Mapa (rezni)" — čist compute (paritet 1.0 `revMapaCompute.js`), bez DOM-a
// i bez React-a → testabilno i deljivo. Ulazi su camelCase (2.0 payload oblici):
// dokumenti = ReversiDocument, mašine = MachineRow, katalog = CuttingTool.

const MS_DAY = 86400000;

/** Lokalni 'YYYY-MM-DD' — `toISOString()` bi dao UTC dan (Beograd +1/+2) pa bi rok
 *  grešio za 1 dan oko ponoći (ista definicija „danas" kao 1.0). */
function todayLocalStr(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export interface AgingDoc {
  issuedAt: string | null;
  expectedReturnDate: string | null;
}

export interface AgingBuckets {
  fresh: number;
  aging: number;
  overdue: number;
  total: number;
}

/**
 * Aging zaduženja (RA-48) — 3 kofe: Sveže (≤7 d), Stari (8–30 d), Prekoračeni
 * (rok prošao ili >30 d). Paritet 1.0 `computeAgingBuckets`.
 */
export function computeAgingBuckets(documents: AgingDoc[]): AgingBuckets {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const todayStr = todayLocalStr();
  let fresh = 0;
  let aging = 0;
  let overdue = 0;
  for (const d of documents || []) {
    const exp = d.expectedReturnDate ? String(d.expectedReturnDate).slice(0, 10) : null;
    if (exp && exp < todayStr) {
      overdue += 1;
      continue;
    }
    const issued = d.issuedAt ? new Date(d.issuedAt) : null;
    if (!issued || Number.isNaN(issued.getTime())) {
      aging += 1;
      continue;
    }
    const days = Math.floor((todayMs - issued.getTime()) / MS_DAY);
    if (days <= 7) fresh += 1;
    else if (days <= 30) aging += 1;
    else overdue += 1;
  }
  return { fresh, aging, overdue, total: fresh + aging + overdue };
}

export interface MachineLoadDoc {
  machineCode: string | null;
  /** Šifra reznog na mašini — SAMO iz `v_rev_cts_by_machine` (doc UUID bi duplo brojao). */
  catalogId?: string | null;
  expectedReturnDate?: string | null;
}

export interface MachineNameRow {
  machine_code: string;
  name?: string | null;
}

export interface MachineLoadCard {
  machineCode: string;
  machineName: string;
  symbolCount: number;
  fillPct: number;
  overdueCount: number;
}

/**
 * Kartice popunjenosti mašina (RA-47) — broj RAZLIČITIH šifri po mašini, popunjenost
 * % (kapacitet 20) i broj prekoračenih. Paritet 1.0 `computeMachineLoadCards`.
 */
export function computeMachineLoadCards(
  documents: MachineLoadDoc[],
  machines: MachineNameRow[],
  opts: { capacity?: number } = {},
): MachineLoadCard[] {
  const cap = Number(opts.capacity) > 0 ? Number(opts.capacity) : 20;
  const today = todayLocalStr();
  const symByMc = new Map<string, Set<string>>();
  const overdueByMc = new Map<string, number>();

  for (const d of documents || []) {
    const mc = d.machineCode;
    if (!mc) continue;
    if (d.expectedReturnDate && String(d.expectedReturnDate).slice(0, 10) < today) {
      overdueByMc.set(mc, (overdueByMc.get(mc) || 0) + 1);
    }
  }

  for (const row of documents || []) {
    const mc = row.machineCode;
    if (!mc) continue;
    const cat = row.catalogId;
    if (!symByMc.has(mc)) symByMc.set(mc, new Set());
    if (cat) symByMc.get(mc)!.add(String(cat));
  }

  const nameByCode = new Map<string, string>();
  for (const m of machines || []) {
    if (m.machine_code) nameByCode.set(m.machine_code, m.name || '');
  }

  const codes = new Set<string>([
    ...symByMc.keys(),
    ...(documents || []).map((d) => d.machineCode).filter((c): c is string => !!c),
  ]);
  return Array.from(codes)
    .map((machineCode): MachineLoadCard | null => {
      const symbolCount = symByMc.get(machineCode)?.size || 0;
      if (symbolCount === 0) return null;
      const fillPct = Math.min(100, Math.round((symbolCount / cap) * 100));
      return {
        machineCode,
        machineName: nameByCode.get(machineCode) || '',
        symbolCount,
        fillPct,
        overdueCount: overdueByMc.get(machineCode) || 0,
      };
    })
    .filter((c): c is MachineLoadCard => c !== null)
    .sort((a, b) => b.symbolCount - a.symbolCount);
}

export interface LowStockCatalog {
  id: string;
  oznaka: string;
  naziv: string;
  status: string;
  minStockQty: number;
  inWarehouseQty: number;
}

export interface LowStockRow {
  id: string;
  oznaka: string;
  naziv: string;
  qty: number;
  min: number;
}

/**
 * Top 10 niskih stanja (RA-49) — aktivne šifre ispod minimuma, sortirano po odnosu
 * qty/min (najkritičnije prvo). Paritet 1.0 `computeLowStockTop10`.
 */
export function computeLowStockTop10(catalog: LowStockCatalog[]): LowStockRow[] {
  return (catalog || [])
    .filter((r) => {
      const min = Number(r.minStockQty) || 0;
      const wh = Number(r.inWarehouseQty) || 0;
      return r.status === 'active' && min > 0 && wh < min;
    })
    .map((r) => ({
      id: r.id,
      oznaka: r.oznaka,
      naziv: r.naziv,
      qty: Number(r.inWarehouseQty) || 0,
      min: Number(r.minStockQty) || 0,
    }))
    .sort((a, b) => a.qty / a.min - b.qty / b.min)
    .slice(0, 10);
}
