'use client';

import { useState } from 'react';
import { Flame, Pin, ArrowLeftRight, ListTree, Image as ImageIcon, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useUpsertOverlay,
  useSetUrgent,
  useClearUrgent,
  useReorderOverlays,
  opKey,
  type OpRow,
} from '@/api/plan-proizvodnje';
import { StatusPill, nextStatus, machineLabel, progressLabel, rowClasses } from './shared';
import { formatDate } from '@/lib/format';

export function OpsTable({
  ops,
  selectable,
  selected,
  onToggleSelect,
  reorderable,
  onReassign,
  onTp,
  onSkice,
}: {
  ops: OpRow[];
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (o: OpRow) => void;
  reorderable?: boolean;
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const overlay = useUpsertOverlay();
  const setUrgent = useSetUrgent();
  const clearUrgent = useClearUrgent();
  const reorder = useReorderOverlays();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  function cycleStatus(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, localStatus: nextStatus(o.local_status) });
  }
  function toggleUrgent(o: OpRow) {
    if (!canEdit) return;
    if (o.is_urgent) clearUrgent.mutate({ workOrderId: o.work_order_id });
    else setUrgent.mutate({ workOrderId: o.work_order_id });
  }
  function togglePin(o: OpRow) {
    if (!canEdit) return;
    // pin-to-top = min(ručnih)−1; ovde jednostavno: pin postavlja -1, unpin briše
    const isPinned = o.shift_sort_order != null;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, shiftSortOrder: isPinned ? null : -1 });
  }
  function toggleCam(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, camReady: !o.cam_ready });
  }
  function toggleReady(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, readyOverride: !o.ready_override });
  }

  function onDrop(overO: OpRow) {
    if (!reorderable || !canEdit || !dragKey) return;
    const from = ops.findIndex((x) => opKey(x) === dragKey);
    const to = ops.findIndex((x) => opKey(x) === opKey(overO));
    setDragKey(null);
    if (from < 0 || to < 0 || from === to) return;
    const arr = [...ops];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    reorder.mutate({ items: arr.map((x) => ({ workOrderId: x.work_order_id, lineId: x.line_id })) });
  }

  if (ops.length === 0) {
    return <div className="rounded-panel border border-line bg-surface px-4 py-8 text-center text-sm text-ink-disabled">Nema otvorenih operacija.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
            {selectable && <th className="w-8 px-2 py-1.5" />}
            <th className="px-3 py-1.5">Crtež / deo</th>
            <th className="px-3 py-1.5">RN</th>
            <th className="px-3 py-1.5">Op</th>
            <th className="px-3 py-1.5">Mašina</th>
            <th className="px-3 py-1.5">Kom</th>
            <th className="px-3 py-1.5">Rok</th>
            <th className="px-3 py-1.5">Status</th>
            <th className="px-3 py-1.5 text-right">Akcije</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((o) => {
            const key = opKey(o);
            const open = expanded === key;
            return (
              <FragRow key={key}>
                <tr
                  className={cn('border-b border-line-soft hover:bg-surface-2', rowClasses(o))}
                  draggable={reorderable && canEdit}
                  onDragStart={() => setDragKey(key)}
                  onDragOver={(e) => reorderable && e.preventDefault()}
                  onDrop={() => onDrop(o)}
                >
                  {selectable && (
                    <td className="px-2 py-1.5">
                      <input type="checkbox" checked={selected?.has(key) ?? false} onChange={() => onToggleSelect?.(o)} />
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {reorderable && canEdit && <span className="cursor-grab text-ink-disabled">⠿</span>}
                      <div>
                        <div className="font-medium text-ink">{o.broj_crteza ?? '—'}</div>
                        <div className="text-xs text-ink-disabled">{o.naziv_dela ?? ''}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-xs">{o.rn_ident_broj ?? '—'}</td>
                  <td className="tnums px-3 py-1.5">{String(o.operacija ?? '')}</td>
                  <td className="px-3 py-1.5">
                    {machineLabel(o)}
                    {o.assigned_machine_code && o.assigned_machine_code !== o.effective_machine_code && (
                      <span className="ml-1 text-2xs text-status-warn">↦</span>
                    )}
                  </td>
                  <td className="tnums px-3 py-1.5">{progressLabel(o)}</td>
                  <td className="tnums px-3 py-1.5 text-xs">{formatDate(o.rok_izrade)}</td>
                  <td className="px-3 py-1.5">
                    <StatusPill status={o.local_status} onClick={() => cycleStatus(o)} disabled={!canEdit} />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <IconBtn title="HITNO" active={!!o.is_urgent} onClick={() => toggleUrgent(o)} disabled={!canEdit}>
                        <Flame className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="Pin na vrh" active={o.shift_sort_order != null} onClick={() => togglePin(o)} disabled={!canEdit}>
                        <Pin className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="Premesti (reassign)" onClick={() => onReassign(o)} disabled={!canEdit}>
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="TP procedura" onClick={() => onTp(o)}>
                        <ListTree className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="Skice" onClick={() => onSkice(o)}>
                        <ImageIcon className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="Detalji" onClick={() => setExpanded(open ? null : key)}>
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-line-soft bg-surface-2/50">
                    <td colSpan={selectable ? 9 : 8} className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <NoteEditor
                          op={o}
                          disabled={!canEdit}
                          onSave={(note) =>
                            overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, shiftNote: note })
                          }
                        />
                        <label className="flex items-center gap-1.5 text-xs text-ink">
                          <input type="checkbox" checked={!!o.cam_ready} disabled={!canEdit} onChange={() => toggleCam(o)} /> CAM spreman
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-ink">
                          <input type="checkbox" checked={!!o.ready_override} disabled={!canEdit} onChange={() => toggleReady(o)} /> SPREMNO (override)
                        </label>
                        {canEdit &&
                          (o.cooperation_status === 'external' ? (
                            <Button
                              variant="ghost"
                              className="h-8 px-2 text-xs"
                              onClick={() =>
                                overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, cooperationStatus: 'none' })
                              }
                            >
                              Vrati iz kooperacije
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              className="h-8 px-2 text-xs"
                              onClick={() => {
                                const partner = prompt('Kooperant (partner):') ?? '';
                                overlay.mutate({
                                  workOrderId: o.work_order_id,
                                  lineId: o.line_id,
                                  cooperationStatus: 'external',
                                  cooperationPartner: partner || null,
                                });
                              }}
                            >
                              Pošalji u kooperaciju
                            </Button>
                          ))}
                        {o.is_urgent && o.urgency_reason && (
                          <span className="text-xs text-status-danger">HITNO: {o.urgency_reason}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </FragRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function IconBtn({
  children,
  title,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-control p-1 hover:bg-surface-2 disabled:opacity-30',
        active ? 'text-status-danger' : 'text-ink-secondary',
      )}
    >
      {children}
    </button>
  );
}

function NoteEditor({ op, disabled, onSave }: { op: OpRow; disabled?: boolean; onSave: (note: string) => void }) {
  const [note, setNote] = useState(op.shift_note ?? '');
  return (
    <div className="flex items-center gap-1.5">
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Napomena…" disabled={disabled} className="h-8 w-56" />
      {!disabled && (
        <Button variant="ghost" onClick={() => onSave(note)} className="h-8 px-2 text-xs">
          Sačuvaj
        </Button>
      )}
    </div>
  );
}
