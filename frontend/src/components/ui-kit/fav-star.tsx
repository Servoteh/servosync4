'use client';

import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';

// Zvezdica za dodavanje/uklanjanje modula iz omiljenog (zahtev 010/26). JEDNA kit
// komponenta za sidebar i hub; `variant` menja SAMO tokene boja/fokusa (obrazac kao
// NotificationBell `variant`) — struktura (opacity/hover/coarse/touch-target/apsolutno
// pozicioniranje/fokus pri samo-uklanjanju) je zajednička.

export type FavStarVariant = 'sidebar' | 'hub';

const VARIANT: Record<FavStarVariant, { ring: string; on: string; off: string; box: string }> = {
  // Sidebar = tamna površina (sidebar tokeni) + sidebar fokus-prsten.
  sidebar: {
    ring: 'focus-visible:shadow-[var(--focus-ring-sidebar)]',
    on: 'text-sidebar-accent hover:text-sidebar-ink-active',
    off: 'text-sidebar-ink/50 hover:text-sidebar-ink-active',
    box: '',
  },
  // Hub = svetla površina (standardni tokeni) + standardni fokus-prsten.
  hub: {
    ring: 'focus-visible:shadow-[var(--focus-ring)]',
    on: 'text-accent hover:text-accent-hover',
    off: 'text-ink-disabled hover:text-accent',
    // Kompaktan masonry hub (27.07.2026) steže red na ~25px koraka, pa bi 28px meta
    // preklapala zvezdicu susednog reda (~3px) i klik u toj traci bi pogodio pogrešan
    // modul. Na PRECIZNOM pokazivaču od `lg` naviše meta je 24px — spoj `lg` +
    // `(pointer:fine)` je uzajamno isključiv sa coarse bump-om ispod, pa 44px touch
    // meta ostaje netaknuta i na velikim ekranima osetljivim na dodir.
    box: 'lg:[@media(pointer:fine)]:h-6 lg:[@media(pointer:fine)]:w-6',
  },
};

/**
 * Klik toggluje BEZ navigacije (preventDefault + stopPropagation — stoji uz nav-link).
 * Apsolutno pozicionirana uz desnu ivicu reda (relative wrapper) — ne rezerviše stalno
 * mesto; desni gutter je na Link-u SAMO kad je red omiljen (popunjena zvezdica je uvek
 * vidljiva) ili na touch-u (coarse-pointer: zvezdica je uvek vidljiva). Vidljiva na hover
 * reda (`group-hover`), fokus i coarse-pointer. Touch-meta 44px (max-lg / coarse; ikona
 * ostaje ista, raste samo hit-area). Fokusabilna (DS §11). Bez `aria-pressed` — dinamički
 * `aria-label`/`title` već saopštavaju stanje (dupli/kontradiktoran signal se izbegava).
 *
 * FOKUS PRI SAMO-UKLANJANJU: kad zvezdica ukloni SOPSTVENI red (sekcija „Omiljeno"), fokus
 * ne sme pasti na <body>. Pre toggle-a se uhvate susedni red i stabilan roditelj
 * (`[data-fav-focus-fallback]`); posle re-rendera (rAF) — ako je dugme otkačeno iz DOM-a
 * (red nestao) — fokus ide na link/dugme susednog reda, a ako je cela sekcija nestala
 * (poslednji omiljeni), na stabilnog roditelja. Za domenske redove je no-op (red ostaje →
 * dugme je i dalje `isConnected`).
 */
export function FavStar({
  favorite,
  onToggle,
  variant = 'sidebar',
}: {
  favorite: boolean;
  onToggle: () => void;
  variant?: FavStarVariant;
}) {
  const v = VARIANT[variant];
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Uhvati mete PRE mutacije: posle handler-a `e.currentTarget` postaje null, a red
        // se uklanja iz DOM-a tek po React re-renderu (proveri u sledećem frejmu).
        const btn = e.currentTarget;
        const row = btn.parentElement;
        const sibling = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
        const fallback = btn.closest<HTMLElement>('[data-fav-focus-fallback]');
        onToggle();
        requestAnimationFrame(() => {
          if (btn.isConnected) return; // red ostaje (domenski red / dodavanje) — ne diraj fokus
          const target = sibling?.querySelector<HTMLElement>('a[href], button') ?? fallback ?? null;
          target?.focus();
        });
      }}
      aria-label={favorite ? 'Ukloni iz omiljenog' : 'Dodaj u omiljeno'}
      title={favorite ? 'Ukloni iz omiljenog' : 'Dodaj u omiljeno'}
      className={cn(
        'absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-control transition-opacity motion-reduce:transition-none',
        'max-lg:h-11 max-lg:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
        'focus-visible:outline-none focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
        v.box,
        v.ring,
        favorite ? cn('opacity-100', v.on) : cn('opacity-0 group-hover:opacity-100', v.off),
      )}
    >
      <Star className={cn('h-3.5 w-3.5', favorite && 'fill-current')} aria-hidden />
    </button>
  );
}
