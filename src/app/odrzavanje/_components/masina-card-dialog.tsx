'use client';

import { useState } from 'react';
import { Download, Pin, Plus, Trash2, Upload } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  signMachineFileUrl,
  useArchiveMachine,
  useClearStatusOverride,
  useCreateCheck,
  useCreateNote,
  useCreateTask,
  useDeleteMachineFile,
  useDeleteMachineHard,
  useDeleteTask,
  useIncidents,
  useMachine,
  useRenameMachine,
  useRestoreMachine,
  useMachineChecks,
  useMachineFiles,
  useMachineNotes,
  useMachineTasks,
  useSetStatusOverride,
  useUpdateMachine,
  useUpdateNote,
  useUploadMachineFile,
  type CheckResult,
  type IntervalUnit,
  type MaintMe,
  type OpStatus,
} from '@/api/odrzavanje';
import { Field, OpStatusBadge } from './common';
import { Tabs } from './tabs';

type CardTab = 'pregled' | 'zadaci' | 'istorija' | 'napomene' | 'dokumenta' | 'sabloni';

const CHECK_RESULTS: { key: CheckResult; label: string }[] = [
  { key: 'ok', label: 'U redu' },
  { key: 'warning', label: 'Upozorenje' },
  { key: 'fail', label: 'Neispravno' },
  { key: 'skipped', label: 'Preskočeno' },
];
const OP_STATUSES: OpStatus[] = ['running', 'degraded', 'down', 'maintenance'];

export function MasinaCardDialog({ code, me, onClose }: { code: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const [tab, setTab] = useState<CardTab>('pregled');
  const machine = useMachine(code);
  const d = machine.data?.data;

  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const canOverride = me?.gates.canManageMaintOverride ?? false;
  const canTasks = me?.gates.canManageMaintTasks ?? false;

  if (!code) return null;

  const tabs = [
    { key: 'pregled' as const, label: 'Pregled' },
    { key: 'zadaci' as const, label: 'Zadaci' },
    { key: 'istorija' as const, label: 'Istorija' },
    { key: 'napomene' as const, label: 'Napomene' },
    { key: 'dokumenta' as const, label: 'Dokumenta' },
    ...(canTasks ? [{ key: 'sabloni' as const, label: 'Šabloni' }] : []),
  ];

  return (
    <Dialog open={!!code} onClose={onClose} title={d ? `${d.machineCode} · ${d.name}` : 'Karton mašine'}>
      {machine.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Karton mašine" />
          {tab === 'pregled' && <PregledSub code={code} canManage={canManage} canOverride={canOverride} onClose={onClose} />}
          {tab === 'zadaci' && <ZadaciSub code={code} me={me} />}
          {tab === 'istorija' && <IstorijaSub code={code} />}
          {tab === 'napomene' && <NapomeneSub code={code} />}
          {tab === 'dokumenta' && <DokumentaSub code={code} canManage={canManage} />}
          {tab === 'sabloni' && canTasks && <SabloniSub code={code} />}
        </div>
      )}
    </Dialog>
  );
}

