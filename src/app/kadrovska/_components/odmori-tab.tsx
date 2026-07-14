'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { generateVacationDecisionPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import {
  useVacationBalance,
  useRequests,
  useDirectory,
  useVacationApprove,
  useVacationVacreqApprove,
  useVacationReject,
  useVacationDelete,
  newClientEventId,
  type VacationRequest,
} from '@/api/kadrovska';
import { SummaryChips, sv, svNum } from './common';

const STATUS_TONE: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'warn', label: 'Na čekanju' },
  sef_approved: { tone: 'info', label: 'Odobrio šef (čeka HR)' },
  approved: { tone: 'success', label: 'Odobreno' },
  rejected: { tone: 'danger', label: 'Odbijeno' },
  canceled: { tone: 'neutral', label: 'Otkazano' },
};

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

export function OdmoriTab() {
  const { can } = useAuth();
  const canVacreq = can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE);
  const vacreqAdmin = can(PERMISSIONS.KADROVSKA_VACREQ_ADMIN);
  const canDecision = can(PERMISSIONS.KADROVSKA_ADMIN); // Rešenje = admin/poslovni_admin (1.0)

  const [year, setYear] = useState(new Date().getFullYear());
  const balanceQ = useVacationBalance({ year });
  const balance = balanceQ.data?.data ?? [];

  const dirQ = useDirectory();
  const nameMap = useMemo(() => {
    const m = new Map<string, { name: string; position: string }>();
    for (const r of dirQ.data?.data ?? []) {
      m.set(sv(r, 'id'), { name: sv(r, 'full_name'), position: sv(r, 'position') });
    }
    return m;
  }, [dirQ.data]);

  const balanceCols: Column<Record<string, unknown>>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => pick(r, ['full_name', 'employee_name', 'ime']) || '—' },
    { key: 'dep', header: 'Odeljenje', render: (r) => pick(r, ['department', 'odeljenje']) || '—' },
    { key: 'total', header: 'Ukupno (do danas)', align: 'right', numeric: true, render: (r) => pick(r, ['total_days', 'entitled_days', 'ukupno', 'earned_to_date']) || '—' },
    { key: 'used', header: 'Iskorišćeno', align: 'right', numeric: true, render: (r) => pick(r, ['used_days', 'iskorisceno', 'used']) || '—' },
    { key: 'remaining', header: 'Preostalo', align: 'right', numeric: true, render: (r) => <strong>{pick(r, ['remaining_days', 'preostalo', 'remaining']) || '—'}</strong> },
  ];

  const totalRemaining = balance.reduce((a, r) => a + svNum(r, 'remaining_days') + svNum(r, 'preostalo'), 0);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-ink">Stanje godišnjih odmora</h3>
          <label className="ml-auto flex items-center gap-2 text-sm text-ink-secondary">
            Godina
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value) || year)}
              className="h-8 w-24 rounded-control border border-line bg-surface px-2 text-sm"
            />
          </label>
        </div>
        <SummaryChips
          items={[
            { label: 'Zaposlenih', value: balance.length },
            { label: 'Ukupno preostalo (dana)', value: totalRemaining || '—' },
          ]}
        />
        <DataTable
          columns={balanceCols}
          rows={balance}
          rowKey={(r) => pick(r, ['id', 'employee_id']) || Math.random().toString()}
          loading={balanceQ.isLoading}
          empty={<EmptyState title="Nema podataka o GO" />}
        />
      </section>

      {canVacreq ? (
        <RequestsInbox nameMap={nameMap} vacreqAdmin={vacreqAdmin} canDecision={canDecision} />
      ) : (
        <p className="text-sm text-ink-secondary">
          Zahtevi za GO i odobravanje vidljivi su rukovodiocima sa pravom upravljanja zahtevima.
        </p>
      )}
    </div>
  );
}

function RequestsInbox({
  nameMap,
  vacreqAdmin,
  canDecision,
}: {
  nameMap: Map<string, { name: string; position: string }>;
  vacreqAdmin: boolean;
  canDecision: boolean;
}) {
  const reqQ = useRequests({}, true);
  const approve = useVacationApprove();
  const vacreqApprove = useVacationVacreqApprove();
  const reject = useVacationReject();
  const del = useVacationDelete();

  const bundle = reqQ.data?.data;
  const vac = bundle?.vacation ?? [];

  async function decision(r: VacationRequest) {
    const emp = nameMap.get(r.employeeId);
    const { blob, fileName } = await generateVacationDecisionPdf({
      imePrezime: emp?.name || r.employeeId,
      radnoMesto: emp?.position || '',
      godina: r.year,
      brojDana: r.daysCount,
      datumOd: formatDate(r.dateFrom),
      datumDo: formatDate(r.dateTo),
      datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
    });
    openBlob(blob);
    downloadBlob(blob, fileName);
  }

  const cols: Column<VacationRequest>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => nameMap.get(r.employeeId)?.name || r.employeeId.slice(0, 8) },
    { key: 'from', header: 'Od', render: (r) => formatDate(r.dateFrom) },
    { key: 'to', header: 'Do', render: (r) => formatDate(r.dateTo) },
    { key: 'days', header: 'Dana', align: 'right', numeric: true, render: (r) => r.daysCount },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = STATUS_TONE[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          {r.status === 'pending' && (
            <>
              <Button
                variant="secondary"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  (vacreqAdmin ? vacreqApprove : approve).mutate({ id: r.id, clientEventId: newClientEventId() })
                }
              >
                Odobri
              </Button>
              <Button variant="danger" className="h-7 px-2 text-xs" onClick={() => reject.mutate({ id: r.id })}>
                Odbij
              </Button>
            </>
          )}
          {r.status === 'sef_approved' && (
            <Button
              variant="secondary"
              className="h-7 px-2 text-xs"
              onClick={() => vacreqApprove.mutate({ id: r.id, clientEventId: newClientEventId() })}
            >
              Finalizuj (HR)
            </Button>
          )}
          {r.status === 'approved' && canDecision && (
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => decision(r)}>
              📄 Rešenje
            </Button>
          )}
          {r.status !== 'pending' && (
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => del.mutate({ id: r.id })}>
              Obriši
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-ink">Zahtevi za GO — za odobravanje</h3>
      <SummaryChips
        items={[
          { label: 'Godišnji odmor', value: vac.length },
          { label: 'Nadoknada', value: bundle?.makeup.length ?? 0 },
          { label: 'Plaćeno', value: bundle?.paidLeave.length ?? 0 },
          { label: 'Neplaćeno', value: bundle?.nop.length ?? 0 },
        ]}
      />
      <DataTable
        columns={cols}
        rows={vac}
        rowKey={(r) => r.id}
        loading={reqQ.isLoading}
        empty={<EmptyState title="Nema zahteva za GO" />}
      />
    </section>
  );
}
