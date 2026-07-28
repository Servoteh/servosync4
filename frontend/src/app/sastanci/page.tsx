'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { emitNavEvent, useQueryTab } from '@/lib/use-query-tab';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from './_components/tabs';
import { PregledTab } from './_components/pregled-tab';
import { SastanciTab } from './_components/sastanci-tab';
import { MojRadTab } from './_components/moj-rad-tab';
import { AkcioniPlanTab } from './_components/akcioni-plan-tab';
import { PmTemeTab } from './_components/pm-teme-tab';
import { PoProjektuTab } from './_components/po-projektu-tab';
import { DraftTemeTab } from './_components/draft-teme-tab';
import { SabloniTab } from './_components/sabloni-tab';
import { ArhivaTab } from './_components/arhiva-tab';
import { PodesavanjaTab } from './_components/podesavanja-tab';
import { CommandPalette } from './_components/command-palette';
import { SastanakDetalj } from './_components/sastanak-detalj';
import { DetailNavContext } from './_components/detail-nav';

type MainKey = 'pregled' | 'sastanci' | 'moj-rad' | 'akcioni' | 'podesavanja';
type GearKey = 'pm-teme' | 'po-projektu' | 'draft-teme' | 'sabloni' | 'arhiva';
type TabKey = MainKey | GearKey;

/**
 * Glavna tab-traka — vidi je svako ko vidi modul (`sastanci.read`), bez dodatnog gate-a.
 *
 * „Podešavanja" su ovde od 27.07 (ranije iza ⚙): to su LIČNA podešavanja mejl-obaveštenja
 * (`PATCH /sastanci/prefs` je self-service uz RLS po email claim-u), pa su posle F1 gate-a
 * ostala JEDINA ne-admin stavka u ⚙ meniju — sakrivena u „admin" fioci koju čitalačke
 * uloge inače nemaju razloga da otvaraju. AI model unutar taba ima svoj `Can`
 * (sastanci.ai_model), pa selidba ništa ne izlaže.
 */
const MAIN_ITEMS: TabItem<MainKey>[] = [
  { key: 'pregled', label: 'Pregled' },
  { key: 'sastanci', label: 'Sastanci' },
  { key: 'moj-rad', label: 'Moj rad' },
  { key: 'akcioni', label: 'Akcioni plan' },
  { key: 'podesavanja', label: 'Podešavanja' },
];

/**
 * ⚙ sekcije — IZVOR ISTINE za njihov gate (ogledalo u `navigation.ts`, deca modula „Sastanci").
 *
 * `sastanci.edit` = 1.0 `canEdit()` / `has_edit_role` krug (admin/menadzment/pm/leadpm/hr/
 * poslovni_admin) — jedini koji sme da mutira ono što ova 4 gejtovana ekrana nude (backend
 * `@RequirePermission(SASTANCI_EDIT)`: templates CRUD, teme, draft-review/uvedi, admin-rang,
 * dodeli). Do F1 su bili vidljivi SVIMA sa `sastanci.read` (paritet 1.0, koje ih takođe ne
 * gejtuje) — nalaz 1.
 *
 * „Arhiva" je od 27.07 opet BEZ `requires`: čitanje starih zapisnika pripada svakome ko vidi
 * modul (paritet 1.0). Tab je i sadržajno READ-ONLY — lista (`GET /sastanci/arhive`),
 * „Štampaj" (`GET :id/full` + potpisane slike) i „PDF" (`GET :id/arhiva/pdf`) su tri GET-a
 * koja na backendu stoje na KLASNOM `sastanci.read`; jedina mutacija nad arhivom
 * (`POST :id/arhiva/pdf`) živi u zaključavanju/detalju i nosi svoj `SASTANCI_EDIT`.
 * Red otvara `SastanakDetalj`, koji svoje akcije već gejtuje `Can`-om — dakle nema šta da
 * se dodatno gejtuje u samom tabu.
 */
const GEAR_ITEMS: { key: GearKey; label: string; requires?: Permission }[] = [
  { key: 'pm-teme', label: 'PM teme', requires: PERMISSIONS.SASTANCI_EDIT },
  { key: 'po-projektu', label: 'Po projektu', requires: PERMISSIONS.SASTANCI_EDIT },
  { key: 'draft-teme', label: 'Draft teme', requires: PERMISSIONS.SASTANCI_EDIT },
  { key: 'sabloni', label: 'Šabloni', requires: PERMISSIONS.SASTANCI_EDIT },
  { key: 'arhiva', label: 'Arhiva' },
];

