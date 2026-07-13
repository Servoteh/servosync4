'use client';

import { useState } from 'react';
import { Check, Pencil, Play, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { useAkcije, useDeleteAkcija, usePatchAkcija, type AkcijaRow } from '@/api/sastanci';
import { AkcijaStatusBadge, formatDatum, tableEmpty } from './common';
import { AkcijaModal } from './akcija-modal';

/** Akcije jednog sastanka (paritet 1.0 sastanakDetalj/akcijeTab — osnovni tok). */
export function DetaljAkcije({ sastanakId, canEdit }: { sastanakId: string; canEdit: boolean }) {
  const akcijeQ = useAkcije({ sastanakId });
  const patchM = usePatchAkcija();
  const delM = useDeleteAkcija();
  const [modal, setModal] = useState<AkcijaRow | null | undefined>(undefined);

  const rows = akcijeQ.data?.data ?? [];

  const cols: Column<AkcijaRow>[] = [
    { key: 'status', header: 'Status', render: (r) => <AkcijaStatusBadge status={r.effective_status} /> },
    { key: 'naslov', header: 'Zadatak', render: (r) => <span className="font-medium">{r.naslov}</span> },
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
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={akcijeQ.isLoading}
        onRowActivate={canEdit ? (r) => setModal(r) : undefined}
        empty={tableEmpty(akcijeQ.isError, 'Nema akcija', 'Zadaci sa ovog sastanka pojaviće se ovde.')}
      />
      {modal !== undefined && <AkcijaModal edit={modal} sastanakId={sastanakId} onClose={() => setModal(undefined)} />}
    </div>
  );
}
