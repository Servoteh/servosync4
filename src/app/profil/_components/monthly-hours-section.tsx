'use client';

// Mesečni sati (karnet self-service) — P1. Paritet 1.0 kartice iz
// `src/ui/mojProfil/index.js` (~856-1144) + `src/services/gridRemarks.js`.
// BE (`GET /v1/profile/hours`) radi ceo agregat (dnevni redovi + karnet totali +
// prikazni chips + moja primedba); FE renderuje i gradi karnet PDF iz gotovih totala.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, FileText, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useProfileHours,
  useSaveHoursRemark,
  useDeleteHoursRemark,
  type ProfileHoursDay,
} from '@/api/moj-profil';
import {
  generateKarnetPdf,
  downloadBlob,
  openBlob,
  type KarnetEmployee,
  type KarnetRow,
  type KarnetTotals,
} from '@/lib/hr-pdf';
import { Section } from './section';

/** Redovni-red šifra odsustva → labela (paritet 1.0 GRID_CODE_LABEL). */
const GRID_CODE_LABEL: Record<string, string> = {
  go: 'Godišnji',
  bo: 'Bolovanje',
  sp: 'Službeni put',
  np: 'Neopravdano',
  sl: 'Slobodan dan',
  sv: 'Krsna slava',
  pl: 'Plaćeno',
  pr: 'Praznik',
  nop: 'Neplaćeno',
};

/** Latinični nazivi meseca (za label navigacije). */
const MONTH_NAMES = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
];
/** Ćirilični nazivi meseca (za karnet naslov). */
const MONTH_NAMES_CYR = [
  'јануар', 'фебруар', 'март', 'април', 'мај', 'јун',
  'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар',
];
/** Ćir. slova dana Sun..Sat (getDay index) — fallback ako BE ne pošalje `letter`. */
const DAY_LETTERS_CYR = ['Н', 'П', 'У', 'С', 'Ч', 'П', 'С'];

