'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Home,
  ListTodo,
  MoreHorizontal,
  ScanLine,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';

/**
 * Zajednička ljuska mobilne aplikacije `/mob` — PLAN_MOB_IZGLED_1.0_PARITET, F1.
 *
 * Paritet 1.0 (`src/ui/mobile/mobileAppShell.js` + `styles/mobile-app.css` `.ma-*`):
 * sticky zaglavlje (naslov + podnaslov) · sadržaj · FIKSIRANA donja traka sa 5 tabova
 * gde je „Skeniraj" istaknut krug koji VIRI iznad trake. Ljuska NE dira sadržaj
 * ekrana — samo ga uokviruje (F1 je čista ljuska, bez izmene poslovne logike).
 *
 * Razlike od 1.0 koje traži naš dizajn sistem:
 *  · ikone su lucide, ne emoji (DESIGN_SYSTEM §2 „bez emoji-ja u UI");
 *  · boje/radijusi samo iz tokena (`text-accent`, `bg-accent`, `border-line`…).
 *
 * Aktivan tab se PREDAJE propom (`active`), ne izvodi iz `usePathname` — static
 * export i tako renderuje svaku rutu zasebno, a eksplicitan prop je čitljiviji od
 * poklapanja putanja (i ne meša `/mob/lokacije` ekrane sa „scan" tabom).
 */

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/**
 * Verzija aplikacije uz naslov — HARDKODOVANA namerno. `public/version.json` nosi
 * build hash (tehnički podatak za `UpdateNotifier`), a pogonu treba samo „u kojoj
 * sam aplikaciji": ljudi svakodnevno prelaze između 1.0 (`/m`) i 3.0 (`/mob`).
 */
const APP_VERZIJA = '3.0';

const DEFAULT_TITLE = 'SERVOSYNC';
const DEFAULT_SUBTITLE = 'Servoteh · mobilni';

export type MobTab = 'pocetna' | 'zaMene' | 'scan' | 'profil' | 'vise';

type TabDef = {
  key: MobTab;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Istaknut centralni tab (krug iznad trake) — vodi na skener uz proveru prava. */
  scan?: boolean;
};

/** Raspored i redosled su 1:1 sa 1.0 `TABS` (Početna · Za mene · Skeniraj · Profil · Više). */
const TABS: TabDef[] = [
  { key: 'pocetna', label: 'Početna', icon: Home, href: '/mob' },
  { key: 'zaMene', label: 'Za mene', icon: ListTodo, href: '/mob/za-mene' },
  { key: 'scan', label: 'Skeniraj', icon: ScanLine, href: '/mob/lokacije', scan: true },
  { key: 'profil', label: 'Profil', icon: UserCircle, href: '/mob/profil' },
  { key: 'vise', label: 'Više', icon: MoreHorizontal, href: '/mob/vise' },
];

/** Tab: ≥44px meta (DS §11), ikona + labela ispod, aktivan u akcentnoj boji. */
const TAB_BASE =
  'flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2 text-2xs font-semibold';

export function MobShell({
  title,
  subtitle,
  active,
  headerRight,
  children,
}: {
  /** Naslov ekrana; bez njega „SERVOSYNC" + oznaka verzije (početna, paritet 1.0). */
  title?: string;
  /** Podnaslov ispod naslova; bez njega „Servoteh · mobilni". */
  subtitle?: string;
  active: MobTab;
  /** Akcija u desnom uglu zaglavlja (1.0 ima jedno ikon-dugme). */
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const { can } = useAuth();
  const router = useRouter();

  // Oznaka „3.0" stoji samo uz podrazumevani naslov (početna). Na pod-ekranima je
  // naslov ime ekrana („Za mene", „Moj profil"…) — pilula uz njega bi bila šum, a
  // identitet aplikacije tamo nosi podnaslov + red na dnu „Više".
  const showVersion = title === undefined;

  /**
   * „Skeniraj" nije Link nego dugme: bez prava na magacin ne navigiramo nikuda nego
   * kažemo zašto (1.0: „🔒 Nemaš pristup magacinu / skeniranju"). Poruka ide kroz
   * postojeći `toast` (`lib/toast.ts`, imperativan, bez provider-a) — isti obrazac
   * koji /mob ekrani već koriste za povratnu informaciju (za-mene, profil, lokacije).
   */
  function onScan() {
    if (!can(PERMISSIONS.LOKACIJE_READ)) {
      toast('Nemaš pristup magacinu / skeniranju.');
      return;
    }
    router.push('/mob/lokacije');
  }

  return (
    <div className="flex min-h-screen flex-col bg-app">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-md font-semibold text-ink">
            <span className="truncate">{title ?? DEFAULT_TITLE}</span>
            {showVersion && (
              <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-bold text-accent">
                {APP_VERZIJA}
              </span>
            )}
          </h1>
          <p className="truncate text-xs text-ink-secondary">{subtitle ?? DEFAULT_SUBTITLE}</p>
        </div>
        {headerRight}
      </header>

      {/* Donji razmak = visina trake + safe-area, da poslednji red sadržaja nikad
          ne ostane ispod fiksirane trake (1.0 `.ma-shell` radi isto). */}
      <main className="flex-1 p-4 pb-[calc(6rem_+_env(safe-area-inset-bottom,0px))]">
        {children}
      </main>

      {/* Fiksirana donja traka. `pb-[env(...)]` = home-indicator zona na iPhone-u
          (bez toga poslednji red trake pada pod sistemsku crtu). */}
      <nav
        aria-label="Glavna navigacija"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom,0px)]"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === active;
          const tone = isActive ? 'text-accent' : 'text-ink-secondary';

          // Centralni „Skeniraj": krug 48px podignut iznad trake (1.0: 46px, -16px).
          const icon = t.scan ? (
            <span className="-mt-4 grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-fg shadow-lg">
              <Icon className="h-6 w-6" aria-hidden />
            </span>
          ) : (
            <Icon className="h-6 w-6" aria-hidden />
          );

          if (t.scan) {
            return (
              <button
                key={t.key}
                type="button"
                onClick={onScan}
                className={`${TAB_BASE} ${tone} ${FOCUS}`}
              >
                {icon}
                {t.label}
              </button>
            );
          }

          return (
            <Link
              key={t.key}
              href={t.href}
              aria-current={isActive ? 'page' : undefined}
              className={`${TAB_BASE} ${tone} active:bg-surface-2 ${FOCUS}`}
            >
              {icon}
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
