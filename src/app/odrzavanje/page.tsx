'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import type { MachineListFilter } from './_components/common';
import { Tabs, type TabItem } from './_components/tabs';
import { PregledTab } from './_components/pregled-tab';
import { BoardTab } from './_components/board-tab';
import { NaloziTab } from './_components/nalozi-tab';
import { KvaroviTab } from './_components/kvarovi-tab';
import { MasineTab } from './_components/masine-tab';
import { PreventivaTab } from './_components/preventiva-tab';
import { KalendarTab } from './_components/kalendar-tab';
import { VozilaTab } from './_components/vozila-tab';
import { VozaciTab } from './_components/vozaci-tab';
import { SredstvaTab } from './_components/sredstva-tab';
import { ZaliheTab } from './_components/zalihe-tab';
import { DokumentaTab } from './_components/dokumenta-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { PodesavanjaTab } from './_components/podesavanja-tab';
import { NotifikacijeTab } from './_components/notifikacije-tab';

type TabKey =
  | 'pregled' | 'board' | 'nalozi' | 'kvarovi' | 'masine' | 'preventiva' | 'kalendar'
  | 'vozila' | 'vozaci' | 'it' | 'objekti' | 'zalihe'
  | 'dokumenta' | 'izvestaji' | 'podesavanja' | 'notifikacije';

/**
 * Održavanje (CMMS) — 3.0 TALAS F (MODULE_SPEC_odrzavanje_30.md §4).
 * Dvoslojni authz: coarse permisije gate-uju kapiju; FINU odluku (admin ekrani,
 * dugmad) donosi `/maintenance/me` (maintRole + gates). Row-scope presuđuje sy15 RLS.
 * Deep-link `?machine=<code>` otvara karton (paritet QR kartice sredstva).
 */
export default function OdrzavanjePage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('pregled');
  const [machineFilter, setMachineFilter] = useState<MachineListFilter>({});
  const meQ = useMaintMe();
  const me = meQ.data?.data;

  const openMachine = (code: string) => router.push(`/odrzavanje/masine?code=${encodeURIComponent(code)}`);
  /** Dashboard/board klik → prebaci tab (uz opcioni preset filtera operativne liste). */
  const gotoTab = (key: TabKey, filter?: MachineListFilter) => {
    setMachineFilter(filter ?? {});
    setTab(key);
  };

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Legacy deep-link `/odrzavanje?machine=<code>` → nova ruta kartona (presuda §8.3, QR paritet).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const code = new URLSearchParams(window.location.search).get('machine');
    if (code) router.replace(`/odrzavanje/masine?code=${encodeURIComponent(code)}`);
  }, [router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const canReport = can(PERMISSIONS.ODRZAVANJE_REPORT);
  const showNotifs = me?.gates.canAccessMaintNotifications ?? false;
  const showAdmin = can(PERMISSIONS.ODRZAVANJE_ADMIN_UI);

  const tabs: TabItem<TabKey>[] = [
    { key: 'pregled', label: 'Pregled' },
    { key: 'board', label: 'Tabla' },
    { key: 'nalozi', label: 'Radni nalozi' },
    { key: 'kvarovi', label: 'Kvarovi' },
    { key: 'masine', label: 'Mašine' },
    { key: 'preventiva', label: 'Preventiva' },
    { key: 'kalendar', label: 'Kalendar' },
    { key: 'vozila', label: 'Vozila' },
    { key: 'vozaci', label: 'Vozači' },
    { key: 'it', label: 'IT oprema' },
    { key: 'objekti', label: 'Objekti' },
    { key: 'zalihe', label: 'Zalihe' },
    { key: 'dokumenta', label: 'Dokumenta' },
    { key: 'izvestaji', label: 'Izveštaji' },
    ...(showAdmin ? [{ key: 'podesavanja' as const, label: 'Podešavanja' }] : []),
    ...(showNotifs ? [{ key: 'notifikacije' as const, label: 'Notifikacije' }] : []),
  ];

  return (
    <AppShell>
      <PageHeader title="Održavanje" count={me?.maintRole ? `uloga: ${me.maintRole}` : undefined} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* Profil-info baner: samo kad korisnik nema ni maint profil ni floor-read (§4.1). */}
        {me && !me.profile && !me.floorRead && !me.erpAdminOrManagement && (
          <div className="flex items-start gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" aria-hidden />
            <span>Nemate dodeljen profil održavanja — vidljivost sredstava je ograničena. Prijava kvara je i dalje moguća.</span>
          </div>
        )}

        <Tabs tabs={tabs} value={tab} onChange={(k) => { setMachineFilter({}); setTab(k); }} ariaLabel="Održavanje" />

        {tab === 'pregled' && <PregledTab onOpenMachine={openMachine} onNavigate={gotoTab} me={me} canReport={canReport} />}
        {tab === 'board' && <BoardTab onOpenMachine={openMachine} />}
        {tab === 'nalozi' && <NaloziTab me={me} />}
        {tab === 'kvarovi' && <KvaroviTab me={me} canReport={canReport} />}
        {tab === 'masine' && <MasineTab me={me} initFilter={machineFilter} />}
        {tab === 'preventiva' && <PreventivaTab me={me} onNavigate={gotoTab} />}
        {tab === 'kalendar' && <KalendarTab onNavigate={gotoTab} />}
        {tab === 'vozila' && <VozilaTab me={me} />}
        {tab === 'vozaci' && <VozaciTab me={me} />}
        {tab === 'it' && <SredstvaTab kind="it" me={me} />}
        {tab === 'objekti' && <SredstvaTab kind="facility" me={me} />}
        {tab === 'zalihe' && <ZaliheTab me={me} />}
        {tab === 'dokumenta' && <DokumentaTab me={me} />}
        {tab === 'izvestaji' && <IzvestajiTab />}
        {tab === 'podesavanja' && showAdmin && <PodesavanjaTab me={me} />}
        {tab === 'notifikacije' && showNotifs && <NotifikacijeTab me={me} />}
      </div>
    </AppShell>
  );
}
