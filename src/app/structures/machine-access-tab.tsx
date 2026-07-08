'use client';

import { useEffect, useMemo, useState } from 'react';
import { ListPlus, Trash2 } from 'lucide-react';
import {
  useWorkers,
  useWorker,
  useOperations,
  useBatchMachineAccess,
  useDeleteMachineAccess,
} from '@/api/structures';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { cn } from '@/lib/cn';
import { Checkbox, ErrorText, ConfirmDialog } from './common';

interface AssignedRow {
  id: number;
  workCenterCode: string;
  name: string;
  workUnitCode: string;
}

// ---------------------------------------------------------------- dialog: dodela

function AssignDialog({
  open,
  workerId,
  currentCodes,
  onClose,
}: {
  open: boolean;
  workerId: number;
  currentCodes: string[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const ops = useOperations({ pageSize: 200, q: q.trim() || undefined });
  const batch = useBatchMachineAccess();

  useEffect(() => {
    if (open) {
      setChecked(new Set(currentCodes));
      setQ('');
    }
  }, [open, currentCodes]);

  const rows = ops.data?.data ?? [];

  function toggle(code: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  async function submit() {
    const current = new Set(currentCodes);
    const add = [...checked].filter((c) => !current.has(c));
    const remove = currentCodes.filter((c) => !checked.has(c));
    if (add.length === 0 && remove.length === 0) {
      onClose();
      return;
    }
    try {
      await batch.mutateAsync({ workerId, add, remove });
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodeli operacije"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={batch.isPending}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <SearchBox value={q} onChange={setQ} placeholder="Šifra ili naziv operacije…" />
        <p className="text-xs text-ink-disabled">
          Označeno: <span className="tnums">{checked.size}</span> operacija.
        </p>
        <div className="max-h-72 space-y-0.5 overflow-auto rounded-control border border-line bg-surface p-1">
          {ops.isLoading ? (
            <div className="px-2 py-6 text-center text-sm text-ink-disabled">Učitavanje…</div>
          ) : rows.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-ink-disabled">Nema operacija.</div>
          ) : (
            rows.map((op) => (
              <div key={op.id} className="rounded-control px-2 py-1 hover:bg-surface-2">
                <Checkbox
                  checked={checked.has(op.workCenterCode)}
                  onChange={(v) => toggle(op.workCenterCode, v)}
                  label={
                    <span className="flex items-baseline gap-2">
                      <span className="tnums font-semibold text-ink">{op.workCenterCode}</span>
                      <span className="text-ink-secondary">{op.workCenterName}</span>
                      <span className="text-xs text-ink-disabled">
                        {op.workUnit?.name ?? op.workUnitCode}
                      </span>
                    </span>
                  }
                />
              </div>
            ))
          )}
        </div>
        <ErrorText error={batch.error} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- desni panel

function AssignedPanel({ workerId }: { workerId: number }) {
  const q = useWorker(workerId);
  const del = useDeleteMachineAccess();
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<AssignedRow | null>(null);

  const assigned: AssignedRow[] = useMemo(
    () =>
      (q.data?.data.machineAccess ?? []).map((m) => ({
        id: m.id,
        workCenterCode: m.workCenterCode,
        name: m.operation?.workCenterName ?? '—',
        workUnitCode: m.operation?.workUnitCode ?? '—',
      })),
    [q.data],
  );
  const currentCodes = useMemo(() => assigned.map((a) => a.workCenterCode), [assigned]);

  const columns: Column<AssignedRow>[] = [
    {
      key: 'workCenterCode',
      header: 'Šifra',
      render: (r) => <span className="tnums font-semibold text-ink">{r.workCenterCode}</span>,
    },
    { key: 'name', header: 'Operacija', render: (r) => r.name },
    { key: 'workUnitCode', header: 'RJ', render: (r) => <span className="text-ink-secondary">{r.workUnitCode}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={() => setRemoving(r)}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-status-danger hover:bg-status-danger-bg"
          aria-label={`Ukloni ${r.workCenterCode}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Ukloni
        </button>
      ),
    },
  ];

  async function doRemove() {
    if (!removing) return;
    try {
      await del.mutateAsync(removing.id);
      setRemoving(null);
    } catch {
      /* greška se prikazuje u dijalogu */
    }
  }

  if (q.isLoading)
    return <div className="p-6 text-sm text-ink-disabled">Učitavanje…</div>;
  if (q.error || !q.data)
    return <div className="p-6 text-sm text-status-danger">Greška pri učitavanju radnika.</div>;
  const w = q.data.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-ink">{w.fullName || w.username}</p>
          <p className="text-xs text-ink-secondary">
            {w.workerType?.name ?? '—'} · {w.workUnit?.name ?? w.workUnitCode}
          </p>
        </div>
        <Button onClick={() => setAssigning(true)}>
          <ListPlus className="h-4 w-4" aria-hidden />
          Dodeli operacije
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={assigned}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title="Nema dodeljenih operacija"
            hint="Klikni „Dodeli operacije“ i označi operacije koje radnik sme."
          />
        }
      />

      <AssignDialog
        open={assigning}
        workerId={workerId}
        currentCodes={currentCodes}
        onClose={() => setAssigning(false)}
      />
      <ConfirmDialog
        open={removing != null}
        danger
        title="Uklanjanje operacije"
        message={
          removing ? (
            <>
              Ukloniti operaciju <b>{removing.workCenterCode}</b> ({removing.name}) sa radnika{' '}
              <b>{w.fullName || w.username}</b>?
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Ukloni"
        onConfirm={doRemove}
        onCancel={() => setRemoving(null)}
        loading={del.isPending}
        error={del.error}
      />
    </div>
  );
}

// ---------------------------------------------------------------- tab

export function MachineAccessTab() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const list = useWorkers({ pageSize: 200, active: 'true', q: q.trim() || undefined });
  const workers = list.data?.data ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* Leva kolona — izbor radnika */}
      <div className="space-y-3">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Radnik (ime / korisničko ime)…"
        />
        {list.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}
        <div className="max-h-[60vh] overflow-auto rounded-panel border border-line bg-surface">
          {list.isLoading ? (
            <div className="px-3 py-6 text-center text-sm text-ink-disabled">Učitavanje…</div>
          ) : workers.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-ink-disabled">Nema radnika.</div>
          ) : (
            <ul className="divide-y divide-line-soft">
              {workers.map((wk) => {
                const isSel = wk.id === selected;
                return (
                  <li key={wk.id}>
                    <button
                      onClick={() => setSelected(wk.id)}
                      className={cn(
                        'flex w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-2',
                        isSel && 'bg-accent-subtle shadow-[inset_3px_0_0_var(--accent)]',
                      )}
                    >
                      <span className="text-base font-medium text-ink">
                        {wk.fullName || wk.username}
                      </span>
                      <span className="text-xs text-ink-secondary">
                        {wk.workUnit?.name ?? wk.workUnitCode}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Desna kolona — dodeljene operacije */}
      <div className="rounded-panel border border-line bg-surface p-4">
        {selected == null ? (
          <EmptyState
            title="Izaberi radnika"
            hint="Klikni radnika u listi levo da vidiš i menjaš dodeljene operacije."
          />
        ) : (
          <AssignedPanel workerId={selected} />
        )}
      </div>
    </div>
  );
}
