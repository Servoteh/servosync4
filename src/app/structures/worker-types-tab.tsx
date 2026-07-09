'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import {
  useWorkerTypes,
  useCreateWorkerType,
  useUpdateWorkerType,
  type WorkerType,
} from '@/api/structures';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Checkbox, ErrorText, FlagCell } from './common';

function WorkerTypeFormDialog({
  open,
  type,
  onClose,
}: {
  open: boolean;
  type: WorkerType | null;
  onClose: () => void;
}) {
  const isEdit = type != null;
  const [name, setName] = useState('');
  const [additionalPrivileges, setAdditionalPrivileges] = useState(false);
  const create = useCreateWorkerType();
  const update = useUpdateWorkerType();
  const mut = isEdit ? update : create;

  useEffect(() => {
    if (open) {
      setName(type?.name ?? '');
      setAdditionalPrivileges(type?.additionalPrivileges ?? false);
    }
  }, [open, type]);

  async function submit() {
    const data = { name: name.trim(), additionalPrivileges };
    try {
      if (isEdit) await update.mutateAsync({ id: type.id, data });
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
      title={isEdit ? 'Izmena vrste posla' : 'Nova vrsta posla'}
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
        <FormField label="Naziv" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tehnolog" />
        </FormField>
        <Checkbox
          checked={additionalPrivileges}
          onChange={setAdditionalPrivileges}
          label="Ima dodatna prava (npr. zatvaranje tuđih naloga)"
        />
        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

export function WorkerTypesTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<WorkerType | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useWorkerTypes({ page, q: q.trim() || undefined });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const columns: Column<WorkerType>[] = [
    {
      key: 'id',
      header: 'Šifra',
      render: (r) => <span className="tnums text-ink-secondary">{r.id}</span>,
    },
    {
      key: 'name',
      header: 'Naziv',
      render: (r) => <span className="font-semibold text-ink">{r.name}</span>,
    },
    {
      key: 'additionalPrivileges',
      header: 'Dodatna prava',
      render: (r) => <FlagCell on={r.additionalPrivileges} />,
    },
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
          placeholder="Naziv…"
        />
        <Can permission={PERMISSIONS.STRUKTURE_WRITE}>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova vrsta posla
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
        empty={<EmptyState title="Nema vrsta poslova" hint="Dodaj vrstu posla dugmetom gore." />}
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}

      <WorkerTypeFormDialog open={creating} type={null} onClose={() => setCreating(false)} />
      <WorkerTypeFormDialog
        open={editing != null}
        type={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
