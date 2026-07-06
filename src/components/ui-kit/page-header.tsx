import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /** e.g. broj zapisa ("62 tabele") */
  count?: ReactNode;
  actions?: ReactNode;
}

/** Komandna traka ekrana: naslov + broj zapisa levo, primarna akcija desno. */
export function PageHeader({ title, count, actions }: PageHeaderProps) {
  return (
    <header className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-between border-b border-line bg-surface px-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {count != null && <span className="text-sm text-ink-secondary">{count}</span>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
