'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useAuth } from '@/lib/auth-context';
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
    // /work-orders (rn.read imaju SVE uloge), ne /syncs — vidi app/page.tsx.
    if (!isLoading && user) router.replace('/work-orders');
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
      router.replace('/work-orders');
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
