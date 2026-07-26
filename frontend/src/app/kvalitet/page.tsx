'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useQueryTab } from '@/lib/use-query-tab';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { cn } from '@/lib/cn';
import { NONCONFORMITY_TYPE, useQualityMini } from '@/api/kvalitet';
import { QUALITY_EVENT_STATUS, useQualityEvents } from '@/api/kvalitet-events';
import { EvidencijaTab } from './_components/evidencija-tab';
import { AktivnostTab } from './_components/aktivnost-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { DokumentiTab } from './_components/dokumenti-tab';
import { KontrolaPogonTab } from './_components/kontrola-pogon-tab';
import { SkartDoradaTab } from './_components/skart-dorada-tab';
import { PERMISSIONS } from '@/lib/permissions';

type TabKey =
  | 'skart'
  | 'dorada'
  | 'skart-dorada'
  | 'aktivnost'
  | 'izvestaji'
  | 'dokumenti'
  | 'pogon';

/** Ključevi `?tab=` — ujedno OGLEDALO dece modula „Kontrola kvaliteta" u `navigation.ts`. */
const TAB_KEYS: readonly TabKey[] = ['skart', 'dorada', 'skart-dorada', 'aktivnost', 'izvestaji', 'dokumenti', 'pogon'];

/** Broj draft-ova na tab labeli (žuti bedž) — radna lista kontrolora. */
function DraftBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="tnums ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-status-warn-bg px-1 text-2xs font-semibold text-status-warn">
      {count}
    </span>
  );
}

export default function KvalitetPage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  // Tab živi u `?tab=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3, F2): čita na mount-u,
  // prati `popstate` i `servosync:nav` (podstavka „Kontrola kvaliteta → Dokumenti" menja tab
  // i kad smo VEĆ ovde — Next ne remount-uje stranu na promenu samog query-ja), a promena
  // taba u strani upisuje URL nazad (`history.replaceState`) → sidebar highlight prati.
  const [tab, setTab] = useQueryTab<TabKey>('tab', 'skart', { valid: TAB_KEYS });
  const mini = useQualityMini();
  // Red čekanja prijava (novi tab „Škart i dorada") — brojač na labeli.
  const pending = useQualityEvents({ status: QUALITY_EVENT_STATUS.PRIJAVLJEN });
  const pendingCount = pending.data?.meta.pendingCount ?? 0;

  // „Aktivnost kontrole" (K4) čita evidenciju kucanja (`tech-processes`) — bez
  // `tehnologija.read` bi svaki upit vratio 403, pa se tab tada i ne nudi.
  const mayReadLog = can(PERMISSIONS.TEHNOLOGIJA_READ);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Tihi guard-redirect (obrazac iz podesavanja/sastanci, F1): deep-link `?tab=aktivnost` bez
  // `tehnologija.read` vraća na „Evidenciju škarta" i prepravlja URL. Čeka `permissionsPending`
  // (dva paralelna upita — `can()` je dotle fail-closed), da tehnologa ne baci sa deep-linka.
  // Napomena: `?tab=skart-dorada` (mejl/zvonce) hvata sam `useQueryTab` jer je u TAB_KEYS.
  useEffect(() => {
    if (isLoading || permissionsPending || !user) return;
    if (tab === 'aktivnost' && !mayReadLog) setTab('skart');
  }, [isLoading, permissionsPending, user, tab, mayReadLog, setTab]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const draftScrap = mini.data?.data.skart.drafts ?? 0;
  const draftRework = mini.data?.data.dorada.drafts ?? 0;

  const tabs: { key: TabKey; label: string; badge?: number }[] = [
    { key: 'skart', label: 'Evidencija škarta', badge: draftScrap },
    { key: 'dorada', label: 'Evidencija dorada', badge: draftRework },
    { key: 'skart-dorada', label: 'Škart i dorada', badge: pendingCount },
    ...(mayReadLog ? ([{ key: 'aktivnost', label: 'Aktivnost kontrole' }] as const) : []),
    { key: 'izvestaji', label: 'Izveštaji' },
    { key: 'dokumenti', label: 'Dokumenti' },
    { key: 'pogon', label: 'Kontrola pogon' },
  ];

  return (
    <AppShell>
      <PageHeader title="Kontrola kvaliteta" />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line bg-surface px-6">
          <div className="flex items-center gap-1" role="tablist" aria-label="Kontrola kvaliteta">
            {tabs.map((t) => {
              const active = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    '-mb-px flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none',
                    active
                      ? 'border-accent text-accent'
                      : 'border-transparent text-ink-secondary hover:text-ink',
                  )}
                >
                  {t.label}
                  {t.badge != null && <DraftBadge count={t.badge} />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {tab === 'skart' && <EvidencijaTab type={NONCONFORMITY_TYPE.SCRAP} />}
          {tab === 'dorada' && <EvidencijaTab type={NONCONFORMITY_TYPE.REWORK} />}
          {tab === 'skart-dorada' && <SkartDoradaTab />}
          {tab === 'aktivnost' && mayReadLog && <AktivnostTab />}
          {tab === 'izvestaji' && <IzvestajiTab />}
          {tab === 'dokumenti' && <DokumentiTab />}
          {tab === 'pogon' && <KontrolaPogonTab />}
        </div>
      </div>
    </AppShell>
  );
}
