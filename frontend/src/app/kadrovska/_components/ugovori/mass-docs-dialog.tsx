'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  generateAnnexPdf,
  generateEmploymentCertificatePdf,
  generateSalaryCertificatePdf,
  downloadBlob,
} from '@/lib/hr-pdf';
import {
  useEmployees,
  useOrgStructure,
  useUploadDocument,
  fetchContractBruto,
  type EmployeeSafe,
  type JobPosition,
} from '@/api/kadrovska';
import { docBroj, formatRsd, opisStavke, todayYmd } from './shared';
import { pushToast } from './toast';

function sv(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return v == null ? '' : String(v);
}

interface BuildCtx {
  year: number;
  datum: string;
}
interface BuiltDoc {
  blob: Blob;
  fileName: string;
  docType: string;
  description: string;
  emailLabel: string;
}
interface MassType {
  key: string;
  label: string;
  adminOnly?: boolean;
  build: (emp: EmployeeSafe, pos: JobPosition, ctx: BuildCtx) => Promise<BuiltDoc | null>;
}

const MASS_TYPES: MassType[] = [
  {
    key: 'aneks',
    label: 'Aneks ugovora (radno mesto + opis poslova)',
    async build(emp, pos, ctx) {
      const { blob, fileName } = await generateAnnexPdf({
        imePrezime: sv(emp, 'full_name'),
        jmbg: sv(emp, 'personal_id') || undefined,
        radnoMesto: pos.name,
        reportsToLine: pos.reportsToLine || undefined,
        opisStavke: opisStavke(pos.responsibilitiesMd),
        broj: docBroj('ANX', ctx.year, emp.id),
        datum: ctx.datum,
      });
      return { blob, fileName, docType: 'aneks', description: `Aneks ugovora — radno mesto: ${pos.name}`, emailLabel: 'Aneks ugovora' };
    },
  },
  {
    key: 'potvrda_zaposlenje',
    label: 'Potvrda o zaposlenju',
    async build(emp, pos, ctx) {
      const { blob, fileName } = await generateEmploymentCertificatePdf({
        imePrezime: sv(emp, 'full_name'),
        jmbg: sv(emp, 'personal_id') || undefined,
        radnoMesto: pos.name,
        datumZaposlenja: sv(emp, 'hire_date') ? formatDate(sv(emp, 'hire_date')) : undefined,
        broj: docBroj('POT', ctx.year, emp.id),
        datum: ctx.datum,
      });
      return { blob, fileName, docType: 'potvrda_zaposlenje', description: 'Potvrda o zaposlenju', emailLabel: 'Potvrda o zaposlenju' };
    },
  },
  {
    key: 'potvrda_primanja',
    label: 'Potvrda o visini primanja (vuče BRUTO)',
    adminOnly: true,
    async build(emp, pos, ctx) {
      const bru = await fetchContractBruto(emp.id).catch(() => ({ data: { employeeId: emp.id, bruto: null } }));
      const bruto = Number(bru.data.bruto) || 0;
      if (!(bruto > 0)) return null; // nema važeću bruto → preskoči
      const { blob, fileName } = await generateSalaryCertificatePdf({
        imePrezime: sv(emp, 'full_name'),
        jmbg: sv(emp, 'personal_id') || undefined,
        radnoMesto: pos.name,
        brutoZarada: formatRsd(bruto),
        broj: docBroj('POT', ctx.year, emp.id),
        datum: ctx.datum,
      });
      return {
        blob, fileName, docType: 'potvrda_primanja',
        description: `Potvrda o visini primanja (bruto ${formatRsd(bruto)})`, emailLabel: 'Potvrda o visini primanja',
      };
    },
  },
];

