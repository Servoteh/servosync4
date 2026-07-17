'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  signDocumentUrl,
  useArchiveDriver,
  useAssignableUsers,
  useCreateDriver,
  useDeleteDriver,
  useDriver,
  useDrivers,
  useEmployeeLookup,
  useRestoreDriver,
  useUpdateDriver,
  useVehicles,
  type DriverRow,
  type MaintMe,
  type VehicleOverviewRow,
} from '@/api/odrzavanje';
import {
  deadlineTone,
  f,
  Field,
  LICENSE_CATEGORIES,
  normNameTokens,
  StatCard,
  tableEmpty,
  tokensEqual,
} from './common';

const DRV_STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'Važi' },
  due_soon: { tone: 'warn', label: 'Uskoro' },
  expired: { tone: 'danger', label: 'Istekla' },
};
function statusFrom(view: string | null, date: unknown): { tone: Tone; label: string } {
  if (view && DRV_STATUS[view]) return DRV_STATUS[view];
  if (!date) return { tone: 'neutral', label: '—' };
  return { tone: deadlineTone(String(date)), label: formatDate(String(date)) };
}

/**
 * Vozači — registar (paritet 1.0 maintDriversPanel.js): filteri q/tip/arhivirani + 5 KPI,
 * kolone Vozač/Vozačka/Rok/Lekarski/Vozila, pun modal (create+edit) sa auto-detect zaposlenog,
 * arhiviraj/vrati/trajno obriši, karton vozača (rokovi + tab Vozila + dokumenta).
 */
