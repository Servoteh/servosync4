'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import {
  useVacationHistory,
  useVacationBalance,
  useWorkHours,
  useHolidays,
  useEmployeePiiCard,
  useUploadDocument,
  newClientEventId,
  type VacationHistory,
} from '@/api/kadrovska';
import {
  generateVacationRecordPdf,
  generateVacationDecisionPdf,
  openBlob,
  downloadBlob,
} from '@/lib/hr-pdf';
import { formatDate } from '@/lib/format';
import {
  regroupHistoryByCalendarYear,
  entryDateRangeIso,
  type HistoryRow,
  type HistoryEntry,
  type RegroupedYear,
} from '@/lib/vacation-regroup';
import { sv } from '../common';
import { useOdmoriUi } from './ui';
import { holidaySetFromRows, nextWorkingDay } from './helpers';

const KIND_BADGE: Record<string, { label: string; color: string }> = {
  go: { label: 'GO', color: '#3B8C4E' },
  slava: { label: 'slava', color: '#2563eb' },
  bolovanje: { label: 'bolovanje', color: '#C6534F' },
  praznik: { label: 'praznik', color: '#8a8a8a' },
  other: { label: '—', color: '#8a8a8a' },
};

/**
 * 📜 GO istorija modal (regroup po kalendarskoj godini) + 🗂 PDF evidencija +
 * ✉ Pošalji zaposlenom + 📄 Rešenje po istorijskom unosu. Port 1.0
 * vacationHistoryView + vacationRecordDoc + vacationDecisionDoc.
 */
