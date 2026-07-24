'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useAuth } from '@/lib/auth-context';
import { landingRoute } from '@/lib/landing-route';
import { isSafeInternalPath } from '@/lib/safe-path';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';

const schema = z.object({
  email: z.string().min(1, 'Unesite email').email('Neispravan email'),
  password: z.string().min(1, 'Unesite lozinku'),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { email: '', password: '' } });

  useEffect(() => {
    if (isLoading || !user) return;
    // Prinudna promena lozinke (B2) ima prednost nad svim: forsira /promena-lozinke i
    // ignoriše zapamćen deep-link (korisnik prvo mora da promeni lozinku).
    if (user.mustChangePassword) {
      router.replace('/promena-lozinke');
      return;
    }
    // Deep-link iz 1.0 iframe-a (zapamćen u AuthProvider-u pre guard redirecta) ima
    // prednost; inače hibrid po ulozi (landing-route.ts): hub-uloge → /pocetna,
    // kontrolori → /kvalitet, ostali → /work-orders. U iframe-u (2.0 kao modul u 1.0
    // shell-u, koji već ima svoj HUB) hub-uloge PRESKAČU /pocetna — otud `embedded`
    // mora da se prosledi (isto kao app/page.tsx), inače dupli hub unutar okvira.
    const embedded = typeof window !== 'undefined' && window.parent !== window;
    let target = landingRoute(user, { embedded });
    try {
      const entry = sessionStorage.getItem('ss2.entryPath');
      sessionStorage.removeItem('ss2.entryPath');
      // Stroga provera protiv open-redirect-a (entry može poticati iz sirovog SSO
      // fragmenta) — deljeni helper, isti kao upisi u auth-context-u.
      if (isSafeInternalPath(entry)) {
        target = entry;
      }
    } catch { /* landingRoute fallback */ }
    router.replace(target);
  }, [user, isLoading, router]);

  async function onSubmit(values: FormValues) {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        setError(issue.path[0] as keyof FormValues, { message: issue.message });
      }
      return;
    }
    try {
      await login(values.email, values.password);
      // Redirect radi useEffect gore čim se `user` (email+role) učita — tako
      // landingRoute dobije rolu i kontrolor sleti na /kvalitet, ne /work-orders.
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? 'Pogrešan email ili lozinka'
          : 'Prijava trenutno nije moguća. Pokušajte ponovo.';
      setError('root', { message });
    }
  }

  return (
    <main className="grid flex-1 place-items-center bg-app px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-ink">ServoSync</h1>
          <p className="mt-1 text-sm text-ink-secondary">Prijava na sistem</p>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4 rounded-panel border border-line bg-surface p-6"
        >
          <FormField label="Email" required error={errors.email?.message}>
            <Input
              type="email"
              autoFocus
              placeholder="ime@servoteh.local"
              {...register('email')}
            />
          </FormField>

          <FormField label="Lozinka" required error={errors.password?.message}>
            <Input type="password" placeholder="••••••••" {...register('password')} />
          </FormField>

          {errors.root && (
            <p className="text-sm text-status-danger" role="alert">
              {errors.root.message}
            </p>
          )}

          <Button type="submit" loading={isSubmitting} className="w-full">
            Prijavi se
          </Button>
        </form>
      </div>
    </main>
  );
}
