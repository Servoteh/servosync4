'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
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

type MainKey = 'pregled' | 'sastanci' | 'moj-rad' | 'akcioni';
type AdminKey = 'pm-teme' | 'po-projektu' | 'draft-teme' | 'sabloni' | 'arhiva' | 'podesavanja';
type TabKey = MainKey | AdminKey;

const ADMIN_ITEMS: { key: AdminKey; label: string }[] = [
  { key: 'pm-teme', label: 'PM teme' },
  { key: 'po-projektu', label: 'Po projektu' },
  { key: 'draft-teme', label: 'Draft teme' },
  { key: 'sabloni', label: 'Šabloni' },
  { key: 'arhiva', label: 'Arhiva' },
  { key: 'podesavanja', label: 'Podešavanja' },
];

// `?tab=` deep-link: podržani su i 1.0 id-jevi (sastanci/index.js MAIN/ADMIN_TABS)
// i direktna 2.0 imena. Samo ČITANJE, i to SAMO na mount — ručna promena taba NE
// ažurira URL (1.0 paritet), a popstate čita samo `?open=` (vidi effect).
const TAB_DEEPLINK_ALIAS: Record<string, TabKey> = {
  dashboard: 'pregled',
  'akcioni-plan': 'akcioni',
  'pregled-projekti': 'po-projektu',
  'podesavanja-notif': 'podesavanja',
};
const VALID_TAB_KEYS: ReadonlySet<string> = new Set<TabKey>([
  'pregled', 'sastanci', 'moj-rad', 'akcioni',
  ...ADMIN_ITEMS.map((a) => a.key),
]);

/**
 * Sastanci — 3.0 TALAS B (MODULE_SPEC_sastanci_ai_30.md §4). 4 glavna taba
 * (Pregled/Sastanci/Moj rad/Akcioni plan) + 6 admin tabova iza ⚙ + komandna
 * paleta Ctrl/⌘+K. Paritet 1.0 sastanci/index.js. Vidljivost = sastanci.read.
 */
export default function SastanciPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('pregled');
  const [gearOpen, setGearOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const gearRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Detalj = stanje unutar strane (statički export nema dinamičkih ruta). Deep-link
  // `?open=<id>` + `?tab=<id>` (glavni/admin tab; 1.0 alias-i) + Back dugme
  // browsera preko history.pushState/popstate.
  //
  // `?tab=` se primenjuje SAMO na mount: pushState za detalj ne briše query, pa
  // bi popstate (Back iz detalja) ponovo pročitao zastareli deep-link tab i
  // pregazio tab koji je korisnik u međuvremenu ručno izabrao. popstate zato
  // čita samo `?open=`.
  const tabAppliedRef = useRef(false);
  useEffect(() => {
    const syncOpen = () => {
      const sp = new URLSearchParams(window.location.search);
      setOpenId(sp.get('open'));
    };
    if (!tabAppliedRef.current) {
      tabAppliedRef.current = true;
      const rawTab = new URLSearchParams(window.location.search).get('tab');
      if (rawTab) {
        const mapped = TAB_DEEPLINK_ALIAS[rawTab] ?? rawTab;
        if (VALID_TAB_KEYS.has(mapped)) setTab(mapped as TabKey);
      }
    }
    syncOpen();
    window.addEventListener('popstate', syncOpen);
    return () => window.removeEventListener('popstate', syncOpen);
  }, []);

  function openDetail(id: string) {
    setOpenId(id);
    window.history.pushState(null, '', `/sastanci?open=${id}`);
    window.scrollTo(0, 0);
  }
  function closeDetail() {
    setOpenId(null);
    window.history.pushState(null, '', '/sastanci');
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
  const mainTabs: TabItem<MainKey>[] = [
    { key: 'pregled', label: 'Pregled' },
    { key: 'sastanci', label: 'Sastanci' },
    { key: 'moj-rad', label: 'Moj rad' },
    { key: 'akcioni', label: 'Akcioni plan' },
  ];
  const isAdminTab = ADMIN_ITEMS.some((a) => a.key === tab);
  const adminLabel = ADMIN_ITEMS.find((a) => a.key === tab)?.label;

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
        count={isAdminTab ? `Admin: ${adminLabel}` : undefined}
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
            <div ref={gearRef} className="relative">
              <button
                onClick={() => setGearOpen((o) => !o)}
                title="Admin sekcije"
                aria-expanded={gearOpen}
                className="rounded-control border border-line p-1.5 text-ink-secondary hover:bg-surface-2"
              >
                <Settings className="h-4 w-4" aria-hidden />
              </button>
              {gearOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-panel border border-line bg-surface py-1 shadow-lg">
                  {ADMIN_ITEMS.map((a) => (
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
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {!isAdminTab && (
          <Tabs tabs={mainTabs} value={tab as MainKey} onChange={(k) => setTab(k)} ariaLabel="Sastanci" />
        )}

        {tab === 'pregled' && (
          <PregledTab
            myEmail={email}
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
