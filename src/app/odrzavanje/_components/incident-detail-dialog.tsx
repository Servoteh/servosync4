'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDateTime } from '@/lib/format';
import {
  useCreateIncidentEvent,
  useIncident,
  useUpdateIncident,
  type IncidentStatus,
  type MaintMe,
} from '@/api/odrzavanje';
import { Field, INCIDENT_STATUS_LABEL, IncidentStatusBadge, SeverityBadge, WoStatusBadge } from './common';

/** Statusi koje tehničar sme; „closed" samo chief/admin/ERP (§2.5.8 — RLS presuđuje). */
const TECH_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'in_progress', 'awaiting_parts', 'resolved'];

export function IncidentDetailDialog({ id, me, onClose }: { id: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const inc = useIncident(id);
  const update = useUpdateIncident();
  const addEvent = useCreateIncidentEvent();
  const [comment, setComment] = useState('');

  const d = inc.data?.data;
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  const canClose = me?.gates.canManageMaintCatalog || me?.maintRole === 'chief' || me?.maintRole === 'admin';
  const statuses = canClose ? [...TECH_STATUSES, 'closed' as const] : TECH_STATUSES;

  if (!id) return null;

  return (
    <Dialog open={!!id} onClose={onClose} title="Kvar">
      {inc.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <IncidentStatusBadge status={d.status} />
              <SeverityBadge severity={d.severity} />
              {d.safetyMarker && <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-2xs font-medium text-status-danger">Bezbednosni rizik</span>}
            </div>
            <h3 className="mt-2 text-md font-semibold text-ink">{d.title}</h3>
            {d.description && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{d.description}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
            <Field label="Mašina">{d.machineCode}</Field>
            <Field label="Prijavljen">{formatDateTime(d.reportedAt)}</Field>
            <Field label="Zastoj (min)">{d.downtimeMinutes ?? '—'}</Field>
            <Field label="Radni nalog">
              {d.workOrder ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="tnums">{d.workOrder.woNumber ?? '—'}</span>
                  <WoStatusBadge status={d.workOrder.status} />
                </span>
              ) : '—'}
            </Field>
          </div>

          {d.attachmentUrls?.length > 0 && (
            <div className="text-xs text-ink-secondary">{d.attachmentUrls.length} priloženih fotografija</div>
          )}

          {canEdit && (
            <FormField label="Status">
              <select
                value={d.status}
                onChange={(e) => update.mutate({ id: d.id, patch: { status: e.target.value } })}
                className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>{INCIDENT_STATUS_LABEL[s]}</option>
                ))}
              </select>
            </FormField>
          )}

          <div>
            <h4 className="mb-1.5 text-sm font-semibold text-ink">Istorija ({d.events.length})</h4>
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
                  disabled={!comment.trim() || addEvent.isPending}
                  onClick={() => { addEvent.mutate({ id: d.id, eventType: 'comment', comment }); setComment(''); }}
                >
                  Dodaj
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
