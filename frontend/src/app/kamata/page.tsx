'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Tabs } from '@/components/ui-kit/tabs';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useInterestRates,
  useCreateInterestRate,
  useComputeInterest,
  type InterestRate,
  type InterestCalcLine,
  type InterestCalculation,
} from '@/api/kamata';

/**
 * Kamata (obračun zatezne kamate). Dva pogleda (Tabs): „Obračun" (partner + datum →
 * kamatni list nad otvorenim dospelim stavkama) i „Stope" (registar kamatnih stopa +
 * unos nove). Data kroz `@/api/kamata` hooks; kit komponente + tokeni.
 */
type View = 'obracun' | 'stope';

const TABS = [
  { key: 'obracun' as const, label: 'Obračun' },
  { key: 'stope' as const, label: 'Kamatne stope' },
];

const lineColumns: Column<InterestCalcLine>[] = [
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (l) => <span className="tnums text-ink-secondary">{l.documentNumber ?? '—'}</span>,
  },
  {
    key: 'principal',
    header: 'Osnovica',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.principal)}</span>,
  },
  {
    key: 'dueDate',
    header: 'Dospeće',
    render: (l) => <span className="text-ink-secondary">{formatDate(l.dueDate)}</span>,
  },
  {
    key: 'daysOverdue',
    header: 'Dana',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{l.daysOverdue}</span>,
  },
  {
    key: 'ratePct',
    header: 'Stopa %',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{formatDecimal(l.ratePct)}</span>,
  },
  {
    key: 'interest',
    header: 'Kamata',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums font-semibold text-ink">{formatDecimal(l.interest)}</span>,
  },
];

const rateColumns: Column<InterestRate>[] = [
  { key: 'kind', header: 'Vrsta', render: (r) => <span className="text-ink">{r.kind}</span> },
  {
    key: 'ratePct',
    header: 'Stopa % (god.)',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.ratePct)}</span>,
  },
  { key: 'validFrom', header: 'Važi od', render: (r) => <span className="text-ink-secondary">{formatDate(r.validFrom)}</span> },
  {
    key: 'validTo',
    header: 'Važi do',
    render: (r) => <span className="text-ink-secondary">{r.validTo ? formatDate(r.validTo) : 'do daljeg'}</span>,
  },
];

export default function KamataPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View>('obracun');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Obračun
  const [partnerId, setPartnerId] = useState('');
  const [kind, setKind] = useState('zatezna');
  const [method, setMethod] = useState('proporcionalni');
  const [calcDate, setCalcDate] = useState(() => new Date().toISOString().slice(0, 10));
  const compute = useComputeInterest();
  const [result, setResult] = useState<InterestCalculation | null>(null);

  // Stope
  const rates = useInterestRates();
  const createRate = useCreateInterestRate();
  const [newKind, setNewKind] = useState('zatezna');
  const [newRate, setNewRate] = useState('');
  const [newFrom, setNewFrom] = useState(() => new Date().toISOString().slice(0, 10));

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const runCompute = () => {
    const pid = Number(partnerId);
    if (!(pid > 0)) return;
    compute.mutate(
      { partnerId: pid, kind, method, calcDate },
      { onSuccess: (r) => setResult(r) },
    );
  };

  const addRate = () => {
    const r = Number(newRate);
    if (!(r >= 0)) return;
    createRate.mutate(
      { kind: newKind, ratePct: r, validFrom: newFrom },
      { onSuccess: () => setNewRate('') },
    );
  };

  const computeErr = (compute.error as Error | null)?.message ?? null;
  const rateErr = (createRate.error as Error | null)?.message ?? null;

  return (
    <AppShell>
      <PageHeader title="Obračun kamate" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={TABS} value={view} onChange={setView} ariaLabel="Kamata pogledi" />

        {view === 'obracun' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-36">
                <FormField label="Komitent (#)" required>
                  <Input type="number" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="komitent #" />
                </FormField>
              </div>
              <div className="w-36">
                <FormField label="Vrsta">
                  <Select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    options={[
                      { value: 'zatezna', label: 'Zatezna' },
                      { value: 'ugovorna', label: 'Ugovorna' },
                    ]}
                  />
                </FormField>
              </div>
              <div className="w-40">
                <FormField label="Metod">
                  <Select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    options={[
                      { value: 'proporcionalni', label: 'Proporcionalni' },
                      { value: 'konformni', label: 'Konformni' },
                    ]}
                  />
                </FormField>
              </div>
              <div className="w-44">
                <FormField label="Na dan">
                  <Input type="date" value={calcDate} onChange={(e) => setCalcDate(e.target.value)} />
                </FormField>
              </div>
              <Button onClick={runCompute} loading={compute.isPending} disabled={!partnerId}>
                Obračunaj
              </Button>
            </div>

            {computeErr && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
                {computeErr}
              </div>
            )}

            {result && (
              <div className="space-y-3">
                <div className="flex gap-6 text-sm">
                  <span className="text-ink-secondary">
                    Σ osnovica: <span className="tnums text-ink">{formatDecimal(result.totalPrincipal)}</span>
                  </span>
                  <span className="text-ink-secondary">
                    Σ kamata:{' '}
                    <span className="tnums font-semibold text-status-warn">
                      {formatDecimal(result.totalInterest)}
                    </span>
                  </span>
                </div>
                <DataTable columns={lineColumns} rows={result.lines} rowKey={(l) => l.id} />
              </div>
            )}
            {!result && !computeErr && (
              <EmptyState
                title="Kamatni list"
                hint="Unesi komitenta i dan obračuna pa klikni Obračunaj — kamata se računa nad otvorenim dospelim stavkama."
              />
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-36">
                <FormField label="Vrsta">
                  <Select
                    value={newKind}
                    onChange={(e) => setNewKind(e.target.value)}
                    options={[
                      { value: 'zatezna', label: 'Zatezna' },
                      { value: 'ugovorna', label: 'Ugovorna' },
                      { value: 'eskontna', label: 'Eskontna' },
                    ]}
                  />
                </FormField>
              </div>
              <div className="w-32">
                <FormField label="Stopa % (god.)" required>
                  <Input type="number" step="0.0001" value={newRate} onChange={(e) => setNewRate(e.target.value)} />
                </FormField>
              </div>
              <div className="w-44">
                <FormField label="Važi od" required>
                  <Input type="date" value={newFrom} onChange={(e) => setNewFrom(e.target.value)} />
                </FormField>
              </div>
              <Button variant="secondary" onClick={addRate} loading={createRate.isPending} disabled={!newRate}>
                Dodaj stopu
              </Button>
            </div>

            {rateErr && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
                {rateErr}
              </div>
            )}

            <DataTable
              columns={rateColumns}
              rows={rates.data?.data ?? []}
              rowKey={(r) => r.id}
              loading={rates.isLoading}
              empty={<EmptyState title="Nema definisanih stopa" hint="Dodaj zateznu stopu (NBS) da bi obračun radio." />}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