// ── Pregled ────────────────────────────────────────────────────────
function PregledSub({ code, canManage, canOverride, onClose }: { code: string; canManage: boolean; canOverride: boolean; onClose: () => void }) {
  const machine = useMachine(code);
  const d = machine.data?.data;
  const setOverride = useSetStatusOverride();
  const clearOverride = useClearStatusOverride();
  const update = useUpdateMachine();
  const archive = useArchiveMachine();
  const restore = useRestoreMachine();
  const rename = useRenameMachine();
  const hardDelete = useDeleteMachineHard();
  const [editing, setEditing] = useState(false);
  const [ovStatus, setOvStatus] = useState<OpStatus>('maintenance');
  const [ovReason, setOvReason] = useState('');
  const qr = typeof window !== 'undefined' && d ? `${window.location.origin}/odrzavanje?machine=${encodeURIComponent(d.machineCode)}` : '';

  if (!d) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <OpStatusBadge status={d.effectiveStatus} />
        {canManage && <Button variant="secondary" onClick={() => setEditing((e) => !e)}>{editing ? 'Zatvori' : 'Uredi mašinu'}</Button>}
      </div>

      {editing ? (
        <EditMachineForm code={code} initial={d.name} update={update} onDone={() => setEditing(false)} />
      ) : (
        <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
          <Field label="Tip">{d.type ?? '—'}</Field>
          <Field label="Lokacija">{d.location ?? '—'}</Field>
          <Field label="Proizvođač / model">{[d.manufacturer, d.model].filter(Boolean).join(' / ') || '—'}</Field>
          <Field label="Serijski broj">{d.serialNumber ?? '—'}</Field>
          <Field label="Godina">{d.yearOfManufacture ?? '—'}</Field>
          <Field label="Odgovoran">{d.responsibleName ?? '—'}</Field>
        </div>
      )}

      {/* Override */}
      <div className="rounded-panel border border-line p-3">
        <h4 className="mb-2 text-sm font-semibold text-ink">Ručni status</h4>
        {d.statusOverride ? (
          <div className="flex items-center justify-between text-sm">
            <span>
              <OpStatusBadge status={d.statusOverride.status} /> <span className="ml-1 text-ink-secondary">{d.statusOverride.reason}</span>
              {d.statusOverride.validUntil && <span className="ml-1 text-2xs text-ink-secondary">do {formatDate(d.statusOverride.validUntil)}</span>}
            </span>
            {canOverride && <Button variant="ghost" onClick={() => clearOverride.mutate({ code })}>Ukloni</Button>}
          </div>
        ) : canOverride ? (
          <div className="flex flex-wrap items-end gap-2">
            <select value={ovStatus} onChange={(e) => setOvStatus(e.target.value as OpStatus)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {OP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Input value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="Razlog" className="flex-1" />
            <Button variant="secondary" disabled={!ovReason.trim() || setOverride.isPending} onClick={() => { setOverride.mutate({ code, status: ovStatus, reason: ovReason }, { onSuccess: () => setOvReason('') }); }}>Postavi</Button>
          </div>
        ) : (
          <p className="text-sm text-ink-secondary">Nema aktivnog ručnog statusa.</p>
        )}
      </div>

      {qr && (
        <a href={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(qr)}`} target="_blank" rel="noreferrer" className="text-xs text-accent">
          QR kartica sredstva (link)
        </a>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2 rounded-panel border border-line p-3">
          <Button variant="secondary" onClick={() => { const nc = prompt('Nova šifra mašine?', d.machineCode); if (nc && nc !== d.machineCode) rename.mutate({ code, newCode: nc.trim() }, { onSuccess: onClose }); }}>Preimenuj šifru</Button>
          {d.archivedAt ? (
            <Button variant="secondary" onClick={() => restore.mutate({ code })}>Vrati iz arhive</Button>
          ) : (
            <Button variant="secondary" onClick={() => archive.mutate({ code })}>Arhiviraj</Button>
          )}
          <Button variant="danger" className="ml-auto" onClick={() => { const reason = prompt('Razlog trajnog brisanja (min 5 znakova)?'); if (reason && reason.trim().length >= 5) hardDelete.mutate({ code, reason: reason.trim() }, { onSuccess: onClose }); }}>Trajno obriši</Button>
        </div>
      )}
    </div>
  );
}

function EditMachineForm({ code, initial, update, onDone }: { code: string; initial: string; update: ReturnType<typeof useUpdateMachine>; onDone: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <div className="space-y-2 rounded-panel border border-line p-3">
      <FormField label="Naziv"><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Otkaži</Button>
        <Button loading={update.isPending} onClick={() => update.mutate({ code, patch: { name } }, { onSuccess: onDone })}>Sačuvaj</Button>
      </div>
    </div>
  );
}

// ── Zadaci (potvrda kontrole) ──────────────────────────────────────
function ZadaciSub({ code, me }: { code: string; me: MaintMe | undefined }) {
  const tasks = useMachineTasks(code);
  const createCheck = useCreateCheck();
  const [active, setActive] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const rows = tasks.data?.data ?? [];

  return (
    <div className="space-y-2">
      {tasks.isLoading ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema definisanih zadataka.</p>
      ) : (
        rows.map((t) => (
          <div key={t.id} className="rounded-control border border-line p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-ink">{t.title}</span>
              <span className="text-2xs text-ink-secondary">{t.intervalValue} {t.intervalUnit}</span>
            </div>
            {t.description && <p className="text-xs text-ink-secondary">{t.description}</p>}
            {active === t.id ? (
              <div className="mt-2 space-y-2">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Napomena (opciono)" />
                <div className="flex flex-wrap gap-1.5">
                  {CHECK_RESULTS.map((r) => (
                    <Button key={r.key} variant="secondary" disabled={createCheck.isPending} onClick={() => createCheck.mutate({ taskId: t.id, machineCode: code, result: r.key, notes: notes || undefined }, { onSuccess: () => { setActive(null); setNotes(''); } })}>
                      {r.label}
                    </Button>
                  ))}
                  <Button variant="ghost" onClick={() => setActive(null)}>Otkaži</Button>
                </div>
              </div>
            ) : (
              <button className="mt-1 text-xs text-accent" onClick={() => { setActive(t.id); setNotes(''); }}>Potvrdi kontrolu</button>
            )}
          </div>
        ))
      )}
      {me && !me.gates.canCreateWo && <p className="text-2xs text-ink-disabled">Kontrole potvrđuju operateri/tehničari zaduženi za mašinu.</p>}
    </div>
  );
}

// ── Istorija (incidenti + kontrole) ────────────────────────────────
function IstorijaSub({ code }: { code: string }) {
  const inc = useIncidents({ machineCode: code, pageSize: 50 });
  const checks = useMachineChecks(code);
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-ink">Kvarovi</h4>
        {(inc.data?.data ?? []).length === 0 ? <p className="text-sm text-ink-secondary">—</p> : (inc.data?.data ?? []).map((i) => (
          <div key={i.id} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
            <span className="text-ink">{i.title}</span>
            <span className="text-2xs text-ink-secondary">{formatDateTime(i.reportedAt)}</span>
          </div>
        ))}
      </div>
      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-ink">Kontrole</h4>
        {(checks.data?.data ?? []).length === 0 ? <p className="text-sm text-ink-secondary">—</p> : (checks.data?.data ?? []).map((c) => (
          <div key={c.id} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
            <span className="text-ink">{c.result}{c.notes ? ` · ${c.notes}` : ''}</span>
            <span className="text-2xs text-ink-secondary">{formatDateTime(c.performedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Napomene ───────────────────────────────────────────────────────
function NapomeneSub({ code }: { code: string }) {
  const notes = useMachineNotes(code);
  const create = useCreateNote();
  const update = useUpdateNote();
  const [text, setText] = useState('');
  const rows = notes.data?.data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Nova napomena…" className="flex-1" />
        <Button variant="secondary" disabled={!text.trim() || create.isPending} onClick={() => create.mutate({ code, content: text }, { onSuccess: () => setText('') })}>Dodaj</Button>
      </div>
      {rows.map((n) => (
        <div key={n.id} className="rounded-control border border-line p-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="whitespace-pre-wrap text-ink">{n.content}</span>
            <div className="flex shrink-0 items-center gap-1">
              <button title={n.pinned ? 'Otkači' : 'Zakači'} onClick={() => update.mutate({ code, noteId: n.id, patch: { pinned: !n.pinned } })} className={n.pinned ? 'text-accent' : 'text-ink-disabled'}>
                <Pin className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button title="Obriši" onClick={() => update.mutate({ code, noteId: n.id, patch: { deleted: true } })} className="text-ink-disabled hover:text-status-danger">
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
          <span className="text-2xs text-ink-secondary">{formatDateTime(n.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Dokumenta (fajlovi mašine) ─────────────────────────────────────
function DokumentaSub({ code, canManage }: { code: string; canManage: boolean }) {
  const files = useMachineFiles(code);
  const upload = useUploadMachineFile();
  const del = useDeleteMachineFile();
  const rows = files.data?.data ?? [];

  async function open(id: string) {
    try {
      const res = await signMachineFileUrl(code, id);
      window.open(res.data.url, '_blank');
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-2">
      {canManage && (
        <label className="flex cursor-pointer items-center gap-2 rounded-control border border-dashed border-line px-3 py-2 text-sm text-ink-secondary hover:bg-surface-2">
          <Upload className="h-4 w-4" aria-hidden /> {upload.isPending ? 'Otpremanje…' : 'Otpremi dokument'}
          <input type="file" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload.mutate({ code, file }); }} />
        </label>
      )}
      {rows.length === 0 ? <p className="py-2 text-center text-sm text-ink-secondary">Nema dokumenata.</p> : rows.map((doc) => (
        <div key={doc.id} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
          <button onClick={() => open(doc.id)} className="flex items-center gap-2 text-left text-accent"><Download className="h-3.5 w-3.5" aria-hidden />{doc.fileName}</button>
          {canManage && <button onClick={() => del.mutate({ code, id: doc.id })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
        </div>
      ))}
    </div>
  );
}

// ── Šabloni kontrola (chief/admin) ─────────────────────────────────
const INTERVAL_UNITS: IntervalUnit[] = ['hours', 'days', 'weeks', 'months'];
function SabloniSub({ code }: { code: string }) {
  const tasks = useMachineTasks(code);
  const create = useCreateTask();
  const del = useDeleteTask();
  const [title, setTitle] = useState('');
  const [val, setVal] = useState('30');
  const [unit, setUnit] = useState<IntervalUnit>('days');
  const rows = tasks.data?.data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
        <FormField label="Naziv"><Input value={title} onChange={(e) => setTitle(e.target.value)} className="w-48" /></FormField>
        <FormField label="Interval"><Input value={val} onChange={(e) => setVal(e.target.value)} className="w-20" inputMode="numeric" /></FormField>
        <select value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {INTERVAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <Button variant="secondary" disabled={!title.trim() || create.isPending} onClick={() => create.mutate({ machineCode: code, title, intervalValue: Number(val) || 1, intervalUnit: unit }, { onSuccess: () => setTitle('') })}>
          <Plus className="h-4 w-4" aria-hidden /> Dodaj
        </Button>
      </div>
      {rows.map((t) => (
        <div key={t.id} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
          <span className="text-ink">{t.title} <span className="text-ink-secondary">· {t.intervalValue} {t.intervalUnit}</span></span>
          <div className="flex items-center gap-2">
            {!t.active && <StatusBadge tone="neutral" label="Neaktivan" />}
            <button onClick={() => del.mutate({ id: t.id })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
