'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useDirectory } from '@/api/kadrovska';
import { sv } from '../common';

// Deljeni primitivci za Razvoj/Razgovori/360 (paritet 1.0 planRazvojaTab/talksSection).

/* ── Label mape (1.0 services/devPlans.js + services/talks.js) ── */
export const DEV_CATEGORY_LABEL: Record<string, string> = {
  strucni: 'Stručni razvoj',
  sertifikat: 'Sertifikat / obuka',
  soft_skill: 'Soft-skill',
  liderstvo: 'Liderstvo',
  ostalo: 'Ostalo',
};
export const CATEGORY_ORDER = ['strucni', 'sertifikat', 'soft_skill', 'liderstvo', 'ostalo'];
export const PRIO_LABEL: Record<string, string> = { niska: 'Niska', srednja: 'Srednja', visoka: 'Visoka' };

export const DEV_PLAN_STATUS_LABEL: Record<string, string> = {
  nacrt: 'Nacrt',
  aktivan: 'Aktivan',
  zavrsen: 'Završen',
  arhiviran: 'Arhiviran',
};

export const TALK_TYPE_LABEL: Record<string, string> = {
  godisnji: 'Godišnji (učinak i zarada)',
  korektivni: 'Korektivni',
  jedan_na_jedan: '1-na-1',
  ostalo: 'Ostalo',
};
export const TALK_STATUS_LABEL: Record<string, string> = { nacrt: 'Nacrt', podeljen: 'Podeljen', potvrdjen: 'Potvrđen' };
export const RAISE_DECISION_LABEL: Record<string, string> = { da: 'Povećanje — DA', ne: 'Bez povećanja', odlozeno: 'Odloženo' };
export const CPLAN_STATUS_LABEL: Record<string, string> = {
  otvoren: 'Otvoren',
  u_toku: 'U toku',
  zatvoren_uspesno: 'Zatvoren — uspešno',
  zatvoren_neuspesno: 'Zatvoren — neuspešno',
};
export const MEASURE_STATUS_LABEL: Record<string, string> = {
  otvoreno: 'Otvoreno',
  u_toku: 'U toku',
  ispunjeno: 'Ispunjeno',
  neispunjeno: 'Neispunjeno',
};
export const A360_STATUS_LABEL: Record<string, string> = {
  draft: 'Nacrt',
  collecting: 'Prikupljanje',
  closed: 'Zatvorena',
  shared: 'Podeljena',
};

/* ── Imenik (directory) → mapa imena/pozicija ── */
export interface DirEntry {
  id: string;
  name: string;
  position: string;
  department: string;
  active: boolean;
  email: string;
}
export function useNameMap() {
  const dirQ = useDirectory();
  const rows = dirQ.data?.data ?? [];
  const list = useMemo<DirEntry[]>(
    () =>
      rows
        .map((r) => ({
          id: sv(r, 'id'),
          name: sv(r, 'full_name'),
          position: sv(r, 'position'),
          department: sv(r, 'department'),
          active: r['is_active'] !== false,
          email: sv(r, 'email'),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sr')),
    [rows],
  );
  const byId = useMemo(() => {
    const m = new Map<string, DirEntry>();
    for (const e of list) m.set(e.id, e);
    return m;
  }, [list]);
  const nm = (id: string | null | undefined) => (id ? byId.get(id)?.name || id.slice(0, 8) : '—');
  return { list, byId, nm, loading: dirQ.isLoading };
}

/* ── Native primitivci ── */
const inputCls =
  'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]';

export function DateField(props: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <input
      id={props.id}
      type="date"
      value={props.value || ''}
      onChange={(e) => props.onChange(e.target.value)}
      className={inputCls}
    />
  );
}

export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(inputCls, 'disabled:opacity-60', className)}
    >
      {children}
    </select>
  );
}

/** Izbor zaposlenog iz imenika (aktivni; opciono bez „mene"; blank opcija). */
export function EmployeeSelect({
  value,
  onChange,
  excludeId,
  blankLabel = '— izaberi —',
  disabled,
  includeInactive,
}: {
  value: string;
  onChange: (v: string) => void;
  excludeId?: string | null;
  blankLabel?: string;
  disabled?: boolean;
  includeInactive?: boolean;
}) {
  const { list } = useNameMap();
  const opts = list.filter((e) => (includeInactive || e.active) && e.id !== excludeId);
  return (
    <Select value={value} onChange={onChange} disabled={disabled}>
      <option value="">{blankLabel}</option>
      {opts.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </Select>
  );
}

/** Traka napretka 0–100% (paritet 1.0 progressBarHtml). */
export function ProgressBar({ pct, width = '100%' }: { pct: number | string | null | undefined; width?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const color = p >= 100 ? 'var(--status-success)' : p > 0 ? 'var(--accent)' : 'var(--line)';
  return (
    <div
      title={`${p}%`}
      style={{ width }}
      className="relative h-4 overflow-hidden rounded-full border border-line bg-surface-2"
    >
      <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
      <span className="absolute inset-0 grid place-items-center text-2xs font-semibold text-ink">{p}%</span>
    </div>
  );
}

/** Širi modal (ui-kit Dialog je fiksni max-w-lg; ovde biramo širinu za detalje/editore). */
export function WideModal({
  open,
  onClose,
  title,
  titleExtra,
  children,
  footer,
  maxWidth = '900px',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  titleExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        className="flex max-h-[92vh] w-full flex-col rounded-panel border border-line bg-surface shadow-xl"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          <div className="flex items-center gap-2">
            {titleExtra}
            <button onClick={onClose} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" aria-label="Zatvori">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Blok u dosijeu razvoja (naslov + sadržaj). */
export function DevBlock({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4 rounded-panel border border-line bg-surface-2/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Danas kao YYYY-MM-DD (lokalno). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
