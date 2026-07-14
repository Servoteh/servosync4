'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import {
  useUpdateWorkOrder,
  useWorkOrders,
  type MaintMe,
  type WorkOrderRow,
  type WoGroup,
  type WoStatus,
} from '@/api/odrzavanje';
import { WO_GROUPS, WO_PRIORITY_LABEL, WO_TYPE_LABEL, WoPriorityBadge, WoStatusBadge } from './common';
import { WoDetailDialog } from './wo-detail-dialog';
import { CreateWoDialog } from './create-wo-dialog';

/** Kanonski status po grupi (za drop-move; precizan status ide iz detalja). */
const GROUP_DROP_STATUS: Record<WoGroup, WoStatus> = {
  novi: 'novi',
  u_toku: 'u_radu',
  ceka: 'ceka_deo',
  zavrseno: 'zavrsen',
};

const TYPE_FILTERS = ['', 'kvar', 'preventiva', 'servis', 'inspekcija'] as const;
const PRIORITY_FILTERS = ['', 'p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'] as const;

/** Radni nalozi — kanban 4 grupe (10 statusa), drag&drop (write), filteri, detalj. */
export function NaloziTab({ me }: { me: MaintMe | undefined }) {
  const [type, setType] = useState<string>('');
  const [priority, setPriority] = useState<string>('');
  const [mine, setMine] = useState(false);
  const [openWo, setOpenWo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const wos = useWorkOrders({ type, priority, mine, pageSize: 200 });
  const updateWo = useUpdateWorkOrder();
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  const canCreate = me?.gates.canCreateWo ?? false;

  const byGroup = useMemo(() => {
    const g: Record<WoGroup, WorkOrderRow[]> = { novi: [], u_toku: [], ceka: [], zavrseno: [] };
    for (const w of wos.data?.data ?? []) {
      if (w.group && g[w.group]) g[w.group].push(w);
    }
    return g;
  }, [wos.data]);

  function onDrop(woId: string, group: WoGroup) {
    if (!canEdit) return;
    updateWo.mutate({ id: woId, patch: { status: GROUP_DROP_STATUS[group] } });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onChange={setType} options={TYPE_FILTERS} labelFor={(t) => (t ? WO_TYPE_LABEL[t] : 'Svi tipovi')} />
        <Select value={priority} onChange={setPriority} options={PRIORITY_FILTERS} labelFor={(p) => (p ? WO_PRIORITY_LABEL[p as never] : 'Svi prioriteti')} />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Meni dodeljeni
        </label>
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
                <button
                  key={w.woId}
                  draggable={canEdit}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', w.woId)}
                  onClick={() => setOpenWo(w.woId)}
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
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <WoStatusBadge status={w.status} />
                    {w.dueAt && <span className="text-2xs text-ink-secondary">rok {formatDate(w.dueAt)}</span>}
                  </div>
                </button>
              ))}
              {!wos.isLoading && byGroup[grp.key].length === 0 && (
                <div className="px-1 py-4 text-center text-xs text-ink-disabled">—</div>
              )}
            </div>
          ))}
        </div>
      )}

      <WoDetailDialog woId={openWo} me={me} onClose={() => setOpenWo(null)} />
      {creating && <CreateWoDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
  labelFor,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly T[];
  labelFor: (v: T) => string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labelFor(o)}
        </option>
      ))}
    </select>
  );
}
