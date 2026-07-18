'use client';

import { useMemo, useState } from 'react';
import { Users, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import {
  useAdminExpectations,
  useCreateExpectation,
  useCreateExpectationsBulk,
  useUpdateExpectation,
  useDeleteExpectation,
  type AdminExpectation,
} from '@/api/podesavanja';
import { useAllEmployees, type EmployeeSafe } from '@/api/kadrovska';

// ============================================================================
// Očekivanja zaposlenih — CRUD (paritet 1.0 `podesavanja/employeeExpectationsTab.js`).
// Tabela (zaposleni/naslov/status/rok⚠overdue/prioritet) + filteri (zaposleni/status).
// „+ Novo očekivanje" i „Uredi" = isti modal; „Obriši" = samo admin. „Dodaj za više" =
// kaskadni picker (odeljenje→pododeljenje) + pretraga + checkbox lista → bulk POST.
// Gating tab-a je na page-nivou (settings.org_profile); DELETE dodatno admin-only.
// ============================================================================

const STATUS_LABEL: Record<string, string> = {
  aktivno: 'Aktivno',
  u_toku: 'U toku',
  ispunjeno: 'Ispunjeno',
  otkazano: 'Otkazano',
};
const STATUS_TONE: Record<string, Tone> = {
  aktivno: 'info',
  u_toku: 'warn',
  ispunjeno: 'success',
  otkazano: 'neutral',
};
const PRIO_LABEL: Record<string, string> = { niska: 'Niska', srednja: 'Srednja', visoka: 'Visoka' };

/** ViewRow kolona kao string (EmployeeSafe nosi extra snake_case polja iz v_employees_safe). */
function sv(e: EmployeeSafe, key: string): string {
  const v = (e as Record<string, unknown>)[key];
  return v == null ? '' : String(v);
}
function empName(e: EmployeeSafe): string {
  return e.full_name || '—';
}
function isOverdue(due: string | null, status: string): boolean {
  if (!due) return false;
  if (status === 'ispunjeno' || status === 'otkazano') return false;
  const d = new Date(String(due).slice(0, 10));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

const SELECT_CLS = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

export function ExpectationsTab() {
  const { user } = useAuth();
  const isAdmin = (user?.role ?? '').trim().toLowerCase() === 'admin';

  const expQ = useAdminExpectations();
  const empQ = useAllEmployees(true);
  const rows = expQ.data?.data ?? [];
  const employees = useMemo(() => empQ.data ?? [], [empQ.data]);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const [fEmp, setFEmp] = useState('');
  const [fStatus, setFStatus] = useState<'active' | 'all' | 'aktivno' | 'u_toku' | 'ispunjeno' | 'otkazano'>('active');

  const [modal, setModal] = useState<{ mode: 'new' | 'edit'; row?: AdminExpectation } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [delRow, setDelRow] = useState<AdminExpectation | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (fEmp && r.employeeId !== fEmp) return false;
      if (fStatus === 'active') return r.status === 'aktivno' || r.status === 'u_toku';
      if (fStatus === 'all') return true;
      return r.status === fStatus;
    });
  }, [rows, fEmp, fStatus]);

  const nameOf = (id: string) => {
    const e = empById.get(id);
    return e ? empName(e) : '—';
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          Zaposleni
          <select value={fEmp} onChange={(e) => setFEmp(e.target.value)} className={SELECT_CLS} aria-label="Filter zaposleni">
            <option value="">Svi zaposleni</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {empName(e)}
                {e.department ? ` · ${e.department}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          Status
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} className={SELECT_CLS} aria-label="Filter status">
            <option value="active">Samo aktivna</option>
            <option value="all">Sva</option>
            <option value="aktivno">Aktivno</option>
            <option value="u_toku">U toku</option>
            <option value="ispunjeno">Ispunjeno</option>
            <option value="otkazano">Otkazano</option>
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => setBulkOpen(true)}>
            <Users className="h-4 w-4" aria-hidden /> Dodaj za više
          </Button>
          <Button onClick={() => setModal({ mode: 'new' })}>+ Novo očekivanje</Button>
        </div>
      </div>
      <p className="text-xs text-ink-secondary">
        Definišite konkretne ciljeve / zadatke sa rokom i prioritetom. Zaposleni vidi svoja u <strong className="text-ink">Moj profil</strong> i može sam da označi „u toku" / „ispunjeno".
      </p>

      {expQ.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : filtered.length === 0 ? (
        <EmptyState title="Nema očekivanja po trenutnom filteru" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="px-3 py-2">Zaposleni</th>
                <th className="px-3 py-2">Naslov</th>
                <th className="px-3 py-2">Rok</th>
                <th className="px-3 py-2">Prioritet</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Definisao</th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const overdue = isOverdue(e.dueDate, e.status);
                return (
                  <tr key={e.id} className={`border-b border-line-soft hover:bg-surface-2 ${overdue ? 'bg-status-warn-bg/40' : ''}`}>
                    <td className="px-3 py-2 text-ink">{nameOf(e.employeeId)}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{e.title}</div>
                      {e.descriptionMd && (
                        <div className="max-w-[420px] truncate text-xs text-ink-secondary">{e.descriptionMd}</div>
                      )}
                    </td>
                    <td className={`px-3 py-2 tnums ${overdue ? 'font-semibold text-status-warn' : 'text-ink-secondary'}`}>
                      {overdue && <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />}
                      {e.dueDate ? formatDate(e.dueDate) : '—'}
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">{PRIO_LABEL[e.priority] ?? e.priority}</td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={STATUS_TONE[e.status] ?? 'neutral'} label={STATUS_LABEL[e.status] ?? e.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-secondary">{e.createdBy || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setModal({ mode: 'edit', row: e })}
                          title="Uredi"
                          aria-label="Uredi"
                          className="rounded p-1 text-ink-secondary hover:bg-surface-2"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => setDelRow(e)}
                            title="Obriši"
                            aria-label="Obriši"
                            className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <ExpectationModal
          mode={modal.mode}
          row={modal.row}
          employees={employees}
          onClose={() => setModal(null)}
        />
      )}
      {bulkOpen && <BulkModal employees={employees} onClose={() => setBulkOpen(false)} />}
      {delRow && <DeleteModal row={delRow} name={nameOf(delRow.employeeId)} onClose={() => setDelRow(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- Add / edit modal

function ExpectationModal({
  mode,
  row,
  employees,
  onClose,
}: {
  mode: 'new' | 'edit';
  row?: AdminExpectation;
  employees: EmployeeSafe[];
  onClose: () => void;
}) {
  const createM = useCreateExpectation();
  const updateM = useUpdateExpectation();
  const isNew = mode === 'new';

  const [employeeId, setEmployeeId] = useState(row?.employeeId ?? '');
  const [title, setTitle] = useState(row?.title ?? '');
  const [descriptionMd, setDescriptionMd] = useState(row?.descriptionMd ?? '');
  const [dueDate, setDueDate] = useState(row?.dueDate ? String(row.dueDate).slice(0, 10) : '');
  const [priority, setPriority] = useState(row?.priority ?? 'srednja');
  const [status, setStatus] = useState(row?.status ?? 'aktivno');
  const [completionNote, setCompletionNote] = useState(
    (row as { completionNote?: string | null } | undefined)?.completionNote ?? '',
  );
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (isNew && !employeeId) return setErr('Izaberite zaposlenog.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    const common = {
      title: title.trim(),
      descriptionMd: descriptionMd.trim() || null,
      dueDate: dueDate || null,
      priority,
      status,
      completionNote: completionNote.trim() || null,
    };
    try {
      if (isNew) {
        await createM.mutateAsync({ employeeId, ...common });
        toast('✅ Očekivanje dodato');
      } else if (row) {
        await updateM.mutateAsync({ id: row.id, ...common });
        toast('✅ Očekivanje sačuvano');
      }
      onClose();
    } catch (e) {
      const forbidden = e instanceof ApiError && e.status === 403;
      setErr(forbidden ? 'Nemate dozvolu za ovu izmenu.' : e instanceof ApiError ? e.message : 'Snimanje nije uspelo.');
    }
  }

  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';
  const taCls =
    'w-full resize-y rounded-control border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none';

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Novo očekivanje' : 'Uredi očekivanje'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={createM.isPending || updateM.isPending}>
            {isNew ? 'Dodaj' : 'Snimi'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          Konkretan zadatak/cilj sa rokom. Zaposleni ga vidi u Moj profil i može sam da označi „u toku" ili „ispunjeno".
        </p>
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}

        <FormField label="Zaposleni" required>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!isNew} className={selCls}>
            {isNew && <option value="">— izaberi —</option>}
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {empName(e)}
                {e.department ? ` · ${e.department}` : ''}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Npr. „Završiti sertifikaciju za zavarivanje”" />
        </FormField>

        <FormField label="Opis (markdown, opciono)">
          <textarea value={descriptionMd} onChange={(e) => setDescriptionMd(e.target.value)} rows={4} placeholder={'- Stavka 1\n- Stavka 2'} className={taCls} />
        </FormField>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Rok">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={selCls} />
          </FormField>
          <FormField label="Prioritet">
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>
              <option value="niska">Niska</option>
              <option value="srednja">Srednja</option>
              <option value="visoka">Visoka</option>
            </select>
          </FormField>
          <FormField label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls}>
              <option value="aktivno">Aktivno</option>
              <option value="u_toku">U toku</option>
              <option value="ispunjeno">Ispunjeno</option>
              <option value="otkazano">Otkazano</option>
            </select>
          </FormField>
        </div>

        <FormField label="Napomena o ispunjenju (opciono)">
          <textarea value={completionNote} onChange={(e) => setCompletionNote(e.target.value)} rows={2} placeholder="Šta je urađeno, koje su prepreke..." className={taCls} />
        </FormField>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Bulk „Dodaj za više”

function BulkModal({ employees, onClose }: { employees: EmployeeSafe[]; onClose: () => void }) {
  const bulkM = useCreateExpectationsBulk();

  const [title, setTitle] = useState('');
  const [descriptionMd, setDescriptionMd] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('srednja');
  const [status, setStatus] = useState('aktivno');
  const [err, setErr] = useState<string | null>(null);

  const [deptId, setDeptId] = useState('');
  const [subDeptId, setSubDeptId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Kaskadni izbori iz tekućeg employees skupa (paritet 1.0 bulk picker).
  const depts = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) {
      const id = sv(e, 'department_id');
      if (id) m.set(id, e.department || sv(e, 'department') || id);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sr'));
  }, [employees]);

  const subDepts = useMemo(() => {
    if (!deptId) return [] as [string, string][];
    const m = new Map<string, string>();
    for (const e of employees) {
      if (sv(e, 'department_id') !== deptId) continue;
      const id = sv(e, 'sub_department_id');
      if (id) m.set(id, sv(e, 'sub_department_name') || id);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sr'));
  }, [employees, deptId]);

  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (deptId && sv(e, 'department_id') !== deptId) return false;
      if (subDeptId && sv(e, 'sub_department_id') !== subDeptId) return false;
      if (s) {
        return empName(e).toLowerCase().includes(s) || (e.position ?? '').toLowerCase().includes(s);
      }
      return true;
    });
  }, [employees, deptId, subDeptId, search]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of visible) next.add(e.id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  async function apply() {
    setErr(null);
    if (!title.trim()) return setErr('Naslov je obavezan.');
    const ids = [...selected];
    if (ids.length === 0) return setErr('Izaberite bar jednog zaposlenog.');
    try {
      const res = await bulkM.mutateAsync({
        employeeIds: ids,
        title: title.trim(),
        descriptionMd: descriptionMd.trim() || null,
        dueDate: dueDate || null,
        priority,
        status,
      });
      const created = res.data?.created ?? ids.length;
      toast(`✅ Dodato ${created} ${created === 1 ? 'očekivanje' : 'očekivanja'}`);
      onClose();
    } catch (e) {
      const forbidden = e instanceof ApiError && e.status === 403;
      setErr(forbidden ? 'Nemate dozvolu (admin/menadžment/pm/lpm).' : e instanceof ApiError ? e.message : 'Snimanje nije uspelo.');
    }
  }

  const n = selected.size;
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';
  const filterCls = 'h-8 w-full rounded-control border border-line bg-surface-2 px-2 text-sm text-ink';
  const taCls =
    'w-full resize-y rounded-control border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none';

  return (
    <Dialog
      open
      onClose={onClose}
      size="2xl"
      title="Dodaj očekivanje za više zaposlenih"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={apply} loading={bulkM.isPending} disabled={n === 0}>
            Dodaj za {n} {n === 1 ? 'zaposlenog' : 'zaposlenih'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-secondary">
        Isti zadatak/cilj sa istim rokom — primeni na više radnika odjednom. Svaki radnik dobija svoj zaseban red (status može da menja nezavisno).
      </p>
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {/* LEVO: forma */}
        <div className="space-y-3">
          <FormField label="Naslov" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Npr. „Završiti obuku za PPZ”" />
          </FormField>
          <FormField label="Opis (markdown, opciono)">
            <textarea value={descriptionMd} onChange={(e) => setDescriptionMd(e.target.value)} rows={3} placeholder={'- Stavka 1\n- Stavka 2'} className={taCls} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Rok">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={selCls} />
            </FormField>
            <FormField label="Prioritet">
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>
                <option value="niska">Niska</option>
                <option value="srednja">Srednja</option>
                <option value="visoka">Visoka</option>
              </select>
            </FormField>
          </div>
          <FormField label="Početni status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls}>
              <option value="aktivno">Aktivno</option>
              <option value="u_toku">U toku</option>
            </select>
          </FormField>
        </div>

        {/* DESNO: picker */}
        <div className="flex min-h-0 flex-col rounded-panel border border-line bg-surface p-3">
          <div className="mb-2 text-sm font-semibold text-ink">Zaposleni (čekirajte radnike)</div>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <select
              value={deptId}
              onChange={(e) => {
                setDeptId(e.target.value);
                setSubDeptId('');
              }}
              className={filterCls}
              aria-label="Odeljenje"
            >
              <option value="">— Sva odeljenja —</option>
              {depts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select value={subDeptId} onChange={(e) => setSubDeptId(e.target.value)} disabled={!deptId || subDepts.length === 0} className={filterCls} aria-label="Pododeljenje">
              <option value="">— Sva pododeljenja —</option>
              {subDepts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pretraži po imenu..."
            className={`${filterCls} mb-2`}
          />
          <div className="mb-2 flex gap-2 text-xs">
            <button type="button" onClick={selectAllVisible} className="rounded-control border border-line bg-surface px-2 py-0.5 text-ink-secondary hover:bg-surface-2 hover:text-ink">
              Označi sve vidljive
            </button>
            <button type="button" onClick={clearSelection} className="rounded-control border border-line bg-surface px-2 py-0.5 text-ink-secondary hover:bg-surface-2 hover:text-ink">
              Odznači sve
            </button>
          </div>
          <div className="max-h-[280px] min-h-[160px] flex-1 overflow-y-auto rounded-control border border-line bg-surface-2 p-1">
            {visible.length === 0 ? (
              <div className="py-6 text-center text-sm text-ink-disabled">Nema rezultata.</div>
            ) : (
              visible.map((e) => {
                const meta = [e.department, e.position].filter(Boolean).join(' · ');
                return (
                  <label key={e.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface">
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                    <span className="flex-1">
                      <span className="text-ink">{empName(e)}</span>
                      {meta && <span className="block text-xs text-ink-secondary">{meta}</span>}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <div className="mt-2 text-right text-sm text-ink-secondary">Izabrano: {n}</div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Delete confirm (admin)

function DeleteModal({ row, name, onClose }: { row: AdminExpectation; name: string; onClose: () => void }) {
  const delM = useDeleteExpectation();
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      await delM.mutateAsync({ id: row.id });
      toast('🗑 Očekivanje obrisano');
      onClose();
    } catch (e) {
      const forbidden = e instanceof ApiError && e.status === 403;
      setErr(forbidden ? 'Brisanje je dozvoljeno samo administratoru.' : e instanceof ApiError ? e.message : 'Brisanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Brisanje očekivanja"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="danger" onClick={go} loading={delM.isPending}>
            Obriši
          </Button>
        </>
      }
    >
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      <p className="text-sm text-ink">
        Obrisati očekivanje <b>„{row.title}”</b> za <b>{name}</b>?
      </p>
    </Dialog>
  );
}
