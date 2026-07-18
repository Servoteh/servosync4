import type { VacationEntitlement } from '@/api/kadrovska';
import type { BalanceRow, RosterEmp } from './types';

type ViewRow = Record<string, unknown>;

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Merge roster × v_vacation_balance × vacation_entitlements u redove salda.
 * Port 1.0 vacationTab.computeRows: „Preostalo" = preneto + zarađeno-do-danas −
 * iskorišćeno − planirano (srazmerni akrual); iz view-a kad postoji, inače lokalno.
 */
export function computeBalanceRows(params: {
  roster: RosterEmp[];
  balances: ViewRow[];
  entitlements: VacationEntitlement[];
  year: number;
  statusFilter: 'active' | 'all';
  hiddenDepts: Set<string>;
  search: string;
}): BalanceRow[] {
  const { roster, balances, entitlements, year, statusFilter, hiddenDepts, search } = params;

  const entByEmp = new Map<string, VacationEntitlement>();
  for (const e of entitlements) if (e.year === year) entByEmp.set(e.employeeId, e);
  const balByEmp = new Map<string, ViewRow>();
  for (const b of balances) if (num(b.year) === year) balByEmp.set(String(b.employee_id), b);

  const q = search.trim().toLowerCase();
  const filtered = roster.filter((e) => {
    if (statusFilter === 'active' && !e.isActive) return false;
    if (hiddenDepts.has(e.department || '')) return false;
    if (q) {
      const hay = [e.name, e.department, e.team].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => a.name.localeCompare(b.name, 'sr'));

  return filtered.map((emp) => {
    const ent = entByEmp.get(emp.id) ?? null;
    const bal = balByEmp.get(emp.id) ?? null;
    const daysTotal = ent ? ent.daysTotal : num(bal?.days_total, 20);
    const daysCarried = ent ? num(ent.daysCarriedOver) : num(bal?.days_carried_over);
    const daysUsed = num(bal?.days_used);
    const daysPlanned = num(bal?.days_planned);
    const daysCommitted = num(bal?.days_committed);
    const daysEarned = bal?.days_earned == null ? (ent ? null : null) : num(bal.days_earned);
    const daysRemaining = daysTotal + daysCarried - daysUsed - daysPlanned;
    const daysRemainingAccrued = bal && bal.days_remaining_accrued != null
      ? num(bal.days_remaining_accrued)
      : daysCarried + (daysEarned != null ? daysEarned : daysTotal) - daysUsed - daysPlanned;
    const accrualModel = bal ? bal.accrual_model === true : (ent?.accrualModel ?? false);
    const openingUsed = bal ? num(bal.opening_used) : num(ent?.openingUsed);
    const isAdvance = bal ? bal.is_advance === true : false;

    return {
      emp,
      year,
      daysTotal,
      daysCarried,
      daysUsed,
      daysPlanned,
      daysCommitted,
      daysRemaining,
      daysRemainingAccrued,
      daysEarned,
      openingUsed,
      accrualModel,
      isAdvance,
      reviewFlag: ent?.reviewFlag ? String(ent.reviewFlag) : null,
      advanceApproved: ent ? !!ent.advanceApproved : false,
      advanceNote: ent?.advanceNote ?? '',
      advanceApprovedBy: ent?.advanceApprovedBy ?? '',
      entId: ent?.id ?? null,
      ent,
    };
  });
}
