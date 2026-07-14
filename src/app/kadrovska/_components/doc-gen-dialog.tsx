'use client';

import { useEffect, useMemo, useState } from 'react';
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
  downloadBlob,
  openBlob,
  type PdfResult,
} from '@/lib/hr-pdf';
import {
  useEmployeePii,
  useOrgStructure,
  useUploadDocument,
  fetchContractBruto,
  signDocument,
  type EmployeeSafe,
  type JobPosition,
} from '@/api/kadrovska';
import { docBroj, formatRsd, mesecLat, opisStavke, todayYmd } from './ugovori/shared';
import { pushToast } from './ugovori/toast';

// Generator HR dokumenata (ćirilica PDF) iz dosijea zaposlenog — PUN AUTO-TOK
// (paritet 1.0 generateHrDocFromKarton): auto-prefill iz PII kartona + org-strukture,
// generiši PDF, AUTO-SNIMI u employee_documents (multipart POST) + AUTO-MEJL
// (queueEmail) + otvori signed URL za pregled. Vidljiv samo PII držaocu.

type DocType = 'employment' | 'salary' | 'annex' | 'maternity' | 'mutual' | 'vacation';

const DOC_LABELS: Record<DocType, string> = {
  employment: 'Potvrda o zaposlenju',
  salary: 'Potvrda o visini primanja',
  annex: 'Aneks ugovora',
  maternity: 'Rešenje o porodiljskom odsustvu',
  mutual: 'Sporazumni raskid ugovora',
  vacation: 'Rešenje o godišnjem odmoru',
};
/** Auto-save docType (mora biti u employee_documents doc_type CHECK — vidi 1.0). */
const DOC_KIND: Partial<Record<DocType, string>> = {
  employment: 'potvrda_zaposlenje',
  salary: 'potvrda_primanja',
  annex: 'aneks',
  maternity: 'resenje_porodiljsko',
  mutual: 'sporazumni_raskid',
};

function sv(row: Record<string, unknown> | null | undefined, key: string): string {
  const v = row?.[key];
  return v == null ? '' : String(v);
}
function fmt(iso: string): string {
  return iso ? formatDate(iso) : '';
}
/** start + N godina (UTC) → ISO. */
function addYears(startIso: string, years: number): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

