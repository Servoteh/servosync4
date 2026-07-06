'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(user ? '/syncs' : '/login');
  }, [user, isLoading, router]);

  return (
    <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
      Učitavanje…
    </main>
  );
}
