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
  useContracts,
  useDeactivateEmployee,
  useDeleteEmployee,
  useEmployees,
  useUpdateEmployee,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { sv, SummaryChips } from './common';
import {
  CON_TYPE_OPTS,
  birthdayInNext30,
  compareEmpByLastFirst,
  daysUntilBirthday,
  ddMm,
  empDisplayName,
  medicalDaysLeft,
} from './emp-shared';
import { DosijeDialog } from './dossier';
import { EmployeeFormDialog } from './employee-form';
import { EmpBulkActionsDialog } from './emp-bulk-actions';

// Lista zaposlenih — pun 1.0 paritet (employeesTab.js): quick-filter chips,
// filteri odeljenje/status/vrsta-ugovora, summary chips, sort po kolonama
// (persist u localStorage), bulk selekcija, CRUD (novi/izmeni/deaktiviraj/
// aktiviraj/trajno brisanje). Red otvara Dosije (dossier.tsx).
//
// TODO(P1a): BE GET /employees nema sort/quick-filter parametre — do tada
// klijentski fallback: fetch bez efektivne paginacije (pageSize 500) pa
// filter/sort u FE. Kad P1a doda parametre, prebaciti na server-side.

type QuickKey = 'all' | 'active' | 'med-soon' | 'bday-soon' | 'missing-jmbg' | 'no-email' | 'no-phone';

const QUICK_CHIPS: { key: QuickKey; label: string; title?: string }[] = [
  { key: 'all', label: 'Svi' },
  { key: 'active', label: '✓ Aktivni' },
  { key: 'med-soon', label: '🩺 Lekarski <30d', title: 'Lekarski ističe u narednih 30 dana' },
  { key: 'bday-soon', label: '🎂 Rođendani <30d', title: 'Rođendani u narednih 30 dana' },
  { key: 'missing-jmbg', label: '⚠ Bez JMBG', title: 'Zaposleni bez upisanog JMBG-a' },
  { key: 'no-email', label: '📧 Bez email-a', title: 'Zaposleni bez email-a — neće dobijati notifikacije' },
  { key: 'no-phone', label: '📱 Bez telefona', title: 'Zaposleni bez telefona — neće dobijati WhatsApp/SMS obaveštenja' },
];

const SORT_KEY_LS = 'kadr_emp_sort_v1';

const SORT_ACCESSORS: Record<string, (e: EmployeeSafe) => string | number> = {
  name: (e) => ((sv(e, 'last_name') + ' ' + sv(e, 'first_name')).trim() || sv(e, 'full_name')).toLocaleLowerCase('sr'),
  position: (e) => sv(e, 'position').toLocaleLowerCase('sr'),
  department: (e) => sv(e, 'department').toLocaleLowerCase('sr'),
  subDepartment: (e) => sv(e, 'sub_department_name').toLocaleLowerCase('sr'),
  email: (e) => sv(e, 'email').toLocaleLowerCase('sr'),
  medical: (e) => sv(e, 'medical_exam_expires'),
  bday: (e) => daysUntilBirthday(sv(e, 'birth_date')),
  status: (e) => (e.is_active ? '1-aktivan' : '2-neaktivan'),
};

const SELECT_CLS = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

function loadSort(): SortState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SORT_KEY_LS);
    if (!raw) return null;
    const p = JSON.parse(raw) as SortState;
    return p && typeof p.key === 'string' && (p.dir === 'asc' || p.dir === 'desc') ? p : null;
  } catch {
    return null;
  }
}

