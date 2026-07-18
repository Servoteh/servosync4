'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { KorisniciTab } from './_components/korisnici-tab';
import { UlogeTab } from './_components/uloge-tab';
import { GridEditorsTab } from './_components/grid-editors-tab';
import { SistemTab } from './_components/system-tab';
import { AuditTab } from './_components/read-tabs';
import { OrganizacijaTab } from './_components/organizacija-tab';
import { KompetencijeTab } from './_components/kompetencije-tab';
import { PredmetAktivacijaTab } from './_components/predmet-aktivacija-tab';
import { CompanyProfileTab } from './_components/company-profile-tab';
import { ExpectationsTab } from './_components/expectations-tab';
import { NotifikacijeTab } from './_components/notifikacije-tab';
import { IntegracijeTab } from './_components/integracije-tab';
import { MastersTab } from './_components/masters-tab';
import { IzgledTab } from './_components/izgled-tab';

type TabKey =
  | 'korisnici'
  | 'uloge'
  | 'grid'
  | 'organizacija'
  | 'masters'
  | 'vrednosti'
  | 'ocekivanja'
  | 'kompetencije'
  | 'predmet'
  | 'notifikacije'
  | 'integracije'
  | 'audit'
  | 'sistem'
  | 'izgled';

const TAB_DEFS: { key: TabKey; label: string; requires: Permission }[] = [
  { key: 'korisnici', label: 'Korisnici', requires: PERMISSIONS.SETTINGS_USERS },
  { key: 'uloge', label: 'Uloge i dozvole', requires: PERMISSIONS.SETTINGS_USERS },
  { key: 'grid', label: 'Grid urednici', requires: PERMISSIONS.SETTINGS_USERS },
  { key: 'organizacija', label: 'Organizacija', requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
  { key: 'masters', label: 'Matični podaci', requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
  { key: 'vrednosti', label: 'Vrednosti firme', requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
  { key: 'ocekivanja', label: 'Očekivanja', requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
  { key: 'kompetencije', label: 'Kompetencije', requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
  { key: 'predmet', label: 'Predmeti', requires: PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA },
  { key: 'notifikacije', label: 'Notifikacije', requires: PERMISSIONS.SETTINGS_SYSTEM },
  { key: 'integracije', label: 'Integracije', requires: PERMISSIONS.SETTINGS_SYSTEM },
  { key: 'audit', label: 'Audit log', requires: PERMISSIONS.SETTINGS_AUDIT },
  { key: 'sistem', label: 'Sistem', requires: PERMISSIONS.SETTINGS_SYSTEM },
  // „Izgled" = lične UI preference (layout + tema) — vidljivo SVAKOM prijavljenom
  // (profile.self), nije admin-only (SIDEBAR_THEME_SPEC §5).
  { key: 'izgled', label: 'Izgled', requires: PERMISSIONS.PROFILE_SELF },
];

/**
 * Podešavanja — RBAC admin konzola + matični + sistem — 3.0 TALAS D (§3.3/§4).
 * Korisnici = jezgro (dvostrano upravljanje nalozima D1: invite/edit/reset/deactivate/delete
 * u 2.0 i sy15). Uloge i dozvole = živ katalog. Ostali tabovi (org/vrednosti/očekivanja/
 * kompetencije/predmet/audit/sistem) su READ prikaz — unos je R2 (BE write nije izložen).
 * Tabovi Mašine + Održ. profili NE sele se u D (Talas F). Vidljivost tabova = per-permisija.
 */
export default function PodesavanjaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

  const visibleTabs = useMemo(() => TAB_DEFS.filter((t) => can(t.requires)), [can]);
  const [tab, setTab] = useState<TabKey>('korisnici');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Deep-link na tab (npr. /podesavanja?tab=izgled iz „Moj profil" — jedini ulaz u
  // Izgled za korisnike bez SETTINGS_ORG_PROFILE, koji ne vide Podešavanja u nav-u).
  // Klijentski (window), static-export-safe; guard efekat ispod koriguje ako tab nije
  // dostupan ovoj ulozi.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested && TAB_DEFS.some((t) => t.key === requested)) setTab(requested as TabKey);
  }, []);

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((t) => t.key === tab)) setTab(visibleTabs[0].key);
  }, [visibleTabs, tab]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  if (visibleTabs.length === 0) {
    return (
      <AppShell>
        <PageHeader title="Podešavanja" />
        <div className="grid flex-1 place-items-center p-6 text-sm text-ink-secondary">
          Podešavanja su dostupna korisnicima sa admin / menadžment / pm / lead pm rolom.
        </div>
      </AppShell>
    );
  }

  const tabs: TabItem<TabKey>[] = visibleTabs.map((t) => ({ key: t.key, label: t.label }));

  return (
    <AppShell>
      <PageHeader title="Podešavanja" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Podešavanja" />
        {tab === 'korisnici' && <KorisniciTab />}
        {tab === 'uloge' && <UlogeTab />}
        {tab === 'grid' && <GridEditorsTab />}
        {tab === 'organizacija' && <OrganizacijaTab />}
        {tab === 'masters' && <MastersTab onNavigate={(t) => setTab(t as TabKey)} />}
        {tab === 'vrednosti' && <CompanyProfileTab />}
        {tab === 'ocekivanja' && <ExpectationsTab />}
        {tab === 'kompetencije' && <KompetencijeTab />}
        {tab === 'predmet' && <PredmetAktivacijaTab />}
        {tab === 'notifikacije' && <NotifikacijeTab onNavigate={(t) => setTab(t as TabKey)} />}
        {tab === 'integracije' && <IntegracijeTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'sistem' && <SistemTab />}
        {tab === 'izgled' && <IzgledTab />}
      </div>
    </AppShell>
  );
}
