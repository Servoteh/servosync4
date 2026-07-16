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
    // Kontrolori → /kvalitet, ostali → /work-orders (rn.read imaju SVE uloge, ne
    // /syncs — sync.read imaju samo admin/šef/menadžment → 403 za ostale).
    router.replace(landingRoute(user));
  }, [user, isLoading, router]);

  return (
    <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
      Učitavanje…
    </main>
  );
}
