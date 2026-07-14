'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from './_components/tabs';
import { PregledTab } from './_components/pregled/pregled-tab';
import { ZaposleniTab } from './_components/zaposleni-tab';
import { ImenikTab } from './_components/imenik-tab';
import { OdmoriTab } from './_components/odmori-tab';
import { OdsustvaTab } from './_components/odsustva/odsustva-tab';
import { GridTab } from './_components/grid-tab';
import { PrisustvoTab } from './_components/prisustvo-tab';
import { RazvojTab } from './_components/razvoj-tab';
import { OnboardingTab } from './_components/onboarding-tab';
import { NotifikacijeTab } from './_components/notifikacije-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { ZaradeTab } from './_components/zarade-tab';
import { UgovoriTab } from './_components/ugovori/ugovori-tab';

type TabKey =
  | 'pregled'
  | 'zaposleni'
  | 'imenik'
  | 'ugovori'
  | 'odmori'
  | 'odsustva'
  | 'sati'
  | 'prisustvo'
  | 'razvoj'
  | 'onboarding'
  | 'notifikacije'
  | 'izvestaji'
  | 'zarade';

type GroupKey = 'pregled' | 'zaposleni' | 'odmori' | 'sati' | 'zarade';

/** Grupe (paritet 1.0 KADR_GROUPS) — konsoliduju tabove; redosled = prikaz. */
const GROUP_DEFS: { id: GroupKey; label: string; icon: string; desc: string; tabs: TabKey[] }[] = [
  { id: 'pregled', label: 'Pregled', icon: '🏠', desc: 'Statistika, izveštaji, notifikacije', tabs: ['pregled', 'izvestaji', 'notifikacije'] },
  { id: 'odmori', label: 'Odmori i odsustva', icon: '🏖️', desc: 'Godišnji odmor, zahtevi, odobravanja, odsustva, kalendar', tabs: ['odmori', 'odsustva'] },
  { id: 'sati', label: 'Radni sati', icon: '📊', desc: 'Mesečni grid i prisustvo', tabs: ['sati', 'prisustvo'] },
  { id: 'zaposleni', label: 'Zaposleni', icon: '👥', desc: 'Kartoni, ugovori, imenik, plan razvoja, uvođenje', tabs: ['zaposleni', 'imenik', 'ugovori', 'razvoj', 'onboarding'] },
  { id: 'zarade', label: 'Zarade', icon: '💰', desc: 'Uslovi i obračun zarada', tabs: ['zarade'] },
];

/**
 * Kadrovska (HR) — 3.0 TALAS G (POSLEDNJI; PII + zarade).
 * IA = paritet 1.0: HUB landing (velike grupne kartice) → grupna traka + tabovi grupe.
 * Novi tab `pregled` (dashboard) je podrazumevani; ostalih 12 tabova + gate-ovi ostaju
 * nepromenjeni, samo konsolidovani u 5 grupa (ZERO-LOSS). Vidljivost modula =
 * `kadrovska.read`; stroža prava po tabu (salary=admin, imenik/contracts/dev/manage…).
 * FE krije afordanse; backend guard + sy15 RLS presuđuju.
 */
