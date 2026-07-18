'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DraftsTab } from '@/app/handovers/_components/drafts-tab';

/**
 * Nacrti primopredaje (MODULE_SPEC_nacrti_primopredaje §8, ODLUKE #33) —
 * radni prostor projektanata: kreiranje/uređivanje/predaja nacrta preko
 * GET/POST/PATCH/DELETE /v1/handover-drafts (handover-drafts.controller.ts).
 * Odvojen od /handovers (tok odobravanja — tehnolozi) da nav stavke ne dele
 * rutu i da projektant bez `primopredaje.approve` ima svoj ekran.
 */
export default function NacrtiPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

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

  // Posle predaje: ko sme da odobrava skače na tok odobravanja; projektant
  // ostaje ovde (lista se osvežava, nacrt nestaje iz nje).
  const onSubmitted = can(PERMISSIONS.PRIMOPREDAJE_APPROVE)
    ? () => router.push('/handovers')
    : undefined;

  return (
    <AppShell>
      <PageHeader title="Nacrti primopredaje" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <DraftsTab onSubmitted={onSubmitted} />
      </div>
    </AppShell>
  );
}