export function HistoryModal({
  employeeId,
  employeeName,
  position,
  canMail,
  canResenje,
  canPii,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  position: string;
  canMail: boolean;
  canResenje: boolean;
  canPii: boolean;
  onClose: () => void;
}) {
  const { showToast, confirm } = useOdmoriUi();
  const year = new Date().getFullYear();

  const histQ = useVacationHistory({ employeeId });
  const balQ = useVacationBalance({ employeeId, year });
  const whQ = useWorkHours({ employeeId, from: `${year}-01-01`, to: `${year}-12-31` });
  const holQ = useHolidays({ from: `${year}-01-01`, to: `${year + 1}-01-31` });
  const piiQ = useEmployeePiiCard(employeeId, canPii);
  const upload = useUploadDocument();

  const [busy, setBusy] = useState<string | null>(null);

  // BE (Prisma) daje entitledDays/usedDays/remainingDays + entries JSON → map na regroup ulaz.
  const rawRows: HistoryRow[] = (histQ.data?.data ?? []).map((h: VacationHistory) => ({
    year: h.year,
    entitled: h.entitledDays,
    used: h.usedDays,
    remaining: h.remainingDays,
    entries: (Array.isArray(h.entries) ? h.entries : []) as HistoryEntry[],
    sourceFile: h.sourceFile,
  }));
  const cal: RegroupedYear[] = regroupHistoryByCalendarYear(rawRows);

  function buildRecordData() {
    const bal = balQ.data?.data?.[0];
    let saldo = null;
    if (bal) {
      const earned = bal.days_earned == null ? Number(bal.days_total ?? 0) : Number(bal.days_earned);
      const carried = Number(bal.days_carried_over ?? 0);
      saldo = {
        ukupno: earned + carried,
        iskorisceno: Number(bal.days_used ?? 0),
        preostalo: Number(bal.days_remaining_accrued ?? bal.days_remaining ?? 0),
        preneto: carried,
        zaradjeno: earned,
      };
    }
    const gridDays = (whQ.data?.data ?? [])
      .filter((r) => r.absenceCode === 'go')
      .map((r) => String(r.workDate).slice(0, 10))
      .filter(Boolean);
    return {
      employeeName,
      position,
      jmbg: sv(piiQ.data?.data, 'personal_id') || '',
      year,
      saldo,
      history: cal,
      gridDays,
      generatedDate: formatDate(new Date().toISOString().slice(0, 10)),
    };
  }

  async function onPdf() {
    setBusy('pdf');
    try {
      const { blob, fileName } = await generateVacationRecordPdf(buildRecordData());
      openBlob(blob);
      downloadBlob(blob, fileName);
    } catch (e) {
      showToast('⚠ PDF nije uspeo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(null);
    }
  }

  async function onMail() {
    const ok = await confirm({
      title: 'Slanje evidencije',
      body: `Poslati evidenciju godišnjeg odmora na mejl zaposlenom (${employeeName})?`,
      confirmLabel: 'Pošalji',
    });
    if (!ok) return;
    setBusy('mail');
    try {
      const { blob, fileName } = await generateVacationRecordPdf(buildRecordData());
      const file = new File([blob], fileName, { type: 'application/pdf' });
      await upload.mutateAsync({
        employeeId,
        file,
        docType: 'evidencija_go',
        description: `Evidencija GO (${year})`,
        queueEmail: true,
        emailLabel: 'Evidencija godišnjeg odmora',
        clientEventId: newClientEventId(),
      });
      showToast('✉ Evidencija sačuvana i poslata (ako zaposleni ima mejl)');
    } catch (e) {
      showToast('⚠ Slanje nije uspelo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(null);
    }
  }

  async function onRangeDecision(entryYear: number, datesText: string, days: number | null) {
    if (!position) {
      showToast('⚠ Zaposlenom nije dodeljeno radno mesto (Zaposleni → Radno mesto).');
      return;
    }
    const range = entryDateRangeIso(datesText, entryYear);
    if (!range) { showToast('⚠ Nema preciznih datuma za rešenje.'); return; }
    setBusy(`res-${datesText}`);
    try {
      const holSet = holidaySetFromRows(holQ.data?.data);
      const returnIso = nextWorkingDay(range.toIso, holSet);
      const { blob, fileName } = await generateVacationDecisionPdf({
        brojResenja: `GO-${entryYear}-${String(range.fromIso).replace(/-/g, '').slice(4)}`,
        datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
        mesto: 'Dobanovci',
        godina: entryYear,
        imePrezime: employeeName,
        jmbg: sv(piiQ.data?.data, 'personal_id') || '________________',
        radnoMesto: position,
        brojDana: days ?? range.count,
        datumOd: formatDate(range.fromIso),
        datumDo: formatDate(range.toIso),
        datumPovratka: returnIso ? formatDate(returnIso) : '________',
        saldo: null,
        potpisPoslodavac: 'Nenad Jaraković',
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
      showToast('✅ Rešenje napravljeno — otvoreno za štampu.');
    } catch (e) {
      showToast('⚠ Greška: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`📜 GO istorija — ${employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onPdf} loading={busy === 'pdf'}>🗂 PDF evidencija</Button>
          {canMail && <Button variant="secondary" onClick={onMail} loading={busy === 'mail'}>✉ Pošalji zaposlenom</Button>}
          <Button onClick={onClose}>Zatvori</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Ručna evidencija iz starih Excel fajlova — ne utiče na trenutni saldo.
        </p>
        {histQ.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : !cal.length ? (
          <p className="text-sm text-ink-secondary">Nema istorijskih GO podataka za ovog zaposlenog.</p>
        ) : (
          cal.map((r) => (
            <div key={r.year} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1">
                <strong className="text-sm text-ink">ODMOR {r.year}</strong>
                <span className="text-xs text-ink-secondary">
                  {[
                    r.entitled != null ? `pravo ${r.entitled}` : null,
                    r.used != null ? `iskorišćeno ${r.used}` : null,
                    r.remaining != null ? `preostalo ${r.remaining}` : null,
                  ].filter(Boolean).join(' · ') || 'bez sažetka'}
                </span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-secondary">
                    <th className="w-12 py-1">Dana</th>
                    <th className="w-20">Tip</th>
                    <th>Datumi</th>
                    <th>Napomena</th>
                    {canResenje && <th className="w-24" />}
                  </tr>
                </thead>
                <tbody>
                  {r.entries.length === 0 ? (
                    <tr><td colSpan={canResenje ? 5 : 4} className="py-1 text-ink-disabled">nema pojedinačnih unosa</td></tr>
                  ) : r.entries.map((e, i) => {
                    const k = KIND_BADGE[e.kind] || KIND_BADGE.other;
                    const canRes = e.kind === 'go' && e.days != null && !!entryDateRangeIso(e.dates, r.year);
                    return (
                      <tr key={i} className="border-t border-line-soft align-top">
                        <td className="py-1 tnums font-semibold">{e.days != null ? `${e.approx ? '~' : ''}${e.days}` : '–'}</td>
                        <td>
                          <span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ color: k.color, borderColor: `${k.color}55` }}>{k.label}</span>
                        </td>
                        <td>
                          {e.dates || '—'}
                          {e.fromYear && (
                            <span className="ml-1 rounded border border-line px-1 text-[0.6rem] text-ink-secondary" title={`upisano u list ${e.fromYear}. godine`}>↤ {e.fromYear}</span>
                          )}
                        </td>
                        <td className="text-ink-secondary">{e.comment || ''}</td>
                        {canResenje && (
                          <td className="text-right">
                            {canRes && (
                              <button
                                type="button"
                                disabled={busy === `res-${e.dates}`}
                                onClick={() => onRangeDecision(r.year, e.dates, e.days)}
                                className="rounded-control px-2 py-1 text-xs text-accent hover:bg-surface-2 disabled:opacity-50"
                                title="Generiši i odštampaj Rešenje o GO za ove dane"
                              >
                                📄 Rešenje
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))
        )}
        <p className="text-[0.7rem] leading-relaxed text-ink-disabled">
          Dani su grupisani po <strong>kalendarskoj godini korišćenja</strong> (iz starih Excel listova);
          godišnje pravo je iz originalne evidencije. „↤ NNNN" = dan je upisan u list te godine; „~" = približno.
          Ručna evidencija — <strong>ne utiče na saldo</strong>.
        </p>
      </div>
    </Dialog>
  );
}
