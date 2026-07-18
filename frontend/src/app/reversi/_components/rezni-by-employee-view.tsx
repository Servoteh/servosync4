'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatNumber } from '@/lib/format';
import { useCuttingByEmployeeReport, type CuttingByEmployeeRow } from '@/api/reversi';

/**
 * Reversi rezni — pod-pogled „Po zaposlenima" (paritet 1.0 `cuttingByViews.js`
 * renderByEmployeeSubview, RC-36). Čita agregatni view kroz
 * `useCuttingByEmployeeReport({ q })` (debounce 300ms po imenu/šifri/barkodu) +
 * klijentski filter „Odeljenje" (distinct department iz vraćenih redova). Grupiše
 * redove po `employee_id` u kartice sortirane po ukupnoj količini (Σ remaining_qty)
 * opadajuće. Klik na karticu otvara ugrađen detalj-modal (RC-37) sa mašinama kao
 * čipovima. RC-52 fuzzy razrešavanje ovde NIJE potrebno (agregatni view).
 */

interface EmployeeGroup {
  key: string;
  employee_name: string;
  department: string;
  items: CuttingByEmployeeRow[];
  total_qty: number;
  machines: string[];
  last_issued_at: string | null;
}

function groupByEmployee(rows: CuttingByEmployeeRow[]): EmployeeGroup[] {
  const map = new Map<string, EmployeeGroup & { machineSet: Set<string> }>();
  for (const r of rows) {
    const k = r.employee_id || r.employee_name || '—';
    let grp = map.get(k);
    if (!grp) {
      grp = {
        key: k,
        employee_name: r.employee_name || 'Nepoznat',
        department: r.department || '',
        items: [],
        total_qty: 0,
        machines: [],
        machineSet: new Set<string>(),
        last_issued_at: null,
      };
      map.set(k, grp);
    }
    grp.items.push(r);
    grp.total_qty += Number(r.remaining_qty) || 0;
    for (const m of r.machine_codes || []) {
      if (m) grp.machineSet.add(m);
    }
    if (!grp.last_issued_at || (r.last_issued_at && r.last_issued_at > grp.last_issued_at)) {
      grp.last_issued_at = r.last_issued_at;
    }
  }
  return Array.from(map.values())
    .map(({ machineSet, ...g }) => ({ ...g, machines: Array.from(machineSet) }))
    .sort((a, b) => b.total_qty - a.total_qty);
}

export function RezniByEmployeeView() {
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [department, setDepartment] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const report = useCuttingByEmployeeReport({ q: q || undefined });
  const rows = report.data?.data ?? [];

  // Odeljenja: distinct iz svih vraćenih redova (nezavisno od trenutnog filtera),
  // da izbor odeljenja ne isprazni sopstveni dropdown.
  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.department) set.add(r.department);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'sr-Latn-RS'));
  }, [rows]);

  const filteredRows = useMemo(
    () => (department ? rows.filter((r) => (r.department || '') === department) : rows),
    [rows, department],
  );
  const groups = useMemo(() => groupByEmployee(filteredRows), [filteredRows]);
  const openGroup = openKey ? groups.find((g) => g.key === openKey) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Pretraga (ime, šifra, barkod)…"
        />
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className="rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="">Sva odeljenja</option>
          {departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {report.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje pregleda po zaposlenima…</p>
      ) : report.isError ? (
        <EmptyState
          title="Greška pri učitavanju"
          hint="Podaci trenutno nisu dostupni. Osveži stranicu ili pokušaj ponovo."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title="Nema aktivnih zaduženja"
          hint="Nema aktivnih zaduženja reznog alata ni za jednog zaposlenog."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {groups.map((grp) => (
            <article
              key={grp.key}
              tabIndex={0}
              role="button"
              onClick={() => setOpenKey(grp.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenKey(grp.key);
                }
              }}
              className="cursor-pointer rounded-panel border border-line bg-surface p-3 transition-colors hover:border-accent hover:bg-surface-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{grp.employee_name}</span>
                <StatusBadge tone="info" label={`${grp.items.length} šifri`} />
              </div>
              {grp.department && (
                <div className="mt-1 text-2xs text-ink-secondary">Odeljenje: {grp.department}</div>
              )}
              <div className="mt-1.5 text-xs text-ink-secondary">
                Ukupno na njemu: <span className="tnums font-medium text-ink">{formatNumber(grp.total_qty)}</span> kom
              </div>
              {grp.machines.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {grp.machines.map((m) => (
                    <span key={m} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs tnums text-ink-secondary">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-2xs text-ink-secondary">
                Poslednje zaduženje: {formatDate(grp.last_issued_at)}
              </div>
            </article>
          ))}
        </div>
      )}

      <EmployeeDetailDialog group={openGroup} onClose={() => setOpenKey(null)} />
    </div>
  );
}

/* ─────────────────────── Detalj zaposlenog (RC-37) ─────────────────────── */

function EmployeeDetailDialog({ group, onClose }: { group: EmployeeGroup | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!group}
      onClose={onClose}
      size="xl2"
      title={group ? `Zaposleni: ${group.employee_name}` : 'Zaposleni'}
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
        </div>
      }
    >
      {group && (
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            {group.department && (
              <>Odeljenje: <span className="font-medium text-ink">{group.department}</span> · </>
            )}
            Ukupno: <span className="tnums font-medium text-ink">{formatNumber(group.total_qty)}</span> kom u{' '}
            <span className="tnums font-medium text-ink">{group.items.length}</span> šifri
          </p>
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-ink-secondary">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Barkod</th>
                  <th className="px-2 py-1 text-left font-medium">Oznaka / Naziv</th>
                  <th className="px-2 py-1 text-left font-medium">Klasa</th>
                  <th className="px-2 py-1 text-right font-medium">Količina</th>
                  <th className="px-2 py-1 text-left font-medium">Mašine</th>
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
                    <td className="px-2 py-1">
                      {(it.machine_codes || []).length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {(it.machine_codes || []).map((m) => (
                            <span key={m} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs tnums text-ink-secondary">
                              {m}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-ink-secondary">—</span>
                      )}
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
