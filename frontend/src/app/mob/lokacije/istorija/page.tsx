'use client';

/**
 * Mobilna „Moja istorija" premeštanja (/mob/lokacije/istorija) — PLAN_MOB_3.0 Faza 2,
 * talas C (magacin ekstre; 1.0 `/m/history` paritet). TANAK omotač nad
 * `GET /v1/locations/movements?mine=1` (`useMovements({ mine: true })`): server
 * razrešava sy15 `auth.users` uid prijavljenog i filtrira `moved_by` — klijent svoj
 * UUID ne zna, pa ga i ne šalje. Nema nijedne nove poslovne odluke; labele tipova
 * pokreta i relativno vreme su preslikani sa desktopa (`MOVEMENT_TYPE_LABEL`,
 * `formatRelativeAge` = 1.0 formatRelativeAge).
 *
 * Gate: `lokacije.read` (isti kao `/mob/lokacije`). Static export: čista statička
 * ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatRelativeAge } from '@/lib/format';
import {
  MOVEMENT_TYPE_LABEL,
  useAllLocations,
  useMovements,
  type LocLocation,
  type LocMovement,
} from '@/api/lokacije';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

const PAGE_SIZE = 50;

/** Kratka oznaka lokacije: šifra iz indeksa; bez indeksa skraćen UUID (zero-loss). */
function locLabel(id: string | null, byId: Map<string, LocLocation>): string {
  if (!id) return '—';
  const l = byId.get(id);
  return l ? l.locationCode : id.slice(0, 8);
}

export default function MobLokacijeIstorijaPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);

  const allowed = can(PERMISSIONS.LOKACIJE_READ);
  // `enabled` gate: bez prava ne pucaj 403 u pozadini (kartica ionako nije vidljiva).
  const q = useMovements({ mine: true, page, pageSize: PAGE_SIZE }, allowed);
  const locs = useAllLocations('all');
  const locById = useMemo(
    () => new Map((locs.data ?? []).map((l) => [l.id, l])),
    [locs.data],
  );

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen radnik na svež login video lažni „Nemate pristup".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
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
        Nemate pristup lokacijama — javite se administratoru (potrebno `lokacije.read`).
      </main>
    );
  }

  const rows = q.data?.data ?? [];
  const total = q.data?.meta.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Moja istorija</h1>
          <p className="truncate text-xs text-ink-secondary">
            {total > 0 ? `${total} mojih pokreta` : (user.fullName ?? user.email)}
          </p>
        </div>
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-3 p-4">
        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : q.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Greška pri učitavanju istorije. Proveri vezu pa osveži stranicu.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Nemaš zabeleženih premeštanja.
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {rows.map((m) => (
                <MovementCard key={m.id} m={m} locById={locById} />
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 rounded-panel border border-line bg-surface px-2 py-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className={`inline-flex h-11 items-center gap-1 rounded-control px-3 text-sm font-semibold text-ink disabled:text-ink-disabled active:bg-surface-2 ${FOCUS}`}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                  Novije
                </button>
                <span className="tnums text-xs text-ink-secondary">
                  {page}/{totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className={`inline-flex h-11 items-center gap-1 rounded-control px-3 text-sm font-semibold text-ink disabled:text-ink-disabled active:bg-surface-2 ${FOCUS}`}
                >
                  Starije
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function MovementCard({
  m,
  locById,
}: {
  m: LocMovement;
  locById: Map<string, LocLocation>;
}) {
  const from = locLabel(m.fromLocationId, locById);
  const to = locLabel(m.toLocationId, locById);
  return (
    <li className="rounded-panel border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        {/* title = pun datum-vreme: relativno je brzo za pregled, tačno za spor. */}
        <span className="text-xs text-ink-secondary" title={formatDateTime(m.movedAt)}>
          {formatRelativeAge(m.movedAt)}
        </span>
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary">
          {MOVEMENT_TYPE_LABEL[m.movementType] ?? m.movementType}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold text-ink">
        {m.orderNo ? `${m.orderNo} · ` : ''}
        {m.itemRefId}
      </p>
      {m.drawingNo && <p className="text-xs text-ink-secondary">crtež {m.drawingNo}</p>}
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-sm text-ink">
        <span className="tnums">
          {/* Bez odredišta (SCRAP / „Neraspoređeno") → strelica u prazno. */}
          {from} → {to}
        </span>
        <span className="tnums text-xs text-ink-secondary">{String(m.quantity)} kom</span>
      </p>
      {m.note && <p className="mt-1 text-xs text-ink-secondary">{m.note}</p>}
    </li>
  );
}
