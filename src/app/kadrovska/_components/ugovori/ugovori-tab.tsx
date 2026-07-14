'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useContracts,
  useDirectory,
  useUpdateContract,
  useArchiveContract,
  useRestoreContract,
  useDeleteContract,
  useNotificationConfig,
  useUpdateNotificationConfig,
  type Contract,
} from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import {
  CON_TYPE_OPTS,
  CON_TYPE_LABELS,
  CONTRACT_PDF_TYPES,
  contractStatus,
  todayYmd,
  ymdAddMonths,
} from './shared';
import { ToastHost, pushToast } from './toast';
import { ContractForm } from './contract-form';
import { ContractGenerateDialog, openResenjePdf } from './contract-generate';
import { MassDocsDialog } from './mass-docs-dialog';

type SortKey = 'employee' | 'type' | 'number' | 'dateFrom' | 'dateTo' | 'status';
type SortDir = 'asc' | 'desc';
const SORT_STORE = 'pm_con_sort_v1';

export function UgovoriTab() {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.KADROVSKA_EDIT);
  const canGenerate = can(PERMISSIONS.KADROVSKA_PII);
  const canManage = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canReadSalary = can(PERMISSIONS.KADROVSKA_SALARY);

  const contractsQ = useContracts({}, true);
  const archiveM = useArchiveContract();
  const restoreM = useRestoreContract();
  const deleteM = useDeleteContract();
  const dirQ = useDirectory();
  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of dirQ.data?.data ?? []) m.set(sv(r, 'id'), sv(r, 'full_name'));
    return m;
  }, [dirQ.data]);
  const empName = (id: string) => nameMap.get(id) || id.slice(0, 8);

  const items = contractsQ.data?.data ?? [];

  // Filteri
  const [empF, setEmpF] = useState('');
  const [typeF, setTypeF] = useState('');
  const [statusF, setStatusF] = useState('active');
  const [archView, setArchView] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'dateFrom', dir: 'desc' });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SORT_STORE);
      if (raw) setSort(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);
  function toggleSort(key: SortKey) {
    setSort((s) => {
      const next: { key: SortKey; dir: SortDir } =
        s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      try {
        localStorage.setItem(SORT_STORE, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Panelska stanja
  const [formFor, setFormFor] = useState<{ contract: Contract | null } | null>(null);
  const [genFor, setGenFor] = useState<Contract | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [massOpen, setMassOpen] = useState(false);

  // Enrich + filter
  const enriched = useMemo(() => {
    const base = archView ? items.filter((c) => c.archivedAt) : items.filter((c) => !c.archivedAt);
    return base.map((c) => ({ c, status: contractStatus(c) }));
  }, [items, archView]);

  const filtered = useMemo(() => {
    const rows = enriched.filter(({ c, status }) => {
      if (empF && c.employeeId !== empF) return false;
      if (typeF && c.contractType !== typeF) return false;
      if (!archView) {
        if (statusF === 'active' && status.key !== 'active' && status.key !== 'expiring') return false;
        if (statusF === 'inactive' && status.key !== 'inactive') return false;
        if (statusF === 'expiring' && status.key !== 'expiring') return false;
        if (statusF === 'expired' && status.key !== 'expired') return false;
      }
      return true;
    });
    const acc: Record<SortKey, (r: (typeof rows)[number]) => string> = {
      employee: (r) => empName(r.c.employeeId).toLowerCase(),
      type: (r) => r.c.contractType || '',
      number: (r) => r.c.contractNumber || '',
      dateFrom: (r) => r.c.dateFrom || '',
      dateTo: (r) => r.c.dateTo || '',
      status: (r) =>
        r.status.key === 'active' ? '1' : r.status.key === 'expiring' ? '2' : r.status.key === 'expired' ? '3' : '4',
    };
    const get = acc[sort.key];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => get(a).localeCompare(get(b), 'sr') * dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched, empF, typeF, statusF, archView, sort, nameMap]);

  // Summary (aktivni prikaz)
  const activeItems = useMemo(() => items.filter((c) => !c.archivedAt), [items]);
  const summary = useMemo(() => {
    let a = 0, ex = 0, exp = 0, ina = 0;
    for (const c of activeItems) {
      const s = contractStatus(c);
      if (s.key === 'active') a++;
      else if (s.key === 'expiring') { ex++; a++; }
      else if (s.key === 'expired') exp++;
      else ina++;
    }
    return { total: activeItems.length, active: a, expiring: ex, expired: exp, inactive: ina };
  }, [activeItems]);

  const empOptions = useMemo(
    () => [...nameMap.entries()].sort((x, y) => x[1].localeCompare(y[1], 'sr')),
    [nameMap],
  );

  function toggleRow(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(filtered.filter(({ c }) => !c.archivedAt).map(({ c }) => c.id)) : new Set());
  }

  // Contract form panel
  if (formFor) {
    return (
      <>
        <ContractForm
          contract={formFor.contract}
          canGenerate={canGenerate}
          onCancel={() => setFormFor(null)}
          onSaved={(saved, generate) => {
            setFormFor(null);
            void contractsQ.refetch();
            if (generate) setGenFor(saved);
          }}
        />
        <ToastHost />
      </>
    );
  }

  const SortHead = ({ k, label }: { k: SortKey; label: string }) => (
    <button type="button" onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-ink">
      {label}
      <span className="text-2xs text-ink-disabled">{sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <SummaryChips
        items={[
          { label: 'Ukupno', value: summary.total, tone: 'accent' },
          { label: 'Aktivni', value: summary.active },
          { label: 'Ističu < 30 d', value: summary.expiring, tone: summary.expiring > 0 ? 'warn' : 'default' },
          { label: 'Istekli', value: summary.expired, tone: summary.expired > 0 ? 'danger' : 'default' },
          { label: 'Neaktivni', value: summary.inactive },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <select value={empF} onChange={(e) => setEmpF(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="">Svi zaposleni</option>
          {empOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={typeF} onChange={(e) => setTypeF(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="">Svi tipovi</option>
          {CON_TYPE_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
        <select
          value={statusF}
          onChange={(e) => setStatusF(e.target.value)}
          disabled={archView}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink disabled:opacity-50"
        >
          <option value="active">Aktivni</option>
          <option value="all">Svi</option>
          <option value="inactive">Neaktivni</option>
          <option value="expiring">Ističu &lt; 30 dana</option>
          <option value="expired">Istekli</option>
        </select>
        <select value={archView ? 'archived' : 'active'} onChange={(e) => setArchView(e.target.value === 'archived')} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="active">Aktivni (ne-arhivirani)</option>
          <option value="archived">Arhivirani</option>
        </select>

        <span className="ml-auto text-sm text-ink-secondary">
          {filtered.length === enriched.length ? `${enriched.length} ugovora` : `${filtered.length} / ${enriched.length} ugovora`}
        </span>
        {canManage && (
          <Button variant="secondary" onClick={() => setSettingsOpen(true)} title="Podešavanje isteka ugovora (lead-days)">
            ⚙ Podešavanja
          </Button>
        )}
        {canGenerate && (
          <Button variant="secondary" onClick={() => setMassOpen(true)}>
            📦 Masovno
          </Button>
        )}
        {canEdit && !archView && (
          <Button variant="secondary" onClick={() => setBulkOpen(true)} disabled={selected.size === 0}>
            ⚙ Bulk ({selected.size})
          </Button>
        )}
        {canEdit && (
          <Button onClick={() => setFormFor({ contract: null })}>+ Novi ugovor</Button>
        )}
      </div>

      {contractsQ.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={archView ? 'Nema arhiviranih ugovora' : enriched.length === 0 ? 'Nema ugovora' : 'Nijedan rezultat ne odgovara filterima'}
          hint={!archView && enriched.length === 0 ? 'Dodaj prvi ugovor o radu — možeš generisati i PDF rešenje.' : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="border-b border-line bg-surface-2 text-left text-xs text-ink-secondary">
              <tr>
                {!archView && (
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Selektuj sve"
                      disabled={!canEdit}
                      checked={selected.size > 0 && filtered.every(({ c }) => c.archivedAt || selected.has(c.id))}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                )}
                <th className="px-3 py-2"><SortHead k="employee" label="Zaposleni" /></th>
                <th className="px-3 py-2"><SortHead k="type" label="Tip" /></th>
                <th className="px-3 py-2"><SortHead k="number" label="Br. ugovora" /></th>
                <th className="px-3 py-2">Pozicija</th>
                <th className="px-3 py-2"><SortHead k="dateFrom" label="Od" /></th>
                <th className="px-3 py-2"><SortHead k="dateTo" label="Do" /></th>
                <th className="px-3 py-2"><SortHead k="status" label="Status" /></th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ c, status }) => (
                <tr
                  key={c.id}
                  className={`border-b border-line/60 ${status.key === 'expired' ? 'bg-status-danger-bg/40' : status.key === 'expiring' ? 'bg-status-warn-bg/40' : ''}`}
                >
                  {!archView && (
                    <td className="px-3 py-2">
                      <input type="checkbox" disabled={!canEdit} checked={selected.has(c.id)} onChange={() => toggleRow(c.id)} />
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium text-ink">{empName(c.employeeId)}</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary">
                      {CON_TYPE_LABELS[c.contractType] || c.contractType}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">{c.contractNumber || '—'}</td>
                  <td className="px-3 py-2 text-ink-secondary">{c.position || '—'}</td>
                  <td className="px-3 py-2 text-ink-secondary">{c.dateFrom ? formatDate(c.dateFrom) : '—'}</td>
                  <td className="px-3 py-2 text-ink-secondary">
                    {c.dateTo ? formatDate(c.dateTo) : '—'}
                    {status.key === 'expiring' && (
                      <span className="ml-1 text-2xs font-semibold text-status-warn">ISTIČE ZA {status.days} D</span>
                    )}
                    {status.key === 'expired' && <span className="ml-1 text-2xs font-semibold text-status-danger">ISTEKAO</span>}
                  </td>
                  <td className="px-3 py-2"><StatusBadge tone={status.tone} label={status.label} /></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <RowBtn label="📄 PDF" title="Štampa rešenja o zasnivanju" onClick={() => void openResenjePdf(c, empName(c.employeeId))} />
                      {c.archivedAt ? (
                        <>
                          <RowBtn label="Vrati" disabled={!canEdit} onClick={() => restore(c.id)} />
                          <RowBtn label="Obriši" danger disabled={!canEdit} onClick={() => del(c.id)} />
                        </>
                      ) : (
                        <>
                          <RowBtn label="Izmeni" disabled={!canEdit} onClick={() => setFormFor({ contract: c })} />
                          {canGenerate && CONTRACT_PDF_TYPES.has(c.contractType) && (
                            <RowBtn label="📑 Ugovor" title="Generiši ugovor o radu i sačuvaj" onClick={() => setGenFor(c)} />
                          )}
                          <RowBtn label="Arhiviraj" danger disabled={!canEdit} onClick={() => archive(c.id)} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {genFor && (
        <ContractGenerateDialog
          contract={genFor}
          empName={empName(genFor.employeeId)}
          onClose={() => setGenFor(null)}
          onDone={() => {
            setGenFor(null);
            void contractsQ.refetch();
          }}
        />
      )}
      {bulkOpen && (
        <BulkDialog
          contracts={items.filter((c) => selected.has(c.id) && !c.archivedAt)}
          empName={empName}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            setSelected(new Set());
            void contractsQ.refetch();
          }}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {massOpen && (
        <MassDocsDialog
          selectedEmployeeIds={[...new Set(items.filter((c) => selected.has(c.id)).map((c) => c.employeeId))]}
          canSalary={canReadSalary}
          onClose={() => setMassOpen(false)}
        />
      )}
      <ToastHost />
    </div>
  );

  function archive(id: string) {
    if (!confirm('Arhivirati ugovor? Sklanja se iz aktivne evidencije (možeš ga kasnije vratiti).')) return;
    archiveM.mutate({ id }, { onSuccess: () => pushToast('📦 Ugovor arhiviran'), onError: (e) => pushToast('⚠ ' + errMsg(e)) });
  }
  function restore(id: string) {
    restoreM.mutate({ id }, { onSuccess: () => pushToast('↩ Ugovor vraćen'), onError: (e) => pushToast('⚠ ' + errMsg(e)) });
  }
  function del(id: string) {
    if (!confirm('Obrisati ugovor trajno? Akcija je nepovratna.')) return;
    deleteM.mutate({ id }, { onSuccess: () => pushToast('🗑 Ugovor obrisan'), onError: (e) => pushToast('⚠ ' + errMsg(e)) });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Greška';
}

function RowBtn({ label, onClick, disabled, danger, title }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-control border px-2 py-1 text-xs disabled:opacity-40 ${
        danger ? 'border-status-danger/40 text-status-danger hover:bg-status-danger-bg' : 'border-line text-ink hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/* ── Bulk dialog ─────────────────────────────────────────────────────────── */

function BulkDialog({
  contracts,
  empName,
  onClose,
  onDone,
}: {
  contracts: Contract[];
  empName: (id: string) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const update = useUpdateContract();
  const [act, setAct] = useState<'extendDate' | 'extendMonths' | 'deactivate'>('extendDate');
  const [extendTo, setExtendTo] = useState(todayYmd());
  const [months, setMonths] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setError(null);
    if (act === 'extendDate' && !extendTo) {
      setError('Izaberi novi „Datum do".');
      return;
    }
    if (act === 'extendMonths' && (!months || months < 1)) {
      setError('Broj meseci mora biti ≥ 1.');
      return;
    }
    if (!confirm(`Primeniti akciju nad ${contracts.length} ugovor(a)? Ne može se poništiti.`)) return;
    setBusy(true);
    const today = todayYmd();
    let ok = 0, fail = 0;
    for (const c of contracts) {
      const patch: Partial<Contract> = {};
      if (act === 'extendDate') {
        if (extendTo < (c.dateFrom || '0000-00-00')) { fail++; continue; }
        patch.dateTo = extendTo;
      } else if (act === 'extendMonths') {
        patch.dateTo = ymdAddMonths(c.dateTo || today, months);
      } else {
        patch.isActive = false;
      }
      try {
        await update.mutateAsync({ id: c.id, patch });
        ok++;
      } catch {
        fail++;
      }
    }
    pushToast(fail === 0 ? `✅ Promenjeno ${ok} ugovor(a)` : `⚠ Promenjeno ${ok}, neuspešno ${fail}`);
    onDone();
  }

  const preview = contracts.slice(0, 5).map((c) => empName(c.employeeId)).join(', ') + (contracts.length > 5 ? ` … +${contracts.length - 5}` : '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={`⚙ Bulk akcija — ${contracts.length} ugovor(a)`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={apply} loading={busy}>Primeni</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs text-ink-secondary">{preview}</p>
        {error && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-status-danger">{error}</p>}
        <label className="flex items-start gap-2">
          <input type="radio" checked={act === 'extendDate'} onChange={() => setAct('extendDate')} className="mt-1" />
          <span className="flex-1">
            Postavi novi „Datum do"
            <Input type="date" value={extendTo} onChange={(e) => setExtendTo(e.target.value)} className="mt-1" />
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" checked={act === 'extendMonths'} onChange={() => setAct('extendMonths')} className="mt-1" />
          <span className="flex-1">
            Produži za N meseci od „Datum do" (ili od danas)
            <Input type="number" min={1} max={60} value={months} onChange={(e) => setMonths(Number(e.target.value))} className="mt-1 max-w-[120px]" />
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={act === 'deactivate'} onChange={() => setAct('deactivate')} />
          Deaktiviraj selektovane (isActive = false)
        </label>
      </div>
    </Dialog>
  );
}

/* ── Podešavanja isteka ugovora (contract_lead_days) ─────────────────────── */

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const cfgQ = useNotificationConfig(true);
  const update = useUpdateNotificationConfig();
  const [days, setDays] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const v = cfgQ.data?.data?.contractLeadDays;
    if (v != null) setDays(String(v));
  }, [cfgQ.data]);

  async function save() {
    setBusy(true);
    try {
      await update.mutateAsync({ contractLeadDays: Number(days) || 0 });
      setSaved(true);
      pushToast('✅ Podešavanje sačuvano');
      setTimeout(onClose, 600);
    } catch (e) {
      pushToast('⚠ ' + errMsg(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="⚙ Isticanje ugovora — obaveštenja"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={save} loading={busy} disabled={cfgQ.isLoading || saved}>Sačuvaj</Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Dani unapred (lead days)" hint="Broj dana pre isteka ugovora kada kreće mejl obaveštenje (cron na sy15).">
          <Input type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </FormField>
        <p className="text-xs text-ink-secondary">
          Obaveštenja o isteku ugovora šalju se automatski (nezavisno od ovog ekrana). Ovde podešavaš samo koliko dana ranije.
        </p>
      </div>
    </Dialog>
  );
}
