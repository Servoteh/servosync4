'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, FileWarning, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useArchiveVehicle,
  useAssets,
  useCreateBooking,
  useCreateTire,
  useCreateVehicleServicePlan,
  useDeleteBooking,
  useDeleteTire,
  useDeleteVehicleServicePlan,
  useDrivers,
  useGenerateVehicleServiceWos,
  useLinkPartToVehicle,
  useParts,
  usePatchVehicleShelf,
  useRestoreVehicle,
  useUnlinkPartFromVehicle,
  useUpdateBooking,
  useUpdatePartVehicleLink,
  useUpdateTire,
  useUpdateVehicleServicePlan,
  useDeleteVehiclePhoto,
  useUploadVehiclePhoto,
  useVehicle,
  useVehicleBookings,
  useVehicleParts,
  useVehiclePhotoUrl,
  useVehicleServicePlan,
  useVehicleTires,
  type BookingStatus,
  type MaintMe,
  type Tire,
  type TireSeason,
  type TireStatus,
  type VehicleDetail,
  type ViewRow,
} from '@/api/odrzavanje';
import {
  BOOKING_STATUS_LABEL,
  deadlineTone,
  f,
  Field,
  fnum,
  GPS_PROVIDER_LABEL,
  isoToDateInput,
  OpStatusBadge,
  OWNER_TYPE_LABEL,
  SHELF_OPTIONS,
  TIRE_SEASON_LABEL,
  TIRE_STATUS_LABEL,
  USAGE_LABEL,
  VEHICLE_KIND_LABEL,
  VEHICLE_SVC_CATEGORY_LABEL,
  WO_PRIORITY_LABEL,
} from './common';
import { AssetWorkOrders } from './asset-work-orders';
import { Tabs } from './tabs';
import { QrCanvas } from './qr-canvas';
import { VoziloEditModal } from './vozilo-edit-modal';
import { PrijavaKvaraDialog } from './prijava-kvara-dialog';

type VTab = 'pregled' | 'servis' | 'gume' | 'delovi' | 'carpool';
const VTABS: VTab[] = ['pregled', 'servis', 'gume', 'delovi', 'carpool'];

function readTab(): VTab {
  if (typeof window === 'undefined') return 'pregled';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t && (VTABS as string[]).includes(t) ? (t as VTab) : 'pregled';
}

/**
 * Karton vozila kao RUTA (`/odrzavanje/vozila?id=<uuid>&tab=<tab>`) — konzistentno sa P1
 * (masina-karton), deep-linkabilan tab, QR/cold-load spremni za P5. Pun paritet 5 tabova +
 * header quick-akcije (Prijavi kvar / Uredi / Vrati iz arhive) + lokalni QR.
 */
