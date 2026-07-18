'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate } from '@/lib/format';
import {
  generateContractPdf,
  generateEmploymentDecisionPdf,
  toCyrillic,
  openBlob,
  downloadBlob,
  type ContractInput,
} from '@/lib/hr-pdf';
import {
  fetchEmployee,
  fetchEmployeePii,
  fetchOrgStructure,
  fetchContractBruto,
  signDocument,
  useUploadDocument,
  type Contract,
  type EmployeeSafe,
  type EmployeePii,
  type JobPosition,
} from '@/api/kadrovska';
import {
  CON_TYPE_LABELS,
  CONTRACT_PDF_TYPES,
  formatRsd,
  isMinorAt,
  mesecWord,
  stepenSpremeCyr,
  todayYmd,
  trajanjeCyr,
} from './shared';
import { pushToast } from './toast';

function sv(row: Record<string, unknown> | null | undefined, key: string): string {
  const v = row?.[key];
  return v == null ? '' : String(v);
}

/* ── Rešenje o zasnivanju radnog odnosa (📄 PDF na redu) ─────────────────── */

/** Učita zaposlenog (adresa/odeljenje) i generiše + otvori/preuzmi Rešenje PDF. */
export async function openResenjePdf(contract: Contract, empName: string): Promise<void> {
  try {
    pushToast('⏳ Pripremam rešenje…');
    const { data: emp } = await fetchEmployee(contract.employeeId);
    const today = todayYmd();
    const seed = String(emp.id).slice(0, 8).toUpperCase();
    const protocol = contract.contractNumber?.trim() || `RR-${today.slice(0, 4)}-${seed}`;
    const address = [sv(emp, 'address'), sv(emp, 'city')].filter(Boolean).join(', ');
    const { blob, fileName } = await generateEmploymentDecisionPdf({
      imePrezime: empName,
      jmbg: sv(emp, 'personal_id') || undefined,
      adresa: address || undefined,
      radnoMesto: contract.position || sv(emp, 'position_name') || undefined,
      odeljenje: sv(emp, 'department_name') || sv(emp, 'department') || undefined,
      tipUgovora: CON_TYPE_LABELS[contract.contractType] || contract.contractType,
      ugovorBroj: contract.contractNumber || undefined,
      datumOd: contract.dateFrom ? formatDate(contract.dateFrom) : undefined,
      datumDo: contract.dateTo ? formatDate(contract.dateTo) : undefined,
      neodredjeno: contract.contractType === 'neodredjeno' || !contract.dateTo,
      napomena: contract.note || undefined,
      brojResenja: protocol,
      datum: formatDate(today),
    });
    openBlob(blob);
    downloadBlob(blob, fileName);
  } catch (e) {
    console.error('[ugovori] resenje pdf', e);
    pushToast('⚠ Greška pri generisanju rešenja: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/* ── Ugovor o radu — pun automatski tok (📑 Ugovor) ─────────────────────── */

interface Prepared {
  emp: EmployeeSafe;
  pii: EmployeePii;
  position: JobPosition;
  bruto: number;
}

export function ContractGenerateDialog({
  contract,
  empName,
  onClose,
  onDone,
}: {
  contract: Contract;
  empName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const upload = useUploadDocument();
  const [loading, setLoading] = useState(true);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signDate, setSignDate] = useState(todayYmd());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ data: emp }, { data: pii }, { data: org }, bru] = await Promise.all([
          fetchEmployee(contract.employeeId),
          fetchEmployeePii(contract.employeeId),
          fetchOrgStructure(),
          fetchContractBruto(contract.employeeId).catch(() => ({ data: { employeeId: contract.employeeId, bruto: null } })),
        ]);
        if (!alive) return;
        const positionId = Number(sv(emp, 'position_id'));
        if (!positionId) {
          setError('Zaposlenom nije dodeljeno radno mesto iz sistematizacije (Zaposleni → Radno mesto).');
          setLoading(false);
          return;
        }
        const position = org.jobPositions.find((p) => p.id === positionId);
        if (!position || !position.name) {
          setError('Radno mesto nije pronađeno u sistematizaciji — ne mogu garantovati usklađenost.');
          setLoading(false);
          return;
        }
        const bruto = Number(bru.data.bruto) || 0;
        if (!(bruto > 0)) {
          setError('Nema unete BRUTO zarade za zaposlenog (uneti u Zarade). Generisanje je blokirano.');
          setLoading(false);
          return;
        }
        setPrep({ emp, pii, position, bruto });
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Greška pri pripremi ugovora');
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [contract.employeeId]);

  const refIso = contract.dateFrom || signDate;
  const maloletnik = prep ? isMinorAt(prep.pii.birth_date, refIso) : false;

  async function run() {
    if (!prep) return;
    setBusy(true);
    setError(null);
    try {
      const prebivaliste = [prep.pii.city, prep.pii.address].filter(Boolean).join(', ');
      const data: ContractInput = {
        tip: contract.contractType === 'odredjeno' ? 'odredjeno' : 'neodredjeno',
        maloletnik,
        imePrezime: toCyrillic(empName),
        jmbg: prep.pii.personal_id || '________________',
        prebivaliste: toCyrillic(prebivaliste || '________'),
        stepenSS: stepenSpremeCyr(prep.pii.education_level),
        zanimanje: toCyrillic(prep.pii.education_title || '________'),
        radnoMesto: toCyrillic(prep.position.name),
        nadredjeni: prep.position.reportsToLine ? toCyrillic(prep.position.reportsToLine) : '',
        brutoZarada: formatRsd(prep.bruto),
        datumPocetka: contract.dateFrom ? formatDate(contract.dateFrom) : '________',
        trajanje: trajanjeCyr(contract.dateFrom, contract.dateTo),
        datumPotpisa: formatDate(signDate),
        probniRad: contract.probniRad === true,
        probniMeseci: Number(contract.probniMeseci) || 6,
        potpisPoslodavac: 'Ненад Јараковић',
      };
      const { blob, fileName } = await generateContractPdf(data);
      const file = new File([blob], fileName, { type: 'application/pdf' });
      const res = (await upload.mutateAsync({
        employeeId: contract.employeeId,
        file,
        docType: 'ugovor',
        description: `Auto-generisan ugovor o radu (${CON_TYPE_LABELS[contract.contractType] || contract.contractType}${contract.contractNumber ? ', br. ' + contract.contractNumber : ''})`,
        queueEmail: true,
        emailLabel: 'Ugovor o radu',
      })) as { data: { id: string } };
      pushToast('✅ Ugovor generisan i sačuvan u dokumenta zaposlenog');
      try {
        const signed = await signDocument(res.data.id);
        if (signed.data) window.open(signed.data, '_blank', 'noopener');
      } catch {
        /* preview greška — dokument je već sačuvan */
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Greška pri generisanju ugovora');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="📑 Generisanje ugovora o radu"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={run} loading={busy} disabled={loading || !prep}>
            Generiši i sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {loading && <p className="py-6 text-center text-ink-secondary">Pripremam podatke…</p>}
        {error && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-status-danger">{error}</p>}
        {prep && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Info label="Zaposleni" value={empName} />
              <Info label="Radno mesto" value={prep.position.name} />
              <Info label="Tip" value={CON_TYPE_LABELS[contract.contractType] || contract.contractType} />
              <Info label="Bruto (BRUTO I)" value={formatRsd(prep.bruto)} />
              {contract.dateFrom && <Info label="Početak rada" value={formatDate(contract.dateFrom)} />}
              {contract.contractType === 'odredjeno' && contract.dateTo && (
                <Info label="Trajanje" value={trajanjeCyr(contract.dateFrom, contract.dateTo).replace(/\(.+?\)\s*/, '')} />
              )}
              {contract.probniRad && (
                <Info label="Probni rad" value={`${Number(contract.probniMeseci) || 6} ${mesecWord(Number(contract.probniMeseci) || 6)}`} />
              )}
            </div>
            {maloletnik && (
              <p className="rounded-control bg-status-warn-bg px-3 py-2 text-status-warn">
                ⚠ MALOLETNO LICE na dan početka rada — radno vreme 7 č/dan (35 č/ned).
              </p>
            )}
            <FormField label="Datum potpisa" hint="Datum koji se štampa u PDF-u (dana … godine).">
              <Input type="date" value={signDate} onChange={(e) => setSignDate(e.target.value)} />
            </FormField>
            <p className="text-xs text-ink-secondary">
              PDF se snima u dokumenta zaposlenog i šalje na njegov email. Potpisivanje je svojeručno, van sistema.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="mt-0.5 text-ink">{value || '—'}</div>
    </div>
  );
}
