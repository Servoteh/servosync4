'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ChevronRight, ScanLine, Search, Wrench } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useAssets,
  useFacility,
  useIncidents,
  useItAsset,
  useMachine,
  useMaintMe,
  useVehicle,
  type AssetPickerRow,
  type AssetType,
} from '@/api/odrzavanje';
import {
  IncidentStatusBadge,
  OpStatusBadge,
  SeverityBadge,
  daysUntil,
  f,
} from '../../odrzavanje/_components/common';
import { PrijavaKvaraDialog } from '../../odrzavanje/_components/prijava-kvara-dialog';
import { MaintScanOverlay } from './maint-scan-overlay';
import { formatDate } from '@/lib/format';

/**
 * Mobilno Održavanje (/m/odrzavanje) — pun paritet 1.0 myMaintenance.js:
 * hub (4 kategorije sa brojačima + globalna pretraga + QR sken) → lista po kategoriji →
 * karton SVIH tipova sredstava (mašina/vozilo/IT/objekat) → otvoreni kvarovi → Prijava
 * kvara (+foto). Sredstva iz GET /maintenance/assets su jedinstveni izvor (asset_code +
 * asset_id + asset_type) za listu/pretragu/sken; karton dovlači tip-specifičan detalj.
 */

const CATEGORIES: { type: AssetType; ico: string; label: string }[] = [
  { type: 'machine', ico: '⚙️', label: 'Mašine' },
  { type: 'vehicle', ico: '🚗', label: 'Vozila' },
  { type: 'facility', ico: '🏢', label: 'Objekti' },
  { type: 'it', ico: '💻', label: 'IT oprema' },
];
const ASSET_ICO: Record<string, string> = { machine: '⚙️', vehicle: '🚗', it: '💻', facility: '🏢' };

type View = 'hub' | 'list' | 'karton';
type ReportTarget = { asset?: AssetPickerRow } | null;

