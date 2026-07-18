'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import { VoziloKarton, VoziloKartonByCode } from '../_components/vozilo-karton';

/**
 * Karton vozila — RUTA (`/odrzavanje/vozila?id=<uuid>&tab=<tab>`), konzistentno sa kartonom
 * mašine (`/odrzavanje/masine?code=`). Query-param umesto `[id]` segmenta jer je build
 * `output: "export"` (statički Cloudflare Pages, bez SPA fallback-a). Deep-link po tabu,
 * browser Nazad i QR cold-load rade.
 *
 * Prihvata I `?code=<asset_code>` (H22): odštampane QR nalepnice i 1.0 router
 * (`/maintenance/assets/vehicles/<code>`) ključaju vozilo po šifri, ne UUID-u — resolver
 * `VoziloKartonByCode` razrešava code→id. Bez `id`/`code` → vrati na listu (`/odrzavanje`).
 */
export default function VoziloKartonPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useMaintMe();
  const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get('id');
    const c = sp.get('code');
    if (v) setId(v);
    else if (c) setCode(c);
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
        {id ? <VoziloKarton id={id} me={meQ.data?.data} /> : code ? <VoziloKartonByCode code={code} me={meQ.data?.data} /> : (
          <p className="py-10 text-center text-sm text-ink-secondary">Nedostaje ID vozila.</p>
        )}
      </div>
    </AppShell>
  );
}