export function VozaciTab({ me }: { me: MaintMe | undefined }) {
  const drivers = useDrivers();
  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const [q, setQ] = useState('');
  const [tip, setTip] = useState<'all' | 'internal' | 'external'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null | 'new'>(null);

  const all = (drivers.data?.data ?? []) as DriverRow[];
  const kpi = useMemo(() => ({
    expired: all.filter((r) => f(r, 'license_status') === 'expired').length,
    dueSoon: all.filter((r) => f(r, 'license_status') === 'due_soon').length,
    medExpired: all.filter((r) => f(r, 'medical_status') === 'expired').length,
    internal: all.filter((r) => r.is_internal).length,
    external: all.filter((r) => r.is_internal === false).length,
  }), [all]);

  const rows = useMemo(() => {
    let out = all;
    if (!showArchived) out = out.filter((r) => !f(r, 'archived_at'));
    if (tip === 'internal') out = out.filter((r) => r.is_internal);
    else if (tip === 'external') out = out.filter((r) => r.is_internal === false);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      out = out.filter((r) => [r.full_name, f(r, 'drivers_license_number'), f(r, 'phone')].filter(Boolean).some((x) => String(x).toLowerCase().includes(t)));
    }
    return out;
  }, [all, showArchived, tip, q]);

  const cols: Column<DriverRow>[] = [
    {
      key: 'vozac', header: 'Vozač',
      render: (r) => (
        <div>
          <span className="font-medium text-ink">{r.full_name}</span>
          {f(r, 'archived_at') && <StatusBadge tone="neutral" label="Arhiviran" />}
          <div className="flex items-center gap-1.5 text-2xs text-ink-secondary">
            <StatusBadge tone={r.is_internal ? 'success' : 'info'} label={r.is_internal ? 'interni' : 'spoljni'} />
            {f(r, 'phone') && <span>· {f(r, 'phone')}</span>}
          </div>
        </div>
      ),
    },
    { key: 'lic', header: 'Vozačka', render: (r) => <div><span className="text-ink">{f(r, 'drivers_license_number') ?? '—'}</span><div className="text-2xs text-ink-secondary">{Array.isArray(r.drivers_license_categories) ? (r.drivers_license_categories as string[]).join(', ') : '—'}</div></div> },
    { key: 'licv', header: 'Vozačka do', render: (r) => { const s = statusFrom(f(r, 'license_status'), r.drivers_license_valid_until); return <div><div className="text-ink-secondary">{f(r, 'drivers_license_valid_until') ? formatDate(String(f(r, 'drivers_license_valid_until'))) : '—'}</div><StatusBadge tone={s.tone} label={s.label} /></div>; } },
    { key: 'med', header: 'Lekarski', render: (r) => { const s = statusFrom(f(r, 'medical_status'), r.medical_check_valid_until); return <div><div className="text-ink-secondary">{f(r, 'medical_check_valid_until') ? formatDate(String(f(r, 'medical_check_valid_until'))) : '—'}</div><StatusBadge tone={s.tone} label={s.label} /></div>; } },
    { key: 'vozila', header: 'Vozila', align: 'right', numeric: true, render: (r) => <span className="text-ink-secondary">{f(r, 'vehicle_count') ?? '0'}</span> },
    {
      key: 'akcije', header: '', align: 'right',
      render: (r) => canManage ? <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setEditId(r.driver_id); }}>Izmeni</Button> : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Vozačka istekla" value={kpi.expired} tone={kpi.expired ? 'danger' : 'neutral'} />
        <StatCard label="Vozačka ≤30d" value={kpi.dueSoon} tone={kpi.dueSoon ? 'warn' : 'neutral'} />
        <StatCard label="Lekarski istekao" value={kpi.medExpired} tone={kpi.medExpired ? 'danger' : 'neutral'} />
        <StatCard label="Interni" value={kpi.internal} tone="success" />
        <StatCard label="Spoljni" value={kpi.external} tone="info" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Ime, broj vozačke, telefon…" />
        <select value={tip} onChange={(e) => setTip(e.target.value as typeof tip)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="all">Svi vozači</option>
          <option value="internal">Interni</option>
          <option value="external">Spoljni</option>
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Arhivirani</label>
        {canManage && <div className="ml-auto"><Button onClick={() => setEditId('new')}><Plus className="h-4 w-4" aria-hidden /> Novi vozač</Button></div>}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.driver_id}
        loading={drivers.isLoading}
        onRowActivate={(r) => setOpenId(r.driver_id)}
        empty={tableEmpty(drivers.isError, 'Nema vozača', 'Nijedan vozač ne odgovara pretrazi.')}
      />

      <VozacCard id={openId} onClose={() => setOpenId(null)} onEdit={(id) => { setOpenId(null); setEditId(id); }} />
      {editId && <DriverModal driverId={editId === 'new' ? null : editId} canManage={canManage} onClose={() => setEditId(null)} />}
    </div>
  );
}

// ── Driver modal (create + edit + auto-detect + arhiva/restore/delete) ─
function DriverModal({ driverId, canManage, onClose }: { driverId: string | null; canManage: boolean; onClose: () => void }) {
  const isEdit = !!driverId;
  const detail = useDriver(driverId);
  const d = detail.data?.data;
  if (isEdit && (detail.isLoading || !d)) {
    return <Dialog open onClose={onClose} title="Izmeni vozača"><p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p></Dialog>;
  }
  return <DriverForm driverId={driverId} canManage={canManage} initial={d ?? null} onClose={onClose} />;
}