export default function MobileOdrzavanjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const me = useMaintMe();
  const [view, setView] = useState<View>('hub');
  const [cat, setCat] = useState<AssetType | null>(null);
  const [q, setQ] = useState('');
  const [asset, setAsset] = useState<AssetPickerRow | null>(null);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ReportTarget>(null);

  const assetsQ = useAssets(undefined, true);
  const assets = useMemo(() => assetsQ.data?.data ?? [], [assetsQ.data]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  function openAsset(a: AssetPickerRow) {
    setAsset(a);
    setView('karton');
  }

  // Skenirani kod (bare ili URL nalepnice) → poslednji segment putanje → uparivanje
  // po asset_code (case-insensitive). Pogodak otvara karton; promašaj puni pretragu.
  function handleScanned(code: string) {
    const raw = code.trim();
    let tail = raw;
    if (raw.includes('/')) {
      const segs = raw.split(/[/?#]/).filter(Boolean);
      if (segs.length) {
        try { tail = decodeURIComponent(segs[segs.length - 1]); } catch { tail = segs[segs.length - 1]; }
      }
    }
    const cands = [raw.toLowerCase(), tail.toLowerCase()];
    const hit = assets.find((a) => cands.includes(String(a.assetCode || '').toLowerCase().trim()));
    if (hit) {
      openAsset(hit);
    } else {
      setQ(tail);
      setCat(null);
      setView('hub');
    }
  }

  const headerTitle =
    view === 'karton'
      ? asset?.name || asset?.assetCode || 'Sredstvo'
      : view === 'list'
        ? CATEGORIES.find((c) => c.type === cat)?.label ?? 'Sredstva'
        : 'Održavanje';

  function back() {
    if (view === 'karton') {
      setAsset(null);
      setView(cat ? 'list' : 'hub');
    } else if (view === 'list') {
      setCat(null);
      setQ('');
      setView('hub');
    }
  }

  return (
    <main className="min-h-screen bg-app pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
        {view !== 'hub' ? (
          <button onClick={back} aria-label="Nazad" className="text-ink-secondary">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : (
          <Wrench className="h-5 w-5 text-accent" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">{headerTitle}</h1>
          {view === 'hub' && <p className="text-2xs text-ink-secondary">Mašine · vozila · objekti · IT</p>}
        </div>
      </header>

      {view === 'hub' && (
        <Hub
          assets={assets}
          loading={assetsQ.isLoading}
          error={assetsQ.isError}
          q={q}
          setQ={setQ}
          onScan={() => setScanning(true)}
          onCat={(c) => { setCat(c); setQ(''); setView('list'); }}
          onOpen={openAsset}
        />
      )}
      {view === 'list' && cat && (
        <CatList assets={assets} loading={assetsQ.isLoading} cat={cat} q={q} setQ={setQ} onOpen={openAsset} />
      )}
      {view === 'karton' && asset && (
        <Karton asset={asset} onReport={() => setReport({ asset })} />
      )}

      {scanning && (
        <MaintScanOverlay onCode={handleScanned} onClose={() => setScanning(false)} />
      )}

      {report && (
        <PrijavaKvaraDialog
          onClose={() => setReport(null)}
          me={me.data?.data}
          fixedMachine={report.asset && report.asset.assetType === 'machine' ? { code: report.asset.assetCode, name: report.asset.name } : undefined}
          fixedAsset={report.asset && report.asset.assetType !== 'machine' ? { code: report.asset.assetCode, name: report.asset.name, assetId: report.asset.assetId, assetType: report.asset.assetType } : undefined}
        />
      )}

      {!scanning && !report && (
        <button
          onClick={() => setReport({})}
          className="fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-status-danger px-5 py-3 text-sm font-semibold text-white shadow-lg"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden /> Prijavi kvar
        </button>
      )}
    </main>
  );
}

/* ── Hub: pretraga + sken + 4 kategorije sa brojačima ── */

function Hub({
  assets,
  loading,
  error,
  q,
  setQ,
  onScan,
  onCat,
  onOpen,
}: {
  assets: AssetPickerRow[];
  loading: boolean;
  error: boolean;
  q: string;
  setQ: (v: string) => void;
  onScan: () => void;
  onCat: (c: AssetType) => void;
  onOpen: (a: AssetPickerRow) => void;
}) {
  const term = q.trim().toLowerCase();
  const results = useMemo(
    () => (term ? assets.filter((a) => `${a.assetCode} ${a.name}`.toLowerCase().includes(term)) : []),
    [assets, term],
  );
  const countOf = (t: AssetType) => assets.filter((a) => a.assetType === t).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2">
        <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nađi sredstvo (šifra ili naziv)…"
          className="w-full bg-transparent text-sm text-ink focus:outline-none"
          aria-label="Pretraži sva sredstva po šifri ili nazivu"
        />
      </div>

      <button
        onClick={onScan}
        className="flex w-full items-center justify-center gap-2 rounded-panel border border-accent/40 bg-accent-subtle px-4 py-3 text-sm font-semibold text-accent"
      >
        <ScanLine className="h-5 w-5" aria-hidden /> Skeniraj QR sredstva
      </button>

      {error && (
        <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          Sredstva se nisu učitala (mreža/dozvola). Brojevi možda nisu tačni — pokušaj ponovo.
        </p>
      )}

      {term ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-ink">Rezultati ({results.length})</h2>
          {results.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-secondary">Nema rezultata za „{q}".</p>
          ) : (
            <div className="space-y-2">
              {results.slice(0, 80).map((a) => (
                <AssetRow key={a.assetId} a={a} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {CATEGORIES.map((c) => (
            <button
              key={c.type}
              onClick={() => onCat(c.type)}
              className="flex flex-col items-center gap-1 rounded-panel border border-line bg-surface px-4 py-6"
            >
              <span className="text-3xl" aria-hidden>{c.ico}</span>
              <span className="text-sm font-medium text-ink">{c.label}</span>
              <span className="text-xs text-ink-secondary">{loading ? '…' : `${countOf(c.type)} kom`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Lista po kategoriji ── */

function CatList({
  assets,
  loading,
  cat,
  q,
  setQ,
  onOpen,
}: {
  assets: AssetPickerRow[];
  loading: boolean;
  cat: AssetType;
  q: string;
  setQ: (v: string) => void;
  onOpen: (a: AssetPickerRow) => void;
}) {
  const term = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const base = assets.filter((a) => a.assetType === cat);
    return term ? base.filter((a) => `${a.assetCode} ${a.name}`.toLowerCase().includes(term)) : base;
  }, [assets, cat, term]);

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2">
        <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Pretraga u kategoriji…"
          className="w-full bg-transparent text-sm text-ink focus:outline-none"
          aria-label="Pretraži sredstva u kategoriji"
        />
      </div>
      <h2 className="text-sm font-semibold text-ink">{CATEGORIES.find((c) => c.type === cat)?.label} ({rows.length})</h2>
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema sredstava u ovoj kategoriji.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <AssetRow key={a.assetId} a={a} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetRow({ a, onOpen }: { a: AssetPickerRow; onOpen: (a: AssetPickerRow) => void }) {
  return (
    <button
      onClick={() => onOpen(a)}
      className="flex w-full items-center justify-between gap-2 rounded-panel border border-line bg-surface px-3 py-3 text-left"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-lg" aria-hidden>{ASSET_ICO[a.assetType] || '🔧'}</span>
        <div className="min-w-0">
          <div className="tnums text-xs text-ink-secondary">{a.assetCode}</div>
          <div className="truncate text-sm font-medium text-ink">{a.name}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <OpStatusBadge status={a.status} />
        <ChevronRight className="h-4 w-4 text-ink-disabled" aria-hidden />
      </div>
    </button>
  );
}

/* ── Karton sredstva (tip-specifičan detalj + otvoreni kvarovi + prijava) ── */

function Karton({ asset, onReport }: { asset: AssetPickerRow; onReport: () => void }) {
  const machine = useMachine(asset.assetType === 'machine' ? asset.assetCode : null);
  const vehicle = useVehicle(asset.assetType === 'vehicle' ? asset.assetId : null);
  const itAsset = useItAsset(asset.assetType === 'it' ? asset.assetId : null);
  const facility = useFacility(asset.assetType === 'facility' ? asset.assetId : null);
  const inc = useIncidents({ machineCode: asset.assetCode, pageSize: 30 });
  const open = useMemo(
    () => (inc.data?.data ?? []).filter((i) => i.status !== 'closed' && i.status !== 'resolved'),
    [inc.data],
  );

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-panel border border-line bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-lg font-semibold text-ink">
            {ASSET_ICO[asset.assetType] || '🔧'} {asset.assetCode}
          </span>
          <OpStatusBadge status={asset.status} />
        </div>
        {asset.name && <div className="mt-0.5 text-sm text-ink-secondary">{asset.name}</div>}

        {asset.assetType === 'machine' && <MachineDetail q={machine} />}
        {asset.assetType === 'vehicle' && <VehicleDetail q={vehicle} />}
        {asset.assetType === 'it' && <AssetDetailBlock q={itAsset} fields={IT_FIELDS} />}
        {asset.assetType === 'facility' && <AssetDetailBlock q={facility} fields={FACILITY_FIELDS} />}
      </div>

      <button
        onClick={onReport}
        className="flex w-full items-center justify-center gap-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm font-semibold text-status-danger"
      >
        <AlertTriangle className="h-4 w-4" aria-hidden /> Prijavi kvar za ovo sredstvo
      </button>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">
          Otvoreni kvarovi {inc.isError ? '' : `(${open.length})`}
        </h2>
        {inc.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : inc.isError ? (
          <p className="text-sm text-status-danger">Kvarovi se nisu učitali — vrati se i pokušaj ponovo.</p>
        ) : open.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema otvorenih kvarova. 👍</p>
        ) : (
          <div className="space-y-2">
            {open.map((i) => (
              <div key={i.id} className="rounded-panel border border-line bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink">{i.title}</span>
                  <SeverityBadge severity={i.severity} />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <IncidentStatusBadge status={i.status} />
                  {i.safetyMarker && <span className="text-2xs text-status-danger">⚠ bezbednost</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Detalj-blokovi po tipu ── */

function DetailWrap({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  if (loading) return <p className="mt-2 text-xs text-ink-secondary">Učitavam detalje…</p>;
  return <div className="mt-3 space-y-0.5 border-t border-line pt-3">{children}</div>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <span className="shrink-0 text-ink-secondary">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}

function RokRow({ label, iso }: { label: string; iso: unknown }) {
  if (!iso) return null;
  const s = String(iso).slice(0, 10);
  const days = daysUntil(s);
  const cls = days === null ? 'text-ink' : days < 0 ? 'text-status-danger' : days <= 30 ? 'text-status-warn' : 'text-ink';
  const suffix = days === null ? '' : days < 0 ? ' · isteklo' : days <= 30 ? ' · uskoro' : '';
  return <Row label={label} value={<span className={cls}>{formatDate(s)}{suffix}</span>} />;
}

function MachineDetail({ q }: { q: ReturnType<typeof useMachine> }) {
  const m = q.data?.data;
  return (
    <DetailWrap loading={q.isLoading}>
      {m ? (
        <>
          <Row label="Proizvođač" value={[m.manufacturer, m.model].filter(Boolean).join(' ') || null} />
          <Row label="Serijski" value={m.serialNumber} />
          <Row label="Lokacija" value={m.location} />
          <Row label="God. puštanja" value={m.yearCommissioned} />
          <Row label="Snaga" value={m.powerKw != null ? `${m.powerKw} kW` : null} />
          {m.notes && <div className="pt-1 text-xs text-ink-secondary">📝 {m.notes}</div>}
        </>
      ) : (
        <p className="text-xs text-ink-secondary">Nema tehničkih detalja.</p>
      )}
    </DetailWrap>
  );
}

function VehicleDetail({ q }: { q: ReturnType<typeof useVehicle> }) {
  const v = q.data?.data;
  const d = v?.details ?? null;
  const km = d?.odometerKm != null ? `${Number(d.odometerKm).toLocaleString('sr-RS')} km` : null;
  const driver = d ? f(d as Record<string, unknown>, 'primary_driver_name', 'driver_full_name', 'driverName') : null;
  return (
    <DetailWrap loading={q.isLoading}>
      {v ? (
        <>
          <Row label="Tablice" value={d?.registrationPlate} />
          <Row label="VIN" value={d?.vin} />
          <Row label="Vozač" value={driver} />
          <Row label="Kilometraža" value={km} />
          <RokRow label="Registracija do" iso={d?.registrationExpiresAt} />
          <RokRow label="Osiguranje do" iso={d?.insuranceExpiresAt} />
          <RokRow label="Prva pomoć do" iso={d?.firstAidKitExpiresAt} />
          <RokRow label="Servis dospeva" iso={d?.serviceDueAt} />
        </>
      ) : (
        <p className="text-xs text-ink-secondary">Nema detalja vozila.</p>
      )}
    </DetailWrap>
  );
}

/** Kandidat-polja za IT/objekat detalj (snake_case view-kolone; f() preskače nepostojeće). */
type DetailField = { label: string; keys: string[]; date?: boolean };
const IT_FIELDS: DetailField[] = [
  { label: 'Proizvođač', keys: ['manufacturer'] },
  { label: 'Model', keys: ['model'] },
  { label: 'Serijski', keys: ['serial_number', 'serialNumber'] },
  { label: 'Tip uređaja', keys: ['device_type'] },
  { label: 'Hostname / IP', keys: ['hostname', 'ip_address'] },
  { label: 'OS', keys: ['os', 'os_version'] },
  { label: 'Zadužen', keys: ['assigned_user_name', 'assigned_to_name'] },
  { label: 'Garancija do', keys: ['warranty_until', 'warranty_expires_at'], date: true },
  { label: 'Licenca do', keys: ['license_expires_at', 'license_expiry'], date: true },
  { label: 'Poslednji backup', keys: ['last_backup_at'], date: true },
];
const FACILITY_FIELDS: DetailField[] = [
  { label: 'Tip objekta', keys: ['facility_type'] },
  { label: 'Površina', keys: ['area_m2'] },
  { label: 'Odgovorno lice', keys: ['responsible_name'] },
  { label: 'Inspekcija (poslednja)', keys: ['last_inspection_at'], date: true },
  { label: 'Inspekcija dospeva', keys: ['next_inspection_at', 'inspection_due_at'], date: true },
];

function AssetDetailBlock({ q, fields }: { q: ReturnType<typeof useItAsset>; fields: DetailField[] }) {
  const a = q.data?.data;
  const details = (a?.details ?? {}) as Record<string, unknown>;
  const core = a as Record<string, unknown> | undefined;
  const get = (keys: string[]) => f(details, ...keys) ?? (core ? f(core, ...keys) : null);
  const anyShown = fields.some((fl) => get(fl.keys) !== null) || !!a?.notes;
  return (
    <DetailWrap loading={q.isLoading}>
      {a ? (
        <>
          {fields.map((fl) => {
            const val = get(fl.keys);
            if (val === null) return null;
            return fl.date ? <RokRow key={fl.label} label={fl.label} iso={val} /> : <Row key={fl.label} label={fl.label} value={val} />;
          })}
          {a.notes && <div className="pt-1 text-xs text-ink-secondary">📝 {a.notes}</div>}
          {!anyShown && <p className="text-xs text-ink-secondary">Nema dodatnih detalja.</p>}
        </>
      ) : (
        <p className="text-xs text-ink-secondary">Nema detalja sredstva.</p>
      )}
    </DetailWrap>
  );
}
