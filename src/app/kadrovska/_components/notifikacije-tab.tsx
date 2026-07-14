'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { SearchBox } from '@/components/ui-kit/search-box';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useNotifications,
  useNotificationConfig,
  useNotifRetry,
  useNotifCancel,
  useNotifDelete,
  useTriggerHrReminders,
  useTriggerPayrollNotify,
  useUpdateNotificationConfig,
  newClientEventId,
  type NotificationConfig,
} from '@/api/kadrovska';
import { SummaryChips, sv, svNum } from './common';
import { Select, WideModal } from './razvoj/shared';

type Row = Record<string, unknown>;

const TYPE_LABELS: Record<string, string> = {
  medical_expiring: 'Lekarski ističe',
  contract_expiring: 'Ugovor ističe',
  birthday: 'Rođendan',
  birthday_oversight: 'Rođendan → nadređeni',
  birthday_digest: 'Rođendani (mesečni pregled)',
  child_birthday: 'Rođendan deteta',
  work_anniversary: 'Godišnjica rada',
  weekly_risk_summary: 'Risk pregled (nedeljni)',
  vacation_submitted: 'GO — podnet',
  vacation_approved: 'GO — odobren',
  vacation_rejected: 'GO — odbijen',
  nop_requested: 'Neplaćeno — predlog',
  nop_decided: 'Neplaćeno — odluka',
  payroll_statement: 'Obračun sati',
  account_invite: 'Novi nalog',
  personal_doc_expiring: 'Lični dokument ističe',
  foreign_doc_expiring: 'Strani dokument ističe',
  bank_card_expiring: 'Kartica ističe',
};
const STATUS_TONE: Record<string, { tone: Tone; label: string }> = {
  queued: { tone: 'warn', label: '⏳ U redu' },
  sent: { tone: 'success', label: '✅ Poslato' },
  failed: { tone: 'danger', label: '❌ Neuspelo' },
  canceled: { tone: 'neutral', label: '🚫 Otkazano' },
};
const CHANNEL_ICON: Record<string, string> = { whatsapp: '💬', email: '✉', sms: '📱' };
const MONTHS = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun', 'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];

