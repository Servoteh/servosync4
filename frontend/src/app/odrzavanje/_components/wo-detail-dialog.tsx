'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
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
  useParts,
  useUpdateWorkOrder,
  useWorkOrder,
  type MaintMe,
  type Part,
  type WoStatus,
} from '@/api/odrzavanje';
import { Field, WO_STATUS_LABEL, WO_TYPE_LABEL, WoPriorityBadge, WoStatusBadge } from './common';

// „Otvori incident" otvara incident-detalj; dinamički import prekida statički ciklus
// (incident-detail-dialog statički uvozi ovaj modul).
const IncidentDetailDialog = dynamic(
  () => import('./incident-detail-dialog').then((m) => m.IncidentDetailDialog),
  { ssr: false },
);

const STATUSES: WoStatus[] = [
  'novi', 'potvrden', 'dodeljen', 'u_radu', 'ceka_deo',
  'ceka_dobavljaca', 'ceka_korisnika', 'kontrola', 'zavrsen', 'otkazan',
];

/** Čitljive labele tipova događaja (paritet 1.0 eventTypeLabel maintWorkOrdersPanel.js:73-81). */
const EVENT_LABEL: Record<string, string> = {
  status_change: 'Promena statusa',
  assigned_change: 'Promena dodele',
  priority_change: 'Promena prioriteta',
  user_note: 'Napomena',
};

