'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import {
  useBoard,
  useCalendar,
  useDashboard,
  useReportAttention,
  useVehiclesDue,
  useWorkOrders,
  type MaintMe,
  type ViewRow,
} from '@/api/odrzavanje';
import {
  ASSET_TYPE_LABEL,
  CategoryTile,
  type DashNavTab,
  f,
  fnum,
  KpiButton,
  type MachineListFilter,
  machinePriorityRank,
  OpStatusBadge,
  relDays,
  WO_STATUS_LABEL,
} from './common';
import { PrijavaKvaraDialog } from './prijava-kvara-dialog';

type Nav = (tab: DashNavTab, filter?: MachineListFilter) => void;

/**
 * Pregled (dashboard) — paritet 1.0 index.js:1399-1846: „Prijavi kvar" CTA, 4 kategorije-tile
 * (sa „zahtevaju pažnju"), unified deadlines (≤30d), 8 klik-KPI + 5 snapshot KPI, i 4 mini-liste
 * (Zahtevaju pažnju / aktivni WO / preventiva due / zastoji). KPI/tile navigiraju na tab uz
 * preset filtera operativne liste (?status/?deadline/?inc paritet).
 */
export function PregledTab({
  onOpenMachine,
  onNavigate,
  me,
  canReport,
}: {
  onOpenMachine: (code: string) => void;
  onNavigate: Nav;
  me: MaintMe | undefined;
  canReport: boolean;
}) {
  const dash = useDashboard();
  const board = useBoard();
  const cal = useCalendar();
  const woQ = useWorkOrders({ pageSize: 200 });
  const attn = useReportAttention();
  const vehDue = useVehiclesDue();
  const [reporting, setReporting] = useState(false);

  const d = dash.data?.data;
  const ms = (d?.machineStatus ?? []) as ViewRow[];
  const summary = d?.dailySummary ?? null;

  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of board.data?.data.machineNames ?? []) m.set(n.machineCode, n.name);
    return m;
  }, [board.data]);

  // ── KPI iz statusa mašina ──────────────────────────────────────────
  const st = (r: ViewRow) => f(r, 'status');
  const nDown = ms.filter((r) => st(r) === 'down').length;
  const nDegraded = ms.filter((r) => st(r) === 'degraded').length;
  const nRunning = ms.filter((r) => st(r) === 'running').length;
  const nOpenInc = ms.filter((r) => (fnum(r, 'open_incidents_count') ?? 0) > 0).length;
  const nLate = ms.filter((r) => (fnum(r, 'overdue_checks_count') ?? 0) > 0).length;
  const nToday = useMemo(() => {
    const s = new Set<string>();
    for (const t of board.data?.data.today ?? []) s.add(t.machine_code);
    return board.isLoading ? null : s.size;
  }, [board.data, board.isLoading]);

  const woRows = woQ.data?.data ?? [];
  const nSafetyWo = woRows.filter((w) => w.safetyMarker).length;
  const openWo = d?.openWorkOrders ?? null;

  const snap = (key: string): number | null => (summary ? (fnum(summary as ViewRow, key) ?? 0) : null);

  // ── Kategorije ─────────────────────────────────────────────────────
  const catCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of d?.categoryCounts ?? []) m[c.asset_type] = c.n;
    return m;
  }, [d]);
  const machinesAttention = ms.length ? ms.filter((r) => st(r) !== 'running').length : null;
  const vehAttention = vehDue.data ? vehDue.data.data.length : null;
  const itAttention = attn.data ? attn.data.data.itAssets.length : null;
  const facAttention = attn.data ? attn.data.data.facilities.length : null;

  // ── Zahtevaju pažnju / zastoji (iz statusa) ────────────────────────
  const attention = useMemo(() => {
    return ms
      .filter((r) => st(r) !== 'running' || (fnum(r, 'open_incidents_count') ?? 0) > 0 || (fnum(r, 'overdue_checks_count') ?? 0) > 0)
      .map((r) => ({
        code: f(r, 'machine_code') ?? '',
        status: st(r),
        inc: fnum(r, 'open_incidents_count') ?? 0,
        overdue: fnum(r, 'overdue_checks_count') ?? 0,
        override: f(r, 'override_reason'),
      }))
      .sort((a, b) => machinePriorityRank({ status: a.status, openInc: a.inc, overdue: a.overdue, nextDueAt: null, archived: false }) - machinePriorityRank({ status: b.status, openInc: b.inc, overdue: b.overdue, nextDueAt: null, archived: false }))
      .slice(0, 12);
  }, [ms]);
  const downList = ms
    .filter((r) => ['down', 'degraded', 'maintenance'].includes(st(r) ?? ''))
    .slice(0, 8);

  const dueList = [...(board.data?.data.overdue ?? []), ...(board.data?.data.today ?? [])].slice(0, 8);
  const unified = useUnifiedDeadlines(cal.data?.data);

  return (
    <div className="space-y-5">
      {/* Prijavi kvar CTA */}
      {canReport && (
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-status-danger/30 bg-status-danger-bg/40 px-4 py-3">
          <Button variant="danger" onClick={() => setReporting(true)}>🔴 Prijavi kvar</Button>
          <span className="text-sm text-ink-secondary">Prijavi kvar na mašini, vozilu, objektu ili IT opremi.</span>
        </div>
      )}

      {/* 4 kategorije */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CategoryTile icon="🛠" label="Mašine" total={catCount.machine ?? null} attention={machinesAttention} onClick={() => onNavigate('masine')} />
        <CategoryTile icon="🚚" label="Vozila" total={catCount.vehicle ?? null} attention={vehAttention} onClick={() => onNavigate('vozila')} />
        <CategoryTile icon="🏭" label="Objekti" total={catCount.facility ?? null} attention={facAttention} onClick={() => onNavigate('objekti')} />
        <CategoryTile icon="💻" label="IT oprema" total={catCount.it ?? null} attention={itAttention} onClick={() => onNavigate('it')} />
      </div>

      {/* Unified deadlines ≤30d */}
      {unified.length > 0 && (
        <section className="rounded-panel border border-line bg-surface p-3">
          <h3 className="mb-2 text-sm font-semibold text-ink">Rokovi (narednih 30 dana)</h3>
          <ul className="space-y-1">
            {unified.slice(0, 15).map((u, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">{u.typeLabel}</span>
                <span className="text-ink">{u.name}</span>
                <span className="text-ink-secondary">· {u.what}</span>
                <span className={`ml-auto text-2xs ${u.days < 0 ? 'text-status-danger' : u.days <= 7 ? 'text-status-warn' : 'text-ink-secondary'}`}>{relDays(u.iso)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 8 operativni KPI */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Mašine — operativni pokazatelji</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiButton label="Otvoreni kvarovi" value={nOpenInc} tone="danger" title="Mašine sa otvorenim kvarovima" onClick={() => onNavigate('masine', { inc: true })} />
          <KpiButton label="U zastoju" value={nDown} tone="danger" title="Mašine trenutno u zastoju" onClick={() => onNavigate('masine', { status: 'down' })} />
          <KpiButton label="Kasni rokovi" value={nLate} tone="warn" title="Mašine sa prekoračenim preventivnim rokovima" onClick={() => onNavigate('masine', { deadline: 'overdue' })} />
          <KpiButton label="Rokovi danas" value={nToday} tone="info" title="Mašine kojima preventiva pada danas" onClick={() => onNavigate('masine', { deadline: 'danas' })} />
          <KpiButton label="Aktivni WO" value={openWo} tone="warn" title="Radni nalozi koji nisu završeni ni otkazani" onClick={() => onNavigate('nalozi')} />
          <KpiButton label="Safety WO" value={nSafetyWo} tone="danger" title="Otvoreni radni nalozi sa bezbednosnim markerom" onClick={() => onNavigate('nalozi')} />
          <KpiButton label="Radi normalno" value={nRunning} tone="success" title="Mašine bez zastoja" onClick={() => onNavigate('masine', { status: 'running' })} />
          <KpiButton label="Smetnje" value={nDegraded} tone="warn" title="Mašine koje rade otežano" onClick={() => onNavigate('masine', { status: 'degraded' })} />
        </div>
      </div>

      {/* 5 snapshot KPI */}
      <div>
        <p className="mb-2 text-xs text-ink-secondary">Dnevni CMMS pregled (prioriteti WO, kasni rokovi, incidenti, zalihe) — iz baze kada je dostupan.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiButton label="WO P1 (zastoj)" value={snap('open_wo_p1')} tone="danger" onClick={() => onNavigate('nalozi')} />
          <KpiButton label="WO P2 (smetnja)" value={snap('open_wo_p2')} tone="warn" onClick={() => onNavigate('nalozi')} />
          <KpiButton label="Kasni WO" value={snap('overdue_work_orders')} tone="warn" onClick={() => onNavigate('nalozi')} />
          <KpiButton label="Kritični kvarovi" value={snap('open_critical_incidents')} tone="danger" onClick={() => onNavigate('izvestaji')} />
          <KpiButton label="Ispod min. zalihe" value={snap('parts_below_min_stock')} tone="warn" onClick={() => onNavigate('zalihe')} />
        </div>
      </div>

      {/* 4 mini-liste */}
      <div className="grid gap-4 lg:grid-cols-2">
        <MiniCard title="Zahtevaju pažnju" empty="Sve mašine rade normalno." isEmpty={attention.length === 0}>
          {attention.map((a) => {
            const problems = [
              a.inc > 0 ? `${a.inc} ${a.inc === 1 ? 'otvoreni kvar' : 'otvorena kvara'}` : null,
              a.overdue > 0 ? `${a.overdue} kasni rok${a.overdue === 1 ? '' : 'a'}` : null,
            ].filter(Boolean).join(' · ') || '—';
            return (
              <li key={a.code} className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" onClick={() => onOpenMachine(a.code)} className="font-medium text-accent hover:underline">{nameByCode.get(a.code) ?? a.code}</button>
                <OpStatusBadge status={a.status} />
                {a.override && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">PAUZA</span>}
                <span className="ml-auto text-2xs text-ink-secondary">{problems}</span>
              </li>
            );
          })}
        </MiniCard>

        <MiniCard title="Aktivni radni nalozi" empty="Nema aktivnih radnih naloga." isEmpty={woRows.length === 0} onMore={() => onNavigate('nalozi')} moreLabel="Svi WO →">
          {woRows.slice(0, 8).map((w) => {
            const asset = (w as unknown as { asset?: { assetCode?: string } }).asset;
            return (
              <li key={w.woId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="tnums font-medium text-ink">{w.woNumber ?? 'WO'}</span>
                <span className="text-ink-secondary">{w.title}</span>
                <span className="ml-auto text-2xs text-ink-secondary">{asset?.assetCode ? `${asset.assetCode} · ` : ''}{WO_STATUS_LABEL[w.status] ?? w.status}</span>
              </li>
            );
          })}
        </MiniCard>

        <MiniCard title="Preventiva: kasni / danas" empty="Nema rokova za akciju." isEmpty={dueList.length === 0} onMore={() => onNavigate('preventiva')} moreLabel="Preventiva →">
          {dueList.map((dd) => (
            <li key={dd.task_id} className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" onClick={() => onOpenMachine(dd.machine_code)} className="font-medium text-accent hover:underline">{nameByCode.get(dd.machine_code) ?? dd.machine_code}</button>
              <span className="text-ink-secondary">{dd.title}</span>
              <span className="ml-auto text-2xs text-ink-secondary">{relDays(dd.next_due_at)}</span>
            </li>
          ))}
        </MiniCard>

        <MiniCard title="Zastoji i smetnje" empty="Nema zastoja ni smetnji." isEmpty={downList.length === 0} onMore={() => onNavigate('masine', { status: 'down' })} moreLabel="Lista →">
          {downList.map((r) => {
            const code = f(r, 'machine_code') ?? '';
            return (
              <li key={code} className="flex flex-wrap items-center gap-2 text-sm">
                <button type="button" onClick={() => onOpenMachine(code)} className="font-medium text-accent hover:underline">{nameByCode.get(code) ?? code}</button>
                <OpStatusBadge status={st(r)} />
                <span className="ml-auto text-2xs text-ink-secondary">{f(r, 'override_reason') ?? '—'}</span>
              </li>
            );
          })}
        </MiniCard>
      </div>

      {reporting && <PrijavaKvaraDialog me={me} onClose={() => setReporting(false)} />}
    </div>
  );
}

function MiniCard({
  title,
  children,
  isEmpty,
  empty,
  onMore,
  moreLabel,
}: {
  title: string;
  children: React.ReactNode;
  isEmpty: boolean;
  empty: string;
  onMore?: () => void;
  moreLabel?: string;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {onMore && <button type="button" onClick={onMore} className="text-2xs text-accent hover:underline">{moreLabel}</button>}
      </div>
      {isEmpty ? (
        <div className="flex items-center gap-2 py-3 text-sm text-ink-secondary">
          <AlertTriangle className="h-4 w-4 text-ink-disabled" aria-hidden /> {empty}
        </div>
      ) : (
        <ul className="space-y-1.5">{children}</ul>
      )}
    </section>
  );
}

// ── Unified deadlines (≤30d) iz kalendara rokova ────────────────────
interface UnifiedItem { name: string; typeLabel: string; what: string; iso: string; days: number }
const DATE_KEYS = [
  'next_due_at', 'service_due_at', 'registration_expires_at', 'insurance_expires_at',
  'first_aid_kit_expires_at', 'license_valid_until', 'inspection_due_at', 'fire_safety_due_at',
  'valid_until', 'due_at', 'next_service_at',
];
function earliest(row: ViewRow): { iso: string; key: string } | null {
  let best: { iso: string; key: string } | null = null;
  for (const k of DATE_KEYS) {
    const v = f(row, k);
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (!best || t < new Date(best.iso).getTime()) best = { iso: v, key: k };
  }
  return best;
}
const KEY_LABEL: Record<string, string> = {
  registration_expires_at: 'Registracija', insurance_expires_at: 'Osiguranje',
  first_aid_kit_expires_at: 'Prva pomoć', license_valid_until: 'Licenca',
  inspection_due_at: 'Inspekcija', fire_safety_due_at: 'Protivpožarno',
  service_due_at: 'Servis', next_service_at: 'Servis', next_due_at: 'Preventiva',
  valid_until: 'Rok', due_at: 'Rok',
};
function useUnifiedDeadlines(cal: { vehicleServiceDue: ViewRow[]; assetServiceDue: ViewRow[]; itAssets: ViewRow[]; facilities: ViewRow[] } | undefined): UnifiedItem[] {
  return useMemo(() => {
    if (!cal) return [];
    const buckets: [ViewRow[], string][] = [
      [cal.vehicleServiceDue, ASSET_TYPE_LABEL.vehicle],
      [cal.assetServiceDue, 'Sredstvo'],
      [cal.itAssets, ASSET_TYPE_LABEL.it],
      [cal.facilities, ASSET_TYPE_LABEL.facility],
    ];
    const out: UnifiedItem[] = [];
    for (const [rows, typeLabel] of buckets) {
      for (const r of rows ?? []) {
        const e = earliest(r);
        if (!e) continue;
        const days = Math.round((new Date(e.iso).getTime() - Date.now()) / 86_400_000);
        if (days > 30) continue;
        out.push({
          name: f(r, 'name', 'asset_code', 'machine_code', 'registration_plate') ?? '—',
          typeLabel,
          what: KEY_LABEL[e.key] ?? 'Rok',
          iso: e.iso,
          days,
        });
      }
    }
    return out.sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
  }, [cal]);
}
