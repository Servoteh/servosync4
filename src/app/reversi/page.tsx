'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from './_components/tabs';
import { MojiAlatiTab } from './_components/moji-alati-tab';
import { DokumentiTab } from './_components/dokumenti-tab';
import { MagacinTab } from './_components/magacin-tab';
import { RezniAlatTab } from './_components/rezni-alat-tab';
import { MasineTab } from './_components/masine-tab';
import { OtpisanoTab } from './_components/otpisano-tab';

type TabKey = 'moji' | 'dokumenti' | 'magacin' | 'rezni' | 'masine' | 'otpisano';

/**
 * Reversi — 3.0 PILOT (MODULE_SPEC_reversi.md §6): zaduženja alata/LZO/kooperacije.
 * Tabovi: Moji alati / Izdavanje i povraćaj / Stanje magacina / Rezni alat / Mašine
 * / Otpisan alat. Izdaj/Vrati modali, kamera+HID skener i bulk-import su uključeni.
 * Tab „Otpisano" je manage-only (paritet 1.0 `manageOnly` taba).
 * Napomena: BE `/v1/reversi/*` (R1/R2) i `reversi.*` permisije još ne postoje —
 * do tada je modul dostupan tek kad backend katalog počne da emituje te permisije.
 */
export default function ReversiPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('moji');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const tabs: TabItem<TabKey>[] = [
    { key: 'moji', label: 'Moji alati' },
    { key: 'dokumenti', label: 'Izdavanje i povraćaj' },
    { key: 'magacin', label: 'Stanje magacina' },
    { key: 'rezni', label: 'Rezni alat' },
    { key: 'masine', label: 'Mašine' },
    ...(manage ? [{ key: 'otpisano' as const, label: 'Otpisan alat' }] : []),
  ];

  return (
    <AppShell>
      <PageHeader title="Reversi" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Reversi" />

        {tab === 'moji' && <MojiAlatiTab />}
        {tab === 'dokumenti' && <DokumentiTab />}
        {tab === 'magacin' && <MagacinTab />}
        {tab === 'rezni' && <RezniAlatTab />}
        {tab === 'masine' && <MasineTab />}
        {tab === 'otpisano' && manage && <OtpisanoTab />}
      </div>
    </AppShell>
  );
}
