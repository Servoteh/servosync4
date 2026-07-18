import type { ReactNode } from 'react';

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-1 px-4 py-12 text-center">
      <p className="text-base text-ink-secondary">{title}</p>
      {hint && <p className="text-sm text-ink-disabled">{hint}</p>}
    </div>
  );
}
