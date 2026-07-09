'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import {
  usePositions,
  useCreatePosition,
  useUpdatePosition,
  type Position,
} from '@/api/part-locations';
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
import { ErrorText, errorBox } from './common';

function PositionFormDialog({
  open,
  position,
  onClose,
}: {
  open: boolean;
  position: Position | null;
  onClose: () => void;
}) {
  const isEdit = position != null;
  const [positionCode, setPositionCode] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreatePosition();
  const update = useUpdatePosition();
  const mut = isEdit ? update : create;

  useEffect(() => {
    if (open) {
      setPositionCode(position?.positionCode ?? '');
      setDescription(position?.description ?? '');
    }
  }, [open, position]);

  async function submit() {
    const data = {
      positionCode: positionCode.trim(),
      description: description.trim() || undefined,
    };
    try {
      if (isEdit) await update.mutateAsync({ id: position.id, data });
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
      title={isEdit ? 'Izmena pozicije/police' : 'Nova pozicija/polica'}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={mut.isPending} disabled={!positionCode.trim()}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Šifra" required hint="Do 20 karaktera.">
          <Input
            value={positionCode}
            onChange={(e) => setPositionCode(e.target.value)}
            maxLength={20}
            placeholder="A-01-03"
          />
        </FormField>
        <FormField label="Opis" hint="Do 250 karaktera, opciono.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={250}
            placeholder="Hala 1, red A, polica 3"
          />
        </FormField>
        <ErrorText error={mut.error} />
      </div>
    </Dialog>
  );
}

/**
 * "Pozicije/police" — matični CRUD šifarnik lokacija (Was: tPozicije,
 * MODULE_SPEC_lokacije §1/§5/§6). Jedini deo ove stranice koji nije read-only.
 */
export function PositionsTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Position | null>(null);
  const [creating, setCreating] = useState(false);
  const list = usePositions({ page, q: q.trim() || undefined });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const columns: Column<Position>[] = [
    {
      key: 'positionCode',
      header: 'Šifra',
      render: (r) => <span className="tnums font-semibold text-ink">{r.positionCode}</span>,
    },
    { key: 'description', header: 'Opis', render: (r) => r.description || '—' },
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
        <div className="flex flex-wrap items-center gap-3">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Šifra ili opis…"
          />
          <span className="text-sm text-ink-secondary">
            {meta ? `${formatNumber(meta.total)} pozicija` : ''}
          </span>
        </div>
        <Can permission={PERMISSIONS.LOKACIJE_WRITE}>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova pozicija
          </Button>
        </Can>
      </div>

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        empty={
          <EmptyState title="Nema pozicija/polica" hint="Dodaj poziciju dugmetom gore." />
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

      <PositionFormDialog open={creating} position={null} onClose={() => setCreating(false)} />
      <PositionFormDialog
        open={editing != null}
        position={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
