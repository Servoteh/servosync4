'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useUpdateWorkOrder,
  useWorkOrders,
  type MaintMe,
  type WorkOrderRow,
  type WoGroup,
  type WoStatus,
} from '@/api/odrzavanje';
import {
  WO_GROUPS,
  WO_PRIORITY_LABEL,
  WO_STATUS_LABEL,
  WoPriorityBadge,
  WoStatusBadge,
} from './common';
import { WoDetailDialog } from './wo-detail-dialog';
import { CreateWoDialog } from './create-wo-dialog';

/** Kanonski status po grupi (za drop-move; precizan status ide iz detalja). */
const GROUP_DROP_STATUS: Record<WoGroup, WoStatus> = {
  novi: 'novi',
  u_toku: 'u_radu',
  ceka: 'ceka_deo',
  zavrseno: 'zavrsen',
};

const STATUS_FILTERS: WoStatus[] = [
  'novi', 'potvrden', 'dodeljen', 'u_radu', 'ceka_deo',
  'ceka_dobavljaca', 'ceka_korisnika', 'kontrola', 'zavrsen', 'otkazan',
];
const PRIORITY_FILTERS = ['', 'p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'] as const;

/** Statusi koji se u kartici tretiraju kao „gotov" (bez brzih dugmadi) — 1.0 :198. */
const DONE = new Set<WoStatus>(['zavrsen', 'otkazan']);

interface Filters {
  q: string;
  status: string;
  priority: string;
  mine: boolean;
  open: boolean; // „Samo otvoreni" — default ON (1.0 open!=='0')
  overdue: boolean;
}

/** Početno stanje filtera iz URL-a (obrazac 1.0 maintWorkOrdersPanel.js:124-131). */
function readInitial(): Filters {
  if (typeof window === 'undefined') {
    return { q: '', status: '', priority: '', mine: false, open: true, overdue: false };
  }
  const sp = new URLSearchParams(window.location.search);
  return {
    q: sp.get('q') || '',
    status: sp.get('status') || '',
    priority: sp.get('priority') || '',
    mine: sp.get('mine') === '1',
    open: sp.get('open') !== '0',
    overdue: sp.get('overdue') === '1',
  };
}

