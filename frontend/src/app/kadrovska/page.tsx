'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useQueryTab } from '@/lib/use-query-tab';
import { PERMISSIONS } from '@/lib/permissions';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { EmptyState } from '@/components/ui-kit/empty-state';
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
import { HelpProvider, HelpToggleButton, HelpBanner } from '@/components/ui-kit/help-mode';
import { HelpSpot } from '@/components/ui-kit/help-spot';
import { HelpTour } from '@/components/ui-kit/help-tour';
import { HELP, KADROVSKA_TOUR } from './_lib/help';

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
 * Vrednosti `?grupa=` (PODMENIJI F2, presuda §6.4 — meni nosi 5 GRUPA, ne 13 tabova).
 * `'hub'` je sentinel za landing sa velikim karticama i NE upisuje se u URL (`omitDefault`),
 * pa `/kadrovska` bez parametra ostaje hub kao dosad (paritet 1.0). Ključevi su ogledalo
 * dece modula „Kadrovska" u `navigation.ts`.
 */
type GroupParam = GroupKey | 'hub';
const GROUP_PARAM_KEYS: readonly GroupParam[] = ['hub', ...GROUP_DEFS.map((g) => g.id)];

/**
 * Kadrovska (HR) — 3.0 TALAS G (POSLEDNJI; PII + zarade).
 * IA = paritet 1.0: HUB landing (velike grupne kartice) → grupna traka + tabovi grupe.
 * Novi tab `pregled` (dashboard) je podrazumevani; ostalih 12 tabova + gate-ovi ostaju
 * nepromenjeni, samo konsolidovani u 5 grupa (ZERO-LOSS). Vidljivost modula =
 * `kadrovska.read`; stroža prava po tabu (salary=admin, imenik/contracts/dev/manage…).
 * FE krije afordanse; backend guard + sy15 RLS presuđuju.
 */
