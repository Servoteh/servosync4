'use client';

import { useMemo } from 'react';
import { useBoard, type BoardDue, type BoardOverride } from '@/api/odrzavanje';
import { OpStatusBadge } from './common';
import { formatDateTime } from '@/lib/format';

/**
 * Tabla (#33) — preventivni taskovi po mašini u kolonama Prekoračeno / Danas /
 * Narednih 7 dana. Mašine pod aktivnim override-om („PAUZA": čekaju deo, planirano
 * održavanje) tonu na DNO svake kolone, zatamnjene, sa značkom PAUZA; brojač kolone je
 * „N live (+M pauza)" (paritet 1.0 index.js:1323-1397, splitByOverride + PAUZA badge).
 */
export function BoardTab({ onOpenMachine }: { onOpenMachine: (code: string) => void }) {
  const boardQ = useBoard();
  const b = boardQ.data?.data;

  const overrideByCode = useMemo(() => {
    const m = new Map<string, BoardOverride>();
    for (const o of b?.overrides ?? []) m.set(o.machineCode, o);
    return m;
  }, [b]);
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of b?.machineNames ?? []) m.set(n.machineCode, n.name);
    return m;
  }, [b]);

  if (boardQ.isLoading) {
    return <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  }
  if (boardQ.isError || !b) {
    return (
      <p className="py-8 text-center text-sm text-ink-secondary">
        Ne mogu da učitam rokove. Verovatno je u pitanju ograničenje pristupa.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-secondary">
        Preventivni zadaci — sledeći rok po mašini. Mašine u pauzi (čekaju deo, planirano
        održavanje) prikazane su na dnu svake kolone i obeležene značkom „PAUZA".
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <BoardCol title="Prekoračeno" items={b.overdue} overrideByCode={overrideByCode} nameByCode={nameByCode} onOpen={onOpenMachine} />
        <BoardCol title="Danas" items={b.today} overrideByCode={overrideByCode} nameByCode={nameByCode} onOpen={onOpenMachine} />
        <BoardCol title="Narednih 7 dana" items={b.week} overrideByCode={overrideByCode} nameByCode={nameByCode} onOpen={onOpenMachine} />
      </div>
    </div>
  );
}

function BoardCol({
  title,
  items,
  overrideByCode,
  nameByCode,
  onOpen,
}: {
  title: string;
  items: BoardDue[];
  overrideByCode: Map<string, BoardOverride>;
  nameByCode: Map<string, string>;
  onOpen: (code: string) => void;
}) {
  // Pauzirane na dno (splitByOverride, index.js:1349-1357) — ne brišu se: bitno je videti šta čeka kad mašina krene.
  const { ordered, live, paused } = useMemo(() => {
    const l: BoardDue[] = [];
    const p: BoardDue[] = [];
    for (const d of items) (overrideByCode.has(d.machine_code) ? p : l).push(d);
    return { ordered: [...l, ...p], live: l.length, paused: p.length };
  }, [items, overrideByCode]);

  const count = paused > 0 ? (
    <span className="text-ink-secondary">{live} <span className="text-ink-disabled">(+{paused} pauza)</span></span>
  ) : (
    <span className="text-ink-secondary">{ordered.length}</span>
  );

  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
        {title} {count}
      </h3>
      {ordered.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-secondary">Nema stavki.</p>
      ) : (
        <ul className="space-y-1.5">
          {ordered.map((d) => {
            const ovr = overrideByCode.get(d.machine_code);
            const disp = nameByCode.get(d.machine_code) ?? d.machine_code;
            return (
              <li key={d.task_id} className={`rounded-control border border-line px-2.5 py-2 text-sm ${ovr ? 'opacity-55' : ''}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => onOpen(d.machine_code)} className="font-medium text-accent hover:underline">
                    {disp}
                  </button>
                  {ovr && (
                    <span title={`${ovr.reason ?? ''}${ovr.validUntil ? ` (do ${formatDateTime(ovr.validUntil)})` : ''}`} className="inline-flex items-center gap-1">
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-secondary">PAUZA</span>
                      <OpStatusBadge status={ovr.status} />
                    </span>
                  )}
                </div>
                <div className="text-ink-secondary">{d.title}</div>
                <div className="text-2xs text-ink-secondary">
                  {d.interval_value != null && `${d.interval_value} ${d.interval_unit ?? ''} · `}
                  {formatDateTime(d.next_due_at)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
