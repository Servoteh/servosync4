'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    // /work-orders (rn.read imaju SVE uloge), ne /syncs — sync.read imaju samo
    // admin/šef/menadžment, pa bi ostale uloge sletele na 403 stranicu.
    router.replace(user ? '/work-orders' : '/login');
  }, [user, isLoading, router]);

  return (
    <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
      Učitavanje…
    </main>
  );
}
