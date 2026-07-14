'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { ApiError } from '@/api/client';
import { useCreateSalaryTerm, useUpdateSalaryTerm, newClientEventId, type SalaryTerm } from '@/api/kadrovska';
import { DEFAULT_PARAMS } from '@/lib/salary-tax';
import {
  COMPENSATION_MODELS,
  PAYROLL_GROUPS,
  compensationModelLabel,
  computeContractSalaryFromValues,
  deriveCompensationModel,
  fmtRsd2,
  paymentWindowLabel,
} from './calc';

export interface EmployeeOption {
  id: string;
  name: string;
  position?: string;
  department?: string;
}

/** Vrednost forme — prefill iz term-a (edit ili „nova izmena" kopija bez id-a). */
interface FormState {
  employeeId: string;
  salaryType: string;
  compensationModel: string;
  amountType: string;
  amount: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
  contractRef: string;
  approvedBy: string;
  approvedAt: string;
  payrollGroup: string;
  cashAllowanceRsd: string;
  transportAllowanceRsd: string;
  perDiemRsd: string;
  perDiemEur: string;
  fixedAmount: string;
  fixedExtraHourRate: string;
  firstPartAmount: string;
  splitHourRate: string;
  fixedNoExtraHours: boolean;
  paymentWindowOverride: string;
  note: string;
}

function iso(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : '';
}
function numStr(v: unknown): string {
  return v == null || v === '' ? '' : String(v);
}

function initFrom(term: Partial<SalaryTerm> | null, presetEmployeeId?: string): FormState {
  const salaryType = (term?.salaryType as string) || 'ugovor';
  return {
    employeeId: (term?.employeeId as string) || presetEmployeeId || '',
    salaryType,
    compensationModel: (term?.compensationModel as string) || deriveCompensationModel(salaryType) || 'fiksno',
    amountType: (term?.amountType as string) || 'neto',
    amount: numStr(term?.amount),
    currency: (term?.currency as string) || 'RSD',
    effectiveFrom: iso(term?.effectiveFrom) || new Date().toISOString().slice(0, 10),
    effectiveTo: iso(term?.effectiveTo),
    contractRef: (term?.contractRef as string) || '',
    approvedBy: (term?.approvedBy as string) || '',
    approvedAt: iso(term?.approvedAt as string),
    payrollGroup: (term?.payrollGroup as string) || 'standard',
    cashAllowanceRsd: numStr(term?.cashAllowanceRsd) || '0',
    transportAllowanceRsd: numStr(term?.transportAllowanceRsd) || '0',
    perDiemRsd: numStr(term?.perDiemRsd) || '0',
    perDiemEur: numStr(term?.perDiemEur) || '0',
    fixedAmount: numStr(term?.fixedAmount) || numStr(term?.amount) || '0',
    fixedExtraHourRate: numStr(term?.fixedExtraHourRate) || '0',
    firstPartAmount: numStr(term?.firstPartAmount) || '0',
    splitHourRate: numStr(term?.splitHourRate) || '0',
    fixedNoExtraHours: !!term?.fixedNoExtraHours,
    paymentWindowOverride: (term?.paymentWindowOverride as string) || '',
    note: (term?.note as string) || '',
  };
}