// `?tab=` deep-link: podržani su i 1.0 id-jevi (sastanci/index.js MAIN/ADMIN_TABS)
// i direktna 2.0 imena. Alias mapa MORA da preživi — stari linkovi iz mejlova (pozivnice,
// zapisnici) i dalje stižu sa 1.0 imenima. Od F1 se URL i UPISUJE (uvek kanonski 2.0 ključ)
// kroz `useQueryTab`, pa deep-link, ručna promena taba i podmeni ostaju saglasni.
const TAB_DEEPLINK_ALIAS: Record<string, TabKey> = {
  dashboard: 'pregled',
  'akcioni-plan': 'akcioni',
  'pregled-projekti': 'po-projektu',
  'podesavanja-notif': 'podesavanja',
};
const VALID_TAB_KEYS: ReadonlySet<string> = new Set<TabKey>([
  ...MAIN_ITEMS.map((m) => m.key),
  ...GEAR_ITEMS.map((a) => a.key),
]);

/**
 * Sastanci — 3.0 TALAS B (MODULE_SPEC_sastanci_ai_30.md §4). 5 glavnih tabova
 * (Pregled/Sastanci/Moj rad/Akcioni plan/Podešavanja) + 5 sekcija iza ⚙ + komandna
 * paleta Ctrl/⌘+K. Paritet 1.0 sastanci/index.js. Vidljivost modula = sastanci.read;
 * 4 admin sekcije iza ⚙ dodatno traže `sastanci.edit` (F1 nalaz 1, vidi `GEAR_ITEMS`).
 */
