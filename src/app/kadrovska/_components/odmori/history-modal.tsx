'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import {
  useVacationLedger,
  useHolidays,
  useEmployeePii,
  useUploadDocument,
  newClientEventId,
  type GoLedgerBlock,
  type GoLedgerPeriod,
  type GoLedgerEntry,
} from '@/api/kadrovska';
import {
  generateVacationRecordPdf,
  generateVacationDecisionPdf,
  openBlob,
  downloadBlob,
} from '@/lib/hr-pdf';
import { formatDate } from '@/lib/format';
import { entryDateRangeIso } from '@/lib/vacation-regroup';
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

function fmtPeriod(p: GoLedgerPeriod): string {
  if (!p.od) return '—';
  if (!p.do || p.od === p.do) return formatDate(p.od);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.od);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.do);
  if (a && b && a[1] === b[1] && a[2] === b[2]) return `${a[3]}–${b[3]}.${b[2]}.${b[1]}.`;
  return `${formatDate(p.od)} – ${formatDate(p.do)}`;
}

/**
 * 📜 GO istorija modal — jedinstveni presek iz go_ledger (grid + „ranije" +
 * planirano + preostalo, usklađeno sa saldom) + 🗂 PDF evidencija + ✉ Pošalji
 * zaposlenom + 📄 Rešenje po periodu/unosu. Port 1.0 vacationHistoryView.
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

  const ledgerQ = useVacationLedger({ employeeId });
  const holQ = useHolidays({ from: `${year}-01-01`, to: `${year + 1}-01-31` });
  const piiQ = useEmployeePii(employeeId, canPii);
  const upload = useUploadDocument();

  const [busy, setBusy] = useState<string | null>(null);

  const blocks: GoLedgerBlock[] = ledgerQ.data?.data ?? [];

  function buildRecordData() {
    const current = blocks.find((b) => b.godina === year) ?? null;
    return {
      employeeName,
      position,
      jmbg: sv(piiQ.data?.data, 'personal_id') || '',
      year,
      current,
      blocks,
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

  /** Rešenje o GO za tačan opseg (fromIso/toIso). Zajedničko za grid periode i istorijske unose. */
  async function emitDecision(entryYear: number, fromIso: string, toIso: string, days: number | null, busyKey: string) {
    if (!position) {
      showToast('⚠ Zaposlenom nije dodeljeno radno mesto (Zaposleni → Radno mesto).');
      return;
    }
    setBusy(busyKey);
    try {
      const holSet = holidaySetFromRows(holQ.data?.data);
      const returnIso = nextWorkingDay(toIso, holSet);
      const { blob, fileName } = await generateVacationDecisionPdf({
        brojResenja: `GO-${entryYear}-${String(fromIso).replace(/-/g, '').slice(4)}`,
        datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
        mesto: 'Dobanovci',
        godina: entryYear,
        imePrezime: employeeName,
        jmbg: sv(piiQ.data?.data, 'personal_id') || '________________',
        radnoMesto: position,
        brojDana: days ?? 0,
        datumOd: formatDate(fromIso),
        datumDo: formatDate(toIso),
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

  function onPeriodDecision(entryYear: number, p: GoLedgerPeriod) {
    emitDecision(entryYear, p.od, p.do, p.dana, `res-${p.od}`);
  }
  function onEntryDecision(entryYear: number, datesText: string, days: number | null) {
    const range = entryDateRangeIso(datesText, entryYear);
    if (!range) { showToast('⚠ Nema preciznih datuma za rešenje.'); return; }
    emitDecision(entryYear, range.fromIso, range.toIso, days ?? range.count, `res-${datesText}`);
  }

  const colSpan = canResenje ? 5 : 4;

  function periodRow(entryYear: number, p: GoLedgerPeriod, planned: boolean, idx: number) {
    const badge = planned
      ? { label: 'planirano', color: '#2563eb' }
      : { label: 'GO', color: '#3B8C4E' };
    return (
      <tr key={`p${planned ? 'p' : 'u'}${idx}`} className="border-t border-line-soft align-top">
        <td className="py-1 tnums font-semibold">{p.dana}</td>
        <td><span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ color: badge.color, borderColor: `${badge.color}55` }}>{badge.label}</span></td>
        <td className="whitespace-nowrap">{fmtPeriod(p)}</td>
        <td className="text-ink-secondary" />
        {canResenje && (
          <td className="text-right">
            <button
              type="button"
              disabled={busy === `res-${p.od}`}
              onClick={() => onPeriodDecision(entryYear, p)}
              className="rounded-control px-2 py-1 text-xs text-accent hover:bg-surface-2 disabled:opacity-50"
              title="Generiši i odštampaj Rešenje o GO za ovaj period"
            >📄 Rešenje</button>
          </td>
        )}
      </tr>
    );
  }

  function noteRow(key: string, n: number, text: string) {
    return (
      <tr key={key} className="border-t border-line-soft align-top">
        <td className="py-1 tnums font-semibold">{n}</td>
        <td><span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ color: '#8a8a8a', borderColor: '#8a8a8a55' }}>ranije</span></td>
        <td colSpan={colSpan - 2} className="text-ink-secondary">{text}</td>
      </tr>
    );
  }

  function entryRow(entryYear: number, e: GoLedgerEntry, i: number, allowResenje: boolean) {
    const k = KIND_BADGE[e.kind] || KIND_BADGE.other;
    const canRes = allowResenje && canResenje && e.kind === 'go' && e.days != null && !!entryDateRangeIso(e.dates, entryYear);
    return (
      <tr key={`e${i}`} className="border-t border-line-soft align-top">
        <td className="py-1 tnums font-semibold">{e.days != null ? `${e.approx ? '~' : ''}${e.days}` : '–'}</td>
        <td><span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ color: k.color, borderColor: `${k.color}55` }}>{k.label}</span></td>
        <td>
          {e.dates || '—'}
          {e.fromYear && (<span className="ml-1 rounded border border-line px-1 text-[0.6rem] text-ink-secondary" title={`upisano u list ${e.fromYear}. godine`}>↤ {e.fromYear}</span>)}
        </td>
        <td className="text-ink-secondary">{e.comment || ''}</td>
        {canResenje && (
          <td className="text-right">
            {canRes && (
              <button
                type="button"
                disabled={busy === `res-${e.dates}`}
                onClick={() => onEntryDecision(entryYear, e.dates, e.days)}
                className="rounded-control px-2 py-1 text-xs text-accent hover:bg-surface-2 disabled:opacity-50"
                title="Generiši i odštampaj Rešenje o GO za ove dane"
              >📄 Rešenje</button>
            )}
          </td>
        )}
      </tr>
    );
  }

  function table(rows: React.ReactNode) {
    return (
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
        <tbody>{rows}</tbody>
      </table>
    );
  }

  function renderBlock(b: GoLedgerBlock) {
    const isHistory = b.izvor === 'istorija';
    const summary = [
      b.ukupno != null ? `raspoloživo ${b.ukupno}` : null,
      `iskorišćeno ${b.iskorisceno}`,
      b.planirano > 0 ? `planirano ${b.planirano}` : null,
      b.preostalo != null ? `preostalo ${b.preostalo}` : null,
    ].filter(Boolean).join(' · ');

    let usedRows: React.ReactNode;
    if (isHistory) {
      const entries = b.istorija_unosi ?? b.stara_evidencija ?? [];
      const goSum = entries.filter((e) => e.kind === 'go' && typeof e.days === 'number').reduce((s, e) => s + (e.days as number), 0);
      const residue = (b.iskorisceno || 0) - goSum;
      usedRows = entries.length
        ? [...entries.map((e, i) => entryRow(b.godina, e, i, true)), residue > 0 ? noteRow('res', residue, 'bez preciznog datuma (iz stare evidencije)') : null]
        : <tr><td colSpan={colSpan} className="py-1 text-ink-disabled">nema pojedinačnih unosa</td></tr>;
    } else {
      const rows: React.ReactNode[] = (b.iskorisceno_periodi ?? []).map((p, i) => periodRow(b.godina, p, false, i));
      if (b.ranije_evidentirano > 0) rows.push(noteRow('earlier', b.ranije_evidentirano, 'bez preciznog datuma (ranija evidencija)'));
      usedRows = rows.length ? rows : <tr><td colSpan={colSpan} className="py-1 text-ink-disabled">nema iskorišćenih dana</td></tr>;
    }

    const plannedPeriods = b.planirano_periodi ?? [];
    const oldEntries = !isHistory ? (b.stara_evidencija ?? []) : [];

    return (
      <div key={b.godina} className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1">
          <strong className="text-sm text-ink">ODMOR {b.godina}</strong>
          <span className="text-xs text-ink-secondary">{summary}</span>
        </div>
        <div className="text-xs font-semibold text-ink-secondary">{isHistory ? 'Iskorišćeni dani (stara evidencija)' : 'Iskorišćeni dani'}</div>
        {table(usedRows)}
        {plannedPeriods.length > 0 && (
          <>
            <div className="text-xs font-semibold" style={{ color: '#2563eb' }}>Planirani (odobreni) dani</div>
            {table(plannedPeriods.map((p, i) => periodRow(b.godina, p, true, i)))}
          </>
        )}
        {oldEntries.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[0.7rem] text-ink-disabled">Stara Excel evidencija ({b.godina}) — kontekst</summary>
            {table(oldEntries.map((e, i) => entryRow(b.godina, e, i, false)))}
          </details>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`📜 Godišnji odmor — istorija — ${employeeName}`}
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
          Kompletan pregled po godinama: iskorišćeni + planirani (odobreni) + preostali dani (usklađeno sa saldom).
        </p>
        {ledgerQ.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : !blocks.length ? (
          <p className="text-sm text-ink-secondary">Nema podataka o godišnjem odmoru za ovog zaposlenog.</p>
        ) : (
          blocks.map(renderBlock)
        )}
        <p className="text-[0.7rem] leading-relaxed text-ink-disabled">
          „Iskorišćeni" i „planirano" su po datumu (grid + stara Excel evidencija, usklađeno sa saldom);
          „bez datuma" = retki dani koje saldo broji a nemamo tačan datum. Za starije godine izvor je
          ranija (Excel) evidencija. <strong>Slobodno = preostalo.</strong>
        </p>
      </div>
    </Dialog>
  );
}