export function TermModal({
  open,
  onClose,
  onSaved,
  employees,
  term,
  presetEmployeeId,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  employees: EmployeeOption[];
  term: Partial<SalaryTerm> | null;
  presetEmployeeId?: string;
}) {
  const isEdit = !!term?.id;
  const [f, setF] = useState<FormState>(() => initFrom(term, presetEmployeeId));
  const [err, setErr] = useState('');
  const create = useCreateSalaryTerm();
  const update = useUpdateSalaryTerm();
  const busy = create.isPending || update.isPending;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  // NETO ↔ BRUTO live preračun (RSD, mesečna zarada).
  const calc = useMemo(
    () => computeContractSalaryFromValues(f.salaryType, f.amountType, parseFloat(f.amount), f.currency),
    [f.salaryType, f.amountType, f.amount, f.currency],
  );

  const model = f.compensationModel;
  const fixedLike = model === 'fiksno' || model === 'jednokratno';
  const showFirst = model === 'dva_dela' || model === 'satnica';
  const showSplit = model === 'dva_dela';

  // Odluka #7 (1.0): „Prvi deo" auto = ugovoreni NETO dok ga korisnik ne prepiše
  // ručno (override ostaje moguć). Fallback na snapshot netoRsd sa reda.
  const firstTouched = useRef(false);
  useEffect(() => {
    if (!showFirst || firstTouched.current) return;
    if (parseFloat(f.firstPartAmount) > 0) return;
    const autoNeto = calc?.netoRsd ?? (Number(term?.netoRsd) > 0 ? Number(term?.netoRsd) : null);
    if (autoNeto && autoNeto > 0) {
      setF((p) => ({ ...p, firstPartAmount: String(Math.round(autoNeto * 100) / 100) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFirst, calc]);

  function onTypeChange(t: string) {
    setF((p) => ({ ...p, salaryType: t, compensationModel: deriveCompensationModel(t) || 'fiksno' }));
  }

  async function submit() {
    setErr('');
    const amount = parseFloat(f.amount);
    if (!f.employeeId) { setErr('Izaberi zaposlenog.'); return; }
    if (!f.effectiveFrom) { setErr('Datum „Važi od" je obavezan.'); return; }
    if (f.effectiveTo && f.effectiveTo < f.effectiveFrom) { setErr('„Važi do" ne može biti pre „Važi od".'); return; }
    if (!(amount >= 0)) { setErr('Iznos mora biti broj ≥ 0.'); return; }
    const transport = parseFloat(f.transportAllowanceRsd) || 0;
    const perDiemRsd = parseFloat(f.perDiemRsd) || 0;
    const perDiemEur = parseFloat(f.perDiemEur) || 0;
    if (transport < 0 || perDiemRsd < 0 || perDiemEur < 0) { setErr('Prevoz i dnevnice ne mogu biti negativni.'); return; }

    // Datum odobrenja bez unetog datuma = „važi od" (najčešći slučaj).
    const approvedAt = f.approvedAt || (f.approvedBy ? f.effectiveFrom : '');
    const fixedAmount = parseFloat(f.fixedAmount) || amount;
    const fixedExtraHourRate = parseFloat(f.fixedExtraHourRate) || 0;
    const firstPartAmount = parseFloat(f.firstPartAmount) || 0;
    const splitHourRate = parseFloat(f.splitHourRate) || 0;

    // amounts: whitelist BE salaryAmounts (kadrovska-mutations.service.ts). NETO/BRUTO
    // se izvode iz Iznos + Neto/Bruto (jedan izvor istine). K3.3 ključevi idu SAMO
    // za aktivan model (1.0 buildTermPayload gating) — edit 'dva_dela' ne sme da
    // upiše fixed_amount i obrnuto; izostavljen ključ = BE ga preskače.
    const amounts: Record<string, unknown> = {
      amount,
      amountType: f.amountType,
      currency: f.currency,
      hourlyRate: f.salaryType === 'satnica' ? amount : null,
      netoRsd: calc ? calc.netoRsd : null,
      brutoRsd: calc ? calc.brutoRsd : null,
      transportAllowanceRsd: transport,
      perDiemRsd,
      perDiemEur,
      terrainDomesticRate: perDiemRsd,
      terrainForeignRate: perDiemEur,
      fixedNoExtraHours: f.fixedNoExtraHours,
      paymentWindowOverride: f.paymentWindowOverride || null,
      payrollGroup: f.payrollGroup,
      cashAllowanceRsd: parseFloat(f.cashAllowanceRsd) || 0,
      // approvedBy/approvedAt/contractRef — TODO(P1a): BE amounts whitelist ih još ne
      // prima (biće tiho odbačeni dok se ne dopune DTO/salaryAmounts).
      approvedBy: f.approvedBy || null,
      approvedAt: approvedAt || null,
      contractRef: f.contractRef || null,
    };
    if (fixedLike) {
      // `|| amount` fallback je 1.0-kanonski SAMO u fiksno/jednokratno grani (salary.js:93).
      amounts.fixedAmount = fixedAmount;
      amounts.fixedTransportComponent = transport;
      amounts.fixedExtraHourRate = fixedExtraHourRate;
    } else if (model === 'dva_dela') {
      amounts.firstPartAmount = firstPartAmount;
      amounts.splitHourRate = splitHourRate;
      amounts.splitTransportAmount = transport;
    } else if (model === 'satnica' || model === 'praksa') {
      amounts.hourlyTransportAmount = transport;
      // SATNICA: prvi deo (01–05) = ugovoreni NETO uz mogući ručni override.
      if (model === 'satnica') amounts.firstPartAmount = firstPartAmount;
    }

    try {
      if (isEdit && term?.id) {
        await update.mutateAsync({
          id: term.id,
          patch: {
            salaryType: f.salaryType,
            effectiveFrom: f.effectiveFrom,
            // null = OBRIŠI „Važi do" (red ponovo aktivan); BE ugovor: null=clear,
            // undefined=ne diraj (1.0 buildTermPayload semantika).
            effectiveTo: f.effectiveTo || null,
            compensationModel: model,
            amounts,
            note: f.note,
          },
        });
      } else {
        await create.mutateAsync({
          clientEventId: newClientEventId(),
          employeeId: f.employeeId,
          salaryType: f.salaryType,
          effectiveFrom: f.effectiveFrom,
          ...(f.effectiveTo ? { effectiveTo: f.effectiveTo } : {}),
          compensationModel: model,
          amounts,
          note: f.note,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri čuvanju.');
    }
  }

  const empName = employees.find((e) => e.id === f.employeeId)?.name;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="2xl"
      title={isEdit ? 'Izmeni unos zarade' : 'Novi unos zarade'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Otkaži</Button>
          <Button onClick={submit} loading={busy}>Sačuvaj</Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-xs text-ink-secondary">
          Istorijski zapis. Novi „važi od" datum automatski zatvara prethodni aktivan red.
        </p>
        {err && <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger" role="alert">{err}</div>}

        {/* Osnovni ugovorni uslovi */}
        <fieldset className="space-y-3">
          <legend className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Osnovni ugovorni uslovi</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="lg:col-span-3">
              <FormField label="Zaposleni" required>
                {isEdit ? (
                  <Input value={empName || f.employeeId} disabled />
                ) : (
                  <select
                    value={f.employeeId}
                    onChange={(e) => set('employeeId', e.target.value)}
                    className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
                  >
                    <option value="">— izaberi —</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
            <FormField label="Tip" required>
              <select value={f.salaryType} onChange={(e) => onTypeChange(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                <option value="ugovor">Ugovor (mesečno)</option>
                <option value="dogovor">Dogovor (mesečno)</option>
                <option value="satnica">Satnica</option>
              </select>
            </FormField>
            <FormField label="Model zarade (K3.3)">
              <select value={model} onChange={(e) => set('compensationModel', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                {COMPENSATION_MODELS.map((m) => (
                  <option key={m} value={m}>{compensationModelLabel(m)}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Neto / Bruto" required>
              <select value={f.amountType} onChange={(e) => set('amountType', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                <option value="neto">Neto</option>
                <option value="bruto">Bruto</option>
              </select>
            </FormField>
            <FormField label="Iznos / satnica" required>
              <Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => set('amount', e.target.value)} />
            </FormField>
            <FormField label="Valuta">
              <select value={f.currency} onChange={(e) => set('currency', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                <option value="RSD">RSD</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </FormField>
            <FormField label="Važi od" required>
              <Input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
            </FormField>
            <FormField label="Važi do (opc.)">
              <Input type="date" value={f.effectiveTo} onChange={(e) => set('effectiveTo', e.target.value)} />
            </FormField>
            <FormField label="Broj / referenca ugovora">
              <Input maxLength={120} value={f.contractRef} onChange={(e) => set('contractRef', e.target.value)} />
            </FormField>
            <FormField label="Odobrio">
              <Input maxLength={120} placeholder="ime osobe koja je odobrila" value={f.approvedBy} onChange={(e) => set('approvedBy', e.target.value)} />
            </FormField>
            <FormField label="Odobreno datuma" hint={'prazno = „važi od"'}>
              <Input type="date" value={f.approvedAt} onChange={(e) => set('approvedAt', e.target.value)} />
            </FormField>
            <FormField label="Grupa za knjigovođu">
              <select value={f.payrollGroup} onChange={(e) => set('payrollGroup', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                {PAYROLL_GROUPS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Naknada u kešu (RSD/mes)" hint="interno">
              <Input type="number" min={0} step="0.01" value={f.cashAllowanceRsd} onChange={(e) => set('cashAllowanceRsd', e.target.value)} />
            </FormField>
          </div>
        </fieldset>

        {/* NETO ↔ BRUTO kalkulator */}
        <fieldset className="space-y-2 rounded-panel border border-line bg-surface-2 p-3">
          <legend className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">
            Preračun NETO ↔ BRUTO (zvanični obračun {DEFAULT_PARAMS.year})
          </legend>
          <p className="text-xs text-ink-secondary">
            Automatski iz „Iznos" i izbora Neto/Bruto (porez 10%, doprinosi zaposlenog 19,90%,
            neoporezivi {DEFAULT_PARAMS.nonTaxable.toLocaleString('sr-RS')} RSD). <strong>U ugovor o radu ide BRUTO I.</strong>
          </p>
          <TaxInfo />
        </fieldset>

        {/* Mesečni dodaci */}
        <fieldset className="space-y-3">
          <legend className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Mesečni dodaci (obračun zarade)</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Prevoz (RSD mesečno)" hint="0 = organizovan prevoz">
              <Input type="number" min={0} step="0.01" value={f.transportAllowanceRsd} onChange={(e) => set('transportAllowanceRsd', e.target.value)} />
            </FormField>
            <FormField label="Dinarska dnevnica (RSD / teren)">
              <Input type="number" min={0} step="0.01" value={f.perDiemRsd} onChange={(e) => set('perDiemRsd', e.target.value)} />
            </FormField>
            <FormField label="Devizna dnevnica (EUR / teren ino)">
              <Input type="number" min={0} step="0.01" value={f.perDiemEur} onChange={(e) => set('perDiemEur', e.target.value)} />
            </FormField>
          </div>
        </fieldset>

        {/* K3.3 parametri obračuna */}
        <fieldset className="space-y-3">
          <legend className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">K3.3 parametri obračuna</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fixedLike && (
              <>
                <FormField label="Fiksna plata (RSD)">
                  <Input type="number" min={0} step="0.01" value={f.fixedAmount} onChange={(e) => set('fixedAmount', e.target.value)} />
                </FormField>
                <FormField label="Dodatak po satu (prekov./praznik/2 maš.)">
                  <Input type="number" min={0} step="0.01" value={f.fixedExtraHourRate} onChange={(e) => set('fixedExtraHourRate', e.target.value)} />
                </FormField>
              </>
            )}
            {showFirst && (
              <FormField label="Prvi deo (RSD)" hint="auto = ugovoreni NETO">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={f.firstPartAmount}
                  onChange={(e) => { firstTouched.current = true; set('firstPartAmount', e.target.value); }}
                />
              </FormField>
            )}
            {showSplit && (
              <FormField label="Satnica II dela">
                <Input type="number" min={0} step="0.01" value={f.splitHourRate} onChange={(e) => set('splitHourRate', e.target.value)} />
              </FormField>
            )}
            <FormField label="Prozor isplate" hint={`Isplata: ${paymentWindowLabel(model, f.paymentWindowOverride || null) || '—'}${f.paymentWindowOverride ? ' (ručni izuzetak)' : ' (automatski po modelu)'}`}>
              <select value={f.paymentWindowOverride} onChange={(e) => set('paymentWindowOverride', e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                <option value="">Automatski (po modelu)</option>
                <option value="01_05">Izuzetak: 01–05. u mesecu</option>
                <option value="15_20">Izuzetak: 15–20. u mesecu</option>
              </select>
            </FormField>
          </div>
          {fixedLike && (
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" checked={f.fixedNoExtraHours} onChange={(e) => set('fixedNoExtraHours', e.target.checked)} className="mt-1" />
              <span>Bez prekovremenih i subota (ugovoreno fiksno) — dodatni sati se evidentiraju, ali se NE plaćaju</span>
            </label>
          )}
        </fieldset>

        {/* Napomena */}
        <FormField label="Napomena">
          <Textarea maxLength={1000} rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );

  function TaxInfo() {
    if (!calc) {
      if (f.salaryType === 'satnica') return <p className="text-xs text-ink-secondary">Preračun se odnosi na mesečnu zaradu (Ugovor/Dogovor), ne na satnicu.</p>;
      if (f.currency !== 'RSD') return <p className="text-xs text-ink-secondary">Poreski preračun je samo za RSD.</p>;
      return <p className="text-xs text-ink-secondary">Unesi „Iznos" iznad — prikazaću NETO, BRUTO I i BRUTO II.</p>;
    }
    const r = calc.breakdown;
    return (
      <div className="space-y-0.5 text-sm text-ink tnums">
        <div>
          <strong>NETO:</strong> {fmtRsd2(r.neto)} · <strong>BRUTO I (ide u ugovor):</strong> {fmtRsd2(r.bruto)}
        </div>
        <div className="text-ink-secondary">
          Porez (10%): {fmtRsd2(r.tax)} · Doprinosi zaposlenog (19,90%): {fmtRsd2(r.empContrib)}
          {r.base !== r.bruto && <span className="text-status-warn"> (osnovica doprinosa ograničena na {fmtRsd2(r.base)})</span>}
        </div>
        <div className="text-ink-secondary">BRUTO II (trošak poslodavca, interno): <strong>{fmtRsd2(r.bruto2)}</strong></div>
      </div>
    );
  }
}
