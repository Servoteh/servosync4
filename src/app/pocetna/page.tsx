'use client';

// Hub početna (/pocetna) — F2 SIDEBAR_HUB. Landing stranica hub-uloga (admin,
// menadzment, leadpm, pm, poslovni_admin, hr, projektant_vodja, tehnolog); ostale
// uloge landuju direktno u modul (landing-route.ts). Živi UNUTAR AppShell-a (sidebar
// ostaje) — nije zaseban fullscreen. Četvrti obrazac ekrana „Hub/početna"
// (DESIGN_SYSTEM §4): agregira ulaz u module, ne zamenjuje listu/formu/master-detalj.
//
// Izvor navigacije = NAV_DOMAINS (jedan izvor istine, F0) → RBAC filter je IDENTIČAN
// sidebaru (stavka uz can(requires), prazan domen se preskače). „Brzo" traka vuče MRU
// iz useUiPrefs (isti store koji shell/paleta pune preko pushRecentModule). Guard i
// vidljivost = svaki prijavljen korisnik (bez posebne permisije; redirect na /login ako
// nema user — obrazac iz ostalih page.tsx).

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { EmptyState } from '@/components/ui-kit/empty-state';
import {
  NAV_DOMAINS,
  allModules,
  canAccessNavModule,
  findModuleByHref,
  navModuleMarkerTitle,
  type NavModule,
} from '@/lib/navigation';
import { useUiPrefs } from '@/lib/use-ui-prefs';

// Fallback „Brzo" prečice kad je MRU prazan (svež profil) — tri najčešća ulaza
// pogona/tehnologije. Filtriraju se RBAC-om kao i sve ostalo, pa korisnik bez prava
// ne vidi ni fallback stavku.
const QUICK_FALLBACK_HREFS = ['/work-orders', '/tech-processes', '/kvalitet'];

/** Srpska množina za broj modula (1 modul · 2–4/… modula). */
function moduliLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? `${n} modul` : `${n} modula`;
}