function DriverForm({ driverId, canManage, initial, onClose }: {
  driverId: string | null; canManage: boolean;
  initial: { fullName: string; isInternal: boolean; authUserId: string | null; driversLicenseNumber: string | null; driversLicenseCategories: string[]; driversLicenseValidUntil: string | null; idCardNumber: string | null; idCardValidUntil: string | null; medicalCheckValidUntil: string | null; phone: string | null; jmbg: string | null; address: string | null; notes: string | null; archivedAt: string | null } | null;
  onClose: () => void;
}) {
  const isEdit = !!driverId;
  const create = useCreateDriver();
  const update = useUpdateDriver();
  const archive = useArchiveDriver();
  const restore = useRestoreDriver();
  const del = useDeleteDriver();
  const employees = useEmployeeLookup(canManage);
  const assignable = useAssignableUsers(canManage);
  const users = assignable.data?.data ?? [];

  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [isInternal, setIsInternal] = useState(initial?.isInternal ?? true);
  const [authUserId, setAuthUserId] = useState(initial?.authUserId ?? '');
  const [licNo, setLicNo] = useState(initial?.driversLicenseNumber ?? '');
  const [cats, setCats] = useState<Set<string>>(new Set((initial?.driversLicenseCategories ?? []).map((c) => c.toUpperCase())));
  const [licValid, setLicValid] = useState(initial?.driversLicenseValidUntil ? String(initial.driversLicenseValidUntil).slice(0, 10) : '');
  const [medValid, setMedValid] = useState(initial?.medicalCheckValidUntil ? String(initial.medicalCheckValidUntil).slice(0, 10) : '');
  const [idNo, setIdNo] = useState(initial?.idCardNumber ?? '');
  const [idValid, setIdValid] = useState(initial?.idCardValidUntil ? String(initial.idCardValidUntil).slice(0, 10) : '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [jmbg, setJmbg] = useState(initial?.jmbg ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  const isArchived = !!initial?.archivedAt;

  const match = useMemo(() => {
    const tokens = normNameTokens(fullName);
    if (tokens.length < 2) return null;
    return (employees.data?.data ?? []).find((e) => tokensEqual(tokens, normNameTokens(e.fullName ?? `${e.firstName ?? ''} ${e.lastName ?? ''}`))) ?? null;
  }, [fullName, employees.data]);

  function toggleCat(c: string) { setCats((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; }); }

  function submit() {
    setErr(null);
    if (!fullName.trim()) return setErr('Ime je obavezno.');
    if (!licNo.trim()) return setErr('Broj vozačke je obavezan.');
    if (cats.size === 0) return setErr('Bar jedna kategorija vozačke.');
    if (!licValid) return setErr('Rok važenja vozačke je obavezan.');
    const base = {
      fullName: fullName.trim(),
      isInternal,
      driversLicenseNumber: licNo.trim(),
      driversLicenseCategories: [...cats],
      driversLicenseValidUntil: licValid,
      idCardNumber: idNo.trim() || undefined,
      idCardValidUntil: idValid || undefined,
      medicalCheckValidUntil: medValid || undefined,
      phone: phone.trim() || undefined,
      jmbg: jmbg.trim() || undefined,
      address: address.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    if (isEdit) {
      // Spoljni → BE forsira authUserId=null; interni → prosledi izbor (null = odveži).
      update.mutate({ id: driverId!, patch: { ...base, authUserId: isInternal ? (authUserId || null) : null } }, { onSuccess: () => { toast('Sačuvano'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    } else {
      create.mutate({ ...base, ...(isInternal && authUserId ? { authUserId } : {}) }, { onSuccess: () => { toast('Vozač dodat'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    }
  }

  const pending = create.isPending || update.isPending;
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Izmeni vozača${isArchived ? ' (arhiviran)' : ''}` : 'Novi vozač'}
      size="lg"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {isEdit && !isArchived && <Button variant="secondary" onClick={() => { const r = prompt('Razlog arhiviranja vozača (npr. otišao iz firme):'); if (r?.trim()) archive.mutate({ id: driverId!, reason: r.trim() }, { onSuccess: () => { toast('Vozač arhiviran'); onClose(); } }); }}>Arhiviraj</Button>}
          {isEdit && isArchived && <Button variant="secondary" onClick={() => { if (confirm('Vratiti vozača u upotrebu?')) restore.mutate({ id: driverId! }, { onSuccess: () => { toast('Vraćeno'); onClose(); } }); }}>Vrati u upotrebu</Button>}
          {isEdit && <Button variant="danger" onClick={() => { if (confirm('Trajno obrisati vozača?\n\nAko je vezan za vozila, veza se uklanja (vozilo ostaje bez primarnog vozača).')) del.mutate({ id: driverId! }, { onSuccess: () => { toast('Obrisano'); onClose(); } }); }}>Trajno obriši</Button>}
          <Button variant="ghost" className="ml-auto" onClick={onClose}>Otkaži</Button>
          <Button loading={pending} onClick={submit}>{isEdit ? 'Sačuvaj' : 'Dodaj'}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Ime i prezime" required>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </FormField>
        {match && (
          <div className="flex flex-wrap items-center gap-2 rounded-control bg-accent-subtle px-3 py-2 text-sm text-ink">
            <span>👤 Match u Kadrovskoj: <strong>{match.fullName ?? `${match.firstName ?? ''} ${match.lastName ?? ''}`}</strong>.</span>
            {!isInternal && <Button variant="secondary" onClick={() => setIsInternal(true)}>Označi kao interni</Button>}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Tip vozača">
            <select value={isInternal ? 'true' : 'false'} onChange={(e) => setIsInternal(e.target.value === 'true')} className={selCls}>
              <option value="true">Interni (zaposleni)</option>
              <option value="false">Spoljni (eksterni)</option>
            </select>
          </FormField>
          {isInternal && (
            <FormField label="ERP nalog (opciono)">
              <select value={authUserId} onChange={(e) => setAuthUserId(e.target.value)} className={selCls}>
                <option value="">— ne povezuj —</option>
                {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Broj vozačke" required><Input value={licNo} onChange={(e) => setLicNo(e.target.value)} /></FormField>
          <FormField label="Vozačka važi do" required><Input type="date" value={licValid} onChange={(e) => setLicValid(e.target.value)} /></FormField>
        </div>
        <div>
          <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Kategorije vozačke *</div>
          <div className="flex flex-wrap gap-1 rounded-control border border-line p-2">
            {LICENSE_CATEGORIES.map((c) => (
              <label key={c} className={`flex cursor-pointer items-center gap-1 rounded-control px-2 py-1 text-sm ${cats.has(c) ? 'bg-accent-subtle text-ink' : 'text-ink-secondary hover:bg-surface-2'}`}>
                <input type="checkbox" checked={cats.has(c)} onChange={() => toggleCat(c)} /> {c}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Lekarski važi do"><Input type="date" value={medValid} onChange={(e) => setMedValid(e.target.value)} /></FormField>
          <FormField label="Telefon"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></FormField>
          <FormField label="Lična karta — broj"><Input value={idNo} onChange={(e) => setIdNo(e.target.value)} /></FormField>
          <FormField label="Lična karta — važi do"><Input type="date" value={idValid} onChange={(e) => setIdValid(e.target.value)} /></FormField>
          <FormField label="JMBG"><Input value={jmbg} onChange={(e) => setJmbg(e.target.value)} maxLength={13} /></FormField>
          <FormField label="Adresa"><Input value={address} onChange={(e) => setAddress(e.target.value)} /></FormField>
        </div>
        <FormField label="Napomene"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
      </div>
    </Dialog>
  );
}

// ── Karton vozača (dialog sa tabovima) ──────────────────────────────
type CardTab = 'pregled' | 'vozila' | 'dokumenta';
function VozacCard({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (id: string) => void }) {
  const detail = useDriver(id);
  const vehiclesQ = useVehicles();
  const d = detail.data?.data;
  const [tab, setTab] = useState<CardTab>('pregled');
  if (!id) return null;

  const vehicles = ((vehiclesQ.data?.data ?? []) as VehicleOverviewRow[]).filter((v) => String(f(v, 'primary_driver_id') ?? '') === id);

  return (
    <Dialog open={!!id} onClose={onClose} title={d ? d.fullName : 'Karton vozača'} size="lg"
      footer={d ? <Button onClick={() => onEdit(id)}>Izmeni</Button> : undefined}>
      {detail.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge tone={d.isInternal ? 'success' : 'info'} label={d.isInternal ? 'INTERNI' : 'SPOLJNI'} />
            {d.archivedAt && <StatusBadge tone="neutral" label="Arhiviran" />}
            {d.phone && <span className="text-sm text-ink-secondary">· {d.phone}</span>}
          </div>

          <div className="flex gap-1 rounded-control border border-line bg-surface-2/40 p-0.5 text-sm">
            {(['pregled', 'vozila', 'dokumenta'] as CardTab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-control px-3 py-1 font-medium ${tab === t ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:text-ink'}`}>
                {t === 'pregled' ? 'Pregled' : t === 'vozila' ? `Vozila (${vehicles.length})` : `Dokumenta (${d.documents.length})`}
              </button>
            ))}
          </div>

          {tab === 'pregled' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <RokCard label="Vozačka dozvola" date={d.driversLicenseValidUntil} extra={d.driversLicenseNumber} />
                <RokCard label="Lekarski" date={d.medicalCheckValidUntil} />
                <RokCard label="Lična karta" date={d.idCardValidUntil} extra={d.idCardNumber} />
              </div>
              <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3 sm:grid-cols-3">
                <Field label="Kategorije">{d.driversLicenseCategories?.join(', ') || '—'}</Field>
                <Field label="JMBG">{d.jmbg ?? '—'}</Field>
                <Field label="Adresa">{d.address ?? '—'}</Field>
              </div>
              {d.notes && <div className="rounded-panel border border-line p-3"><div className="text-2xs uppercase tracking-wider text-ink-secondary">Napomene</div><p className="mt-1 whitespace-pre-wrap text-sm text-ink">{d.notes}</p></div>}
              {d.archivedAt && d.archiveReason && <p className="text-2xs text-ink-secondary">Arhiviran: {d.archiveReason} ({formatDate(d.archivedAt)})</p>}
            </div>
          )}

          {tab === 'vozila' && <VozacVozila vehicles={vehicles} />}

          {tab === 'dokumenta' && (
            <div className="space-y-1">
              {d.documents.length === 0 ? <p className="py-4 text-center text-sm text-ink-secondary">Nema dokumenata.</p> : d.documents.map((doc) => (
                <button key={doc.id} onClick={async () => { try { const r = await signDocumentUrl(doc.id); window.open(r.data.url, '_blank'); } catch { toast('Dokument nije dostupan.'); } }} className="flex w-full items-center justify-between gap-2 border-b border-line-soft py-1.5 text-left text-sm hover:bg-surface-2">
                  <span className="flex items-center gap-2 text-accent"><Download className="h-3.5 w-3.5" aria-hidden />{doc.fileName}</span>
                  <span className="text-2xs text-ink-secondary">{doc.validUntil ? `važi do ${formatDate(doc.validUntil)}` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function RokCard({ label, date, extra }: { label: string; date: string | null; extra?: string | null }) {
  return (
    <div className="rounded-panel border border-line p-3">
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      {date ? <div className="mt-1"><StatusBadge tone={deadlineTone(date)} label={formatDate(date)} /></div> : <div className="mt-1 text-sm text-ink-disabled">—</div>}
      {extra && <div className="mt-0.5 text-2xs text-ink-secondary">{extra}</div>}
    </div>
  );
}

function VozacVozila({ vehicles }: { vehicles: VehicleOverviewRow[] }) {
  const router = useRouter();
  if (vehicles.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-secondary">Vozač nije primarni ni na jednom vozilu. Dodeli ga kroz karton vozila → „Primarni vozač".</p>;
  }
  return (
    <div className="space-y-1">
      {vehicles.map((v) => (
        <button key={v.asset_id} onClick={() => router.push(`/odrzavanje/vozila?id=${encodeURIComponent(v.asset_id)}`)} className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-3 py-2 text-left text-sm hover:bg-surface-2">
          <span><span className="tnums font-medium text-ink">{v.asset_code}</span> · {v.name}{v.archived_at && <StatusBadge tone="neutral" label="Arhivirano" />}</span>
          <span className="text-2xs text-ink-secondary">{f(v, 'registration_plate') ?? ''}</span>
        </button>
      ))}
    </div>
  );
}
