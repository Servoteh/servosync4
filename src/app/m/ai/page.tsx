'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AiChat } from '../../ai/_components/ai-chat';

/** Mobilni AI asistent (/m/ai) — full-screen, paritet 1.0 myAi. Vidljivost = ai.chat. */
export default function MobileAiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <div className="flex h-screen flex-col">
      <AiChat variant="mobile" />
    </div>
  );
}