/** WO detalj: sredstvo+linkovi, dodela, status, prioritet, rok, closure, events + delovi (katalog) + rad. */
export function WoDetailDialog({ woId, me, onClose }: { woId: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const router = useRouter();
  const wo = useWorkOrder(woId);
  const assignable = useAssignableUsers(!!woId && (me?.gates.canEditWorkOrder ?? false));
  const update = useUpdateWorkOrder();
  const addEvent = useCreateWoEvent();
  const addPart = useCreateWoPart();
  const addLabor = useCreateWoLabor();
  const canEdit = me?.gates.canEditWorkOrder ?? false;
  // Katalog delova za autocomplete (samo za editore; BE uzima cenu/naziv autoritativno).
  const partsCatalog = useParts(canEdit && !!woId ? { pageSize: 500 } : {});

  const [comment, setComment] = useState('');
  const [closure, setClosure] = useState('');
  const [partName, setPartName] = useState('');
  const [partQty, setPartQty] = useState('');
  const [partUnit, setPartUnit] = useState('');
  const [partCost, setPartCost] = useState('');
  const [minutes, setMinutes] = useState('');
  const [laborNotes, setLaborNotes] = useState('');
  const [incidentOpen, setIncidentOpen] = useState(false);

  const d = wo.data?.data;
  const busy = update.isPending || addEvent.isPending || addPart.isPending || addLabor.isPending;

  const catalog = useMemo(() => {
    if (!canEdit) return [] as Part[];
    return ((partsCatalog.data?.data ?? []) as Part[]).filter((p) => p && p.partId);
  }, [partsCatalog.data, canEdit]);
  /** Kataloški deo koji tačno odgovara upisu (labela „šifra — naziv" ili sama šifra). */
  const selectedPart = useMemo(() => {
    const t = partName.trim();
    if (!t) return null;
    const low = t.toLowerCase();
    return (
      catalog.find((p) => `${p.partCode} — ${p.name}` === t || String(p.partCode).toLowerCase() === low) ?? null
    );
  }, [partName, catalog]);

  if (!woId) return null;
  // „Otvori incident" — incident-detalj preko sourceIncidentId (BE incidentId).
  if (incidentOpen && d?.incidentId) {
    return <IncidentDetailDialog id={d.incidentId} me={me} onClose={() => setIncidentOpen(false)} />;
  }

  function openMachine() {
    if (!d?.asset || d.asset.assetType !== 'machine') return;
    onClose();
    router.push(`/odrzavanje/masine?code=${encodeURIComponent(d.asset.assetCode)}&tab=pregled`);
  }

  function submitPart() {
    if (!d || !partName.trim()) return;
    const qty = partQty ? Number(partQty) : undefined;
    if (selectedPart) {
      // Kataloški deo: BE autoritativno uzima naziv/cenu + skida zalihu (out kretanje).
      addPart.mutate({ id: d.woId, partId: selectedPart.partId, partName: selectedPart.name, quantity: qty, unit: partUnit.trim() || undefined });
    } else {
      // Slobodan unos (bez partId) — zadržava ručna polja.
      addPart.mutate({
        id: d.woId,
        partName: partName.trim(),
        quantity: qty,
        unit: partUnit.trim() || undefined,
        unitCost: partCost ? Number(partCost) : undefined,
      });
    }
    setPartName(''); setPartQty(''); setPartUnit(''); setPartCost('');
  }

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
            {/* Sredstvo + linkovi (paritet 1.0 :513-525) */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-ink-secondary">
                Sredstvo: <span className="text-ink">{d.asset ? `${d.asset.assetCode} — ${d.asset.name}` : '—'}</span>
              </span>
              {d.asset?.assetType === 'machine' && (
                <button className="inline-flex items-center gap-1 text-accent" onClick={openMachine}>
                  Otvori mašinu <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
              )}
              {d.incidentId && (
                <button className="inline-flex items-center gap-1 text-accent" onClick={() => setIncidentOpen(true)}>
                  Otvori incident <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
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
                      <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>
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
              <div key={p.id} className="flex items-center justify-between gap-2 border-b border-line-soft py-1 text-sm">
                <span className="min-w-0 truncate text-ink">
                  {p.partName}
                  {p.supplier && <span className="text-ink-secondary"> · {p.supplier}</span>}
                </span>
                <span className="tnums shrink-0 text-ink-secondary">
                  {p.quantity ?? '—'} {p.unit ?? ''}{p.unitCost != null ? ` · ${p.unitCost}` : ''}
                </span>
              </div>
            ))}
            {canEdit && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={partName}
                    onChange={(e) => setPartName(e.target.value)}
                    placeholder="Naziv dela ili šifra iz kataloga"
                    className="min-w-40 flex-1"
                    list="mnt-wo-part-catalog"
                  />
                  <datalist id="mnt-wo-part-catalog">
                    {catalog.map((p) => (
                      <option key={p.partId} value={`${p.partCode} — ${p.name}`} />
                    ))}
                  </datalist>
                  <Input value={partUnit} onChange={(e) => setPartUnit(e.target.value)} placeholder="Jedinica" className="w-24" />
                  <Input value={partQty} onChange={(e) => setPartQty(e.target.value)} placeholder="Kol." className="w-20" inputMode="decimal" />
                  <Input
                    value={selectedPart ? String(selectedPart.unitCost ?? '') : partCost}
                    onChange={(e) => setPartCost(e.target.value)}
                    placeholder="Cena"
                    className="w-24"
                    inputMode="decimal"
                    disabled={!!selectedPart}
                    title={selectedPart ? 'Cena iz kataloga (BE autoritativno)' : undefined}
                  />
                  <Button variant="secondary" disabled={!partName.trim() || busy} onClick={submitPart}>
                    Dodaj
                  </Button>
                </div>
                {selectedPart && (
                  <p className="text-2xs text-ink-secondary">
                    Kataloški deo — zaliha se skida, cena/naziv iz kataloga.
                  </p>
                )}
              </div>
            )}
          </Section>

          {/* Rad */}
          <Section title={`Rad (${d.labor.length})`}>
            {d.labor.map((l) => (
              <Row key={l.id} left={`${l.minutes ?? 0} min`} right={l.notes ?? ''} />
            ))}
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minuta" className="w-28" inputMode="numeric" />
                <Input value={laborNotes} onChange={(e) => setLaborNotes(e.target.value)} placeholder="Napomena" className="min-w-40 flex-1" />
                <Button
                  variant="secondary"
                  disabled={!minutes || busy}
                  onClick={() => { addLabor.mutate({ id: d.woId, minutes: Number(minutes), notes: laborNotes.trim() || undefined }); setMinutes(''); setLaborNotes(''); }}
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
                  <span className="text-ink">{EVENT_LABEL[ev.eventType] ?? ev.eventType}</span>
                  <span className="text-2xs text-ink-secondary">{formatDateTime(ev.at)}</span>
                </div>
                {(ev.fromValue || ev.toValue) && (
                  <p className="text-ink-secondary">{ev.fromValue ?? '—'} → {ev.toValue ?? '—'}</p>
                )}
                {ev.comment && <p className="whitespace-pre-wrap text-ink-secondary">{ev.comment}</p>}
              </div>
            ))}
            {canEdit && (
              <div className="mt-2 flex gap-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Komentar…" className="flex-1" />
                <Button
                  variant="secondary"
                  disabled={!comment.trim() || busy}
                  onClick={() => { addEvent.mutate({ id: d.woId, eventType: 'user_note', comment }); setComment(''); }}
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
