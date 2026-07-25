'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bot,
  CalendarClock,
  CalendarRange,
  Cog,
  FileText,
  Hammer,
  Monitor,
  Radar,
  UserCheck,
  Users,
  Warehouse,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';

/**
 * Mobilna početna `/mob` (PLAN_MOB_3.0.md, Faza 0) — kartice ka 3.0 mobilnim
 * ekranima, paritet ideje 1.0 `/m` huba. Van AppShell-a (full-screen mobilni
 * panel, isti obrazac kao `/mob/lokacije` i `/mob/prisustvo`).
 *
 * ⚠️ Prostor `/mob/*` je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`)
 * sve `/m/*` na javnom domenu proksira na 1.0 mobilnu (pages.dev), pa 3.0 stranica
 * pod `/m` tamo ne bi bila dostupna. Isti origin = APK WebView ljuska ostaje živa.
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 *
 * Vidljivost kartice je OGLEDALO gate-a ciljnog ekrana (`requires`); kartica bez
 * `requires` je dostupna svakom prijavljenom (ciljni ekran nema permisiju).
 */

type MobCard = {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Permisija ciljnog ekrana; bez nje = svaki prijavljen korisnik. */
  requires?: Permission;
};

const CARDS: MobCard[] = [
  {
    href: '/mob/lokacije',
    label: 'Magacin / Lokacije',
    hint: 'skeniraj deo → gde stoji → premesti',
    icon: Warehouse,
    requires: PERMISSIONS.LOKACIJE_READ,
  },
  {
    href: '/mob/prisustvo',
    label: 'Prisustvo uživo',
    hint: 'ko je prisutan, na pauzi, odsutan',
    icon: Users,
    requires: PERMISSIONS.KADROVSKA_ATTENDANCE,
  },
  {
    // Ekran nema eksplicitnu permisiju (guard = prijava; `profile.self` ima svaka
    // rola, a RPC „own ∨ manager" presuđuje red) → kartica za sve prijavljene.
    href: '/mob/moje-prisustvo',
    label: 'Moje prisustvo',
    hint: 'moji prolazi + prijava korekcije',
    icon: UserCheck,
  },
  {
    href: '/mob/montaza',
    label: 'Montaža',
    hint: 'plan, izveštaji, neusaglašenosti',
    icon: Hammer,
    requires: PERMISSIONS.MONTAZA_READ,
  },
  {
    href: '/mob/izvestaj',
    label: 'Novi izveštaj',
    hint: 'tekst + fotke → AI → PDF',
    icon: FileText,
    requires: PERMISSIONS.MONTAZA_READ,
  },
  {
    href: '/mob/odrzavanje',
    label: 'Održavanje',
    hint: 'karton sredstva, prijava kvara, QR',
    icon: Cog,
    requires: PERMISSIONS.ODRZAVANJE_READ,
  },
  {
    // Ekran nema read gate (1.0 paritet: pogonski radnici su primarni korisnici;
    // PRACENJE_READ bi sakrio karticu monterima/CNC-u) — override unutra čuva
    // PRACENJE_MANAGE.
    href: '/mob/pracenje',
    label: 'Praćenje',
    hint: 'predmeti → pozicije → status',
    icon: Radar,
  },
  {
    // Isto: operater na mašini je ciljni korisnik, ekran bez read gate-a;
    // izmene unutra čuva PLAN_PROIZVODNJE_EDIT.
    href: '/mob/proizvodnja',
    label: 'Proizvodnja',
    hint: 'red operacija po mašini',
    icon: CalendarRange,
  },
  {
    href: '/mob/sastanci',
    label: 'Sastanci',
    hint: 'pregled, RSVP, status akcija',
    icon: CalendarClock,
    requires: PERMISSIONS.SASTANCI_READ,
  },
  {
    href: '/mob/energetika',
    label: 'Energetika',
    hint: 'SCADA nadzor + touch komande',
    icon: Zap,
    requires: PERMISSIONS.ENERGETIKA_READ,
  },
  {
    href: '/mob/ai',
    label: 'AI asistent',
    hint: 'pitaj o nalozima, predmetima, planu',
    icon: Bot,
    requires: PERMISSIONS.AI_CHAT,
  },
];

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

  const visible = CARDS.filter((c) => !c.requires || can(c.requires));

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">ServoSync</h1>
          <p className="truncate text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
        </div>
        <Link
          href="/"
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-control border border-line bg-surface-2 px-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <Monitor className="h-4 w-4" aria-hidden />
          Desktop verzija
        </Link>
      </header>

      <main className="p-4">
        {visible.length === 0 ? (
          <EmptyState
            title="Nema dostupnih modula"
            hint="Vaša uloga nema pristup nijednom mobilnom ekranu — javite se administratoru."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((c) => {
              const Icon = c.icon;
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
      </main>
    </div>
  );
}