export function DocGenDialog({ employee, onClose }: { employee: EmployeeSafe; onClose: () => void }) {
  const { can } = useAuth();
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const canAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);

  const piiQ = useEmployeePii(employee.id, canPii);
  const orgQ = useOrgStructure();
  const upload = useUploadDocument();

  const positionId = Number(sv(employee, 'position_id')) || 0;
  const position: JobPosition | undefined = useMemo(
    () => orgQ.data?.data.jobPositions.find((p) => p.id === positionId),
    [orgQ.data, positionId],
  );
  const pii = piiQ.data?.data;

  const options = useMemo(() => {
    const list: DocType[] = ['employment', 'salary', 'annex', 'maternity', 'vacation'];
    if (canAdmin) list.push('mutual');
    return list;
  }, [canAdmin]);

  const [type, setType] = useState<DocType>(options[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill (auto iz kartona/sistematizacije; editabilno)
  const ime = employee.full_name || '';
  const radnoMesto = position?.name || employee.position || '';
  const jmbg = pii?.personal_id || '';
  const datum = todayYmd();
  const year = Number(datum.slice(0, 4));

  // Salary bruto (auto — blokira potvrdu bez zarade)
  const [bruto, setBruto] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (type !== 'salary') return;
    let alive = true;
    setBruto(undefined);
    fetchContractBruto(employee.id)
      .then((r) => alive && setBruto(r.data.bruto))
      .catch(() => alive && setBruto(null));
    return () => {
      alive = false;
    };
  }, [type, employee.id]);

  // Specifična polja
  const [datumPocetka, setDatumPocetka] = useState('');
  const [matYears, setMatYears] = useState(1);
  const [datumPrestanka, setDatumPrestanka] = useState('');
  const [godina, setGodina] = useState(String(year));
  const [brojDana, setBrojDana] = useState('20');
  const [vacOd, setVacOd] = useState('');
  const [vacDo, setVacDo] = useState('');

  const needsPosition = type === 'employment' || type === 'annex' || type === 'maternity' || type === 'mutual';
  const positionMissing = needsPosition && !radnoMesto;

  async function saveAndPreview(res: PdfResult, docType: string, description: string, emailLabel: string, email: boolean) {
    const file = new File([res.blob], res.fileName, { type: 'application/pdf' });
    const up = (await upload.mutateAsync({
      employeeId: employee.id, file, docType, description,
      queueEmail: email, emailLabel,
    })) as { data: { id: string } };
    pushToast(email ? '✅ Sačuvano u dokumenta + poslato na email' : '✅ Sačuvano u dokumenta zaposlenog');
    try {
      const s = await signDocument(up.data.id);
      if (s.data) window.open(s.data, '_blank', 'noopener');
    } catch {
      /* preview greška — dokument je sačuvan */
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (positionMissing) throw new Error('Zaposlenom nije dodeljeno radno mesto iz sistematizacije.');

      if (type === 'vacation') {
        // GO rešenje: manual unos (nema odobrenog zahteva u dosijeu) — samo download.
        const res = await generateVacationDecisionPdf({
          imePrezime: ime, radnoMesto, jmbg: jmbg || undefined,
          godina: godina || year, brojDana: Number(brojDana) || 0,
          datumOd: fmt(vacOd) || '________', datumDo: fmt(vacDo) || '________', datumDonosenja: fmt(datum),
        });
        openBlob(res.blob);
        downloadBlob(res.blob, res.fileName);
        onClose();
        return;
      }

      let res: PdfResult;
      let description = '';
      let emailLabel = DOC_LABELS[type];
      const docType = DOC_KIND[type]!;
      let email = true;

      if (type === 'employment') {
        res = await generateEmploymentCertificatePdf({
          imePrezime: ime, jmbg: jmbg || undefined, radnoMesto,
          datumZaposlenja: sv(employee, 'hire_date') ? fmt(sv(employee, 'hire_date')) : undefined,
          broj: docBroj('POT', year, employee.id), datum: fmt(datum),
        });
        description = 'Potvrda o zaposlenju';
      } else if (type === 'salary') {
        if (!(Number(bruto) > 0)) throw new Error('Nema važeće BRUTO zarade — potvrda o primanjima je blokirana.');
        res = await generateSalaryCertificatePdf({
          imePrezime: ime, jmbg: jmbg || undefined, radnoMesto,
          brutoZarada: formatRsd(Number(bruto)), broj: docBroj('POT', year, employee.id), datum: fmt(datum),
        });
        description = `Potvrda o visini primanja (bruto ${formatRsd(Number(bruto))})`;
      } else if (type === 'annex') {
        res = await generateAnnexPdf({
          imePrezime: ime, jmbg: jmbg || undefined, radnoMesto,
          reportsToLine: position?.reportsToLine || undefined,
          opisStavke: opisStavke(position?.responsibilitiesMd),
          broj: docBroj('ANX', year, employee.id), datum: fmt(datum),
        });
        description = `Aneks ugovora — radno mesto: ${radnoMesto}`;
      } else if (type === 'maternity') {
        if (!datumPocetka) throw new Error('Unesite datum početka porodiljskog.');
        const end = addYears(datumPocetka, matYears);
        res = await generateMaternityDecisionPdf({
          imePrezime: ime, jmbg: jmbg || undefined, radnoMesto,
          datumPocetka: fmt(datumPocetka), datumZavrsetka: fmt(end),
          trajanjeDana: matYears === 2 ? 730 : 365,
          broj: docBroj('POR', Number(datumPocetka.slice(0, 4)), employee.id), datum: fmt(datum),
        });
        description = `Rešenje o porodiljskom (${fmt(datumPocetka)} – ${fmt(end)})`;
      } else {
        // mutual — sporazumni raskid (admin), bez mejla (latinica šablon)
        if (!datumPrestanka) throw new Error('Unesite datum prestanka radnog odnosa.');
        res = await generateMutualTerminationPdf({
          imePrezime: ime, jmbg: jmbg || undefined, radnoMesto,
          datumUgovora: sv(employee, 'hire_date') ? fmt(sv(employee, 'hire_date')) : undefined,
          datumPrestanka: fmt(datumPrestanka), mesecZarade: mesecLat(datumPrestanka),
          broj: docBroj('SPR', Number(datumPrestanka.slice(0, 4)), employee.id), datum: fmt(datum),
        });
        description = `Sporazumni raskid ugovora o radu (prestanak ${fmt(datumPrestanka)})`;
        email = false;
      }

      await saveAndPreview(res, docType, description, emailLabel, email);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Greška pri generisanju dokumenta');
      setBusy(false);
    }
  }

  const loading = piiQ.isLoading || orgQ.isLoading;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Generiši dokument (PDF, ćirilica)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={run} loading={busy} disabled={loading || positionMissing}>
            {type === 'vacation' ? 'Generiši PDF' : 'Generiši, sačuvaj i pošalji'}
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

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Ro label="Zaposleni" value={ime} />
          <Ro label="Radno mesto" value={radnoMesto || '—'} />
          <Ro label="JMBG" value={jmbg || (canPii ? '(nije unet)' : '🔒')} />
          <Ro label="Datum dokumenta" value={fmt(datum)} />
        </div>

        {positionMissing && (
          <p className="rounded-control bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
            ⚠ Zaposlenom nije dodeljeno radno mesto iz sistematizacije — ovaj dokument se ne može generisati.
          </p>
        )}

        {type === 'salary' && (
          <p className="rounded-control border border-line px-3 py-2 text-sm">
            {bruto === undefined ? 'Učitavam BRUTO zaradu…' : Number(bruto) > 0 ? (
              <>Auto BRUTO: <strong>{formatRsd(Number(bruto))}</strong></>
            ) : (
              <span className="text-status-warn">⚠ Nema važeće BRUTO zarade — generisanje je blokirano.</span>
            )}
          </p>
        )}

        {type === 'annex' && (
          <p className="text-xs text-ink-secondary">
            Aneks auto uzima radno mesto, nadređenog{position?.reportsToLine ? ` (${position.reportsToLine})` : ''} i
            opis poslova ({opisStavke(position?.responsibilitiesMd).length} stavki) iz sistematizacije.
          </p>
        )}

        {type === 'maternity' && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Datum početka" required>
              <Input type="date" value={datumPocetka} onChange={(e) => setDatumPocetka(e.target.value)} />
            </FormField>
            <FormField label="Trajanje">
              <select
                value={matYears}
                onChange={(e) => setMatYears(Number(e.target.value))}
                className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
              >
                <option value={1}>1. i 2. dete — 1 godina (365 dana)</option>
                <option value={2}>3. i naredno — 2 godine (730 dana)</option>
              </select>
            </FormField>
          </div>
        )}

        {type === 'mutual' && (
          <FormField label="Datum prestanka radnog odnosa" required>
            <Input type="date" value={datumPrestanka} onChange={(e) => setDatumPrestanka(e.target.value)} />
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
              <Input type="date" value={vacOd} onChange={(e) => setVacOd(e.target.value)} />
            </FormField>
            <FormField label="Datum do">
              <Input type="date" value={vacDo} onChange={(e) => setVacDo(e.target.value)} />
            </FormField>
          </div>
        )}

        <p className="text-xs text-ink-secondary">
          {type === 'vacation'
            ? 'Rešenje o GO se generiše i preuzima (za odobreni zahtev koristi tok u Odmorima).'
            : type === 'mutual'
              ? 'Latinica (šablon). Snima se u dokumenta zaposlenog; mejl se NE šalje (interni dokument).'
              : 'Ćirilica. PDF se snima u dokumenta zaposlenog, šalje na njegov email i otvara za štampu.'}
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function Ro({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="mt-0.5 text-ink">{value}</div>
    </div>
  );
}
