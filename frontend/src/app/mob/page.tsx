'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Monitor } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { MobShell } from './_components/mob-shell';
import { visibleMobModules } from './_components/mob-modules';

/**
 * Mobilna početna `/mob` (PLAN_MOB_3.0.md, Faza 0) — kartice ka 3.0 mobilnim
 * ekranima, paritet ideje 1.0 `/m` huba. Van AppShell-a (full-screen mobilni
 * panel, isti obrazac kao `/mob/lokacije` i `/mob/prisustvo`).
 *
 * Od F1 (PLAN_MOB_IZGLED_1.0_PARITET) ekran je uvijen u `MobShell` — zaglavlje i
 * donja tab-traka žive tamo, ovde je samo sadržaj. Spisak modula je zajednički sa
 * „Više" (`_components/mob-modules.ts`) — bez duplirane liste.
 *
 * ⚠️ Prostor `/mob/*` je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`)
 * sve `/m/*` na javnom domenu proksira na 1.0 mobilnu (pages.dev), pa 3.0 stranica
 * pod `/m` tamo ne bi bila dostupna. Isti origin = APK WebView ljuska ostaje živa.
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

export default function MobHubPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen korisnik na svež login video prazan hub.
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

  const visible = visibleMobModules(can);

  return (
    <MobShell
      active="pocetna"
      headerRight={
        <Link
          href="/"
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-control border border-line bg-surface-2 px-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <Monitor className="h-4 w-4" aria-hidden />
          Desktop verzija
        </Link>
      }
    >
      {visible.length === 0 ? (
        <EmptyState
          title="Nema dostupnih modula"
          hint="Vaša uloga nema pristup nijednom mobilnom ekranu — javite se administratoru."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {visible.map((c) => {
            const Icon = c.icon;

            // Grupa (Montaža): pun red, glavni ulaz + pod-ulazi u istom panelu.
            // Bez `overflow-hidden` — fokus prsten je spoljna senka i bio bi odsečen;
            // uglovi se zato zaokružuju po redu (prvi/poslednji).
            if (c.children) {
              const subs = c.children;
              return (
                <div key={c.href} className="col-span-2 rounded-panel border border-line bg-surface">
                  <Link
                    href={c.href}
                    className={`flex min-h-14 items-center gap-3 p-4 active:bg-surface-2 ${
                      subs.length === 0 ? 'rounded-panel' : 'rounded-t-panel'
                    } ${FOCUS}`}
                  >
                    <Icon className="h-7 w-7 shrink-0 text-accent" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{c.label}</span>
                      <span className="block text-xs text-ink-secondary">{c.hint}</span>
                    </span>
                    <ChevronRight className="h-5 w-5 shrink-0 text-ink-disabled" aria-hidden />
                  </Link>

                  {subs.map((s, i) => {
                    const SubIcon = s.icon;
                    return (
                      <Link
                        key={s.href}
                        href={s.href}
                        className={`flex min-h-11 items-center gap-3 border-t border-line py-2.5 pl-6 pr-4 active:bg-surface-2 ${
                          i === subs.length - 1 ? 'rounded-b-panel' : ''
                        } ${FOCUS}`}
                      >
                        <SubIcon className="h-5 w-5 shrink-0 text-ink-secondary" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink">{s.label}</span>
                          <span className="block text-xs text-ink-secondary">{s.hint}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                      </Link>
                    );
                  })}
                </div>
              );
            }

            return (
              <Link
                key={c.href}
                href={c.href}
                className={`flex min-h-24 flex-col gap-2 rounded-panel border border-line bg-surface p-4 active:bg-surface-2 ${FOCUS}`}
              >
                <Icon className="h-7 w-7 shrink-0 text-accent" aria-hidden />
                <span className="text-sm font-semibold text-ink">{c.label}</span>
                <span className="text-xs text-ink-secondary">{c.hint}</span>
              </Link>
            );
          })}
        </div>
      )}
    </MobShell>
  );
}
