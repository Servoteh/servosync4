'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import { useEnsureRn, resolveRn } from '@/api/pracenje';
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

  // Deep-link paritet (PR-25): ?predmet=/?rn=/&root=/#tab= → ekran. URL je izvor istine za
  // restore; popstate (browser back/forward) potpuno restaurira ekran bez napuštanja modula.
  const screenFromUrl = useCallback((): Screen => {
    const sp = new URLSearchParams(window.location.search);
    const rn = sp.get('rn');
    const predmet = sp.get('predmet');
    const root = sp.get('root') || undefined;
    if (rn) return { kind: 'rn', rnId: rn };
    if (predmet) return { kind: 'predmet', itemId: Number(predmet), rootRn: root };
    const hashTab = window.location.hash.replace(/^#tab=/, '') as TabKey;
    const tab: TabKey = (['kontrolna', 'predmeti', 'pretraga'] as const).includes(hashTab) ? hashTab : 'kontrolna';
    return { kind: 'tab', tab };
  }, []);

  // Init iz URL-a na mount + popstate/hashchange (paritet 1.0 pracenjeRouter popstate).
  useEffect(() => {
    setScreen(screenFromUrl());
    const onNav = () => setScreen(screenFromUrl());
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, [screenFromUrl]);

  const openPredmet = useCallback((itemId: number, rootRn?: string) => {
    setScreen({ kind: 'predmet', itemId, rootRn });
    const url = `/pracenje-proizvodnje?predmet=${itemId}${rootRn ? `&root=${encodeURIComponent(rootRn)}` : ''}`;
    window.history.pushState(null, '', url);
  }, []);

  const openRnUuid = useCallback((rnId: string) => {
    setScreen({ kind: 'rn', rnId });
    window.history.pushState(null, '', `/pracenje-proizvodnje?rn=${rnId}`);
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
    // #tab= očuvanje (paritet 1.0) — root ekran nosi hash umesto query parametara.
    window.history.pushState(null, '', tab === 'kontrolna' ? '/pracenje-proizvodnje' : `/pracenje-proizvodnje#tab=${tab}`);
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
        {screen.kind === 'tab' && <RnLoader onOpenRn={openRnUuid} />}
        {screen.kind === 'tab' && screen.tab === 'kontrolna' && <KontrolnaTab onOpenPredmet={openPredmet} />}
        {screen.kind === 'tab' && screen.tab === 'predmeti' && <PredmetiTab onOpenPredmet={openPredmet} />}
        {screen.kind === 'tab' && screen.tab === 'pretraga' && (
          <PretragaTab onOpenRnBigtehn={openRnBigtehn} onOpenRnUuid={openRnUuid} />
        )}
        {screen.kind === 'predmet' && (
          <PredmetView
            itemId={screen.itemId}
            rootRn={screen.rootRn}
            onBack={() => backToTab('predmeti')}
            onOpenRnBigtehn={openRnBigtehn}
          />
        )}
        {screen.kind === 'rn' && <RnView key={screen.rnId} rnId={screen.rnId} onBack={() => backToTab('predmeti')} />}
      </main>
    </AppShell>
  );
}

/** RN loader toolbar (PR-02): unos RN broja/UUID → resolveRn → otvori RN. */
function RnLoader({ onOpenRn }: { onOpenRn: (rnId: string) => void }) {
  const [ref, setRef] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    const q = ref.trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await resolveRn(q);
      if (res.data?.id) {
        onOpenRn(res.data.id);
        setRef('');
      } else {
        toast('RN nije pronađen.');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'RN nije pronađen. Proveri broj ili UUID.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
        Direktan ulaz u RN
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void load();
            }
          }}
          placeholder="RN broj ili UUID"
          className="h-8 w-64 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink placeholder:text-ink-disabled"
        />
      </label>
      <Button variant="secondary" onClick={() => void load()} disabled={loading || !ref.trim()}>
        {loading ? 'Učitavam…' : 'Učitaj RN'}
      </Button>
    </div>
  );
}
