'use client';

import { useEffect, useMemo, useState } from 'react';
import { DataTable, type Column, type SortState } from '@/components/ui-kit/data-table';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  newClientEventId,
  useDeactivateEmployee,
  useDeleteEmployee,
  useEmployeesList,
  useOrgStructure,
  useUpdateEmployee,
  type EmployeesListParams,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { sv, SummaryChips } from './common';
import { CON_TYPE_OPTS, daysUntilBirthday, ddMm, empDisplayName, medicalDaysLeft } from './emp-shared';
import { DosijeDialog } from './dossier';
import { EmployeeFormDialog } from './employee-form';
import { EmpBulkActionsDialog } from './emp-bulk-actions';
import { EmpQuickEntryDialog } from './emp-quick-entry';

// Lista zaposlenih — pun 1.0 paritet (employeesTab.js): quick-filter chips,
// filteri odeljenje/status/vrsta-ugovora, summary chips, sort po kolonama
// (persist u localStorage), bulk selekcija, CRUD (novi/izmeni/deaktiviraj/
// aktiviraj/trajno brisanje). Red otvara Dosije (dossier.tsx).
//
// SERVER-SIDE model (P1a ListEmployeesQueryDto): q/department/active/filter/
// conType/sort/dir + paginacija (BE klampuje pageSize na 200) — bez klijentskog
// „fetch-sve". Summary chips = 4 mini upita (pageSize=1, čita se meta.total).
// ⚠️ BE `q` pretražuje SAMO full_name (ILIKE) — uže od 1.0 multi-polja pretrage.

type QuickKey = 'all' | 'active' | 'med-soon' | 'bday-soon' | 'missing-jmbg' | 'no-email' | 'no-phone';

const QUICK_CHIPS: { key: QuickKey; label: string; title?: string }[] = [
  { key: 'all', label: 'Svi' },
  { key: 'active', label: '✓ Aktivni' },
  { key: 'med-soon', label: '🩺 Lekarski <30d', title: 'Lekarski ističe u narednih 30 dana' },
  { key: 'bday-soon', label: '🎂 Rođendani <30d', title: 'Rođendani u narednih 30 dana' },
  { key: 'missing-jmbg', label: '⚠ Bez JMBG', title: 'Zaposleni bez upisanog JMBG-a (vidljivo samo PII korisnicima)' },
  { key: 'no-email', label: '📧 Bez email-a', title: 'Zaposleni bez email-a — neće dobijati notifikacije' },
  { key: 'no-phone', label: '📱 Bez telefona', title: 'Zaposleni bez telefona — neće dobijati WhatsApp/SMS obaveštenja' },
];

const SORT_KEY_LS = 'kadr_emp_sort_v1';

/** BE whitelist sort ključeva (EMPLOYEE_SORT_KEYS) — mora 1:1 sa kb1. */
const SORT_KEYS = ['name', 'position', 'department', 'subDepartment', 'email', 'medical', 'birthday', 'status'] as const;
type SortKey = (typeof SORT_KEYS)[number];

const SELECT_CLS = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

/** Učitaj persistovan sort — whitelist protiv BE ključeva + legacy 'bday'→'birthday'
    mapiranje (stariji localStorage ne sme da emituje nevažeći sort param → 400). */
function loadSort(): SortState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SORT_KEY_LS);
    if (!raw) return null;
    const p = JSON.parse(raw) as SortState;
    if (!p || typeof p.key !== 'string' || (p.dir !== 'asc' && p.dir !== 'desc')) return null;
    const key = p.key === 'bday' ? 'birthday' : p.key;
    return (SORT_KEYS as readonly string[]).includes(key) ? { key, dir: p.dir } : null;
  } catch {
    return null;
  }
}

