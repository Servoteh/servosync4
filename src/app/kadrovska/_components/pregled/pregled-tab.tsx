'use client';

import { useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useKadrDashboard, type DashboardActionItem } from '@/api/kadrovska';

/**
 * Kadrovska → Pregled (dashboard). Paritet 1.0 `dashboardTab.js`:
 *   • KPI strip (6 kartica: aktivni, na odsustvu, GO/nadoknada/plaćeno zahtevi, grid %)
 *   • Action-stack „Šta čeka mene" (isteci/rođendani/zahtevi) sa rok-pilulom i deep-link-om
 *   • Mini izveštaji (zaposleni po odeljenju, sati po danu, odsustva po tipu)
 * Podaci: POSTOJEĆI hook `useKadrDashboard` (RPC kadr_dashboard_kpis/mini_reports/action_stack).
 * Klik na action-stavku → `onOpenTab` (1.0 deep_link_tab mapiran na 2.0 TabKey).
 * Gate: `kadrovska.read` (modul-nivo; presuđuje page.tsx).
 */

/** 1.0 deep_link_tab (RPC) → 2.0 TabKey. */
const DEEP_LINK_MAP: Record<string, string> = {
  contracts: 'ugovori',
  employees: 'zaposleni',
  notifications: 'notifikacije',
  'vac-requests': 'odmori',
  vacation: 'odmori',
  grid: 'sati',
};

/** Čitljive labele za tipove odsustava (fallback = sirovi kod). */
const ABSENCE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  go: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sick: 'Bolovanje',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  nop: 'Neplaćeno odsustvo',
  nadoknada: 'Nadoknada sati',
  praznik: 'Praznik',
  teren: 'Teren',
};

function monthSubtitle(): string {
  try {
    return new Date().toLocaleDateString('sr-Latn-RS', { month: 'long', year: 'numeric' });
  } catch {
    const d = new Date();
    return `${d.getMonth() + 1}. ${d.getFullYear()}.`;
  }
}

/** Izvuci prvi datum iz subtitle-a (RPC vraća "do YYYY-MM-DD", "Rođendan DD.MM.", "od … do …"). */
function extractDate(text: string | undefined, refYear?: number): string | null {
  if (!text) return null;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dot = text.match(/(\d{1,2})\.(\d{1,2})\.?(\d{4})?/);
  if (dot) {
    const day = String(parseInt(dot[1], 10)).padStart(2, '0');
    const mon = String(parseInt(dot[2], 10)).padStart(2, '0');
    const yr = dot[3] || String(refYear ?? new Date().getFullYear());
    return `${yr}-${mon}-${day}`;
  }
  return null;
}

