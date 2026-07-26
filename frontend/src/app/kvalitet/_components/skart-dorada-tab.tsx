'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Plus, Check, X } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Textarea } from '@/components/ui-kit/textarea';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  EVENT_STATUS_LABEL,
  EVENT_TYPE_LABEL,
  QUALITY_EVENT_STATUS,
  QUALITY_EVENT_TYPE,
  eventStatusTone,
  useConfirmQualityEvent,
  useCreateQualityEvent,
  useQualityEvents,
  useQualityPareto,
  useReasonCodes,
  useRejectQualityEvent,
  type CreateQualityEventInput,
  type QualityEvent,
  type QualityEventType,
} from '@/api/kvalitet-events';

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

type SubView = 'evidencija' | 'queue' | 'pareto';

interface Filters {
  type: '' | QualityEventType;
  status: '' | keyof typeof QUALITY_EVENT_STATUS;
  reasonCodeId: string;
  workOrderId: string;
  machine: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  type: '',
  status: '',
  reasonCodeId: '',
  workOrderId: '',
  machine: '',
  from: '',
  to: '',
};

/** Novi tab „Škart i dorada" (MODULE_SPEC_kvalitet_skart_dorada §4): evidencija +
 *  red čekanja prijava (Potvrdi/Odbaci) + kontrolorski unos + Pareto. */
