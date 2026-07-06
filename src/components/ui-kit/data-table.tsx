'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  numeric?: boolean;
  render: (row: T) => ReactNode;
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
}: DataTableProps<T>) {
  const [focus, setFocus] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

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
      onRowActivate?.(rows[focus]);
    }
  }

  const colCount = columns.length;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'h-9 px-4 font-semibold uppercase tracking-[0.08em] text-ink-secondary',
                  'text-[10.5px]',
                  c.align === 'right' && 'text-right',
                )}
              >
                {c.header}
              </th>
            ))}
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
                    className={cn(
                      'h-[var(--table-row-height)] cursor-pointer border-b border-line-soft',
                      'hover:bg-surface-2',
                      isFocused && 'bg-accent-subtle shadow-[inset_3px_0_0_var(--accent)]',
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
