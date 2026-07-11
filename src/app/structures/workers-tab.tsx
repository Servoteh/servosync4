'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, UserCheck, UserX } from 'lucide-react';
import {
  useWorkers,
  useWorker,
  useCreateWorker,
  useUpdateWorker,
  useDeactivateWorker,
  useDeleteWorker,
  useWorkUnits,
  useWorkerTypes,
  type Worker,
  type WorkerDetail,
  type WorkerInput,
  type WorkerActiveFilter,
} from '@/api/structures';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatNumber } from '@/lib/format';
import { Checkbox, ConfirmDialog, ErrorText, NativeSelect } from './common';

/** Pilule za prava (saglasnost / lansiranje). */
function PermissionPills({ w }: { w: Pick<Worker, 'definesApproval' | 'definesLaunch'> }) {
  if (!w.definesApproval && !w.definesLaunch)
    return <span className="text-ink-disabled">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {w.definesApproval && <StatusBadge tone="success" label="Saglasnost" />}
      {w.definesLaunch && <StatusBadge tone="info" label="Lansiranje" />}
    </span>
  );
}

const columns: Column<Worker>[] = [
  {
    key: 'idNumber',
    header: 'Šifra',
    render: (r) => <span className="tnums text-ink-secondary">{r.idNumber || '—'}</span>,
  },
  {
    key: 'fullName',
    header: 'Ime i prezime',
    render: (r) => <span className="font-semibold text-ink">{r.fullName || '—'}</span>,
  },
  {
    key: 'username',
    header: 'Korisničko ime',
    render: (r) => <span className="text-ink-secondary">{r.username}</span>,
  },
  {
    key: 'workUnit',
    header: 'RJ',
    render: (r) => r.workUnit?.name ?? r.workUnitCode ?? '—',
  },
  {
    key: 'workerType',
    header: 'Vrsta posla',
    render: (r) => r.workerType?.name ?? '—',
  },
  {
    key: 'active',
    header: 'Aktivan',
    render: (r) =>
      r.active ? (
        <StatusBadge tone="success" label="Aktivan" />
      ) : (
        <StatusBadge tone="neutral" label="Neaktivan" />
      ),
  },
  // Kolona „Prava" je namerno sklonjena iz tabele (Nenad 10.07) — flagovi
  // saglasnost/lansiranje ostaju vidljivi u expand-detalju i formi.
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- detalj (expand)

function WorkerDetailRow({ id }: { id: number }) {
  const q = useWorker(id);
  const deactivate = useDeactivateWorker();
  const activate = useUpdateWorker();
  const del = useDeleteWorker();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const w = q.data.data;

  async function doDeactivate() {
    try {
      await deactivate.mutateAsync(w.id);
      setConfirming(false);
    } catch {
      /* greška se prikazuje u dijalogu */
    }
  }

  async function doActivate() {
    try {
      await activate.mutateAsync({ id: w.id, data: { active: true } });
    } catch {
      /* greška se prikazuje ispod dugmadi */
    }
  }

  async function doDelete() {
    try {
      await del.mutateAsync(w.id);
      setConfirmingDelete(false);
    } catch {
      /* greška (409 „ima istoriju") se prikazuje u dijalogu */
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PermissionPills w={w} />
        {w.multiAccount && <StatusBadge tone="neutral" label="Više naloga" />}
        <span className="flex-1" />
        <Can permission={PERMISSIONS.STRUKTURE_WRITE}>
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Izmeni
          </button>
          {w.active ? (
            <button
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-control border border-status-danger px-3 py-1.5 text-xs font-semibold text-status-danger hover:bg-status-danger-bg"
            >
              <UserX className="h-3.5 w-3.5" aria-hidden />
              Deaktiviraj
            </button>
          ) : (
            <button
              onClick={doActivate}
              disabled={activate.isPending}
              className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
            >
              <UserCheck className="h-3.5 w-3.5" aria-hidden />
              Aktiviraj
            </button>
          )}
          <button
            onClick={() => {
              del.reset();
              setConfirmingDelete(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-control border border-status-danger px-3 py-1.5 text-xs font-semibold text-status-danger hover:bg-status-danger-bg"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Obriši
          </button>
        </Can>
      </div>
      <ErrorText error={activate.error} />

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Šifra" value={w.idNumber || '—'} />
        <Field label="ID kartice" value={w.cardId || '—'} />
        <Field label="Login nalog" value={w.loginAccount || '—'} />
        <Field label="Vrsta posla" value={w.workerType?.name ?? '—'} />
        <Field label="Radna jedinica" value={w.workUnit?.name ?? w.workUnitCode} />
        <Field label="Provizija" value={`${formatNumber(w.commissionPercent ?? 0)} %`} />
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Dodeljene operacije ({w.machineAccess.length})
        </p>
        {w.machineAccess.length === 0 ? (
          <span className="text-sm text-ink-disabled">
            Nema dodeljenih operacija (dodeli ih na tabu „Radnici po mašinama“).
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {w.machineAccess.map((m) => (
              <span
                key={m.id}
                className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary"
                title={m.operation?.workCenterName ?? undefined}
              >
                <span className="tnums">{m.workCenterCode}</span>
                {m.operation?.workCenterName ? ` · ${m.operation.workCenterName}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      <WorkerFormDialog open={editing} worker={w} onClose={() => setEditing(false)} />
      <ConfirmDialog
        open={confirming}
        danger
        title="Deaktivacija radnika"
        message={
          <>
            Da li da deaktiviram radnika <b>{w.fullName || w.username}</b>? Radnik ostaje u bazi
            (soft delete) i može se ponovo aktivirati izmenom.
          </>
        }
        confirmLabel="Deaktiviraj"
        onConfirm={doDeactivate}
        onCancel={() => setConfirming(false)}
        loading={deactivate.isPending}
        error={deactivate.error}
      />
      <ConfirmDialog
        open={confirmingDelete}
        danger
        title="Brisanje radnika"
        message={
          <>
            Da li da obrišem radnika <b>{w.fullName || w.username}</b>? Brisanje je moguće samo za
            pogrešan unos — radnik bez ijednog kucanja, naloga ili druge istorije. Radnika sa
            istorijom deaktiviraj umesto brisanja.
          </>
        }
        confirmLabel="Obriši"
        onConfirm={doDelete}
        onCancel={() => setConfirmingDelete(false)}
        loading={del.isPending}
        error={del.error}
      />
    </div>
  );
}

// ---------------------------------------------------------------- forma (Novi / Izmeni)

interface WorkerFormState {
  username: string;
  fullName: string;
  idNumber: string;
  cardId: string;
  loginAccount: string;
  workUnitCode: string;
  workerTypeId: number | '';
  definesApproval: boolean;
  definesLaunch: boolean;
  multiAccount: boolean;
  commissionPercent: string;
  active: boolean;
}

function toFormState(w: WorkerDetail | null): WorkerFormState {
  return {
    username: w?.username ?? '',
    fullName: w?.fullName ?? '',
    idNumber: w?.idNumber ?? '',
    cardId: w?.cardId ?? '',
    loginAccount: w?.loginAccount ?? '',
    workUnitCode: w?.workUnitCode ?? '',
    workerTypeId: w?.workerTypeId ?? '',
    definesApproval: w?.definesApproval ?? false,
    definesLaunch: w?.definesLaunch ?? false,
    multiAccount: w?.multiAccount ?? false,
    commissionPercent: w != null ? String(w.commissionPercent ?? 0) : '',
    active: w?.active ?? true,
  };
}

function WorkerFormDialog({
  open,
  worker,
  onClose,
}: {
  open: boolean;
  worker: WorkerDetail | null;
  onClose: () => void;
}) {
  const isEdit = worker != null;
  const [form, setForm] = useState<WorkerFormState>(() => toFormState(worker));
  const units = useWorkUnits({ pageSize: 200 });
  const types = useWorkerTypes({ pageSize: 200 });
  const create = useCreateWorker();
  const update = useUpdateWorker();
  const mut = isEdit ? update : create;

  // Reset forme kad se dijalog otvori (ili se promeni radnik koji se menja).
  useEffect(() => {
    if (open) setForm(toFormState(worker));
  }, [open, worker]);

  const set = (patch: Partial<WorkerFormState>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const payload: WorkerInput = {
      username: form.username.trim(),
      fullName: form.fullName.trim() || undefined,
      idNumber: form.idNumber.trim() || undefined,
      cardId: form.cardId.trim() || undefined,
      loginAccount: form.loginAccount.trim() || undefined,
      workUnitCode: form.workUnitCode || undefined,
      workerTypeId: form.workerTypeId === '' ? undefined : Number(form.workerTypeId),
      definesApproval: form.definesApproval,
      definesLaunch: form.definesLaunch,
      multiAccount: form.multiAccount,
      commissionPercent:
        form.commissionPercent === '' ? undefined : Number(form.commissionPercent),
      active: form.active,
    };
    try {
      if (isEdit) await update.mutateAsync({ id: worker.id, data: payload });
      else await create.mutateAsync(payload);
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Izmena radnika' : 'Novi radnik'}
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
          <FormField label="Korisničko ime" required>
            <Input value={form.username} onChange={(e) => set({ username: e.target.value })} />
          </FormField>
          <FormField label="Ime i prezime">
            <Input value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra">
            <Input value={form.idNumber} onChange={(e) => set({ idNumber: e.target.value })} />
          </FormField>
          <FormField label="ID kartice">
            <Input value={form.cardId} onChange={(e) => set({ cardId: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Radna jedinica">
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
          <FormField label="Vrsta posla">
            <NativeSelect
              value={form.workerTypeId === '' ? '' : String(form.workerTypeId)}
              onChange={(e) =>
                set({ workerTypeId: e.target.value === '' ? '' : Number(e.target.value) })
              }
            >
              <option value="">— izaberi —</option>
              {(types.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Login nalog">
            <Input
              value={form.loginAccount}
              onChange={(e) => set({ loginAccount: e.target.value })}
            />
          </FormField>
          <FormField label="Provizija (%)">
            <Input
              type="number"
              value={form.commissionPercent}
              onChange={(e) => set({ commissionPercent: e.target.value })}
            />
          </FormField>
        </div>

        <div className="space-y-2 rounded-control border border-line bg-surface-2/40 px-3 py-2.5">
          <Checkbox
            checked={form.definesApproval}
            onChange={(v) => set({ definesApproval: v, definesLaunch: v ? form.definesLaunch : false })}
            label="Definiše saglasnost (primopredaje)"
          />
          <Checkbox
            checked={form.definesLaunch}
            disabled={!form.definesApproval}
            onChange={(v) => set({ definesLaunch: v })}
            label="Definiše lansiranje RN"
          />
          <p className="pl-6 text-xs text-ink-disabled">
            Saglasnost mogu imati samo radnici vrste „Tehnolog“ ili „Inžinjer“; lansiranje zahteva
            saglasnost.
          </p>
          <Checkbox
            checked={form.multiAccount}
            onChange={(v) => set({ multiAccount: v })}
            label="Može imati više login naloga"
          />
          <Checkbox
            checked={form.active}
            onChange={(v) => set({ active: v })}
            label="Aktivan"
          />
        </div>

        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- tab

export function WorkersTab() {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<WorkerActiveFilter>('true');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useWorkers({ page, q: q.trim() || undefined, active });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const resetPage = () => setPage(1);

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
            placeholder="Ime, korisničko ime, kartica…"
          />
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <NativeSelect
              value={active}
              onChange={(e) => {
                setActive(e.target.value as WorkerActiveFilter);
                resetPage();
              }}
              className="w-40"
            >
              <option value="true">Aktivni</option>
              <option value="false">Neaktivni</option>
              <option value="all">Svi</option>
            </NativeSelect>
          </label>
        </div>
        <Can permission={PERMISSIONS.STRUKTURE_WRITE}>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Novi radnik
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
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <WorkerDetailRow id={r.id} />}
        empty={
          <EmptyState
            title="Nema radnika"
            hint="Promeni filtere ili dodaj radnika dugmetom „Novi radnik“."
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

      <WorkerFormDialog open={creating} worker={null} onClose={() => setCreating(false)} />
    </div>
  );
}
