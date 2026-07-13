'use client';

import { useMemo, useState } from 'react';
import { History, Pencil, Play, Check, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useAkcije,
  useAkcijaIstorija,
  useAkcijeWeeklyDiff,
  useBulkStatusAkcije,
  useDeleteAkcija,
  usePatchAkcija,
  type AkcijaRow,
} from '@/api/sastanci';
import {
  AKCIJA_SETTABLE_STATUSI,
  AKCIJA_STATUS_LABEL,
  AkcijaStatusBadge,
  formatDatum,
  INPUT_CLS,
  tableEmpty,
} from './common';
import { formatDateTime } from '@/lib/format';
import { Tabs, type TabItem } from './tabs';
import { AkcijaModal } from './akcija-modal';
import { AkcioniKanban } from './akcioni-kanban';

type ViewKey = 'lista' | 'kanban';

/** Akcioni plan: tabela + kanban + bulk status + weekly diff + istorija (paritet 1.0). */
export function AkcioniPlanTab({ myEmail }: { myEmail: string }) {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.SASTANCI_EDIT);
  const [view, setView] = useState<ViewKey>('lista');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [samoMoje, setSamoMoje] = useState(false);
  const [prikaziZavrseno, setPrikaziZavrseno] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState('u_toku');
  const [modalEdit, setModalEdit] = useState<AkcijaRow | null | undefined>(undefined);
  const [istorijaFor, setIstorijaFor] = useState<string | null>(null);

  const akcijeQ = useAkcije(samoMoje ? { odgovoranEmail: myEmail } : {});
  const patchM = usePatchAkcija();
  const delM = useDeleteAkcija();
  const bulkM = useBulkStatusAkcije();

  // Weekly diff — since = pre 7 dana (aproks. „ove nedelje"; 1.0 = od poslednjeg zaključanog).
  const since = useMemo(() => new Date(Date.now() - 7 * 864e5).toISOString(), []);
  const diff = useAkcijeWeeklyDiff({ since });
  const d = diff.data?.data;

  const rows = useMemo(() => {
    let list = akcijeQ.data?.data ?? [];
    if (status) list = list.filter((a) => a.effective_status === status);
    else if (!prikaziZavrseno) list = list.filter((a) => a.effective_status !== 'zavrsen');
    const t = q.trim().toLowerCase();
    if (t) list = list.filter((a) => a.naslov.toLowerCase().includes(t) || (a.opis ?? '').toLowerCase().includes(t));
    return list;
  }, [akcijeQ.data, status, prikaziZavrseno, q]);

  function toggleSel(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function applyBulk() {
    if (!sel.size) return;
    await bulkM.mutateAsync({ ids: [...sel], status: bulkStatus });
    setSel(new Set());
  }

  const cols: Column<AkcijaRow>[] = [
    ...(canEdit
      ? [{
          key: 'sel',
          header: '',
          render: (r: AkcijaRow) => (
            <input
              type="checkbox"
              checked={sel.has(r.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleSel(r.id)}
              aria-label="Izaberi"
            />
          ),
        }]
      : []),
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
                  <IconBtn title="Započni" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'u_toku' } })}><Play className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn title="Završi" onClick={() => patchM.mutate({ id: r.id, patch: { status: 'zavrsen' } })}><Check className="h-3.5 w-3.5" /></IconBtn>
                </>
              )}
              <IconBtn title="Istorija" onClick={() => setIstorijaFor(r.id)}><History className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn title="Izmeni" onClick={() => setModalEdit(r)}><Pencil className="h-3.5 w-3.5" /></IconBtn>
              <IconBtn title="Obriši" danger onClick={() => { if (confirm('Obrisati akciju?')) delM.mutate({ id: r.id }); }}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
            </div>
          ),
        }]
      : []),
  ];

  const viewTabs: TabItem<ViewKey>[] = [
    { key: 'lista', label: 'Lista' },
    { key: 'kanban', label: 'Kanban' },
  ];

  return (
    <div className="space-y-3">
      {/* Weekly diff */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        <DiffCell value={d?.novo ?? 0} label="Novo (7 dana)" />
        <DiffCell value={d?.zavrsenoOveNedelje ?? 0} label="Završeno (7 dana)" tone="success" />
        <DiffCell value={d?.kasni ?? 0} label="Kasni" tone="danger" />
        <DiffCell value={d?.aktivnih ?? 0} label="Aktivnih ukupno" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs tabs={viewTabs} value={view} onChange={setView} ariaLabel="Prikaz akcija" />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className={`${INPUT_CLS} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Svi statusi</option>
            {['otvoren', 'u_toku', 'kasni', 'zavrsen', 'odlozen', 'otkazan'].map((s) => (
              <option key={s} value={s}>{AKCIJA_STATUS_LABEL[s]}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input type="checkbox" checked={samoMoje} onChange={(e) => setSamoMoje(e.target.checked)} /> Samo moje
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input type="checkbox" checked={prikaziZavrseno} onChange={(e) => setPrikaziZavrseno(e.target.checked)} /> Prikaži završeno
          </label>
          <SearchBox value={q} onChange={setQ} placeholder="Zadatak…" />
          {canEdit && <Button onClick={() => setModalEdit(null)}>+ Nova akcija</Button>}
        </div>
      </div>

      {/* Bulk bar */}
      {canEdit && sel.size > 0 && view === 'lista' && (
        <div className="flex items-center gap-2 rounded-panel border border-line bg-surface-2 px-3 py-2 text-sm">
          <span className="text-ink-secondary">Izabrano: {sel.size}</span>
          <select className={`${INPUT_CLS} w-auto`} value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
            {AKCIJA_SETTABLE_STATUSI.map((s) => (
              <option key={s} value={s}>{AKCIJA_STATUS_LABEL[s]}</option>
            ))}
          </select>
          <Button variant="secondary" loading={bulkM.isPending} onClick={() => void applyBulk()}>Primeni na izabrane</Button>
          <Button variant="ghost" onClick={() => setSel(new Set())}>Poništi</Button>
        </div>
      )}

      {view === 'lista' ? (
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          loading={akcijeQ.isLoading}
          onRowActivate={canEdit ? (r) => setModalEdit(r) : undefined}
          empty={tableEmpty(akcijeQ.isError, 'Nema akcija', 'Nema zadataka po ovim filterima.')}
        />
      ) : (
        <AkcioniKanban akcije={rows} canEdit={canEdit} onEdit={(a) => setModalEdit(a)} />
      )}

      {modalEdit !== undefined && (
        <AkcijaModal edit={modalEdit} onClose={() => setModalEdit(undefined)} />
      )}
      {istorijaFor && <IstorijaModal akcijaId={istorijaFor} onClose={() => setIstorijaFor(null)} />}
    </div>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-control border border-line p-1 hover:bg-surface-2 ${danger ? 'text-status-danger' : 'text-ink-secondary'}`}
    >
      {children}
    </button>
  );
}

