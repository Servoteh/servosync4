'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import type { OpRow } from '@/api/plan-proizvodnje';
import { BridgeBanner } from './_components/bridge-banner';
import { PoMasiniTab } from './_components/po-masini-tab';
import { PoCrtezuTab } from './_components/po-crtezu-tab';
import { ZauzetostTab } from './_components/zauzetost-tab';
import { PregledSvihTab } from './_components/pregled-svih-tab';
import { KooperacijaTab } from './_components/kooperacija-tab';
import { ReassignDialog } from './_components/reassign-dialog';
import { TpProcedureModal } from './_components/tp-procedure-modal';
import { SkiceModal } from './_components/skice-modal';

type TabKey = 'po-masini' | 'po-crtezu' | 'zauzetost' | 'pregled' | 'kooperacija';

const TABS: TabItem<TabKey>[] = [
  { key: 'po-masini', label: 'Po mašini' },
  { key: 'po-crtezu', label: 'Po crtežu' },
  { key: 'zauzetost', label: 'Zauzetost mašina' },
  { key: 'pregled', label: 'Pregled svih' },
  { key: 'kooperacija', label: 'Kooperacija' },
];

/**
 * Plan proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §4). 5 tabova
 * (Po mašini/Po crtežu/Zauzetost/Pregled svih/Kooperacija). Vidljivost = plan_proizvodnje.read;
 * mutacije = plan_proizvodnje.edit; force reassign = plan_proizvodnje.force; auto-koop = koop_admin.
 */
export default function PlanProizvodnjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('po-masini');

  // Reassign radi nad PUNIM redovima (GAP-PM-24 — filtriranje kandidata po grupi mašine).
  const [reassignRows, setReassignRows] = useState<OpRow[] | null>(null);
  const [tpWo, setTpWo] = useState<string | null>(null);
  const [skice, setSkice] = useState<{ wo: string; line: string } | null>(null);
  // GAP-PM-12 — skok iz Zauzetost/Pregled u „Po mašini" sa preselektovanom mašinom.
  const [jumpMachine, setJumpMachine] = useState<string | null>(null);

  const jumpToPoMasini = (machineCode: string) => {
    setJumpMachine(machineCode);
    setTab('po-masini');
  };

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const onReassign = (o: OpRow) => setReassignRows([o]);
  const onTp = (o: OpRow) => setTpWo(o.work_order_id);
  const onSkice = (o: OpRow) => setSkice({ wo: o.work_order_id, line: o.line_id });

  return (
    <AppShell>
      <PageHeader
        title="Plan proizvodnje"
        actions={<Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Tabovi Plana proizvodnje" />}
      />
      <main className="flex-1 space-y-4 overflow-auto p-6">
        <BridgeBanner />
        {tab === 'po-masini' && (
          <PoMasiniTab
            onReassign={onReassign}
            onBulkReassign={setReassignRows}
            onTp={onTp}
            onSkice={onSkice}
            jumpTo={jumpMachine}
            onJumpConsumed={() => setJumpMachine(null)}
          />
        )}
        {tab === 'po-crtezu' && (
          <PoCrtezuTab onBulkReassign={setReassignRows} onReassign={onReassign} onTp={onTp} onSkice={onSkice} />
        )}
        {tab === 'zauzetost' && <ZauzetostTab onJumpToPoMasini={jumpToPoMasini} />}
        {tab === 'pregled' && <PregledSvihTab onJumpToPoMasini={jumpToPoMasini} />}
        {tab === 'kooperacija' && <KooperacijaTab />}
      </main>

      {reassignRows && (
        <ReassignDialog open onClose={() => setReassignRows(null)} rows={reassignRows} />
      )}
      {tpWo && <TpProcedureModal workOrderId={tpWo} onClose={() => setTpWo(null)} />}
      {skice && <SkiceModal workOrder={skice.wo} line={skice.line} onClose={() => setSkice(null)} />}
    </AppShell>
  );
}