function fmtNum(n: number | null | undefined): string {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return v ? String(v) : '0';
}
function dowOf(ymd: string | null | undefined): number {
  if (!ymd) return 0;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function isWeekendYmd(ymd: string): boolean {
  const dow = dowOf(ymd);
  return dow === 0 || dow === 6;
}
function currentYm(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}
function ymStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function MonthlyHoursSection({ employeeName, employeePosition }: { employeeName: string; employeePosition?: string }) {
  const init = currentYm();
  const [year, setYear] = useState(init.year);
  const [month, setMonth] = useState(init.month);

  const monthKey = ymStr(year, month);
  const q = useProfileHours(monthKey);
  const data = q.data?.data ?? null;

  const days = data?.days ?? [];
  const chips = data?.chips ?? null;
  const totals = data?.totals ?? null;
  const remark = data?.remark ?? null;
  const holidaySet = useMemo(() => new Set(data?.holidays ?? []), [data]);
  // Paritet 1.0 (index.js:912 — tabela kad ima ijedan grid-red): prikaži mesec i kad
  // postoje SAMO prekovremeni/terenski/2-mašine sati (bez redovnih i bez odsustva).
  const hasHours = days.some(
    (d) =>
      Number(d.hours) > 0 ||
      Number(d.overtimeHours) > 0 ||
      Number(d.fieldHours) > 0 ||
      Number(d.twoMachineHours) > 0 ||
      d.absenceCode,
  );

  const saveM = useSaveHoursRemark();
  const deleteM = useDeleteHoursRemark();

  // Kontrolisano polje primedbe — sinhronizuj tekst kad se učita nov mesec/remark.
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote(remark?.text ?? '');
  }, [remark, monthKey]);

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setYear(y);
    setMonth(m);
  }

  async function saveRemark() {
    const text = note.trim();
    if (!text) {
      // Prazan tekst + postojeća primedba = brisanje (paritet 1.0).
      if (remark) return deleteRemark();
      toast('Unesite tekst primedbe.');
      return;
    }
    try {
      await saveM.mutateAsync({ clientEventId: newClientEventId(), year, month, text });
      toast('Primedba sačuvana — HR će je videti.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Greška pri čuvanju primedbe.');
    }
  }

  async function deleteRemark() {
    try {
      await deleteM.mutateAsync({ year, month });
      setNote('');
      toast('Primedba obrisana.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Greška pri brisanju primedbe.');
    }
  }

  async function downloadKarnet() {
    if (!hasHours || !totals) {
      toast('Nema unetih sati za ovaj mesec.');
      return;
    }
    try {
      const monthLabel = `${MONTH_NAMES_CYR[month - 1]} ${year}.`;
      const rows = new Map<string, KarnetRow>();
      let fieldHours = 0;
      const pdfDays = days.map((d) => {
        rows.set(d.ymd, {
          hours: d.hours,
          overtimeHours: d.overtimeHours,
          fieldHours: d.fieldHours,
          twoMachineHours: d.twoMachineHours,
          absenceCode: d.absenceCode,
          absenceSubtype: d.absenceSubtype,
        });
        fieldHours += Number(d.fieldHours || 0);
        return { ymd: d.ymd, day: d.day, letter: d.letter || DAY_LETTERS_CYR[dowOf(d.ymd)] };
      });
      const employee: KarnetEmployee = {
        name: employeeName,
        position: employeePosition,
        rows,
        totals: totals as KarnetTotals,
        fieldHours,
      };
      const { blob, fileName } = await generateKarnetPdf({
        title: `КАРНЕТ — ${monthLabel}`,
        monthLabel,
        days: pdfDays,
        holidayYmdSet: holidaySet,
        employees: [employee],
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
      toast('Karnet preuzet');
    } catch (e) {
      console.error('[profil] karnet', e);
      toast('Greška pri generisanju karneta');
    }
  }

  const busy = saveM.isPending || deleteM.isPending;

  return (
    <Section
      icon={<CalendarDays className="h-4 w-4 text-ink-secondary" />}
      title="Mesečni sati"
      defaultOpen
      actions={
        <Button
          variant="secondary"
          className="h-8"
          onClick={downloadKarnet}
          disabled={!hasHours}
          title={hasHours ? 'Preuzmi svoj karnet (mesečni radni list) za ovaj mesec' : 'Nema unetih sati'}
        >
          <FileText className="h-4 w-4" aria-hidden /> Karnet
        </Button>
      }
    >
      {/* Navigacija po mesecima */}
      <div className="mb-3 flex items-center justify-center gap-3">
        <button onClick={() => shiftMonth(-1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2" title="Prethodni mesec" aria-label="Prethodni mesec">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="min-w-40 text-center text-sm font-medium text-ink">{MONTH_NAMES[month - 1]} {year}</span>
        <button onClick={() => shiftMonth(1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2" title="Sledeći mesec" aria-label="Sledeći mesec">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {q.isLoading ? (
        <p className="py-4 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : q.isError ? (
        <p className="py-4 text-center text-sm text-status-danger">Greška pri učitavanju sati.</p>
      ) : !data ? (
        <p className="py-4 text-center text-sm text-ink-disabled">Vaš zaposlenički profil nije pronađen — obratite se HR-u.</p>
      ) : (
        <>
          {/* Chips zbirovi */}
          {chips && (
            <div className="mb-3 flex flex-wrap gap-2">
              <Chip label="Radnih sati" value={fmtNum(chips.radnihSati)} />
              <Chip label="Σ prisustva" value={`${fmtNum(chips.prisustvoSati)}h`} />
              {chips.godisnjiDani > 0 && <Chip label="Godišnji" value={`${chips.godisnjiDani} dana`} />}
              {chips.spDani > 0 && <Chip label="Službeni put" value={String(chips.spDani)} />}
              {chips.bolovanjeDani > 0 && <Chip label="Bolovanje" value={`${chips.bolovanjeDani} dana`} />}
              {chips.slobodniDani > 0 && <Chip label="Slob./slava/plać." value={String(chips.slobodniDani)} />}
              {chips.prekovremeniH > 0 && <Chip label="Prekovremeni" value={`${fmtNum(chips.prekovremeniH)}h`} />}
              {chips.terenH > 0 && <Chip label="Teren" value={`${fmtNum(chips.terenH)}h`} />}
            </div>
          )}

          {/* Dnevna tabela */}
          {hasHours ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                    <th className="py-1.5">Dan</th>
                    <th className="py-1.5">Redovni / odsustvo</th>
                    <th className="py-1.5">Prekov.</th>
                    <th className="py-1.5">Teren</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <DayRow key={d.ymd} d={d} month={month} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-3 text-sm text-ink-disabled">Nema unetih sati za {MONTH_NAMES[month - 1]} {year}.</p>
          )}

          {/* Primedba na sate */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">Primedba na sate ({MONTH_NAMES[month - 1]})</h3>
              {remark && (
                <StatusBadge
                  tone={remark.status === 'resolved' ? 'success' : 'danger'}
                  label={remark.status === 'resolved' ? `Rešeno${remark.resolvedBy ? ` · ${remark.resolvedBy}` : ''}` : 'Poslato HR-u'}
                />
              )}
            </div>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Ako nešto u satima nije tačno za ovaj mesec, napiši ovde — HR će videti."
            />
            <div className="mt-2 flex gap-2">
              <Button onClick={saveRemark} loading={busy}>Sačuvaj primedbu</Button>
              {remark && (
                <Button variant="secondary" onClick={deleteRemark} loading={busy}>Obriši</Button>
              )}
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs text-ink">
      {label}: <b className="tnums">{value}</b>
    </span>
  );
}

function DayRow({ d, month }: { d: ProfileHoursDay; month: number }) {
  const weekend = isWeekendYmd(d.ymd);
  const code = d.absenceCode;
  const hours = Number(d.hours || 0);
  const ot = Number(d.overtimeHours || 0);
  const fh = Number(d.fieldHours || 0);
  let cell: ReactNode;
  if (code) cell = <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-secondary">{GRID_CODE_LABEL[code] || code}</span>;
  else if (hours > 0) cell = fmtNum(hours);
  else cell = <span className="text-ink-disabled">—</span>;
  return (
    <tr className={`border-b border-line-soft ${weekend ? 'bg-surface-2/50' : ''}`}>
      <td className="py-1.5 tnums">
        {String(d.day).padStart(2, '0')}.{String(month).padStart(2, '0')}{' '}
        <span className="text-ink-secondary">{d.letter}</span>
      </td>
      <td className="py-1.5">{cell}</td>
      <td className="py-1.5 tnums">{ot > 0 ? fmtNum(ot) : '—'}</td>
      <td className="py-1.5 tnums">{fh > 0 ? fmtNum(fh) : '—'}</td>
    </tr>
  );
}
