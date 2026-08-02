'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, CircleSlash, Square, SquareCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useOnboarding,
  useSetMyOnboardingTask,
  type OnboardingTask,
} from '@/api/moj-profil';
import { formatDate } from '@/lib/format';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { MobRefreshButton } from '../_components/mob-refresh';

/**
 * Mobilno „Moje uvođenje" (/mob/onboarding) — 1.0 myOnboarding paritet.
 * ODLUKA Nenada 26.07: radnik SAM štiklira svoje zadatke (done ↔ otvoren) kroz
 * PATCH /v1/profile/onboarding/tasks/:id (SECURITY DEFINER RPC presuđuje
 * vlasništvo — zadatak mora biti u AKTIVNOM run-u tog zaposlenog); „preskočeno"
 * ostaje HR-u. Static export: čista statička ruta.
 *
 * BE vraća sirove Prisma redove (camelCase) a stariji FE tip ima snake polja —
 * čitamo oba oblika (dueDate ?? due_date) dok se desktop sekcija ne sredi.
 */

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type TaskLoose = OnboardingTask & Record<string, unknown>;
const taskDue = (t: TaskLoose): string | null =>
  (typeof t.dueDate === 'string' ? t.dueDate.slice(0, 10) : null) ?? t.due_date ?? null;
const taskHint = (t: TaskLoose): string | null =>
  (typeof t.assigneeHint === 'string' ? t.assigneeHint : null) ?? t.assignee_hint ?? null;

export default function MobOnboardingPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const q = useOnboarding();
  const toggle = useSetMyOnboardingTask();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/mob/prijava');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const runs = q.data?.data?.runs ?? [];
  const allTasks = (q.data?.data?.tasks ?? []) as TaskLoose[];

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Moje uvođenje</h1>
          <p className="truncate text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
        </div>
        {/* Osvežavanje bez reload-a: pull-to-refresh je pod `/mob` ugašen,
            a instalirana PWA nema adresnu traku (v. `_components/mob-refresh.tsx`). */}
        <MobRefreshButton />
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-5 p-4">
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : q.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Uvođenje nije učitano. Proveri vezu pa dodirni „Osveži" gore desno.
          </p>
        ) : runs.length === 0 ? (
          <EmptyState
            title="Nemaš aktivno uvođenje"
            hint="Kad ti HR otvori tok uvođenja ili izlaska, zadaci će se pojaviti ovde."
          />
        ) : (
          runs.map((r) => {
            const tasks = allTasks.filter((t) => t.runId === r.id);
            const doneCount = tasks.filter(
              (t) => t.status === 'done' || t.status === 'skipped',
            ).length;
            const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
            return (
              <section key={r.id} className="space-y-2">
                <div className="flex items-center gap-2.5">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tnums shrink-0 text-xs text-ink-secondary">
                    {doneCount}/{tasks.length}
                  </span>
                </div>

                {tasks.length === 0 ? (
                  <p className="text-sm text-ink-disabled">Nema zadataka.</p>
                ) : (
                  <ul className="space-y-2">
                    {tasks.map((t) => {
                      const done = t.status === 'done';
                      const skipped = t.status === 'skipped';
                      const due = taskDue(t);
                      const overdue = !done && !skipped && !!due && due < today();
                      const Mark = done ? SquareCheck : skipped ? CircleSlash : Square;
                      return (
                        <li key={t.id}>
                          <button
                            type="button"
                            disabled={skipped || toggle.isPending}
                            onClick={() => toggle.mutate({ id: t.id, done: !done })}
                            className={`flex min-h-11 w-full items-center gap-3 rounded-panel border border-line bg-surface p-3 text-left active:bg-surface-2 disabled:opacity-60 ${FOCUS}`}
                          >
                            <Mark
                              className={`h-5 w-5 shrink-0 ${done ? 'text-status-success' : 'text-accent'}`}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                className={`block text-sm ${done ? 'text-ink-secondary line-through' : 'text-ink'}`}
                              >
                                {t.title}
                              </span>
                              {(taskHint(t) || skipped) && (
                                <span className="block text-xs text-ink-secondary">
                                  {skipped ? 'Preskočeno (vodi HR)' : taskHint(t)}
                                </span>
                              )}
                            </span>
                            {due && (
                              <span
                                className={`tnums shrink-0 text-xs ${overdue ? 'font-semibold text-status-danger' : 'text-ink-secondary'}`}
                              >
                                {formatDate(due)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </main>
    </div>
  );
}
