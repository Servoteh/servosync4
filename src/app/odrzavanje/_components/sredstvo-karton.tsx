'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, FileWarning, Pencil } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useArchiveAsset,
  useFacility,
  useItAsset,
  useRestoreAsset,
  type AssetCardDetail,
  type MaintMe,
} from '@/api/odrzavanje';
import {
  criticalityTone,
  CRITICALITY_LABEL,
  daysUntil,
  deadlineTone,
  Field,
  FACILITY_TYPES_HIDE_TECH,
  OpStatusBadge,
} from './common';
import { AssetWorkOrders } from './asset-work-orders';
import { AssetServicePlanPanel } from './asset-service-plan';
import { AssetDocuments } from './asset-documents';
import { Tabs } from './tabs';
import { QrCanvas } from './qr-canvas';
import { SredstvoEditModal } from './sredstvo-edit-modal';
import { PrijavaKvaraDialog } from './prijava-kvara-dialog';

type Kind = 'it' | 'facility';
type STab = 'pregled' | 'plan' | 'nalozi' | 'dokumenta';
const STABS: STab[] = ['pregled', 'plan', 'nalozi', 'dokumenta'];

function readTab(): STab {
  if (typeof window === 'undefined') return 'pregled';
  const t = new URLSearchParams(window.location.search).get('tab');
  return t && (STABS as string[]).includes(t) ? (t as STab) : 'pregled';
}

/**
 * Karton IT opreme / objekta kao RUTA (`/odrzavanje/sredstva?id=<uuid>&kind=<it|facility>&tab=`)
 * — konzistentno sa P1 (masina/vozilo karton). 4 taba (Pregled/Plan/Radni nalozi/Dokumenta),
 * header quick-akcije (Prijavi kvar / Uredi / Arhiviraj|Vrati), lokalni QR. Paritet 1.0
 * maintItAssetCardPage.js / maintFacilityCardPage.js.
 */
