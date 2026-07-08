'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import {
  useWorkUnits,
  useCreateWorkUnit,
  useUpdateWorkUnit,
  type WorkUnit,
} from '@/api/structures';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ErrorText } from './common';

function WorkUnitFormDialog({
  open,
  unit,
  onClose,
}: {
  open: boolean;
  unit: WorkUnit | null;
  onClose: () => void;
}) {
  const isEdit = unit != null;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useCreateWorkUnit();
  const update = useUpdateWorkUnit();
  const mut = isEdit ? update : create;

  useEffect(() => {
    if (open) {
      setCode(unit?.code ?? '');
      setName(unit?.name ?? '');
    }
  }, [open, unit]);

  async function submit() {
    const data = { code: code.trim(), name: name.trim() };
    try {
      if (isEdit) await update.mutateAsync({ id: unit.id, data });
      else await create.mutateAsync(data);
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Izmena radne jedinice' : 'Nova radna jedinica'}
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
        <FormField label="Šifra" required>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="01" />
        </FormField>
        <FormField label="Naziv" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sečenje" />
        </FormField>
        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

export function WorkUnitsTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<WorkUnit | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useWorkUnits({ page, q: q.trim() || undefined });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const columns: Column<WorkUnit>[] = [
    {
      key: 'code',
      header: 'Šifra',
      render: (r) => <span className="tnums font-semibold text-ink">{r.code}</span>,
    },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          onClick={() => setEditing(r)}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Izmeni
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Šifra ili naziv…"
        />
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Nova radna jedinica
        </Button>
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
        empty={<EmptyState title="Nema radnih jedinica" hint="Dodaj RJ dugmetom gore." />}
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}

      <WorkUnitFormDialog open={creating} unit={null} onClose={() => setCreating(false)} />
      <WorkUnitFormDialog open={editing != null} unit={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
