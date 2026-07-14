'use client';

import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate } from '@/lib/format';
import {
  useCalendar,
  useCreatePreventiveWo,
  useTasksDue,
  type MaintMe,
  type ViewRow,
} from '@/api/odrzavanje';
import { deadlineTone, f } from './common';

/** Preventiva (due lista + kreiraj WO) + Kalendar rokova (IT/objekti/planovi). */
export function PreventivaTab({ me }: { me: MaintMe | undefined }) {
  const due = useTasksDue();
  const calendar = useCalendar();
  const createWo = useCreatePreventiveWo();
  const canCreate = me?.gates.canCreateWo ?? false;

  const dueRows = due.data?.data ?? [];
  const cal = calendar.data?.data;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Preventiva na redu</h2>
        {due.isError ? (
          <EmptyState title="Greška pri učitavanju" hint="Preventiva trenutno nije dostupna." />
        ) : dueRows.length === 0 ? (
          <EmptyState title="Nema preventive na redu" hint="Sve kontrole su u roku." />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                  <th className="h-9 px-4">Mašina</th>
                  <th className="px-4">Zadatak</th>
                  <th className="px-4">Rok</th>
                  <th className="px-4"></th>
                </tr>
              </thead>
              <tbody>
                {dueRows.map((r, i) => {
                  const taskId = f(r, 'task_id', 'id');
                  const nextDue = f(r, 'next_due_at', 'due_at', 'next_due', 'due_date');
                  return (
                    <tr key={taskId ?? i} className="border-b border-line-soft">
                      <td className="px-4 py-2 tnums text-ink">{f(r, 'machine_code') ?? '—'}</td>
                      <td className="px-4 py-2 text-ink">{f(r, 'title', 'task_title') ?? '—'}</td>
                      <td className="px-4 py-2">
                        {nextDue ? <StatusBadge tone={deadlineTone(nextDue)} label={formatDate(nextDue)} /> : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {canCreate && taskId && (
                          <Button variant="secondary" disabled={createWo.isPending} onClick={() => createWo.mutate({ id: taskId })}>
                            Kreiraj nalog
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Kalendar rokova</h2>
        {calendar.isLoading ? (
          <p className="py-4 text-sm text-ink-secondary">Učitavanje…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DeadlineCard title="Servisi vozila" rows={cal?.vehicleServiceDue ?? []} labelKeys={['name', 'asset_code', 'plate']} dateKeys={['next_due_at', 'due_at', 'due_date']} />
            <DeadlineCard title="Servisi IT/objekata" rows={cal?.assetServiceDue ?? []} labelKeys={['name', 'asset_code']} dateKeys={['next_due_at', 'due_at', 'due_date']} />
            <DeadlineCard title="IT oprema (licence/garancije)" rows={cal?.itAssets ?? []} labelKeys={['name', 'asset_code']} dateKeys={['license_expires_at', 'warranty_expires_at']} />
            <DeadlineCard title="Objekti (inspekcija/PP)" rows={cal?.facilities ?? []} labelKeys={['name', 'asset_code']} dateKeys={['inspection_due_at', 'fire_safety_due_at']} />
          </div>
        )}
      </section>
    </div>
  );
}

function DeadlineCard({ title, rows, labelKeys, dateKeys }: { title: string; rows: ViewRow[]; labelKeys: string[]; dateKeys: string[] }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <h3 className="mb-1.5 text-sm font-semibold text-ink">{title} <span className="text-ink-secondary">({rows.length})</span></h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">—</p>
      ) : (
        rows.slice(0, 12).map((r, i) => {
          const date = f(r, ...dateKeys);
          return (
            <div key={i} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
              <span className="text-ink">{f(r, ...labelKeys) ?? '—'}</span>
              {date ? <StatusBadge tone={deadlineTone(date)} label={formatDate(date)} /> : <span className="text-ink-secondary">—</span>}
            </div>
          );
        })
      )}
    </div>
  );
}
