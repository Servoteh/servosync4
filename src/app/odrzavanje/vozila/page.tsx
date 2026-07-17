'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import { VoziloKarton } from '../_components/vozilo-karton';

/**
 * Karton vozila — RUTA (`/odrzavanje/vozila?id=<uuid>&tab=<tab>`), konzistentno sa kartonom
 * mašine (`/odrzavanje/masine?code=`). Query-param umesto `[id]` segmenta jer je build
 * `output: "export"` (statički Cloudflare Pages, bez SPA fallback-a). Deep-link po tabu,
 * browser Nazad i QR cold-load rade. Nedostaje `id` → vrati na listu (`/odrzavanje`).
 */
export default function VoziloKartonPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useMaintMe();
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = new URLSearchParams(window.location.search).get('id');
    if (v) setId(v);
    else router.replace('/odrzavanje');
  }, [router]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <AppShell>
      <PageHeader title="Održavanje" />
      <div className="flex-1 overflow-auto p-6">
        {id ? <VoziloKarton id={id} me={meQ.data?.data} /> : (
          <p className="py-10 text-center text-sm text-ink-secondary">Nedostaje ID vozila.</p>
        )}
      </div>
    </AppShell>
  );
}
