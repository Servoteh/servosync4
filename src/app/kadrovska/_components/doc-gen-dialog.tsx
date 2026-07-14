'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  generateVacationDecisionPdf,
  generateEmploymentCertificatePdf,
  generateSalaryCertificatePdf,
  generateAnnexPdf,
  generateMaternityDecisionPdf,
  generateMutualTerminationPdf,
  generateContractPdf,
  downloadBlob,
  openBlob,
  type PdfResult,
} from '@/lib/hr-pdf';
import type { EmployeeSafe } from '@/api/kadrovska';

// Generator HR dokumenata (ćirilica PDF) iz dosijea zaposlenog — R3 težište.
// Vidljivi tipovi zavise od permisija: primanja/ugovor = salary(admin); sporazumni
// raskid = admin; ostali = edit. Polja se pretpopune iz v_employees_safe; JMBG je
// PII (prazan bez kadrovska.pii — korisnik ga upiše ručno). Rezultat = PDF preuzimanje.

type DocType =
  | 'employment'
  | 'salary'
  | 'annex'
  | 'maternity'
  | 'mutual'
  | 'vacation'
  | 'contract';

const DOC_LABELS: Record<DocType, string> = {
  employment: 'Potvrda o zaposlenju',
  salary: 'Potvrda o visini primanja',
  annex: 'Aneks ugovora',
  maternity: 'Rešenje o porodiljskom odsustvu',
  mutual: 'Sporazumni raskid ugovora',
  vacation: 'Rešenje o godišnjem odmoru',
  contract: 'Ugovor o radu',
};

function today(): string {
  return formatDate(new Date().toISOString().slice(0, 10));
}

