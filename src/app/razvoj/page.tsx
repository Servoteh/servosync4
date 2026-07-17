'use client';

// Razvojna faza 2.0 — indeks-stranica WIP modula (Talasi B–G: Sastanci, Održavanje,
// Projektni biro, Praćenje proizvodnje, Plan proizvodnje, Plan montaže, Podešavanja,
// Energetika, Lokacije). Ovi moduli su BE+FE izgrađeni (R1 read + R2 write, adversarni
// review po talasu) i spojeni na main, ali NISU prošli deploy-review/hub-integraciju
// kao Reversi/Kadrovska/Tehnologija — ovaj ekran postoji da admin/menadzment/HR mogu
// da ih testiraju PRE nego što svaki dobije trajno mesto u 1.0 hub-u (odluka Nenad
// 15.07.2026). Kartice su prosto linkovi na već postojeće rute — svaka i dalje nosi
// svoj sopstveni modul-specifičan authz gate (ova stranica samo grupiše/otkriva).
//
// Kad modul „diplomira" (prođe review + hub-integraciju), izlazi odavde i dobija
// trajnu karticu u 1.0 hub-u — vidi docs/PLAN_MODULA_MES_3.0.md §4 (1.0 repo).
//
// F0 SIDEBAR_HUB: label/icon/requires se sada vuku iz NAV_DOMAINS po href-u (ukinut je
// lokalni RAZVOJ_DOMAINS duplikat taksonomije; single source of truth = navigation.ts).
// Članstvo/napomene WIP modula = RAZVOJ_WIP; grupisanje/redosled = NAV_DOMAINS; emoji
// naslovi domena zadržani radi pariteta izgleda ove strane.

import Link from 'next/link';
import { FlaskConical } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { NAV_DOMAINS, RAZVOJ_WIP, findModuleByHref, type NavModule } from '@/lib/navigation';

// Emoji dekoracija naslova domena — /razvoj-specifično (NAV_DOMAINS nosi lucide ikone,
// ova indeks-strana zadržava stari emoji stil da izgled ostane nepromenjen).
const RAZVOJ_DOMAIN_EMOJI: Record<string, string> = {
  proizvodnja: '🏭',
  montaza: '🔧',
  projektovanje: '📐',
  logistika: '📦',
  'oprema-energija': '🛠️',
  saradnja: '🤝',
  sistem: '⚙️',
};

// Konteksta radi — moduli koji su VEĆ prošli ovaj isti proces i imaju trajno mesto
// u 1.0 hub-u (nisu deo testa, samo referenca da se vidi napredak).
const VEC_ZIVO_HREFS = ['/reversi', '/kadrovska'];

function ModuleCard({ module, note, label }: { module: NavModule; note?: string; label?: string }) {
  const Icon = module.icon;
  return (
    <Link
      href={module.href}
      className="flex items-start gap-3 rounded-panel border border-line bg-surface p-4 hover:border-accent hover:bg-surface-2"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-secondary" aria-hidden />
      <div className="min-w-0">
        {/* labelOverride čuva stare opisnije nazive ove strane (paritet). */}
        <div className="text-sm font-semibold text-ink">{label ?? module.label}</div>
        {note && <div className="mt-0.5 text-xs text-ink-secondary">{note}</div>}
      </div>
    </Link>
  );
}

export default function RazvojnaFazaPage() {
  const { can } = useAuth();
  const readOk = can(PERMISSIONS.RAZVOJ_READ);

  if (!readOk) {
    return (
      <AppShell>
        <PageHeader title="Razvojna faza 2.0" />
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-md rounded-panel border border-line bg-surface p-6 text-center">
            <div className="text-3xl">🔒</div>
            <h2 className="mt-2 text-md font-semibold text-ink">Pristup ograničen</h2>
            <p className="mt-1 text-sm text-ink-secondary">
              Razvojna faza je dostupna samo administratorima, menadžmentu i kadrovskoj administraciji.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  // Napomene WIP modula (po href-u) + grupisanje po domenima iz NAV_DOMAINS (redosled
  // domena = redosled u modelu). Modul se prikazuje samo uz `can(requires)`; prazan
  // domen se ne prikazuje — identično današnjem ponašanju.
  const wipByHref = new Map(RAZVOJ_WIP.map((w) => [w.href, w] as const));
  const visibleDomains = NAV_DOMAINS.map((domain) => ({
    domain,
    modules: domain.modules.filter(
      (m) => wipByHref.has(m.href) && (!m.requires || can(m.requires)),
    ),
  })).filter((g) => g.modules.length > 0);

  const visibleZivo = VEC_ZIVO_HREFS.map((href) => findModuleByHref(href)).filter(
    (m): m is NavModule => !!m && (!m.requires || can(m.requires)),
  );

  return (
    <AppShell>
      <PageHeader title="Razvojna faza 2.0" count="testni prikaz — Talasi B–G" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 flex items-start gap-3 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-status-warn" aria-hidden />
          <div className="text-sm text-status-warn">
            <p className="font-semibold">Moduli u razvoju — funkcionalnost se testira.</p>
            <p className="mt-0.5 text-status-warn/90">
              Ovi ekrani mogu biti nedovršeni ili nestabilni. Mutacije pišu u ISTU produkcionu
              bazu koju koristi i 1.0 — testiraj pažljivo. Kad modul prođe review, dobija
              trajno mesto u glavnom hub-u i nestaje odavde.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {visibleDomains.map(({ domain, modules }) => {
            const emoji = RAZVOJ_DOMAIN_EMOJI[domain.id];
            return (
              <section key={domain.id}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-secondary">
                  {emoji ? `${emoji} ${domain.title}` : domain.title}
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {modules.map((module) => (
                    <ModuleCard
                      key={module.href}
                      module={module}
                      note={wipByHref.get(module.href)?.note}
                      label={wipByHref.get(module.href)?.labelOverride}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {visibleZivo.length > 0 && (
          <div className="mt-8 border-t border-line pt-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-secondary">
              ✅ Već živo (za kontekst — nisu deo testa)
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleZivo.map((module) => (
                <ModuleCard key={module.href} module={module} />
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