export default function PocetnaPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const { recentModules, pushRecentModule } = useUiPrefs();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekamo i dozvole (permissionsPending), ne samo /auth/me: hub gejtuje SVE preko
  // can() (fail-closed dok dozvole ne stignu), pa bi bez ovog čekanja prijavljen
  // korisnik na svež login/SSO video prolazni „Nema dostupnih modula" dok permsQuery
  // još stiže (['me'] je već pre-seed-ovan). Razlikuj učitavanje od stvarno-nula-modula.
  if (isLoading || !user || permissionsPending) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  // Vidljivi domeni/moduli po ulozi — RBAC filter IDENTIČAN sidebaru (app-shell):
  // stavka uz canAccessNavModule (requiresAny OR ima prednost), prazna pod-grupa i
  // prazan domen se preskaču. Iteriraju se i direktne stavke i pod-grupe („Tehnologija").
  const visibleDomains = NAV_DOMAINS.map((domain) => ({
    ...domain,
    modules: domain.modules.filter((m) => canAccessNavModule(m, can)),
    groups: domain.groups
      ?.map((g) => ({ ...g, modules: g.modules.filter((m) => canAccessNavModule(m, can)) }))
      .filter((g) => g.modules.length > 0),
  })).filter((domain) => domain.modules.length > 0 || (domain.groups?.length ?? 0) > 0);

  // „Brzo" = MRU (recentModules) razrešen na nav model + RBAC; fallback na fiksne
  // prečice kad je MRU prazan ili sve odsečeno pravima.
  const canSee = (m: NavModule | undefined): m is NavModule => !!m && canAccessNavModule(m, can);
  const recentResolved = recentModules.map((href) => findModuleByHref(href)).filter(canSee);
  const quickModules =
    recentResolved.length > 0
      ? recentResolved
      : QUICK_FALLBACK_HREFS.map((href) => findModuleByHref(href)).filter(canSee);

  // Jedan modul kao red u pločici — deljeno između direktnih stavki domena i stavki
  // pod-grupa. `external`/`crosslisted` (npr. pogonski /kiosk, „Lokacije delova" na dva
  // mesta) nose diskretnu „↗" oznaku, isto kao u sidebaru.
  const renderModule = (m: NavModule) => {
    const MIcon = m.icon;
    const marker = !!(m.external || m.crosslisted);
    const markerTitle = navModuleMarkerTitle(m);
    return (
      <li key={m.href}>
        <Link
          href={m.href}
          onClick={() => pushRecentModule(m.href)}
          title={markerTitle}
          // Touch-meta min 44×44px na tablet/telefon (DS §11) — isti bump kao sidebar
          // (app-shell max-lg:py-2.5); min-h-11 garant.
          className="group flex items-center gap-2.5 rounded-control px-2 py-1.5 text-base text-ink hover:bg-accent-subtle hover:text-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] max-lg:min-h-11 max-lg:py-2.5"
        >
          <MIcon
            className="h-4 w-4 shrink-0 text-ink-secondary group-hover:text-accent"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{m.label}</span>
          {marker && <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-disabled" aria-hidden />}
        </Link>
      </li>
    );
  };

  return (
    <AppShell>
      <PageHeader title="Početna" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-8">
          {/* Pozdrav */}
          <h2 className="text-lg text-ink-secondary">
            Dobrodošli, <span className="font-medium text-ink">{user.fullName ?? user.email}</span>
          </h2>

          {/* „Brzo" — MRU prečice kao pilule (accent-subtle → akcenat na hover). */}
          {quickModules.length > 0 && (
            <section aria-labelledby="hub-brzo">
              <h2
                id="hub-brzo"
                className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary"
              >
                Brzo
              </h2>
              <ul className="flex flex-wrap gap-2">
                {quickModules.map((m) => {
                  const Icon = m.icon;
                  return (
                    <li key={m.href}>
                      <Link
                        href={m.href}
                        onClick={() => pushRecentModule(m.href)}
                        // Touch-meta min 44×44px na tablet/telefon (DS §11) — isti bump
                        // kao sidebar (app-shell max-lg:py-2.5); min-h-11 garantuje visinu.
                        className="inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] max-lg:min-h-11 max-lg:py-2.5"
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="truncate">{m.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Mreža domenskih pločica — jedan izvor = NAV_DOMAINS, RBAC-filtrirano. */}
          {visibleDomains.length === 0 ? (
            // Dozvole učitane (permissionsPending je iznad odsekao loading): prazno je
            // ili stvarno-nula-modula ili PAD upita dozvola (retry:false → ostaje za
            // sesiju) — poruke se razlikuju da korisnik ne bi bio pogrešno upućen.
            permissionsError ? (
              <EmptyState
                title="Dozvole trenutno nisu dostupne"
                hint="Ne mogu da učitam vaše dozvole. Osvežite stranicu ili se obratite administratoru."
              />
            ) : (
              <EmptyState
                title="Nema dostupnih modula"
                hint="Vaš nalog trenutno nema pristup nijednom modulu. Obratite se administratoru."
              />
            )
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleDomains.map((domain) => {
                const DIcon = domain.icon;
                return (
                  <section
                    key={domain.id}
                    className="rounded-panel border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-accent hover:shadow-sm motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                  >
                    <div className="mb-3 flex items-center gap-3">
                      <span
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent"
                        aria-hidden
                      >
                        <DIcon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-md font-semibold text-ink">{domain.title}</h3>
                        <p className="tnums text-xs text-ink-secondary">
                          {/* Broji i direktne stavke i module pod-grupa (allModules). */}
                          {moduliLabel(allModules(domain).length)}
                        </p>
                      </div>
                    </div>
                    {domain.modules.length > 0 && (
                      <ul className="space-y-0.5">{domain.modules.map(renderModule)}</ul>
                    )}
                    {/* Imenovane pod-grupe (npr. „Tehnologija") kao odeljci sa verzalnim
                        naslovom — vizuelni paritet sa izdvojenom grupom u sidebaru. */}
                    {domain.groups?.map((g) => {
                      const GIcon = g.icon;
                      return (
                        <div key={g.id} className="mt-2">
                          <div className="mb-1 flex items-center gap-1.5 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">
                            <GIcon className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{g.title}</span>
                          </div>
                          <ul className="space-y-0.5">{g.modules.map(renderModule)}</ul>
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
