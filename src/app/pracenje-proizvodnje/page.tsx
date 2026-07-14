'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { useEnsureRn } from '@/api/pracenje';
import { KontrolnaTab } from './_components/kontrolna-tab';
import { PredmetiTab } from './_components/predmeti-tab';
import { PredmetView } from './_components/predmet-view';
import { RnView } from './_components/rn-view';
import { PretragaTab } from './_components/pretraga-tab';

type TabKey = 'kontrolna' | 'predmeti' | 'pretraga';
const TABS: TabItem<TabKey>[] = [
  { key: 'kontrolna', label: 'Kontrolna tabla' },
  { key: 'predmeti', label: 'Aktivni predmeti' },
  { key: 'pretraga', label: 'Pretraga delova' },
];

type Screen =
  | { kind: 'tab'; tab: TabKey }
  | { kind: 'predmet'; itemId: number; rootRn?: string }
  | { kind: 'rn'; rnId: string };

/**
 * Praćenje proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §4). Ekrani
 * 0→1→2→3 (Kontrolna tabla → Aktivni predmeti → Predmet → RN) + Pretraga delova.
 * Deep-link `?predmet=`/`?rn=`. Polling 30 s (u api hukovima). Vidljivost = pracenje.read.
 */
export default function PracenjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>({ kind: 'tab', tab: 'kontrolna' });
  const ensureRn = useEnsureRn();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Deep-link init.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const rn = sp.get('rn');
    const predmet = sp.get('predmet');
    if (rn) setScreen({ kind: 'rn', rnId: rn });
    else if (predmet) setScreen({ kind: 'predmet', itemId: Number(predmet) });
  }, []);

  const openPredmet = useCallback((itemId: number, rootRn?: string) => {
    setScreen({ kind: 'predmet', itemId, rootRn });
    window.history.replaceState(null, '', `/pracenje-proizvodnje?predmet=${itemId}`);
  }, []);

  const openRnUuid = useCallback((rnId: string) => {
    setScreen({ kind: 'rn', rnId });
    window.history.replaceState(null, '', `/pracenje-proizvodnje?rn=${rnId}`);
  }, []);

  const openRnBigtehn = useCallback(
    async (bigtehnRnId: string) => {
      try {
        const res = await ensureRn.mutateAsync({ workOrderId: bigtehnRnId });
        if (res.data.id) openRnUuid(res.data.id);
      } catch {
        /* ne uspeva ensure → ostani */
      }
    },
    [ensureRn, openRnUuid],
  );

  const backToTab = useCallback((tab: TabKey) => {
    setScreen({ kind: 'tab', tab });
    window.history.replaceState(null, '', '/pracenje-proizvodnje');
  }, []);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const activeTab = screen.kind === 'tab' ? screen.tab : 'predmeti';

  return (
    <AppShell>
      <PageHeader
        title="Praćenje proizvodnje"
        actions={
          screen.kind === 'tab' ? (
            <Tabs tabs={TABS} value={activeTab} onChange={(t) => backToTab(t)} ariaLabel="Ekrani Praćenja" />
          ) : undefined
        }
      />
      <main className="flex-1 overflow-auto p-6">
        {screen.kind === 'tab' && screen.tab === 'kontrolna' && <KontrolnaTab onOpenPredmet={openPredmet} />}
        {screen.kind === 'tab' && screen.tab === 'predmeti' && <PredmetiTab onOpenPredmet={openPredmet} />}
        {screen.kind === 'tab' && screen.tab === 'pretraga' && <PretragaTab onOpenRnBigtehn={openRnBigtehn} />}
        {screen.kind === 'predmet' && (
          <PredmetView
            itemId={screen.itemId}
            rootRn={screen.rootRn}
            onBack={() => backToTab('predmeti')}
            onOpenRnBigtehn={openRnBigtehn}
          />
        )}
        {screen.kind === 'rn' && <RnView rnId={screen.rnId} onBack={() => backToTab('predmeti')} />}
      </main>
    </AppShell>
  );
}
