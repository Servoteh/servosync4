'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, CopyPlus, Pencil, Plus, Printer, Recycle, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  REWORK_QUALITY,
  WO_STATUS,
  useAddOperation,
  useApproveWorkOrder,
  useBulkCloneWorkOrders,
  useCopyFromWorkOrder,
  useCreateWorkOrder,
  useDeleteOperation,
  useDeleteWorkOrder,
  useLaunchWorkOrder,
  useLockWorkOrder,
  useReworkWorkOrder,
  useUpdateOperation,
  useUpdateWorkOrder,
  useWorkOrder,
  useWorkOrders,
  useWorkOrdersLookup,
  openWorkOrderRnPdf,
  type BulkCloneResult,
  type CreateWorkOrderInput,
  type ReworkQuality,
  type WorkOrder,
  type WorkOrderDetail as WorkOrderDetailData,
  type WorkOrderOperation,
} from '@/api/work-orders';
import { useOperations, type Operation } from '@/api/structures';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
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
  const { can } = useAuth();
  const q = useWorkOrder(id);
  const approve = useApproveWorkOrder();
  const launch = useLaunchWorkOrder();
  const lock = useLockWorkOrder();
  const delOp = useDeleteOperation();
  const delRn = useDeleteWorkOrder();
  const [copyOpen, setCopyOpen] = useState(false);
  const [reworkOpen, setReworkOpen] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [opDialog, setOpDialog] = useState<{ open: boolean; op: WorkOrderOperation | null }>({
    open: false,
    op: null,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const busy =
    approve.isPending || launch.isPending || lock.isPending || delOp.isPending;

  async function onPrint() {
    setPrinting(true);
    setPrintError(null);
    try {
      await openWorkOrderRnPdf(id);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : 'Greška pri štampi radnog naloga.');
    } finally {
      setPrinting(false);
    }
  }

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const rn = q.data.data;
  const s = statusMeta(rn.handoverStatusId);
  const locked = !!rn.isLocked;
  const canEdit = !locked && can(PERMISSIONS.RN_WRITE);
  const fmtNum = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 3 });
  const opTotal = rn.operations.reduce(
    (sum, op) => sum + (op.setupTime ?? 0) + (op.cycleTime ?? 0) * rn.pieceCount,
    0,
  );
  const isEmpty =
    rn.operations.length === 0 &&
    rn.machinedParts.length === 0 &&
    rn.blanks.length === 0 &&
    rn.nonStandardParts.length === 0;
  const canCopyInto = isEmpty && !locked && rn.handoverStatusId !== WO_STATUS.LAUNCHED;
  const actionError =
    (approve.error as Error) || (launch.error as Error) || (lock.error as Error);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {locked && <StatusBadge tone="warn" label="Zaključan" />}
        <span className="flex-1" />
        <button
          disabled={printing}
          onClick={onPrint}
          className={`${actionBtn} inline-flex items-center gap-1.5 border border-line text-ink-secondary`}
        >
          <Printer className="h-3.5 w-3.5" aria-hidden />
          {printing ? 'Priprema…' : 'Štampaj RN'}
        </button>
        {canCopyInto && (
          <button
            disabled={busy}
            onClick={() => setCopyOpen(true)}
            className={`${actionBtn} inline-flex items-center gap-1.5 border border-line text-ink-secondary`}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Kopiraj iz naloga
          </button>
        )}
        {!isEmpty && (
          <button
            disabled={busy}
            onClick={() => setReworkOpen(true)}
            className={`${actionBtn} inline-flex items-center gap-1.5 border border-line text-ink-secondary`}
          >
            <Recycle className="h-3.5 w-3.5" aria-hidden />
            Dorada/Škart
          </button>
        )}
        {!locked && (rn.handoverStatusId === WO_STATUS.IN_PROGRESS || rn.handoverStatusId === WO_STATUS.REJECTED) && (
          <Can permission={PERMISSIONS.RN_APPROVE}>
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
          </Can>
        )}
        {!locked && rn.handoverStatusId === WO_STATUS.APPROVED && (
          <Can permission={PERMISSIONS.RN_LAUNCH}>
            <button
              disabled={busy}
              onClick={() => launch.mutate(id)}
              className={`${actionBtn} bg-accent text-accent-fg`}
            >
              Lansiraj
            </button>
          </Can>
        )}
        <Can permission={PERMISSIONS.RN_WRITE}>
          {!locked && (
            <button
              disabled={busy}
              onClick={() => setHeaderOpen(true)}
              className={`${actionBtn} inline-flex items-center gap-1.5 border border-line text-ink-secondary`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Izmeni zaglavlje
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            className={`${actionBtn} inline-flex items-center gap-1.5 border border-status-danger text-status-danger`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Obriši RN
          </button>
        </Can>
        <button
          disabled={busy}
          onClick={() => lock.mutate({ id, locked: !locked })}
          className={`${actionBtn} border border-line text-ink-secondary`}
        >
          {locked ? 'Otključaj' : 'Zaključaj'}
        </button>
      </div>

      {printError && (
        <p className="text-sm text-status-danger" role="alert">
          {printError}
        </p>
      )}
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
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Operacije ({rn.operations.length})
          </p>
          {canEdit && (
            <button
              onClick={() => setOpDialog({ open: true, op: null })}
              className={`${actionBtn} inline-flex items-center gap-1.5 border border-line text-ink-secondary`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Dodaj operaciju
            </button>
          )}
        </div>
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
                  <th className="px-3 py-2 text-right font-semibold">Tpz</th>
                  <th className="px-3 py-2 text-right font-semibold">Tk</th>
                  <th className="px-3 py-2 text-right font-semibold">Ukupno</th>
                  {canEdit && <th className="px-3 py-2 text-right font-semibold">Akcije</th>}
                </tr>
              </thead>
              <tbody>
                {rn.operations.map((op) => {
                  const uk = (op.setupTime ?? 0) + (op.cycleTime ?? 0) * rn.pieceCount;
                  return (
                    <tr key={op.id} className="border-b border-line-soft last:border-0">
                      <td className="tnums px-3 py-1.5 text-ink-secondary">
                        {op.operationNumber}
                      </td>
                      <td className="px-3 py-1.5 text-ink">
                        {op.operation?.workCenterName ?? op.workCenterCode}
                      </td>
                      <td className="px-3 py-1.5 text-ink">{op.workDescription}</td>
                      <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                        {op.setupTime != null ? fmtNum(op.setupTime) : '—'}
                      </td>
                      <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                        {op.cycleTime != null ? fmtNum(op.cycleTime) : '—'}
                      </td>
                      <td className="tnums px-3 py-1.5 text-right text-ink">{fmtNum(uk)}</td>
                      {canEdit && (
                        <td className="px-3 py-1.5 text-right">
                          <div className="inline-flex gap-1">
                            <button
                              onClick={() => setOpDialog({ open: true, op })}
                              aria-label="Izmeni operaciju"
                              className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                delOp.mutate({ workOrderId: id, operationId: op.id })
                              }
                              aria-label="Obriši operaciju"
                              className="rounded-control border border-line px-2 py-1 text-status-danger hover:bg-status-danger-bg disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <td className="px-3 py-2 font-semibold" colSpan={5}>
                    Ukupno (Tpz + Tk × {formatNumber(rn.pieceCount)} kom)
                  </td>
                  <td className="tnums px-3 py-2 text-right font-semibold text-ink">
                    {fmtNum(opTotal)}
                  </td>
                  {canEdit && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {delOp.error && (
          <p className="mt-1.5 text-sm text-status-danger" role="alert">
            {(delOp.error as Error).message}
          </p>
        )}
      </div>

      <CopyFromWorkOrderDialog targetId={id} open={copyOpen} onClose={() => setCopyOpen(false)} />
      <ReworkWorkOrderDialog sourceId={id} open={reworkOpen} onClose={() => setReworkOpen(false)} />
      <OperationDialog
        workOrderId={id}
        operation={opDialog.op}
        open={opDialog.open}
        onClose={() => setOpDialog({ open: false, op: null })}
      />
      <EditHeaderDialog rn={rn} open={headerOpen} onClose={() => setHeaderOpen(false)} />
      <Dialog
        open={confirmDelete}
        onClose={() => {
          delRn.reset();
          setConfirmDelete(false);
        }}
        title="Obrisati radni nalog?"
        footer={
          <>
            <button
              onClick={() => {
                delRn.reset();
                setConfirmDelete(false);
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Otkaži
            </button>
            <button
              disabled={delRn.isPending}
              onClick={async () => {
                try {
                  await delRn.mutateAsync(id);
                  setConfirmDelete(false);
                } catch {
                  /* greška se prikazuje ispod */
                }
              }}
              className="rounded-control bg-status-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {delRn.isPending ? 'Brisanje…' : 'Obriši RN'}
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p className="text-ink">
            RN <span className="tnums font-semibold">{rn.identNumber}</span> i sve njegove stavke
            biće trajno obrisani. Blokirano ako je zaključan ili je proizvodnja započeta.
          </p>
          {delRn.error && (
            <p className="text-sm text-status-danger" role="alert">
              {delRn.error instanceof ApiError
                ? delRn.error.message
                : (delRn.error as Error)?.message}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

/** „Kopiraj iz naloga" — izbor izvornog RN-a → prepiši sve stavke u prazan cilj. */
function CopyFromWorkOrderDialog({
  targetId,
  open,
  onClose,
}: {
  targetId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [source, setSource] = useState<WorkOrder | null>(null);
  const copy = useCopyFromWorkOrder();

  function close() {
    setSource(null);
    copy.reset();
    onClose();
  }

  async function submit() {
    if (!source) return;
    try {
      await copy.mutateAsync({ id: targetId, sourceId: source.id });
      close();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  const err =
    copy.error instanceof ApiError ? copy.error.message : (copy.error as Error)?.message;
  const sameAsTarget = source?.id === targetId;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Kopiraj stavke iz naloga"
      footer={
        <>
          <button
            onClick={close}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={copy.isPending} disabled={!source || sameAsTarget}>
            Kopiraj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Kopira sve stavke (operacije, obrađeni/nestandardni delovi, pripremci) iz izabranog
          naloga u ovaj. Cilj mora biti prazan i ne sme biti zaključan/lansiran.
        </p>
        <FormField label="Izvorni radni nalog" required>
          <ComboBox<WorkOrder>
            value={source}
            onChange={setSource}
            useSearch={useWorkOrdersLookup}
            getKey={(w) => w.id}
            getLabel={(w) => w.identNumber}
            getSublabel={(w) =>
              [w.partName, w.drawingNumber].filter(Boolean).join(' · ')
            }
            placeholder="Ident, naziv pozicije, crtež…"
          />
        </FormField>
        {sameAsTarget && (
          <p className="text-xs text-status-danger" role="alert">
            Izvor i cilj moraju biti različiti nalozi.
          </p>
        )}
        {err && (
          <p className="text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

const EMPTY_REWORK = {
  pieceCount: 1,
  qualityTypeId: REWORK_QUALITY.DORADA as ReworkQuality,
  note: '',
};

/** „Dorada/Škart" — količina + izbor dorada(1)/škart(2) → kreira child RN. */
function ReworkWorkOrderDialog({
  sourceId,
  open,
  onClose,
}: {
  sourceId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState(EMPTY_REWORK);
  const rework = useReworkWorkOrder();

  function close() {
    setForm(EMPTY_REWORK);
    rework.reset();
    onClose();
  }

  async function submit() {
    try {
      await rework.mutateAsync({
        id: sourceId,
        pieceCount: form.pieceCount,
        qualityTypeId: form.qualityTypeId,
        note: form.note.trim() || undefined,
      });
      close();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  const err =
    rework.error instanceof ApiError ? rework.error.message : (rework.error as Error)?.message;
  const isDorada = form.qualityTypeId === REWORK_QUALITY.DORADA;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Dorada / Škart"
      footer={
        <>
          <button
            onClick={close}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={rework.isPending} disabled={form.pieceCount < 1}>
            Kreiraj {isDorada ? 'doradu' : 'škart'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Iz ovog naloga nastaje nov child RN u istom predmetu (sufiks{' '}
          <span className="tnums">-D</span>/<span className="tnums">-S</span>) sa kopijom zaglavlja
          i svih stavki.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Vrsta" required>
            <select
              value={form.qualityTypeId}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  qualityTypeId: Number(e.target.value) as ReworkQuality,
                }))
              }
              className="w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value={REWORK_QUALITY.DORADA}>Dorada</option>
              <option value={REWORK_QUALITY.SKART}>Škart</option>
            </select>
          </FormField>
          <FormField label="Količina (kom)" required>
            <Input
              type="number"
              min={1}
              step={1}
              value={form.pieceCount || ''}
              onChange={(e) =>
                setForm((f) => ({ ...f, pieceCount: Math.floor(Number(e.target.value)) }))
              }
            />
          </FormField>
        </div>
        <FormField label="Napomena">
          <Input
            value={form.note}
            placeholder="Prazno → preuzima napomenu izvora"
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </FormField>
        {err && (
          <p className="text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "" ili nevalidan broj → undefined; inače broj (za opciona numerička polja). */
function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

const EMPTY_OP_FORM = {
  operationNumber: '',
  workDescription: '',
  toolsFixtures: '',
  setupTime: '',
  cycleTime: '',
  toolWeight: '',
  priority: '',
};

/** Dodaj/izmeni operaciju TP-a (RC + norme Tpz/Tk + opis + prioritet). */
function OperationDialog({
  workOrderId,
  operation,
  open,
  onClose,
}: {
  workOrderId: number;
  operation: WorkOrderOperation | null;
  open: boolean;
  onClose: () => void;
}) {
  const editing = !!operation;
  const add = useAddOperation();
  const upd = useUpdateOperation();
  const [rc, setRc] = useState<Operation | null>(null);
  const [form, setForm] = useState(EMPTY_OP_FORM);

  useEffect(() => {
    if (!open) return;
    add.reset();
    upd.reset();
    if (operation) {
      setRc({
        workCenterCode: operation.workCenterCode,
        workCenterName: operation.operation?.workCenterName ?? operation.workCenterCode,
      } as Operation);
      setForm({
        operationNumber: String(operation.operationNumber),
        workDescription: operation.workDescription ?? '',
        toolsFixtures: operation.toolsFixtures ?? '',
        setupTime: operation.setupTime != null ? String(operation.setupTime) : '',
        cycleTime: operation.cycleTime != null ? String(operation.cycleTime) : '',
        toolWeight: operation.toolWeight != null ? String(operation.toolWeight) : '',
        priority: String(operation.priority),
      });
    } else {
      setRc(null);
      setForm(EMPTY_OP_FORM);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, operation]);

  const set = (patch: Partial<typeof EMPTY_OP_FORM>) => setForm((f) => ({ ...f, ...patch }));
  const busy = add.isPending || upd.isPending;
  const err =
    (add.error instanceof ApiError ? add.error.message : (add.error as Error)?.message) ||
    (upd.error instanceof ApiError ? upd.error.message : (upd.error as Error)?.message);
  const canSave = !busy && (editing || !!rc) && form.workDescription.trim().length > 0;

  function close() {
    add.reset();
    upd.reset();
    onClose();
  }

  async function submit() {
    if (!canSave) return;
    const common = {
      workDescription: form.workDescription.trim(),
      toolsFixtures: form.toolsFixtures.trim() || undefined,
      setupTime: numOrUndef(form.setupTime),
      cycleTime: numOrUndef(form.cycleTime),
      toolWeight: numOrUndef(form.toolWeight),
      priority: numOrUndef(form.priority),
      operationNumber: numOrUndef(form.operationNumber),
    };
    try {
      if (editing && operation) {
        await upd.mutateAsync({
          workOrderId,
          operationId: operation.id,
          ...common,
          ...(rc ? { workCenterCode: rc.workCenterCode } : {}),
        });
      } else if (rc) {
        await add.mutateAsync({ workOrderId, workCenterCode: rc.workCenterCode, ...common });
      }
      close();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={editing ? 'Izmeni operaciju' : 'Dodaj operaciju'}
      footer={
        <>
          <button
            onClick={close}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={busy} disabled={!canSave}>
            {editing ? 'Sačuvaj' : 'Dodaj'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Radni centar (RC)" required>
          <ComboBox<Operation>
            value={rc}
            onChange={setRc}
            useSearch={(query) => useOperations({ q: query || undefined })}
            getKey={(o) => o.workCenterCode}
            getLabel={(o) => `${o.workCenterName} (${o.workCenterCode})`}
            getSublabel={(o) => (o.significantForFinishing ? 'završna kontrola' : '')}
            placeholder="Šifra/naziv radnog centra…"
          />
        </FormField>
        <FormField label="Opis rada" required>
          <Input
            value={form.workDescription}
            onChange={(e) => set({ workDescription: e.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Priprema (Tpz)">
            <Input
              type="number"
              min={0}
              step="any"
              value={form.setupTime}
              onChange={(e) => set({ setupTime: e.target.value })}
            />
          </FormField>
          <FormField label="Ciklus (Tk)">
            <Input
              type="number"
              min={0}
              step="any"
              value={form.cycleTime}
              onChange={(e) => set({ cycleTime: e.target.value })}
            />
          </FormField>
        </div>
        <FormField label="Alat / pribor">
          <Input
            value={form.toolsFixtures}
            onChange={(e) => set({ toolsFixtures: e.target.value })}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Broj operacije" hint="prazno → auto (MAX+10)">
            <Input
              type="number"
              min={0}
              step={1}
              value={form.operationNumber}
              onChange={(e) => set({ operationNumber: e.target.value })}
            />
          </FormField>
          <FormField label="Prioritet" hint="prazno → iz radnog centra">
            <Input
              type="number"
              min={0}
              step={1}
              value={form.priority}
              onChange={(e) => set({ priority: e.target.value })}
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

/** Izmena zaglavlja RN-a (naziv, crtež, materijal, količina, rok…). */
function EditHeaderDialog({
  rn,
  open,
  onClose,
}: {
  rn: WorkOrderDetailData;
  open: boolean;
  onClose: () => void;
}) {
  const upd = useUpdateWorkOrder();
  const [form, setForm] = useState({
    partName: '',
    drawingNumber: '',
    material: '',
    materialDimension: '',
    unit: '',
    product: '',
    revision: '',
    pieceCount: '1',
    productionDeadline: '',
  });

  useEffect(() => {
    if (!open) return;
    upd.reset();
    setForm({
      partName: rn.partName,
      drawingNumber: rn.drawingNumber,
      material: rn.material,
      materialDimension: rn.materialDimension,
      unit: rn.unit,
      product: rn.product ?? '',
      revision: rn.revision,
      pieceCount: String(rn.pieceCount),
      productionDeadline: rn.productionDeadline ? rn.productionDeadline.slice(0, 10) : '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rn]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const err = upd.error instanceof ApiError ? upd.error.message : (upd.error as Error)?.message;
  const pieces = Number(form.pieceCount);
  const valid =
    form.partName.trim() &&
    form.drawingNumber.trim() &&
    form.material.trim() &&
    form.materialDimension.trim() &&
    Number.isInteger(pieces) &&
    pieces >= 1;

  async function submit() {
    if (!valid) return;
    try {
      await upd.mutateAsync({
        id: rn.id,
        partName: form.partName.trim(),
        drawingNumber: form.drawingNumber.trim(),
        material: form.material.trim(),
        materialDimension: form.materialDimension.trim(),
        unit: form.unit.trim() || undefined,
        product: form.product.trim() || undefined,
        revision: form.revision.trim() || undefined,
        pieceCount: pieces,
        productionDeadline: form.productionDeadline || null,
      });
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Izmeni zaglavlje — RN ${rn.identNumber}`}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={upd.isPending} disabled={!valid}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
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
            <Input value={form.revision} onChange={(e) => set({ revision: e.target.value })} />
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
              step={1}
              value={form.pieceCount}
              onChange={(e) => set({ pieceCount: e.target.value })}
            />
          </FormField>
          <FormField label="Rok isporuke">
            <Input
              type="date"
              value={form.productionDeadline}
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

/** „Kloniraj predmet" — izvorni + ciljni predmet + koeficijent → bulk-clone. */
function BulkCloneProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [source, setSource] = useState<ProjectLookup | null>(null);
  const [target, setTarget] = useState<ProjectLookup | null>(null);
  const [coefficient, setCoefficient] = useState(1);
  const [result, setResult] = useState<BulkCloneResult | null>(null);
  const clone = useBulkCloneWorkOrders();

  function close() {
    setSource(null);
    setTarget(null);
    setCoefficient(1);
    setResult(null);
    clone.reset();
    onClose();
  }

  async function submit() {
    if (!source || !target) return;
    try {
      const res = await clone.mutateAsync({
        sourceProjectId: source.id,
        targetProjectId: target.id,
        coefficient,
      });
      setResult(res.data);
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  const err =
    clone.error instanceof ApiError ? clone.error.message : (clone.error as Error)?.message;
  const sameProject = !!source && !!target && source.id === target.id;
  const invalidCoef = !(coefficient > 0);

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Kloniraj predmet"
      footer={
        result ? (
          <Button onClick={close}>Zatvori</Button>
        ) : (
          <>
            <button
              onClick={close}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Otkaži
            </button>
            <Button
              onClick={submit}
              loading={clone.isPending}
              disabled={!source || !target || sameProject || invalidCoef}
            >
              Kloniraj
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2 text-sm">
          <p className="text-ink">
            Klonirano <span className="tnums font-semibold">{formatNumber(result.count)}</span>{' '}
            {result.count === 1 ? 'nalog' : 'naloga'} u novi predmet.
          </p>
          <div className="max-h-56 overflow-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="px-3 py-2 font-semibold">Novi RN</th>
                  <th className="px-3 py-2 text-right font-semibold">Izvor (id)</th>
                </tr>
              </thead>
              <tbody>
                {result.workOrders.map((w) => (
                  <tr key={w.id} className="border-b border-line-soft last:border-0">
                    <td className="tnums px-3 py-1.5 text-ink">{w.identNumber}</td>
                    <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                      {w.sourceId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-disabled">
            Kloniraj sve naloge izvornog predmeta u nov <em>prazan</em> predmet. Koeficijent množi
            količine (norme operacija se ne skaliraju).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Izvorni predmet" required>
              <ComboBox<ProjectLookup>
                value={source}
                onChange={setSource}
                useSearch={useProjectsLookup}
                getKey={(p) => p.id}
                getLabel={(p) => p.projectNumber}
                getSublabel={(p) => p.projectName ?? p.description ?? ''}
                placeholder="Broj/naziv predmeta…"
              />
            </FormField>
            <FormField label="Ciljni predmet" required>
              <ComboBox<ProjectLookup>
                value={target}
                onChange={setTarget}
                useSearch={useProjectsLookup}
                getKey={(p) => p.id}
                getLabel={(p) => p.projectNumber}
                getSublabel={(p) => p.projectName ?? p.description ?? ''}
                placeholder="Prazan predmet…"
              />
            </FormField>
          </div>
          <FormField label="Koeficijent" required>
            <Input
              type="number"
              min={0}
              step="any"
              value={coefficient || ''}
              onChange={(e) => setCoefficient(Number(e.target.value))}
            />
          </FormField>
          {sameProject && (
            <p className="text-xs text-status-danger" role="alert">
              Ciljni predmet mora biti različit od izvornog.
            </p>
          )}
          {err && (
            <p className="text-sm text-status-danger" role="alert">
              {err}
            </p>
          )}
        </div>
      )}
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
  const [cloning, setCloning] = useState(false);
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
            <Button variant="secondary" onClick={() => setCloning(true)}>
              <CopyPlus className="h-4 w-4" aria-hidden />
              Kloniraj predmet
            </Button>
            <Can permission={PERMISSIONS.RN_WRITE}>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Novi RN
              </Button>
            </Can>
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
      <BulkCloneProjectDialog open={cloning} onClose={() => setCloning(false)} />
    </AppShell>
  );
}
