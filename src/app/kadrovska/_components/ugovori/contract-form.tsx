'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate } from '@/lib/format';
import {
  useEmployees,
  useEmployee,
  useContracts,
  useOrgStructure,
  useCreateContract,
  useUpdateContract,
  fetchContractBruto,
  newClientEventId,
  type Contract,
  type EmployeeSafe,
} from '@/api/kadrovska';
import {
  CON_TYPE_OPTS,
  CON_TYPE_LABELS,
  CONTRACT_PDF_TYPES,
  contractStatus,
  durationHint,
  formatRsd,
  ymdAddMonthsMinusDay,
} from './shared';
import { pushToast } from './toast';

function useEmployeeSearch(q: string) {
  return useEmployees({ q: q || undefined, active: true, pageSize: 25 });
}

export function ContractForm({
  contract,
  canGenerate,
  onCancel,
  onSaved,
}: {
  contract: Contract | null;
  canGenerate: boolean;
  onCancel: () => void;
  /** Vrati listu (i opciono pokreni generisanje ugovora za sačuvani red). */
  onSaved: (saved: Contract, generate: boolean) => void;
}) {
  const isEdit = !!contract;
  const orgQ = useOrgStructure();
  const create = useCreateContract();
  const update = useUpdateContract();

  // Zaposleni (edit: pretpopuni iz contract.employeeId)
  const editEmpQ = useEmployee(isEdit ? contract!.employeeId : null);
  const [selEmp, setSelEmp] = useState<EmployeeSafe | null>(null);
  useEffect(() => {
    if (isEdit && editEmpQ.data?.data && !selEmp) setSelEmp(editEmpQ.data.data);
  }, [isEdit, editEmpQ.data, selEmp]);

  const [type, setType] = useState(contract?.contractType || 'neodredjeno');
  const [position, setPosition] = useState(contract?.position || '');
  const [dateFrom, setDateFrom] = useState(contract?.dateFrom?.slice(0, 10) || '');
  const [dateTo, setDateTo] = useState(contract?.dateTo?.slice(0, 10) || '');
  const [isActive, setIsActive] = useState(contract ? contract.isActive !== false : true);
  const [note, setNote] = useState(contract?.note || '');
  const [probni, setProbni] = useState(contract?.probniRad === true);
  const [probniMeseci, setProbniMeseci] = useState(contract?.probniMeseci || 6);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const empId = selEmp?.id || null;
  const posNames = useMemo(
    () => (orgQ.data?.data.jobPositions ?? []).map((p) => p.name).filter(Boolean),
    [orgQ.data],
  );
  const probniVisible = CONTRACT_PDF_TYPES.has(type);
  const pdfSaveVisible = canGenerate && CONTRACT_PDF_TYPES.has(type);

  function setQuickTo(months: number) {
    if (!dateFrom) {
      pushToast('⚠ Prvo unesi „Datum od"');
      return;
    }
    const end = ymdAddMonthsMinusDay(dateFrom, months);
    if (end) setDateTo(end);
    if (type !== 'odredjeno') setType('odredjeno');
  }

  async function submit(generate: boolean) {
    setError(null);
    if (!empId) {
      setError('Izaberi zaposlenog.');
      return;
    }
    if (!dateFrom) {
      setError('Datum početka ugovora je obavezan.');
      return;
    }
    if (type === 'odredjeno' && !dateTo) {
      setError('Za ugovor na određeno vreme obavezan je Datum do (iskoristi dugmad 3/6/12/24 mes).');
      return;
    }
    if (dateTo && dateTo < dateFrom) {
      setError('Datum završetka ne može biti pre datuma početka.');
      return;
    }
    const probniRad = probniVisible && probni;
    const probniMes = probniRad ? Math.min(6, Math.max(1, probniMeseci)) : null;

    setBusy(true);
    try {
      let saved: Contract;
      if (isEdit) {
        const res = await update.mutateAsync({
          id: contract!.id,
          patch: {
            contractType: type,
            dateFrom,
            dateTo: dateTo || null,
            position: position || null,
            isActive,
            note: note || null,
            probniRad,
            probniMeseci: probniMes,
          } as Partial<Contract>,
        });
        saved = (res as { data: Contract }).data;
      } else {
        const res = await create.mutateAsync({
          employeeId: empId,
          clientEventId: newClientEventId(),
          contractType: type,
          dateFrom,
          ...(dateTo ? { dateTo } : {}),
          ...(position ? { position } : {}),
          isActive,
          ...(note ? { note } : {}),
          probniRad,
          ...(probniMes ? { probniMeseci: probniMes } : {}),
        });
        saved = (res as { data: Contract }).data;
      }
      pushToast(isEdit ? '✏️ Ugovor izmenjen' : '✅ Ugovor dodat');
      onSaved(saved, generate && pdfSaveVisible);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Greška pri čuvanju.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onCancel}>
          ← Nazad na ugovore
        </Button>
        <span className="ml-auto text-sm text-ink-secondary">{isEdit ? 'Izmena ugovora' : 'Novi ugovor'}</span>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <form
          className="min-w-[340px] flex-1 space-y-4"
          style={{ maxWidth: 720 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <div>
            <h2 className="text-md font-semibold text-ink">{isEdit ? '✏️ Izmeni ugovor' : '📄 Novi ugovor'}</h2>
            <p className="text-xs text-ink-secondary">
              Datum početka je obavezan. Datum završetka ostavi prazno za neodređeno trajanje.
            </p>
          </div>
          {error && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{error}</p>}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FormField label="Zaposleni" required>
                <ComboBox<EmployeeSafe>
                  value={selEmp}
                  onChange={setSelEmp}
                  useSearch={useEmployeeSearch}
                  getKey={(e) => e.id}
                  getLabel={(e) => e.full_name}
                  getSublabel={(e) => e.position || ''}
                  placeholder="Pretraga po imenu ili poziciji…"
                />
              </FormField>
            </div>
            <FormField label="Tip ugovora" required>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
              >
                {CON_TYPE_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Pozicija">
              <Input list="conPositionList" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="npr. Vođa montaže" />
              <datalist id="conPositionList">
                {posNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </FormField>
          </div>

          <fieldset className="space-y-3 rounded-panel border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink-secondary">Trajanje</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Datum od" required>
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </FormField>
              <FormField label="Datum do" hint="Opciono — prazno = neodređeno">
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </FormField>
            </div>
            {type === 'odredjeno' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-secondary">Brzo (poslednji dan):</span>
                {[3, 6, 12, 24].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setQuickTo(m)}
                    className="rounded-control border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-surface-2"
                  >
                    {m} mes
                  </button>
                ))}
              </div>
            )}
            {type === 'odredjeno' && dateFrom && dateTo && dateTo >= dateFrom && (
              <p className="text-xs text-ink-secondary">
                Ugovor će glasiti: <strong className="text-ink">{durationHint(dateFrom, dateTo)}</strong>
              </p>
            )}
            {type === 'neodredjeno' && (
              <p className="text-xs text-ink-disabled">Neodređeno trajanje — „Datum do" se ne unosi.</p>
            )}
            {probniVisible && (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={probni} onChange={(e) => setProbni(e.target.checked)} />
                  Probni rad (klauzula u ugovoru)
                </label>
                <select
                  value={probniMeseci}
                  disabled={!probni}
                  onChange={(e) => setProbniMeseci(Number(e.target.value))}
                  className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink disabled:opacity-50"
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'mesec' : n <= 4 ? 'meseca' : 'meseci'}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3 rounded-panel border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink-secondary">Status i napomena</legend>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Aktivan ugovor
            </label>
            <FormField label="Napomena">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Opcioni komentar…" />
            </FormField>
          </fieldset>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              ← Nazad
            </Button>
            <Button type="submit" loading={busy}>
              Sačuvaj
            </Button>
            {pdfSaveVisible && (
              <Button type="button" loading={busy} onClick={() => submit(true)} title="Sačuvaj i odmah generiši PDF ugovora o radu">
                Sačuvaj i generiši PDF
              </Button>
            )}
          </div>
        </form>

        {selEmp && <EmpInfoCard emp={selEmp} showSalary={canGenerate} />}
      </div>
    </div>
  );
}

function EmpInfoCard({ emp, showSalary }: { emp: EmployeeSafe; showSalary: boolean }) {
  const contractsQ = useContracts({ employeeId: emp.id }, true);
  const [bruto, setBruto] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!showSalary) return;
    let alive = true;
    fetchContractBruto(emp.id)
      .then((r) => alive && setBruto(r.data.bruto))
      .catch(() => alive && setBruto(null));
    return () => {
      alive = false;
    };
  }, [emp.id, showSalary]);

  const active = (contractsQ.data?.data ?? []).filter((c) => !c.archivedAt && c.isActive !== false);
  return (
    <aside className="w-full max-w-xs shrink-0 space-y-3 rounded-panel border border-line bg-surface p-4 text-sm">
      <div>
        <div className="font-semibold text-ink">{emp.full_name}</div>
        <div className="text-xs text-ink-secondary">{emp.position || '—'}</div>
      </div>
      <div className="space-y-1 text-xs">
        <Row label="Odeljenje" value={emp.department || '—'} />
        <Row label="Zaposlen od" value={emp.hire_date ? formatDate(emp.hire_date as string) : '—'} />
      </div>
      <div>
        <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Aktivni ugovori</div>
        {active.length === 0 ? (
          <p className="text-xs text-ink-disabled">Nema aktivnih ugovora.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {active.map((c) => {
              const st = contractStatus(c);
              return (
                <li key={c.id} className="text-ink-secondary">
                  {CON_TYPE_LABELS[c.contractType] || c.contractType}: {formatDate(c.dateFrom)} –{' '}
                  {c.dateTo ? formatDate(c.dateTo) : 'neodređeno'} · {st.label}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {showSalary && (
        <div>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Ugovorna zarada</div>
          {bruto === undefined ? (
            <p className="text-xs text-ink-disabled">Učitavam…</p>
          ) : bruto && bruto > 0 ? (
            <p className="text-xs text-ink">BRUTO I: {formatRsd(bruto)}</p>
          ) : (
            <p className="rounded-control bg-status-warn-bg px-2 py-1 text-xs text-status-warn">
              ⚠ Nema unete zarade — 📑 generisanje ugovora će biti blokirano.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-secondary">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
