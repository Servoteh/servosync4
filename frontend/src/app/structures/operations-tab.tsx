'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  useOperations,
  useCreateOperation,
  useUpdateOperation,
  useDeleteOperation,
  useWorkUnits,
  type Operation,
  type OperationCreateInput,
} from '@/api/structures';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatNumber } from '@/lib/format';
import { Checkbox, ConfirmDialog, ErrorText, FlagCell, NativeSelect } from './common';

interface OperationFormState {
  workCenterCode: string;
  workCenterName: string;
  workUnitCode: string;
  note: string;
  withoutProcess: boolean;
  significantForFinishing: boolean;
  usesPriority: boolean;
  isSkippable: boolean;
}

function toFormState(op: Operation | null): OperationFormState {
  return {
    workCenterCode: op?.workCenterCode ?? '',
    workCenterName: op?.workCenterName ?? '',
    workUnitCode: op?.workUnitCode ?? '',
    note: op?.note ?? '',
    withoutProcess: op?.withoutProcess ?? false,
    significantForFinishing: op?.significantForFinishing ?? false,
    usesPriority: op?.usesPriority ?? false,
    isSkippable: op?.isSkippable ?? false,
  };
}

function OperationFormDialog({
  open,
  operation,
  onClose,
}: {
  open: boolean;
  operation: Operation | null;
  onClose: () => void;
}) {
  const isEdit = operation != null;
  const [form, setForm] = useState<OperationFormState>(() => toFormState(operation));
  const units = useWorkUnits({ pageSize: 200 });
  const create = useCreateOperation();
  const update = useUpdateOperation();
  const mut = isEdit ? update : create;

  useEffect(() => {
    if (open) setForm(toFormState(operation));
  }, [open, operation]);

  const set = (patch: Partial<OperationFormState>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    try {
      if (isEdit) {
        await update.mutateAsync({
          code: operation.workCenterCode,
          data: {
            workCenterName: form.workCenterName.trim(),
            workUnitCode: form.workUnitCode.trim(),
            note: form.note.trim() || undefined,
            withoutProcess: form.withoutProcess,
            significantForFinishing: form.significantForFinishing,
            usesPriority: form.usesPriority,
            isSkippable: form.isSkippable,
          },
        });
      } else {
        const payload: OperationCreateInput = {
          workCenterCode: form.workCenterCode.trim(),
          workCenterName: form.workCenterName.trim(),
          workUnitCode: form.workUnitCode.trim(),
          note: form.note.trim() || undefined,
          withoutProcess: form.withoutProcess,
          significantForFinishing: form.significantForFinishing,
          usesPriority: form.usesPriority,
          isSkippable: form.isSkippable,
        };
        await create.mutateAsync(payload);
      }
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Izmena operacije ${operation.workCenterCode}` : 'Nova operacija'}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={mut.isPending}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra operacije" required hint={isEdit ? 'Šifra se ne menja.' : undefined}>
            <Input
              value={form.workCenterCode}
              disabled={isEdit}
              onChange={(e) => set({ workCenterCode: e.target.value })}
              placeholder="1.10"
            />
          </FormField>
          <FormField label="Radna jedinica" required>
            <NativeSelect
              value={form.workUnitCode}
              onChange={(e) => set({ workUnitCode: e.target.value })}
            >
              <option value="">— izaberi —</option>
              {(units.data?.data ?? []).map((u) => (
                <option key={u.id} value={u.code}>
                  {u.code} · {u.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>
        <FormField label="Naziv operacije" required>
          <Input
            value={form.workCenterName}
            onChange={(e) => set({ workCenterName: e.target.value })}
          />
        </FormField>
        <FormField label="Napomena">
          <Input value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </FormField>

        <div className="grid grid-cols-2 gap-2 rounded-control border border-line bg-surface-2/40 px-3 py-2.5">
          <Checkbox
            checked={form.withoutProcess}
            onChange={(v) => set({ withoutProcess: v })}
            label="Bez postupka (opšti nalog)"
          />
          <Checkbox
            checked={form.significantForFinishing}
            onChange={(v) => set({ significantForFinishing: v })}
            label="Kraj postupka (završna kontrola)"
          />
          <Checkbox
            checked={form.usesPriority}
            onChange={(v) => set({ usesPriority: v })}
            label="Koristi prioritet"
          />
          <Checkbox
            checked={form.isSkippable}
            onChange={(v) => set({ isSkippable: v })}
            label="Može se preskočiti"
          />
        </div>

        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

export function OperationsTab() {
  const [q, setQ] = useState('');
  const [workUnitCode, setWorkUnitCode] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Operation | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Operation | null>(null);
  const list = useOperations({
    page,
    q: q.trim() || undefined,
    workUnitCode: workUnitCode || undefined,
  });
  const units = useWorkUnits({ pageSize: 200 });
  const del = useDeleteOperation();

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const resetPage = () => setPage(1);

  async function doDelete() {
    if (!deleting) return;
    try {
      await del.mutateAsync(deleting.workCenterCode);
      setDeleting(null);
    } catch {
      /* greška se prikazuje u dijalogu */
    }
  }

  const columns: Column<Operation>[] = [
    {
      key: 'workCenterCode',
      header: 'Šifra',
      render: (r) => <span className="tnums font-semibold text-ink">{r.workCenterCode}</span>,
    },
    { key: 'workCenterName', header: 'Naziv', render: (r) => r.workCenterName },
    {
      key: 'workUnit',
      header: 'RJ',
      render: (r) => (
        <span className="text-ink-secondary">{r.workUnit?.name ?? r.workUnitCode}</span>
      ),
    },
    {
      key: 'withoutProcess',
      header: 'Bez postupka',
      align: 'right',
      render: (r) => (
        <span className="inline-flex justify-end">
          <FlagCell on={r.withoutProcess} />
        </span>
      ),
    },
    {
      key: 'significantForFinishing',
      header: 'Kraj postupka',
      align: 'right',
      render: (r) => (
        <span className="inline-flex justify-end">
          <FlagCell on={r.significantForFinishing} />
        </span>
      ),
    },
    {
      key: 'usesPriority',
      header: 'Prioritet',
      align: 'right',
      render: (r) => (
        <span className="inline-flex justify-end">
          <FlagCell on={r.usesPriority} />
        </span>
      ),
    },
    {
      key: 'isSkippable',
      header: 'Preskočiva',
      align: 'right',
      render: (r) => (
        <span className="inline-flex justify-end">
          <FlagCell on={r.isSkippable} />
        </span>
      ),
    },
    {
      key: 'workersWithAccess',
      header: 'Radnika',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="text-ink-secondary">{formatNumber(r.workersWithAccess)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <span className="inline-flex justify-end gap-1.5">
          {/* Sve mutirajuće akcije iza Can (obrazac workers-tab): read-only rola ne sme da vidi „Izmeni" pa dobije 403 na snimanju. */}
          <Can permission={PERMISSIONS.STRUKTURE_WRITE}>
            <button
              onClick={() => setEditing(r)}
              className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Izmeni
            </button>
            <button
              onClick={() => {
                del.reset();
                setDeleting(r);
              }}
              className="inline-flex items-center gap-1.5 rounded-control border border-status-danger px-2.5 py-1 text-xs font-semibold text-status-danger hover:bg-status-danger-bg"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Obriši
            </button>
          </Can>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Šifra ili naziv…"
          />
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Radna jedinica
            <NativeSelect
              value={workUnitCode}
              onChange={(e) => {
                setWorkUnitCode(e.target.value);
                resetPage();
              }}
              className="w-48"
            >
              <option value="">Sve</option>
              {(units.data?.data ?? []).map((u) => (
                <option key={u.id} value={u.code}>
                  {u.code} · {u.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <Can permission={PERMISSIONS.STRUKTURE_WRITE}>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova operacija
          </Button>
        </Can>
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
        empty={
          <EmptyState
            title="Nema operacija"
            hint="Promeni filtere ili dodaj operaciju dugmetom gore."
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

      <OperationFormDialog open={creating} operation={null} onClose={() => setCreating(false)} />
      <OperationFormDialog
        open={editing != null}
        operation={editing}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting != null}
        danger
        title="Brisanje operacije"
        message={
          <>
            Da li da obrišem operaciju <b>{deleting?.workCenterCode}</b> ·{' '}
            {deleting?.workCenterName}? Brisanje je moguće samo ako operacija nije referencirana
            (radni nalozi, pristup mašinama, kucanja, evidencija vremena).
          </>
        }
        confirmLabel="Obriši"
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
        loading={del.isPending}
        error={del.error}
      />
    </div>
  );
}
