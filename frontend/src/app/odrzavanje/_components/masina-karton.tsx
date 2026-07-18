'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, ChevronDown, ChevronRight, Download, FileWarning,
  Pencil, Pin, Plus, Trash2, Upload, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  signMachineFileUrl,
  useArchiveMachine,
  useAssignableUsers,
  useClearStatusOverride,
  useCreateCheck,
  useCreateNote,
  useCreateTask,
  useDeleteMachineFile,
  useDeleteMachineHard,
  useDeleteTask,
  useIncidents,
  useMachine,
  useMachineChecks,
  useMachineFiles,
  useMachineNotes,
  useMachineTasks,
  useRenameMachine,
  useRestoreMachine,
  useSetStatusOverride,
  useUpdateMachine,
  useUpdateMachineFile,
  useUpdateNote,
  useUpdateTask,
  useUploadMachineFile,
  type CheckResult,
  type IntervalUnit,
  type MachineDetail,
  type MachineFile,
  type MachineNote,
  type MaintCheck,
  type MaintMe,
  type MaintTask,
  type OpStatus,
} from '@/api/odrzavanje';
import { Field, OpStatusBadge, SEVERITY_LABEL } from './common';
import { AssetWorkOrders } from './asset-work-orders';
import { Tabs } from './tabs';
import { QrCanvas } from './qr-canvas';
import { PrijavaKvaraDialog } from './prijava-kvara-dialog';
import { IncidentDetailDialog } from './incident-detail-dialog';

type CardTab = 'pregled' | 'zadaci' | 'istorija' | 'napomene' | 'dokumenta' | 'sabloni';
const CARD_TABS: CardTab[] = ['pregled', 'zadaci', 'istorija', 'napomene', 'dokumenta', 'sabloni'];

const CHECK_RESULTS: { key: CheckResult; label: string }[] = [
  { key: 'ok', label: 'U redu' },
  { key: 'warning', label: 'Upozorenje' },
  { key: 'fail', label: 'Neispravno' },
  { key: 'skipped', label: 'Preskočeno' },
];
const OP_STATUSES: OpStatus[] = ['running', 'degraded', 'down', 'maintenance'];
const INTERVAL_UNITS: { key: IntervalUnit; label: string }[] = [
  { key: 'hours', label: 'Po satima' },
  { key: 'days', label: 'Dnevno' },
  { key: 'weeks', label: 'Nedeljno' },
  { key: 'months', label: 'Mesečno' },
];
const OPEN_INCIDENT = new Set(['open', 'acknowledged', 'in_progress', 'awaiting_parts']);

function readTab(): CardTab {
  if (typeof window === 'undefined') return 'pregled';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t && (CARD_TABS as string[]).includes(t) ? (t as CardTab) : 'pregled';
}

/**
 * Karton mašine kao RUTA (presuda §8.3). Deep-linkabilan tab (`?tab=`), browser Nazad radi
 * (pushState po tabu). Sadrži pun paritet 6 tabova + header quick-akcije + QR (lokalni render).
 */
