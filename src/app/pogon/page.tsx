'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { KioskScanner } from '../kiosk/_components/kiosk-scanner';

/**
 * Pogonski kiosk sa DELJENIM terminal nalogom (/pogon).
 *
 * Otvaraju ga pogonski terminali direktnim URL-om (LAN:
 * http://192.168.64.28:3000/pogon) ili 1.0 HUB pločicom „Kucanje (pogon)".
 * label-proxy (localhost:8765) mora raditi na terminalu za štampu nalepnica.
 *
 * Razlika u odnosu na /kiosk (koji ostaje za HUB iframe + SSO iz 1.0 shell-a):
 * ovde terminal NIJE u iframe-u pa nema SSO handshake-a. Umesto redirekta na
 * /login, terminal se JEDNOM prijavi DELJENIM nalogom (email 'kiosk@servoteh.com',
 * rola proizvodni_radnik → tehnologija.report_work). Token ostaje u localStorage
 * (auth-context) pa terminal ostaje prijavljen i posle refresh-a. Operater se
 * onda identifikuje KARTICOM unutar sesije (KioskScanner → identifyWorker).
 *
 * NAMERNO bez AppShell-a (isto kao /kiosk): full-screen touch panel.
 * Static export: statička ruta /pogon, bez [id] segmenata.
 */

/** Deljeni nalog nije tajna — email je predpopunjen, lozinka se unosi na terminalu. */
const TERMINAL_EMAIL = 'kiosk@servoteh.com';

export default function PogonPage() {
  const { user, isLoading, login, logout } = useAuth();

  if (isLoading) {
    return (
      <main className="grid flex-1 place-items-center text-xl text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  if (!user) {
    return <TerminalLogin onLogin={login} />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <KioskScanner />
      <button
        type="button"
        onClick={logout}
        className="fixed bottom-2 right-2 z-10 inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs text-ink-disabled opacity-60 transition-colors hover:bg-surface-2 hover:text-ink-secondary hover:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        title="Odjavi terminal (promena naloga)"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden />
        Odjavi terminal
      </button>
    </div>
  );
}

function TerminalLogin({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState(TERMINAL_EMAIL);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError('Unesite lozinku terminala');
      return;
    }
    setSubmitting(true);
    try {
      await onLogin(email.trim(), password);
      // Uspeh → auth-context postavlja user-a, page re-renderuje KioskScanner.
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Pogrešna lozinka terminala'
          : 'Prijava trenutno nije moguća. Pokušajte ponovo.',
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="grid flex-1 place-items-center bg-app px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-ink">Prijava terminala pogona</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Terminal se prijavljuje jednom deljenim nalogom. Radnik se posle
            identifikuje karticom.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-panel border border-line bg-surface p-6"
        >
          <FormField label="Nalog terminala">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </FormField>

          <FormField label="Lozinka terminala" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              autoComplete="current-password"
            />
          </FormField>

          {error && (
            <p className="text-sm text-status-danger" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="w-full">
            Prijavi terminal
          </Button>
        </form>
      </div>
    </main>
  );
}
