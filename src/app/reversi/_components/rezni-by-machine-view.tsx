'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatNumber } from '@/lib/format';
import { useCuttingByMachineReport, type CuttingByMachineRow } from '@/api/reversi';

/**
 * Reversi rezni — pod-pogled „Po mašinama" (paritet 1.0 `cuttingByViews.js`
 * renderByMachineSubview, RC-34). Čita agregatni view kroz
 * `useCuttingByMachineReport({ q })` (debounce 300ms po mašini/šifri/barkodu),
 * grupiše redove po `machine_code` u kartice sortirane po ukupnoj količini
 * (Σ remaining_qty) opadajuće. Klik na karticu otvara ugrađen detalj-modal
 * (RC-35) sa punim kolonama i meta zaglavljem.
 */

interface MachineGroup {
  machine_code: string;
  machine_name: string;
  items: CuttingByMachineRow[];
  total_qty: number;
  last_issued_at: string | null;
}

function groupByMachine(rows: CuttingByMachineRow[]): MachineGroup[] {
  const map = new Map<string, MachineGroup>();
  for (const r of rows) {
    const k = r.machine_code || '—';
    let grp = map.get(k);
    if (!grp) {
      grp = {
        machine_code: k,
        machine_name: r.machine_name || '',
        items: [],
        total_qty: 0,
        last_issued_at: null,
      };
      map.set(k, grp);
    }
    grp.items.push(r);
    grp.total_qty += Number(r.remaining_qty) || 0;
    if (!grp.last_issued_at || (r.last_issued_at && r.last_issued_at > grp.last_issued_at)) {
      grp.last_issued_at = r.last_issued_at;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.total_qty - a.total_qty);
}

export function RezniByMachineView() {
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [openCode, setOpenCode] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const report = useCuttingByMachineReport({ q: q || undefined });
  const rows = report.data?.data ?? [];
  const groups = useMemo(() => groupByMachine(rows), [rows]);
  const openGroup = openCode ? groups.find((g) => g.machine_code === openCode) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Pretraga (mašina, šifra, barkod)…"
        />
      </div>

      {report.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje pregleda po mašinama…</p>
      ) : report.isError ? (
        <EmptyState
          title="Greška pri učitavanju"
          hint="Podaci trenutno nisu dostupni. Osveži stranicu ili pokušaj ponovo."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title="Nema aktivnih zaduženja"
          hint="Nema aktivnih zaduženja reznog alata ni na jednoj mašini."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {groups.map((grp) => (
            <article
              key={grp.machine_code}
              tabIndex={0}
              role="button"
              onClick={() => setOpenCode(grp.machine_code)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenCode(grp.machine_code);
                }
              }}
              className="cursor-pointer rounded-panel border border-line bg-surface p-3 transition-colors hover:border-accent hover:bg-surface-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="tnums text-sm font-semibold text-ink">{grp.machine_code}</span>
                <StatusBadge tone="info" label={`${grp.items.length} šifri`} />
              </div>
              <div className="mt-1 truncate text-2xs text-ink-secondary">{grp.machine_name || 'mašina'}</div>
              <div className="mt-1.5 text-xs text-ink-secondary">
                Ukupno na mašini: <span className="tnums font-medium text-ink">{formatNumber(grp.total_qty)}</span> kom
              </div>
              <div className="mt-1 text-2xs text-ink-secondary">
                Poslednje zaduženje: {formatDate(grp.last_issued_at)}
              </div>
            </article>
          ))}
        </div>
      )}

      <MachineDetailDialog group={openGroup} onClose={() => setOpenCode(null)} />
    </div>
  );
}

/* ─────────────────────── Detalj mašine (RC-35) ─────────────────────── */

function MachineDetailDialog({ group, onClose }: { group: MachineGroup | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!group}
      onClose={onClose}
      size="xl2"
      title={group ? `Mašina ${group.machine_code} — ${group.machine_name || ''}` : 'Mašina'}
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
        </div>
      }
    >
      {group && (
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            Aktivna zaduženja reznog alata na ovoj mašini. Ukupno:{' '}
            <span className="tnums font-medium text-ink">{formatNumber(group.total_qty)}</span> kom u{' '}
            <span className="tnums font-medium text-ink">{group.items.length}</span> šifri.
          </p>
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-ink-secondary">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Barkod</th>
                  <th className="px-2 py-1 text-left font-medium">Oznaka / Naziv</th>
                  <th className="px-2 py-1 text-left font-medium">Klasa</th>
                  <th className="px-2 py-1 text-right font-medium">Količina</th>
                  <th className="px-2 py-1 text-left font-medium">Operateri</th>
                  <th className="px-2 py-1 text-left font-medium">Datum</th>
                  <th className="px-2 py-1 text-right font-medium">Doc</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((it) => (
                  <tr key={it.catalog_id} className="border-t border-line">
                    <td className="px-2 py-1 tnums">{it.barcode || '—'}</td>
                    <td className="px-2 py-1">
                      <span className="font-medium">{it.oznaka || '—'}</span>{' '}
                      <span className="text-ink-secondary">{it.naziv || ''}</span>
                    </td>
                    <td className="px-2 py-1 text-ink-secondary">{it.klasa || '—'}</td>
                    <td className="px-2 py-1 text-right tnums">
                      {formatNumber(Number(it.remaining_qty) || 0)} {it.unit || 'kom'}
                    </td>
                    <td className="px-2 py-1 text-ink-secondary">
                      {it.operator_names || it.last_issued_to_name || '—'}
                    </td>
                    <td className="px-2 py-1 tnums text-ink-secondary">{formatDate(it.last_issued_at)}</td>
                    <td className="px-2 py-1 text-right tnums text-ink-secondary">{formatNumber(Number(it.doc_count) || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}
