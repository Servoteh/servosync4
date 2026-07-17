'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Boxes, Layers, Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Can, useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useAllLocations, useUpdateLocation, type LocLocation } from '@/api/lokacije';
import {
  LocTypeBadge,
  compareCageCode,
  compareLocationCodeNatural,
  isCageLoc,
  locationKind,
  locationKindFromLoc,
  locationKindLabel,
  tableEmpty,
} from './common';
import { LocationFormDialog } from './location-form-dialog';
import { CageMoveDialog } from './cage-move-dialog';
import { BulkShelvesDialog } from './bulk-shelves-dialog';
import { CageFormDialog } from './cage-form-dialog';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

type KindFilter = '' | 'hall' | 'shelf' | 'cage' | 'machine' | 'other';
type ViewMode = 'table' | 'tree';

// ------------------------------------------------------------------ klijentski filteri (paritet 1.0)
// 1.0 učita CEO šifarnik i filtrira klijentski: hala-subtree → tekst → kind →
// A-Z natural sort (index.js:1729). Ancestors se uvek zadrže da hijerarhija ne
// „raspadne" (filterLocationsHierarchical / …ByKindHierarchical).

/** Suzi na izabranu HALU + sve njene potomke (paritet filterLocationsBySubtree). */
function filterBySubtree(locs: LocLocation[], hallId: string): LocLocation[] {
  if (!hallId) return locs.slice();
  const childrenByParent = new Map<string, LocLocation[]>();
  for (const l of locs) {
    const k = l.parentId ?? '__root__';
    const arr = childrenByParent.get(k);
    if (arr) arr.push(l);
    else childrenByParent.set(k, [l]);
  }
  const keep = new Set<string>();
  const stack = [hallId];
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const c of childrenByParent.get(id) ?? []) stack.push(c.id);
  }
  return locs.filter((l) => keep.has(l.id));
}

function matchesText(l: LocLocation, q: string): boolean {
  if (!q) return true;
  return (
    l.locationCode.toLowerCase().includes(q) ||
    (l.name ?? '').toLowerCase().includes(q) ||
    (l.pathCached ?? '').toLowerCase().includes(q)
  );
}

