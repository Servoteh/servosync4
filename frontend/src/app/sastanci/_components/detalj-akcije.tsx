'use client';

import { useMemo, useState } from 'react';
import { Check, Pencil, Play, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
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
import type { ProjekatIzbor } from './projekat-picker';

/**
 * Akcije jednog sastanka — grupisane po RN-u/projektu (paritet 1.0 sastanakDetalj/
 * akcijeTab): ⭐ prioritetni predmeti prvi, pa šifra; „Bez RN / projekta" poslednja;
 * redovi u grupi po prioritetu pa rb (S2; zvanični PDF/print i dalje ređaju po rb).
 */
export function DetaljAkcije({ sastanakId, canEdit }: { sastanakId: string; canEdit: boolean }) {
  const akcijeQ = useAkcije({ sastanakId });
  const prioQ = usePredmetPrioritet();
  const patchM = usePatchAkcija();
  const delM = useDeleteAkcija();
  const [modal, setModal] = useState<AkcijaRow | null | undefined>(undefined);
  // S6 — prefill projekta kad se „+ Zadatak" otvori iz zaglavlja grupe.
  const [prefill, setPrefill] = useState<ProjekatIzbor | null>(null);

  function openNova(projekat: ProjekatIzbor | null) {
    setPrefill(projekat);
    setModal(null);
  }

  const rows = useMemo(() => akcijeQ.data?.data ?? [], [akcijeQ.data]);
  const groups = useMemo(
    () => groupAkcijeByRn(rows, prioQ.data?.data, { rowSort: 'prioritet' }),
    [rows, prioQ.data],
  );

  const cols: Column<AkcijaRow>[] = [
    { key: 'status', header: 'Status', render: (r) => <AkcijaStatusBadge status={r.effective_status} /> },
    {
      key: 'naslov',
      header: 'Zadatak',
      render: (r) => (
        <span className="flex items-center gap-2">
          {/* Prioritet akcije — StatusBadge (S2): tone + labela iz kanonske mape. */}
          <StatusBadge
            tone={PRIORITET_TONE[r.prioritet] ?? 'neutral'}
            label={PRIORITET_LABEL[r.prioritet] ?? String(r.prioritet)}
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
            <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              {/* S3 — vidljiv tekst umesto golog ▷/✓. „Započni" se ne nudi ako je
                  akcija već u toku (redundantno). */}
              {r.effective_status !== 'zavrsen' && r.effective_status !== 'u_toku' && (
                <button title="Započni zadatak" className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'u_toku' } })}>
                  <Play className="h-3.5 w-3.5" aria-hidden /> Započni
                </button>
              )}
              {r.effective_status !== 'zavrsen' && (
                <button title="Završi zadatak" className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-status-success hover:bg-surface-2" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'zavrsen' } })}>
                  <Check className="h-3.5 w-3.5" aria-hidden /> Završi
                </button>
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
          <Button onClick={() => openNova(null)}>+ Nova akcija</Button>
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
                {/* S6 — „+ Zadatak" po grupi, prefill projektom te grupe („Bez RN /
                    projekta" → bez prefill-a). Paritet 1.0 „dodaj zadatak" u grupi. */}
                {canEdit && (
                  <button
                    type="button"
                    title="Dodaj zadatak u ovaj RN / projekat"
                    className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
                    onClick={() => openNova(g.key === '__none__' ? null : { id: g.key, code: g.code || null, naziv: g.naziv || null })}
                  >
                    + Zadatak
                  </button>
                )}
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
      {modal !== undefined && (
        <AkcijaModal
          edit={modal}
          sastanakId={sastanakId}
          initialProjekat={modal === null ? prefill : null}
          onClose={() => { setModal(undefined); setPrefill(null); }}
        />
      )}
    </div>
  );
}
