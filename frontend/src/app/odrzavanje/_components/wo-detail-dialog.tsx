'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ExternalLink, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  readServiceInvoice,
  useAssignableUsers,
  useCreateWoEvent,
  useCreateWoLabor,
  useCreateWoPart,
  useParts,
  useUpdateWorkOrder,
  useWorkOrder,
  type AssignableUser,
  type MaintMe,
  type Part,
  type RacunPredlog,
  type WoPart,
  type WoStatus,
  type WorkOrderDetail,
} from '@/api/odrzavanje';
import { Field, money, parsePrice, WO_STATUS_LABEL, WO_TYPE_LABEL, WoPriorityBadge, WoStatusBadge } from './common';

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
  const [partName, setPartName] = useState('');
  const [partQty, setPartQty] = useState('');
  const [partUnit, setPartUnit] = useState('');
  const [partCost, setPartCost] = useState('');
  const [partErr, setPartErr] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('');
  const [laborNotes, setLaborNotes] = useState('');
  const [incidentOpen, setIncidentOpen] = useState(false);
  // Nesačuvane izmene edit panela (prijavljuje WoEditPanel) — guard za SVIH 5 puteva
  // zatvaranja: X / Esc / klik-van (Dialog.onClose) + „Otvori mašinu" + „Otvori incident".
  const [editDirty, setEditDirty] = useState(false);

  const d = wo.data?.data;
  const busy = update.isPending || addEvent.isPending || addPart.isPending || addLabor.isPending;

  /** true = bezbedno napustiti (nema izmena, ili je korisnik svesno odbacio). */
  function confirmDiscard(): boolean {
    return !editDirty || window.confirm('Imate nesačuvane izmene u nalogu. Zatvoriti bez čuvanja?');
  }
  function guardedClose() {
    if (confirmDiscard()) onClose();
  }

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
    if (!confirmDiscard()) return;
    onClose();
    router.push(`/odrzavanje/masine?code=${encodeURIComponent(d.asset.assetCode)}&tab=pregled`);
  }

  function submitPart() {
    setPartErr(null);
    if (!d) return;
    if (!partName.trim()) {
      return setPartErr('Naziv dela je obavezan — za samu cenu servisa koristi „Trošak popravke" ispod.');
    }
    const qty = partQty ? Number(partQty) : undefined;
    if (selectedPart) {
      // Kataloški deo: BE autoritativno uzima naziv/cenu + skida zalihu (out kretanje).
      addPart.mutate({ id: d.woId, partId: selectedPart.partId, partName: selectedPart.name, quantity: qty, unit: partUnit.trim() || undefined });
    } else {
      // Slobodan unos (bez partId) — zadržava ručna polja. `parsePrice` jer ljudi kucaju
      // „10din": goli Number() vrati NaN, BE ga odbije i upis tiho propadne.
      const cena = parsePrice(partCost);
      if (Number.isNaN(cena)) return setPartErr('Cena mora biti broj (npr. 10 ili 1.250,50).');
      addPart.mutate({
        id: d.woId,
        partName: partName.trim(),
        quantity: qty,
        unit: partUnit.trim() || undefined,
        unitCost: cena ?? undefined,
      });
    }
    setPartName(''); setPartQty(''); setPartUnit(''); setPartCost('');
  }

  return (
    <Dialog open={!!woId} onClose={guardedClose} title={d?.woNumber ? `Nalog ${d.woNumber}` : 'Radni nalog'}>
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
                <button
                  className="inline-flex items-center gap-1 text-accent"
                  // Render-switch na incident unmount-uje edit panel → guard i ovde.
                  onClick={() => { if (confirmDiscard()) setIncidentOpen(true); }}
                >
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

          {/* Trošak — rezime vide SVI (i bez prava izmene); unos je u edit panelu ispod. */}
          <TrosakRezime
            parts={d.parts}
            costTotal={d.costTotal}
            estimatedCost={d.estimatedCost}
            externalServicerName={d.externalServicerName}
          />

          {canEdit && (
            <WoEditPanel
              key={d.woId}
              d={d}
              assignableUsers={assignable.data?.data ?? []}
              update={update}
              onDirtyChange={setEditDirty}
            />
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
                  {/* Dugme je AKTIVNO i bez naziva — sivo dugme je izgledalo kao da
                      „Dodaj ne radi"; sada `submitPart` kaže šta tačno fali. */}
                  <Button variant="secondary" disabled={busy} onClick={submitPart}>
                    Dodaj
                  </Button>
                </div>
                {partErr && <p className="text-sm text-status-danger">{partErr}</p>}
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

/**
 * Edit panel naloga sa EKSPLICITNIM „Sačuvaj izmene" (zahtev 060/26 — Duško: „nema opciju
 * sačuvaj"). Raniji obrazac je čuvao svako polje NEMO na onChange/onBlur, bez potvrde i bez
 * prikaza greške — korisniku je izgledalo kao da se izmene ne čuvaju. Sada se izmene odlažu
 * (staged patch), jedno dugme šalje objedinjeni PATCH, uspeh = toast „Sačuvano", pad = vidljiva
 * poruka. `key={d.woId}` u pozivaocu resetuje nacrt pri promeni naloga.
 */
function WoEditPanel({
  d,
  assignableUsers,
  update,
  onDirtyChange,
}: {
  d: WorkOrderDetail;
  assignableUsers: AssignableUser[];
  update: ReturnType<typeof useUpdateWorkOrder>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);
  const [racun, setRacun] = useState<RacunPredlog | null>(null);
  /** Originalne (serverske) vrednosti — polje dirnuto pa vraćeno na ovo IZLAZI iz patch-a. */
  const original: Record<string, unknown> = {
    status: d.status,
    priority: d.priority,
    assignedTo: d.assignedTo ?? null,
    dueAt: d.dueAt ? d.dueAt.slice(0, 10) : '',
    closureComment: d.closureComment ?? '',
    // Trošak ide kroz ISTI staged patch (060/26): polja se drže kao TEKST dok se ne
    // sačuvaju, jer čovek kuca „42.800,50" — u broj se prevodi tek u `save()`.
    costTotal: d.costTotal == null ? '' : String(d.costTotal),
    estimatedCost: d.estimatedCost == null ? '' : String(d.estimatedCost),
    externalServicerName: d.externalServicerName ?? '',
    odometerKmAtService: d.odometerKmAtService == null ? '' : String(d.odometerKmAtService),
  };
  /** Odložena (još nesačuvana) vrednost polja, ili trenutna sa servera. */
  const staged = <T,>(key: string, fallback: T): T => (key in patch ? (patch[key] as T) : fallback);
  const stage = (key: string, value: unknown) => {
    setErr(null);
    setPatch((p) => {
      // Vraćeno na original → ključ napolje: dugme se gasi kad je sve vraćeno i ne
      // šalju se no-op vrednosti koje bi pregazile tuđu svežiju izmenu.
      if (value === original[key]) {
        if (!(key in p)) return p;
        const next = { ...p };
        delete next[key];
        return next;
      }
      return { ...p, [key]: value };
    });
  };
  const dirty = Object.keys(patch).length > 0;
  const effStatus = staged<WoStatus>('status', d.status);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  // Roditelj (WoDetailDialog) guard-uje zatvaranje po ovome. Cleanup je OBAVEZAN:
  // dijalog ostaje montiran posle zatvaranja (rana `return null` grana), pa bi
  // `editDirty` inače preživeo zatvaranje i lažno pitao pri sledećem otvaranju.
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  function save() {
    setErr(null);
    const body: Record<string, unknown> = { ...patch };
    // Rok se odlaže kao `yyyy-mm-dd` (vrednost inputa); u ISO se prevodi tek pri slanju.
    if ('dueAt' in body) {
      const v = String(body.dueAt ?? '');
      body.dueAt = v ? new Date(v).toISOString() : null;
    }
    // Novčana polja: tekst → broj tek ovde. Prazno = obriši (null), smeće = greška
    // (ranije je NaN odlazio na BE i upis je tiho propadao).
    for (const key of ['costTotal', 'estimatedCost'] as const) {
      if (!(key in body)) continue;
      const n = parsePrice(String(body[key] ?? ''));
      if (Number.isNaN(n)) {
        return setErr('Cena mora biti broj (npr. 42800 ili 42.800,50).');
      }
      body[key] = n;
    }
    if ('odometerKmAtService' in body) {
      const raw = String(body.odometerKmAtService ?? '').replace(/\D/g, '');
      body.odometerKmAtService = raw === '' ? null : Number(raw);
    }
    if ('externalServicerName' in body) {
      body.externalServicerName = String(body.externalServicerName ?? '').trim() || null;
    }
    // Napomena zatvaranja važi samo uz zatvarajući status — ako je status u međuvremenu
    // odložen na ne-zatvarajući, ne šalji je (polje je i sakriveno iz forme).
    if ('closureComment' in body && effStatus !== 'zavrsen' && effStatus !== 'kontrola') {
      delete body.closureComment;
    }
    update.mutate(
      { id: d.woId, patch: body },
      {
        onSuccess: () => { setPatch({}); toast('Sačuvano'); },
        onError: (e) => setErr((e as Error).message || 'Čuvanje nije uspelo.'),
      },
    );
  }

  return (
    <div className="space-y-3 rounded-panel border border-line p-3">
      {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Status">
          <select value={effStatus} onChange={(e) => stage('status', e.target.value)} className={selCls}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{WO_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Prioritet">
          <select
            value={staged('priority', d.priority)}
            onChange={(e) => stage('priority', e.target.value)}
            className={selCls}
          >
            {(['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'] as const).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Dodeljen">
          <select
            value={staged<string | null>('assignedTo', d.assignedTo ?? null) ?? ''}
            onChange={(e) => stage('assignedTo', e.target.value || null)}
            className={selCls}
          >
            <option value="">— nedodeljen —</option>
            {assignableUsers.map((u) => (
              <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>
            ))}
          </select>
        </FormField>
        <FormField label="Rok">
          <Input
            type="date"
            value={staged('dueAt', d.dueAt ? d.dueAt.slice(0, 10) : '')}
            onChange={(e) => stage('dueAt', e.target.value)}
          />
        </FormField>
      </div>
      {(effStatus === 'zavrsen' || effStatus === 'kontrola') && (
        <FormField label="Napomena zatvaranja">
          <Input
            value={staged('closureComment', d.closureComment ?? '')}
            onChange={(e) => stage('closureComment', e.target.value)}
            placeholder="Šta je urađeno…"
          />
        </FormField>
      )}

      {/* Trošak popravke — u istom panelu, pa ga hvata isto „Sačuvaj izmene" (060/26). */}
      <div className="border-t border-line-soft pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-ink">Trošak popravke</h4>
          <RacunCitac
            woId={d.woId}
            onRead={(p) => {
              // Račun samo ODLAŽE vrednosti u isti nacrt — čovek ih vidi, po potrebi
              // ispravi, pa potvrdi „Sačuvaj izmene". AI ne piše novac sam.
              if (p.ukupanIznos != null) stage('costTotal', String(p.ukupanIznos));
              if (p.serviser) stage('externalServicerName', p.serviser);
              if (p.kilometraza != null) stage('odometerKmAtService', String(p.kilometraza));
              setRacun(p);
            }}
          />
        </div>
        {racun && <RacunPredlogPregled predlog={racun} onClose={() => setRacun(null)} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Cena popravke (RSD)" hint="ceo iznos sa računa servisa">
            <Input
              value={staged('costTotal', original.costTotal as string)}
              onChange={(e) => stage('costTotal', e.target.value)}
              inputMode="decimal"
              placeholder="npr. 42800"
            />
          </FormField>
          <FormField label="Procenjena cena (RSD)">
            <Input
              value={staged('estimatedCost', original.estimatedCost as string)}
              onChange={(e) => stage('estimatedCost', e.target.value)}
              inputMode="decimal"
            />
          </FormField>
          <FormField label="Servis / radionica">
            <Input
              value={staged('externalServicerName', original.externalServicerName as string)}
              onChange={(e) => stage('externalServicerName', e.target.value)}
              placeholder="npr. Auto Čačak"
            />
          </FormField>
          {d.assetType === 'vehicle' && (
            <FormField label="Kilometraža na servisu">
              <Input
                value={staged('odometerKmAtService', original.odometerKmAtService as string)}
                onChange={(e) => stage('odometerKmAtService', e.target.value)}
                inputMode="numeric"
              />
            </FormField>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        {dirty && !update.isPending && <span className="text-2xs text-ink-secondary">Nesačuvane izmene</span>}
        <Button disabled={!dirty} loading={update.isPending} onClick={save}>
          Sačuvaj izmene
        </Button>
      </div>
    </div>
  );
}

/* ── Trošak popravke ───────────────────────────────────────────────────────── */

/** Σ(kol × cena) stavki „Delovi". */
export function woPartsSum(parts: WoPart[]): number {
  return parts.reduce((sum, p) => {
    const qty = Number(p.quantity ?? 0);
    const cost = Number(p.unitCost ?? 0);
    return sum + (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(cost) ? cost : 0);
  }, 0);
}
/**
 * Trošak naloga = VEĆI od (zbir delova, cena sa fakture). Nikad zbir oba: kad spoljni
 * servis fakturiše i delove koje smo popisali kao stavke, sabiranje bi ih brojalo
 * dvaput. Isto pravilo drži `effectiveWoCost` u BE-u — dva ekrana moraju dati isti broj.
 */
export function woEffectiveCost(parts: WoPart[], costTotal: string | number | null): number {
  const ct = Number(costTotal ?? 0);
  return Math.max(woPartsSum(parts), Number.isFinite(ct) ? ct : 0);
}

function TrosakRezime({
  parts, costTotal, estimatedCost, externalServicerName,
}: {
  parts: WoPart[];
  costTotal: string | number | null;
  estimatedCost: string | number | null;
  externalServicerName: string | null;
}) {
  const partsSum = woPartsSum(parts);
  const effective = woEffectiveCost(parts, costTotal);
  return (
    <div className="rounded-panel border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">Trošak popravke</h4>
        <span className="tnums text-md font-semibold text-ink">{money(effective)} RSD</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-ink-secondary">
        <span>Delovi (stavke): <span className="tnums">{money(partsSum)}</span></span>
        <span>Faktura servisa: <span className="tnums">{costTotal == null ? '—' : money(costTotal)}</span></span>
        {estimatedCost != null && <span>Procena: <span className="tnums">{money(estimatedCost)}</span></span>}
        {externalServicerName && <span>Servis: {externalServicerName}</span>}
      </div>
    </div>
  );
}

/** Dozvoljeni ulazi za čitanje računa (BE isto proverava — ovo je samo picker filter). */
const RACUN_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/gif';
const RACUN_MAX_FAJLOVA = 8;

/** „Pročitaj račun" — slika/PDF → AI predlog. Ne upisuje; puni nacrt edit panela. */
function RacunCitac({ woId, onRead }: { woId: string; onRead: (p: RacunPredlog) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    if (files.length > RACUN_MAX_FAJLOVA) return setErr(`Najviše ${RACUN_MAX_FAJLOVA} fajlova.`);
    setErr(null);
    setBusy(true);
    try {
      onRead((await readServiceInvoice(woId, files)).data);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input ref={fileRef} type="file" hidden multiple accept={RACUN_ACCEPT} onChange={pick} />
      <Button variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
        <Sparkles className="h-4 w-4" aria-hidden /> Pročitaj račun
      </Button>
      {err && <p className="mt-1 text-sm text-status-danger">{err}</p>}
    </div>
  );
}

/** Šta je model pročitao — kontekst uz polja koja je upravo popunio. */
function RacunPredlogPregled({ predlog, onClose }: { predlog: RacunPredlog; onClose: () => void }) {
  return (
    <div className="mb-3 space-y-1.5 rounded-panel border border-accent/40 bg-accent-subtle/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">Pročitano sa računa — proveri pa „Sačuvaj izmene"</span>
        <button onClick={onClose} className="text-2xs text-ink-secondary hover:text-ink">Sakrij</button>
      </div>
      {predlog.necitljivo.length > 0 && (
        <p className="rounded-control bg-status-warn-bg px-2 py-1 text-2xs text-ink">
          Nije pročitano: {predlog.necitljivo.join(', ')} — dopuni ručno.
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-ink-secondary">
        {predlog.datum && <span>Datum: {predlog.datum}</span>}
        {predlog.brojRacuna && <span>Broj: {predlog.brojRacuna}</span>}
        {predlog.registracija && <span>Tablice: {predlog.registracija}</span>}
        {predlog.iznosBezPdv != null && <span>Bez PDV-a: <span className="tnums">{money(predlog.iznosBezPdv)}</span></span>}
      </div>
      {predlog.opisRadova && <p className="text-sm text-ink-secondary">{predlog.opisRadova}</p>}
      {predlog.stavke.length > 0 && (
        <div className="max-h-32 overflow-auto rounded-control border border-line bg-surface">
          {predlog.stavke.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-2 border-b border-line-soft px-2 py-1 text-2xs last:border-0">
              <span className="min-w-0 truncate text-ink">{s.naziv}</span>
              <span className="tnums shrink-0 text-ink-secondary">
                {s.kolicina ?? '—'} {s.jedinica} {s.iznos != null ? `· ${money(s.iznos)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="text-2xs text-ink-secondary">
        Stavke su informativne — u „Delovi" ih dodaj ručno ako ih vodiš po komadu.
      </p>
    </div>
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