/** Rok-pilula { label, tone } za broj dana do datuma; null ako datum nedostaje. */
function deadlinePill(ymd: string | null): { label: string; tone: Tone } | null {
  if (!ymd) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(ymd + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return { label: 'Isteklo', tone: 'danger' };
  if (diff === 0) return { label: 'Danas', tone: 'danger' };
  if (diff === 1) return { label: 'Sutra', tone: 'warn' };
  if (diff <= 7) return { label: `za ${diff} d`, tone: 'warn' };
  if (diff <= 30) return { label: `za ${diff} d`, tone: 'info' };
  return { label: `za ${diff} d`, tone: 'neutral' };
}

function Skel({ className }: { className?: string }) {
  return <span className={cn('inline-block animate-pulse rounded bg-surface-2', className)} aria-hidden />;
}

function KpiCard({ icon, label, value, loading }: { icon: string; label: string; value: string; loading: boolean }) {
  return (
    <article className="flex items-center gap-3 rounded-panel border border-line bg-surface px-4 py-3">
      <span className="text-2xl" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</div>
        {loading ? <Skel className="mt-1 h-6 w-12" /> : <div className="tnums text-xl font-semibold text-ink">{value}</div>}
      </div>
    </article>
  );
}

/** Horizontalna bar-lista (zaposleni po odeljenju / odsustva po tipu). */
function BarList({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`}>
          <div className="mb-0.5 flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-ink">{r.label}</span>
            <span className="tnums shrink-0 text-ink-secondary">{r.value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Mini vertikalne trake (sati po danu u mesecu). */
function DayBars({ rows }: { rows: { date: string; hours: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.hours));
  return (
    <div className="flex h-24 items-end gap-px">
      {rows.map((r) => (
        <div
          key={r.date}
          title={`${r.date}: ${r.hours} h`}
          className="flex-1 rounded-t bg-accent/70"
          style={{ height: `${Math.max(2, (r.hours / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function MiniCard({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      {empty ? <p className="py-6 text-center text-sm text-ink-disabled">Nema podataka za prikaz</p> : children}
    </section>
  );
}

function ActionRow({ item, onOpenTab }: { item: DashboardActionItem; onOpenTab?: (tab: string) => void }) {
  const pill = deadlinePill(extractDate(item.subtitle));
  const target = DEEP_LINK_MAP[item.deep_link_tab] ?? item.deep_link_tab;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenTab?.(target)}
        className="flex w-full items-center gap-3 rounded-control border border-line bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{item.title}</div>
          {item.subtitle && <div className="truncate text-2xs text-ink-secondary">{item.subtitle}</div>}
        </div>
        {pill && <StatusBadge tone={pill.tone} label={pill.label} />}
        <span className="shrink-0 text-ink-disabled" aria-hidden>›</span>
      </button>
    </li>
  );
}

export function PregledTab({ onOpenTab }: { onOpenTab?: (tab: string) => void }) {
  const q = useKadrDashboard();
  const loading = q.isLoading;
  const d = q.data?.data;
  const kpis = d?.kpis ?? null;
  const mini = d?.miniReports ?? null;
  const actions = d?.actionStack ?? [];

  const gridPct = useMemo(() => {
    const n = Number(kpis?.grid_fill_percent);
    return Number.isFinite(n) ? `${n}%` : '—';
  }, [kpis]);

  const num = (v: number | undefined | null) => (v == null ? '—' : String(v));

  const cards = [
    { icon: '👥', label: 'Aktivni zaposleni', value: num(kpis?.active_employees) },
    { icon: '🏠', label: 'Trenutno na odsustvu', value: num(kpis?.on_absence_today) },
    { icon: '✋', label: 'Otvoreni zahtevi GO', value: num(kpis?.pending_vac_requests) },
    { icon: '🕗', label: 'Nadoknada sati (čeka)', value: num(kpis?.pending_makeup) },
    { icon: '📝', label: 'Plaćeno odsustvo (čeka)', value: num(kpis?.pending_paid_leave) },
    { icon: '📊', label: 'Grid popunjenost', value: gridPct },
  ];

  const empRows = (mini?.employees_by_department ?? []).map((r) => ({ label: r.department, value: r.count }));
  const absRows = (mini?.absences_by_type ?? []).map((r) => ({ label: ABSENCE_LABELS[r.type] ?? r.type, value: r.days }));
  const hourRows = mini?.hours_per_day ?? [];

  return (
    <div className="space-y-5">
      {/* Hero: mesec + osveži */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">Pregled</h2>
          <p className="text-sm capitalize text-ink-secondary">{monthSubtitle()}</p>
        </div>
        <Button variant="secondary" loading={q.isFetching} onClick={() => void q.refetch()} title="Osveži KPI, akcije i mini izveštaje">
          📊 Osveži
        </Button>
      </div>

      {q.isError && (
        <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          ⚠ Greška pri učitavanju pregleda — proveri mrežu ili prava.
        </p>
      )}

      {/* KPI strip */}
      <section aria-label="Kratke statistike" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <KpiCard key={c.label} icon={c.icon} label={c.label} value={c.value} loading={loading} />
        ))}
      </section>

      {/* Action stack */}
      <section aria-label="Šta čeka mene" className="space-y-2">
        <h2 className="text-base font-semibold text-ink">Šta čeka mene</h2>
        {loading ? (
          <div className="space-y-2">
            <Skel className="h-11 w-full" />
            <Skel className="h-11 w-full" />
            <Skel className="h-11 w-full" />
          </div>
        ) : actions.length === 0 ? (
          <EmptyState title="Nema stavki za prikaz" hint="Nema predstojećih isteka, rođendana ni zahteva na čekanju." />
        ) : (
          <ul className="space-y-2">
            {actions.map((it) => (
              <ActionRow key={it.id} item={it} onOpenTab={onOpenTab} />
            ))}
          </ul>
        )}
      </section>

      {/* Mini izveštaji */}
      <section aria-label="Mini izveštaji" className="space-y-2">
        <h2 className="text-base font-semibold text-ink">Mini izveštaji</h2>
        <div className="grid gap-3 lg:grid-cols-3">
          <MiniCard title="Zaposleni po odeljenju" empty={!loading && empRows.length === 0}>
            {loading ? <Skel className="h-24 w-full" /> : <BarList rows={empRows} />}
          </MiniCard>
          <MiniCard title="Sati po danu (mesec)" empty={!loading && hourRows.length === 0}>
            {loading ? <Skel className="h-24 w-full" /> : <DayBars rows={hourRows} />}
          </MiniCard>
          <MiniCard title="Odsustva po tipu" empty={!loading && absRows.length === 0}>
            {loading ? <Skel className="h-24 w-full" /> : <BarList rows={absRows} />}
          </MiniCard>
        </div>
      </section>
    </div>
  );
}