export function NotifikacijeTab() {
  const [filter, setFilter] = useState('queued');
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const [payroll, setPayroll] = useState(false);

  const listQ = useNotifications(filter === 'all' ? {} : { status: filter }, true);
  const rows = listQ.data?.data ?? [];
  const scan = useTriggerHrReminders();
  const retry = useNotifRetry();
  const cancel = useNotifCancel();
  const del = useNotifDelete();

  const counts = useMemo(() => {
    const c = { queued: 0, sent: 0, failed: 0, canceled: 0 } as Record<string, number>;
    for (const r of rows) if (c[sv(r, 'status')] != null) c[sv(r, 'status')]++;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [sv(r, 'recipient'), sv(r, 'subject'), sv(r, 'body'), TYPE_LABELS[sv(r, 'notification_type')] || sv(r, 'notification_type')].join(' ').toLowerCase().includes(q));
  }, [rows, search]);

  function runScan() {
    scan.mutate(undefined, {
      onSuccess: (res) => {
        const d = (res.data ?? {}) as Record<string, unknown>;
        if (d.config_missing || d.configMissing) toast('ℹ Konfiguracija nedostaje — otvori ⚙️ Podešavanja');
        else toast(`🔔 Zakazano ${d.scheduled_count ?? d.scheduledCount ?? 0} novih upozorenja`);
      },
      onError: () => toast('⚠ Skeniranje nije uspelo'),
    });
  }

  const cols: Column<Row>[] = [
    { key: 'when', header: 'Zakazano', render: (r) => (sv(r, 'scheduled_at') ? formatDateTime(sv(r, 'scheduled_at')) : '—') },
    { key: 'type', header: 'Tip', render: (r) => <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs font-medium text-ink">{TYPE_LABELS[sv(r, 'notification_type')] || sv(r, 'notification_type')}</span> },
    { key: 'ch', header: 'Kanal', render: (r) => `${CHANNEL_ICON[sv(r, 'channel')] || '•'} ${sv(r, 'channel')}` },
    { key: 'rcpt', header: 'Primalac', render: (r) => sv(r, 'recipient') },
    {
      key: 'msg',
      header: 'Poruka',
      render: (r) => (
        <div className="max-w-72">
          <div className="truncate">{(sv(r, 'subject') || sv(r, 'body')).slice(0, 80)}</div>
          {sv(r, 'status') === 'failed' && sv(r, 'error') && <div className="truncate text-2xs text-status-danger" title={sv(r, 'error')}>❗ {sv(r, 'error').slice(0, 60)}</div>}
        </div>
      ),
    },
    { key: 'att', header: 'Pokušaji', align: 'right', render: (r) => svNum(r, 'attempts') },
    { key: 'status', header: 'Status', render: (r) => { const s = STATUS_TONE[sv(r, 'status')] ?? { tone: 'neutral' as Tone, label: sv(r, 'status') }; return <StatusBadge tone={s.tone} label={s.label} />; } },
    {
      key: 'act',
      header: '',
      render: (r) => {
        const st = sv(r, 'status');
        const id = sv(r, 'id');
        return (
          <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            {st === 'failed' && <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => retry.mutate({ id }, { onSuccess: () => toast('♻ Vraćeno u queue'), onError: () => toast('⚠ Neuspeh') })}>♻ Retry</Button>}
            {(st === 'queued' || st === 'failed') && <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => { if (confirm('Otkazati ovo upozorenje?')) cancel.mutate({ id }, { onSuccess: () => toast('🚫 Otkazano'), onError: () => toast('⚠ Neuspeh') }); }}>Otkaži</Button>}
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => { if (confirm('Obrisati zapis? Akcija je trajna.')) del.mutate({ id }, { onSuccess: () => toast('🗑 Obrisano'), onError: () => toast('⚠ Neuspeh') }); }}>Obriši</Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <SummaryChips
        items={[
          { label: '⏳ U redu', value: counts.queued },
          { label: '✅ Poslate', value: counts.sent },
          { label: '❌ Neuspele', value: counts.failed, tone: counts.failed ? 'danger' : undefined },
          { label: '🚫 Otkazane', value: counts.canceled },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onChange={setFilter} className="h-8 w-auto">
          <option value="queued">⏳ U redu</option>
          <option value="sent">✅ Poslate</option>
          <option value="failed">❌ Neuspele</option>
          <option value="canceled">🚫 Otkazane</option>
          <option value="all">Sve</option>
        </Select>
        <SearchBox value={search} onChange={setSearch} placeholder="Pretraga po primaocu / naslovu…" />
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setPayroll(true)}>📧 Obračun sati</Button>
        <Button variant="secondary" onClick={() => setSettings(true)}>⚙️ Podešavanja</Button>
        <Button loading={scan.isPending} onClick={runScan}>🔔 Skeniraj sada</Button>
      </div>

      <DataTable
        columns={cols}
        rows={shown}
        rowKey={(r) => sv(r, 'id') || Math.random().toString()}
        loading={listQ.isLoading}
        empty={<EmptyState title="Nema zapisa" hint={'Klikni „🔔 Skeniraj sada" da generišeš predstojeća upozorenja.'} />}
      />

      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {payroll && <PayrollModal onClose={() => setPayroll(false)} />}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const cfgQ = useNotificationConfig(true);
  const save = useUpdateNotificationConfig();
  const cfg = cfgQ.data?.data;
  const [form, setForm] = useState<Partial<NotificationConfig>>({});
  const [err, setErr] = useState('');
  const [waText, setWaText] = useState<string | null>(null);
  const [emailText, setEmailText] = useState<string | null>(null);
  const waValue = waText ?? (cfg?.whatsappRecipients ?? []).join('\n');
  const emailValue = emailText ?? (cfg?.emailRecipients ?? []).join('\n');
  // Vrednost polja: lokalna izmena → server → default.
  const val = <K extends keyof NotificationConfig>(k: K, d: NotificationConfig[K]): NotificationConfig[K] =>
    (form[k] ?? cfg?.[k] ?? d) as NotificationConfig[K];
  const set = <K extends keyof NotificationConfig>(k: K, v: NotificationConfig[K]) => setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    setErr('');
    const med = Number(val('medicalLeadDays', 30));
    const con = Number(val('contractLeadDays', 30));
    if (med < 1 || con < 1) return setErr('Pragovi dana moraju biti ≥ 1.');
    const payload: Partial<NotificationConfig> = {
      enabled: val('enabled', true),
      medicalLeadDays: med,
      contractLeadDays: con,
      birthdayEnabled: val('birthdayEnabled', false),
      birthdayOversightEnabled: val('birthdayOversightEnabled', true),
      birthdayDigestEnabled: val('birthdayDigestEnabled', true),
      childBirthdayEnabled: val('childBirthdayEnabled', false),
      workAnniversaryEnabled: val('workAnniversaryEnabled', false),
      whatsappRecipients: splitLines(waValue).filter((s) => /^\+?\d{6,20}$/.test(s.replace(/\s+/g, ''))),
      emailRecipients: splitLines(emailValue).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    };
    save.mutate(payload, { onSuccess: () => { toast('💾 Podešavanja sačuvana'); onClose(); }, onError: () => setErr('Čuvanje nije uspelo (prava?).') });
  }

  const Toggle = ({ k, label, dflt }: { k: keyof NotificationConfig; label: string; dflt: boolean }) => (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input type="checkbox" checked={Boolean(val(k, dflt as never))} onChange={(e) => set(k, e.target.checked as never)} />
      {label}
    </label>
  );

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="640px"
      title="⚙️ Podešavanja notifikacija"
      footer={<><Button variant="secondary" onClick={onClose}>Otkaži</Button><Button loading={save.isPending} onClick={submit}>Sačuvaj</Button></>}
    >
      <p className="mb-3 text-sm text-ink-secondary">HR upozorenja se skeniraju jednom dnevno (07:00). Ovde biraš pragove i primaoce.</p>
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      {cfgQ.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : (
        <div className="space-y-3">
          <Toggle k="enabled" label="Notifikacije uključene (master switch)" dflt />
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Lekarski — dana pre?"><Input type="number" min={1} max={180} value={String(val('medicalLeadDays', 30) ?? 30)} onChange={(e) => set('medicalLeadDays', Number(e.target.value))} /></FormField>
            <FormField label="Ugovor — dana pre?"><Input type="number" min={1} max={365} value={String(val('contractLeadDays', 30) ?? 30)} onChange={(e) => set('contractLeadDays', Number(e.target.value))} /></FormField>
          </div>
          <Toggle k="birthdayEnabled" label="🎂 Rođendani zaposlenih (globalni primaoci)" dflt={false} />
          <Toggle k="birthdayOversightEnabled" label="🎂 Rođendan → mejl nadređenom na sam dan" dflt />
          <Toggle k="birthdayDigestEnabled" label="🎂 Mesečni pregled rođendana (1. u mesecu) → lideri + administracija" dflt />
          <Toggle k="childBirthdayEnabled" label="🎂 Rođendani dece zaposlenih" dflt={false} />
          <Toggle k="workAnniversaryEnabled" label="Poruke za godišnjice rada" dflt={false} />
          <FormField label="WhatsApp primaoci (E.164, npr. 381601234567 — jedan po redu)">
            <Textarea rows={3} value={waValue} placeholder="381601234567" onChange={(e) => setWaText(e.target.value)} />
          </FormField>
          <FormField label="Email primaoci (jedan po redu)">
            <Textarea rows={3} value={emailValue} placeholder="hr@firma.rs" onChange={(e) => setEmailText(e.target.value)} />
          </FormField>
          <p className="text-2xs text-ink-secondary">💡 Za WhatsApp slanje potrebni su WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID / WA_TEMPLATE_NAME secrets na dispatch funkciji; bez njih poruke idu u DRY-RUN log.</p>
        </div>
      )}
    </WideModal>
  );
}