export default function KadrovskaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  // group === null → HUB landing (izbor grupe). Podrazumevani tab (u grupi) = 'pregled'.
  const [group, setGroup] = useState<GroupKey | null>(null);
  const [tab, setTab] = useState<TabKey>('pregled');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const canDev = can(PERMISSIONS.KADROVSKA_DEV_MANAGE);
  // Imenik = 1.0 canViewPhoneDirectory krug (admin/menadzment/hr/poslovni_admin);
  // GET /employees ostaje na kadrovska.read (Zaposleni tab ga legitimno koristi).
  const canImenik = can(PERMISSIONS.KADROVSKA_IMENIK);
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canManage = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canRead = can(PERMISSIONS.KADROVSKA_READ);

  // Vidljivost taba (postojeći permisijski uslovi; zaposleni/odmori/odsustva/sati/prisustvo = read-baseline).
  const tabVisible: Record<TabKey, boolean> = useMemo(
    () => ({
      pregled: canRead,
      izvestaji: canRead,
      notifikacije: canManage,
      zaposleni: true,
      imenik: canImenik,
      ugovori: canContracts,
      razvoj: canDev,
      onboarding: canManage,
      odmori: true,
      odsustva: true,
      sati: true,
      prisustvo: true,
      zarade: canSalary,
    }),
    [canRead, canManage, canImenik, canContracts, canDev, canSalary],
  );

  const TAB_LABEL: Record<TabKey, string> = {
    pregled: 'Pregled',
    izvestaji: 'Izveštaji',
    notifikacije: 'Notifikacije',
    zaposleni: 'Zaposleni',
    imenik: 'Imenik',
    ugovori: 'Ugovori',
    razvoj: 'Razvoj i razgovori',
    onboarding: 'Uvođenje/Izlazak',
    odmori: 'Odmori',
    odsustva: 'Odsustva',
    sati: 'Radni sati',
    prisustvo: 'Prisustvo',
    zarade: 'Zarade',
  };

  // Grupe sa bar jednim vidljivim tabom (za rolu) → prikaz na hub-u i u traci.
  const groups = useMemo(
    () =>
      GROUP_DEFS.map((g) => ({ ...g, tabs: g.tabs.filter((t) => tabVisible[t]) })).filter((g) => g.tabs.length > 0),
    [tabVisible],
  );

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const firstTabOf = (gid: GroupKey): TabKey => groups.find((g) => g.id === gid)?.tabs[0] ?? 'pregled';

  /** Otvori grupu (default = prvi vidljiv tab), opciono skoči na konkretan tab. */
  function openGroup(gid: GroupKey, target?: TabKey) {
    setGroup(gid);
    setTab(target ?? firstTabOf(gid));
  }

  /** Deep-link iz dashboard-a: nađi grupu koja sadrži tab i otvori je na tom tabu. */
  function openTab(target: string) {
    const t = target as TabKey;
    const g = groups.find((grp) => grp.tabs.includes(t));
    if (g) openGroup(g.id, t);
  }

  const activeGroup = group ? groups.find((g) => g.id === group) : null;
  const groupTabs: TabItem<TabKey>[] = activeGroup ? activeGroup.tabs.map((t) => ({ key: t, label: TAB_LABEL[t] })) : [];

  return (
    <AppShell>
      <PageHeader title="Kadrovska" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* HUB landing — velike grupne kartice */}
        {!activeGroup ? (
          <section aria-label="Kadrovska — izbor grupe" className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Izaberi grupu</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => openGroup(g.id)}
                  aria-label={g.label}
                  className="flex flex-col items-start gap-2 rounded-panel border border-line bg-surface p-5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                >
                  <span className="text-3xl" aria-hidden>{g.icon}</span>
                  <span className="text-base font-semibold text-ink">{g.label}</span>
                  <span className="text-sm text-ink-secondary">{g.desc}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            {/* Grupna traka: „⊞ Grupe" (nazad na hub) + grupe */}
            <div className="flex flex-wrap items-center gap-1 rounded-panel border border-line bg-surface p-1">
              <button
                type="button"
                onClick={() => setGroup(null)}
                className="rounded-control px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
                title="Nazad na izbor grupa"
              >
                ⊞ Grupe
              </button>
              <span className="mx-1 h-5 w-px bg-line" aria-hidden />
              {groups.map((g) => {
                const on = g.id === activeGroup.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => openGroup(g.id)}
                    className={cn(
                      'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
                      on ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
                    )}
                  >
                    <span aria-hidden>{g.icon}</span> {g.label}
                  </button>
                );
              })}
            </div>

            {/* Tabovi aktivne grupe */}
            {groupTabs.length > 1 && <Tabs tabs={groupTabs} value={tab} onChange={setTab} ariaLabel={activeGroup.label} />}

            {/* Sadržaj taba (12 postojećih + novi pregled; gate-ovi nepromenjeni) */}
            {tab === 'pregled' && canRead && <PregledTab onOpenTab={openTab} />}
            {tab === 'izvestaji' && canRead && <IzvestajiTab />}
            {tab === 'notifikacije' && canManage && <NotifikacijeTab />}
            {tab === 'zaposleni' && <ZaposleniTab />}
            {tab === 'imenik' && canImenik && <ImenikTab />}
            {tab === 'ugovori' && canContracts && <UgovoriTab />}
            {tab === 'razvoj' && canDev && <RazvojTab />}
            {tab === 'onboarding' && canManage && <OnboardingTab />}
            {tab === 'odmori' && <OdmoriTab />}
            {tab === 'odsustva' && <OdsustvaTab onNavigateGrid={() => openTab('sati')} />}
            {tab === 'sati' && <GridTab />}
            {tab === 'prisustvo' && <PrisustvoTab />}
            {tab === 'zarade' && canSalary && <ZaradeTab />}
          </>
        )}
      </div>
    </AppShell>
  );
}
