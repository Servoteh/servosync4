'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useLocations, useUpdateLocation, type LocLocation } from '@/api/lokacije';
import { LocTypeBadge, tableEmpty } from './common';
import { LocationFormDialog } from './location-form-dialog';
import { CageMoveDialog } from './cage-move-dialog';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

type Kind = '' | 'hall' | 'shelf' | 'cage' | 'machine';

/** Browse šifarnika lokacija (hijerarhija po path_cached) + manage akcije. */
export function LokacijeTab() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('');
  const [active, setActive] = useState<'true' | 'all' | 'false'>('true');
  const [page, setPage] = useState(1);
  const pageSize = 200;

  const [form, setForm] = useState<{ edit?: LocLocation | null } | null>(null);
  const [cage, setCage] = useState<LocLocation | null>(null);

  const update = useUpdateLocation();
  const query = useLocations({
    q: q || undefined,
    kind: kind || undefined,
    active,
    page,
    pageSize,
  });
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta.pagination;

  function toggleActive(loc: LocLocation) {
    update.mutate({ id: loc.id, isActive: !loc.isActive });
  }

  const columns: Column<LocLocation>[] = [
    {
      key: 'code',
      header: 'Šifra',
      render: (r) => (
        <span className="font-medium" style={{ paddingLeft: `${Math.min(r.depth, 6) * 12}px` }}>
          {r.locationCode}
        </span>
      ),
    },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'type', header: 'Tip', render: (r) => <LocTypeBadge type={r.locationType} /> },
    { key: 'path', header: 'Putanja', render: (r) => <span className="text-xs text-ink-secondary">{r.pathCached || '—'}</span> },
    {
      key: 'active',
      header: 'Status',
      render: (r) => (
        <span className={r.isActive ? 'text-status-success' : 'text-ink-disabled'}>{r.isActive ? 'Aktivna' : 'Neaktivna'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <Can permission={PERMISSIONS.LOKACIJE_MANAGE}>
          <div className="flex justify-end gap-1.5">
            {r.locationType === 'CAGE' && (
              <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setCage(r); }}>
                Premesti kavez
              </button>
            )}
            <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setForm({ edit: r }); }}>
              Izmeni
            </button>
            <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); toggleActive(r); }}>
              {r.isActive ? 'Deaktiviraj' : 'Aktiviraj'}
            </button>
          </div>
        </Can>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${INPUT} min-w-56`} placeholder="Pretraga (šifra / naziv / putanja)…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className={INPUT} value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPage(1); }}>
          <option value="">Sve vrste</option>
          <option value="hall">Hale</option>
          <option value="shelf">Police / regali</option>
          <option value="cage">Kavezi</option>
          <option value="machine">Mašine</option>
        </select>
        <select className={INPUT} value={active} onChange={(e) => { setActive(e.target.value as typeof active); setPage(1); }}>
          <option value="true">Samo aktivne</option>
          <option value="all">Sve</option>
          <option value="false">Samo neaktivne</option>
        </select>
        <Can permission={PERMISSIONS.LOKACIJE_MANAGE}>
          <Button className="ml-auto" onClick={() => setForm({ edit: null })}>
            <Plus className="h-4 w-4" /> Nova lokacija
          </Button>
        </Can>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={query.isLoading}
        empty={tableEmpty(query.isError, 'Nema lokacija', 'Promeni filtere ili dodaj novu lokaciju.')}
      />

      {meta && meta.totalPages > 1 && (
        <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
      )}

      {form && <LocationFormDialog edit={form.edit} onClose={() => setForm(null)} />}
      {cage && <CageMoveDialog cage={cage} onClose={() => setCage(null)} />}
    </div>
  );
}
