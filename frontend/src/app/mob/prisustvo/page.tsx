'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';
import { DIRECTION_LABEL, STATUS_META } from '@/app/kadrovska/_components/prisustvo/helpers';
import {
  filterLiveRows,
  LIVE_SEGMENTS,
  useLiveAttendance,
  type StatusFilter,
} from '@/app/kadrovska/_components/prisustvo/live-rows';

/**
 * MOBILNO „Prisustvo uživo" (zahtev 019/26, Miljan Nikodijević) — ko je trenutno
 * prisutan / na pauzi / odsutan, sa telefona. Isti izvor kao PC prikaz
 * (Kadrovska → Radni sati → Prisustvo → „Uživo"): `GET /kadrovska/attendance/now`
 * ⨝ imenik, kroz deljeni `useLiveAttendance` — nema nove poslovne logike ni novog
 * endpointa. Osvežava se sam na 60 s (refetchInterval hook-a) + dugme „Osveži".
 *
 * ⚠️ Ruta je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`) SVE `/m/*`
 * na javnom domenu proksira na 1.0 — 3.0 stranica pod /m ne bi bila dostupna sa
 * telefona. Ulazi se prečicom iz 1.0 mobilne Kadrovske (isti origin, ista APK
 * ljuska). Static export: čista statička ruta, bez [id] i bez useSearchParams.
 */

/** „HH:mm" LOKALNOG vremena iz epoch ms (dataUpdatedAt) — ne kroz ISO/UTC. */
function localHhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Kartica-brojač = i prečica na filter (najveća meta za prst na ekranu). */
const CARDS: { key: StatusFilter; label: string; tone: string }[] = [
  { key: 'prisutan', label: 'Prisutno', tone: 'border-accent/40 bg-accent-subtle' },
  { key: 'pauza', label: 'Na pauzi', tone: 'border-status-warn/40 bg-status-warn-bg' },
  { key: 'odsutan', label: 'Odsutno', tone: 'border-line bg-surface' },
];

export default function MobPrisustvoPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('svi');

  // Gejt PRE zahteva: bez prava (ili dok dozvole ne stignu) ne ispaljuj /attendance/now.
  const allowed = !!user && !permissionsPending && !permissionsError && can(PERMISSIONS.KADROVSKA_ATTENDANCE);
  const live = useLiveAttendance(allowed);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen korisnik na svež login video lažni „Nemate pristup".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // Pad učitavanja dozvola (retry:false — ostaje za sesiju) ≠ stvarna zabrana.
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup prisustvu — javite se administratoru (potrebno `kadrovska.attendance`).
      </main>
    );
  }

  const filtered = filterLiveRows(live.rows, statusFilter, query);
  const counts: Record<StatusFilter, number> = {
    svi: live.rows.length,
    prisutan: live.counts.prisutan,
    pauza: live.counts.pauza,
    odsutan: live.counts.odsutan,
  };

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-ink">Prisustvo — uživo</h1>
            <p className="truncate text-xs text-ink-secondary">
              {live.updatedAt ? `osveženo u ${localHhmm(live.updatedAt)}` : 'učitavanje…'}
            </p>
          </div>
          <button
            onClick={live.reload}
            disabled={live.isFetching}
            aria-label="Osveži"
            className="inline-flex h-11 min-w-11 items-center gap-2 rounded-control border border-line bg-surface-2 px-4 text-sm font-semibold text-ink active:bg-surface disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${live.isFetching ? 'animate-spin' : ''}`} aria-hidden />
            Osveži
          </button>
        </div>
      </header>

      <main className="space-y-3 p-4">
        {/* Brojači = i prečica na filter (tap na „Na pauzi" = lista onih na pauzi). */}
        <div className="grid grid-cols-3 gap-2">
          {CARDS.map((c) => (
            <button
              key={c.key}
              onClick={() => setStatusFilter(statusFilter === c.key ? 'svi' : c.key)}
              aria-pressed={statusFilter === c.key}
              className={`rounded-panel border px-3 py-3 text-left ${c.tone} ${
                statusFilter === c.key ? 'ring-2 ring-accent' : ''
              }`}
            >
              <span className="block text-2xs font-semibold uppercase tracking-wider text-ink-secondary">
                {c.label}
              </span>
              <span className="tnums mt-0.5 block text-2xl font-semibold text-ink">{counts[c.key]}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-1 rounded-panel border border-line bg-surface p-1">
          {LIVE_SEGMENTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatusFilter(s.key)}
              aria-pressed={statusFilter === s.key}
              className={`min-h-11 rounded-control px-1 text-sm font-semibold ${
                statusFilter === s.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary active:bg-surface-2'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded-control border border-line bg-surface px-3">
          <Search className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ime i prezime…"
            aria-label="Pretraga po imenu i prezimenu"
            autoComplete="off"
            className="h-12 w-full bg-transparent text-base text-ink placeholder:text-ink-disabled focus:outline-none"
          />
        </div>

        {live.isError && (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            Podaci nisu učitani (mreža ili dozvola). Probaj „Osveži".
          </p>
        )}

        {live.isLoading ? (
          <p className="px-1 py-8 text-center text-sm text-ink-secondary">Učitavam…</p>
        ) : filtered.length === 0 ? (
          <EmptyState title="Nema rezultata" hint="Promeni pretragu ili filter statusa." />
        ) : (
          <ul className="space-y-2">
            {filtered.map((r) => {
              const meta = STATUS_META[r.status] ?? STATUS_META.odsutan;
              return (
                <li
                  key={r.employeeId || r.fullName}
                  className="rounded-panel border border-line bg-surface px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-ink">{r.fullName || '—'}</p>
                      <p className="truncate text-sm text-ink-secondary">{r.department || '—'}</p>
                    </div>
                    <span className="shrink-0">
                      <StatusBadge tone={meta.tone} label={meta.label} />
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-ink-secondary">
                    {r.eventTs ? (
                      <>
                        {formatDateTime(r.eventTs)} · {DIRECTION_LABEL[r.direction ?? 'unknown'] ?? '—'}
                      </>
                    ) : (
                      <span className="text-ink-disabled">bez prolaza u 24 h</span>
                    )}
                  </p>
                  {r.terminalName && (
                    <p className="text-xs text-ink-disabled">Terminal: {r.terminalName}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="tnums pt-1 text-center text-xs text-ink-disabled">
          Prikazano {filtered.length} od {live.rows.length}
        </p>
      </main>
    </div>
  );
}