export function ZaposleniTab() {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.KADROVSKA_EDIT);
  // „+ Novi zaposleni" / „⚡ Brzi unos": FE gate = kadrovska.manage — NAMERNO
  // strožiji od BE guard-a (POST /employees je na BE kadrovska.edit; verifikovano
  // 14.07). Presuda Nenad 14.07: fail-closed afordansa ostaje na manage;
  // sy15 RLS employees_insert svakako presuđuje red (HR/admin/poslovni_admin).
  const canAdd = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const canPii = can(PERMISSIONS.KADROVSKA_PII);

  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<QuickKey>('all');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [conType, setConType] = useState('');
  const [sort, setSort] = useState<SortState | null>(loadSort);
  const [page, setPage] = useState(1);
  /* Selekcija čuva CELE redove (Map id→red) da bulk radi i preko više strana. */
  const [selected, setSelected] = useState<ReadonlyMap<string, EmployeeSafe>>(new Map());

  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ editId: string | null } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [quickEntryOpen, setQuickEntryOpen] = useState(false);
  const [deactivateFor, setDeactivateFor] = useState<EmployeeSafe | null>(null);
  const [purgeFor, setPurgeFor] = useState<EmployeeSafe | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /* Promena bilo kog filtera/sorta vraća na prvu stranu. */
  useEffect(() => {
    setPage(1);
  }, [q, quick, dept, status, conType, sort]);

  /* Server parami: quick 'active' i čipovi koji u 1.0 podrazumevaju aktivne
     (med-soon/bday-soon/no-phone) šalju active=true; inače status select. */
  const effActive =
    quick === 'active' || quick === 'med-soon' || quick === 'bday-soon' || quick === 'no-phone'
      ? true
      : status === 'active'
        ? true
        : status === 'inactive'
          ? false
          : undefined;
  const quickFilter: EmployeesListParams['filter'] = quick === 'all' || quick === 'active' ? undefined : quick;

  const listQ = useEmployeesList({
    q: q.trim() || undefined,
    department: dept || undefined,
    active: effActive,
    filter: quickFilter,
    conType: conType || undefined,
    sort: (sort?.key as SortKey | undefined) ?? undefined,
    dir: sort?.dir,
    page,
    pageSize: 50,
  });
  const rows = useMemo(() => listQ.data?.data ?? [], [listQ.data]);
  const total = listQ.data?.meta.pagination.total ?? 0;
  const totalPages = listQ.data?.meta.pagination.totalPages ?? 1;

  /* Summary chips — 4 mini upita (pageSize=1, samo meta.total; 1.0 brojevi). */
  const sumAllQ = useEmployeesList({ pageSize: 1 });
  const sumActiveQ = useEmployeesList({ active: true, pageSize: 1 });
  const sumMedQ = useEmployeesList({ active: true, filter: 'med-soon', pageSize: 1 });
  const sumBdayQ = useEmployeesList({ active: true, filter: 'bday-soon', pageSize: 1 });
  const totAll = sumAllQ.data?.meta.pagination.total ?? 0;
  const totActive = sumActiveQ.data?.meta.pagination.total ?? 0;
  const medExpSoon = sumMedQ.data?.meta.pagination.total ?? 0;
  const bdaySoon = sumBdayQ.data?.meta.pagination.total ?? 0;

  /* Filter „Sva odeljenja" — org struktura (kanonska imena); fallback = tekuća strana. */
  const orgQ = useOrgStructure();
  const departments = useMemo(() => {
    const fromOrg = (orgQ.data?.data?.departments ?? []).map((d) => d.name);
    if (fromOrg.length) return fromOrg;
    return Array.from(new Set(rows.map((e) => sv(e, 'department')).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sr'));
  }, [orgQ.data, rows]);

  const deactivateMut = useDeactivateEmployee();
  const deleteMut = useDeleteEmployee();
  const updateMut = useUpdateEmployee();

  const bdayView = quick === 'bday-soon';
  const filtersActive = !!(q.trim() || dept || status || conType || quick !== 'all');

  /** Klik-sort ciklira asc → desc → none; persist u localStorage (BE whitelist). */
  function toggleSort(key: string) {
    setSort((prev) => {
      const next: SortState | null =
        prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null;
      try {
        if (next) localStorage.setItem(SORT_KEY_LS, JSON.stringify(next));
        else localStorage.removeItem(SORT_KEY_LS);
      } catch {
        /* noop */
      }
      return next;
    });
  }

  /* Selekcija — preživljava promene filtera i strana (Map id→red). */
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allVisibleSelected) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.set(r.id, r));
      return next;
    });
  }
  function toggleSelect(r: EmployeeSafe) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.set(r.id, r);
      return next;
    });
  }
  const selectedItems = useMemo(() => Array.from(selected.values()), [selected]);

  /* Aktiviranje = PATCH is_active (BE ugovor; deaktivacija ima svoj endpoint). */
  async function activate(e: EmployeeSafe) {
    try {
      await updateMut.mutateAsync({ id: e.id, patch: { is_active: true }, expectedUpdatedAt: sv(e, 'updated_at') || undefined });
      setToast('✅ Zaposleni je vraćen u aktivne');
    } catch {
      setToast('⚠ Promena nije uspela');
    }
  }

  async function confirmDeactivate() {
    const e = deactivateFor;
    if (!e) return;
    try {
      await deactivateMut.mutateAsync({ id: e.id, clientEventId: newClientEventId() });
      setToast('🔒 Zaposleni je deaktiviran');
    } catch {
      setToast('⚠ Promena nije uspela');
    }
    setDeactivateFor(null);
  }

  async function confirmPurge() {
    const e = purgeFor;
    if (!e) return;
    try {
      await deleteMut.mutateAsync({ id: e.id });
      setToast('🗑 Zaposleni trajno obrisan');
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(e.id);
        return next;
      });
    } catch {
      setToast('⚠ Brisanje nije uspelo — verovatno postoje vezani podaci (ostaviti deaktiviranog)');
    }
    setPurgeFor(null);
  }

  const rowBtn = 'rounded-control border border-line bg-surface px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2 hover:text-ink disabled:opacity-50';

  const columns: Column<EmployeeSafe>[] = [
    {
      key: 'sel',
      header: (
        <input
          type="checkbox"
          aria-label="Selektuj sve vidljive"
          title="Selektuj sve vidljive"
          checked={allVisibleSelected}
          disabled={!canEdit}
          onChange={toggleSelectAll}
        />
      ),
      render: (r) => (
        <input
          type="checkbox"
          aria-label="Selektuj red"
          checked={selected.has(r.id)}
          disabled={!canEdit}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelect(r)}
        />
      ),
    },
    {
      key: 'name',
      header: 'Ime i prezime',
      sortable: true,
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{empDisplayName(r) || '—'}</div>
          <div className="text-xs text-ink-secondary">{[r.email, r.phone_work].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'position', header: 'Pozicija', sortable: true, render: (r) => r.position || '—' },
    { key: 'department', header: 'Odeljenje', sortable: true, render: (r) => r.department || '—' },
    { key: 'subDepartment', header: 'Pododeljenje', sortable: true, render: (r) => sv(r, 'sub_department_name') || '—' },
    { key: 'phone', header: 'Telefon', render: (r) => sv(r, 'phone_work') || sv(r, 'phone') || '—' },
    {
      key: 'medical',
      header: 'Lekarski ističe',
      sortable: true,
      render: (r) => {
        const exp = sv(r, 'medical_exam_expires');
        const days = medicalDaysLeft(exp);
        if (days == null) return '—';
        if (days < 0) return <StatusBadge tone="danger" label="Istekao" />;
        if (days <= 30) return <StatusBadge tone="warn" label={`za ${days}d`} />;
        return <span className="text-ink-secondary">{formatDate(exp)}</span>;
      },
    },
    ...(bdayView
      ? [
          {
            key: 'birthday',
            header: '🎂 Rođendan',
            sortable: true,
            render: (r: EmployeeSafe) => {
              const bd = sv(r, 'birth_date');
              if (!bd) return '—';
              const d = daysUntilBirthday(bd);
              return (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-ink-secondary">{ddMm(bd)}</span>
                  {d === 0 ? <StatusBadge tone="info" label="danas 🎂" /> : d <= 30 ? <StatusBadge tone="info" label={`za ${d}d`} /> : null}
                </span>
              );
            },
          } as Column<EmployeeSafe>,
        ]
      : []),
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) =>
        r.is_active ? <StatusBadge tone="success" label="Aktivan" /> : <StatusBadge tone="neutral" label="Neaktivan" />,
    },
    {
      key: 'actions',
      header: 'Akcije',
      align: 'right',
      render: (r) => (
        <span className="inline-flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button className={rowBtn} disabled={!canEdit} title={canEdit ? 'Izmeni' : 'Samo pregled'} onClick={() => setForm({ editId: r.id })}>
            Izmeni
          </button>
          {r.is_active ? (
            <button
              className={rowBtn}
              disabled={!canEdit}
              title={canEdit ? 'Deaktiviraj zaposlenog (zadrži istoriju)' : 'Samo pregled'}
              onClick={() => setDeactivateFor(r)}
            >
              Deaktiviraj
            </button>
          ) : (
            <>
              <button className={rowBtn} disabled={!canEdit} title={canEdit ? 'Vrati u aktivne' : 'Samo pregled'} onClick={() => void activate(r)}>
                Aktiviraj
              </button>
              {canAdmin && (
                <button
                  className={cn(rowBtn, 'border-status-danger/40 text-status-danger hover:bg-status-danger-bg')}
                  title="Trajno obriši (samo admin) — može da padne ako postoje vezani podaci"
                  onClick={() => setPurgeFor(r)}
                >
                  🗑 Trajno
                </button>
              )}
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SummaryChips
        items={[
          { label: 'Ukupno', value: totAll, tone: 'accent' },
          { label: 'Aktivni', value: totActive },
          { label: 'Neaktivni', value: Math.max(0, totAll - totActive) },
          { label: 'Lekarski ističe <30d', value: medExpSoon, tone: medExpSoon > 0 ? 'warn' : 'default' },
          { label: 'Rođendani <30d', value: bdaySoon, tone: bdaySoon > 0 ? 'accent' : 'default' },
        ]}
      />

      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Brzi filteri">
        {QUICK_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            title={c.title}
            onClick={() => setQuick(c.key)}
            className={cn(
              'rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-2',
              quick === c.key && 'border-accent/50 bg-accent-subtle text-accent',
            )}
            aria-pressed={quick === c.key}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga po imenu, poziciji, email-u…" />
        <select className={SELECT_CLS} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Filter po odeljenju">
          <option value="">Sva odeljenja</option>
          {departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select className={SELECT_CLS} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter po statusu">
          <option value="">Svi statusi</option>
          <option value="active">Aktivni</option>
          <option value="inactive">Neaktivni</option>
        </select>
        <select className={SELECT_CLS} value={conType} onChange={(e) => setConType(e.target.value)} title="Filter po vrsti aktivnog ugovora" aria-label="Filter po vrsti ugovora">
          <option value="">Sve vrste ugovora</option>
          {CON_TYPE_OPTS.map((o) => (
            <option key={o.v} value={o.v}>{o.l}</option>
          ))}
        </select>
        <span className="ml-auto text-sm text-ink-secondary">
          {filtersActive && total !== totAll ? `${total} / ${totAll} zaposlenih` : `${total} zaposlenih`}
        </span>
        <Button variant="ghost" disabled={!canEdit || selected.size === 0} title="Selektuj redove za bulk akcije" onClick={() => setBulkOpen(true)}>
          ⚙ Bulk ({selected.size})
        </Button>
        <Button
          variant="ghost"
          disabled={!canAdd}
          title={canAdd ? 'Brzi unos više zaposlenih ili uvoz iz Excel/CSV' : 'Nove zaposlene mogu da dodaju samo HR i administrator'}
          onClick={() => setQuickEntryOpen(true)}
        >
          ⚡ Brzi unos
        </Button>
        <Button
          onClick={() => setForm({ editId: null })}
          disabled={!canAdd}
          title={canAdd ? '' : 'Nove zaposlene mogu da dodaju samo HR i administrator'}
        >
          + Novi zaposleni
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={listQ.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        sort={sort}
        onSortToggle={toggleSort}
        empty={
          <EmptyState
            title={!filtersActive && total === 0 ? 'Nema zaposlenih' : 'Nijedan rezultat ne odgovara filterima'}
            hint={!filtersActive && total === 0 ? 'Dodaj prvog zaposlenog.' : 'Promenite pretragu ili filtere.'}
          />
        }
      />

      {totalPages > 1 && (
        <Pager page={page} totalPages={totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPages, p + 1))} />
      )}

      {openId && <DosijeDialog id={openId} onClose={() => setOpenId(null)} />}

      {form && (
        <EmployeeFormDialog
          editId={form.editId}
          employees={rows}
          canPii={canPii}
          onClose={() => setForm(null)}
          onSaved={setToast}
        />
      )}

      {bulkOpen && selectedItems.length > 0 && (
        <EmpBulkActionsDialog
          items={selectedItems}
          onClose={() => setBulkOpen(false)}
          onDone={(msg) => {
            setToast(msg);
            setSelected(new Map());
          }}
        />
      )}

      {quickEntryOpen && (
        <EmpQuickEntryDialog canPii={canPii} onClose={() => setQuickEntryOpen(false)} onDone={setToast} />
      )}

      {deactivateFor && (
        <Dialog
          open
          onClose={() => setDeactivateFor(null)}
          title="Deaktiviranje zaposlenog"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeactivateFor(null)}>Otkaži</Button>
              <Button onClick={() => void confirmDeactivate()} loading={deactivateMut.isPending}>Deaktiviraj</Button>
            </>
          }
        >
          <p className="text-sm text-ink">
            Deaktivirati „{empDisplayName(deactivateFor)}"? Zaposleni će biti uklonjen iz aktivnih, ali sva istorija
            (ugovori, sati, odsustva) ostaje. Možeš ga kasnije vratiti.
          </p>
        </Dialog>
      )}

      {purgeFor && (
        <PurgeDialog emp={purgeFor} busy={deleteMut.isPending} onCancel={() => setPurgeFor(null)} onConfirm={() => void confirmPurge()} />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* Trajno brisanje (admin): potvrda kucanjem „OBRIŠI" — paritet 1.0 requireType. */
function PurgeDialog({
  emp,
  busy,
  onCancel,
  onConfirm,
}: {
  emp: EmployeeSafe;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = typed.trim().toUpperCase() === 'OBRIŠI';
  return (
    <Dialog
      open
      onClose={onCancel}
      title="Trajno brisanje zaposlenog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Otkaži</Button>
          <Button variant="danger" disabled={!ok} loading={busy} onClick={onConfirm}>Trajno obriši</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink">
          OPREZ: brisanjem zaposlenog „{empDisplayName(emp)}" trajno se gubi i sva vezana istorija. Ako postoje
          ugovori / sati / odsustva, baza će odbiti akciju — u tom slučaju ostavi deaktiviranog. Preporučujemo da
          prvo izvezeš podatke u Excel.
        </p>
        <p className="text-sm text-ink-secondary">Za potvrdu ukucaj „OBRIŠI":</p>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="OBRIŠI" aria-label="Potvrda brisanja" />
      </div>
    </Dialog>
  );
}
