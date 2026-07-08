'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  WO_STATUS,
  useApproveWorkOrder,
  useCreateWorkOrder,
  useLaunchWorkOrder,
  useLockWorkOrder,
  useWorkOrder,
  useWorkOrders,
  type CreateWorkOrderInput,
  type WorkOrder,
} from '@/api/work-orders';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import {
  useCustomersLookup,
  useProjectsLookup,
  type CustomerLookup,
  type ProjectLookup,
} from '@/api/lookups';
import { formatDate, formatNumber } from '@/lib/format';

const STATUS_META: Record<number, { tone: Tone; label: string }> = {
  [WO_STATUS.IN_PROGRESS]: { tone: 'neutral', label: 'U obradi' },
  [WO_STATUS.APPROVED]: { tone: 'success', label: 'Saglasan' },
  [WO_STATUS.REJECTED]: { tone: 'danger', label: 'Odbijeno' },
  [WO_STATUS.LAUNCHED]: { tone: 'info', label: 'Lansiran' },
};
function statusMeta(id: number) {
  return STATUS_META[id] ?? { tone: 'neutral' as Tone, label: 'U obradi' };
}

const columns: Column<WorkOrder>[] = [
  {
    key: 'identNumber',
    header: 'RN / Ident',
    render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
  },
  { key: 'partName', header: 'Naziv pozicije', render: (r) => r.partName || '—' },
  {
    key: 'drawingNumber',
    header: 'Crtež',
    render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber || '—'}</span>,
  },
  {
    key: 'pieceCount',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.pieceCount),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = statusMeta(r.handoverStatusId);
      return (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge tone={s.tone} label={s.label} />
          {r.isLocked && <StatusBadge tone="warn" label="Zaključan" />}
        </span>
      );
    },
  },
  {
    key: 'deadline',
    header: 'Rok',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.productionDeadline)}</span>,
  },
  {
    key: 'worker',
    header: 'Otvorio',
    render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
  },
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

const actionBtn =
  'rounded-control px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';