/** Tekst filter + svi preci match-ova (paritet filterLocationsHierarchical). */
function filterByText(locs: LocLocation[], query: string): LocLocation[] {
  const q = query.trim().toLowerCase();
  if (!q) return locs.slice();
  const byId = new Map(locs.map((l) => [l.id, l]));
  const keep = new Set<string>();
  for (const loc of locs) {
    if (!matchesText(loc, q)) continue;
    let cur: LocLocation | undefined = loc;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return locs.filter((l) => keep.has(l.id));
}

/** Kind filter + svi preci match-ova (paritet filterLocationsByKindHierarchical). */
function filterByKind(locs: LocLocation[], kind: KindFilter): LocLocation[] {
  if (!kind) return locs.slice();
  const byId = new Map(locs.map((l) => [l.id, l]));
  const keep = new Set<string>();
  for (const loc of locs) {
    if (locationKindFromLoc(loc) !== kind) continue;
    let cur: LocLocation | undefined = loc;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return locs.filter((l) => keep.has(l.id));
}

/** Deca po roditelju za tekuću (filtriranu) listu; siblinzi: police → kavezi → ostalo. */
function buildChildren(locs: LocLocation[]): { childrenByParent: Map<string, LocLocation[]>; roots: LocLocation[] } {
  const byId = new Set(locs.map((l) => l.id));
  const childrenByParent = new Map<string, LocLocation[]>();
  const roots: LocLocation[] = [];
  for (const l of locs) {
    // Root = bez roditelja ILI roditelj nije u filtriranom skupu (subtree scoping).
    if (!l.parentId || !byId.has(l.parentId)) {
      roots.push(l);
    } else {
      const arr = childrenByParent.get(l.parentId);
      if (arr) arr.push(l);
      else childrenByParent.set(l.parentId, [l]);
    }
  }
  const sortSiblings = (kids: LocLocation[]): LocLocation[] => {
    const shelves: LocLocation[] = [];
    const cages: LocLocation[] = [];
    const rest: LocLocation[] = [];
    for (const k of kids) {
      const kind = locationKindFromLoc(k);
      if (kind === 'shelf') shelves.push(k);
      else if (kind === 'cage') cages.push(k);
      else rest.push(k);
    }
    shelves.sort(compareLocationCodeNatural);
    cages.sort(compareCageCode);
    rest.sort(compareLocationCodeNatural);
    return [...shelves, ...cages, ...rest];
  };
  for (const [k, arr] of childrenByParent) childrenByParent.set(k, sortSiblings(arr));
  return { childrenByParent, roots: sortSiblings(roots) };
}

/** Flat A-Z natural redosled (za tabelu) — paritet sortLocationsAZNatural. */
function flattenSorted(locs: LocLocation[]): LocLocation[] {
  const { childrenByParent, roots } = buildChildren(locs);
  const out: LocLocation[] = [];
  const visit = (node: LocLocation) => {
    out.push(node);
    for (const c of childrenByParent.get(node.id) ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

/** Browse šifarnika lokacija (stablo/tabela hala→polica) + manage akcije. */
export function LokacijeTab() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [hallId, setHallId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [view, setView] = useState<ViewMode>('tree');

  const [form, setForm] = useState<{ edit?: LocLocation | null } | null>(null);
  const [cage, setCage] = useState<LocLocation | null>(null);
  const [bulk, setBulk] = useState(false);
  const [newCage, setNewCage] = useState(false);

  const update = useUpdateLocation();
  const query = useAllLocations(showInactive ? 'all' : 'true');
  const all = useMemo(() => query.data ?? [], [query.data]);
  const canManage = can(PERMISSIONS.LOKACIJE_MANAGE);

  const hallOptions = useMemo(
    () => all.filter((l) => locationKind(l.locationType) === 'hall').slice().sort(compareLocationCodeNatural),
    [all],
  );

  // Hala-subtree → tekst → kind (svaki korak čuva pretke).
  const filtered = useMemo(() => {
    const scoped = filterBySubtree(all, hallId);
    const text = filterByText(scoped, q);
    return filterByKind(text, kind);
  }, [all, hallId, q, kind]);

  const tableRows = useMemo(() => flattenSorted(filtered), [filtered]);

  function toggleActive(loc: LocLocation) {
    update.mutate({ id: loc.id, isActive: !loc.isActive });
  }

  const columns: Column<LocLocation>[] = [
    {
      key: 'code',
      header: 'Šifra',
      render: (r) => (
        <span className={r.isActive ? 'font-medium' : 'font-medium text-ink-disabled'} style={{ paddingLeft: `${Math.min(r.depth, 6) * 12}px` }}>
          {r.locationCode}
        </span>
      ),
    },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'type', header: 'Tip', render: (r) => <LocTypeBadge type={r.locationType} /> },
    { key: 'path', header: 'Putanja', render: (r) => <span className="text-xs text-ink-secondary">{r.pathCached || '—'}</span> },
    {
      key: 'active',
      header: 'Status',
      render: (r) => (
        <span className={r.isActive ? 'text-status-success' : 'text-ink-disabled'}>{r.isActive ? 'Aktivna' : 'Neaktivna'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => <RowActions loc={r} onEdit={() => setForm({ edit: r })} onCage={() => setCage(r)} onToggle={() => toggleActive(r)} canManage={canManage} />,
    },
  ];

  const matchHint = q.trim()
    ? `Pogodaka: ${filtered.length} / ${all.length}`
    : `${filtered.length} lokacija`;

  return (
    <div className="space-y-3">
      <div className="rounded-panel border border-line bg-surface-2/40 px-3 py-2.5 text-xs text-ink-secondary">
        <strong className="text-ink">Šifarnik hala i polica.</strong> HALA je veći prostor; POLICA je konkretno mesto unutar hale. Sve izmene se čuvaju kroz istoriju definicija.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Prikaz">
          {(['tree', 'table'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setView(m)}
              className={`px-3 py-1.5 text-xs ${view === m ? 'bg-accent text-white' : 'bg-surface text-ink-secondary hover:bg-surface-2'}`}
            >
              {m === 'tree' ? 'Stablo' : 'Tabela'}
            </button>
          ))}
        </div>

        <select className={INPUT} value={hallId} onChange={(e) => setHallId(e.target.value)} title="Hala">
          <option value="">Sve hale</option>
          {hallOptions.map((h) => (
            <option key={h.id} value={h.id}>{h.locationCode}{h.name ? ` · ${h.name}` : ''}</option>
          ))}
        </select>

        <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} title="Tip lokacije">
          <option value="">Sve lokacije</option>
          <option value="hall">Samo hale</option>
          <option value="shelf">Samo police</option>
          <option value="cage">Kavezi</option>
          <option value="machine">Samo mašine</option>
          <option value="other">Ostalo</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span>Prikaži neaktivne</span>
        </label>

        <input className={`${INPUT} min-w-56 flex-1`} placeholder="Pretraga (šifra / naziv / putanja)…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-ink-disabled tnums">{matchHint}</span>

        <Can permission={PERMISSIONS.LOKACIJE_MANAGE}>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setBulk(true)} title="Serijsko kreiranje polica (A1…A30)">
              <Layers className="h-4 w-4" /> Bulk police
            </Button>
            <Button variant="secondary" onClick={() => setNewCage(true)} title="Novi kavez (KV N) + bulk">
              <Boxes className="h-4 w-4" /> Novi kavez
            </Button>
            <Button onClick={() => setForm({ edit: null })}>
              <Plus className="h-4 w-4" /> Nova lokacija
            </Button>
          </div>
        </Can>
      </div>

      {view === 'tree' ? (
        <LocationTree
          locs={filtered}
          loading={query.isLoading}
          isError={query.isError}
          canManage={canManage}
          onEdit={(l) => setForm({ edit: l })}
          onCage={(l) => setCage(l)}
          onToggle={toggleActive}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={tableRows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          empty={tableEmpty(query.isError, 'Nema lokacija', 'Promeni filtere ili dodaj novu lokaciju.')}
        />
      )}

      {form && <LocationFormDialog edit={form.edit} onClose={() => setForm(null)} />}
      {cage && <CageMoveDialog cage={cage} onClose={() => setCage(null)} />}
      {bulk && <BulkShelvesDialog onClose={() => setBulk(false)} />}
      {newCage && <CageFormDialog onClose={() => setNewCage(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ akcije reda (deljeno tabela/stablo)

function RowActions({
  loc,
  onEdit,
  onCage,
  onToggle,
  canManage,
}: {
  loc: LocLocation;
  onEdit: () => void;
  onCage: () => void;
  onToggle: () => void;
  canManage: boolean;
}) {
  if (!canManage) return null;
  return (
    <div className="flex justify-end gap-1.5">
      {isCageLoc(loc) && (
        <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onCage(); }}>
          Premesti kavez
        </button>
      )}
      <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onEdit(); }}>
        Izmeni
      </button>
      <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }}>
        {loc.isActive ? 'Deaktiviraj' : 'Aktiviraj'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ stablo (paritet renderLocationsTreeHtml)

function LocationTree({
  locs,
  loading,
  isError,
  canManage,
  onEdit,
  onCage,
  onToggle,
}: {
  locs: LocLocation[];
  loading: boolean;
  isError: boolean;
  canManage: boolean;
  onEdit: (l: LocLocation) => void;
  onCage: (l: LocLocation) => void;
  onToggle: (l: LocLocation) => void;
}) {
  const { childrenByParent, roots } = useMemo(() => buildChildren(locs), [locs]);

  if (loading) {
    return <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">Učitavanje…</div>;
  }
  if (locs.length === 0) {
    return tableEmpty(isError, 'Nema lokacija', 'Promeni filtere ili dodaj novu lokaciju.');
  }

  const renderNode = (node: LocLocation, depth: number): ReactNode => {
    const kids = childrenByParent.get(node.id) ?? [];
    const kindLbl = locationKindLabel(node.locationType);
    const head = (
      <span className="inline-flex flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 align-middle">
        <span className={`font-medium ${node.isActive ? 'text-ink' : 'text-ink-disabled line-through'}`}>{node.locationCode}</span>
        <span className="text-sm text-ink-secondary">{node.name}</span>
        <span className="text-2xs uppercase tracking-wide text-ink-disabled">{kindLbl} · {node.locationType}</span>
        {!node.isActive && <span className="text-2xs uppercase tracking-wide text-ink-disabled">(neaktivna)</span>}
        <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <RowActions loc={node} onEdit={() => onEdit(node)} onCage={() => onCage(node)} onToggle={() => onToggle(node)} canManage={canManage} />
        </span>
      </span>
    );

    if (kids.length === 0) {
      return (
        <li key={node.id} className="flex items-center gap-2 rounded-control py-1 hover:bg-surface-2" style={{ marginLeft: depth * 16 + 18 }}>
          <span aria-hidden className="text-ink-disabled">·</span>
          {head}
        </li>
      );
    }
    return (
      <li key={node.id} style={{ marginLeft: depth * 16 }}>
        <details open={depth < 1}>
          <summary className="flex cursor-pointer items-center gap-2 rounded-control py-1 hover:bg-surface-2">
            {head}
          </summary>
          <ul className="mt-0.5 space-y-0.5">{kids.map((k) => renderNode(k, depth + 1))}</ul>
        </details>
      </li>
    );
  };

  return (
    <div className="rounded-panel border border-line bg-surface p-3 text-sm">
      <ul className="space-y-0.5">{roots.map((r) => renderNode(r, 0))}</ul>
    </div>
  );
}