export default function SastanciPage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  // ⚙ sekcije koje uloga sme da vidi (nalaz 1). Isti filter gejtuje i dropdown i deep-link.
  // Dok dozvole stižu `can()` je fail-closed → ⚙ kratko nudi samo negejtovane stavke
  // („Arhiva"), pa se dopuni; grešimo ka SKRIVANJU, nikad ka izlaganju.
  const visibleGearItems = useMemo(
    () => GEAR_ITEMS.filter((a) => !a.requires || can(a.requires)),
    [can],
  );
  // Prečice sa „Pregleda" ka „PM temama" prate ISTI gate (inače bi ih guard nemo vraćao).
  const canPmTeme = visibleGearItems.some((a) => a.key === 'pm-teme');
  // Naslov ⚙ prati sadržaj: edit krug vidi admin sekcije, a čitalačke uloge samo
  // negejtovane (danas „Arhiva") — njima bi „Admin sekcije" bilo pogrešno. Izvedeno iz
  // liste da ostane tačno i kad se sastav ⚙ menija promeni.
  const gearTitle = visibleGearItems.some((a) => a.requires)
    ? 'Admin sekcije'
    : visibleGearItems.map((a) => a.label).join(' · ');
  // Tab živi u `?tab=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3): čita na mount-u (uz 1.0
  // alias mapu), prati `popstate` i `servosync:nav` (podstavka „Sastanci → Akcioni plan"
  // menja tab i kad smo VEĆ ovde), a promena taba upisuje URL nazad (`history.replaceState`).
  const [tab, setTab] = useQueryTab<TabKey>('tab', 'pregled', {
    valid: VALID_TAB_KEYS,
    alias: TAB_DEEPLINK_ALIAS,
  });
  const [gearOpen, setGearOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const gearRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Tihi guard-redirect (obrazac iz podesavanja/page.tsx): deep-link na admin tab bez prava
  // (`/sastanci?tab=sabloni`) vraća na „Pregled" bez poruke — `setTab` uz to prepravlja URL
  // (`replaceState`), pa i highlight podstavke u sidebaru ostaje saglasan.
  // Čeka i `permissionsPending`: `/auth/me` i `/auth/me/permissions` su DVA paralelna upita
  // (isLoading ne pokriva drugi), a `can()` je dotle fail-closed — bez ovoga bi i admina sa
  // deep-linka na „Šablone" bacilo na Pregled dok dozvole stižu.
  // Gate je isključivo `requires`, pa negejtovane sekcije („Arhiva") i glavni tabovi
  // („Podešavanja") prolaze deep-link i čitalačkim ulogama — nema tihog vraćanja na Pregled.
  useEffect(() => {
    if (isLoading || permissionsPending || !user) return;
    const denied = GEAR_ITEMS.find((a) => a.key === tab && a.requires && !can(a.requires));
    if (denied) setTab('pregled');
  }, [isLoading, permissionsPending, user, can, tab, setTab]);

  // Detalj = stanje unutar strane (statički export nema dinamičkih ruta). Deep-link
  // `?open=<id>` + Back dugme browsera preko history.pushState/popstate. `?tab=` drži
  // `useQueryTab` (i on sluša popstate) — ovde ostaje samo `?open=`.
  useEffect(() => {
    const syncOpen = () => {
      const sp = new URLSearchParams(window.location.search);
      setOpenId(sp.get('open'));
    };
    syncOpen();
    window.addEventListener('popstate', syncOpen);
    return () => window.removeEventListener('popstate', syncOpen);
  }, []);

  // Otvaranje/zatvaranje detalja ČUVA `?tab=` u URL-u: od F1 je URL izvor istine za tab
  // (popstate ga ponovo čita), pa bi gubitak parametra po povratku iz detalja vratio
  // korisnika na „Pregled" umesto na tab sa kog je ušao. `emitNavEvent()` (bez detalja —
  // URL je već promenjen) drži highlight podstavke u sidebaru saglasnim sa URL-om.
  function openDetail(id: string) {
    setOpenId(id);
    window.history.pushState(null, '', `/sastanci?tab=${tab}&open=${id}`);
    emitNavEvent();
    window.scrollTo(0, 0);
  }
  function closeDetail() {
    setOpenId(null);
    window.history.pushState(null, '', `/sastanci?tab=${tab}`);
    emitNavEvent();
  }

  // Ctrl/⌘+K → komandna paleta.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Zatvori gear meni na Esc / klik van.
  useEffect(() => {
    if (!gearOpen) return;
    function onDown(e: MouseEvent) {
      if (gearRef.current && !gearRef.current.contains(e.target as Node)) setGearOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setGearOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [gearOpen]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const email = user.email;
  // Sekcija iz ⚙ nema svoje mesto u glavnoj traci, pa je zaglavlje jedino što kaže gde si.
  // Prefiks „Admin:" nosi samo gejtovana sekcija — „Arhiva" je read-only i svima.
  const gearItem = GEAR_ITEMS.find((a) => a.key === tab);
  const gearLabel = gearItem && (gearItem.requires ? `Admin: ${gearItem.label}` : gearItem.label);

  if (openId) {
    return (
      <AppShell>
        <SastanakDetalj id={openId} onBack={closeDetail} />
      </AppShell>
    );
  }

  return (
    <DetailNavContext.Provider value={{ open: openDetail }}>
    <AppShell>
      <PageHeader
        title="Sastanci"
        count={gearLabel}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              title="Pretraga (Ctrl+K)"
              className="flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Pretraga</span>
              <kbd className="hidden rounded bg-surface-2 px-1 text-2xs sm:inline">Ctrl K</kbd>
            </button>
            {/* ⚙ nudi SAMO dozvoljene sekcije i ne prikazuje se kad ih nema (nalaz 1);
                naziv prati sadržaj — ulozi bez admin sekcija ostaje samo „Arhiva". */}
            {visibleGearItems.length > 0 && (
              <div ref={gearRef} className="relative">
                <button
                  onClick={() => setGearOpen((o) => !o)}
                  title={gearTitle}
                  aria-expanded={gearOpen}
                  className="rounded-control border border-line p-1.5 text-ink-secondary hover:bg-surface-2"
                >
                  <Settings className="h-4 w-4" aria-hidden />
                </button>
                {gearOpen && (
                  <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-panel border border-line bg-surface py-1 shadow-lg">
                    {visibleGearItems.map((a) => (
                      <button
                        key={a.key}
                        onClick={() => {
                          setTab(a.key);
                          setGearOpen(false);
                        }}
                        className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${tab === a.key ? 'text-accent' : 'text-ink'}`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {!gearItem && (
          <Tabs tabs={MAIN_ITEMS} value={tab as MainKey} onChange={(k) => setTab(k)} ariaLabel="Sastanci" />
        )}

        {tab === 'pregled' && (
          <PregledTab
            myEmail={email}
            canPmTeme={canPmTeme}
            onJump={(t) => setTab(t === 'akcioni' ? 'akcioni' : t === 'pmteme' ? 'pm-teme' : 'sastanci')}
          />
        )}
        {tab === 'sastanci' && <SastanciTab />}
        {tab === 'moj-rad' && <MojRadTab myEmail={email} />}
        {tab === 'akcioni' && <AkcioniPlanTab myEmail={email} />}
        {tab === 'pm-teme' && <PmTemeTab myEmail={email} />}
        {tab === 'po-projektu' && <PoProjektuTab />}
        {tab === 'draft-teme' && <DraftTemeTab />}
        {tab === 'sabloni' && <SabloniTab />}
        {tab === 'arhiva' && <ArhivaTab />}
        {tab === 'podesavanja' && <PodesavanjaTab />}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
    </DetailNavContext.Provider>
  );
}
