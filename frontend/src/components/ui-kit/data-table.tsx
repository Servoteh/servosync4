'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right';
  numeric?: boolean;
  /** Kolona je sortabilna klikom na zaglavlje (traži `sort`+`onSortToggle` na tabeli). */
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

/** Stanje sortiranja po koloni (kontrolisano spolja — persist radi pozivalac). */
export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowActivate?: (row: T) => void;
  renderExpanded?: (row: T) => ReactNode;
  expandedKey?: string | number | null;
  empty?: ReactNode;
  loading?: boolean;
  /** Uključi native HTML5 prevlačenje redova (uz `onRowDrop`). */
  rowDraggable?: boolean;
  /** Poziva se pri spuštanju prevučenog reda na drugi (ključevi kao stringovi). */
  onRowDrop?: (dragKey: string, overKey: string) => void;
  /** Aktivno sortiranje (kontrolisano); indikator ▲/▼ na koloni. */
  sort?: SortState | null;
  /** Klik na sortabilno zaglavlje — pozivalac ciklira asc → desc → none. */
  onSortToggle?: (key: string) => void;
  /** Opcione dodatne klase po redu (npr. isticanje prekoračenih rokova — RB-22). */
  rowClassName?: (row: T) => string | undefined;
}

/**
 * Gusta tabela (DESIGN_SYSTEM.md §5): red ~35px, zaglavlje uppercase,
 * tastatura ↑/↓ + Enter, selektovan red = akcentna traka levo + blaga pozadina.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowActivate,
  renderExpanded,
  expandedKey,
  empty,
  loading,
  rowDraggable,
  onRowDrop,
  sort,
  onSortToggle,
  rowClassName,
}: DataTableProps<T>) {
  const [focus, setFocus] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const dnd = !!rowDraggable && !!onRowDrop;

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    if (!rows.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus((f) => Math.min(f + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus((f) => Math.max(f - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // `focus` može biti van opsega ako se `rows` suzio (promena filtera/pretrage)
      // a strelice još nisu pomerile fokus — bez guarda rows[focus] je undefined.
      const row = rows[focus];
      if (row) onRowActivate?.(row);
    }
  }

  const colCount = columns.length;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left">
            {columns.map((c) => {
              const sortableHere = !!c.sortable && !!onSortToggle;
              const active = sort?.key === c.key ? sort : null;
              return (
                <th
                  key={c.key}
                  aria-sort={active ? (active.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'h-9 px-4 font-semibold uppercase tracking-[0.08em] text-ink-secondary',
                    'text-2xs',
                    c.align === 'right' && 'text-right',
                  )}
                >
                  {sortableHere ? (
                    <button
                      type="button"
                      onClick={() => onSortToggle(c.key)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-ink',
                        'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
                        active && 'text-ink',
                      )}
                      title="Sortiraj po koloni"
                    >
                      {c.header}
                      <span aria-hidden className="text-[9px] leading-none">
                        {active ? (active.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody
          ref={bodyRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="focus-visible:outline-none"
        >
          {loading ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-10 text-center text-ink-disabled">
                Učitavanje…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="p-0">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row);
              const isFocused = i === focus;
              const isExpanded = expandedKey != null && expandedKey === key;
              return (
                <FragmentRow key={key}>
                  <tr
                    onClick={() => {
                      setFocus(i);
                      onRowActivate?.(row);
                    }}
                    aria-selected={isFocused}
                    draggable={dnd || undefined}
                    onDragStart={
                      dnd
                        ? (e) => {
                            e.dataTransfer.setData('text/plain', String(key));
                            e.dataTransfer.effectAllowed = 'move';
                          }
                        : undefined
                    }
                    onDragOver={
                      dnd
                        ? (e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dropTarget !== String(key)) setDropTarget(String(key));
                          }
                        : undefined
                    }
                    onDragLeave={
                      dnd
                        ? () => {
                            setDropTarget((t) => (t === String(key) ? null : t));
                          }
                        : undefined
                    }
                    onDrop={
                      dnd
                        ? (e) => {
                            e.preventDefault();
                            const dragKey = e.dataTransfer.getData('text/plain');
                            setDropTarget(null);
                            if (dragKey) onRowDrop?.(dragKey, String(key));
                          }
                        : undefined
                    }
                    className={cn(
                      'h-[var(--table-row-height)] cursor-pointer border-b border-line-soft',
                      'hover:bg-surface-2',
                      isFocused && 'bg-accent-subtle shadow-[inset_3px_0_0_var(--accent)]',
                      dnd && dropTarget === String(key) && 'border-t-2 border-t-accent',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          'px-4 text-ink',
                          c.align === 'right' && 'text-right',
                          c.numeric && 'tnums',
                        )}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && renderExpanded && (
                    <tr className="border-b border-line-soft bg-surface-2/60">
                      <td colSpan={colCount} className="px-4 py-3">
                        {renderExpanded(row)}
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// Small helper so each logical row (+ its expansion) shares one key.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
