'use client';

// Moj tim (P5) — menadžerska drill-down sekcija. Paritet 1.0 `src/ui/mojProfil/index.js`
// (~2018-2154 „Moj tim" kartica + drill). Vidljiva samo upravljačima sa opsegom: BE
// (`GET /v1/profile/team` iza `profile.team`) vraća prazan `members` / 403 → kartica se ne
// prikazuje. Drill po članu: GO linija, trenutno+sledeće odsustvo, tabela zaduženja alata
// (`useTeamTools`), karnet člana (`useTeamHours` → `generateKarnetPdf`), korekcija kucanja
// (`useTeamCorrection`, allowDayPick min danas-3), PDF opisa pozicije (`generateJobPositionPdf`).

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useTeam,
  useTeamTools,
  useTeamCorrection,
  teamHoursQuery,
  type TeamMember,
  type TeamAbsence,
  type TeamToolRow,
  type ProfileHours,
} from '@/api/moj-profil';
import { fetchOrgStructure } from '@/api/kadrovska';
import {
  generateKarnetPdf,
  generateJobPositionPdf,
  downloadBlob,
  openBlob,
  type KarnetEmployee,
  type KarnetRow,
  type KarnetTotals,
} from '@/lib/hr-pdf';
import { Section } from './section';

// ── labele / helperi ──────────────────────────────────────────────

/** Tip odsustva → srpska labela (paritet 1.0 ABS_TYPE_LABELS). */
const ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  slava: 'Krsna slava',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  slobodan: 'Slobodan dan',
  ostalo: 'Ostalo',
};
function absLabel(type: string): string {
  return ABS_TYPE_LABELS[type] || type;
}

const MONTH_NAMES = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
];
const MONTH_NAMES_CYR = [
  'јануар', 'фебруар', 'март', 'април', 'мај', 'јун',
  'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар',
];
const DAY_LETTERS_CYR = ['Н', 'П', 'У', 'С', 'Ч', 'П', 'С'];

function dowOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** Broj dana do početka nadolazećeg odsustva (tolerantno na `days`/`daysToStart`). */
function daysToStart(a: TeamAbsence | null | undefined): number | null {
  if (!a) return null;
  const d = a.days ?? a.daysToStart;
  if (d != null) return Number(d);
  if (!a.date_from) return null;
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((new Date(a.date_from + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000);
}
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
/** min za date-picker korekcije: danas − 3 dana (paritet 1.0 allowDayPick prozor). */
function minCorrectionDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return d.toISOString().slice(0, 10);
}

// ── sekcija ───────────────────────────────────────────────────────

export function TeamSection() {
  const q = useTeam();
  const members = q.data?.data?.members ?? [];

  // Kartica se NE prikazuje ako je tim prazan (ili 403 / nema opsega).
  if (q.isLoading || q.isError || members.length === 0) return null;

  return <TeamCard members={members} />;
}

function TeamCard({ members }: { members: TeamMember[] }) {
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [corrMember, setCorrMember] = useState<TeamMember | null>(null);

  // Mesec za „Karnet tima" (default tekući). Karnet svih članova = jedan član / strana.
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const qc = useQueryClient();
  const [karnetBusy, setKarnetBusy] = useState(false);

  const q = (filter || '').trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? members.filter((m) => (m.fullName || '').toLowerCase().includes(q)) : members),
    [members, q],
  );
  const onLeaveCount = members.filter((m) => m.currentAbsence).length;

  async function downloadTeamKarnet() {
    setKarnetBusy(true);
    try {
      toast(`⏳ Pripremam karnete tima (${MONTH_NAMES[month - 1]} ${year})…`);
      // Učitaj karnet po članu (keširano — deli sa drill hookom).
      const results = await Promise.all(
        members.map((m) =>
          qc
            .fetchQuery(teamHoursQuery(m.id, monthKey))
            .then((r) => ({ member: m, hours: r?.data ?? null }))
            .catch(() => ({ member: m, hours: null as ProfileHours | null })),
        ),
      );
      const holidaySet = new Set<string>();
      let dayScaffold: { ymd: string; day: number; letter: string }[] = [];
      const employees: KarnetEmployee[] = [];
      for (const { member, hours } of results) {
        if (!hours || !hours.totals) continue;
        const days = hours.days ?? [];
        const hasHours = days.some(
          (d) =>
            Number(d.hours) > 0 || Number(d.overtimeHours) > 0 ||
            Number(d.fieldHours) > 0 || Number(d.twoMachineHours) > 0 || d.absenceCode,
        );
        if (!hasHours) continue;
        (hours.holidays ?? []).forEach((h) => holidaySet.add(h));
        if (!dayScaffold.length) {
          dayScaffold = days.map((d) => ({ ymd: d.ymd, day: d.day, letter: d.letter || DAY_LETTERS_CYR[dowOf(d.ymd)] }));
        }
        const rows = new Map<string, KarnetRow>();
        let fieldHours = 0;
        for (const d of days) {
          rows.set(d.ymd, {
            hours: d.hours,
            overtimeHours: d.overtimeHours,
            fieldHours: d.fieldHours,
            twoMachineHours: d.twoMachineHours,
            absenceCode: d.absenceCode,
            absenceSubtype: d.absenceSubtype,
          });
          fieldHours += Number(d.fieldHours || 0);
        }
        employees.push({
          name: member.fullName || '—',
          position: member.position || undefined,
          rows,
          totals: hours.totals as KarnetTotals,
          fieldHours,
        });
      }
      if (!employees.length || !dayScaffold.length) {
        toast('ℹ Nema podataka za tim u tom mesecu.');
        return;
      }
      const monthLabel = `${MONTH_NAMES_CYR[month - 1]} ${year}.`;
      const { blob, fileName } = await generateKarnetPdf({
        title: `КАРНЕТ (тим) — ${monthLabel}`,
        monthLabel,
        days: dayScaffold,
        holidayYmdSet: holidaySet,
        employees,
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
      toast(`📄 Karnet tima preuzet (${employees.length})`);
    } catch (e) {
      console.error('[profil] team karnet', e);
      toast('⚠ Greška pri generisanju karneta tima');
    } finally {
      setKarnetBusy(false);
    }
  }

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setYear(y);
    setMonth(m);
  }

  return (
    <Section
      icon="👥"
      title="Moj tim"
      defaultOpen
      badge={
        <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary">
          {onLeaveCount ? `${onLeaveCount} na odsustvu` : String(members.length)}
        </span>
      }
    >
      <p className="mb-3 text-xs text-ink-secondary">
        Zaposleni u tvom opsegu — saldo godišnjeg, odsustva i status. Klikni red za detalje.
      </p>

      {/* Filter + karnet tima */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="🔎 Pretraži po imenu i prezimenu…"
          className="max-w-64"
          autoComplete="off"
        />
        {q && <span className="text-xs text-ink-secondary">{filtered.length} rezultat(a)</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => shiftMonth(-1)} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface-2" title="Prethodni mesec">
            ◀
          </button>
          <span className="min-w-28 text-center text-xs font-medium text-ink">{MONTH_NAMES[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface-2" title="Sledeći mesec">
            ▶
          </button>
          <Button
            variant="secondary"
            className="h-8"
            onClick={downloadTeamKarnet}
            loading={karnetBusy}
            title="Preuzmi karnete celog tima za izabrani mesec (jedan član po strani)"
          >
            📄 Karnet tima
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Zaposleni</th>
              <th className="py-1.5">Pozicija</th>
              <th className="py-1.5">Pododeljenje</th>
              <th className="py-1.5 text-center">GO (ost./uk.)</th>
              <th className="py-1.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <TeamRow
                key={m.id}
                m={m}
                open={openId === m.id}
                onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                onCorrect={() => setCorrMember(m)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {corrMember && (
        <TeamCorrectionModal member={corrMember} onClose={() => setCorrMember(null)} />
      )}
    </Section>
  );
}

// ── roster red + drill ────────────────────────────────────────────

function TeamRow({
  m,
  open,
  onToggle,
  onCorrect,
}: {
  m: TeamMember;
  open: boolean;
  onToggle: () => void;
  onCorrect: () => void;
}) {
  const bal = m.balance;
  const rem = bal ? num(bal.days_remaining) : null;
  const tot = bal ? num(bal.days_earned ?? bal.days_total) + num(bal.days_carried_over) : null;
  const balTxt = bal ? `${fmtGrid(rem)} / ${fmtGrid(tot)}` : '—';
  const balLow = bal != null && rem != null && rem <= 0;
  const toolCount = num(m.issuedToolsCount);

  let status: ReactNode;
  if (m.currentAbsence) {
    status = (
      <span className="text-status-warn">
        🟠 {absLabel(m.currentAbsence.type)} do {m.currentAbsence.date_to ? formatDate(m.currentAbsence.date_to) : '—'}
      </span>
    );
  } else if (m.upcomingAbsence) {
    const d = daysToStart(m.upcomingAbsence);
    const when = d === 1 ? 'sutra' : d != null ? `za ${d} d` : '';
    status = (
      <span className="text-accent">
        🔵 {absLabel(m.upcomingAbsence.type)} {m.upcomingAbsence.date_from ? formatDate(m.upcomingAbsence.date_from) : ''}
        {when ? ` (${when})` : ''}
      </span>
    );
  } else {
    status = <span className="text-ink-secondary">na radu</span>;
  }

  return (
    <Fragment>
      <tr className="cursor-pointer border-b border-line-soft hover:bg-surface-2" onClick={onToggle}>
        <td className="py-1.5 text-ink">
          <span className="mr-1 text-ink-secondary">{open ? '▼' : '▶'}</span>
          {m.fullName || '—'}
          {toolCount > 0 && (
            <span className="ml-1.5 rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary" title="Zaduženja alata">
              🔧 {toolCount}
            </span>
          )}
        </td>
        <td className="py-1.5 text-ink-secondary">{m.position || '—'}</td>
        <td className="py-1.5 text-ink-secondary">{m.subDepartmentName || '—'}</td>
        <td className={`py-1.5 text-center tnums ${balLow ? 'font-bold text-status-danger' : 'text-ink'}`}>{balTxt}</td>
        <td className="py-1.5">{status}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="bg-surface-2 px-3 pb-3 pt-2">
            <TeamMemberDetail m={m} onCorrect={onCorrect} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function TeamMemberDetail({ m, onCorrect }: { m: TeamMember; onCorrect: () => void }) {
  const toolsQ = useTeamTools(m.id);
  const tools = toolsQ.data?.data ?? [];
  const [pdfBusy, setPdfBusy] = useState(false);

  const bal = m.balance;
  const goLine = bal
    ? `Godišnji: ukupno ${fmtGrid(num(bal.days_earned ?? bal.days_total) + num(bal.days_carried_over))}, iskorišćeno ${fmtGrid(num(bal.days_used))}, preostalo ${fmtGrid(num(bal.days_remaining))}`
    : 'Saldo godišnjeg: nema podataka';

  const absParts: string[] = [];
  if (m.currentAbsence) {
    absParts.push(
      `🟠 Trenutno: ${absLabel(m.currentAbsence.type)} — ${fmtRange(m.currentAbsence)}`,
    );
  }
  if (m.upcomingAbsence) {
    absParts.push(
      `🔵 Sledeće: ${absLabel(m.upcomingAbsence.type)} — ${fmtRange(m.upcomingAbsence)}`,
    );
  }
  if (!absParts.length) absParts.push('Nema aktuelnih/nadolazećih odsustava (≤ 14 dana).');

  async function downloadPositionPdf() {
    if (!m.positionId) {
      toast('Pozicija nije povezana sa opisom.');
      return;
    }
    setPdfBusy(true);
    try {
      // Opis pozicije živi u org-strukturi (kadrovska read). Pronađi red po positionId;
      // ako pozivalac nema pristup (403) ili pozicija nema opis → poruka (paritet 1.0 fallback).
      const org = await fetchOrgStructure();
      const pos = org.data.jobPositions.find((p) => p.id === m.positionId);
      if (!pos) {
        toast('Opis pozicije nije dostupan.');
        return;
      }
      const { blob, fileName } = await generateJobPositionPdf(pos, {
        fullName: m.fullName || undefined,
        department: m.subDepartmentName || m.department || undefined,
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
    } catch (e) {
      toast(e instanceof ApiError ? `⚠ ${e.message}` : '⚠ PDF nije uspeo');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink">{goLine}</div>
      <ul className="list-disc pl-5 text-sm text-ink-secondary">
        {absParts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">🔧 Zaduženja (alat / oprema)</h4>
        {toolsQ.isLoading ? (
          <p className="text-xs text-ink-disabled">Učitavam zaduženja…</p>
        ) : tools.length === 0 ? (
          <p className="text-xs text-ink-disabled">Nema otvorenih zaduženja alata.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                  <th className="py-1">Predmet</th>
                  <th className="py-1">Kol.</th>
                  <th className="py-1">Br. dok.</th>
                  <th className="py-1">Izdato</th>
                  <th className="py-1">Rok povr.</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t, i) => (
                  <ToolRow key={i} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" className="h-8" onClick={onCorrect}>
          ✎ Korekcija kucanja
        </Button>
        {m.positionId ? (
          <Button variant="secondary" className="h-8" onClick={downloadPositionPdf} loading={pdfBusy}>
            📄 Opis pozicije (PDF A4)
          </Button>
        ) : (
          <span className="self-center text-xs text-ink-disabled">Pozicija nije povezana sa opisom posla.</span>
        )}
      </div>
    </div>
  );
}

function ToolRow({ t }: { t: TeamToolRow }) {
  const qty = t.quantity != null ? String(t.quantity) : '—';
  const qDisplay = t.unit ? `${qty} ${t.unit}` : qty;
  const subgroup = t.subgroup_label || t.group_label;
  const desc = [t.oznaka, t.naziv].filter(Boolean).join(' — ') || '—';
  const overdue = t.expected_return_date && t.expected_return_date < todayYmd();
  return (
    <tr className="border-b border-line-soft">
      <td className="py-1 text-ink">
        {desc}
        {subgroup && <span className="text-ink-secondary"> ({subgroup})</span>}
      </td>
      <td className="py-1 tnums">{qDisplay}</td>
      <td className="py-1 tnums text-ink-secondary">{t.doc_number || '—'}</td>
      <td className="py-1 tnums">{t.issued_at ? formatDate(t.issued_at) : '—'}</td>
      <td className={`py-1 tnums ${overdue ? 'font-bold text-status-danger' : ''}`}>
        {t.expected_return_date ? formatDate(t.expected_return_date) : '—'}
      </td>
    </tr>
  );
}

// ── korekcija kucanja za člana ────────────────────────────────────

function TeamCorrectionModal({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const [day, setDay] = useState(todayYmd());
  const [timeIn, setIn] = useState('');
  const [timeOut, setOut] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const corrM = useTeamCorrection();

  async function save() {
    setErr(null);
    if (!day) return setErr('Izaberite dan.');
    if (reason.trim().length < 5) return setErr('Obrazloženje je obavezno (min 5 znakova).');
    try {
      await corrM.mutateAsync({
        employeeId: member.id,
        clientEventId: newClientEventId(),
        day,
        timeIn: timeIn || undefined,
        timeOut: timeOut || undefined,
        reason: reason.trim(),
      });
      toast('✅ Korekcija uneta.');
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Slanje nije uspelo.');
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Odustani
      </Button>
      <Button onClick={save} loading={corrM.isPending}>
        Sačuvaj korekciju
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={`✎ Korekcija kucanja — ${member.fullName || ''}`} footer={footer}>
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">Unosite korekciju u ime radnika (dodaje se samo vreme koje NIJE otkucano).</p>
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <FormField label="Dan" required>
          <Input type="date" value={day} min={minCorrectionDay()} max={todayYmd()} onChange={(e) => setDay(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ulaz (ako fali)">
            <Input type="time" value={timeIn} onChange={(e) => setIn(e.target.value)} />
          </FormField>
          <FormField label="Izlaz (ako fali)">
            <Input type="time" value={timeOut} onChange={(e) => setOut(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Obrazloženje (obavezno)" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="npr. Zaboravio da otkuca izlaz, otišao u 15:30" />
        </FormField>
      </div>
    </Dialog>
  );
}

// ── formatiranje ──────────────────────────────────────────────────

/** GO saldo (0.5 dozvoljeno) — bez suvišnih nula (paritet 1.0 _gridFmt). */
function fmtGrid(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : String(v);
}
function fmtRange(a: TeamAbsence): string {
  const from = a.date_from ? formatDate(a.date_from) : '—';
  const to = a.date_to ? formatDate(a.date_to) : '—';
  return `${from} → ${to}`;
}
