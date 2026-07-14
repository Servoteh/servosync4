'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Collapsible sekcija profila (paritet 1.0 `<details>` kartica: ikona + naslov + badge). */
export function Section({
  icon,
  title,
  badge,
  defaultOpen = false,
  actions,
  children,
}: {
  icon?: string;
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-panel border border-line bg-surface">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-4 w-4 text-ink-secondary" aria-hidden /> : <ChevronRight className="h-4 w-4 text-ink-secondary" aria-hidden />}
          {icon && <span aria-hidden>{icon}</span>}
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {badge}
        </button>
        {open && actions}
      </div>
      {open && <div className="border-t border-line px-4 py-4">{children}</div>}
    </section>
  );
}

/** Mala mapa statusa GO/nadoknade → srpska labela (paritet 1.0 STATUS_LABEL). */
export const STATUS_LABEL: Record<string, string> = {
  pending: 'Na čekanju',
  sef_approved: 'Odobrio šef (čeka HR)',
  approved: 'Odobreno',
  rejected: 'Odbijeno',
  canceled: 'Otkazano',
  completed: 'Završeno',
  storniran: 'Stornirano',
};
export function statusLabel(s: string | null | undefined): string {
  return (s && STATUS_LABEL[s]) || s || '—';
}
export function statusTone(s: string | null | undefined): 'success' | 'warn' | 'danger' | 'neutral' | 'info' {
  switch (s) {
    case 'approved':
    case 'completed':
      return 'success';
    case 'rejected':
    case 'canceled':
    case 'storniran':
      return 'danger';
    case 'pending':
    case 'sef_approved':
      return 'warn';
    default:
      return 'neutral';
  }
}
