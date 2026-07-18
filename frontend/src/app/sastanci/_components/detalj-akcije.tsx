'use client';

import { useMemo, useState } from 'react';
import { Check, Pencil, Play, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import {
  useAkcije,
  useDeleteAkcija,
  usePatchAkcija,
  usePredmetPrioritet,
  type AkcijaRow,
} from '@/api/sastanci';
import {
  AkcijaStatusBadge,
  formatDatum,
  groupAkcijeByRn,
  PRIORITET_LABEL,
  PRIORITET_TONE,
  tableEmpty,
} from './common';
import { AkcijaModal } from './akcija-modal';

/**
 * Akcije jednog sastanka — grupisane po RN-u/projektu (paritet 1.0 sastanakDetalj/
 * akcijeTab): ⭐ prioritetni predmeti prvi, pa šifra; „Bez RN / projekta" poslednja;
 * redovi u grupi po rb (ručni redosled).
 */
export function DetaljAkcije({ sastanakId, canEdit }: { sastanakId: string; canEdit: boolean }) {
  const akcijeQ = useAkcije({ sastanakId });
  const prioQ = usePredmetPrioritet();
  const patchM = usePatchAkcija();
  const delM = useDeleteAkcija();
  const [modal, setModal] = useState<AkcijaRow | null | undefined>(undefined);

  const rows = useMemo(() => akcijeQ.data?.data ?? [], [akcijeQ.data]);
  const groups = useMemo(
    () => groupAkcijeByRn(rows, prioQ.data?.data, { rowSort: 'rb' }),
    [rows, prioQ.data],
  );

  const cols: Column<AkcijaRow>[] = [
    { key: 'status', header: 'Status', render: (r) => <AkcijaStatusBadge status={r.effective_status} /> },
    {
      key: 'naslov',
      header: 'Zadatak',
      render: (r) => (
        <span className="flex items-start gap-1.5">
          {/* Prioritet akcije — boja tačke kao kanban (PRIORITET_TONE). */}
          <span
            className={cn(
              'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
              PRIORITET_TONE[r.prioritet] === 'danger'
                ? 'bg-status-danger'
                : PRIORITET_TONE[r.prioritet] === 'warn'
                  ? 'bg-status-warn'
                  : 'bg-status-neutral',
            )}
            title={`Prioritet: ${PRIORITET_LABEL[r.prioritet] ?? r.prioritet}`}
          />
          <span className="font-medium">{r.naslov}</span>
        </span>
      ),
    },
    { key: 'odg', header: 'Odgovoran', render: (r) => <span className="text-ink-secondary">{r.odgovoran_label || r.odgovoran_text || r.odgovoran_email || '—'}</span> },
    { key: 'rok', header: 'Rok', render: (r) => <span className={`tnums ${r.effective_status === 'kasni' ? 'text-status-danger' : 'text-ink-secondary'}`}>{r.rok_text || formatDatum(r.rok)}</span> },
    ...(canEdit
      ? [{
          key: 'akcije',
          header: '',
          render: (r: AkcijaRow) => (
            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              {r.effective_status !== 'zavrsen' && (
                <>
                  <button title="Započni" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'u_toku' } })}><Play className="h-3.5 w-3.5" /></button>
                  <button title="Završi" className="rounded-control border border-line p-1 text-status-success hover:bg-surface-2" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'zavrsen' } })}><Check className="h-3.5 w-3.5" /></button>
                </>
              )}
              <button title="Izmeni" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setModal(r)}><Pencil className="h-3.5 w-3.5" /></button>
              <button title="Obriši" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { if (confirm('Obrisati akciju?')) delM.mutate({ id: r.id }); }}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setModal(null)}>+ Nova akcija</Button>
        </div>
      )}
      {groups.length > 0 ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key}>
              <div className="mb-1 flex flex-wrap items-baseline gap-2 rounded-panel border border-line bg-surface-2 px-4 py-2">
                {g.code && <span className="text-sm font-semibold text-accent">{g.code}</span>}
                <span className="text-sm font-medium text-ink">{g.naziv || '—'}</span>
                <span className="tnums ml-auto text-xs text-ink-secondary">
                  {g.rows.filter((a) => ['otvoren', 'u_toku', 'kasni'].includes(a.effective_status)).length} aktivnih
                  {' · '}
                  {g.rows.length} ukupno
                </span>
              </div>
              <DataTable
                columns={cols}
                rows={g.rows}
                rowKey={(r) => r.id}
                onRowActivate={canEdit ? (r) => setModal(r) : undefined}
              />
            </section>
          ))}
        </div>
      ) : (
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          loading={akcijeQ.isLoading}
          empty={tableEmpty(akcijeQ.isError, 'Nema akcija', 'Zadaci sa ovog sastanka pojaviće se ovde.')}
        />
      )}
      {modal !== undefined && <AkcijaModal edit={modal} sastanakId={sastanakId} onClose={() => setModal(undefined)} />}
    </div>
  );
}