export default function KadrovskaPage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  // Grupa živi u `?grupa=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3, F2): `'hub'` = landing
  // (bez parametra u URL-u), sve ostalo je otvorena grupa. Hook čita na mount-u, prati
  // `popstate` i `servosync:nav` (podstavka „Kadrovska → Radni sati" menja grupu i kad smo
  // VEĆ ovde), a `setGroupParam` upisuje URL nazad → sidebar highlight prati klik u strani.
  // TAB unutar grupe ostaje interni state (13 tabova bi bilo previše za meni — presuda §6.4).
  const [group, setGroupParam] = useQueryTab<GroupParam>('grupa', 'hub', {
    valid: GROUP_PARAM_KEYS,
    omitDefault: true,
  });
  const [tab, setTab] = useState<TabKey>('pregled');

  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const canDev = can(PERMISSIONS.KADROVSKA_DEV_MANAGE);
  // Imenik = 1.0 canViewPhoneDirectory krug (admin/menadzment/hr/poslovni_admin);
  // GET /employees ostaje na kadrovska.read (Zaposleni tab ga legitimno koristi).
  const canImenik = can(PERMISSIONS.KADROVSKA_IMENIK);
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canManage = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canRead = can(PERMISSIONS.KADROVSKA_READ);
  // Prisustvo = paritet 1.0 canSeePrisustvo (attendance ∨ attendance_shadow); BE
  // @RequirePermission(ATTENDANCE) na /attendance/now + interni PrisustvoTab gating.
  const canAttendance = can(PERMISSIONS.KADROVSKA_ATTENDANCE);
  const canAttendanceShadow = can(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW);

  // Redirect: samo neprijavljen → /login. Prijavljen BEZ kadrovska.read se NE preusmerava
  // tiho (ranije `router.replace('/')` → korisnik bi „pao" na Radne naloge bez objašnjenja);
  // umesto toga render ispod prikazuje jasnu poruku „nemate pristup" sa ručnim izlazom.
  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

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
      prisustvo: canAttendance || canAttendanceShadow,
      zarade: canSalary,
    }),
    [canRead, canManage, canImenik, canContracts, canDev, canSalary, canAttendance, canAttendanceShadow],
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

  // Tihi guard-redirect (obrazac F1): `?grupa=zarade` bez `kadrovska.salary` (kao i svaka
  // grupa bez ijednog vidljivog taba za ovu ulogu) vraća na hub i prepravlja URL. Čeka
  // `permissionsPending` — dok dozvole stižu `can()` je fail-closed, pa je `groups` krnj i
  // legitiman deep-link bi bio poništen.
  useEffect(() => {
    if (isLoading || permissionsPending || !user) return;
    if (group !== 'hub' && !groups.some((g) => g.id === group)) setGroupParam('hub');
  }, [isLoading, permissionsPending, user, group, groups, setGroupParam]);

  // Tab prati grupu: kad grupa stigne SPOLJA (podstavka u sidebaru, deep-link, Back), interni
  // `tab` može biti iz druge grupe — tada pada na prvi vidljiv tab nove grupe. Klik u strani
  // (`openGroup`) tab već postavi, pa je ovde bez efekta (uslov `includes` je ispunjen).
  useEffect(() => {
    if (group === 'hub') return;
    const g = groups.find((x) => x.id === group);
    if (!g || g.tabs.length === 0) return;
    setTab((cur) => (g.tabs.includes(cur) ? cur : g.tabs[0]));
  }, [group, groups]);

  // Čeka i `permissionsPending`: `/auth/me` i `/auth/me/permissions` su dva paralelna upita
  // (isLoading ne pokriva drugi), a `canRead` je dotle fail-closed — bez ovoga bi svakom
  // korisniku na tren bljesnula poruka „Nemate pristup Kadrovskoj" (obrazac iz F1 nalaza 2).
  if (isLoading || permissionsPending || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  // Hard-guard (paritet 1.0): korisnik bez kadrovska.read NE renderuje modul. Umesto tihog
  // preusmeravanja (koje je izgledalo kao „otvorio mi se pogrešan tab — Radni nalozi"),
  // prikaži jasnu poruku sa ručnim izlazom. Backend ostaje krajnji autoritet (403 na rutama).
  if (!canRead) {
    return (
      <AppShell>
        <PageHeader title="Kadrovska" />
        <div className="grid flex-1 place-items-center p-6">
          <EmptyState
            title="Nemate pristup Kadrovskoj"
            hint={
              <span>
                Vaš nalog nema pravo pristupa ovom modulu. Ako mislite da je to greška, obratite se
                administratoru.{' '}
                <Link href="/" className="text-accent hover:underline">
                  Nazad na početnu
                </Link>
                .
              </span>
            }
          />
        </div>
      </AppShell>
    );
  }

  const firstTabOf = (gid: GroupKey): TabKey => groups.find((g) => g.id === gid)?.tabs[0] ?? 'pregled';

  /** Otvori grupu (default = prvi vidljiv tab), opciono skoči na konkretan tab. */
  function openGroup(gid: GroupKey, target?: TabKey) {
    setGroupParam(gid);
    setTab(target ?? firstTabOf(gid));
  }

  /** Deep-link iz dashboard-a: nađi grupu koja sadrži tab i otvori je na tom tabu. */
  function openTab(target: string) {
    const t = target as TabKey;
    const g = groups.find((grp) => grp.tabs.includes(t));
    if (g) openGroup(g.id, t);
  }

  const activeGroup = group === 'hub' ? null : (groups.find((g) => g.id === group) ?? null);
  const groupTabs: TabItem<TabKey>[] = activeGroup ? activeGroup.tabs.map((t) => ({ key: t, label: TAB_LABEL[t] })) : [];

  return (
    /* Uputstvo za rukovanje (info režim) — isti obrazac kao pilot na Zahtevima.
       Ko ne želi pomoć, ugasi je jednom („?" ili Shift+?) i ostaje ugašena na
       svim modulima (`servosync.help.enabled=false`). */
    <HelpProvider moduleKey="kadrovska" registry={HELP}>
    <AppShell>
      <PageHeader
        title="Kadrovska"
        actions={<HelpToggleButton />}
      />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <HelpBanner />
        {/* HUB landing — velike grupne kartice */}
        {!activeGroup ? (
          <section aria-label="Kadrovska — izbor grupe" className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Izaberi grupu</h2>
            <HelpSpot id="kadrovska.hub.grupe" variant="inline">
              <span className="text-sm text-ink-secondary">Pet celina modula</span>
            </HelpSpot>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => (
                /* „i" po pločici — ujedno i koraci vođene ture (help.ts). */
                <HelpSpot key={g.id} id={`kadrovska.hub.${g.id}`}>
                  <button
                    type="button"
                    onClick={() => openGroup(g.id)}
                    aria-label={g.label}
                    className="flex h-full w-full flex-col items-start gap-2 rounded-panel border border-line bg-surface p-5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <span className="text-3xl" aria-hidden>{g.icon}</span>
                    <span className="text-base font-semibold text-ink">{g.label}</span>
                    <span className="text-sm text-ink-secondary">{g.desc}</span>
                  </button>
                </HelpSpot>
              ))}
            </div>
          </section>
        ) : (
          <>
            {/* Grupna traka: „⊞ Grupe" (nazad na hub) + grupe */}
            <div className="flex flex-wrap items-center gap-1 rounded-panel border border-line bg-surface p-1">
              <button
                type="button"
                onClick={() => setGroupParam('hub')}
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
            {tab === 'prisustvo' && (canAttendance || canAttendanceShadow) && <PrisustvoTab />}
            {tab === 'zarade' && canSalary && <ZaradeTab />}
          </>
        )}
      </div>
      <HelpTour steps={KADROVSKA_TOUR} />
    </AppShell>
    </HelpProvider>
  );
}
