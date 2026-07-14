'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}
export interface CellMenuState {
  x: number;
  y: number;
  header?: string;
  items: MenuItem[];
}

/** Kontekst meni ćelije (desni klik). Port openGridCellMenu. */
export function CellContextMenu({ menu, onClose }: { menu: CellMenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => {
      window.addEventListener('mousedown', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const left = Math.max(4, Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220));
  const top = Math.max(4, Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 40 - menu.items.length * 32));

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-52 rounded-panel border border-line bg-surface py-1 shadow-xl"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.header && <div className="border-b border-line-soft px-3 py-1 text-2xs text-ink-secondary">{menu.header}</div>}
      {menu.items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          type="button"
          className={cn('block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2', it.danger ? 'text-status-danger' : 'text-ink')}
          onClick={() => {
            onClose();
            try {
              it.onClick();
            } catch {
              /* ignore */
            }
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