/** Radni nalozi — kanban 4 grupe (10 statusa), drag&drop, filteri, brza dugmad, tabela, detalj. */
export function NaloziTab({ me }: { me: MaintMe | undefined }) {
  const [flt, setFlt] = useState<Filters>(readInitial);
  const [openWo, setOpenWo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const patch = <K extends keyof Filters>(k: K, v: Filters[K]) => setFlt((f) => ({ ...f, [k]: v }));

  // URL sync (paritet 1.0 syncUrl :133-144) — replaceState da se ne dira tab-stanje/scroll.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams();
    if (flt.q.trim()) q.set('q', flt.q.trim());
    if (flt.status) q.set('status', flt.status);
    if (flt.priority) q.set('priority', flt.priority);
    if (flt.mine) q.set('mine', '1');
    if (!flt.open) q.set('open', '0');
    if (flt.overdue) q.set('overdue', '1');
    const s = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}`);
  }, [flt]);

  const wos = useWorkOrders({
    q: flt.q.trim() || undefined,
    status: flt.status || undefined,
    priority: flt.priority || undefined,
    mine: flt.mine || undefined,
    // BE default ON — šalji `false` samo kad je isključeno (paritet 1.0 open=0).
    openOnly: flt.open ? undefined : false,
    overdue: flt.overdue || undefined,
    pageSize: 200,
  });
  const updateWo = useUpdateWorkOrder();
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  const canCreate = me?.gates.canCreateWo ?? false;

  const list = wos.data?.data ?? [];
  const byGroup = useMemo(() => {
    const g: Record<WoGroup, WorkOrderRow[]> = { novi: [], u_toku: [], ceka: [], zavrseno: [] };
    for (const w of list) if (w.group && g[w.group]) g[w.group].push(w);
    return g;
  }, [list]);
  const tableRows = useMemo(
    () => [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    [list],
  );
  const shownCount = list.length;

  function onDrop(woId: string, group: WoGroup) {
    if (!canEdit) return;
    updateWo.mutate({ id: woId, patch: { status: GROUP_DROP_STATUS[group] } });
  }
  /** Brza promena statusa iz kartice (bez modala) — pečate started_at/completed_at radi BE. */
  function quickStatus(w: WorkOrderRow, status: WoStatus) {
    if (!canEdit || w.status === status) return;
    updateWo.mutate({ id: w.woId, patch: { status } });
  }

  return (
    <div className="space-y-4">
      {/* Toolbar (paritet 1.0 :279-293) */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={flt.q}
          onChange={(e) => patch('q', e.target.value)}
          placeholder="Pretraga (broj, naslov, sredstvo)…"
          className="h-9 min-w-52 flex-1 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        />
        <select
          value={flt.status}
          onChange={(e) => patch('status', e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Svi statusi</option>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{WO_STATUS_LABEL[s]}</option>
          ))}
        </select>
        <select
          value={flt.priority}
          onChange={(e) => patch('priority', e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          {PRIORITY_FILTERS.map((p) => (
            <option key={p} value={p}>{p ? WO_PRIORITY_LABEL[p] : 'Svi prioriteti'}</option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={flt.open} onChange={(e) => patch('open', e.target.checked)} />
          Samo otvoreni
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={flt.overdue} onChange={(e) => patch('overdue', e.target.checked)} />
          Kasni rok (WO)
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={flt.mine} onChange={(e) => patch('mine', e.target.checked)} />
          Samo moji
        </label>
        <span className="tnums text-xs text-ink-secondary">{shownCount} prikazano</span>
        <div className="ml-auto">
          {canCreate && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Novi nalog
            </Button>
          )}
        </div>
      </div>

      {wos.isError ? (
        <EmptyState title="Greška pri učitavanju" hint="Radni nalozi trenutno nisu dostupni." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {WO_GROUPS.map((grp) => (
              <div
                key={grp.key}
                onDragOver={(e) => canEdit && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/plain');
                  if (id) onDrop(id, grp.key);
                }}
                className="flex min-h-32 flex-col gap-2 rounded-panel border border-line bg-surface-2/40 p-2"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="text-sm font-semibold text-ink">{grp.label}</span>
                  <span className="tnums text-xs text-ink-secondary">{byGroup[grp.key].length}</span>
                </div>
                {byGroup[grp.key].map((w) => (
                  <WoCard key={w.woId} w={w} canEdit={canEdit} onOpen={() => setOpenWo(w.woId)} onQuick={quickStatus} />
                ))}
                {!wos.isLoading && byGroup[grp.key].length === 0 && (
                  <div className="px-1 py-4 text-center text-xs text-ink-disabled">Nema stavki.</div>
                )}
              </div>
            ))}
          </div>

          {/* Tabela ispod kanbana (paritet 1.0 :297-300) */}
          <details className="rounded-panel border border-line bg-surface-2/40">
            <summary className="cursor-pointer px-3 py-2 text-sm text-ink-secondary">Tabela (svi prikazani redovi)</summary>
            <div className="overflow-x-auto px-3 pb-3">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                    <th className="py-1.5 pr-3">Broj</th>
                    <th className="py-1.5 pr-3">Status</th>
                    <th className="py-1.5 pr-3">Prioritet</th>
                    <th className="py-1.5 pr-3">Naslov</th>
                    <th className="py-1.5 pr-3">Šifra sredstva</th>
                    <th className="py-1.5">Kreiran</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((w) => (
                    <tr
                      key={w.woId}
                      onClick={() => setOpenWo(w.woId)}
                      className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    >
                      <td className="tnums py-1.5 pr-3 text-ink-secondary">{w.woNumber ?? '—'}</td>
                      <td className="py-1.5 pr-3"><WoStatusBadge status={w.status} /></td>
                      <td className="py-1.5 pr-3"><WoPriorityBadge priority={w.priority} /></td>
                      <td className="py-1.5 pr-3 text-ink">{w.title}</td>
                      <td className="py-1.5 pr-3 text-ink-secondary">{w.asset?.assetCode ?? '—'}</td>
                      <td className="tnums py-1.5 text-ink-secondary">{formatDateTime(w.createdAt)}</td>
                    </tr>
                  ))}
                  {tableRows.length === 0 && (
                    <tr><td colSpan={6} className="py-3 text-center text-ink-disabled">Nema podataka</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      <WoDetailDialog woId={openWo} me={me} onClose={() => setOpenWo(null)} />
      {creating && <CreateWoDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Kanban kartica naloga — sredstvo 'šifra · naziv' + brza dugmad (Započni/Čeka deo/Završi). */
function WoCard({
  w,
  canEdit,
  onOpen,
  onQuick,
}: {
  w: WorkOrderRow;
  canEdit: boolean;
  onOpen: () => void;
  onQuick: (w: WorkOrderRow, s: WoStatus) => void;
}) {
  const done = DONE.has(w.status);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', w.woId)}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={cn(
        'w-full rounded-control border border-line bg-surface p-2.5 text-left hover:border-accent',
        canEdit && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="tnums text-xs font-medium text-ink-secondary">{w.woNumber ?? '—'}</span>
        <WoPriorityBadge priority={w.priority} />
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-ink">{w.title}</p>
      {w.asset && (
        <div className="mt-0.5 truncate text-2xs text-ink-secondary">
          {w.asset.assetCode}{w.asset.name ? ` · ${w.asset.name}` : ''}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <WoStatusBadge status={w.status} />
        {w.dueAt && <span className="text-2xs text-ink-secondary">rok {formatDate(w.dueAt)}</span>}
      </div>
      {canEdit && !done && (
        <div className="mt-2 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {w.status !== 'u_radu' && (
            <QuickBtn onClick={() => onQuick(w, 'u_radu')}>Započni</QuickBtn>
          )}
          <QuickBtn onClick={() => onQuick(w, 'ceka_deo')}>Čeka deo</QuickBtn>
          <QuickBtn tone="ok" onClick={() => onQuick(w, 'zavrsen')}>Završi</QuickBtn>
        </div>
      )}
    </div>
  );
}

function QuickBtn({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone?: 'ok' }) {
  return (
    <button
      type="button"
      draggable={false}
      onClick={onClick}
      className={cn(
        'rounded-control border px-2 py-0.5 text-2xs font-medium transition-colors',
        tone === 'ok'
          ? 'border-status-success/40 text-status-success hover:bg-status-success-bg'
          : 'border-line text-ink-secondary hover:border-accent hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
