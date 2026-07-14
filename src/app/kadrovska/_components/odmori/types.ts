import type { VacationEntitlement, EmployeeSafe } from '@/api/kadrovska';

type ViewRow = Record<string, unknown>;

export interface RosterEmp {
  id: string;
  name: string;
  position: string;
  department: string;
  team: string;
  isActive: boolean;
  email: string;
}

export interface BalanceRow {
  emp: RosterEmp;
  year: number;
  daysTotal: number;
  daysCarried: number;
  daysUsed: number;
  daysPlanned: number;
  daysCommitted: number;
  daysRemaining: number;
  daysRemainingAccrued: number;
  daysEarned: number | null;
  openingUsed: number;
  accrualModel: boolean;
  isAdvance: boolean;
  reviewFlag: string | null;
  advanceApproved: boolean;
  advanceNote: string;
  advanceApprovedBy: string;
  entId: string | null;
  ent: VacationEntitlement | null;
}

/** v_employees_safe red → RosterEmp (list ili directory izvor). */
export function toRosterEmp(r: EmployeeSafe | ViewRow): RosterEmp {
  const g = (k: string) => {
    const v = (r as ViewRow)[k];
    return v == null ? '' : String(v);
  };
  return {
    id: g('id'),
    name: g('full_name'),
    position: g('position'),
    department: g('department'),
    team: g('team'),
    isActive: (r as ViewRow).is_active !== false,
    email: g('email'),
  };
}
