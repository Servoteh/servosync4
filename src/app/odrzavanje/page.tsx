'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import { Tabs, type TabItem } from './_components/tabs';
import { PregledTab } from './_components/pregled-tab';
import { NaloziTab } from './_components/nalozi-tab';
import { KvaroviTab } from './_components/kvarovi-tab';
import { MasineTab } from './_components/masine-tab';
import { PreventivaTab } from './_components/preventiva-tab';
import { VozilaTab } from './_components/vozila-tab';
import { VozaciTab } from './_components/vozaci-tab';
import { SredstvaTab } from './_components/sredstva-tab';
import { ZaliheTab } from './_components/zalihe-tab';
import { DokumentaTab } from './_components/dokumenta-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { PodesavanjaTab } from './_components/podesavanja-tab';
import { NotifikacijeTab } from './_components/notifikacije-tab';
import { MasinaCardDialog } from './_components/masina-card-dialog';

type TabKey =
  | 'pregled' | 'nalozi' | 'kvarovi' | 'masine' | 'preventiva'
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
  const [deepMachine, setDeepMachine] = useState<string | null>(null);
  const meQ = useMaintMe();
  const me = meQ.data?.data;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('machine');
    if (code) setDeepMachine(code);
  }, []);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const canReport = can(PERMISSIONS.ODRZAVANJE_REPORT);
  const showNotifs = me?.gates.canAccessMaintNotifications ?? false;
  const showAdmin = can(PERMISSIONS.ODRZAVANJE_ADMIN_UI);

  const tabs: TabItem<TabKey>[] = [
    { key: 'pregled', label: 'Pregled' },
    { key: 'nalozi', label: 'Radni nalozi' },
    { key: 'kvarovi', label: 'Kvarovi' },
    { key: 'masine', label: 'Mašine' },
    { key: 'preventiva', label: 'Preventiva' },
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

        <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Održavanje" />

        {tab === 'pregled' && <PregledTab onOpenMachine={setDeepMachine} />}
        {tab === 'nalozi' && <NaloziTab me={me} />}
        {tab === 'kvarovi' && <KvaroviTab me={me} canReport={canReport} />}
        {tab === 'masine' && <MasineTab me={me} />}
        {tab === 'preventiva' && <PreventivaTab me={me} />}
        {tab === 'vozila' && <VozilaTab me={me} />}
        {tab === 'vozaci' && <VozaciTab me={me} />}
        {tab === 'it' && <SredstvaTab kind="it" me={me} />}
        {tab === 'objekti' && <SredstvaTab kind="facility" me={me} />}
        {tab === 'zalihe' && <ZaliheTab me={me} />}
        {tab === 'dokumenta' && <DokumentaTab me={me} />}
        {tab === 'izvestaji' && <IzvestajiTab />}
        {tab === 'podesavanja' && showAdmin && <PodesavanjaTab />}
        {tab === 'notifikacije' && showNotifs && <NotifikacijeTab />}
      </div>

      {/* Deep-link karton mašine (QR / klik iz Pregleda) — nezavisno od taba. */}
      <MasinaCardDialog code={deepMachine} me={me} onClose={() => setDeepMachine(null)} />
    </AppShell>
  );
}