export function MassDocsDialog({
  selectedEmployeeIds,
  canSalary,
  onClose,
}: {
  selectedEmployeeIds: string[];
  canSalary: boolean;
  onClose: () => void;
}) {
  const empQ = useEmployees({ active: true, pageSize: 200 });
  const orgQ = useOrgStructure();
  const upload = useUploadDocument();

  const types = useMemo(() => MASS_TYPES.filter((t) => !t.adminOnly || canSalary), [canSalary]);
  const [typeKey, setTypeKey] = useState(types[0]?.key ?? 'aneks');
  const [scope, setScope] = useState<'active' | 'selected'>(selectedEmployeeIds.length ? 'selected' : 'active');
  const [doSave, setDoSave] = useState(true);
  const [doZip, setDoZip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const allEmps = empQ.data?.data ?? [];
  const posMap = useMemo(() => {
    const m = new Map<number, JobPosition>();
    for (const p of orgQ.data?.data.jobPositions ?? []) m.set(p.id, p);
    return m;
  }, [orgQ.data]);

  const scopeEmps = useMemo(() => {
    if (scope === 'selected') {
      const set = new Set(selectedEmployeeIds);
      return allEmps.filter((e) => set.has(e.id));
    }
    return allEmps;
  }, [scope, allEmps, selectedEmployeeIds]);
  const withPos = scopeEmps.filter((e) => Number(sv(e, 'position_id')) > 0);

  async function run() {
    setError(null);
    const def = types.find((t) => t.key === typeKey);
    if (!def) return;
    if (!doSave && !doZip) {
      setError('Izaberi bar jedan izlaz (snimanje ili ZIP).');
      return;
    }
    if (!withPos.length) {
      setError('Nema zaposlenih sa dodeljenim radnim mestom u izabranom obuhvatu.');
      return;
    }
    setBusy(true);
    const today = todayYmd();
    const ctx: BuildCtx = { year: Number(today.slice(0, 4)), datum: formatDate(today) };
    let generated = 0, saved = 0, mailed = 0, skipped = scopeEmps.length - withPos.length, failed = 0;
    const zipFiles: { name: string; blob: Blob }[] = [];

    for (let i = 0; i < withPos.length; i++) {
      const emp = withPos[i];
      setProgress(`⏳ ${i + 1}/${withPos.length} — ${sv(emp, 'full_name') || '—'}`);
      const pos = posMap.get(Number(sv(emp, 'position_id')));
      if (!pos || !pos.name) { skipped++; continue; }
      try {
        const out = await def.build(emp, pos, ctx);
        if (!out) { skipped++; continue; }
        generated++;
        if (doZip) zipFiles.push({ name: out.fileName, blob: out.blob });
        if (doSave) {
          const file = new File([out.blob], out.fileName, { type: 'application/pdf' });
          try {
            await upload.mutateAsync({
              employeeId: emp.id, file, docType: out.docType, description: out.description,
              queueEmail: true, emailLabel: out.emailLabel,
            });
            saved++;
            mailed++; // BE queue-uje mejl uz upload (no_email → tiho preskoči)
          } catch {
            failed++;
          }
        }
      } catch (e) {
        console.error('[mass docs]', emp.id, e);
        failed++;
      }
    }

    let zipped = 0;
    if (doZip && zipFiles.length) {
      setProgress('📦 Pakujem ZIP…');
      try {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const f of zipFiles) zip.file(f.name, f.blob);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(zipBlob, `${typeKey}_${today.replace(/-/g, '')}.zip`);
        zipped = zipFiles.length;
      } catch (e) {
        console.error('[mass docs] zip', e);
        pushToast('⚠ ZIP pakovanje nije uspelo: ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    const parts = [`${generated} generisano`];
    if (doSave) parts.push(`💾 ${saved} snimljeno`, `📧 ${mailed} na email`);
    if (doZip) parts.push(`📦 ${zipped} u ZIP`);
    if (skipped) parts.push(`${skipped} preskočeno`);
    if (failed) parts.push(`${failed} neuspešno`);
    pushToast(`✅ ${def.label.split(' (')[0]}: ${parts.join(', ')}`);
    onClose();
  }

  const activeWithPos = allEmps.filter((e) => Number(sv(e, 'position_id')) > 0).length;
  const selWithPos = selectedEmployeeIds.length
    ? allEmps.filter((e) => selectedEmployeeIds.includes(e.id) && Number(sv(e, 'position_id')) > 0).length
    : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title="📦 Masovno generisanje dokumenata"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={run} loading={busy} disabled={empQ.isLoading || orgQ.isLoading}>Generiši</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {error && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-status-danger">{error}</p>}

        <fieldset className="space-y-1 rounded-panel border border-line p-3">
          <legend className="px-1 text-xs font-medium text-ink-secondary">1. Tip dokumenta</legend>
          {types.map((t) => (
            <label key={t.key} className="flex items-center gap-2">
              <input type="radio" name="massType" checked={typeKey === t.key} onChange={() => setTypeKey(t.key)} />
              {t.label}
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1 rounded-panel border border-line p-3">
          <legend className="px-1 text-xs font-medium text-ink-secondary">2. Obuhvat</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="massScope" checked={scope === 'active'} onChange={() => setScope('active')} />
            Svi aktivni sa radnim mestom <span className="text-ink-disabled">({activeWithPos})</span>
          </label>
          <label className={`flex items-center gap-2 ${selectedEmployeeIds.length ? '' : 'opacity-50'}`}>
            <input
              type="radio"
              name="massScope"
              checked={scope === 'selected'}
              disabled={!selectedEmployeeIds.length}
              onChange={() => setScope('selected')}
            />
            Zaposleni iz selektovanih ugovora{' '}
            <span className="text-ink-disabled">
              {selectedEmployeeIds.length ? `(${selWithPos} sa radnim mestom od ${selectedEmployeeIds.length})` : '(nema selekcije)'}
            </span>
          </label>
        </fieldset>

        <fieldset className="space-y-1 rounded-panel border border-line p-3">
          <legend className="px-1 text-xs font-medium text-ink-secondary">3. Izlaz</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={doSave} onChange={(e) => setDoSave(e.target.checked)} />
            Snimi u dokumenta zaposlenih (+ auto mejl)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={doZip} onChange={(e) => setDoZip(e.target.checked)} />
            Preuzmi ZIP (svi PDF-ovi u jednom fajlu)
          </label>
        </fieldset>

        {progress && <p className="text-xs text-ink-secondary">{progress}</p>}
      </div>
    </Dialog>
  );
}
