'use client';

import { formatDate } from '@/lib/format';
import { useOnboarding, type OnboardingTask } from '@/api/moj-profil';
import { Section } from './section';

/**
 * 🚀 Moje uvođenje — paritet 1.0 `_onboardingCardHtml` (mojProfil/index.js).
 * Aktivni onboarding/offboarding tokovi zaposlenog (read-only). Po run-u: progress bar %
 * + zadaci (☑ done / ⊘ skipped / ☐ open; rok u prošlosti = crveno). Status vodi HR.
 */

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TaskRow({ t }: { t: OnboardingTask }) {
  const done = t.status === 'done';
  const skipped = t.status === 'skipped';
  const overdue = !done && !skipped && !!t.due_date && t.due_date < today();
  const mark = done ? '☑' : skipped ? '⊘' : '☐';
  return (
    <div
      className={`flex items-center gap-2 border-b border-line-soft py-1.5 text-sm ${done || skipped ? 'opacity-65' : ''}`}
    >
      <span className="text-base text-accent" aria-hidden>
        {mark}
      </span>
      <span className={`flex-1 ${done ? 'line-through' : ''} text-ink`}>
        {t.title}
        {t.assignee_hint && (
          <span className="ml-1 rounded bg-surface-2 px-1 text-2xs text-ink-secondary">{t.assignee_hint}</span>
        )}
      </span>
      <span className={`whitespace-nowrap text-xs ${overdue ? 'font-semibold text-status-danger' : 'text-ink-secondary'}`}>
        {t.due_date ? formatDate(t.due_date) : ''}
      </span>
    </div>
  );
}

export function OnboardingSection() {
  const q = useOnboarding();
  const runs = q.data?.data?.runs ?? [];
  const allTasks = q.data?.data?.tasks ?? [];
  if (q.isLoading) return null;
  if (runs.length === 0) return null;

  return (
    <Section icon="🚀" title="Moje uvođenje" defaultOpen>
      <p className="mb-2 text-xs text-ink-secondary">
        Zadaci tvog uvođenja/izlaska. Status vodi HR — ako je nešto urađeno a nije čekirano, javi HR-u.
      </p>
      {runs.map((r) => {
        const tasks = allTasks.filter((t) => t.runId === r.id);
        const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
        const pct = r.progress != null ? r.progress : tasks.length ? Math.round((done / tasks.length) * 100) : 0;
        return (
          <div key={r.id} className="mb-4 last:mb-0">
            <div className="mb-1.5 flex items-center gap-2.5">
              <strong className="text-sm text-ink">{r.title}</strong>
              <div className="h-2 w-32 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-ink-secondary">
                {done}/{tasks.length}
              </span>
            </div>
            {tasks.length === 0 ? (
              <div className="text-sm text-ink-disabled">Nema zadataka.</div>
            ) : (
              tasks.map((t) => <TaskRow key={t.id} t={t} />)
            )}
          </div>
        );
      })}
    </Section>
  );
}