export function VoziloKarton({ id, me }: { id: string; me: MaintMe | undefined }) {
  const router = useRouter();
  const vehicle = useVehicle(id);
  const archive = useArchiveVehicle();
  const restore = useRestoreVehicle();
  const d = vehicle.data?.data;
  const det = (d?.details ?? null) as Record<string, unknown> | null;
  const [tab, setTabState] = useState<VTab>('pregled');
  const [editOpen, setEditOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const carpoolCanEdit = canManage || me?.maintRole === 'technician' || me?.maintRole === 'operator';

  useEffect(() => { setTabState(readTab()); }, []);
  useEffect(() => {
    const onPop = () => setTabState(readTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function setTab(next: VTab) {
    setTabState(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'pregled') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.pushState(null, '', url.toString());
  }

  /* QR nalepnica ključa se po asset_code (NE UUID) — preživljava re-seed baze i
     poklapa se sa 1.0 formatom nalepnice; deep-link resolver (VoziloKartonByCode)
     razrešava code→id. */
  const qrUrl = typeof window !== 'undefined' && d ? `${window.location.origin}/odrzavanje/vozila?code=${encodeURIComponent(d.assetCode)}` : '';

  return (
    <div className="space-y-4">
      <button onClick={() => router.push('/odrzavanje')} className="inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Održavanje
      </button>

      {vehicle.isLoading || !d ? (
        <p className="py-10 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-ink"><span className="tnums">{d.assetCode}</span> · {d.name}</h1>
                <OpStatusBadge status={d.status} />
                {d.archivedAt && <StatusBadge tone="neutral" label="Arhivirano" />}
              </div>
              {f(det ?? {}, 'registrationPlate') && <p className="mt-0.5 text-sm text-ink-secondary">{f(det ?? {}, 'registrationPlate')}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setShowReport(true)}><FileWarning className="h-4 w-4" aria-hidden /> Prijavi kvar</Button>
              {canManage && !d.archivedAt && <Button onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" aria-hidden /> Uredi vozilo</Button>}
              {canManage && !d.archivedAt && <Button variant="danger" onClick={() => { const reason = prompt('Razlog arhiviranja vozila?'); if (reason?.trim()) archive.mutate({ id, reason: reason.trim() }, { onSuccess: () => toast('Vozilo arhivirano') }); }}>Arhiviraj</Button>}
            </div>
          </div>

          {d.archivedAt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-status-warn" aria-hidden /> Vozilo je ARHIVIRANO ({formatDate(d.archivedAt)}){d.archiveReason ? ` — ${d.archiveReason}` : ''}.
              </span>
              {canManage && <Button variant="secondary" onClick={() => restore.mutate({ id }, { onSuccess: () => toast('Vozilo vraćeno u upotrebu') })}>Vrati u upotrebu</Button>}
            </div>
          )}

          <Tabs
            tabs={[
              { key: 'pregled', label: 'Pregled' },
              { key: 'servis', label: 'Servisni plan' },
              { key: 'gume', label: 'Gume' },
              { key: 'delovi', label: 'Delovi' },
              { key: 'carpool', label: 'Carpool' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Karton vozila"
          />

          {tab === 'pregled' && <VPregled d={d} det={det} qrUrl={qrUrl} id={id} canManage={canManage} />}
          {tab === 'servis' && <VServis id={id} canManage={canManage} me={me} />}
          {tab === 'gume' && <VGume id={id} canManage={canManage} />}
          {tab === 'delovi' && <VDelovi id={id} assetCode={d.assetCode} det={det} canManage={canManage} />}
          {tab === 'carpool' && <VCarpool id={id} canEdit={carpoolCanEdit} />}

          {editOpen && <VoziloEditModal vehicleId={id} onClose={() => setEditOpen(false)} />}
          {showReport && <PrijavaKvaraDialog me={me} fixedAsset={{ code: d.assetCode, name: d.name, assetId: id, assetType: 'vehicle' }} onClose={() => setShowReport(false)} />}
        </>
      )}
    </div>
  );
}

/**
 * Deep-link po asset_code (H22 — cutover rizik). Odštampane QR nalepnice / 1.0
 * router prevode `/maintenance/assets/vehicles/<code>` → `/odrzavanje/vozila?code=<code>`.
 * Ovde razrešavamo code→asset_id (GET /maintenance/assets, match `asset_code`
 * case-insensitive) pa renderujemo karton. Po pogotku URL se čisti na `?id=` (uz
 * očuvan `tab`) — deljenje/refresh idu direktnim putem. Bez pogotka: jasna poruka + list.
 */
export function VoziloKartonByCode({ code, me }: { code: string; me: MaintMe | undefined }) {
  const router = useRouter();
  const assets = useAssets('vehicle', false);
  const rows = assets.data?.data ?? [];
  const needle = code.toLowerCase().trim();
  const match = rows.find((a) => String(a.assetCode ?? '').toLowerCase().trim() === needle) ?? null;

  useEffect(() => {
    if (!match || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.set('id', match.assetId);
    window.history.replaceState(null, '', url.toString());
  }, [match]);

  if (assets.isLoading) return <p className="py-10 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  if (!match) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="text-sm text-ink">Nije pronađeno vozilo sa šifrom „<span className="tnums">{code}</span>".</p>
        <button onClick={() => router.push('/odrzavanje')} className="text-sm text-accent hover:underline">← Nazad na listu sredstava</button>
      </div>
    );
  }
  return <VoziloKarton id={match.assetId} me={me} />;
}

// ── Pregled ─────────────────────────────────────────────────────────
function VPregled({ d, det, qrUrl, id, canManage }: { d: VehicleDetail; det: Record<string, unknown> | null; qrUrl: string; id: string; canManage: boolean }) {
  const dd = det ?? {};
  const ownerName = d.owner?.name ?? null;
  const ownerTypeLabel = d.owner?.ownerType ? OWNER_TYPE_LABEL[d.owner.ownerType] ?? d.owner.ownerType : null;
  return (
    <div className="space-y-4">
      <VehiclePhoto id={id} hasPhoto={!!f(dd, 'primaryPhotoStoragePath')} canManage={canManage} />

      <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3 sm:grid-cols-3">
        <Field label="Tablice">{f(dd, 'registrationPlate') ?? '—'}</Field>
        <Field label="Vrsta">{VEHICLE_KIND_LABEL[f(dd, 'vehicleKind') ?? ''] ?? f(dd, 'vehicleKind') ?? '—'}</Field>
        <Field label="Namena">{USAGE_LABEL[f(dd, 'usageType') ?? ''] ?? f(dd, 'usageType') ?? '—'}</Field>
        <Field label="Vlasnik">{ownerName ? `${ownerName}${ownerTypeLabel ? ` (${ownerTypeLabel})` : ''}` : '—'}</Field>
        <Field label="Proizvođač / model">{[d.manufacturer, d.model].filter(Boolean).join(' / ') || '—'}</Field>
        <Field label="Godina">{f(dd, 'yearOfManufacture') ?? '—'}</Field>
        <Field label="VIN">{f(dd, 'vin') ?? '—'}</Field>
        <Field label="Gorivo">{f(dd, 'fuelType') ?? '—'}</Field>
        <Field label="Kilometraža">{f(dd, 'odometerKm') ? `${Number(f(dd, 'odometerKm')).toLocaleString('sr-RS')} km` : '—'}</Field>
        <Field label="GPS">{GPS_PROVIDER_LABEL[f(dd, 'gpsProvider') ?? 'nema'] ?? f(dd, 'gpsProvider') ?? '—'}</Field>
        <Field label="Privatno">{dd.isPrivateVehicle === true ? 'Da' : 'Ne'}</Field>
        <Field label="ENP / TAG">{f(dd, 'tollTagSerial') ?? '—'}</Field>
      </div>

      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-ink">Rokovi</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Rok label="Registracija" date={f(dd, 'registrationExpiresAt')} />
          <Rok label="Osiguranje" date={f(dd, 'insuranceExpiresAt')} />
          <Rok label="Servis (legacy)" date={f(dd, 'serviceDueAt')} />
          <Rok label="Prva pomoć" date={f(dd, 'firstAidKitExpiresAt')} />
        </div>
      </div>

      {(f(dd, 'notes')) && (
        <div className="rounded-panel border border-line p-3">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Napomena</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{f(dd, 'notes')}</p>
        </div>
      )}

      {qrUrl && (
        <div className="flex items-center gap-3 rounded-panel border border-line p-3">
          <QrCanvas url={qrUrl} />
          <div className="text-sm text-ink-secondary">
            <div className="font-medium text-ink">QR kartica vozila</div>
            <p className="mt-0.5 text-xs">Skeniranje otvara karton ovog vozila. Renderuje se lokalno — ne šalje se van mreže.</p>
          </div>
        </div>
      )}
    </div>
  );
}
/**
 * Glavna fotografija vozila (P4a rute). Signed URL se povlači tek kad details nose
 * `primaryPhotoStoragePath` (izbegava 404 buku). Dok BE nije živ / foto ne postoji →
 * graceful placeholder. Upload/uklanjanje samo za canManage.
 */
function VehiclePhoto({ id, hasPhoto, canManage }: { id: string; hasPhoto: boolean; canManage: boolean }) {
  const photo = useVehiclePhotoUrl(id, hasPhoto);
  const upload = useUploadVehiclePhoto();
  const remove = useDeleteVehiclePhoto();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const url = photo.data?.data.url ?? null;
  const shown = hasPhoto && !photo.isError && url;

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Dozvoljena je samo slika.');
    if (file.size > 25 * 1024 * 1024) return toast('Fotografija je prevelika (max 25 MB).');
    upload.mutate({ id, file }, { onSuccess: () => toast('Fotografija sačuvana'), onError: (err) => toast((err as Error).message) });
  }

  if (!shown && !canManage) return null;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface p-3">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Fotografija vozila" className="max-h-40 max-w-full rounded-control border border-line object-cover" />
      ) : (
        <div className="grid h-28 w-40 place-items-center rounded-control border border-dashed border-line text-2xs text-ink-secondary">
          {photo.isLoading ? 'Učitavanje…' : 'Nema fotografije'}
        </div>
      )}
      {canManage && (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" loading={upload.isPending} onClick={() => fileRef.current?.click()}>{shown ? 'Zameni fotografiju' : 'Otpremi fotografiju'}</Button>
          {shown && <Button variant="ghost" disabled={remove.isPending} onClick={() => { if (confirm('Ukloniti glavnu fotografiju vozila?')) remove.mutate({ id }, { onSuccess: () => toast('Fotografija uklonjena') }); }}>Ukloni</Button>}
        </div>
      )}
    </div>
  );
}
function Rok({ label, date }: { label: string; date: string | null }) {
  return (
    <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm">
      <span className="text-ink-secondary">{label}</span>
      {date ? <StatusBadge tone={deadlineTone(date)} label={formatDate(date)} /> : <span className="text-ink-disabled">—</span>}
    </div>
  );
}

// ── Servisni plan (pun CRUD + status/next-due/WO-link) ──────────────
const SVC_DUE: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  due_soon: { tone: 'warn', label: 'Uskoro' },
  overdue: { tone: 'danger', label: 'Kasni' },
  inactive: { tone: 'neutral', label: 'Pauziran' },
};
function VServis({ id, canManage, me }: { id: string; canManage: boolean; me: MaintMe | undefined }) {
  const plans = useVehicleServicePlan(id);
  const del = useDeleteVehicleServicePlan();
  const gen = useGenerateVehicleServiceWos();
  const [formOpen, setFormOpen] = useState(false);
  const [editRow, setEditRow] = useState<ViewRow | null>(null);
  const rows = (plans.data?.data ?? []) as ViewRow[];
  const overdueN = rows.filter((r) => f(r, 'due_status') === 'overdue').length;
  const dueSoonN = rows.filter((r) => f(r, 'due_status') === 'due_soon').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">
          {rows.length} {rows.length === 1 ? 'stavka' : 'stavki'}
          {overdueN > 0 && <span className="text-status-danger"> · {overdueN} kasni</span>}
          {dueSoonN > 0 && <span className="text-status-warn"> · {dueSoonN} uskoro</span>}
        </p>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" disabled={gen.isPending} onClick={() => gen.mutate({ id }, { onSuccess: () => toast('Generisanje WO iz plana pokrenuto') })}>↻ Generiši WO</Button>
            <Button onClick={() => { setEditRow(null); setFormOpen(true); }}><Plus className="h-4 w-4" aria-hidden /> Dodaj stavku</Button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema plan stavki. Dodaj prvu da sistem automatski kreira naloge kad servis dospe.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Stavka</th><th className="p-2">Interval</th><th className="p-2">Poslednji put</th><th className="p-2">Sledeći put</th><th className="p-2">Status</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const due = SVC_DUE[f(r, 'due_status') ?? ''] ?? { tone: 'neutral' as Tone, label: f(r, 'due_status') ?? '—' };
                const cat = f(r, 'vehicle_service_category');
                return (
                  <tr key={f(r, 'plan_id') ?? Math.random()} className={`border-b border-line-soft ${f(r, 'active') === 'false' ? 'opacity-55' : ''}`}>
                    <td className="p-2"><span className="font-medium text-ink">{f(r, 'name')}</span>{cat && <div className="text-2xs text-ink-secondary">{VEHICLE_SVC_CATEGORY_LABEL[cat] ?? cat}</div>}</td>
                    <td className="p-2 text-ink-secondary">{intervalText(fnum(r, 'interval_km'), fnum(r, 'interval_months'))}</td>
                    <td className="p-2 text-ink-secondary">{f(r, 'last_done_at') ? formatDate(String(f(r, 'last_done_at'))) : '—'}{fnum(r, 'last_done_km') != null ? ` · ${Number(f(r, 'last_done_km')).toLocaleString('sr-RS')} km` : ''}</td>
                    <td className="p-2 text-ink-secondary">{nextDueText(f(r, 'next_due_at'), fnum(r, 'next_due_km'), fnum(r, 'days_to_due'), fnum(r, 'km_to_due'))}</td>
                    <td className="p-2"><StatusBadge tone={due.tone} label={due.label} /></td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        {f(r, 'has_open_wo') === 'true' && <StatusBadge tone="info" label="WO otvoren" />}
                        {canManage && <button title="Izmeni" onClick={() => { setEditRow(r); setFormOpen(true); }} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>}
                        {canManage && <button title="Obriši" onClick={() => { if (confirm(`Obrisati plan stavku „${f(r, 'name')}"? WO-ovi ostaju ali gube vezu nazad.`)) del.mutate({ id, planId: String(f(r, 'plan_id')) }, { onSuccess: () => toast('Obrisano') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AssetWorkOrders assetId={id} me={me} title="Radni nalozi vozila" />
      {formOpen && <ServicePlanForm id={id} row={editRow} onClose={() => setFormOpen(false)} />}
    </div>
  );
}
function intervalText(km: number | null, months: number | null): string {
  const parts: string[] = [];
  if (months != null) parts.push(`${months} mes`);
  if (km != null) parts.push(`${km.toLocaleString('sr-RS')} km`);
  return parts.join(' / ') || '—';
}
function nextDueText(at: string | null, km: number | null, daysToDue: number | null, kmToDue: number | null): string {
  const lines: string[] = [];
  if (at) {
    let hint = '';
    if (daysToDue != null) hint = daysToDue < 0 ? ` (kasni ${-daysToDue}d)` : daysToDue === 0 ? ' (danas)' : daysToDue <= 30 ? ` (za ${daysToDue}d)` : '';
    lines.push(`${formatDate(at)}${hint}`);
  }
  if (km != null) {
    let hint = '';
    if (kmToDue != null) hint = kmToDue < 0 ? ` (prešao ${(-kmToDue).toLocaleString('sr-RS')} km)` : kmToDue <= 1000 ? ` (za ${kmToDue.toLocaleString('sr-RS')} km)` : '';
    lines.push(`${km.toLocaleString('sr-RS')} km${hint}`);
  }
  return lines.join(' · ') || '—';
}

const SVC_PRIORITY_KEYS = ['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'] as const;
const SVC_CAT_KEYS = Object.keys(VEHICLE_SVC_CATEGORY_LABEL);
function ServicePlanForm({ id, row, onClose }: { id: string; row: ViewRow | null; onClose: () => void }) {
  const create = useCreateVehicleServicePlan();
  const update = useUpdateVehicleServicePlan();
  const isEdit = !!row;
  const [name, setName] = useState(row ? String(f(row, 'name') ?? '') : '');
  const [category, setCategory] = useState(row ? String(f(row, 'vehicle_service_category') ?? '') : '');
  const [priority, setPriority] = useState<string>(row ? String(f(row, 'priority') ?? 'p4_planirano') : 'p4_planirano');
  const [months, setMonths] = useState(row ? String(fnum(row, 'interval_months') ?? '') : '');
  const [km, setKm] = useState(row ? String(fnum(row, 'interval_km') ?? '') : '');
  const [lastAt, setLastAt] = useState(row ? isoToDateInput(f(row, 'last_done_at')) : '');
  const [lastKm, setLastKm] = useState(row ? String(fnum(row, 'last_done_km') ?? '') : '');
  const [active, setActive] = useState(row ? f(row, 'active') !== 'false' : true);
  const [notes, setNotes] = useState(row ? String(f(row, 'notes') ?? '') : '');
  const [err, setErr] = useState<string | null>(null);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  function submit() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    const m = months.trim() === '' ? undefined : Number(months);
    const k = km.trim() === '' ? undefined : Number(km);
    if (m == null && k == null) return setErr('Bar jedan interval (meseci ili km) je obavezan.');
    if (m != null && (!Number.isFinite(m) || m <= 0)) return setErr('Interval u mesecima mora biti pozitivan.');
    if (k != null && (!Number.isFinite(k) || k <= 0)) return setErr('Interval u km mora biti pozitivan.');
    const common = {
      name: name.trim(),
      intervalMonths: m,
      intervalKm: k,
      lastDoneAt: lastAt || undefined,
      lastDoneKm: lastKm.trim() === '' ? undefined : Number(lastKm),
      vehicleServiceCategory: category || undefined,
      priority: priority as never,
      notes: notes.trim() || undefined,
      active,
    };
    if (isEdit) update.mutate({ id, planId: String(f(row!, 'plan_id')), patch: common }, { onSuccess: () => { toast('Sačuvano'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    else create.mutate({ id, ...common }, { onSuccess: () => { toast('Plan stavka dodata'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Izmeni plan stavku' : 'Nova plan stavka'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={create.isPending || update.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Veliki servis, Zamena ulja" /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Kategorija"><select value={category} onChange={(e) => setCategory(e.target.value)} className={selCls}><option value="">— bez —</option>{SVC_CAT_KEYS.map((k) => <option key={k} value={k}>{VEHICLE_SVC_CATEGORY_LABEL[k]}</option>)}</select></FormField>
          <FormField label="Prioritet"><select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>{SVC_PRIORITY_KEYS.map((k) => <option key={k} value={k}>{WO_PRIORITY_LABEL[k]}</option>)}</select></FormField>
          <FormField label="Interval — meseci"><Input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Interval — km"><Input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Poslednji put — datum"><Input type="date" value={lastAt} onChange={(e) => setLastAt(e.target.value)} /></FormField>
          <FormField label="Poslednji put — km"><Input value={lastKm} onChange={(e) => setLastKm(e.target.value)} inputMode="numeric" /></FormField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktivno (uključeno u auto-generisanje WO)</label>
        <FormField label="Napomene"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
      </div>
    </Dialog>
  );
}

// ── Gume (pun modal + edit + 9 kolona) ──────────────────────────────
const TIRE_SEASON_KEYS: TireSeason[] = ['summer', 'winter', 'all_season'];
const TIRE_STATUS_KEYS: TireStatus[] = ['nove', 'koriscene', 'dotrajale', 'bacene'];
function VGume({ id, canManage }: { id: string; canManage: boolean }) {
  const tires = useVehicleTires(id);
  const del = useDeleteTire();
  const [formTire, setFormTire] = useState<Tire | null | 'new'>(null);
  const rows = tires.data?.data ?? [];
  return (
    <div className="space-y-3">
      {canManage && <div className="flex justify-end"><Button onClick={() => setFormTire('new')}><Plus className="h-4 w-4" aria-hidden /> Dodaj komplet</Button></div>}
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema unetih guma.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Sezona</th><th className="p-2">Dimenzija</th><th className="p-2">Kom</th><th className="p-2">Status</th><th className="p-2">Na vozilu</th><th className="p-2">Polica</th><th className="p-2">Nabavka</th><th className="p-2">Napomena</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.tireSetId} className="border-b border-line-soft">
                  <td className="p-2"><StatusBadge tone="neutral" label={TIRE_SEASON_LABEL[t.season] ?? t.season} /></td>
                  <td className="p-2 font-medium text-ink">{t.dimension}</td>
                  <td className="p-2 text-ink-secondary">{t.count}</td>
                  <td className="p-2 text-ink-secondary">{TIRE_STATUS_LABEL[t.status] ?? t.status}</td>
                  <td className="p-2 text-ink-secondary">{t.installedOnVehicle ? 'Da' : 'Ne'}</td>
                  <td className="p-2 text-ink-secondary">{t.shelfCode ?? '—'}</td>
                  <td className="p-2 text-ink-secondary">{t.purchasedAt ? formatDate(t.purchasedAt) : '—'}</td>
                  <td className="p-2 text-ink-secondary">{t.notes ?? ''}</td>
                  <td className="p-2 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1.5">
                        <button title="Izmeni" onClick={() => setFormTire(t)} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
                        <button title="Obriši" onClick={() => { if (confirm('Obrisati komplet guma?')) del.mutate({ id, tireId: t.tireSetId }, { onSuccess: () => toast('Obrisano') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {formTire && <TireForm id={id} tire={formTire === 'new' ? null : formTire} onClose={() => setFormTire(null)} />}
    </div>
  );
}
function TireForm({ id, tire, onClose }: { id: string; tire: Tire | null; onClose: () => void }) {
  const create = useCreateTire();
  const update = useUpdateTire();
  const isEdit = !!tire;
  const [season, setSeason] = useState<TireSeason>(tire?.season ?? 'summer');
  const [dimension, setDim] = useState(tire?.dimension ?? '');
  const [count, setCount] = useState(String(tire?.count ?? 4));
  const [status, setStatus] = useState<TireStatus>(tire?.status ?? 'koriscene');
  const [shelfCode, setShelf] = useState(tire?.shelfCode ?? '');
  const [installed, setInstalled] = useState(tire?.installedOnVehicle ?? false);
  const [purchasedAt, setPurchased] = useState(isoToDateInput(tire?.purchasedAt));
  const [notes, setNotes] = useState(tire?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  function submit() {
    setErr(null);
    if (!dimension.trim()) return setErr('Dimenzija je obavezna.');
    const c = Number(count);
    if (!Number.isFinite(c) || c < 1) return setErr('Broj guma mora biti ≥ 1.');
    const body = { season, dimension: dimension.trim(), count: Math.round(c), status, shelfCode: shelfCode.trim() || undefined, installedOnVehicle: installed, purchasedAt: purchasedAt || undefined, notes: notes.trim() || undefined };
    if (isEdit) update.mutate({ id, tireId: tire!.tireSetId, patch: body }, { onSuccess: () => { toast('Komplet sačuvan'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    else create.mutate({ id, ...body }, { onSuccess: () => { toast('Komplet dodat'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Izmena kompleta guma' : 'Novi komplet guma'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={create.isPending || update.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Sezona" required><select value={season} onChange={(e) => setSeason(e.target.value as TireSeason)} className={selCls}>{TIRE_SEASON_KEYS.map((s) => <option key={s} value={s}>{TIRE_SEASON_LABEL[s]}</option>)}</select></FormField>
          <FormField label="Status"><select value={status} onChange={(e) => setStatus(e.target.value as TireStatus)} className={selCls}>{TIRE_STATUS_KEYS.map((s) => <option key={s} value={s}>{TIRE_STATUS_LABEL[s]}</option>)}</select></FormField>
          <FormField label="Dimenzija" required><Input value={dimension} onChange={(e) => setDim(e.target.value)} placeholder="npr. 225/55 R17" /></FormField>
          <FormField label="Komada" required><Input value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Polica / šifra skladišta"><Input value={shelfCode} onChange={(e) => setShelf(e.target.value)} /></FormField>
          <FormField label="Datum nabavke"><Input type="date" value={purchasedAt} onChange={(e) => setPurchased(e.target.value)} /></FormField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={installed} onChange={(e) => setInstalled(e.target.checked)} /> Montirano na vozilu</label>
        <FormField label="Napomena"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
      </div>
    </Dialog>
  );
}

// ── Delovi (shelf-komplet + picker + link edit/unlink + stock badge) ─
const STOCK_BADGE: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  low: { tone: 'warn', label: 'Malo' },
  out: { tone: 'danger', label: 'Nema' },
};
function VDelovi({ id, assetCode, det, canManage }: { id: string; assetCode: string; det: Record<string, unknown> | null; canManage: boolean }) {
  const parts = useVehicleParts(id);
  const unlink = useUnlinkPartFromVehicle();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [editRow, setEditRow] = useState<ViewRow | null>(null);
  const rows = (parts.data?.data ?? []) as ViewRow[];
  const existingPartIds = new Set(rows.map((r) => String(f(r, 'part_id'))));
  const hasSet = det?.hasPartsSet === true;
  const shelf = f(det ?? {}, 'partsShelf');
  const partsNotes = f(det ?? {}, 'partsNotes');
  const outN = rows.filter((r) => f(r, 'stock_status') === 'out').length;
  const lowN = rows.filter((r) => f(r, 'stock_status') === 'low').length;

  return (
    <div className="space-y-3">
      <div className={`flex flex-wrap items-center gap-3 rounded-panel border-l-4 p-3 ${hasSet ? 'border-status-success bg-status-success-bg/30' : 'border-status-warn bg-status-warn-bg/30'}`}>
        <span className="text-xl" aria-hidden>{hasSet ? '✅' : '❌'}</span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink">Komplet rezervnih delova: {hasSet ? 'IMA' : 'NEMA'}</div>
          <div className="text-2xs text-ink-secondary">Polica: <strong>{shelf ?? '— nije zabeležena —'}</strong>{partsNotes ? ` · ${partsNotes}` : ''}</div>
        </div>
        {canManage && <Button variant="secondary" onClick={() => setShelfOpen(true)}>Izmeni</Button>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">
          {rows.length} {rows.length === 1 ? 'deo' : 'delova'} vezano
          {outN > 0 && <span className="text-status-danger"> · {outN} nema na stanju</span>}
          {lowN > 0 && <span className="text-status-warn"> · {lowN} ispod min.</span>}
        </p>
        {canManage && <Button onClick={() => setPickerOpen(true)}><Plus className="h-4 w-4" aria-hidden /> Dodaj postojeći deo</Button>}
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema delova vezanih za ovo vozilo.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Šifra</th><th className="p-2">Naziv</th><th className="p-2">Dobavljač</th><th className="p-2">Na stanju</th><th className="p-2">Min</th><th className="p-2">Status</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STOCK_BADGE[f(r, 'stock_status') ?? ''] ?? { tone: 'neutral' as Tone, label: '—' };
                return (
                  <tr key={String(f(r, 'part_id'))} className="border-b border-line-soft">
                    <td className="p-2 tnums text-ink-secondary">{f(r, 'part_code') ?? '—'}</td>
                    <td className="p-2"><span className="font-medium text-ink">{f(r, 'part_name') ?? '—'}</span>{f(r, 'notes') && <div className="text-2xs text-ink-secondary">📝 {f(r, 'notes')}</div>}</td>
                    <td className="p-2 text-ink-secondary">{f(r, 'supplier_name') ?? '—'}</td>
                    <td className="p-2 text-ink-secondary">{f(r, 'current_stock') ?? '—'} {f(r, 'unit') ?? ''}</td>
                    <td className="p-2 text-ink-secondary">{f(r, 'effective_min') ?? '—'}{f(r, 'vehicle_qty_min') == null ? ' (global)' : ''}</td>
                    <td className="p-2"><StatusBadge tone={st.tone} label={st.label} /></td>
                    <td className="p-2 text-right">{canManage && <button title="Izmeni" onClick={() => setEditRow(r)} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shelfOpen && <ShelfForm id={id} assetCode={assetCode} hasSet={hasSet} shelf={shelf} notes={partsNotes} onClose={() => setShelfOpen(false)} />}
      {pickerOpen && <PartPicker id={id} existingPartIds={existingPartIds} onClose={() => setPickerOpen(false)} />}
      {editRow && <PartLinkEditForm id={id} row={editRow} onUnlink={() => { unlink.mutate({ id, partId: String(f(editRow, 'part_id')) }, { onSuccess: () => { toast('Veza uklonjena'); setEditRow(null); } }); }} onClose={() => setEditRow(null)} />}
    </div>
  );
}
function ShelfForm({ id, assetCode, hasSet, shelf, notes, onClose }: { id: string; assetCode: string; hasSet: boolean; shelf: string | null; notes: string | null; onClose: () => void }) {
  const patch = usePatchVehicleShelf();
  const [has, setHas] = useState(hasSet);
  const [sh, setSh] = useState(shelf ?? '');
  const [nt, setNt] = useState(notes ?? '');
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';
  return (
    <Dialog open onClose={onClose} title="Komplet rezervnih delova"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={patch.isPending} onClick={() => patch.mutate({ id, patch: { hasPartsSet: has, partsShelf: sh || null, partsNotes: nt.trim() || null } }, { onSuccess: () => { toast('Sačuvano'); onClose(); } })}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        <p className="text-2xs text-ink-secondary">{assetCode}</p>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={has} onChange={(e) => setHas(e.target.checked)} /> Ima komplet rezervnih delova</label>
        <FormField label="Polica"><select value={sh} onChange={(e) => setSh(e.target.value)} className={selCls}><option value="">— bez police —</option>{SHELF_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}</select></FormField>
        <FormField label="Napomena"><Textarea value={nt} onChange={(e) => setNt(e.target.value)} rows={2} placeholder="npr. Ima nosač kuke, 2 kompleta…" /></FormField>
      </div>
    </Dialog>
  );
}
function PartPicker({ id, existingPartIds, onClose }: { id: string; existingPartIds: Set<string>; onClose: () => void }) {
  const link = useLinkPartToVehicle();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  const [qtyMin, setQtyMin] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const parts = useParts({ q, pageSize: 50 });
  const list = (parts.data?.data ?? []) as unknown as Array<Record<string, unknown>>;

  function add() {
    if (!chosen) return;
    setErr(null);
    const qm = qtyMin.trim() === '' ? undefined : Number(qtyMin);
    if (qm != null && (!Number.isFinite(qm) || qm < 0)) return setErr('Min mora biti broj ≥ 0.');
    link.mutate({ id, partId: chosen.id, qtyMin: qm, notes: notes.trim() || undefined }, { onSuccess: () => { toast('Deo dodat na vozilo'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title="Dodaj deo na vozilo"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button disabled={!chosen} loading={link.isPending} onClick={add}>Dodaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Šifra ili naziv dela…" autoFocus />
        <div className="max-h-64 space-y-0.5 overflow-auto rounded-control border border-line p-1">
          {parts.isLoading ? <p className="p-2 text-sm text-ink-secondary">Učitavanje…</p> : list.length === 0 ? <p className="p-2 text-sm text-ink-secondary">Nema pogodaka.</p> : list.map((r) => {
            const pid = String(r.partId ?? f(r, 'part_id'));
            const already = existingPartIds.has(pid);
            const label = `${r.partCode ?? f(r, 'part_code') ?? ''} — ${r.name ?? f(r, 'name') ?? ''}`;
            return (
              <button key={pid} type="button" disabled={already} onClick={() => setChosen({ id: pid, label })}
                className={`flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm ${already ? 'opacity-40' : chosen?.id === pid ? 'bg-accent-subtle' : 'hover:bg-surface-2'}`}>
                <code className="tnums text-ink-secondary">{String(r.partCode ?? f(r, 'part_code') ?? '')}</code>
                <span className="flex-1 text-ink">{String(r.name ?? f(r, 'name') ?? '')}</span>
                <span className="text-2xs text-ink-secondary">{String(r.currentStock ?? f(r, 'current_stock') ?? '')} {String(r.unit ?? f(r, 'unit') ?? '')}</span>
                {already && <StatusBadge tone="neutral" label="Već dodato" />}
              </button>
            );
          })}
        </div>
        {chosen && (
          <div className="space-y-2 rounded-control border border-line p-3">
            <p className="text-sm font-medium text-ink">Izabran: {chosen.label}</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Min za ovo vozilo" hint="prazno = globalni min"><Input value={qtyMin} onChange={(e) => setQtyMin(e.target.value)} inputMode="numeric" /></FormField>
              <FormField label="Napomena"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
function PartLinkEditForm({ id, row, onUnlink, onClose }: { id: string; row: ViewRow; onUnlink: () => void; onClose: () => void }) {
  const patch = useUpdatePartVehicleLink();
  const [qtyMin, setQtyMin] = useState(fnum(row, 'vehicle_qty_min') != null ? String(fnum(row, 'vehicle_qty_min')) : '');
  const [notes, setNotes] = useState(f(row, 'notes') ?? '');
  const [err, setErr] = useState<string | null>(null);
  function save() {
    setErr(null);
    const qm = qtyMin.trim() === '' ? null : Number(qtyMin);
    if (qm != null && (!Number.isFinite(qm) || qm < 0)) return setErr('Min mora biti broj ≥ 0.');
    patch.mutate({ id, partId: String(f(row, 'part_id')), patch: { qtyMin: qm, notes: notes.trim() || null } }, { onSuccess: () => { toast('Sačuvano'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }
  return (
    <Dialog open onClose={onClose} title="Izmeni vezu deo ↔ vozilo"
      footer={<><Button variant="danger" className="mr-auto" onClick={() => { if (confirm(`Ukloni „${f(row, 'part_code')} — ${f(row, 'part_name')}" sa vozila? Deo ostaje u magacinu.`)) onUnlink(); }}>Ukloni sa vozila</Button><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={patch.isPending} onClick={save}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <p className="text-sm text-ink-secondary"><code className="tnums">{f(row, 'part_code')}</code> — {f(row, 'part_name')}</p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min za ovo vozilo" hint={`globalni min: ${f(row, 'global_min_stock') ?? '0'}`}><Input value={qtyMin} onChange={(e) => setQtyMin(e.target.value)} inputMode="numeric" /></FormField>
          <FormField label="Napomena"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}

// ── Carpool (pun add/edit + showPast + brojači + gate) ──────────────
const CARPOOL_STATE_BADGE: Record<string, { tone: Tone; label: string }> = {
  planirana: { tone: 'info', label: 'Planirana' },
  u_toku: { tone: 'success', label: 'U toku' },
  zavrsena: { tone: 'neutral', label: 'Završena' },
  otkazana: { tone: 'neutral', label: 'Otkazana' },
  isteklo: { tone: 'warn', label: 'Isteklo (zatvori)' },
};
function VCarpool({ id, canEdit }: { id: string; canEdit: boolean }) {
  const bookings = useVehicleBookings(id);
  const [showPast, setShowPast] = useState(false);
  const [formRow, setFormRow] = useState<ViewRow | null | 'new'>(null);
  const all = (bookings.data?.data ?? []) as ViewRow[];
  const now = Date.now();
  const rows = showPast ? all : all.filter((b) => { const e = f(b, 'end_at'); return !e || Date.parse(String(e)) >= now; });
  const planN = all.filter((b) => f(b, 'current_state') === 'planirana').length;
  const activeN = all.filter((b) => f(b, 'current_state') === 'u_toku').length;
  const overdueN = all.filter((b) => f(b, 'current_state') === 'isteklo').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">
          {all.length} {all.length === 1 ? 'rezervacija' : 'rezervacija'}
          {planN > 0 && ` · ${planN} planirano`}
          {activeN > 0 && <span className="text-status-success"> · {activeN} u toku</span>}
          {overdueN > 0 && <span className="text-status-warn"> · {overdueN} isteklo</span>}
        </p>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> Prikaži i prošle</label>
          {canEdit && <Button onClick={() => setFormRow('new')}><Plus className="h-4 w-4" aria-hidden /> Nova rezervacija</Button>}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema rezervacija.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary"><th className="p-2">Period</th><th className="p-2">Vozač</th><th className="p-2">Namena</th><th className="p-2">Status</th><th className="p-2"></th></tr></thead>
            <tbody>
              {rows.map((b) => {
                const st = CARPOOL_STATE_BADGE[f(b, 'current_state') ?? ''] ?? { tone: 'neutral' as Tone, label: f(b, 'current_state') ?? '—' };
                return (
                  <tr key={String(f(b, 'booking_id'))} className="border-b border-line-soft">
                    <td className="p-2 text-ink-secondary">{f(b, 'start_at') ? formatDateTime(String(f(b, 'start_at'))) : '—'}<br />→ {f(b, 'end_at') ? formatDateTime(String(f(b, 'end_at'))) : '—'}</td>
                    <td className="p-2 text-ink">{f(b, 'driver_name') ?? '— bez vozača —'}</td>
                    <td className="p-2 text-ink-secondary">{f(b, 'purpose') ?? '—'}</td>
                    <td className="p-2"><StatusBadge tone={st.tone} label={st.label} /></td>
                    <td className="p-2 text-right">{canEdit && <button title="Izmeni" onClick={() => setFormRow(b)} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {formRow && <BookingForm id={id} row={formRow === 'new' ? null : formRow} onClose={() => setFormRow(null)} />}
    </div>
  );
}
const BOOKING_STATUS_KEYS: BookingStatus[] = ['planirana', 'u_toku', 'zavrsena', 'otkazana'];
function isoToLocalInput(iso: unknown): string {
  if (!iso) return '';
  const d = new Date(String(iso));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function BookingForm({ id, row, onClose }: { id: string; row: ViewRow | null; onClose: () => void }) {
  const create = useCreateBooking();
  const update = useUpdateBooking();
  const del = useDeleteBooking();
  const drivers = useDrivers();
  const isEdit = !!row;
  const [driverId, setDriverId] = useState(row ? String(f(row, 'driver_id') ?? '') : '');
  const [start, setStart] = useState(row ? isoToLocalInput(f(row, 'start_at')) : '');
  const [end, setEnd] = useState(row ? isoToLocalInput(f(row, 'end_at')) : '');
  const [purpose, setPurpose] = useState(row ? String(f(row, 'purpose') ?? '') : '');
  const [status, setStatus] = useState<BookingStatus>((row ? (f(row, 'status') as BookingStatus) : 'planirana') ?? 'planirana');
  const [notes, setNotes] = useState(row ? String(f(row, 'notes') ?? '') : '');
  const [err, setErr] = useState<string | null>(null);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  function submit() {
    setErr(null);
    if (!start || !end) return setErr('Datum „Od" i „Do" su obavezni.');
    if (new Date(end) <= new Date(start)) return setErr('Datum „Do" mora biti posle „Od".');
    const body = { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), driverId: driverId || undefined, purpose: purpose.trim() || undefined, status, notes: notes.trim() || undefined };
    if (isEdit) update.mutate({ id, bookingId: String(f(row!, 'booking_id')), patch: body }, { onSuccess: () => { toast('Sačuvano'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    else create.mutate({ id, ...body }, { onSuccess: () => { toast('Rezervacija dodata'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Izmeni rezervaciju' : 'Nova rezervacija'}
      footer={<>{isEdit && <Button variant="danger" className="mr-auto" onClick={() => { if (confirm('Obrisati rezervaciju?')) del.mutate({ id, bookingId: String(f(row!, 'booking_id')) }, { onSuccess: () => { toast('Obrisano'); onClose(); } }); }}>Obriši</Button>}<Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={create.isPending || update.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Vozač"><select value={driverId} onChange={(e) => setDriverId(e.target.value)} className={selCls}><option value="">— bez vozača —</option>{(drivers.data?.data ?? []).map((dr) => <option key={dr.driver_id} value={dr.driver_id}>{dr.full_name}{dr.is_internal === false ? ' (spoljni)' : ''}</option>)}</select></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Od" required><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></FormField>
          <FormField label="Do" required><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></FormField>
        </div>
        <FormField label="Namena"><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="npr. Beograd-Niš servis" /></FormField>
        <FormField label="Status"><select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus)} className={selCls}>{BOOKING_STATUS_KEYS.map((s) => <option key={s} value={s}>{BOOKING_STATUS_LABEL[s]}</option>)}</select></FormField>
        <FormField label="Napomena"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
      </div>
    </Dialog>
  );
}
