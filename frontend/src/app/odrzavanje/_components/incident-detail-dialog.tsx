'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDateTime } from '@/lib/format';
import {
  useAssignableUsers,
  useCreateIncidentEvent,
  useIncident,
  useUpdateIncident,
  type IncidentStatus,
  type MaintMe,
} from '@/api/odrzavanje';
import { Field, INCIDENT_STATUS_LABEL, IncidentStatusBadge, SeverityBadge, WoStatusBadge } from './common';
import { WoDetailDialog } from './wo-detail-dialog';

/** Statusi koje tehničar sme; „closed" samo chief/admin/ERP (§2.5.8 — RLS presuđuje). */
const TECH_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'in_progress', 'awaiting_parts', 'resolved'];

/** Čitljive labele tipova događaja (paritet 1.0 eventTypeLabel). */
const EVENT_LABEL: Record<string, string> = {
  status_change: 'Promena statusa',
  assigned_change: 'Promena dodele',
  assignment_change: 'Promena dodele',
  severity_change: 'Promena ozbiljnosti',
  comment: 'Komentar',
  user_note: 'Napomena',
  created: 'Prijavljen',
};

export function IncidentDetailDialog({ id, me, onClose }: { id: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const router = useRouter();
  const inc = useIncident(id);
  const update = useUpdateIncident();
  const addEvent = useCreateIncidentEvent();
  const [comment, setComment] = useState('');
  const [woOpen, setWoOpen] = useState(false);

  const d = inc.data?.data;
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  const canClose = me?.gates.canManageMaintCatalog || me?.maintRole === 'chief' || me?.maintRole === 'admin';
  const statuses = canClose ? [...TECH_STATUSES, 'closed' as const] : TECH_STATUSES;
  // Dodela (H3): dropdown assignable users → PATCH assignedTo. BE podržava (assignableUsers + assignedTo).
  const assignable = useAssignableUsers(!!id && canEdit);
  const users = assignable.data?.data ?? [];
  const assigneeName = d?.assignedTo ? users.find((u) => u.user_id === d.assignedTo)?.full_name ?? null : null;

  if (!id) return null;
  if (woOpen && d?.workOrder?.woId) return <WoDetailDialog woId={d.workOrder.woId} me={me} onClose={() => setWoOpen(false)} />;

  return (
    <Dialog open={!!id} onClose={onClose} title="Kvar">
      {inc.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <IncidentStatusBadge status={d.status} />
              <SeverityBadge severity={d.severity} />
              {d.safetyMarker && <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-2xs font-medium text-status-danger">Bezbednosni rizik</span>}
            </div>
            <h3 className="mt-2 text-md font-semibold text-ink">{d.title}</h3>
            {d.description && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{d.description}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
            <Field label="Sredstvo">
              <button className="inline-flex items-center gap-1 text-accent" onClick={() => { onClose(); router.push(`/odrzavanje/masine?code=${encodeURIComponent(d.machineCode)}`); }}>
                {d.machineCode} <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
            </Field>
            <Field label="Prijavljen">{formatDateTime(d.reportedAt)}</Field>
            <Field label="Zastoj (min)">{d.downtimeMinutes ?? '—'}</Field>
            <Field label="Radni nalog">
              {d.workOrder ? (
                <button className="inline-flex items-center gap-1.5 text-accent" onClick={() => setWoOpen(true)}>
                  <span className="tnums">{d.workOrder.woNumber ?? '—'}</span>
                  <WoStatusBadge status={d.workOrder.status} />
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
              ) : '—'}
            </Field>
            <Field label="Dodeljen">{assigneeName ?? (d.assignedTo ? 'dodeljen' : '—')}</Field>
          </div>

          {d.attachmentUrls?.length > 0 && (
            <div className="text-xs text-ink-secondary">{d.attachmentUrls.length} priloženih fotografija</div>
          )}

          {canEdit && (
            <div className="grid gap-3 sm:grid-cols-2">
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
              <FormField label="Dodeli tehničaru">
                <select
                  value={d.assignedTo ?? ''}
                  onChange={(e) => update.mutate({ id: d.id, patch: { assignedTo: e.target.value || null } })}
                  className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
                >
                  <option value="">— nedodeljen —</option>
                  {users.map((u) => (
                    <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>
                  ))}
                </select>
              </FormField>
            </div>
          )}

          <div>
            <h4 className="mb-1.5 text-sm font-semibold text-ink">Istorija ({d.events.length})</h4>
            {d.events.map((ev) => (
              <div key={ev.id} className="border-b border-line-soft py-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-ink">
                    {EVENT_LABEL[ev.eventType] ?? ev.eventType}
                    {ev.fromValue || ev.toValue ? `: ${ev.fromValue ?? '—'} → ${ev.toValue ?? '—'}` : ''}
                  </span>
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
