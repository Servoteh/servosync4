'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';
import { DIRECTION_LABEL, STATUS_META } from '@/app/kadrovska/_components/prisustvo/helpers';
import {
  countByStatus,
  searchLiveRows,
  useLiveAttendance,
  type StatusFilter,
} from '@/app/kadrovska/_components/prisustvo/live-rows';

/**
 * MOBILNO „Prisustvo uživo" (zahtev 019/26, Miljan Nikodijević) — ko je trenutno
 * prisutan / na pauzi / odsutan, sa telefona. Isti izvor kao PC prikaz
 * (Kadrovska → Radni sati → Prisustvo → „Uživo"): `GET /kadrovska/attendance/now`
 * ⨝ imenik, kroz deljeni `useLiveAttendance` — nema nove poslovne logike ni novog
 * endpointa. Osvežavanje: 60 s interval + na povratak fokusa (telefon iz zaključanog
 * stanja) + dugme „Osveži".
 *
 * ⚠️ Ruta je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`) SVE `/m/*`
 * na javnom domenu proksira na 1.0 — 3.0 stranica pod /m ne bi bila dostupna sa
 * telefona. Ulazi se prečicom iz 1.0 mobilne Kadrovske (isti origin, ista APK
 * ljuska, SSO token u fragmentu). Static export: čista statička ruta, bez [id] i
 * bez useSearchParams.
 */

