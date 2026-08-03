'use client';

// Mobilni „Novi izveštaj" (/mob/izvestaj) — slobodan tekst + fotke → AI → preview → snimi + PDF.
// Reuse punog wizarda (IzvestajWizard); po zatvaranju nazad na /mob/montaza. Vidljivost = montaza.read.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { IzvestajWizard } from '../../montaza/_components/izvestaj-wizard';

export default function MobileIzvestajPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/mob/prijava');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-dvh place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <main className="min-h-dvh bg-app p-3">
      <IzvestajWizard onClose={() => router.push('/mob/montaza')} />
    </main>
  );
}
