'use client';

import Link from 'next/link';
import { Database, Building2, Wrench, ClipboardList, ArrowRight, ExternalLink } from 'lucide-react';

// ============================================================================
// Podešavanja → Matični podaci — hub referentnih podataka (paritet 1.0
// `mastersTab.js`). Tanki FE, čiste link-kartice:
//  - Organizacija → interni tab Podešavanja (onNavigate) — odeljenja/pododeljenja/
//    radna mesta (P8 write verzija u istom ekranu).
//  - „Mašine (1.0)” i „Održ. profili (1.0)” → OSTAJU u 1.0 do Talasa F
//    (odluka migracionog plana). Kartica-link vodi na 1.0 podešavanja + odgovarajući
//    tab. Predmet-aktivacija → interni tab (2.0 već ima write ekran).
// ============================================================================

/** 1.0 hub (kanon: SAMO servosync.servoteh.com — vidi ADRESE KANON). */
const LEGACY_1_0 = 'https://servosync.servoteh.com';

interface InternalLink {
  kind: 'internal';
  tab: string;
  label: string;
  desc: string;
  icon: typeof Database;
}
interface ExternalLink {
  kind: 'external';
  href: string;
  label: string;
  desc: string;
  icon: typeof Database;
}
type MasterLink = InternalLink | ExternalLink;

const LINKS: MasterLink[] = [
  {
    kind: 'internal',
    tab: 'organizacija',
    label: 'Organizacija',
    desc: 'Odeljenja, pododeljenja, radna mesta i opisi pozicija.',
    icon: Building2,
  },
  {
    kind: 'external',
    href: `${LEGACY_1_0}/podesavanja?tab=masine`,
    label: 'Mašine (1.0)',
    desc: 'Katalog mašina (CMMS + Lokacije sync). Ostaje u 1.0 do Talasa F.',
    icon: Wrench,
  },
  {
    kind: 'external',
    href: `${LEGACY_1_0}/podesavanja?tab=maint-profiles`,
    label: 'Održ. profili (1.0)',
    desc: 'Profili održavanja (planovi/intervali). Ostaje u 1.0 do Talasa F.',
    icon: Wrench,
  },
  {
    kind: 'internal',
    tab: 'predmet',
    label: 'Podeš. predmeta',
    desc: 'Aktivacija predmeta i prioritet (BigTehn cache).',
    icon: ClipboardList,
  },
];

/** `onNavigate` = prelaz na drugi tab Podešavanja (interne kartice). */
export function MastersTab({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Database className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Matični podaci</h2>
          <p className="text-xs text-ink-secondary">Referentni podaci raspoređeni po sekcijama</p>
        </div>
      </div>

      <p className="text-xs text-ink-secondary">
        Matični podaci su podeljeni: organizacija (kadrovska struktura), mašine (fizički resursi),
        predmeti (BigTehn cache + aktivacija). Mašine i profili održavanja ostaju u 1.0 do sledećeg talasa seobe.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LINKS.map((l) => {
          const Icon = l.icon;
          const body = (
            <>
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-secondary">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  {l.label}
                  {l.kind === 'external' && <ExternalLink className="h-3 w-3 text-ink-disabled" aria-hidden />}
                </div>
                <p className="mt-0.5 text-xs text-ink-secondary">{l.desc}</p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
            </>
          );
          const cls =
            'flex items-start gap-3 rounded-panel border border-line bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-surface-2';

          if (l.kind === 'external') {
            return (
              <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={cls}>
                {body}
              </a>
            );
          }
          // Interni tab — ako onNavigate nije prosleđen, fallback na next/link ka /podesavanja
          if (onNavigate) {
            return (
              <button key={l.tab} type="button" onClick={() => onNavigate(l.tab)} className={cls}>
                {body}
              </button>
            );
          }
          return (
            <Link key={l.tab} href="/podesavanja" className={cls}>
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
