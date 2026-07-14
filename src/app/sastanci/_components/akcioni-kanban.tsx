'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { usePatchAkcija, type AkcijaRow } from '@/api/sastanci';
import { formatDatum, PRIORITET_TONE } from './common';

// Kanban 3 kolone (paritet 1.0 akcioniPlanKanban): Otvorene / Završene / Odložene.
// Drag-drop menja status (HTML5 DnD).
const COLUMNS: { key: string; label: string; statuses: string[]; drop: string }[] = [
  { key: 'otvorene', label: 'Otvorene', statuses: ['otvoren', 'u_toku', 'kasni'], drop: 'otvoren' },
  { key: 'zavrsene', label: 'Završene', statuses: ['zavrsen'], drop: 'zavrsen' },
  { key: 'odlozene', label: 'Odložene', statuses: ['odlozen', 'otkazan'], drop: 'odlozen' },
];

export function AkcioniKanban({
  akcije,
  canEdit,
  onEdit,
}: {
  akcije: AkcijaRow[];
  canEdit: boolean;
  onEdit: (a: AkcijaRow) => void;
}) {
  const patchM = usePatchAkcija();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  function drop(dropStatus: string) {
    if (!dragId) return;
    const a = akcije.find((x) => x.id === dragId);
    setDragId(null);
    setOverCol(null);
    if (!a || a.status === dropStatus) return;
    patchM.mutate({ id: a.id, patch: { status: dropStatus } });
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {COLUMNS.map((col) => {
        const items = akcije.filter((a) => col.statuses.includes(a.effective_status));
        return (
          <div
            key={col.key}
            onDragOver={(e) => {
              if (canEdit) {
                e.preventDefault();
                setOverCol(col.key);
              }
            }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => drop(col.drop)}
            className={cn(
              'rounded-panel border border-line bg-surface-2 p-2',
              overCol === col.key && 'ring-2 ring-accent/40',
            )}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-semibold text-ink">{col.label}</span>
              <span className="tnums text-xs text-ink-secondary">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map((a) => (
                <div
                  key={a.id}
                  draggable={canEdit}
                  onDragStart={() => setDragId(a.id)}
                  onClick={() => onEdit(a)}
                  className="cursor-pointer rounded-control border border-line bg-surface p-2 text-sm hover:bg-surface-2"
                >
                  <div className="flex items-start gap-1.5">
                    <span
                      className={cn(
                        'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                        PRIORITET_TONE[a.prioritet] === 'danger'
                          ? 'bg-status-danger'
                          : PRIORITET_TONE[a.prioritet] === 'warn'
                            ? 'bg-status-warn'
                            : 'bg-status-neutral',
                      )}
                      aria-hidden
                    />
                    <span className="line-clamp-3 text-ink">{a.naslov}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-2xs text-ink-secondary">
                    <span className="truncate">{a.odgovoran_label || a.odgovoran_text || a.odgovoran_email || '—'}</span>
                    <span className={cn('tnums', a.effective_status === 'kasni' && 'text-status-danger')}>
                      {a.rok_text || formatDatum(a.rok)}
                    </span>
                  </div>
                </div>
              ))}
              {items.length === 0 && <p className="px-1 py-2 text-xs text-ink-disabled">—</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