export function SredstvoKarton({ kind, id, me }: { kind: Kind; id: string; me: MaintMe | undefined }) {
  const router = useRouter();
  const itQ = useItAsset(kind === 'it' ? id : null);
  const facQ = useFacility(kind === 'facility' ? id : null);
  const q = kind === 'it' ? itQ : facQ;
  const d = q.data?.data;
  const archive = useArchiveAsset();
  const restore = useRestoreAsset();
  const [tab, setTabState] = useState<STab>('pregled');
  const [editOpen, setEditOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const canUpload = canManage || me?.maintRole === 'technician' || me?.maintRole === 'operator';

  useEffect(() => { setTabState(readTab()); }, []);
  useEffect(() => {
    const onPop = () => setTabState(readTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function setTab(next: STab) {
    setTabState(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'pregled') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.pushState(null, '', url.toString());
  }

  const qrUrl = typeof window !== 'undefined' && d ? `${window.location.origin}/odrzavanje/sredstva?id=${encodeURIComponent(id)}&kind=${kind}` : '';

  return (
    <div className="space-y-4">
      <button onClick={() => router.push('/odrzavanje')} className="inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Održavanje
      </button>

      {q.isLoading || !d ? (
        <p className="py-10 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-ink">{kind === 'it' ? '💻' : '🏭'} <span className="tnums">{d.assetCode}</span> · {d.name}</h1>
                <OpStatusBadge status={d.status} />
                {d.archivedAt && <StatusBadge tone="neutral" label="Arhivirano" />}
              </div>
              <p className="mt-0.5 text-sm text-ink-secondary">{subtitleOf(kind, d)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!d.archivedAt && <Button variant="secondary" onClick={() => setShowReport(true)}><FileWarning className="h-4 w-4" aria-hidden /> Prijavi kvar</Button>}
              {canManage && !d.archivedAt && <Button onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" aria-hidden /> Uredi</Button>}
              {canManage && !d.archivedAt && <Button variant="danger" onClick={() => { const reason = prompt('Razlog arhiviranja?'); if (reason?.trim()) archive.mutate({ id, reason: reason.trim() }, { onSuccess: () => toast(kind === 'it' ? 'IT oprema arhivirana' : 'Objekat arhiviran') }); }}>Arhiviraj</Button>}
            </div>
          </div>

          {d.archivedAt && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-status-warn" aria-hidden /> {kind === 'it' ? 'IT oprema je ARHIVIRANA' : 'Objekat je ARHIVIRAN'} ({formatDate(d.archivedAt)}){d.archiveReason ? ` — ${d.archiveReason}` : ''}.
              </span>
              {canManage && <Button variant="secondary" onClick={() => restore.mutate({ id }, { onSuccess: () => toast('Vraćeno u upotrebu') })}>Vrati u upotrebu</Button>}
            </div>
          )}

          <Tabs
            tabs={[
              { key: 'pregled', label: 'Pregled' },
              { key: 'plan', label: 'Plan' },
              { key: 'nalozi', label: 'Radni nalozi' },
              { key: 'dokumenta', label: 'Dokumenta' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Karton sredstva"
          />

          {tab === 'pregled' && <Pregled kind={kind} d={d} qrUrl={qrUrl} />}
          {tab === 'plan' && <AssetServicePlanPanel assetId={id} canManage={canManage} />}
          {tab === 'nalozi' && <AssetWorkOrders assetId={id} me={me} title="Radni nalozi sredstva" />}
          {tab === 'dokumenta' && <AssetDocuments assetId={id} canUpload={canUpload} />}

          {editOpen && <SredstvoEditModal kind={kind} assetId={id} onClose={() => setEditOpen(false)} />}
          {showReport && <PrijavaKvaraDialog me={me} fixedAsset={{ code: d.assetCode, name: d.name, assetId: id, assetType: kind }} onClose={() => setShowReport(false)} />}
        </>
      )}
    </div>
  );
}

function subtitleOf(kind: Kind, d: AssetCardDetail): string {
  const det = (d.details ?? {}) as Record<string, unknown>;
  if (kind === 'it') return [det.deviceType, det.hostname].filter(Boolean).map(String).join(' · ') || 'IT oprema';
  const crit = det.criticality ? CRITICALITY_LABEL[String(det.criticality)] ?? String(det.criticality) : '';
  return [det.facilityType, det.floorOrZone, crit && `kritičnost: ${crit}`].filter(Boolean).map(String).join(' · ') || 'Objekat';
}

// ── Pregled ─────────────────────────────────────────────────────────
function Pregled({ kind, d, qrUrl }: { kind: Kind; d: AssetCardDetail; qrUrl: string }) {
  const det = (d.details ?? {}) as Record<string, unknown>;
  const legacyWarranty = (d as unknown as Record<string, unknown>).warrantyUntil ?? null;

  return (
    <div className="space-y-4">
      {kind === 'it' ? <ItFacts det={det} /> : <FacilityFacts det={det} />}

      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-ink">Rokovi i status</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {kind === 'it' ? (
            <>
              <Rok label="🔑 Licenca" date={str(det.licenseExpiresAt)} />
              <Rok label="🛡 Garancija" date={str(det.warrantyExpiresAt) ?? str(legacyWarranty)} />
              <BackupCard required={det.backupRequired === true} lastBackup={str(det.lastBackupAt)} />
            </>
          ) : (
            <>
              <Rok label="🔍 Inspekcija" date={str(det.inspectionDueAt)} />
              <Rok label="🧯 PP zaštita" date={str(det.fireSafetyDueAt)} />
              <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm">
                <span className="text-ink-secondary">Kritičnost</span>
                {det.criticality ? <StatusBadge tone={criticalityTone(String(det.criticality))} label={CRITICALITY_LABEL[String(det.criticality)] ?? String(det.criticality)} /> : <span className="text-ink-disabled">—</span>}
              </div>
            </>
          )}
        </div>
        {kind === 'facility' && (
          <p className="mt-2 text-2xs text-ink-secondary">Poslednja inspekcija (auto): {str(det.lastInspectionAt) ? formatDate(str(det.lastInspectionAt)!) : '— još nije zabeleženo'}. Postavlja se kad se zatvori WO „Inspekcija".</p>
        )}
      </div>

      {str(det.notes) || str(d.notes) ? (
        <div className="rounded-panel border border-line p-3">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Napomene</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{str(det.notes) ?? str(d.notes)}</p>
        </div>
      ) : null}

      <TehnickiBlok kind={kind} d={d} det={det} />

      {qrUrl && (
        <div className="flex items-center gap-3 rounded-panel border border-line p-3">
          <QrCanvas url={qrUrl} />
          <div className="text-sm text-ink-secondary">
            <div className="font-medium text-ink">QR kartica</div>
            <p className="mt-0.5 text-xs">Skeniranje otvara ovaj karton. Renderuje se lokalno — ne šalje se van mreže.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ItFacts({ det }: { det: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3 sm:grid-cols-3">
      <Field label="Tip uređaja">{str(det.deviceType) ?? '—'}</Field>
      <Field label="Zadužen">{str(det.assignedTo) ?? '—'}</Field>
      <Field label="Hostname">{str(det.hostname) ?? '—'}</Field>
      <Field label="IP adresa">{str(det.ipAddress) ?? '—'}</Field>
      <Field label="MAC">{str(det.macAddress) ?? '—'}</Field>
      <Field label="OS">{str(det.operatingSystem) ?? '—'}</Field>
    </div>
  );
}
function FacilityFacts({ det }: { det: Record<string, unknown> }) {
  const area = det.floorAreaM2 != null && det.floorAreaM2 !== '' ? `${Number(det.floorAreaM2).toLocaleString('sr-RS')} m²` : '—';
  return (
    <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3 sm:grid-cols-3">
      <Field label="Tip">{str(det.facilityType) ?? '—'}</Field>
      <Field label="Zona / sprat">{str(det.floorOrZone) ?? '—'}</Field>
      <Field label="Površina">{area}</Field>
      <Field label="Serviser">{str(det.serviceProvider) ?? '—'}</Field>
      <Field label="Katastarske parcele">{str(det.cadastralParcels) ?? '—'}</Field>
    </div>
  );
}

function TehnickiBlok({ kind, d, det }: { kind: Kind; d: AssetCardDetail; det: Record<string, unknown> }) {
  if (kind === 'facility' && FACILITY_TYPES_HIDE_TECH.has(String(det.facilityType ?? ''))) return null;
  const rows: [string, string | null][] = [
    ['Proizvođač', d.manufacturer],
    ['Model', d.model],
    ['Serijski broj', d.serialNumber],
    ['Dobavljač', d.supplier],
  ].filter(([, v]) => v != null && v !== '') as [string, string][];
  if (rows.length === 0) return null;
  return (
    <details className="rounded-panel border border-line p-3">
      <summary className="cursor-pointer text-sm font-semibold text-ink">Tehnički podaci ({rows.length})</summary>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {rows.map(([k, v]) => <Field key={k} label={k}>{v}</Field>)}
      </div>
    </details>
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
/** Backup „stale" prag: pažnja ako nema last_backup ILI stariji od 7 dana (skriveno pravilo). */
function BackupCard({ required, lastBackup }: { required: boolean; lastBackup: string | null }) {
  if (!required) {
    return (
      <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm">
        <span className="text-ink-secondary">💽 Backup</span><span className="text-ink-disabled">nije obavezan</span>
      </div>
    );
  }
  const days = lastBackup ? daysUntil(lastBackup) : null;
  let tone: Tone = 'success';
  let label = '—';
  if (!lastBackup) { tone = 'danger'; label = 'nema backup'; }
  else if (days != null) { label = days < 0 ? `pre ${-days} d` : days === 0 ? 'danas' : `za ${days} d`; tone = days < -7 ? 'warn' : 'success'; }
  return (
    <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm">
      <span className="text-ink-secondary">💽 Backup</span><StatusBadge tone={tone} label={label} />
    </div>
  );
}

function str(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}