/** Kartice su JEDINI filter (nema druge trake) — najveća meta za prst. */
const CARDS: { key: StatusFilter; label: string; tone: string }[] = [
  { key: 'svi', label: 'Svi', tone: 'border-line bg-surface' },
  { key: 'prisutan', label: 'Prisutno', tone: 'border-accent/40 bg-accent-subtle' },
  { key: 'pauza', label: 'Na pauzi', tone: 'border-status-warn/40 bg-status-warn-bg' },
  { key: 'odsutan', label: 'Odsutno', tone: 'border-line bg-surface-2' },
];

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** „HH:mm" LOKALNOG vremena iz epoch ms (dataUpdatedAt) — ne kroz ISO/UTC. */
function localHhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function MobPrisustvoPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('svi');
  // „Osveži" prati SAMO korisničko osvežavanje (obrazac /mob/lokacije flushBusy):
  // vezivanje za isFetching bi dugme gasilo na svakih 60 s pozadinskog refetch-a.
  const [refreshing, setRefreshing] = useState(false);

  // Gejt PRE zahteva: bez prava (ili dok dozvole ne stignu) ne ispaljuj /attendance/now.
  const allowed =
    !!user && !permissionsPending && !permissionsError && can(PERMISSIONS.KADROVSKA_ATTENDANCE);
  const live = useLiveAttendance(allowed);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen korisnik na svež login video lažni „Nemate pristup".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // Pad učitavanja dozvola (retry:false — ostaje za sesiju) ≠ stvarna zabrana.
  if (permissionsError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup prisustvu — javite se administratoru (potrebno `kadrovska.attendance`).
      </main>
    );
  }

  // Brojači se računaju nad PRETRAŽENIM skupom (kartice dele ono što je u listi),
  // pa zbir kartica uvek odgovara onome što korisnik vidi.
  const searched = searchLiveRows(live.rows, query);
  const counts = countByStatus(searched);
  const filtered =
    statusFilter === 'svi' ? searched : searched.filter((r) => r.status === statusFilter);
  const cardValue: Record<StatusFilter, number> = {
    svi: searched.length,
    prisutan: counts.prisutan,
    pauza: counts.pauza,
    odsutan: counts.odsutan,
  };

  // Dva različita neuspeha: „imam star prikaz" (stale) i „nemam ništa" (dead).
  const stale = (live.isError || live.isPaused) && live.hasSnapshot;
  const dead = (live.isError || live.isPaused) && !live.hasSnapshot && !live.isLoading;

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await live.reload();
    } finally {
      setRefreshing(false);
    }
  }

  function goBack() {
    // Ulazi se tvrdom navigacijom iz 1.0 mobilne Kadrovske → istorija postoji; ako je
    // stranica otvorena direktno (deep-link), vrati na 3.0 početnu umesto ćorsokaka.
    if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
    else router.push('/');
  }

  const headerNote = live.updatedAt
    ? `osveženo u ${localHhmm(live.updatedAt)}`
    : dead
      ? 'podaci nisu učitani'
      : live.isPaused
        ? 'nema mreže — čekam vezu'
        : 'učitavanje…';

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <button
          onClick={goBack}
          aria-label="Nazad"
          className={`-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-secondary active:bg-surface-2 ${FOCUS}`}
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Prisustvo — uživo</h1>
          <p className="truncate text-xs text-ink-secondary">{headerNote}</p>
        </div>
        <button
          onClick={() => void onRefresh()}
          disabled={refreshing}
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-control border border-line bg-surface-2 px-4 text-sm font-semibold text-ink active:bg-surface disabled:opacity-60 ${FOCUS}`}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
          {refreshing ? 'Osvežavam…' : 'Osveži'}
        </button>
      </header>

      <main className="space-y-3 p-4">
        {/* Kartice-brojači SU filter (tap na „Na pauzi" = lista onih na pauzi). */}
        <div className="grid grid-cols-2 gap-2">
          {CARDS.map((c) => (
            <button
              key={c.key}
              onClick={() => setStatusFilter(c.key)}
              aria-pressed={statusFilter === c.key}
              className={`min-h-11 rounded-panel border px-3 py-3 text-left ${c.tone} ${FOCUS} ${
                statusFilter === c.key ? 'ring-2 ring-accent' : ''
              }`}
            >
              <span className="block text-xs font-semibold uppercase tracking-wider text-ink-secondary">
                {c.label}
              </span>
              <span className="tnums mt-0.5 block text-2xl font-semibold text-ink">
                {cardValue[c.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded-control border border-line bg-surface px-3 focus-within:shadow-[var(--focus-ring)]">
          <Search className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ime i prezime…"
            aria-label="Pretraga po imenu i prezimenu"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // text-md = 16 px: ispod toga iOS Safari zumira stranicu na fokus polja.
            className="h-12 w-full bg-transparent text-md text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>

        {/* (a) imam star prikaz — reci OD KADA je i da mreže nema */}
        {stale && (
          <p className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-status-warn">
            Prikaz je star{live.updatedAt ? ` od ${localHhmm(live.updatedAt)}` : ''} — mreža
            nedostupna. Probaj „Osveži" kad se veza vrati.
          </p>
        )}

        {/* (b) nemam ništa — greška, NE prazno stanje (prazna lista bi lagala) */}
        {dead ? (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center">
            <p className="text-sm font-semibold text-status-danger">Stanje prisustva nije učitano</p>
            <p className="mt-1 text-sm text-ink-secondary">
              {live.isPaused
                ? 'Telefon je bez mreže. Podaci stižu čim se veza vrati.'
                : 'Mreža ili dozvola. Probaj „Osveži"; ako se ponavlja, javi administratoru.'}
            </p>
          </div>
        ) : live.isLoading ? (
          <p className="px-1 py-8 text-center text-sm text-ink-secondary">Učitavam…</p>
        ) : filtered.length === 0 ? (
          <EmptyState title="Nema rezultata" hint="Promeni pretragu ili izabranu karticu." />
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
                      <p className="truncate text-md font-semibold text-ink">{r.fullName || '—'}</p>
                      <p className="truncate text-sm text-ink-secondary">{r.department || '—'}</p>
                    </div>
                    <span className="shrink-0">
                      <StatusBadge tone={meta.tone} label={meta.label} />
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-ink-secondary">
                    {r.eventTs ? (
                      <>
                        {formatDateTime(r.eventTs)} ·{' '}
                        {DIRECTION_LABEL[r.direction ?? 'unknown'] ?? '—'}
                      </>
                    ) : (
                      'bez prolaza u poslednja 24 h'
                    )}
                  </p>
                  {r.terminalName && (
                    <p className="text-sm text-ink-secondary">Terminal: {r.terminalName}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!dead && !live.isLoading && (
          <p className="tnums pt-1 text-center text-xs text-ink-secondary">
            {query.trim()
              ? `Pretraga: ${searched.length} od ${live.rows.length} zaposlenih`
              : `Ukupno ${live.rows.length} zaposlenih`}
          </p>
        )}
      </main>
    </div>
  );
}
