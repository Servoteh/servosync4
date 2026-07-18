'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Dialog } from '@/components/ui-kit/dialog';
import { toast } from '@/lib/toast';
import {
  useCreateNotificationRule,
  useCreateProfile,
  useNotificationRules,
  useProfiles,
  useSettings,
  useUpdateNotificationRule,
  useUpdateProfile,
  useUpdateSettings,
  type MaintMe,
  type MaintProfile,
  type MaintSettings,
  type NotifChannel,
  type NotificationRule,
  type WoPriority,
} from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, SEVERITY_LABEL, WO_PRIORITY_LABEL, WO_STATUS_LABEL } from './common';

const CHANNEL_LABEL: Record<NotifChannel, string> = {
  in_app: 'Aplikacija',
  email: 'Email',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};
const CHANNELS: NotifChannel[] = ['in_app', 'email', 'telegram', 'whatsapp'];
const WO_PRIORITIES: WoPriority[] = ['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'];
/** Uloge za DODELU maint profila — BEZ 'management' (namerno legacy; §5.1 skriveno pravilo). */
const PROFILE_ROLES = ['operator', 'technician', 'chief', 'admin'] as const;
/** Ciljne uloge notif pravila (uklj. management za eskalaciju). */
const TARGET_ROLES = ['operator', 'technician', 'chief', 'management', 'admin'] as const;
const SEVERITIES = ['minor', 'major', 'critical'] as const;
const ASSET_TYPES = ['machine', 'vehicle', 'it', 'facility'] as const;
const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Podešavanja (maint_settings singleton) + notif pravila + Profili (H19). admin_ui prikaz. */
export function PodesavanjaTab({ me }: { me: MaintMe | undefined }) {
  return (
    <div className="space-y-8">
      <OpstaPodesavanja />
      <NotifPravila />
      {me?.erpAdmin && <ProfiliSekcija />}
    </div>
  );
}

