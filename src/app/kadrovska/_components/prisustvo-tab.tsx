'use client';

import { useMemo, useState } from 'react';
import { QrCode, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';
import { generateBadgeSheetPdf, openBlob, downloadBlob, type BadgeItem } from '@/lib/hr-pdf';
import { useAttendanceNow, useAttendanceShadow, useDirectory } from '@/api/kadrovska';
import { SummaryChips, sv } from './common';

type ViewRow = Record<string, unknown>;
function pick(row: ViewRow, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

export function PrisustvoTab() {
  const { can } = useAuth();
  const canLive = can(PERMISSIONS.KADROVSKA_ATTENDANCE);
  const canShadow = can(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW);
  const [view, setView] = useState<'live' | 'shadow'>(canLive ? 'live' : 'shadow');
  const [badgeOpen, setBadgeOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
          {canLive && (
            <button
              onClick={() => setView('live')}
              className={`rounded-control px-3 py-1.5 text-sm font-medium ${view === 'live' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
            >
              ⏱ Uživo
            </button>
          )}
          {canShadow && (
            <button
              onClick={() => setView('shadow')}
              className={`rounded-control px-3 py-1.5 text-sm font-medium ${view === 'shadow' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
            >
              📊 Poređenje sa gridom
            </button>
          )}
        </div>
        {canShadow && (
          <Button className="ml-auto" variant="secondary" onClick={() => setBadgeOpen(true)}>
            <QrCode className="h-4 w-4" aria-hidden /> QR nalepnice
          </Button>
        )}
      </div>

      {view === 'live' && canLive && <LiveView />}
      {view === 'shadow' && canShadow && <ShadowView />}

      {badgeOpen && <BadgeDialog onClose={() => setBadgeOpen(false)} />}
    </div>
  );
}

function LiveView() {
  const q = useAttendanceNow(true);
  const rows = q.data?.data ?? [];

  const present = rows.filter((r) => /prisut|present|ulaz|in/i.test(pick(r, ['status', 'state']))).length;
  const cols: Column<ViewRow>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => pick(r, ['full_name', 'employee_name', 'ime']) || '—' },
    { key: 'dep', header: 'Odeljenje', render: (r) => pick(r, ['department', 'odeljenje']) || '—' },
    { key: 'status', header: 'Status', render: (r) => pick(r, ['status', 'state']) || '—' },
    {
      key: 'event',
      header: 'Poslednji događaj',
      render: (r) => {
        const ts = pick(r, ['event_ts', 'last_event_ts', 'ts']);
        return ts ? formatDateTime(ts) : '—';
      },
    },
    { key: 'terminal', header: 'Terminal', render: (r) => pick(r, ['terminal', 'device', 'reader']) || '—' },
  ];

  return (
    <div className="space-y-3">
      <SummaryChips items={[{ label: 'Prisutno', value: present }, { label: 'Ukupno praćeno', value: rows.length }]} />
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => pick(r, ['employee_id', 'id']) || pick(r, ['full_name']) || Math.random().toString()}
        loading={q.isLoading}
        empty={<EmptyState title="Nema podataka o prisustvu" hint="Kiosk/kapija još nisu poslali događaje danas." />}
      />
    </div>
  );
}

function ShadowView() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const q = useAttendanceShadow({ year, month }, true);
  const rows = q.data?.data ?? [];

  const cols: Column<ViewRow>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => pick(r, ['full_name', 'employee_name']) || '—' },
    { key: 'dep', header: 'Odeljenje', render: (r) => pick(r, ['department', 'odeljenje']) || '—' },
    { key: 'cmp', header: 'Poredivih dana', align: 'right', numeric: true, render: (r) => pick(r, ['comparable_days', 'poredivih_dana', 'days']) || '—' },
    { key: 'dev', header: 'Odstupanja', align: 'right', numeric: true, render: (r) => pick(r, ['deviations', 'odstupanja', 'mismatch_days']) || '—' },
    { key: 'nogrid', header: 'Bez grida', align: 'right', numeric: true, render: (r) => pick(r, ['missing_grid_days', 'bez_grida']) || '—' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="month"
          value={`${year}-${String(month).padStart(2, '0')}`}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number);
            if (y && m) {
              setYear(y);
              setMonth(m);
            }
          }}
          className="h-9 rounded-control border border-line bg-surface px-3 text-sm"
        />
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => pick(r, ['employee_id', 'id']) || Math.random().toString()}
        loading={q.isLoading}
        empty={<EmptyState title="Nema poređenja prisustva sa gridom" />}
      />
    </div>
  );
}

function BadgeDialog({ onClose }: { onClose: () => void }) {
  const dirQ = useDirectory();
  const all = dirQ.data?.data ?? [];
  const deps = useMemo(() => Array.from(new Set(all.map((r) => sv(r, 'department')).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sr')), [all]);
  const [dep, setDep] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = dep ? all.filter((r) => sv(r, 'department') === dep) : all;

  async function generate() {
    setBusy(true);
    try {
      const items: BadgeItem[] = selected.map((r) => ({ name: sv(r, 'full_name'), dep: sv(r, 'department'), code: sv(r, 'id') }));
      const { blob, fileName } = await generateBadgeSheetPdf(items);
      openBlob(blob);
      downloadBlob(blob, fileName);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="🏷 QR nalepnice za kiosk (kapija)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={generate} loading={busy} disabled={selected.length === 0}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Generiši QR + PDF
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          Odeljenje (pilot grupa)
          <select
            value={dep}
            onChange={(e) => setDep(e.target.value)}
            className="mt-1 h-9 w-full rounded-control border border-line bg-surface px-3 text-sm"
          >
            <option value="">— svi aktivni —</option>
            {deps.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-ink-secondary">{selected.length} zaposlenih u izboru</p>
        <p className="text-xs text-ink-secondary">
          QR kodira stabilni identifikator zaposlenog (kiosk-punch ga razrešava). Trajni „SVK-" token po zaposlenom
          čeka BE rutu <code>employee_badges</code> (get-or-create) — vidi napomenu u kodu.
        </p>
      </div>
    </Dialog>
  );
}
