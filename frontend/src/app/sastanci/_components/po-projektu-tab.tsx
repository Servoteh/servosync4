'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { useReorderRang, useTeme, type PmTemaRow } from '@/api/sastanci';
import { INPUT_CLS, PRIORITET_LABEL, TemaStatusBadge } from './common';

/**
 * Master-rang tema po projektu (admin) — paritet 1.0 pregledPoProjektuTab.
 * NAPOMENA (R4): puni izbor projekta traži sy15 projects-by-uuid lookup (ne postoji
 * BE endpoint; FE `useProjectsLookup` je BigBit numerički ID, drugi prostor). Do tada
 * projekti se izvode iz `projekat_id` postojećih tema; rang se čuva kroz reorder-rang.
 */
export function PoProjektuTab() {
  const temeQ = useTeme({});
  const reorder = useReorderRang();
  const [projekat, setProjekat] = useState<string | null>(null);
  const [ranks, setRanks] = useState<Record<string, number | null>>({});

  const byProject = useMemo(() => {
    const m = new Map<string, PmTemaRow[]>();
    for (const t of temeQ.data?.data ?? []) {
      if (!t.projekat_id) continue;
      if (!m.has(t.projekat_id)) m.set(t.projekat_id, []);
      m.get(t.projekat_id)!.push(t);
    }
    return m;
  }, [temeQ.data]);

  const projects = [...byProject.keys()];
  const active = projekat && byProject.has(projekat) ? projekat : projects[0] ?? null;
  const rows = active ? (byProject.get(active) ?? []) : [];

  useEffect(() => {
    const next: Record<string, number | null> = {};
    for (const r of rows) next[r.id] = r.admin_rang;
    setRanks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, temeQ.data]);

  async function save() {
    const items = rows.map((r) => ({ id: r.id, rang: ranks[r.id] ?? null }));
    await reorder.mutateAsync({ items });
  }

  function renumber() {
    const sorted = [...rows].sort((a, b) => (ranks[a.id] ?? 999) - (ranks[b.id] ?? 999));
    const next: Record<string, number | null> = {};
    sorted.forEach((r, i) => (next[r.id] = i + 1));
    setRanks(next);
  }

  if (temeQ.isLoading) return <p className="text-sm text-ink-secondary">Učitavanje…</p>;
  if (!projects.length) return <p className="text-sm text-ink-secondary">Nema tema vezanih za projekat.</p>;

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <aside className="space-y-1 rounded-panel border border-line bg-surface p-2">
        {projects.map((p) => (
          <button
            key={p}
            onClick={() => setProjekat(p)}
            className={cn(
              'flex w-full items-center justify-between rounded-control px-2 py-1.5 text-left text-sm',
              p === active ? 'bg-accent-subtle text-ink' : 'text-ink-secondary hover:bg-surface-2',
            )}
          >
            <span className="truncate">{p.slice(0, 8)}…</span>
            <span className="tnums text-xs text-ink-disabled">{byProject.get(p)!.length}</span>
          </button>
        ))}
      </aside>

      <div className="space-y-3">
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={renumber}>Renumeriši 1..N</Button>
          <Button loading={reorder.isPending} onClick={() => void save()}>Sačuvaj poredak</Button>
        </div>
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="h-9 w-16 px-3">Rang</th>
                <th className="px-3">Naslov</th>
                <th className="px-3">Status</th>
                <th className="px-3">Prioritet</th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => (ranks[a.id] ?? 999) - (ranks[b.id] ?? 999))
                .map((r) => (
                  <tr key={r.id} className="border-b border-line-soft">
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        className={`${INPUT_CLS} w-14`}
                        value={ranks[r.id] ?? ''}
                        onChange={(e) => setRanks((s) => ({ ...s, [r.id]: e.target.value === '' ? null : Number(e.target.value) }))}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      {r.hitno && <span className="mr-1 text-status-danger" aria-hidden>🔥</span>}
                      {r.naslov}
                    </td>
                    <td className="px-3 py-1.5"><TemaStatusBadge status={r.status} /></td>
                    <td className="px-3 py-1.5 text-ink-secondary">{PRIORITET_LABEL[r.prioritet] ?? r.prioritet}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
