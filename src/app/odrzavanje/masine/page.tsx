'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useMaintMe } from '@/api/odrzavanje';
import { MasinaKarton } from '../_components/masina-karton';

/**
 * Karton mašine — RUTA (presuda §8.3). URL: `/odrzavanje/masine?code=<šifra>&tab=<tab>`.
 * Query-param umesto `[code]` filesystem segmenta jer je build `output: "export"` (statički
 * Cloudflare Pages, bez SPA fallback-a) → dinamički segment bi pao na cold-load/QR skeniranju.
 * Ovako je isto REALNA ruta (deep-link po tabu, browser Nazad, QR cold-load rade), po
 * obrascu ostalih 2.0 modula (montaza `?view=`). Legacy `/odrzavanje?machine=` redirektuje ovamo.
 */
export default function MasinaKartonPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useMaintMe();
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const c = new URLSearchParams(window.location.search).get('code');
    if (c) setCode(c);
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
        {code ? <MasinaKarton code={code} me={meQ.data?.data} /> : (
          <p className="py-10 text-center text-sm text-ink-secondary">Nedostaje šifra mašine.</p>
        )}
      </div>
    </AppShell>
  );
}
