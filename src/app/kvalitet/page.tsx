'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { cn } from '@/lib/cn';
import { NONCONFORMITY_TYPE, useQualityMini } from '@/api/kvalitet';
import { EvidencijaTab } from './_components/evidencija-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { DokumentiTab } from './_components/dokumenti-tab';
import { KontrolaPogonTab } from './_components/kontrola-pogon-tab';

type TabKey = 'skart' | 'dorada' | 'izvestaji' | 'dokumenti' | 'pogon';

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
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('skart');
  const mini = useQualityMini();

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

  const draftScrap = mini.data?.data.draftScrap ?? 0;
  const draftRework = mini.data?.data.draftRework ?? 0;

  const tabs: { key: TabKey; label: string; badge?: number }[] = [
    { key: 'skart', label: 'Evidencija škarta', badge: draftScrap },
    { key: 'dorada', label: 'Evidencija dorada', badge: draftRework },
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
          {tab === 'izvestaji' && <IzvestajiTab />}
          {tab === 'dokumenti' && <DokumentiTab />}
          {tab === 'pogon' && <KontrolaPogonTab />}
        </div>
      </div>
    </AppShell>
  );
}
