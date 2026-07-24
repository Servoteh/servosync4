'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { landingRoute } from '@/lib/landing-route';
import { useChangePassword } from '@/api/auth';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';

/** Min. dužina nove lozinke (paritet backend B2). */
const MIN_LEN = 8;

interface Values {
  current: string;
  next: string;
  confirm: string;
}

/**
 * Self-service promena lozinke (B2) — obrazac „Forma" (DESIGN_SYSTEM §4), vanredni tok bez shell-a
 * (kao /login) da forsirani korisnik nema sidebar za bekstvo. Dostupno svakom prijavljenom (link u
 * profilu) i prinudno posle admin reseta (must_change_password → auth-context zaključava rutu).
 * Statička ruta bez [id] — bezbedna za export. Ctrl+S ili Enter čuva.
 */
export default function PromenaLozinkePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const change = useChangePassword();

  const [values, setValues] = useState<Values>({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof Values | 'root', string>>>({});
  const busy = change.isPending;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  function set<K extends keyof Values>(key: K, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  const save = useCallback(async () => {
    const next: Partial<Record<keyof Values | 'root', string>> = {};
    if (!values.current) next.current = 'Unesite trenutnu lozinku';
    if (values.next.length < MIN_LEN)
      next.next = `Nova lozinka mora imati najmanje ${MIN_LEN} karaktera`;
    if (!values.confirm) next.confirm = 'Potvrdite novu lozinku';
    else if (values.next !== values.confirm) next.confirm = 'Lozinke se ne poklapaju';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      await change.mutateAsync({
        currentPassword: values.current,
        newPassword: values.next,
      });
      toast('Lozinka je promenjena.');
      const embedded = typeof window !== 'undefined' && window.parent !== window;
      router.replace(landingRoute(user, { embedded }));
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? 'Trenutna lozinka nije ispravna'
          : err instanceof ApiError && err.status === 400
            ? `Nova lozinka mora imati najmanje ${MIN_LEN} karaktera`
            : 'Promena lozinke trenutno nije moguća. Pokušajte ponovo.';
      setErrors((e) => ({ ...e, root: message }));
    }
  }, [values, change, router, user]);

  // Ctrl+S = sačuvaj (Enter ide kroz form onSubmit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, save]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const forced = user.mustChangePassword === true;

  return (
    <main className="grid flex-1 place-items-center bg-app px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-ink">Promena lozinke</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {forced
              ? 'Iz bezbednosnih razloga postavite novu lozinku pre nastavka.'
              : 'Postavite novu lozinku za svoj nalog.'}
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="space-y-4 rounded-panel border border-line bg-surface p-6"
        >
          <FormField label="Trenutna lozinka" required error={errors.current}>
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={values.current}
              onChange={(e) => set('current', e.target.value)}
            />
          </FormField>

          <FormField
            label="Nova lozinka"
            required
            error={errors.next}
            hint={`Najmanje ${MIN_LEN} karaktera.`}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={values.next}
              onChange={(e) => set('next', e.target.value)}
            />
          </FormField>

          <FormField label="Potvrda nove lozinke" required error={errors.confirm}>
            <Input
              type="password"
              autoComplete="new-password"
              value={values.confirm}
              onChange={(e) => set('confirm', e.target.value)}
            />
          </FormField>

          {errors.root && (
            <p className="text-sm text-status-danger" role="alert">
              {errors.root}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full">
            Sačuvaj novu lozinku
          </Button>
          <p className="text-center text-2xs text-ink-secondary">Ctrl+S ili Enter čuva</p>
        </form>
      </div>
    </main>
  );
}
