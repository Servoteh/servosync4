'use client';

import { useEffect, type ReactNode } from 'react';
import { Menu, Search } from 'lucide-react';
import { HeaderBell, useAppShell } from '@/components/ui-kit/app-shell';

interface PageHeaderProps {
  title: string;
  /** e.g. broj zapisa ("62 tabele") */
  count?: ReactNode;
  actions?: ReactNode;
}

/** Kit obrazac fokus prstena (button.tsx) — za icon-only dugmad na svetloj površini. */
const HDR_FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/**
 * Komandna traka ekrana: naslov + broj zapisa levo, primarna akcija desno.
 * Uz F1 shell dobija: hamburger kad sidebar nema svoju kolonu (mobilni / „hidden" /
 * „wide" ruta), vidljivu Ctrl+K pretragu (DS §4: globalna pretraga je deo komandne
 * trake; §8: prečica vidljiva u tooltip-u) i zvonce kad je sidebar sklonjen (da
 * notifikacije ne nestanu sa ekrana). Van AppShell-a (kiosk/login) kontekst je null
 * pa se sve tri afordanse preskaču — API nepromenjen.
 */
export function PageHeader({ title, count, actions }: PageHeaderProps) {
  const shell = useAppShell();

  // Prijavi shell-u da stranica ima komandnu traku (nosilac hamburgera) — shell tada
  // NE renderuje sopstveni plutajući fallback (v. AppShell registerHeaderAffordance).
  const register = shell?.registerHeaderAffordance;
  useEffect(() => register?.(), [register]);

  return (
    <header className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-between border-b border-line bg-surface px-6">
      <div className="flex min-w-0 items-center gap-3">
        {shell?.sidebarHidden && (
          <button
            type="button"
            onClick={shell.openSidebar}
            title="Otvori navigaciju"
            aria-label="Otvori navigaciju"
            className={`-my-2 -ml-3 grid h-11 w-11 shrink-0 place-items-center rounded-control text-ink-secondary hover:bg-surface-2 hover:text-ink ${HDR_FOCUS}`}
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        )}
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-lg font-semibold text-ink">{title}</h1>
          {count != null && <span className="shrink-0 text-sm text-ink-secondary">{count}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {shell && (
          <button
            type="button"
            onClick={shell.openPalette}
            title="Pretraga modula (Ctrl+K)"
            aria-label="Pretraga modula (Ctrl+K)"
            className={`grid h-9 w-9 place-items-center rounded-control text-ink-secondary hover:bg-surface-2 hover:text-ink ${HDR_FOCUS}`}
          >
            <Search className="h-4 w-4" aria-hidden />
          </button>
        )}
        {shell?.sidebarHidden && <HeaderBell />}
        {actions}
      </div>
    </header>
  );
}
