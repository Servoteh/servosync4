'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useQueryTab } from '@/lib/use-query-tab';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '../reversi/_components/tabs';
import { PocetnaTab } from './_components/pocetna-tab';
import { PredmetTab } from './_components/predmet-tab';
import { LokacijeTab } from './_components/lokacije-tab';
import { StavkeTab } from './_components/stavke-tab';
import { ReportTab } from './_components/report-tab';
import { MovementsTab } from './_components/movements-tab';
import { StampaTab } from './_components/stampa-tab';
import { AuditTab } from './_components/audit-tab';
import { SyncTab } from './_components/sync-tab';

type TabKey =
  | 'pocetna' | 'predmet' | 'lokacije' | 'stavke' | 'report'
  | 'pokreti' | 'stampa' | 'audit' | 'sync';

/** Ključevi `?tab=` — ujedno OGLEDALO dece modula „Lokacije" u `navigation.ts`. */
const TAB_KEYS: readonly TabKey[] = [
  'pocetna', 'predmet', 'lokacije', 'stavke', 'report', 'pokreti', 'stampa', 'audit', 'sync',
];
/** Tabovi sa strožim gate-om (izvor istine za `requires` dece u nav modelu). */
const GATED_TABS: Partial<Record<TabKey, Permission>> = {
  stampa: PERMISSIONS.LOKACIJE_LABELS,
  audit: PERMISSIONS.LOKACIJE_MANAGE,
  sync: PERMISSIONS.LOKACIJE_ADMIN,
};

/**
 * Lokacije delova (fizičke `loc_*`) — 3.0 TALAS A seoba iz 1.0
 * (MODULE_SPEC_lokacije_30.md §4). 9 tabova: Početna / Pregled predmeta / Lokacije /
 * Stavke / Pregled po lokacijama / Istorija premeštanja / Štampa nalepnica /
 * Istorija definicija (manage) / Sync (admin). Skener (kamera+HID+ručno, dvokoračni
 * stavka→destinacija) i brzo premeštanje (11 tipova, idempotentno) su uključeni.
 * ⚠️ ODVOJENO od 2.0-native „Lokacije delova" (part-locations).
 */
export default function LokacijePage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  // Tab živi u `?tab=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3, F2) — deep-link, klik na
  // podstavku dok si već ovde i write-back URL-a pri promeni taba u strani.
  const [tab, setTab] = useQueryTab<TabKey>('tab', 'pocetna', { valid: TAB_KEYS });
  const [stavkeSearch, setStavkeSearch] = useState('');

  const labels = can(PERMISSIONS.LOKACIJE_LABELS);
  const manage = can(PERMISSIONS.LOKACIJE_MANAGE);
  const admin = can(PERMISSIONS.LOKACIJE_ADMIN);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Tihi guard-redirect (obrazac F1): deep-link na gejtovan tab (`?tab=sync` bez
  // `lokacije.admin`) vraća na „Početnu" i prepravlja URL. Čeka `permissionsPending` —
  // dok dozvole stižu `can()` je fail-closed.
  useEffect(() => {
    if (isLoading || permissionsPending || !user) return;
    const need = GATED_TABS[tab];
    if (need && !can(need)) setTab('pocetna');
  }, [isLoading, permissionsPending, user, tab, can, setTab]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const tabs: TabItem<TabKey>[] = [
    { key: 'pocetna', label: 'Početna' },
    { key: 'predmet', label: 'Pregled predmeta' },
    { key: 'lokacije', label: 'Lokacije' },
    { key: 'stavke', label: 'Stavke' },
    { key: 'report', label: 'Pregled po lokacijama' },
    { key: 'pokreti', label: 'Istorija premeštanja' },
    ...(labels ? [{ key: 'stampa' as const, label: 'Štampa nalepnica' }] : []),
    ...(manage ? [{ key: 'audit' as const, label: 'Istorija definicija' }] : []),
    ...(admin ? [{ key: 'sync' as const, label: 'Sync' }] : []),
  ];

  function goStavke(q: string) {
    setStavkeSearch(q);
    setTab('stavke');
  }

  return (
    <AppShell>
      <PageHeader
        title="Lokacije"
        actions={
          /* Mobilni režim (paritet 1.0 magacin) — /mob/lokacije, namerno VAN /m/*
             (worker proxy sve /m/* šalje na 1.0). Otvoriti na telefonu. */
          <button
            onClick={() => router.push('/mob/lokacije')}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            📱 Mobilni režim
          </button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="overflow-x-auto">
          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Lokacije" />
        </div>

        {tab === 'pocetna' && <PocetnaTab onGoStavke={goStavke} onGoLabels={labels ? () => setTab('stampa') : undefined} />}
        {tab === 'predmet' && <PredmetTab />}
        {tab === 'lokacije' && <LokacijeTab />}
        {tab === 'stavke' && <StavkeTab key={stavkeSearch} initialSearch={stavkeSearch} />}
        {tab === 'report' && <ReportTab />}
        {tab === 'pokreti' && <MovementsTab />}
        {tab === 'stampa' && labels && <StampaTab />}
        {tab === 'audit' && manage && <AuditTab />}
        {tab === 'sync' && admin && <SyncTab />}
      </div>
    </AppShell>
  );
}
