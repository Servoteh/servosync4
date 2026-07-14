'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  useEmployees,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { DosijeDialog } from './dossier';

export function ZaposleniTab() {
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const listQ = useEmployees({ q: q || undefined, active: onlyActive || undefined, page, pageSize: 25 });
  const rows = listQ.data?.data ?? [];
  const total = listQ.data?.meta.pagination.total ?? 0;
  const totalPages = listQ.data?.meta.pagination.totalPages ?? 1;

  const columns: Column<EmployeeSafe>[] = [
    {
      key: 'name',
      header: 'Ime i prezime',
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.full_name}</div>
          <div className="text-xs text-ink-secondary">{[r.email, r.phone_work].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'position', header: 'Pozicija', render: (r) => r.position || '—' },
    { key: 'department', header: 'Odeljenje', render: (r) => r.department || '—' },
    { key: 'team', header: 'Tim', render: (r) => r.team || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.is_active ? <StatusBadge tone="success" label="Aktivan" /> : <StatusBadge tone="neutral" label="Neaktivan" />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Pretraga po imenu, poziciji, email-u…"
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => {
              setOnlyActive(e.target.checked);
              setPage(1);
            }}
          />
          Samo aktivni
        </label>
        <span className="ml-auto text-sm text-ink-secondary">{total} zaposlenih</span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={listQ.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        empty={<EmptyState title="Nema zaposlenih" hint="Promenite pretragu ili filter." />}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            ‹ Prethodna
          </Button>
          <span className="text-sm text-ink-secondary">
            {page} / {totalPages}
          </span>
          <Button variant="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            Sledeća ›
          </Button>
        </div>
      )}

      {openId && <DosijeDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