// ── Opšta podešavanja (bool + num + prioritet + kanali + napomena) ──────────
function OpstaPodesavanja() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<Partial<MaintSettings>>({});
  const s = settings.data?.data;
  useEffect(() => { if (s) setDraft(s); }, [s]);

  const bools: [keyof MaintSettings, string][] = [
    ['autoCreateWoMajor', 'Auto-nalog za ozbiljne kvarove'],
    ['autoCreateWoCritical', 'Auto-nalog za kritične kvarove'],
    ['safetyMarkerRequiresWo', 'Bezbednosni rizik zahteva nalog'],
    ['notificationEnabled', 'Notifikacije uključene'],
    ['notifyOnMajorIncident', 'Obavesti na ozbiljan kvar'],
    ['notifyOnCriticalIncident', 'Obavesti na kritičan kvar'],
    ['notifyOnOverduePreventive', 'Obavesti na zakasnelu preventivu'],
  ];
  const nums: [keyof MaintSettings, string][] = [
    ['majorWoDueHours', 'Rok naloga za ozbiljne (h)'],
    ['criticalWoDueHours', 'Rok naloga za kritične (h)'],
    ['preventiveDueWarningDays', 'Upozorenje na preventivu (dana)'],
  ];
  const channels = (draft.notificationChannels ?? []) as NotifChannel[];
  function toggleChannel(ch: NotifChannel) {
    setDraft((d) => {
      const cur = (d.notificationChannels ?? []) as NotifChannel[];
      return { ...d, notificationChannels: cur.includes(ch) ? cur.filter((c) => c !== ch) : [...cur, ch] };
    });
  }
  function save() {
    update.mutate({
      patch: {
        autoCreateWoMajor: draft.autoCreateWoMajor,
        autoCreateWoCritical: draft.autoCreateWoCritical,
        safetyMarkerRequiresWo: draft.safetyMarkerRequiresWo,
        defaultWoPriority: draft.defaultWoPriority,
        notificationEnabled: draft.notificationEnabled,
        notifyOnMajorIncident: draft.notifyOnMajorIncident,
        notifyOnCriticalIncident: draft.notifyOnCriticalIncident,
        notifyOnOverduePreventive: draft.notifyOnOverduePreventive,
        notificationChannels: draft.notificationChannels,
        majorWoDueHours: draft.majorWoDueHours,
        criticalWoDueHours: draft.criticalWoDueHours,
        preventiveDueWarningDays: draft.preventiveDueWarningDays,
        notes: draft.notes,
      },
    }, { onSuccess: () => toast('Podešavanja sačuvana'), onError: (e) => toast((e as Error).message) });
  }

  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <h2 className="mb-3 text-md font-semibold text-ink">Opšta podešavanja</h2>
      {settings.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : !s ? (
        <p className="text-sm text-ink-secondary">Podešavanja nisu dostupna.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {bools.map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={Boolean(draft[key])} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Podrazumevani prioritet WO">
              <select value={draft.defaultWoPriority ?? 'p3_manje'} onChange={(e) => setDraft((d) => ({ ...d, defaultWoPriority: e.target.value as WoPriority }))} className={selCls}>
                {WO_PRIORITIES.map((p) => <option key={p} value={p}>{WO_PRIORITY_LABEL[p]}</option>)}
              </select>
            </FormField>
            {nums.map(([key, label]) => (
              <FormField key={key} label={label}>
                <Input value={String(draft[key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))} inputMode="numeric" />
              </FormField>
            ))}
          </div>

          <FormField label="Kanali obaveštenja">
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((ch) => (
                <label key={ch} className="flex cursor-pointer items-center gap-1.5 text-sm text-ink">
                  <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggleChannel(ch)} /> {CHANNEL_LABEL[ch]}
                </label>
              ))}
            </div>
          </FormField>

          <FormField label="Napomena">
            <Textarea value={draft.notes ?? ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} rows={2} placeholder="Interna napomena za CMMS podešavanja…" />
          </FormField>

          <div className="flex justify-end">
            <Button loading={update.isPending} onClick={save}>Sačuvaj podešavanja</Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Notifikaciona pravila (puna tabela + „Dodaj pravilo" + status-šablon) ────
function NotifPravila() {
  const rules = useNotificationRules();
  const updateRule = useUpdateNotificationRule();
  const [adding, setAdding] = useState(false);
  const rows = rules.data?.data ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-md font-semibold text-ink">Notifikaciona pravila</h2>
        <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden /> Dodaj pravilo</Button>
      </div>
      {rules.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema definisanih pravila.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Događaj</th><th className="p-2">Filter</th><th className="p-2">Uloga</th><th className="p-2">Kanal</th><th className="p-2">Kašnjenje</th><th className="p-2">Napomena</th><th className="p-2">Status</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ruleId} className="border-b border-line-soft">
                  <td className="p-2 font-medium text-ink">{r.eventType}</td>
                  <td className="p-2 text-ink-secondary">{[r.severity ? (SEVERITY_LABEL[r.severity as never] ?? r.severity) : null, r.assetType ? (ASSET_TYPE_LABEL[r.assetType] ?? r.assetType) : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="p-2 text-ink-secondary">{r.targetRole ?? '—'}</td>
                  <td className="p-2 text-ink-secondary">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="p-2 tnums text-ink-secondary">{r.delayMinutes} min{r.escalationLevel ? ` · L${r.escalationLevel}` : ''}</td>
                  <td className="p-2 text-ink-secondary">{r.notes ?? '—'}</td>
                  <td className="p-2"><StatusBadge tone={r.enabled ? 'success' : 'neutral'} label={r.enabled ? 'Aktivno' : 'Isključeno'} /></td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" disabled={updateRule.isPending} onClick={() => updateRule.mutate({ id: r.ruleId, patch: { enabled: !r.enabled } })}>{r.enabled ? 'Isključi' : 'Uključi'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Status-šablon referenca (paritet 1.0: centralna lista, prikaz-samo) */}
      <details className="mt-3 rounded-panel border border-line bg-surface p-3 text-sm">
        <summary className="cursor-pointer text-ink-secondary">Šabloni statusa radnih naloga (referenca)</summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(WO_STATUS_LABEL).map(([k, v]) => (
            <span key={k} className="rounded-control border border-line px-2 py-0.5 text-2xs text-ink-secondary">{v} <code className="text-ink-disabled">{k}</code></span>
          ))}
        </div>
        <p className="mt-2 text-2xs text-ink-secondary">Labele su centralna referenca (maint_settings.wo_status_labels); menjaju se u narednom koraku.</p>
      </details>

      {adding && <RuleForm onClose={() => setAdding(false)} />}
    </section>
  );
}

function RuleForm({ onClose }: { onClose: () => void }) {
  const create = useCreateNotificationRule();
  const [eventType, setEventType] = useState('');
  const [severity, setSeverity] = useState('');
  const [assetType, setAssetType] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [channel, setChannel] = useState<NotifChannel>('in_app');
  const [delayMinutes, setDelay] = useState('0');
  const [escalationLevel, setEsc] = useState('0');
  const [notes, setNotes] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!eventType.trim()) return setErr('Događaj (event_type) je obavezan.');
    create.mutate({
      eventType: eventType.trim(),
      severity: severity || undefined,
      assetType: assetType || undefined,
      targetRole: targetRole || undefined,
      channel,
      delayMinutes: Number(delayMinutes) || 0,
      escalationLevel: Number(escalationLevel) || 0,
      notes: notes.trim() || undefined,
      enabled,
    }, { onSuccess: () => { toast('Pravilo dodato'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title="Novo notifikaciono pravilo"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={create.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Događaj (event_type)" required><Input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="npr. incident_created, preventive_overdue" /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ozbiljnost">
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={selCls}><option value="">— bilo koja —</option>{SEVERITIES.map((sv) => <option key={sv} value={sv}>{SEVERITY_LABEL[sv]}</option>)}</select>
          </FormField>
          <FormField label="Tip sredstva">
            <select value={assetType} onChange={(e) => setAssetType(e.target.value)} className={selCls}><option value="">— bilo koji —</option>{ASSET_TYPES.map((a) => <option key={a} value={a}>{ASSET_TYPE_LABEL[a]}</option>)}</select>
          </FormField>
          <FormField label="Ciljna uloga">
            <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)} className={selCls}><option value="">— nije bitno —</option>{TARGET_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          </FormField>
          <FormField label="Kanal">
            <select value={channel} onChange={(e) => setChannel(e.target.value as NotifChannel)} className={selCls}>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select>
          </FormField>
          <FormField label="Kašnjenje (min)"><Input value={delayMinutes} onChange={(e) => setDelay(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Nivo eskalacije"><Input value={escalationLevel} onChange={(e) => setEsc(e.target.value)} inputMode="numeric" /></FormField>
        </div>
        <FormField label="Napomena"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aktivno</label>
      </div>
    </Dialog>
  );
}

// ── Profili održavanja (H19; SoD — SAMO ERP admin) ──────────────────────────
function ProfiliSekcija() {
  const profiles = useProfiles(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MaintProfile | null>(null);
  const rows = profiles.data?.data ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold text-ink">Profili održavanja</h2>
          <p className="text-2xs text-ink-secondary">Dodela CMMS uloge, mašina i kontakata. Menja isključivo ERP administrator.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Dodaj profil</Button>
      </div>
      {profiles.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : profiles.isError ? (
        <p className="text-sm text-ink-secondary">Profili trenutno nisu dostupni.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema definisanih profila.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Ime</th><th className="p-2">Uloga</th><th className="p-2">Mašine</th><th className="p-2">Telefon</th><th className="p-2">Telegram</th><th className="p-2">Aktivan</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.userId} className="border-b border-line-soft">
                  <td className="p-2 font-medium text-ink">{p.fullName}</td>
                  <td className="p-2 text-ink-secondary">{p.role}</td>
                  <td className="p-2 text-ink-secondary">{p.assignedMachineCodes.length ? p.assignedMachineCodes.join(', ') : '—'}</td>
                  <td className="p-2 tnums text-ink-secondary">{p.phone ?? '—'}</td>
                  <td className="p-2 tnums text-ink-secondary">{p.telegramChatId ?? '—'}</td>
                  <td className="p-2">{p.active ? <StatusBadge tone="success" label="Da" /> : <StatusBadge tone="neutral" label="Ne" />}</td>
                  <td className="p-2 text-right"><Button variant="ghost" onClick={() => setEditing(p)}>Izmeni</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <ProfileForm onClose={() => setCreating(false)} />}
      {editing && <ProfileForm existing={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ProfileForm({ existing, onClose }: { existing?: MaintProfile; onClose: () => void }) {
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const [userId, setUserId] = useState(existing?.userId ?? '');
  const [fullName, setFullName] = useState(existing?.fullName ?? '');
  const [role, setRole] = useState<string>(existing?.role ?? 'operator');
  const [machines, setMachines] = useState((existing?.assignedMachineCodes ?? []).join(', '));
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [telegram, setTelegram] = useState(existing?.telegramChatId ?? '');
  const [active, setActive] = useState(existing?.active ?? true);
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!fullName.trim()) return setErr('Ime i prezime su obavezni.');
    const codes = machines.split(',').map((c) => c.trim()).filter(Boolean);
    const common = {
      fullName: fullName.trim(),
      role,
      assignedMachineCodes: codes,
      phone: phone.trim() || undefined,
      telegramChatId: telegram.trim() || undefined,
      active,
    };
    const onDone = { onSuccess: () => { toast(existing ? 'Profil ažuriran' : 'Profil dodat'); onClose(); }, onError: (e: unknown) => setErr((e as Error).message) };
    if (existing) {
      update.mutate({ id: existing.userId, patch: common }, onDone);
    } else {
      if (!UUID_RE.test(userId.trim())) return setErr('Korisnički UUID nije validan (mora biti auth.users.id).');
      create.mutate({ userId: userId.trim(), ...common }, onDone);
    }
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog open onClose={onClose} title={existing ? 'Izmeni profil održavanja' : 'Novi profil održavanja'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={pending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        {existing ? (
          <p className="text-2xs text-ink-secondary">Korisnik: <code className="tnums">{existing.userId}</code></p>
        ) : (
          <FormField label="Korisnički UUID (auth.users.id)" required hint="Uzmi iz Podešavanja → Korisnici; NIJE ID zaposlenog.">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
          </FormField>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ime i prezime" required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></FormField>
          <FormField label="Uloga" required>
            <select value={role} onChange={(e) => setRole(e.target.value)} className={selCls}>
              {PROFILE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </FormField>
          <FormField label="Telefon" hint="E.164, npr. +38160…"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></FormField>
          <FormField label="Telegram chat ID"><Input value={telegram} onChange={(e) => setTelegram(e.target.value)} /></FormField>
        </div>
        <FormField label="Dodeljene mašine (šifre, zarezom)" hint="npr. 8.3, 10.1">
          <Input value={machines} onChange={(e) => setMachines(e.target.value)} />
        </FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktivan</label>
      </div>
    </Dialog>
  );
}
