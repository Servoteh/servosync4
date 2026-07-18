'use client';

import Link from 'next/link';
import { Bell, Pencil, Calendar, Wrench, Users, ArrowRight, Link2 } from 'lucide-react';

// ============================================================================
// Podešavanja → Notifikacije — centralni hub (paritet 1.0 `notifikacijeTab.js`).
// Tanki FE: čiste link-kartice ka konfiguraciji notifikacija po modulu. Bez backend
// poziva. Notifikacije se i dalje podešavaju UNUTAR svakog modula — ovde su svi
// ulazi na jednom mestu. Rute su 2.0 (PB=/pb, Sastanci=/sastanci, Održavanje=
// /odrzavanje, Kadrovska=/kadrovska); svaka vodi na modul čiji admin/notif tab
// nosi stvarnu konfiguraciju. Link ka Integracije tabu je interni (onNavigate).
// ============================================================================

interface NotifLink {
  id: string;
  icon: typeof Bell;
  title: string;
  desc: string;
  href: string;
  hint: string;
}

const MODULE_NOTIF_LINKS: NotifLink[] = [
  {
    id: 'pb',
    icon: Pencil,
    title: 'Projektni biro',
    desc: 'Email primaoci, pragovi rokova, tihi sati, digest.',
    href: '/pb',
    hint: 'Tab „Podešavanja” unutar PB modula (samo admin).',
  },
  {
    id: 'sastanci',
    icon: Calendar,
    title: 'Sastanci',
    desc: 'Lične email preference: pozivnice, zaključavanje, podsetnici.',
    href: '/sastanci',
    hint: 'Svaki korisnik podešava svoje preference (tab „Podešavanja”).',
  },
  {
    id: 'odrzavanje',
    icon: Wrench,
    title: 'Održavanje',
    desc: 'CMMS pravila, kanali, eskalacije.',
    href: '/odrzavanje',
    hint: 'Tab „Notifikacije” u modulu Održavanje (maint chief / admin).',
  },
  {
    id: 'kadrovska',
    icon: Users,
    title: 'Kadrovska (HR)',
    desc: 'HR podsetnici — WhatsApp / email outbox.',
    href: '/kadrovska',
    hint: 'Konfiguracija u Kadrovskoj sekciji notifikacija.',
  },
];

/** `onNavigate` = prelaz na drugi tab Podešavanja (npr. Integracije) bez rute. */
export function NotifikacijeTab({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Bell className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Notifikacije</h2>
          <p className="text-xs text-ink-secondary">Centralni pregled — konfiguracija po modulu</p>
        </div>
      </div>

      <p className="text-xs text-ink-secondary">
        Notifikacije se trenutno podešavaju u okviru svakog modula. Ovde su svi ulazi na jednom mestu.
        Globalni digest / integracije:{' '}
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate('integracije')}
            className="text-accent underline underline-offset-2 hover:opacity-80"
          >
            tab Integracije
          </button>
        ) : (
          <span className="text-ink-secondary">tab Integracije</span>
        )}
        .
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {MODULE_NOTIF_LINKS.map((l) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.id}
              href={l.href}
              className="flex items-start gap-3 rounded-panel border border-line bg-surface p-4 transition-colors hover:border-accent hover:bg-surface-2"
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-secondary">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{l.title}</div>
                <p className="mt-0.5 text-xs text-ink-secondary">{l.desc}</p>
                <p className="mt-1 text-2xs text-ink-disabled">{l.hint}</p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
            </Link>
          );
        })}
      </div>

      {onNavigate && (
        <button
          type="button"
          onClick={() => onNavigate('integracije')}
          className="inline-flex items-center gap-2 text-xs text-ink-secondary hover:text-ink"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden />
          Pregled spoljnih sistema i platforme →
        </button>
      )}
    </div>
  );
}
