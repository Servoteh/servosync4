'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from './_components/tabs';
import { ZaposleniTab } from './_components/zaposleni-tab';
import { OdmoriTab } from './_components/odmori-tab';
import { GridTab } from './_components/grid-tab';
import { PrisustvoTab } from './_components/prisustvo-tab';
import { RazvojTab } from './_components/razvoj-tab';
import { ZaradeTab } from './_components/zarade-tab';

type TabKey = 'zaposleni' | 'odmori' | 'sati' | 'prisustvo' | 'razvoj' | 'zarade';

/**
 * Kadrovska (HR) — 3.0 TALAS G (POSLEDNJI; PII + zarade).
 * Tabovi = 1.0 grupe (Zaposleni / Odmori / Radni sati / Prisustvo / Razvoj / Zarade).
 * Vidljivost modula = `kadrovska.read`; stroža prava po tabu/akciji (salary=admin,
 * pii=admin∨poslovni_admin, dev_manage, attendance_shadow…). FE krije afordanse;
 * backend guard + sy15 RLS presuđuju. R3 težište: PDF ćirilica generatori + QR bedževi.
 */
export default function KadrovskaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('zaposleni');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const canDev = can(PERMISSIONS.KADROVSKA_DEV_MANAGE);

  const tabs: TabItem<TabKey>[] = [
    { key: 'zaposleni', label: 'Zaposleni' },
    { key: 'odmori', label: 'Odmori' },
    { key: 'sati', label: 'Radni sati' },
    { key: 'prisustvo', label: 'Prisustvo' },
    ...(canDev ? [{ key: 'razvoj' as const, label: 'Razvoj i razgovori' }] : []),
    ...(canSalary ? [{ key: 'zarade' as const, label: 'Zarade' }] : []),
  ];

  return (
    <AppShell>
      <PageHeader title="Kadrovska" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Kadrovska" />

        {tab === 'zaposleni' && <ZaposleniTab />}
        {tab === 'odmori' && <OdmoriTab />}
        {tab === 'sati' && <GridTab />}
        {tab === 'prisustvo' && <PrisustvoTab />}
        {tab === 'razvoj' && canDev && <RazvojTab />}
        {tab === 'zarade' && canSalary && <ZaradeTab />}
      </div>
    </AppShell>
  );
}
