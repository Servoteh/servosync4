'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useAssignableUsers,
  useCreateWoEvent,
  useCreateWoLabor,
  useCreateWoPart,
  useUpdateWorkOrder,
  useWorkOrder,
  type MaintMe,
  type WoStatus,
} from '@/api/odrzavanje';
import { Field, WO_STATUS_LABEL, WO_TYPE_LABEL, WoPriorityBadge, WoStatusBadge } from './common';

const STATUSES: WoStatus[] = [
  'novi', 'potvrden', 'dodeljen', 'u_radu', 'ceka_deo',
  'ceka_dobavljaca', 'ceka_korisnika', 'kontrola', 'zavrsen', 'otkazan',
];

/** WO detalj: dodela, status, prioritet, rok, closure, events + delovi + rad. */
export function WoDetailDialog({ woId, me, onClose }: { woId: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const wo = useWorkOrder(woId);
  const assignable = useAssignableUsers(!!woId && (me?.gates.canEditWorkOrder ?? false));
  const update = useUpdateWorkOrder();
  const addEvent = useCreateWoEvent();
  const addPart = useCreateWoPart();
  const addLabor = useCreateWoLabor();

  const [comment, setComment] = useState('');
  const [closure, setClosure] = useState('');
  const [partName, setPartName] = useState('');
  const [partQty, setPartQty] = useState('');
  const [partCost, setPartCost] = useState('');
  const [minutes, setMinutes] = useState('');

  const d = wo.data?.data;
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  const busy = update.isPending || addEvent.isPending || addPart.isPending || addLabor.isPending;

  if (!woId) return null;

  return (
    <Dialog open={!!woId} onClose={onClose} title={d?.woNumber ? `Nalog ${d.woNumber}` : 'Radni nalog'}>
      {wo.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <WoStatusBadge status={d.status} />
              <WoPriorityBadge priority={d.priority} />
              {d.safetyMarker && <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-2xs font-medium text-status-danger">Bezbednosni rizik</span>}
            </div>
            <h3 className="mt-2 text-md font-semibold text-ink">{d.title}</h3>
            {d.description && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{d.description}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
            <Field label="Tip">{WO_TYPE_LABEL[d.type] ?? d.type}</Field>
            <Field label="Rok">{d.dueAt ? formatDate(d.dueAt) : '—'}</Field>
            <Field label="Kreiran">{formatDateTime(d.createdAt)}</Field>
            <Field label="Završen">{d.completedAt ? formatDateTime(d.completedAt) : '—'}</Field>
          </div>

          {canEdit && (
            <div className="space-y-3 rounded-panel border border-line p-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Status">
                  <select
                    value={d.status}
                    onChange={(e) => update.mutate({ id: d.woId, patch: { status: e.target.value } })}
                    className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{WO_STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Prioritet">
                  <select
                    value={d.priority}
                    onChange={(e) => update.mutate({ id: d.woId, patch: { priority: e.target.value } })}
                    className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
                  >
                    {(['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'] as const).map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Dodeljen">
                  <select
                    value={d.assignedTo ?? ''}
                    onChange={(e) => update.mutate({ id: d.woId, patch: { assignedTo: e.target.value || null } })}
                    className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
                  >
                    <option value="">— nedodeljen —</option>
                    {(assignable.data?.data ?? []).map((u) => (
                      <option key={u.user_id} value={u.user_id}>{u.full_name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Rok">
                  <Input
                    type="date"
                    defaultValue={d.dueAt ? d.dueAt.slice(0, 10) : ''}
                    onBlur={(e) => update.mutate({ id: d.woId, patch: { dueAt: e.target.value ? new Date(e.target.value).toISOString() : null } })}
                  />
                </FormField>
              </div>
              {(d.status === 'zavrsen' || d.status === 'kontrola') && (
                <FormField label="Napomena zatvaranja">
                  <div className="flex gap-2">
                    <Input value={closure} onChange={(e) => setClosure(e.target.value)} placeholder="Šta je urađeno…" />
                    <Button
                      variant="secondary"
                      disabled={!closure.trim() || busy}
                      onClick={() => { update.mutate({ id: d.woId, patch: { closureComment: closure } }); setClosure(''); }}
                    >
                      Sačuvaj
                    </Button>
                  </div>
                </FormField>
              )}
            </div>
          )}

          {/* Delovi */}
          <Section title={`Delovi (${d.parts.length})`}>
            {d.parts.map((p) => (
              <Row key={p.id} left={p.partName} right={`${p.quantity ?? '—'} ${p.unit ?? ''} · ${p.unitCost ?? '—'}`} />
            ))}
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="Naziv dela" className="flex-1" />
                <Input value={partQty} onChange={(e) => setPartQty(e.target.value)} placeholder="Kol." className="w-20" inputMode="decimal" />
                <Input value={partCost} onChange={(e) => setPartCost(e.target.value)} placeholder="Cena" className="w-24" inputMode="decimal" />
                <Button
                  variant="secondary"
                  disabled={!partName.trim() || busy}
                  onClick={() => {
                    addPart.mutate({ id: d.woId, partName, quantity: partQty ? Number(partQty) : undefined, unitCost: partCost ? Number(partCost) : undefined });
                    setPartName(''); setPartQty(''); setPartCost('');
                  }}
                >
                  Dodaj
                </Button>
              </div>
            )}
          </Section>

          {/* Rad */}
          <Section title={`Rad (${d.labor.length})`}>
            {d.labor.map((l) => (
              <Row key={l.id} left={`${l.minutes ?? 0} min`} right={l.notes ?? ''} />
            ))}
            {canEdit && (
              <div className="mt-2 flex gap-2">
                <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minuta" className="w-28" inputMode="numeric" />
                <Button
                  variant="secondary"
                  disabled={!minutes || busy}
                  onClick={() => { addLabor.mutate({ id: d.woId, minutes: Number(minutes) }); setMinutes(''); }}
                >
                  Evidentiraj rad
                </Button>
              </div>
            )}
          </Section>

          {/* Timeline */}
          <Section title={`Istorija (${d.events.length})`}>
            {d.events.map((ev) => (
              <div key={ev.id} className="border-b border-line-soft py-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-ink">{ev.eventType}{ev.toValue ? ` → ${ev.toValue}` : ''}</span>
                  <span className="text-2xs text-ink-secondary">{formatDateTime(ev.at)}</span>
                </div>
                {ev.comment && <p className="text-ink-secondary">{ev.comment}</p>}
              </div>
            ))}
            {canEdit && (
              <div className="mt-2 flex gap-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Komentar…" className="flex-1" />
                <Button
                  variant="secondary"
                  disabled={!comment.trim() || busy}
                  onClick={() => { addEvent.mutate({ id: d.woId, eventType: 'comment', comment }); setComment(''); }}
                >
                  Dodaj
                </Button>
              </div>
            )}
          </Section>
        </div>
      )}
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-sm font-semibold text-ink">{title}</h4>
      <div>{children}</div>
    </div>
  );
}
function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
      <span className="text-ink">{left}</span>
      <span className="tnums text-ink-secondary">{right}</span>
    </div>
  );
}