function DiffCell({ value, label, tone }: { value: number; label: string; tone?: 'success' | 'danger' }) {
  const cls = tone === 'danger' ? 'text-status-danger' : tone === 'success' ? 'text-status-success' : 'text-ink';
  return (
    <div className="min-w-32 rounded-panel border border-line bg-surface px-4 py-2">
      <div className={`tnums text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs text-ink-secondary">{label}</div>
    </div>
  );
}

function IstorijaModal({ akcijaId, onClose }: { akcijaId: string; onClose: () => void }) {
  const q = useAkcijaIstorija(akcijaId);
  const rows = q.data?.data ?? [];
  return (
    <Dialog open onClose={onClose} title="Istorija akcije">
      {q.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema zabeleženih izmena.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-control border border-line-soft px-3 py-2 text-sm">
              <div className="flex items-center justify-between text-xs text-ink-secondary">
                <span>{r.polje}</span>
                <span className="tnums">{formatDateTime(r.izmenjenoAt)}</span>
              </div>
              <div className="mt-1 text-ink">
                <span className="text-ink-disabled line-through">{r.staro || '—'}</span>{' → '}
                <span>{r.novo || '—'}</span>
              </div>
              {r.izmenioEmail && <div className="mt-0.5 text-xs text-ink-disabled">{r.izmenioEmail}</div>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