export function MasinaKarton({ code, me }: { code: string; me: MaintMe | undefined }) {
  const router = useRouter();
  const machine = useMachine(code);
  const d = machine.data?.data;
  const [tab, setTabState] = useState<CardTab>('pregled');
  const [editOpen, setEditOpen] = useState(false);
  const [reportFor, setReportFor] = useState<{ code: string; name: string } | null>(null);
  const [incidentId, setIncidentId] = useState<string | null>(null);

  const restore = useRestoreMachine();

  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const canOverride = me?.gates.canManageMaintOverride ?? false;
  const canTasks = me?.gates.canManageMaintTasks ?? false;
  const canWrite = !!(me?.maintRole || me?.erpAdminOrManagement);

  useEffect(() => { setTabState(readTab()); }, []);
  useEffect(() => {
    const onPop = () => setTabState(readTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function setTab(next: CardTab) {
    setTabState(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'pregled') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.pushState(null, '', url.toString());
  }

  const tabs = [
    { key: 'pregled' as const, label: 'Pregled' },
    { key: 'zadaci' as const, label: 'Zadaci' },
    { key: 'istorija' as const, label: 'Istorija' },
    { key: 'napomene' as const, label: 'Napomene' },
    { key: 'dokumenta' as const, label: 'Dokumenta' },
    ...(canTasks ? [{ key: 'sabloni' as const, label: 'Šabloni' }] : []),
  ];

  return (
    <div className="space-y-4">
      <button onClick={() => router.push('/odrzavanje')} className="inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Održavanje
      </button>

      {machine.isLoading || !d ? (
        <p className="py-10 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <>
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-ink"><span className="tnums">{d.machineCode}</span> · {d.name}</h1>
                <OpStatusBadge status={d.effectiveStatus} />
              </div>
              {d.location && <p className="mt-0.5 text-sm text-ink-secondary">{d.location}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setReportFor({ code: d.machineCode, name: d.name })}><FileWarning className="h-4 w-4" aria-hidden /> Prijavi kvar</Button>
              <Button variant="secondary" onClick={() => setTab('zadaci')}><Wrench className="h-4 w-4" aria-hidden /> Potvrdi kontrolu</Button>
              {canOverride && <Button variant="secondary" onClick={() => setTab('pregled')}>Postavi status</Button>}
              {canManage && <Button onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" aria-hidden /> Uredi mašinu</Button>}
            </div>
          </div>

          {d.archivedAt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
              <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 text-status-warn" aria-hidden /> Mašina je ARHIVIRANA ({formatDate(d.archivedAt)}).</span>
              {canManage && <Button variant="secondary" onClick={() => restore.mutate({ code }, { onSuccess: () => toast('Mašina vraćena iz arhive') })}>Vrati iz arhive</Button>}
            </div>
          )}

          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Karton mašine" />

          {tab === 'pregled' && <PregledSub code={code} canManage={canManage} canOverride={canOverride} onEdit={() => setEditOpen(true)} onOpenIncident={setIncidentId} />}
          {tab === 'zadaci' && <ZadaciSub code={code} canWrite={canWrite} />}
          {tab === 'istorija' && <IstorijaSub code={code} assetId={d.assetId} me={me} onOpenIncident={setIncidentId} />}
          {tab === 'napomene' && <NapomeneSub code={code} me={me} canWrite={canWrite} />}
          {tab === 'dokumenta' && <DokumentaSub code={code} me={me} canUpload={canWrite} />}
          {tab === 'sabloni' && canTasks && <SabloniSub code={code} />}

          {editOpen && <EditMachineModal code={code} canManage={canManage} onClose={() => setEditOpen(false)} />}
        </>
      )}

      {reportFor && <PrijavaKvaraDialog me={me} fixedMachine={reportFor} onClose={() => setReportFor(null)} />}
      <IncidentDetailDialog id={incidentId} me={me} onClose={() => setIncidentId(null)} />
    </div>
  );
}

// ── Pregled ─────────────────────────────────────────────────────────
function PregledSub({ code, canManage, canOverride, onEdit, onOpenIncident }: {
  code: string; canManage: boolean; canOverride: boolean; onEdit: () => void; onOpenIncident: (id: string) => void;
}) {
  const machine = useMachine(code);
  const d = machine.data?.data;
  const incidents = useIncidents({ machineCode: code, pageSize: 100 });
  const tasks = useMachineTasks(code);
  const files = useMachineFiles(code);
  const [showTech, setShowTech] = useState(false);
  const qrUrl = typeof window !== 'undefined' && d ? `${window.location.origin}/odrzavanje/masine?code=${encodeURIComponent(d.machineCode)}` : '';

  if (!d) return null;
  const openIncidents = (incidents.data?.data ?? []).filter((i) => OPEN_INCIDENT.has(i.status));
  const taskCount = (tasks.data?.data ?? []).length;

  return (
    <div className="space-y-4">
      {/* Status + Stanje */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Status</div>
          <div className="mt-1"><OpStatusBadge status={d.effectiveStatus} /></div>
        </div>
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className={`tnums text-2xl font-semibold ${openIncidents.length ? 'text-status-danger' : 'text-ink'}`}>{openIncidents.length}</div>
          <div className="mt-1 text-2xs uppercase tracking-wider text-ink-secondary">Otvoreni kvarovi</div>
        </div>
        <div className="rounded-panel border border-line bg-surface p-4">
          <div className="tnums text-2xl font-semibold text-ink">{taskCount}</div>
          <div className="mt-1 text-2xs uppercase tracking-wider text-ink-secondary">Definisane kontrole</div>
        </div>
      </div>

      {/* Otvoreni kvarovi */}
      {openIncidents.length > 0 && (
        <div className="rounded-panel border border-line p-3">
          <h4 className="mb-2 text-sm font-semibold text-ink">Otvoreni kvarovi</h4>
          <div className="space-y-1">
            {openIncidents.map((i) => (
              <button key={i.id} onClick={() => onOpenIncident(i.id)} className="flex w-full items-center justify-between rounded-control border border-line-soft px-2.5 py-1.5 text-left text-sm hover:bg-surface-2">
                <span className="text-ink">{i.title}</span>
                <span className="flex items-center gap-2 text-2xs text-ink-secondary">
                  <StatusBadge tone={i.severity === 'critical' ? 'danger' : i.severity === 'major' ? 'warn' : 'info'} label={SEVERITY_LABEL[i.severity]} />
                  {formatDateTime(i.reportedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Osnovni podaci */}
      <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3 sm:grid-cols-3">
        <Field label="Tip">{d.type ?? '—'}</Field>
        <Field label="Lokacija">{d.location ?? '—'}</Field>
        <Field label="Odgovoran">{d.responsibleName ?? '—'}</Field>
        <Field label="Proizvođač / model">{[d.manufacturer, d.model].filter(Boolean).join(' / ') || '—'}</Field>
        <Field label="Praćenje">{d.tracked ? 'Prati se' : 'Ne prati se'}</Field>
        <Field label="Izvor">{d.source}</Field>
      </div>

      {/* Napomena (slobodan tekst) */}
      {d.notes && (
        <div className="rounded-panel border border-line p-3">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Napomena</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{d.notes}</p>
        </div>
      )}

      {/* Override */}
      <OverrideEditor code={code} canOverride={canOverride} statusOverride={d.statusOverride} />

      {/* Tehnički podaci (collapsible) */}
      <div className="rounded-panel border border-line">
        <button onClick={() => setShowTech((s) => !s)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-ink">
          {showTech ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />} Tehnički podaci
        </button>
        {showTech && (
          <div className="grid grid-cols-2 gap-3 border-t border-line p-3 sm:grid-cols-3">
            <Field label="Serijski broj">{d.serialNumber ?? '—'}</Field>
            <Field label="Godina proizvodnje">{d.yearOfManufacture ?? '—'}</Field>
            <Field label="Godina puštanja">{d.yearCommissioned ?? '—'}</Field>
            <Field label="Snaga (kW)">{d.powerKw ?? '—'}</Field>
            <Field label="Masa (kg)">{d.weightKg ?? '—'}</Field>
            <Field label="BigTehn / izvor">{d.source}</Field>
          </div>
        )}
      </div>

      {/* QR (lokalni render) */}
      {qrUrl && (
        <div className="flex items-center gap-3 rounded-panel border border-line p-3">
          <QrCanvas url={qrUrl} />
          <div className="text-sm text-ink-secondary">
            <div className="font-medium text-ink">QR kartica sredstva</div>
            <p className="mt-0.5 text-xs">Skeniranje otvara karton ove mašine. Renderuje se lokalno — ne šalje se van mreže.</p>
          </div>
        </div>
      )}

      {/* Upravljanje (canManage) */}
      {canManage && (
        <MachineAdmin code={code} d={d} onEdit={onEdit} filesCount={files.data?.data.length ?? 0} />
      )}
    </div>
  );
}

function MachineAdmin({ code, d, onEdit, filesCount }: {
  code: string; d: MachineDetail; onEdit: () => void; filesCount: number;
}) {
  const rename = useRenameMachine();
  const archive = useArchiveMachine();
  const restore = useRestoreMachine();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex flex-wrap gap-2 rounded-panel border border-line p-3">
      <Button variant="secondary" onClick={onEdit}>Uredi podatke</Button>
      <Button variant="secondary" onClick={() => setRenaming(true)}>Preimenuj šifru</Button>
      {d.archivedAt ? (
        <Button variant="secondary" onClick={() => restore.mutate({ code }, { onSuccess: () => toast('Vraćeno iz arhive') })}>Vrati iz arhive</Button>
      ) : (
        <Button variant="secondary" onClick={() => archive.mutate({ code }, { onSuccess: () => toast('Mašina arhivirana') })}>Arhiviraj</Button>
      )}
      <Button variant="danger" className="ml-auto" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" aria-hidden /> Trajno obriši</Button>

      {renaming && <RenameDialog code={code} rename={rename} onClose={() => setRenaming(false)} />}
      {deleting && <HardDeleteDialog code={code} name={d.name} filesCount={filesCount} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function RenameDialog({ code, rename, onClose }: { code: string; rename: ReturnType<typeof useRenameMachine>; onClose: () => void }) {
  const [nc, setNc] = useState(code);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onClose={onClose} title="Preimenuj šifru mašine"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button>
        <Button loading={rename.isPending} disabled={!nc.trim() || nc.trim() === code} onClick={() => {
          setErr(null);
          rename.mutate({ code, newCode: nc.trim() }, {
            onSuccess: (res) => {
              const r = (res as { data?: Record<string, unknown> }).data;
              const moved = r && typeof r === 'object'
                ? Object.entries(r).filter(([, v]) => typeof v === 'number' && (v as number) > 0).map(([k, v]) => `${k}: ${v}`).join(', ')
                : '';
              toast(moved ? `Šifra promenjena. Preseljeno — ${moved}` : 'Šifra promenjena.');
              onClose();
            },
            onError: (e) => setErr((e as Error).message),
          });
        }}>Preimenuj</Button></>}>
      <div className="space-y-2">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Nova šifra" hint="Atomski se prenose kontrole, kvarovi, nalozi, napomene i fajlovi."><Input value={nc} onChange={(e) => setNc(e.target.value)} /></FormField>
      </div>
    </Dialog>
  );
}

function HardDeleteDialog({ code, name, filesCount, onClose }: { code: string; name: string; filesCount: number; onClose: () => void }) {
  const router = useRouter();
  const del = useDeleteMachineHard();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = reason.trim().length >= 5 && confirm;

  return (
    <Dialog open onClose={onClose} title="Trajno brisanje mašine"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button>
        <Button variant="danger" loading={del.isPending} disabled={!ok} onClick={() => {
          setErr(null);
          del.mutate({ code, reason: reason.trim() }, {
            onSuccess: () => { toast('Mašina trajno obrisana'); onClose(); router.push('/odrzavanje'); },
            onError: (e) => setErr((e as Error).message),
          });
        }}>Obriši zauvek</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="flex items-start gap-2 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Trajno se briše <strong>{code} · {name}</strong> sa celom istorijom (kontrole, kvarovi, nalozi, napomene) i <strong>{filesCount}</strong> dokumenata. Radnja je nepovratna — razmotrite arhiviranje.</span>
        </div>
        <FormField label="Razlog (min 5 znakova)" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Zašto se trajno briše" /></FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Razumem da je brisanje trajno i potvrđujem.
        </label>
      </div>
    </Dialog>
  );
}

// ── Override editor (valid_until + edit) ────────────────────────────
function OverrideEditor({ code, canOverride, statusOverride }: {
  code: string; canOverride: boolean; statusOverride: { status: OpStatus; reason: string; validUntil: string | null } | null;
}) {
  const setOverride = useSetStatusOverride();
  const clearOverride = useClearStatusOverride();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<OpStatus>(statusOverride?.status ?? 'maintenance');
  const [reason, setReason] = useState(statusOverride?.reason ?? '');
  const [permanent, setPermanent] = useState(!statusOverride?.validUntil);
  const [validUntil, setValidUntil] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function startEdit() {
    setStatus(statusOverride?.status ?? 'maintenance');
    setReason(statusOverride?.reason ?? '');
    setPermanent(!statusOverride?.validUntil);
    setValidUntil(statusOverride?.validUntil ? toLocalInput(statusOverride.validUntil) : '');
    setErr(null);
    setEditing(true);
  }

  function save() {
    setErr(null);
    if (!reason.trim()) return setErr('Razlog je obavezan.');
    let iso: string | undefined;
    if (!permanent) {
      if (!validUntil) return setErr('Unesite „Važi do" ili izaberite trajno.');
      const t = new Date(validUntil);
      if (t.getTime() <= Date.now()) return setErr('„Važi do" mora biti u budućnosti.');
      iso = t.toISOString();
    }
    setOverride.mutate({ code, status, reason: reason.trim(), validUntil: iso }, {
      onSuccess: () => { setEditing(false); toast('Ručni status postavljen'); },
      onError: (e) => setErr((e as Error).message),
    });
  }

  return (
    <div className="rounded-panel border border-line p-3">
      <h4 className="mb-2 text-sm font-semibold text-ink">Ručni status</h4>
      {statusOverride && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <OpStatusBadge status={statusOverride.status} />
            <span className="text-ink-secondary">{statusOverride.reason}</span>
            {statusOverride.validUntil && <span className="text-2xs text-ink-secondary">važi do {formatDateTime(statusOverride.validUntil)}</span>}
          </span>
          {canOverride && (
            <span className="flex gap-1.5">
              <Button variant="ghost" onClick={startEdit}>Izmeni</Button>
              <Button variant="ghost" onClick={() => clearOverride.mutate({ code }, { onSuccess: () => toast('Ručni status uklonjen') })}>Ukloni</Button>
            </span>
          )}
        </div>
      ) : canOverride && (editing || !statusOverride) ? (
        <div className="space-y-2">
          {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value as OpStatus)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {OP_STATUSES.map((s) => <option key={s} value={s}>{OP_LABEL[s]}</option>)}
            </select>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Razlog" className="min-w-40 flex-1" />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} /> Trajno (bez isteka)
          </label>
          {!permanent && (
            <FormField label="Važi do">
              <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink" />
            </FormField>
          )}
          <div className="flex justify-end gap-2">
            {editing && <Button variant="ghost" onClick={() => setEditing(false)}>Otkaži</Button>}
            <Button variant="secondary" loading={setOverride.isPending} onClick={save}>Postavi</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">Nema aktivnog ručnog statusa.</p>
      )}
    </div>
  );
}
const OP_LABEL: Record<OpStatus, string> = { running: 'U radu', degraded: 'Smetnja', down: 'Zastoj', maintenance: 'Održavanje' };
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Edit mašine (pun modal, H1) ─────────────────────────────────────
function EditMachineModal({ code, canManage, onClose }: { code: string; canManage: boolean; onClose: () => void }) {
  const machine = useMachine(code);
  const d = machine.data?.data;
  const update = useUpdateMachine();
  const assignable = useAssignableUsers(canManage);
  const users = assignable.data?.data ?? [];

  const [name, setName] = useState(d?.name ?? '');
  const [type, setType] = useState(d?.type ?? '');
  const [manufacturer, setMfg] = useState(d?.manufacturer ?? '');
  const [model, setModel] = useState(d?.model ?? '');
  const [serialNumber, setSerial] = useState(d?.serialNumber ?? '');
  const [yearOfManufacture, setYom] = useState(d?.yearOfManufacture != null ? String(d.yearOfManufacture) : '');
  const [yearCommissioned, setYc] = useState(d?.yearCommissioned != null ? String(d.yearCommissioned) : '');
  const [location, setLoc] = useState(d?.location ?? '');
  const [powerKw, setPower] = useState(d?.powerKw != null ? String(d.powerKw) : '');
  const [weightKg, setWeight] = useState(d?.weightKg != null ? String(d.weightKg) : '');
  const [notes, setNotes] = useState(d?.notes ?? '');
  const [tracked, setTracked] = useState(d?.tracked ?? true);
  const [responsibleUserId, setResp] = useState(d?.responsibleUserId ?? '');
  const [err, setErr] = useState<string | null>(null);

  if (!d) return null;
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  function save() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    const patch: Record<string, unknown> = {
      name: name.trim(),
      type: type || null,
      manufacturer: manufacturer || null,
      model: model || null,
      serialNumber: serialNumber || null,
      yearOfManufacture: numOrNull(yearOfManufacture),
      yearCommissioned: numOrNull(yearCommissioned),
      location: location || null,
      powerKw: numOrNull(powerKw),
      weightKg: numOrNull(weightKg),
      notes: notes || null,
      tracked,
      responsibleUserId: responsibleUserId || null,
    };
    update.mutate({ code, patch }, { onSuccess: () => { toast('Mašina sačuvana'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} dismissable={false} title="Uredi mašinu" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={update.isPending} onClick={save}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra"><Input value={d.machineCode} disabled /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Tip"><Input value={type} onChange={(e) => setType(e.target.value)} /></FormField>
          <FormField label="Lokacija"><Input value={location} onChange={(e) => setLoc(e.target.value)} /></FormField>
          <FormField label="Proizvođač"><Input value={manufacturer} onChange={(e) => setMfg(e.target.value)} /></FormField>
          <FormField label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></FormField>
          <FormField label="Serijski broj"><Input value={serialNumber} onChange={(e) => setSerial(e.target.value)} /></FormField>
          <FormField label="Odgovoran">
            <select value={responsibleUserId} onChange={(e) => setResp(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">— niko —</option>
              {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>)}
            </select>
          </FormField>
          <FormField label="Godina proizvodnje"><Input value={yearOfManufacture} onChange={(e) => setYom(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Godina puštanja"><Input value={yearCommissioned} onChange={(e) => setYc(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Snaga (kW)"><Input value={powerKw} onChange={(e) => setPower(e.target.value)} inputMode="decimal" /></FormField>
          <FormField label="Masa (kg)"><Input value={weightKg} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" /></FormField>
        </div>
        <FormField label="Napomena"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} /> Prati se (uključena u preventivu/rokove)
        </label>
      </div>
    </Dialog>
  );
}

// ── Zadaci (kontrole) — grupisano + ✓ OK ────────────────────────────
function ZadaciSub({ code, canWrite }: { code: string; canWrite: boolean }) {
  const tasks = useMachineTasks(code);
  const createCheck = useCreateCheck();
  const [active, setActive] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const rows = tasks.data?.data ?? [];

  const groups = useMemo(() => {
    const m = new Map<IntervalUnit, MaintTask[]>();
    for (const t of rows) { const g = m.get(t.intervalUnit) ?? []; g.push(t); m.set(t.intervalUnit, g); }
    return m;
  }, [rows]);

  function quickOk(t: MaintTask) {
    createCheck.mutate({ taskId: t.id, machineCode: code, result: 'ok' }, { onSuccess: () => toast('Kontrola potvrđena (OK)') });
  }

  if (tasks.isLoading) return <p className="py-4 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-ink-secondary">Nema definisanih kontrola za ovu mašinu.</p>;

  return (
    <div className="space-y-4">
      {INTERVAL_UNITS.filter((u) => groups.has(u.key)).map((u) => (
        <div key={u.key}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-secondary">{u.label}</h4>
          <div className="space-y-2">
            {(groups.get(u.key) ?? []).map((t) => (
              <div key={t.id} className="rounded-control border border-line p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{t.title}</span>
                  <span className="flex items-center gap-2 text-2xs text-ink-secondary">
                    <span>{t.intervalValue} {u.label.toLowerCase()}</span>
                    {canWrite && <Button variant="secondary" disabled={createCheck.isPending} onClick={() => quickOk(t)}>✓ OK</Button>}
                  </span>
                </div>
                {t.description && <p className="mt-0.5 text-xs text-ink-secondary">{t.description}</p>}
                {active === t.id ? (
                  <div className="mt-2 space-y-2">
                    <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Napomena (opciono)" />
                    <div className="flex flex-wrap gap-1.5">
                      {CHECK_RESULTS.map((r) => (
                        <Button key={r.key} variant="secondary" disabled={createCheck.isPending} onClick={() => createCheck.mutate({ taskId: t.id, machineCode: code, result: r.key, notes: notes || undefined }, { onSuccess: () => { setActive(null); setNotes(''); toast('Kontrola zabeležena'); } })}>
                          {r.label}
                        </Button>
                      ))}
                      <Button variant="ghost" onClick={() => setActive(null)}>Otkaži</Button>
                    </div>
                  </div>
                ) : canWrite ? (
                  <button className="mt-1 text-xs text-accent" onClick={() => { setActive(t.id); setNotes(''); }}>Potvrdi sa rezultatom…</button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
      {!canWrite && <p className="text-2xs text-ink-disabled">Kontrole potvrđuju operateri/tehničari zaduženi za mašinu.</p>}
    </div>
  );
}

// ── Istorija (merged timeline) ──────────────────────────────────────
type TimelineItem =
  | { kind: 'incident'; at: number; id: string; title: string; severity: 'minor' | 'major' | 'critical'; woNumber: string | null }
  | { kind: 'check'; at: number; id: string; result: CheckResult; notes: string | null };

function IstorijaSub({ code, assetId, me, onOpenIncident }: {
  code: string; assetId: string; me: MaintMe | undefined; onOpenIncident: (id: string) => void;
}) {
  const inc = useIncidents({ machineCode: code, pageSize: 100 });
  const checks = useMachineChecks(code);

  const items: TimelineItem[] = useMemo(() => {
    const out: TimelineItem[] = [];
    for (const i of inc.data?.data ?? []) out.push({ kind: 'incident', at: Date.parse(i.reportedAt), id: i.id, title: i.title, severity: i.severity, woNumber: i.workOrder?.woNumber ?? null });
    for (const c of (checks.data?.data ?? []) as MaintCheck[]) out.push({ kind: 'check', at: Date.parse(c.performedAt), id: c.id, result: c.result, notes: c.notes });
    return out.sort((a, b) => b.at - a.at);
  }, [inc.data, checks.data]);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-ink">Vremenska linija (kvarovi + kontrole)</h4>
        {inc.isLoading || checks.isLoading ? (
          <p className="py-4 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Nema zabeleženih kvarova ni kontrola.</p>
        ) : (
          <div className="space-y-1.5">
            {items.map((it) => it.kind === 'incident' ? (
        <button key={`i${it.id}`} onClick={() => onOpenIncident(it.id)} className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-3 py-2 text-left text-sm hover:bg-surface-2">
          <span className="flex items-center gap-2">
            <StatusBadge tone={it.severity === 'critical' ? 'danger' : it.severity === 'major' ? 'warn' : 'info'} label="Kvar" />
            <span className="text-ink">{it.title}</span>
            {it.woNumber && <span className="tnums rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">Nalog {it.woNumber}</span>}
          </span>
          <span className="text-2xs text-ink-secondary">{formatDateTime(new Date(it.at).toISOString())}</span>
        </button>
      ) : (
        <div key={`c${it.id}`} className="flex items-center justify-between gap-2 rounded-control border border-line-soft px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <CheckBadge result={it.result} />
            {it.notes && <span className="text-ink-secondary">{it.notes}</span>}
          </span>
          <span className="text-2xs text-ink-secondary">{formatDateTime(new Date(it.at).toISOString())}</span>
        </div>
            ))}
          </div>
        )}
      </div>
      <AssetWorkOrders assetId={assetId} me={me} title="Radni nalozi mašine" />
    </div>
  );
}

function CheckBadge({ result }: { result: CheckResult }) {
  const map: Record<CheckResult, { tone: 'success' | 'warn' | 'danger' | 'neutral'; label: string }> = {
    ok: { tone: 'success', label: 'OK' },
    warning: { tone: 'warn', label: 'UPOZORENJE' },
    fail: { tone: 'danger', label: 'NEISPRAVNO' },
    skipped: { tone: 'neutral', label: 'PRESKOČENO' },
  };
  const m = map[result];
  return <StatusBadge tone={m.tone} label={`Kontrola · ${m.label}`} />;
}

// ── Napomene (dodaj + pin + edit + soft-delete) ─────────────────────
function NapomeneSub({ code, me, canWrite }: { code: string; me: MaintMe | undefined; canWrite: boolean }) {
  const notes = useMachineNotes(code);
  const create = useCreateNote();
  const update = useUpdateNote();
  const [text, setText] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const rows = notes.data?.data ?? [];
  const isChiefAdmin = me?.maintRole === 'chief' || me?.maintRole === 'admin' || !!me?.erpAdminOrManagement;

  function canEditNote(note: MachineNote) {
    // Paritet 1.0 maintNoteBodyEditable: šef/admin/ERP uvek; inače autor ≤24h.
    if (isChiefAdmin) return true;
    if (!me?.profile?.userId || note.author !== me.profile.userId) return false;
    return Date.now() - Date.parse(note.createdAt) < 24 * 3600 * 1000;
  }

  return (
    <div className="space-y-2">
      {canWrite && (
        <div className="flex gap-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Nova napomena…" className="flex-1" />
          <Button variant="secondary" disabled={!text.trim() || create.isPending} onClick={() => create.mutate({ code, content: text }, { onSuccess: () => { setText(''); toast('Napomena dodata'); } })}>Dodaj</Button>
        </div>
      )}
      {rows.length === 0 ? <p className="py-4 text-center text-sm text-ink-secondary">Nema napomena.</p> : rows.map((n) => (
        <div key={n.id} className="rounded-control border border-line p-2.5 text-sm">
          {editId === n.id ? (
            <div className="space-y-2">
              <Textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={2} />
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" onClick={() => setEditId(null)}>Otkaži</Button>
                <Button variant="secondary" disabled={!editText.trim()} onClick={() => update.mutate({ code, noteId: n.id, patch: { content: editText } }, { onSuccess: () => { setEditId(null); toast('Napomena izmenjena'); } })}>Snimi</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="whitespace-pre-wrap text-ink">{n.content}</span>
                <div className="flex shrink-0 items-center gap-1">
                  {n.pinned && <StatusBadge tone="info" label="Zakačeno" />}
                  {canWrite && (
                    <button title={n.pinned ? 'Otkači' : 'Zakači'} onClick={() => update.mutate({ code, noteId: n.id, patch: { pinned: !n.pinned } })} className={n.pinned ? 'text-accent' : 'text-ink-disabled'}>
                      <Pin className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                  {canWrite && canEditNote(n) && (
                    <button title="Izmeni" onClick={() => { setEditId(n.id); setEditText(n.content); }} className="text-ink-disabled hover:text-ink">
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                  {canWrite && canEditNote(n) && (
                    <button title="Obriši" onClick={() => update.mutate({ code, noteId: n.id, patch: { deleted: true } }, { onSuccess: () => toast('Napomena obrisana') })} className="text-ink-disabled hover:text-status-danger">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
              <span className="text-2xs text-ink-secondary">{formatDateTime(n.createdAt)}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Dokumenta (upload operator+, kategorija/opis, meta edit, delete) ─
const DOC_CATEGORIES = ['uputstvo', 'atest', 'garancija', 'shema', 'servis', 'foto', 'ostalo'];
function fmtSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function DokumentaSub({ code, me, canUpload }: { code: string; me: MaintMe | undefined; canUpload: boolean }) {
  const files = useMachineFiles(code);
  const upload = useUploadMachineFile();
  const del = useDeleteMachineFile();
  const patchMeta = useUpdateMachineFile();
  const [category, setCategory] = useState('uputstvo');
  const [description, setDescription] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editCat, setEditCat] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const rows = files.data?.data ?? [];
  const isChiefAdmin = me?.maintRole === 'chief' || me?.maintRole === 'admin' || !!me?.erpAdminOrManagement;

  async function open(id: string) {
    try { const res = await signMachineFileUrl(code, id); window.open(res.data.url, '_blank'); }
    catch { toast('Dokument nije dostupan (storage).'); }
  }
  function onPick(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('Dokument veći od 25 MB.'); return; }
    upload.mutate({ code, file, category, description: description || undefined }, { onSuccess: () => { setDescription(''); toast('Dokument otpremljen'); } });
  }
  function canDeleteDoc(doc: MachineFile) {
    // Paritet 1.0 canDeleteFile: šef/admin/ERP uvek; inače vlasnik ≤24h.
    if (isChiefAdmin) return true;
    if (!me?.profile?.userId || !doc.uploadedBy || doc.uploadedBy !== me.profile.userId) return false;
    return Date.now() - Date.parse(doc.uploadedAt) < 24 * 3600 * 1000;
  }

  return (
    <div className="space-y-2">
      {canUpload && (
        <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
          <FormField label="Kategorija">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Opis"><Input value={description} onChange={(e) => setDescription(e.target.value)} className="w-56" placeholder="Kratak opis" /></FormField>
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-control border border-dashed border-line px-3 text-sm text-ink-secondary hover:bg-surface-2">
            <Upload className="h-4 w-4" aria-hidden /> {upload.isPending ? 'Otpremanje…' : 'Izaberi fajl'}
            <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.dwg,.dxf" onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      )}
      {rows.length === 0 ? <p className="py-4 text-center text-sm text-ink-secondary">Nema dokumenata.</p> : rows.map((doc) => (
        <div key={doc.id} className="rounded-control border border-line p-2.5 text-sm">
          {editId === doc.id ? (
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="Kategorija">
                <select value={editCat} onChange={(e) => setEditCat(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
                  {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FormField>
              <FormField label="Opis"><Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="w-56" /></FormField>
              <Button variant="ghost" onClick={() => setEditId(null)}>Otkaži</Button>
              <Button variant="secondary" onClick={() => patchMeta.mutate({ code, id: doc.id, patch: { category: editCat, description: editDesc } }, { onSuccess: () => { setEditId(null); toast('Meta sačuvana'); } })}>Snimi</Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => open(doc.id)} className="flex items-center gap-2 text-left text-accent"><Download className="h-3.5 w-3.5" aria-hidden />{doc.fileName}</button>
              <div className="flex items-center gap-2 text-2xs text-ink-secondary">
                {doc.category && <StatusBadge tone="neutral" label={doc.category} />}
                <span>{fmtSize(doc.sizeBytes)}</span>
                {canUpload && <button title="Uredi meta" onClick={() => { setEditId(doc.id); setEditCat(doc.category ?? 'ostalo'); setEditDesc(doc.description ?? ''); }} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>}
                {canUpload && canDeleteDoc(doc) && <button title="Obriši" onClick={() => del.mutate({ code, id: doc.id }, { onSuccess: () => toast('Dokument obrisan') })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
              </div>
            </div>
          )}
          {doc.description && editId !== doc.id && <p className="mt-1 text-xs text-ink-secondary">{doc.description}</p>}
        </div>
      ))}
    </div>
  );
}

// ── Šabloni kontrola (chief/admin/ERP) — pun modal + edit + arhiviraj ─
const TASK_SEVERITIES = [
  { key: 'normal', label: 'Normalna' },
  { key: 'important', label: 'Važna' },
  { key: 'critical', label: 'Kritična' },
];
const TASK_ROLES = ['operator', 'technician', 'chief', 'admin'];
function SabloniSub({ code }: { code: string }) {
  const tasks = useMachineTasks(code);
  const create = useCreateTask();
  const update = useUpdateTask();
  const del = useDeleteTask();
  const [form, setForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const rows = tasks.data?.data ?? [];

  return (
    <div className="space-y-2">
      {!form && !editId && <Button variant="secondary" onClick={() => setForm(true)}><Plus className="h-4 w-4" aria-hidden /> Novi šablon kontrole</Button>}
      {form && <TaskForm code={code} onClose={() => setForm(false)} onSubmit={(v, done) => create.mutate({ machineCode: code, ...v }, { onSuccess: () => { done(); toast('Šablon dodat'); } })} pending={create.isPending} />}

      {rows.map((t) => editId === t.id ? (
        <TaskForm key={t.id} code={code} initial={t} onClose={() => setEditId(null)} onSubmit={(v, done) => update.mutate({ id: t.id, patch: v }, { onSuccess: () => { done(); toast('Šablon izmenjen'); } })} pending={update.isPending} />
      ) : (
        <div key={t.id} className="rounded-control border border-line p-2.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink">{t.title} <span className="text-ink-secondary">· {t.intervalValue} {INTERVAL_UNITS.find((u) => u.key === t.intervalUnit)?.label.toLowerCase() ?? t.intervalUnit}</span></span>
            <div className="flex items-center gap-1.5">
              {!t.active && <StatusBadge tone="neutral" label="Neaktivan" />}
              <button title="Izmeni" onClick={() => setEditId(t.id)} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
              {t.active ? (
                <button title="Arhiviraj" onClick={() => { if (confirm('Arhiviranje deaktivira šablon (istorija se čuva). Nastaviti?')) update.mutate({ id: t.id, patch: { active: false } }, { onSuccess: () => toast('Šablon arhiviran') }); }} className="text-ink-disabled hover:text-status-warn"><FileWarning className="h-3.5 w-3.5" aria-hidden /></button>
              ) : (
                <button title="Aktiviraj" onClick={() => update.mutate({ id: t.id, patch: { active: true } }, { onSuccess: () => toast('Šablon aktiviran') })} className="text-ink-disabled hover:text-status-success"><Wrench className="h-3.5 w-3.5" aria-hidden /></button>
              )}
              <button title="Obriši zauvek (briše istoriju)" onClick={() => { if (confirm('TRAJNO brisanje uništava istoriju kontrola. Preporučuje se arhiviranje. Obrisati?')) del.mutate({ id: t.id }, { onSuccess: () => toast('Šablon obrisan') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
            </div>
          </div>
          {t.description && <p className="mt-0.5 text-xs text-ink-secondary">{t.description}</p>}
          {t.instructions && <p className="mt-0.5 text-2xs text-ink-secondary">Uputstvo: {t.instructions}</p>}
          <p className="mt-0.5 text-2xs text-ink-secondary">Ozbiljnost: {TASK_SEVERITIES.find((s) => s.key === t.severity)?.label ?? t.severity} · Uloga: {t.requiredRole} · Grejs: {t.gracePeriodDays} d</p>
        </div>
      ))}
    </div>
  );
}

function TaskForm({ initial, onClose, onSubmit, pending }: {
  code: string; initial?: MaintTask; onClose: () => void; onSubmit: (v: Record<string, unknown>, done: () => void) => void; pending: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [val, setVal] = useState(String(initial?.intervalValue ?? 30));
  const [unit, setUnit] = useState<IntervalUnit>(initial?.intervalUnit ?? 'days');
  const [severity, setSeverity] = useState<string>(initial?.severity ?? 'normal');
  const [requiredRole, setRole] = useState<string>(initial?.requiredRole ?? 'operator');
  const [grace, setGrace] = useState(String(initial?.gracePeriodDays ?? 0));
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-panel border border-line p-3">
      {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Naziv" required><Input value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
        <div className="grid grid-cols-2 gap-2">
          <FormField label="Interval"><Input value={val} onChange={(e) => setVal(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Jedinica">
            <select value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {INTERVAL_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Ozbiljnost">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {TASK_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </FormField>
        <FormField label="Potrebna uloga">
          <select value={requiredRole} onChange={(e) => setRole(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {TASK_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </FormField>
        <FormField label="Grejs period (dana)"><Input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" /></FormField>
      </div>
      <FormField label="Opis"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></FormField>
      <FormField label="Uputstvo"><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} /></FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Otkaži</Button>
        <Button variant="secondary" loading={pending} onClick={() => {
          setErr(null);
          if (!title.trim()) return setErr('Naziv je obavezan.');
          const iv = Number(val); if (!Number.isFinite(iv) || iv <= 0) return setErr('Interval mora biti pozitivan broj.');
          onSubmit({ title: title.trim(), description: description || undefined, instructions: instructions || undefined, intervalValue: iv, intervalUnit: unit, severity, requiredRole, gracePeriodDays: Number(grace) || 0 }, onClose);
        }}>Sačuvaj</Button>
      </div>
    </div>
  );
}
