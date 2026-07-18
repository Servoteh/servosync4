'use client';

import { useMemo, useState } from 'react';
import { Pencil, Trash2, Check, X, Flame } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useDeleteTema,
  useSetTemaHitno,
  useSetTemaRazmatranje,
  useTeme,
  useUpdateTema,
  type PmTemaRow,
} from '@/api/sastanci';
import {
  formatDatum,
  INPUT_CLS,
  PRIORITET_LABEL,
  tableEmpty,
  TEMA_OBLASTI,
  TemaStatusBadge,
  TEMA_VRSTE,
} from './common';
import { Tabs, type TabItem } from './tabs';
import { TemaModal } from './tema-modal';

type SubKey = 'sve' | 'moje' | 'hitno' | 'razmatranje';

/** PM teme — životni ciklus + hitno/razmatranje/admin_rang (paritet 1.0 pmTemeTab). */
export function PmTemeTab({ myEmail }: { myEmail: string }) {
  const { can } = useAuth();
  const isAdmin = can(PERMISSIONS.SASTANCI_AI_MODEL); // paritet canPrioritizeTeme = admin
  const [sub, setSub] = useState<SubKey>('sve');
  const [q, setQ] = useState('');
  const [oblast, setOblast] = useState('');
  const [modalEdit, setModalEdit] = useState<PmTemaRow | null | undefined>(undefined);

  const params =
    sub === 'moje'
      ? { predlozioEmail: myEmail }
      : sub === 'hitno'
        ? { hitnoOnly: true }
        : sub === 'razmatranje'
          ? { razmatranjeOnly: true }
          : {};
  const temeQ = useTeme({ ...params, ...(oblast ? { oblast } : {}) });
  const updateM = useUpdateTema();
  const delM = useDeleteTema();
  const hitnoM = useSetTemaHitno();
  const razM = useSetTemaRazmatranje();

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = temeQ.data?.data ?? [];
    return t ? list.filter((x) => x.naslov.toLowerCase().includes(t)) : list;
  }, [temeQ.data, q]);

  const cols: Column<PmTemaRow>[] = [
    { key: 'status', header: 'Status', render: (r) => <TemaStatusBadge status={r.status} /> },
    {
      key: 'naslov',
      header: 'Naslov',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          {r.hitno && <span title="Hitno" className="text-status-danger" aria-hidden>🔥</span>}
          {r.za_razmatranje && <span title="Za razmatranje" aria-hidden>🎯</span>}
          <span className="font-medium">{r.naslov}</span>
        </span>
      ),
    },
    { key: 'vrsta', header: 'Vrsta / oblast', render: (r) => <span className="text-ink-secondary">{TEMA_VRSTE[r.vrsta] ?? r.vrsta} · {TEMA_OBLASTI[r.oblast] ?? r.oblast}</span> },
    { key: 'predl', header: 'Predložio', render: (r) => <span className="text-ink-secondary">{r.predlozio_label || r.predlozio_email}</span> },
    { key: 'pri', header: 'Pri.', render: (r) => <span className="text-ink-secondary">{PRIORITET_LABEL[r.prioritet] ?? r.prioritet}</span> },
    { key: 'datum', header: 'Datum', render: (r) => <span className="tnums text-ink-secondary">{formatDatum(r.predlozio_at)}</span> },
    {
      key: 'akcije',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconBtn title={r.hitno ? 'Skini hitno' : 'Označi hitno'} active={r.hitno} onClick={() => hitnoM.mutate({ id: r.id, hitno: !r.hitno })}>
            <Flame className="h-3.5 w-3.5" />
          </IconBtn>
          {isAdmin && (
            <>
              <IconBtn title={r.za_razmatranje ? 'Skini razmatranje' : 'Za razmatranje'} active={r.za_razmatranje} onClick={() => razM.mutate({ id: r.id, zaRazmatranje: !r.za_razmatranje })}>
                🎯
              </IconBtn>
              {r.status === 'predlog' && (
                <>
                  <IconBtn title="Usvoji" onClick={() => updateM.mutate({ id: r.id, patch: { status: 'usvojeno' } })}><Check className="h-3.5 w-3.5 text-status-success" /></IconBtn>
                  <IconBtn title="Odbij" onClick={() => { const n = prompt('Razlog odbijanja (opciono):') ?? undefined; updateM.mutate({ id: r.id, patch: { status: 'odbijeno', resioNapomena: n } }); }}><X className="h-3.5 w-3.5 text-status-danger" /></IconBtn>
                </>
              )}
            </>
          )}
          <IconBtn title="Izmeni" onClick={() => setModalEdit(r)}><Pencil className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn title="Obriši" danger onClick={() => { if (confirm('Obrisati temu?')) delM.mutate({ id: r.id }); }}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
        </div>
      ),
    },
  ];

  const subTabs: TabItem<SubKey>[] = [
    { key: 'sve', label: 'Sve teme' },
    { key: 'moje', label: 'Moje teme' },
    { key: 'hitno', label: 'Hitno' },
    { key: 'razmatranje', label: 'Za razmatranje' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs tabs={subTabs} value={sub} onChange={setSub} ariaLabel="PM teme" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className={`${INPUT_CLS} w-auto`} value={oblast} onChange={(e) => setOblast(e.target.value)}>
            <option value="">Sve oblasti</option>
            {Object.entries(TEMA_OBLASTI).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <SearchBox value={q} onChange={setQ} placeholder="Naslov teme…" />
          <Button onClick={() => setModalEdit(null)}>+ Nova tema</Button>
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={temeQ.isLoading}
        onRowActivate={(r) => setModalEdit(r)}
        empty={tableEmpty(temeQ.isError, 'Nema tema', 'Dodaj prvu temu dugmetom „Nova tema“.')}
      />

      {modalEdit !== undefined && <TemaModal edit={modalEdit} onClose={() => setModalEdit(undefined)} />}
    </div>
  );
}

function IconBtn({ title, onClick, active, danger, children }: { title: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-control border border-line p-1 text-xs hover:bg-surface-2 ${
        danger ? 'text-status-danger' : active ? 'border-status-warn/50 bg-status-warn-bg text-status-warn' : 'text-ink-secondary'
      }`}
    >
      {children}
    </button>
  );
}
