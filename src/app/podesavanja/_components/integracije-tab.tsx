'use client';

import Link from 'next/link';
import { Link2, RefreshCw, ArrowRight } from 'lucide-react';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import { useSyncLogs } from '@/api/sync';

// ============================================================================
// Podešavanja → Integracije — spoljni sistemi + platforma (paritet 1.0
// `integracijeTab.js`). KPI online/offline se izvodi iz zdravlja backend poziva
// (`GET /sync/log` kroz NestJS): uspeh = REST online. „Proveri konekciju” =
// refetch tog upita. Link ka postojećem `/syncs` ekranu (2.0 sync-status). Tabela
// integracija je statička (BigTehn/Auth/Resend/WhatsApp/MES — paritet 1.0 opis).
// ============================================================================

interface IntegRow {
  name: string;
  tone: Tone;
  label: string;
  note: string;
}

const INTEGRATIONS: IntegRow[] = [
  {
    name: 'BigTehn cache',
    tone: 'success',
    label: 'Aktivno',
    note: 'Predmeti, RN, mašine — read-only sync u 2.0 (vidi Sync status).',
  },
  {
    name: 'Supabase Auth (sy15)',
    tone: 'success',
    label: 'Aktivno',
    note: 'JWT + user_roles; invite/edit kroz Podešavanja → Korisnici.',
  },
  {
    name: 'Resend / email dispatch',
    tone: 'info',
    label: 'Po modulu',
    note: 'PB, Sastanci, HR, CMMS — Edge / dispatch funkcije.',
  },
  {
    name: 'WhatsApp (Meta)',
    tone: 'neutral',
    label: 'Opciono',
    note: 'HR / Sastanci — env secrets na Edge.',
  },
  {
    name: 'MES radni nalozi',
    tone: 'info',
    label: 'Samo čitanje',
    note: 'BigTehn radni nalozi — read-only kroz sync.',
  },
];

export function IntegracijeTab() {
  const q = useSyncLogs();

  // REST online = uspešan poziv kroz backend. Offline = greška/nedostupan.
  const online = q.isSuccess && !q.isError;
  const restTone: Tone = q.isLoading ? 'neutral' : online ? 'success' : 'warn';
  const restValue = q.isLoading ? 'Provera…' : online ? 'Online' : 'Offline';
  const restSub = q.isLoading ? 'Provera konekcije' : online ? 'REST odgovara (NestJS · sy15)' : 'REST nedostupan';

  const lastRun = Array.isArray(q.data) && q.data.length ? q.data[0] : null;

  async function checkConnection() {
    try {
      const r = await q.refetch();
      const ok = r.status === 'success' && !r.error;
      toast(ok ? '✅ REST online' : '⚠ REST nedostupan');
    } catch {
      toast('⚠ REST nedostupan');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Link2 className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Integracije</h2>
          <p className="text-xs text-ink-secondary">Spoljni sistemi i platforma</p>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="REST" value={restValue} sub={restSub} tone={restTone} />
        <Kpi
          label="Poslednji sync"
          value={lastRun ? syncStatusLabel(lastRun.status) : online ? 'Nema zapisa' : '—'}
          sub={lastRun?.finishedAt ? formatDateTime(lastRun.finishedAt) : lastRun?.startedAt ? formatDateTime(lastRun.startedAt) : 'BigTehn cache'}
          tone={lastRun ? syncStatusTone(lastRun.status) : 'neutral'}
        />
        <Kpi label="Platforma" value="Servosync 2.0" sub="NestJS · Prisma · sy15" tone="neutral" />
      </div>

      {/* Akcije */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void checkConnection()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? 'animate-spin' : ''}`} aria-hidden />
          Proveri konekciju
        </button>
        <Link
          href="/syncs"
          className="inline-flex items-center gap-1.5 text-sm text-accent underline underline-offset-2 hover:opacity-80"
        >
          Sync status (BigTehn) <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {/* Tabela integracija */}
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
              <th className="px-3 py-2">Integracija</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Napomena</th>
            </tr>
          </thead>
          <tbody>
            {INTEGRATIONS.map((r) => (
              <tr key={r.name} className="border-b border-line-soft">
                <td className="px-3 py-2 font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2">
                  <StatusBadge tone={r.tone} label={r.label} />
                </td>
                <td className="px-3 py-2 text-ink-secondary">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-disabled">
        Dijagnostika: tab Sistem. Notifikacije se podešavaju po modulu (tab Notifikacije).
      </p>
    </div>
  );
}

function syncStatusLabel(status: string): string {
  return { success: 'Uspešno', running: 'U toku', partial: 'Delimično', failed: 'Greška' }[status] ?? status;
}
function syncStatusTone(status: string): Tone {
  return ({ success: 'success', running: 'info', partial: 'warn', failed: 'danger' } as Record<string, Tone>)[status] ?? 'neutral';
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: Tone }) {
  const border =
    tone === 'success'
      ? 'border-status-success/40 bg-status-success-bg'
      : tone === 'warn'
        ? 'border-status-warn/40 bg-status-warn-bg'
        : tone === 'danger'
          ? 'border-status-danger/40 bg-status-danger-bg'
          : tone === 'info'
            ? 'border-status-info/40 bg-status-info-bg'
            : 'border-line bg-surface';
  return (
    <div className={`rounded-panel border px-3 py-2 ${border}`}>
      <div className="text-2xs uppercase text-ink-secondary">{label}</div>
      <div className="text-sm font-semibold text-ink">{value}</div>
      <div className="text-xs text-ink-secondary">{sub}</div>
    </div>
  );
}