export function DocGenDialog({ employee, onClose }: { employee: EmployeeSafe; onClose: () => void }) {
  const { can } = useAuth();
  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const canAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);

  const options = useMemo(() => {
    const list: DocType[] = ['employment', 'vacation', 'annex', 'maternity'];
    if (canSalary) list.splice(1, 0, 'salary', 'contract');
    if (canAdmin) list.push('mutual');
    return list;
  }, [canSalary, canAdmin]);

  const [type, setType] = useState<DocType>(options[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Zajednička polja (pretpopunjena; korisnik dopunjuje). JMBG PII → ručno.
  const [ime, setIme] = useState(employee.full_name || '');
  const [radnoMesto, setRadnoMesto] = useState(employee.position || '');
  const [jmbg, setJmbg] = useState('');
  const [datum, setDatum] = useState(today());
  // Specifična polja
  const [brutoZarada, setBrutoZarada] = useState('');
  const [datumOd, setDatumOd] = useState('');
  const [datumDo, setDatumDo] = useState('');
  const [brojDana, setBrojDana] = useState('20');
  const [godina, setGodina] = useState(String(new Date().getFullYear()));
  const [datumPocetka, setDatumPocetka] = useState('');
  const [datumZavrsetka, setDatumZavrsetka] = useState('');
  const [datumPrestanka, setDatumPrestanka] = useState('');

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let res: PdfResult;
      switch (type) {
        case 'employment':
          res = await generateEmploymentCertificatePdf({ imePrezime: ime, radnoMesto, jmbg, datum });
          break;
        case 'salary':
          res = await generateSalaryCertificatePdf({ imePrezime: ime, radnoMesto, jmbg, brutoZarada: brutoZarada || '________', datum });
          break;
        case 'annex':
          res = await generateAnnexPdf({ imePrezime: ime, radnoMesto, jmbg, datum });
          break;
        case 'maternity':
          res = await generateMaternityDecisionPdf({ imePrezime: ime, radnoMesto, jmbg, datumPocetka: datumPocetka || '________', datumZavrsetka: datumZavrsetka || '________', datum });
          break;
        case 'mutual':
          res = await generateMutualTerminationPdf({ imePrezime: ime, radnoMesto, jmbg, datumPrestanka: datumPrestanka || '________', datum });
          break;
        case 'vacation':
          res = await generateVacationDecisionPdf({
            imePrezime: ime,
            radnoMesto,
            jmbg,
            godina: godina || new Date().getFullYear(),
            brojDana: Number(brojDana) || 0,
            datumOd: datumOd || '________',
            datumDo: datumDo || '________',
            datumDonosenja: datum,
          });
          break;
        case 'contract':
          res = await generateContractPdf({
            imePrezime: ime,
            jmbg: jmbg || '________________',
            prebivaliste: '________',
            stepenSS: '________',
            zanimanje: radnoMesto,
            radnoMesto,
            brutoZarada: brutoZarada || '________',
            datumPocetka: datumPocetka || '________',
            datumPotpisa: datum,
            tip: 'neodredjeno',
          });
          break;
      }
      openBlob(res.blob);
      downloadBlob(res.blob, res.fileName);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Greška pri generisanju dokumenta');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Generiši dokument (PDF, ćirilica)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={run} loading={busy}>
            Generiši PDF
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label="Tip dokumenta">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as DocType)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {DOC_LABELS[o]}
              </option>
            ))}
          </select>
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ime i prezime">
            <Input value={ime} onChange={(e) => setIme(e.target.value)} />
          </FormField>
          <FormField label="Radno mesto">
            <Input value={radnoMesto} onChange={(e) => setRadnoMesto(e.target.value)} />
          </FormField>
          <FormField label="JMBG (PII)" hint="Prazno ako nemate pristup PII — ostaje linija za ručno">
            <Input value={jmbg} onChange={(e) => setJmbg(e.target.value)} placeholder="________________" />
          </FormField>
          <FormField label="Datum dokumenta">
            <Input value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
        </div>

        {(type === 'salary' || type === 'contract') && (
          <FormField label="Bruto zarada (formatiran iznos)">
            <Input value={brutoZarada} onChange={(e) => setBrutoZarada(e.target.value)} placeholder="npr. 150.000,00 RSD" />
          </FormField>
        )}

        {type === 'vacation' && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Godina">
              <Input value={godina} onChange={(e) => setGodina(e.target.value)} />
            </FormField>
            <FormField label="Broj radnih dana">
              <Input value={brojDana} onChange={(e) => setBrojDana(e.target.value)} />
            </FormField>
            <FormField label="Datum od">
              <Input value={datumOd} onChange={(e) => setDatumOd(e.target.value)} placeholder="dd.mm.gggg." />
            </FormField>
            <FormField label="Datum do">
              <Input value={datumDo} onChange={(e) => setDatumDo(e.target.value)} placeholder="dd.mm.gggg." />
            </FormField>
          </div>
        )}

        {type === 'maternity' && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Datum početka">
              <Input value={datumPocetka} onChange={(e) => setDatumPocetka(e.target.value)} placeholder="dd.mm.gggg." />
            </FormField>
            <FormField label="Datum završetka">
              <Input value={datumZavrsetka} onChange={(e) => setDatumZavrsetka(e.target.value)} placeholder="dd.mm.gggg." />
            </FormField>
          </div>
        )}

        {type === 'contract' && (
          <FormField label="Datum početka rada">
            <Input value={datumPocetka} onChange={(e) => setDatumPocetka(e.target.value)} placeholder="dd.mm.gggg." />
          </FormField>
        )}

        {type === 'mutual' && (
          <FormField label="Datum prestanka radnog odnosa">
            <Input value={datumPrestanka} onChange={(e) => setDatumPrestanka(e.target.value)} placeholder="dd.mm.gggg." />
          </FormField>
        )}

        <p className="text-xs text-ink-secondary">
          Dokument je na ćirilici (latinična polja se automatski preslovljavaju). Sporazumni raskid ostaje na
          latinici (šablon). PDF se otvara i preuzima; potpis/M.P. se dodaju ručno.
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