export function SkartDoradaTab() {
  const [view, setView] = useState<SubView>('evidencija');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [newOpen, setNewOpen] = useState(false);
  const [confirmEvent, setConfirmEvent] = useState<QualityEvent | null>(null);
  const [rejectEvent, setRejectEvent] = useState<QualityEvent | null>(null);
  const resetPage = () => setPage(1);

  const reasonsQ = useReasonCodes();
  const reasons = reasonsQ.data?.data ?? [];

  const listParams = {
    page,
    type: filters.type || undefined,
    status: filters.status || undefined,
    reasonCodeId: filters.reasonCodeId ? Number(filters.reasonCodeId) : undefined,
    workOrderId: filters.workOrderId ? Number(filters.workOrderId) : undefined,
    machine: filters.machine.trim() || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  } as const;

  const evidencija = useQualityEvents(listParams, { enabled: view === 'evidencija' });
  const queue = useQualityEvents(
    { type: filters.type || undefined, status: QUALITY_EVENT_STATUS.PRIJAVLJEN },
    { enabled: view === 'queue' },
  );
  const pareto = useQualityPareto(
    { type: filters.type || undefined, from: filters.from || undefined, to: filters.to || undefined },
    { enabled: view === 'pareto' },
  );

  // pendingCount (badge na „Red čekanja") — bilo iz evidencije bilo iz queue meta.
  const pendingCount =
    queue.data?.meta.pendingCount ?? evidencija.data?.meta.pendingCount ?? 0;

  const hasFilter =
    !!(filters.type || filters.status || filters.reasonCodeId || filters.workOrderId ||
    filters.machine || filters.from || filters.to);

  const setF = (p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    resetPage();
  };

  const typeOptions = [
    { value: QUALITY_EVENT_TYPE.SKART, label: 'Škart' },
    { value: QUALITY_EVENT_TYPE.DORADA, label: 'Dorada' },
  ];
  const statusOptions = [
    { value: QUALITY_EVENT_STATUS.PRIJAVLJEN, label: 'Prijavljen' },
    { value: QUALITY_EVENT_STATUS.POTVRDJEN, label: 'Potvrđen' },
    { value: QUALITY_EVENT_STATUS.ODBACEN, label: 'Odbačen' },
  ];
  const reasonOptions = reasons.map((r) => ({ value: String(r.id), label: r.label }));

  const subViews: { key: SubView; label: string; badge?: number }[] = [
    { key: 'evidencija', label: 'Evidencija' },
    { key: 'queue', label: 'Red čekanja', badge: pendingCount },
    { key: 'pareto', label: 'Pareto' },
  ];

  return (
    <div className="space-y-4">
      {/* Sub-view + primarna akcija */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Prikaz škart/dorada">
          {subViews.map((s) => {
            const active = s.key === view;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(s.key)}
                className={
                  'flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (active
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line text-ink-secondary hover:bg-surface-2')
                }
              >
                {s.label}
                {s.badge != null && s.badge > 0 && (
                  <span className="tnums inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-status-warn-bg px-1 text-2xs font-semibold text-status-warn">
                    {s.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="ml-auto">
          <Can permission={PERMISSIONS.KVALITET_WRITE}>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi unos
            </Button>
          </Can>
        </div>
      </div>

      {/* Filteri (evidencija + pareto koriste period/tip; evidencija dodatno status/razlog/RN/mašina) */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Tip
          <Select
            options={typeOptions}
            placeholder="Svi"
            value={filters.type}
            onChange={(e) => setF({ type: e.target.value as Filters['type'] })}
            className="h-8 py-1 text-sm"
          />
        </label>
        {view === 'evidencija' && (
          <>
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              Status
              <Select
                options={statusOptions}
                placeholder="Svi"
                value={filters.status}
                onChange={(e) => setF({ status: e.target.value as Filters['status'] })}
                className="h-8 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              Razlog
              <Select
                options={reasonOptions}
                placeholder="Svi"
                value={filters.reasonCodeId}
                onChange={(e) => setF({ reasonCodeId: e.target.value })}
                className="h-8 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              RN (ID)
              <input
                type="number"
                min={1}
                value={filters.workOrderId}
                onChange={(e) => setF({ workOrderId: e.target.value })}
                className={filterInput + ' w-24'}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              Mašina / RJ
              <input
                value={filters.machine}
                onChange={(e) => setF({ machine: e.target.value })}
                placeholder="RC kod"
                className={filterInput + ' w-28'}
              />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period od
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setF({ from: e.target.value })}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period do
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setF({ to: e.target.value })}
            className={filterInput}
          />
        </label>
        {hasFilter && (
          <button
            onClick={() => setF(EMPTY_FILTERS)}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
      </div>

      {view === 'evidencija' && (
        <EvidencijaView
          query={evidencija}
          page={page}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={(tp) => setPage((p) => Math.min(tp, p + 1))}
        />
      )}
      {view === 'queue' && (
        <QueueView
          query={queue}
          onConfirm={setConfirmEvent}
          onReject={setRejectEvent}
        />
      )}
      {view === 'pareto' && <ParetoView query={pareto} />}

      {/* Dijalozi */}
      <NewEventDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        reasons={reasonOptions}
      />
      {confirmEvent && (
        <ConfirmDialog
          event={confirmEvent}
          reasons={reasonOptions}
          onClose={() => setConfirmEvent(null)}
        />
      )}
      {rejectEvent && (
        <RejectDialog event={rejectEvent} onClose={() => setRejectEvent(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── kolone (deljene)

function typeCell(r: QualityEvent) {
  return <span className="text-ink-secondary">{EVENT_TYPE_LABEL[r.type]}</span>;
}
function qtyCell(r: QualityEvent) {
  return (
    <span className="tnums">
      {formatDecimal(r.qty, 3)} {r.unit}
    </span>
  );
}

// ─────────────────────────────────────────────────────────── Evidencija

function EvidencijaView({
  query,
  page,
  onPrev,
  onNext,
}: {
  query: ReturnType<typeof useQualityEvents>;
  page: number;
  onPrev: () => void;
  onNext: (totalPages: number) => void;
}) {
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta.pagination;
  const columns: Column<QualityEvent>[] = [
    { key: 'type', header: 'Tip', render: typeCell },
    {
      key: 'reportedAt',
      header: 'Datum',
      render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.reportedAt)}</span>,
    },
    { key: 'workOrderId', header: 'RN', numeric: true, render: (r) => <span className="tnums">{r.workOrderId}</span> },
    { key: 'qty', header: 'Količina', align: 'right', numeric: true, render: qtyCell },
    { key: 'reason', header: 'Razlog', render: (r) => r.reason?.label ?? '—' },
    { key: 'workUnit', header: 'Mašina / RJ', render: (r) => <span className="text-ink-secondary">{r.workUnitCode ?? '—'}</span> },
    { key: 'reporter', header: 'Prijavio', render: (r) => <span className="text-ink-secondary">{r.reportedByWorker?.fullName ?? '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone={eventStatusTone(r.status)} label={EVENT_STATUS_LABEL[r.status]} />,
    },
  ];
  return (
    <div className="space-y-4">
      {query.error && <ErrorBox error={query.error} />}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={query.isLoading}
        empty={<EmptyState title="Nema događaja" hint="Promeni filtere ili dodaj novi unos." />}
      />
      <div className="flex items-center justify-between">
        {meta && <span className="text-sm text-ink-secondary">{formatNumber(meta.total)} zapisa</span>}
        {meta && meta.totalPages > 1 && (
          <Pager page={page} totalPages={meta.totalPages} onPrev={onPrev} onNext={() => onNext(meta.totalPages)} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Red čekanja

function QueueView({
  query,
  onConfirm,
  onReject,
}: {
  query: ReturnType<typeof useQualityEvents>;
  onConfirm: (e: QualityEvent) => void;
  onReject: (e: QualityEvent) => void;
}) {
  const rows = query.data?.data ?? [];
  const columns: Column<QualityEvent>[] = [
    { key: 'type', header: 'Tip', render: typeCell },
    { key: 'reportedAt', header: 'Datum', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.reportedAt)}</span> },
    { key: 'workOrderId', header: 'RN', numeric: true, render: (r) => <span className="tnums">{r.workOrderId}</span> },
    { key: 'qty', header: 'Količina', align: 'right', numeric: true, render: qtyCell },
    { key: 'reason', header: 'Razlog', render: (r) => r.reason?.label ?? <span className="text-ink-disabled">bez razloga</span> },
    { key: 'reporter', header: 'Prijavio', render: (r) => <span className="text-ink-secondary">{r.reportedByWorker?.fullName ?? '—'}</span> },
    {
      key: 'akcije',
      header: '',
      render: (r) => (
        <Can permission={PERMISSIONS.KVALITET_WRITE}>
          <div className="flex justify-end gap-1.5">
            <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => onConfirm(r)}>
              <Check className="h-3.5 w-3.5" aria-hidden /> Potvrdi
            </Button>
            <Button variant="danger" className="h-7 px-2 text-xs" onClick={() => onReject(r)}>
              <X className="h-3.5 w-3.5" aria-hidden /> Odbaci
            </Button>
          </div>
        </Can>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      {query.error && <ErrorBox error={query.error} />}
      <p className="text-sm text-ink-secondary">
        Prijave sa kioska koje čekaju odluku kontrolora. Potvrdi (dopuni razlog) ili Odbaci (uz razlog).
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={query.isLoading}
        empty={<EmptyState title="Nema prijava na čekanju" hint="Red čekanja je prazan." />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Pareto

function ParetoView({ query }: { query: ReturnType<typeof useQualityPareto> }) {
  const data = query.data?.data;
  if (query.isLoading) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  if (query.error) return <ErrorBox error={query.error} />;
  if (!data || (!data.byReason.length && !data.byMachine.length))
    return <EmptyState title="Nema potvrđenih događaja" hint="Pareto sabira samo potvrđene događaje u periodu." />;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ParetoTable
        title="Po razlogu"
        rows={data.byReason.map((r) => ({ key: String(r.reasonCodeId ?? 'x'), label: r.label, count: r.count, qty: r.qty, percent: r.percent }))}
      />
      <ParetoTable
        title="Po mašini / RJ"
        rows={data.byMachine.map((r) => ({ key: r.workUnitCode ?? 'x', label: r.label, count: r.count, qty: r.qty, percent: r.percent }))}
      />
    </div>
  );
}

function ParetoTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; count: number; qty: number; percent: number }[];
}) {
  return (
    <div className="rounded-panel border border-line bg-surface">
      <div className="border-b border-line px-4 py-2 text-sm font-semibold text-ink">{title}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left">
            <th className="h-9 px-4 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">Stavka</th>
            <th className="h-9 px-4 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">Broj</th>
            <th className="h-9 px-4 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">Količina</th>
            <th className="h-9 px-4 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">Udeo</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-ink-disabled">Nema podataka</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-b border-line-soft">
                <td className="px-4 py-1.5 text-ink">{r.label}</td>
                <td className="tnums px-4 py-1.5 text-right text-ink-secondary">{formatNumber(r.count)}</td>
                <td className="tnums px-4 py-1.5 text-right">{formatDecimal(r.qty, 3)}</td>
                <td className="tnums px-4 py-1.5 text-right text-ink-secondary">{formatDecimal(r.percent, 1)}%</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Dijalozi

/** Ctrl+S = snimi (DESIGN_SYSTEM §8) — poziva se na keydown wrappera forme. */
function onCtrlS(submit: () => void) {
  return (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      submit();
    }
  };
}

type ReasonOption = { value: string; label: string };

function NewEventDialog({
  open,
  onClose,
  reasons,
}: {
  open: boolean;
  onClose: () => void;
  reasons: ReasonOption[];
}) {
  const create = useCreateQualityEvent();
  const [type, setType] = useState<QualityEventType>(QUALITY_EVENT_TYPE.SKART);
  const [workOrderId, setWorkOrderId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('kom');
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [workUnitCode, setWorkUnitCode] = useState('');
  const [techProcessId, setTechProcessId] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setType(QUALITY_EVENT_TYPE.SKART);
    setWorkOrderId('');
    setQty('');
    setUnit('kom');
    setReasonCodeId('');
    setWorkUnitCode('');
    setTechProcessId('');
    setNote('');
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid =
    Number(workOrderId) > 0 && Number(qty) > 0 && reasonCodeId !== '';

  function submit() {
    if (!valid) return;
    const input: CreateQualityEventInput = {
      type,
      workOrderId: Number(workOrderId),
      qty: Number(qty),
      unit: unit.trim() || 'kom',
      reasonCodeId: Number(reasonCodeId),
      workUnitCode: workUnitCode.trim() || null,
      techProcessId: techProcessId ? Number(techProcessId) : null,
      note: note.trim() || null,
    };
    create.mutate(input, { onSuccess: onClose });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Novi unos — škart / dorada"
      size="lg"
      dismissable={false}
      footer={
        <>
          <button onClick={onClose} className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2">
            Otkaži
          </button>
          <Button onClick={submit} loading={create.isPending} disabled={!valid}>
            Sačuvaj (potvrđen)
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" onKeyDown={onCtrlS(submit)}>
        <FormField label="Tip" required>
          <Select
            options={[
              { value: QUALITY_EVENT_TYPE.SKART, label: 'Škart' },
              { value: QUALITY_EVENT_TYPE.DORADA, label: 'Dorada' },
            ]}
            value={type}
            onChange={(e) => setType(e.target.value as QualityEventType)}
          />
        </FormField>
        <FormField label="RN (ID naloga)" required hint="Interni ID radnog naloga (work_orders.id).">
          <Input type="number" min={1} value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Količina" required>
          <Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </FormField>
        <FormField label="Jedinica">
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
        </FormField>
        <FormField label="Razlog" required>
          <Select options={reasons} placeholder="— izaberi razlog —" value={reasonCodeId} onChange={(e) => setReasonCodeId(e.target.value)} />
        </FormField>
        <FormField label="Mašina / radna jedinica" hint="RC kod (opciono).">
          <Input value={workUnitCode} onChange={(e) => setWorkUnitCode(e.target.value)} />
        </FormField>
        <FormField label="Operacija (ID)" hint="tech_processes.id (opciono).">
          <Input type="number" min={1} value={techProcessId} onChange={(e) => setTechProcessId(e.target.value)} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Napomena">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>
        {create.error && (
          <p className="sm:col-span-2 text-sm text-status-danger" role="alert">
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ConfirmDialog({
  event,
  reasons,
  onClose,
}: {
  event: QualityEvent;
  reasons: ReasonOption[];
  onClose: () => void;
}) {
  const confirm = useConfirmQualityEvent();
  const [reasonCodeId, setReasonCodeId] = useState(event.reasonCodeId ? String(event.reasonCodeId) : '');
  const [qty, setQty] = useState(event.qty ?? '');
  const [workUnitCode, setWorkUnitCode] = useState(event.workUnitCode ?? '');
  const [note, setNote] = useState(event.note ?? '');

  const valid = reasonCodeId !== '' && Number(qty) > 0;
  function submit() {
    if (!valid) return;
    confirm.mutate(
      {
        id: event.id,
        data: {
          reasonCodeId: Number(reasonCodeId),
          qty: Number(qty),
          workUnitCode: workUnitCode.trim() || null,
          note: note.trim() || null,
        },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Potvrdi prijavu — ${EVENT_TYPE_LABEL[event.type].toLowerCase()} (RN ${event.workOrderId})`}
      size="md"
      dismissable={false}
      footer={
        <>
          <button onClick={onClose} className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2">
            Otkaži
          </button>
          <Button onClick={submit} loading={confirm.isPending} disabled={!valid}>
            Potvrdi
          </Button>
        </>
      }
    >
      <div className="space-y-3" onKeyDown={onCtrlS(submit)}>
        <FormField label="Razlog" required>
          <Select options={reasons} placeholder="— izaberi razlog —" value={reasonCodeId} onChange={(e) => setReasonCodeId(e.target.value)} />
        </FormField>
        <FormField label="Količina" required>
          <Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </FormField>
        <FormField label="Mašina / radna jedinica">
          <Input value={workUnitCode} onChange={(e) => setWorkUnitCode(e.target.value)} />
        </FormField>
        <FormField label="Napomena">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {confirm.error && (
          <p className="text-sm text-status-danger" role="alert">
            {(confirm.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function RejectDialog({ event, onClose }: { event: QualityEvent; onClose: () => void }) {
  const reject = useRejectQualityEvent();
  const [rejectReason, setRejectReason] = useState('');
  const valid = rejectReason.trim() !== '';
  function submit() {
    if (!valid) return;
    reject.mutate({ id: event.id, rejectReason: rejectReason.trim() }, { onSuccess: onClose });
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Odbaci prijavu — RN ${event.workOrderId}`}
      size="md"
      dismissable={false}
      footer={
        <>
          <button onClick={onClose} className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2">
            Otkaži
          </button>
          <Button variant="danger" onClick={submit} loading={reject.isPending} disabled={!valid}>
            Odbaci prijavu
          </Button>
        </>
      }
    >
      <div className="space-y-3" onKeyDown={onCtrlS(submit)}>
        <FormField label="Razlog odbacivanja" required hint="I odbacivanje je podatak — kratko obrazloži zašto prijava nije validna.">
          <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} autoFocus />
        </FormField>
        {reject.error && (
          <p className="text-sm text-status-danger" role="alert">
            {(reject.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
      {(error as Error).message}
    </div>
  );
}