export function ZaposleniTab() {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.KADROVSKA_EDIT);
  // Nov slog (INSERT) sme samo admin/HR/poslovni_admin — FE afordansa preko
  // kadrovska.manage; backend guard + sy15 RLS presuđuju (1.0 canAddEmployeeRecord).
  const canAdd = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);

  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<QuickKey>('all');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [conType, setConType] = useState('');
  const [sort, setSort] = useState<SortState | null>(loadSort);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ editId: string | null } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deactivateFor, setDeactivateFor] = useState<EmployeeSafe | null>(null);
  const [purgeFor, setPurgeFor] = useState<EmployeeSafe | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // TODO(P1a): server-side sort/filteri/paginacija — do tada sve odjednom.
  const listQ = useEmployees({ page, pageSize: 500 });
  const all = useMemo(() => listQ.data?.data ?? [], [listQ.data]);
  const totalPages = listQ.data?.meta.pagination.totalPages ?? 1;

  const deactivateMut = useDeactivateEmployee();
  const deleteMut = useDeleteEmployee();
  const updateMut = useUpdateEmployee();

  /* Mapa zaposleni→vrsta aktivnog (ne-arhiviranog) ugovora — najnoviji po „od". */
  const contractsQ = useContracts({}, canContracts);
  const conTypeByEmp = useMemo(() => {
    const best = new Map<string, { type: string; dateFrom: string }>();
    for (const c of contractsQ.data?.data ?? []) {
      if (!c.employeeId || c.archivedAt || c.isActive === false || !c.contractType) continue;
      const prev = best.get(c.employeeId);
      if (!prev || String(c.dateFrom || '') > prev.dateFrom) {
        best.set(c.employeeId, { type: c.contractType, dateFrom: String(c.dateFrom || '') });
      }
    }
    const out = new Map<string, string>();
    for (const [id, v] of best) out.set(id, v.type);
    return out;
  }, [contractsQ.data]);

  const departments = useMemo(
    () => Array.from(new Set(all.map((e) => sv(e, 'department')).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sr')),
    [all],
  );

  /* Filteri — paritet 1.0 applyFilters (quick chip preglas + obični filteri). */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return all.filter((e) => {
      if (quick !== 'all') {
        if (quick === 'active' && !e.is_active) return false;
        if (quick === 'med-soon') {
          if (!e.is_active) return false;
          const exp = sv(e, 'medical_exam_expires');
          if (!exp || exp.slice(0, 10) > in30) return false;
        }
        if (quick === 'bday-soon') {
          if (!e.is_active || !birthdayInNext30(sv(e, 'birth_date'))) return false;
        }
        if (quick === 'missing-jmbg') {
          if (/^\d{13}$/.test(sv(e, 'personal_id'))) return false;
        }
        if (quick === 'no-email') {
          const em = sv(e, 'email');
          if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return false;
        }
        if (quick === 'no-phone') {
          if (!e.is_active) return false;
          const digits = (sv(e, 'phone_work') || sv(e, 'phone')).replace(/\D/g, '');
          if (digits.length >= 8) return false;
        }
      }
      if (dept && sv(e, 'department') !== dept) return false;
      if (status === 'active' && !e.is_active) return false;
      if (status === 'inactive' && e.is_active) return false;
      if (conType && conTypeByEmp.get(e.id) !== conType) return false;
      if (needle) {
        const hay = [
          empDisplayName(e), sv(e, 'first_name'), sv(e, 'last_name'), sv(e, 'position'),
          sv(e, 'department'), sv(e, 'sub_department_name'), sv(e, 'team'),
          sv(e, 'email'), sv(e, 'phone_work') || sv(e, 'phone'), sv(e, 'note'),
        ].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [all, quick, dept, status, conType, conTypeByEmp, q]);

  const bdayView = quick === 'bday-soon';

  /* Sort: eksplicitni klik-sort > bday view (najbliži rođendan) > „Prezime Ime". */
  const rows = useMemo(() => {
    const base = [...filtered];
    if (sort && SORT_ACCESSORS[sort.key]) {
      const acc = SORT_ACCESSORS[sort.key];
      const mul = sort.dir === 'asc' ? 1 : -1;
      base.sort((a, b) => {
        const va = acc(a);
        const vb = acc(b);
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
        return String(va).localeCompare(String(vb), 'sr') * mul;
      });
    } else if (bdayView) {
      base.sort((a, b) => daysUntilBirthday(sv(a, 'birth_date')) - daysUntilBirthday(sv(b, 'birth_date')));
    } else {
      base.sort(compareEmpByLastFirst);
    }
    return base;
  }, [filtered, sort, bdayView]);

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

  /* Summary chips — nad CELOM listom (ne filtriranom), paritet 1.0. */
  const summary = useMemo(() => {
    const totAll = all.length;
    const totActive = all.filter((e) => e.is_active).length;
    const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    let medExpSoon = 0;
    let bdaySoon = 0;
    for (const e of all) {
      if (!e.is_active) continue;
      const exp = sv(e, 'medical_exam_expires');
      if (exp && exp.slice(0, 10) <= in30) medExpSoon++;
      if (birthdayInNext30(sv(e, 'birth_date'))) bdaySoon++;
    }
    return { totAll, totActive, totInactive: totAll - totActive, medExpSoon, bdaySoon };
  }, [all]);

  /* Selekcija — preživljava promene filtera (1.0 _empSelectedIds). */
  const visibleIds = rows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedItems = useMemo(() => all.filter((e) => selected.has(e.id)), [all, selected]);

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
        const next = new Set(prev);
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
          onChange={() => toggleSelect(r.id)}
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
            key: 'bday',
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
          { label: 'Ukupno', value: summary.totAll, tone: 'accent' },
          { label: 'Aktivni', value: summary.totActive },
          { label: 'Neaktivni', value: summary.totInactive },
          { label: 'Lekarski ističe <30d', value: summary.medExpSoon, tone: summary.medExpSoon > 0 ? 'warn' : 'default' },
          { label: 'Rođendani <30d', value: summary.bdaySoon, tone: summary.bdaySoon > 0 ? 'accent' : 'default' },
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
        {canContracts && (
          <select className={SELECT_CLS} value={conType} onChange={(e) => setConType(e.target.value)} title="Filter po vrsti aktivnog ugovora" aria-label="Filter po vrsti ugovora">
            <option value="">Sve vrste ugovora</option>
            {CON_TYPE_OPTS.map((o) => (
              <option key={o.v} value={o.v}>{o.l}</option>
            ))}
          </select>
        )}
        <span className="ml-auto text-sm text-ink-secondary">
          {rows.length === all.length ? `${all.length} zaposlenih` : `${rows.length} / ${all.length} zaposlenih`}
        </span>
        <Button variant="ghost" disabled={!canEdit || selected.size === 0} title="Selektuj redove za bulk akcije" onClick={() => setBulkOpen(true)}>
          ⚙ Bulk ({selected.size})
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
            title={all.length === 0 ? 'Nema zaposlenih' : 'Nijedan rezultat ne odgovara filterima'}
            hint={all.length === 0 ? 'Dodaj prvog zaposlenog.' : 'Promenite pretragu ili filtere.'}
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
          employees={all}
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
            setSelected(new Set());
          }}
        />
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
