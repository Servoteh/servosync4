'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { landingRoute } from '@/lib/landing-route';

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    // Hibrid po ulozi (landing-route.ts): hub-uloge → /pocetna, kontrolor/kontrola@ →
    // /kvalitet, ostali → /work-orders (rn.read imaju SVE uloge — nema 403). U iframe-u
    // (2.0 kao modul „Tehnologija" u 1.0 shell-u, koji već ima svoj HUB) hub-uloge
    // preskaču /pocetna i padaju na modul-metu — otud `embedded` = smo li unutar okvira.
    const embedded = typeof window !== 'undefined' && window.parent !== window;
    router.replace(landingRoute(user, { embedded }));
  }, [user, isLoading, router]);

  return (
    <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
      Učitavanje…
    </main>
  );
}