function WorkOrderDetail({ id }: { id: number }) {
  const q = useWorkOrder(id);
  const approve = useApproveWorkOrder();
  const launch = useLaunchWorkOrder();
  const lock = useLockWorkOrder();
  const busy = approve.isPending || launch.isPending || lock.isPending;

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const rn = q.data.data;
  const s = statusMeta(rn.handoverStatusId);
  const locked = !!rn.isLocked;
  const actionError =
    (approve.error as Error) || (launch.error as Error) || (lock.error as Error);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {locked && <StatusBadge tone="warn" label="Zaključan" />}
        <span className="flex-1" />
        {!locked && (rn.handoverStatusId === WO_STATUS.IN_PROGRESS || rn.handoverStatusId === WO_STATUS.REJECTED) && (
          <>
            <button
              disabled={busy}
              onClick={() => approve.mutate({ id, approve: true })}
              className={`${actionBtn} bg-status-success text-white`}
            >
              Odobri
            </button>
            <button
              disabled={busy}
              onClick={() => approve.mutate({ id, approve: false })}
              className={`${actionBtn} border border-status-danger text-status-danger`}
            >
              Odbij
            </button>
          </>
        )}
        {!locked && rn.handoverStatusId === WO_STATUS.APPROVED && (
          <button
            disabled={busy}
            onClick={() => launch.mutate(id)}
            className={`${actionBtn} bg-accent text-accent-fg`}
          >
            Lansiraj
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => lock.mutate({ id, locked: !locked })}
          className={`${actionBtn} border border-line text-ink-secondary`}
        >
          {locked ? 'Otključaj' : 'Zaključaj'}
        </button>
      </div>

      {actionError && (
        <p className="text-sm text-status-danger" role="alert">
          {actionError.message}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Materijal" value={rn.material || '—'} />
        <Field label="Dimenzija" value={rn.materialDimension || '—'} />
        <Field label="Revizija" value={rn.revision} />
        <Field label="Kvalitet" value={rn.qualityType?.name ?? '—'} />
        <Field label="Predmet (spolja)" value={rn.externalProjectName ?? String(rn.projectId)} />
        <Field label="Tehnolog" value={rn.worker?.fullName ?? '—'} />
        <Field label="Otvoren" value={formatDate(rn.enteredAt)} />
        <Field label="Rok" value={formatDate(rn.productionDeadline)} />
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Operacije ({rn.operations.length})
        </p>
        {rn.operations.length === 0 ? (
          <span className="text-sm text-ink-disabled">Nema operacija.</span>
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="px-3 py-2 font-semibold">Op.</th>
                  <th className="px-3 py-2 font-semibold">RC</th>
                  <th className="px-3 py-2 font-semibold">Opis</th>
                  <th className="px-3 py-2 text-right font-semibold">Priprema</th>
                  <th className="px-3 py-2 text-right font-semibold">Ciklus</th>
                </tr>
              </thead>
              <tbody>
                {rn.operations.map((op) => (
                  <tr key={op.id} className="border-b border-line-soft last:border-0">
                    <td className="tnums px-3 py-1.5 text-ink-secondary">{op.operationNumber}</td>
                    <td className="px-3 py-1.5 text-ink">
                      {op.operation?.workCenterName ?? op.workCenterCode}
                    </td>
                    <td className="px-3 py-1.5 text-ink">{op.workDescription}</td>
                    <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                      {op.setupTime ?? '—'}
                    </td>
                    <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                      {op.cycleTime ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_FORM: CreateWorkOrderInput = {
  projectId: 0,
  externalCustomerId: 0,
  partName: '',
  drawingNumber: '',
  material: '',
  materialDimension: '',
  pieceCount: 1,
  revision: '',
  productionDeadline: '',
};

function NewWorkOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<CreateWorkOrderInput>(EMPTY_FORM);
  const [project, setProject] = useState<ProjectLookup | null>(null);
  const [customer, setCustomer] = useState<CustomerLookup | null>(null);
  const create = useCreateWorkOrder();
  const set = (patch: Partial<CreateWorkOrderInput>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    try {
      await create.mutateAsync({
        ...form,
        revision: form.revision?.trim() || undefined,
        productionDeadline: form.productionDeadline || undefined,
      });
      setForm(EMPTY_FORM);
      setProject(null);
      setCustomer(null);
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  const err =
    create.error instanceof ApiError ? create.error.message : (create.error as Error)?.message;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Novi radni nalog"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={create.isPending}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Broj naloga (<span className="tnums">predmet/redni</span>) generiše sistem. Predmet i
          komitent se za sad unose šifrom (biranje iz liste stiže sa šifarnicima).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Predmet" required>
            <ComboBox<ProjectLookup>
              value={project}
              onChange={(p) => {
                setProject(p);
                setForm((f) => ({
                  ...f,
                  projectId: p?.id ?? 0,
                  externalCustomerId: p?.customerId ?? f.externalCustomerId,
                }));
                if (p) setCustomer(null);
              }}
              useSearch={useProjectsLookup}
              getKey={(p) => p.id}
              getLabel={(p) => p.projectNumber}
              getSublabel={(p) => p.projectName ?? p.description ?? ''}
              placeholder="Broj/naziv predmeta…"
            />
          </FormField>
          <FormField label="Komitent" required>
            <ComboBox<CustomerLookup>
              value={customer}
              onChange={(c) => {
                setCustomer(c);
                setForm((f) => ({
                  ...f,
                  externalCustomerId: c?.id ?? project?.customerId ?? 0,
                }));
              }}
              useSearch={useCustomersLookup}
              getKey={(c) => c.id}
              getLabel={(c) => c.name}
              getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
              placeholder={project ? 'Iz predmeta — promeni po želji…' : 'Naziv/PIB…'}
            />
            {!customer && form.externalCustomerId > 0 && (
              <p className="mt-1 text-xs text-ink-disabled">
                Preuzet iz predmeta (šifra {form.externalCustomerId}).
              </p>
            )}
          </FormField>
        </div>
        <FormField label="Naziv pozicije" required>
          <Input value={form.partName} onChange={(e) => set({ partName: e.target.value })} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Broj crteža" required>
            <Input
              value={form.drawingNumber}
              onChange={(e) => set({ drawingNumber: e.target.value })}
            />
          </FormField>
          <FormField label="Revizija">
            <Input
              value={form.revision ?? ''}
              placeholder="A"
              onChange={(e) => set({ revision: e.target.value })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Materijal" required>
            <Input value={form.material} onChange={(e) => set({ material: e.target.value })} />
          </FormField>
          <FormField label="Dimenzija materijala" required>
            <Input
              value={form.materialDimension}
              onChange={(e) => set({ materialDimension: e.target.value })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Količina (kom)" required>
            <Input
              type="number"
              min={1}
              value={form.pieceCount || ''}
              onChange={(e) => set({ pieceCount: Number(e.target.value) })}
            />
          </FormField>
          <FormField label="Rok isporuke">
            <Input
              type="date"
              value={form.productionDeadline ?? ''}
              onChange={(e) => set({ productionDeadline: e.target.value })}
            />
          </FormField>
        </div>
        {err && (
          <p className="text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default function WorkOrdersPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [statusId, setStatusId] = useState<number | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useWorkOrders({ page, q: q.trim() || undefined, statusId, from, to });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const resetPage = () => setPage(1);

  return (
    <AppShell>
      <PageHeader
        title="Radni nalozi"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <>
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                resetPage();
              }}
              placeholder="Ident, naziv, crtež…"
            />
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi RN
            </Button>
          </>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <select
              value={statusId}
              onChange={(e) => {
                setStatusId(e.target.value === '' ? '' : Number(e.target.value));
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value="">Svi</option>
              <option value={WO_STATUS.IN_PROGRESS}>U obradi</option>
              <option value={WO_STATUS.APPROVED}>Saglasan</option>
              <option value={WO_STATUS.LAUNCHED}>Lansiran</option>
              <option value={WO_STATUS.REJECTED}>Odbijeno</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Otvoren od
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            do
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          {(statusId !== '' || from || to || q) && (
            <button
              onClick={() => {
                setQ('');
                setStatusId('');
                setFrom('');
                setTo('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {list.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
          expandedKey={expanded}
          renderExpanded={(r) => <WorkOrderDetail id={r.id} />}
          empty={
            <EmptyState
              title="Nema radnih naloga"
              hint="Promeni filtere ili kreiraj novi RN dugmetom gore."
            />
          }
        />

        {meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
          />
        )}
      </div>

      <NewWorkOrderDialog open={creating} onClose={() => setCreating(false)} />
    </AppShell>
  );
}
