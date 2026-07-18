'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
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

/**
 * Lokacije delova (fizičke `loc_*`) — 3.0 TALAS A seoba iz 1.0
 * (MODULE_SPEC_lokacije_30.md §4). 9 tabova: Početna / Pregled predmeta / Lokacije /
 * Stavke / Pregled po lokacijama / Istorija premeštanja / Štampa nalepnica /
 * Istorija definicija (manage) / Sync (admin). Skener (kamera+HID+ručno, dvokoračni
 * stavka→destinacija) i brzo premeštanje (11 tipova, idempotentno) su uključeni.
 * ⚠️ ODVOJENO od 2.0-native „Lokacije delova" (part-locations).
 */
export default function LokacijePage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('pocetna');
  const [stavkeSearch, setStavkeSearch] = useState('');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const labels = can(PERMISSIONS.LOKACIJE_LABELS);
  const manage = can(PERMISSIONS.LOKACIJE_MANAGE);
  const admin = can(PERMISSIONS.LOKACIJE_ADMIN);

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
      <PageHeader title="Lokacije" />

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
