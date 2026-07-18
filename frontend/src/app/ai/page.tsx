'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { AiChat } from './_components/ai-chat';

/** AI asistent (/ai) — 3.0 TALAS B. Paritet 1.0 aiAsistent. Vidljivost = ai.chat. */
export default function AiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col">
        <AiChat variant="desktop" />
      </div>
    </AppShell>
  );
}