function splitLines(s: string): string[] {
  return String(s || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

function PayrollModal({ onClose }: { onClose: () => void }) {
  const trigger = useTriggerPayrollNotify();
  const now = new Date();
  let dy = now.getFullYear();
  let dm = now.getMonth(); // prethodni mesec (0-based tekući = prethodni 1-based)
  if (dm === 0) { dm = 12; dy -= 1; }
  const [month, setMonth] = useState(String(dm));
  const [year, setYear] = useState(String(dy));

  function submit() {
    trigger.mutate(
      { year: Number(year), month: Number(month), clientEventId: newClientEventId() },
      { onSuccess: (res) => { toast(`📧 Obračun sati: ${Number(res.data) || 0} obaveštenja u redu za ${MONTHS[Number(month) - 1]} ${year}`); onClose(); }, onError: () => toast('⚠ Slanje nije uspelo (prava?).') },
    );
  }

  return (
    <WideModal open onClose={onClose} maxWidth="480px" title="📧 Pošalji obračun sati" footer={<><Button variant="secondary" onClick={onClose}>Otkaži</Button><Button loading={trigger.isPending} onClick={submit}>Pošalji</Button></>}>
      <p className="mb-3 text-sm text-ink-secondary">Svakom zaposlenom sa upisanim satima za izabrani mesec šalje se pregled na email/WhatsApp.</p>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Mesec">
          <Select value={month} onChange={setMonth}>
            {MONTHS.map((n, i) => (<option key={i} value={i + 1}>{n}</option>))}
          </Select>
        </FormField>
        <FormField label="Godina">
          <Select value={year} onChange={setYear}>
            {[now.getFullYear(), now.getFullYear() - 1].map((y) => (<option key={y} value={y}>{y}</option>))}
          </Select>
        </FormField>
      </div>
      <p className="mt-3 text-2xs text-ink-secondary">💡 Redovi se upisuju u red i dispatch cron ih šalje. Bez verifikovanog Resend domena mejlovi idu u DRY-RUN log.</p>
    </WideModal>
  );
}
