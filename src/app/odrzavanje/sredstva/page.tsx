'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import { SredstvoKarton } from '../_components/sredstvo-karton';

/**
 * Karton IT opreme / objekta — RUTA (`/odrzavanje/sredstva?id=<uuid>&kind=<it|facility>&tab=`),
 * konzistentno sa kartonom mašine/vozila. Query-param umesto `[id]` segmenta jer je build
 * `output: "export"` (statički Cloudflare Pages) → deep-link po tabu, browser Nazad i QR
 * cold-load rade. Bez `id`/nevalidan `kind` → vrati na listu (`/odrzavanje`).
 */
export default function SredstvoKartonPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useMaintMe();
  const [state, setState] = useState<{ id: string; kind: 'it' | 'facility' } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get('id');
    const kind = sp.get('kind');
    if (id && (kind === 'it' || kind === 'facility')) setState({ id, kind });
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
        {state ? <SredstvoKarton kind={state.kind} id={state.id} me={meQ.data?.data} /> : (
          <p className="py-10 text-center text-sm text-ink-secondary">Nedostaje ID sredstva.</p>
        )}
      </div>
    </AppShell>
  );
}
