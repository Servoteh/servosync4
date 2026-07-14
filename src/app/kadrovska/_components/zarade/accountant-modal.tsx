'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { downloadBlob } from '@/lib/hr-pdf';
import { buildPayrollGroupPdfs, splitName, type GroupJoined, type PayrollGroupPdf } from '@/lib/hr-pdf/payroll-groups';
import { MONTHS_SR_LAT, s, type ViewRow } from './calc';

const ACCOUNTANT_EMAIL = 'holpen@gmail.com';

export function AccountantModal({
  open,
  onClose,
  employees,
  current,
}: {
  open: boolean;
  onClose: () => void;
  /** v_employees_safe redovi (snake_case). */
  employees: ViewRow[];
  /** v_employee_current_salary redovi (snake_case). */
  current: ViewRow[];
  nameOf?: (id: string) => string;
}) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const selectCls = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink';

  async function buildPdfs(): Promise<PayrollGroupPdf[]> {
    const bySal = new Map(current.map((c) => [s(c, 'employee_id'), c]));
    const joined: GroupJoined[] = employees
      .filter((e) => e.is_active !== false && bySal.has(s(e, 'id')))
      .map((e) => {
        const { firstName, lastName } = splitName(s(e, 'full_name'));
        return { firstName, lastName, sal: bySal.get(s(e, 'id'))! };
      });
    return buildPayrollGroupPdfs({ month, year, joined });
  }

  async function onDownload() {
    setBusy(true);
    try {
      setStatus('⏳ Generisanje PDF tabela…');
      const pdfs = await buildPdfs();
      if (!pdfs.length) {
        setStatus('⚠ Nema podataka — nijedna tabela nema redove.');
        return;
      }
      for (let i = 0; i < pdfs.length; i++) {
        setStatus(`⬇ Preuzimanje ${i + 1}/${pdfs.length}: ${pdfs[i].title}…`);
        downloadBlob(pdfs[i].blob, pdfs[i].filename);
        // Kratka pauza — browseri gutaju višestruke download-e u istom tick-u.
        await new Promise((r) => setTimeout(r, 400));
      }
      setStatus(`✅ Preuzeto ${pdfs.length} PDF-ova: ${pdfs.map((p) => `${p.title} (${p.count})`).join(' · ')}`);
    } catch (e) {
      console.error('[zarade/knjigovodja]', e);
      setStatus('⚠ Greška pri generisanju tabela.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="📤 Tabele za knjigovođu"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          <Button variant="secondary" onClick={onDownload} loading={busy}>⬇ Preuzmi PDF-ove</Button>
          {/* TODO(P1a): slanje mejlom knjigovođi — upload+queue postoji na BE, ali NEMA
              endpoint za retarget primaoca/subject/tela queued outbox reda (1.0
              retargetQueuedNotif). Dugme se aktivira kad P1a doda
              notifications/:id/retarget ili namenski send-to-accountant. */}
          <Button disabled title="Čeka P1a: BE endpoint za preusmeravanje outbox reda na knjigovođu">
            ✉ Pošalji na {ACCOUNTANT_EMAIL}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          Mesečne PDF tabele zarada po grupama (bez olakšica / olakšice / razvoj / stranci / HAP Fluid / prevoz).
          Grupa „Keš" se ne šalje. Slanje ide na <strong>{ACCOUNTANT_EMAIL}</strong> — po jedan mejl po tabeli (PDF prilog).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5 text-base font-medium text-ink">
            Mesec
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={selectCls}>
              {MONTHS_SR_LAT.map((nm, i) => (
                <option key={nm} value={i + 1}>{nm}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-base font-medium text-ink">
            Godina
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="min-h-5 text-sm text-ink-secondary" aria-live="polite">{status}</div>
      </div>
    </Dialog>
  );
}
