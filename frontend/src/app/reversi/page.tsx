'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useQueryTab } from '@/lib/use-query-tab';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import {
  useCuttingTools,
  useInventoryUnits,
  useMyIssuedTools,
  useReversiDocuments,
  useReversiMachines,
  useScrapped,
} from '@/api/reversi';
import { Tabs, type TabItem } from './_components/tabs';
import { WorkbenchTab } from './_components/workbench-tab';
import { MojiAlatiTab } from './_components/moji-alati-tab';
import { DokumentiTab } from './_components/dokumenti-tab';
import { InventarView } from './_components/inventar-view';
import { RezniAlatTab } from './_components/rezni-alat-tab';
import { MasineTab } from './_components/masine-tab';
import { OtpisanoTab } from './_components/otpisano-tab';

type TabKey = 'radni-sto' | 'moji' | 'dokumenti' | 'magacin' | 'rezni' | 'masine' | 'otpisano';

const TAB_KEYS: TabKey[] = ['radni-sto', 'moji', 'dokumenti', 'magacin', 'rezni', 'masine', 'otpisano'];
const TAB_STORAGE_KEY = 'reversi:tab';

/**
 * Legacy 1.0 id-jevi → 2.0 ključevi (paritet 1.0 `tabMigration.js`). JEDAN izvor istine za
 * dva potrošača: sačuvan izbor u `localStorage` (RA-05) i `?tab=` deep-link (F2, `alias`
 * opcija `useQueryTab`-a) — stari bookmark/link mora da nastavi da radi.
 */
const LEGACY_TAB_ALIAS: Record<string, TabKey> = {
  moja: 'moji',
  workbench: 'radni-sto',
  radni_sto: 'radni-sto',
  zaduzenja: 'dokumenti',
  inventar: 'magacin',
  unit: 'magacin',
  warehouse: 'magacin',
  'rezni-alat': 'rezni',
  cutting: 'rezni',
  scrapped: 'otpisano',
};

/**
 * Migracija sačuvanog taba (RA-05): prihvata 2.0 ključeve i mapira legacy 1.0 id-jeve.
 * Vraća `null` ako id nije prepoznat.
 */
function migrateTab(raw: string | null): TabKey | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  if ((TAB_KEYS as string[]).includes(id)) return id as TabKey;
  return LEGACY_TAB_ALIAS[id] ?? null;
}

/**
 * Reversi — 3.0 PILOT (MODULE_SPEC_reversi.md §6): zaduženja alata/LZO/kooperacije.
 * Tabovi: Moji alati / Izdavanje i povraćaj / Stanje magacina / Rezni alat / Mašine
 * / Otpisan alat. „Stanje magacina" nosi prekidač „Alat i oprema" ⇄ „Magacin
 * (zbirno)" (RA-08). Tabovi nose žive brojače (RA-04) i pamte se između poseta
 * (RA-05). Tab „Otpisano" je manage-only (paritet 1.0 `manageOnly`).
 */
export default function ReversiPage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  // Tab živi u `?tab=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3, F2), uz legacy alias mapu —
  // deep-link, klik na podstavku dok si već ovde i write-back URL-a pri promeni taba u strani.
  const [tab, setTab] = useQueryTab<TabKey>('tab', 'moji', {
    valid: TAB_KEYS,
    alias: LEGACY_TAB_ALIAS,
  });

  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // RA-05 — učitaj sačuvan tab posle mount-a (bez hydration mismatch-a), uz
  // validaciju protiv vidljivih tabova (manage gejtuje „Otpisano"). Bez sačuvanog
  // izbora magacioner (manage) startuje na „Radni sto" (paritet 1.0 default za magacionera).
  // F2: URL je JAČI od zapamćenog izbora — kad `?tab=` postoji (deep-link, klik na podstavku,
  // povratak Back-om), sačuvani tab se NE primenjuje da ne pregazi cilj navigacije.
  useEffect(() => {
    if (isLoading || !user) return;
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('tab')) return;
    const saved = migrateTab(window.localStorage.getItem(TAB_STORAGE_KEY));
    if (saved && (saved !== 'otpisano' || manage)) setTab(saved);
    else if (!saved && manage) setTab('radni-sto');
  }, [isLoading, user, manage, setTab]);

  // Tihi guard-redirect (obrazac F1): deep-link `?tab=otpisano` bez `reversi.manage` vraća na
  // „Moje alate" i prepravlja URL. Čeka `permissionsPending` — dok dozvole stižu `can()` je
  // fail-closed, pa bi i magacionera sa deep-linka bacilo nazad.
  useEffect(() => {
    if (isLoading || permissionsPending || !user) return;
    if (tab === 'otpisano' && !manage) setTab('moji');
  }, [isLoading, permissionsPending, user, tab, manage, setTab]);

  // RA-04 — živi brojači (deljeni query-key-evi sa tabovima → bez duplog fetcha;
  // documents/units su count-only pageSize=1).
  const myIssued = useMyIssuedTools();
  const docs = useReversiDocuments({ pageSize: 1 });
  const units = useInventoryUnits({ status: 'active', page: 1, pageSize: 1 });
  const cutting = useCuttingTools('');
  const machines = useReversiMachines();
  const scrapped = useScrapped();

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  function changeTab(k: TabKey) {
    setTab(k);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, k);
    } catch {
      /* localStorage nedostupan — tab se prosto ne pamti */
    }
  }

  const tabs: TabItem<TabKey>[] = [
    { key: 'radni-sto', label: 'Radni sto', count: null },
    { key: 'moji', label: 'Moji alati', count: myIssued.data?.data.length ?? null },
    { key: 'dokumenti', label: 'Izdavanje i povraćaj', count: docs.data?.meta.pagination.total ?? null },
    { key: 'magacin', label: 'Stanje magacina', count: units.data?.meta.pagination.total ?? null },
    { key: 'rezni', label: 'Rezni alat', count: cutting.data?.data.length ?? null },
    { key: 'masine', label: 'Mašine', count: machines.data?.data.length ?? null },
    ...(manage
      ? [{ key: 'otpisano' as const, label: 'Otpisan alat', count: scrapped.data?.data.length ?? null }]
      : []),
  ];

  return (
    <AppShell>
      <PageHeader title="Reversi" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={tabs} value={tab} onChange={changeTab} ariaLabel="Reversi" />

        {tab === 'radni-sto' && <WorkbenchTab onNavigate={changeTab} />}
        {tab === 'moji' && <MojiAlatiTab />}
        {tab === 'dokumenti' && <DokumentiTab />}
        {tab === 'magacin' && <InventarView />}
        {tab === 'rezni' && <RezniAlatTab />}
        {tab === 'masine' && <MasineTab />}
        {tab === 'otpisano' && manage && <OtpisanoTab />}
      </div>
    </AppShell>
  );
}
