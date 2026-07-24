'use client';

// Moj tim (P5) — menadžerska drill-down sekcija. Paritet 1.0 `src/ui/mojProfil/index.js`
// (~2018-2154 „Moj tim" kartica + drill). Vidljiva samo upravljačima sa opsegom: BE
// (`GET /v1/profile/team` iza `profile.team`) vraća prazan `members` / 403 → kartica se ne
// prikazuje. Drill po članu: GO linija, trenutno+sledeće odsustvo, tabela zaduženja alata
// (`useTeamTools`), karnet člana (`useTeamHours` → `generateKarnetPdf`), korekcija kucanja
// (`useTeamCorrection`, allowDayPick min danas-3), PDF opisa pozicije (`generateJobPositionPdf`).

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Users, FileText, Wrench, Pencil, Clock, AlertTriangle, Moon, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
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
  useTeamAttendance,
  useTeamAttendanceEvents,
  teamHoursQuery,
  type TeamMember,
  type TeamAbsence,
  type TeamToolRow,
  type ProfileHours,
  type AttendanceDay,
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

function dowOf(ymd: string | null | undefined): number {
  if (!ymd) return 0;
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
/** 'HH:MM' iz time kolone ili '…THH:MM' iz timestampa (paritet self AttendanceSection). */
function hhmm(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (s.includes('T')) return s.slice(11, 16) || '—';
  return s.slice(0, 5) || '—';
}
/** Smer prolaza → srpska labela (paritet self AttendanceSection DIR_LABEL). */
const DIR_LABEL: Record<string, string> = {
  in: 'Ulaz',
  out: 'Izlaz',
  break: 'Pauza',
  official_out: 'Služb. izlaz',
  other: 'Ostalo',
  unknown: '—',
};
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
      toast(`Pripremam karnete tima (${MONTH_NAMES[month - 1]} ${year})…`);
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
        toast('Nema podataka za tim u tom mesecu.');
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
      toast(`Karnet tima preuzet (${employees.length})`);
    } catch (e) {
      console.error('[profil] team karnet', e);
      toast('Greška pri generisanju karneta tima');
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
      icon={<Users className="h-4 w-4 text-ink-secondary" />}
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
          placeholder="Pretraži po imenu i prezimenu…"
          className="max-w-64"
          autoComplete="off"
        />
        {q && <span className="text-xs text-ink-secondary">{filtered.length} rezultat(a)</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => shiftMonth(-1)} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface-2" title="Prethodni mesec" aria-label="Prethodni mesec">
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-28 text-center text-xs font-medium text-ink">{MONTH_NAMES[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface-2" title="Sledeći mesec" aria-label="Sledeći mesec">
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
          <Button
            variant="secondary"
            className="h-8"
            onClick={downloadTeamKarnet}
            loading={karnetBusy}
            title="Preuzmi karnete celog tima za izabrani mesec (jedan član po strani)"
          >
            <FileText className="h-4 w-4" aria-hidden /> Karnet tima
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
      <span className="inline-flex items-center gap-1.5 text-status-warn">
        <span className="inline-block h-2 w-2 rounded-full bg-status-warn" aria-hidden />
        {absLabel(m.currentAbsence.type)} do {m.currentAbsence.date_to ? formatDate(m.currentAbsence.date_to) : '—'}
      </span>
    );
  } else if (m.upcomingAbsence) {
    const d = daysToStart(m.upcomingAbsence);
    const when = d === 1 ? 'sutra' : d != null ? `za ${d} d` : '';
    status = (
      <span className="inline-flex items-center gap-1.5 text-accent">
        <span className="inline-block h-2 w-2 rounded-full bg-status-info" aria-hidden />
        {absLabel(m.upcomingAbsence.type)} {m.upcomingAbsence.date_from ? formatDate(m.upcomingAbsence.date_from) : ''}
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
          <span className="mr-1 inline-block align-text-bottom text-ink-secondary">{open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}</span>
          {m.fullName || '—'}
          {toolCount > 0 && (
            <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary" title="Zaduženja alata">
              <Wrench className="h-3 w-3" aria-hidden /> {toolCount}
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
  const tools = toolsQ.data?.data?.tools ?? [];
  const [pdfBusy, setPdfBusy] = useState(false);

  const bal = m.balance;
  const goLine = bal
    ? `Godišnji: ukupno ${fmtGrid(num(bal.days_earned ?? bal.days_total) + num(bal.days_carried_over))}, iskorišćeno ${fmtGrid(num(bal.days_used))}, preostalo ${fmtGrid(num(bal.days_remaining))}`
    : 'Saldo godišnjeg: nema podataka';

  const absParts: ReactNode[] = [];
  if (m.currentAbsence) {
    absParts.push(
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-status-warn" aria-hidden />
        Trenutno: {absLabel(m.currentAbsence.type)} — {fmtRange(m.currentAbsence)}
      </span>,
    );
  }
  if (m.upcomingAbsence) {
    absParts.push(
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-status-info" aria-hidden />
        Sledeće: {absLabel(m.upcomingAbsence.type)} — {fmtRange(m.upcomingAbsence)}
      </span>,
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
      toast(e instanceof ApiError ? e.message : 'PDF nije uspeo');
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

      {/* Prisustvo (ulazi/izlazi) člana — isti prikaz kao „Moje prisustvo" (zahtev 011/26). */}
      <TeamMemberAttendance employeeId={m.id} />

      <div>
        <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary"><Wrench className="h-3.5 w-3.5" aria-hidden /> Zaduženja (alat / oprema)</h4>
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
          <Pencil className="h-4 w-4" aria-hidden /> Korekcija kucanja
        </Button>
        {m.positionId ? (
          <Button variant="secondary" className="h-8" onClick={downloadPositionPdf} loading={pdfBusy}>
            <FileText className="h-4 w-4" aria-hidden /> Opis pozicije (PDF A4)
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

// ── prisustvo člana (ulazi/izlazi) — zahtev 011/26 ────────────────
// Isti prikaz kao „Moje prisustvo" (self AttendanceSection): mesečni pregled dnevnih
// ulaza/izlaza + sati, klik na red = sirovi prolazi tog dana. Scope „samo svoj tim"
// presuđuje BE (`current_user_manages_employee`); van opsega → 404 → „nije dostupno".
// Mount je lazy (detalj člana se renderuje tek kad je red otvoren).

function TeamMemberAttendance({ employeeId }: { employeeId: string }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const y = cursor.getFullYear();
  const mo = cursor.getMonth();
  const from = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(y, mo + 1, 0).getDate();
  const to = `${y}-${String(mo + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const label = cursor.toLocaleDateString('sr-Latn', { month: 'long', year: 'numeric' });
  const q = useTeamAttendance(employeeId, { from, to });
  const days = (q.data?.data?.days ?? []) as AttendanceDay[];
  const [openDay, setOpenDay] = useState<string | null>(null);
  const today = todayYmd();
  const now = new Date();
  const atCurrentMonth = y >= now.getFullYear() && mo >= now.getMonth();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
          <Clock className="h-3.5 w-3.5" aria-hidden /> Prisustvo (ulazi / izlazi)
        </h4>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setCursor(new Date(y, mo - 1, 1))} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface" title="Prethodni mesec" aria-label="Prethodni mesec">
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-24 text-center text-xs font-medium capitalize text-ink">{label}</span>
          <button onClick={() => setCursor(new Date(y, mo + 1, 1))} disabled={atCurrentMonth} className="rounded-control border border-line px-1.5 py-1 text-ink-secondary hover:bg-surface disabled:opacity-40" title="Sledeći mesec" aria-label="Sledeći mesec">
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <p className="mb-2 flex flex-wrap items-center gap-x-1 text-2xs text-ink-disabled">
        Prolazi sa kapije, hala i kioska. Klik na red = prolazi tog dana.
        <Pencil className="inline-block h-3 w-3 align-text-bottom" aria-hidden /> korigovano ·
        <AlertTriangle className="inline-block h-3 w-3 align-text-bottom text-status-warn" aria-hidden /> izlaz nije otkucan ·
        <Moon className="inline-block h-3 w-3 align-text-bottom" aria-hidden /> preko ponoći.
      </p>
      {q.isLoading ? (
        <p className="text-xs text-ink-disabled">Učitavam prisustvo…</p>
      ) : q.isError ? (
        <p className="text-xs text-status-danger">
          {q.error instanceof ApiError ? q.error.message : 'Greška pri učitavanju prisustva.'}{' '}
          <button onClick={() => void q.refetch()} className="text-accent hover:underline" disabled={q.isFetching}>
            {q.isFetching ? 'Učitavam…' : 'Pokušaj ponovo'}
          </button>
        </p>
      ) : days.length === 0 ? (
        <p className="text-xs text-ink-disabled">Nema prolaza u ovom mesecu.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Dan</th>
                <th className="py-1.5">Ulaz</th>
                <th className="py-1.5">Izlaz</th>
                <th className="py-1.5">Sati</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => {
                const firstIn = d.first_in ?? d.time_in;
                const lastOut = d.last_out ?? d.time_out;
                const overnight = !!firstIn && !!lastOut && String(lastOut) < String(firstIn);
                const openIntervals = num(d.open_intervals);
                const missingOut = (openIntervals > 0 || (!!firstIn && !lastOut)) && String(d.day ?? '').slice(0, 10) !== today && !overnight;
                const corrected = d.corrected === true;
                const isOpen = openDay === d.day;
                return (
                  <Fragment key={i}>
                    <tr className="cursor-pointer border-b border-line-soft hover:bg-surface" onClick={() => setOpenDay(isOpen ? null : d.day)}>
                      <td className="py-1.5 tnums">
                        {formatDate(d.day)}{' '}
                        {corrected ? (
                          <span title="Korigovano uz obrazloženje"><Pencil className="inline-block h-3.5 w-3.5 align-text-bottom text-ink-secondary" aria-hidden /></span>
                        ) : missingOut ? (
                          <span className="text-status-warn" title="Izlaz nije otkucan"><AlertTriangle className="inline-block h-3.5 w-3.5 align-text-bottom" aria-hidden /></span>
                        ) : overnight ? (
                          <span title="Smena preko ponoći"><Moon className="inline-block h-3.5 w-3.5 align-text-bottom" aria-hidden /></span>
                        ) : null}
                      </td>
                      <td className="py-1.5 tnums">{hhmm(firstIn)}</td>
                      <td className="py-1.5 tnums">
                        {lastOut ? hhmm(lastOut) : missingOut ? <span className="text-status-warn">nije otkucan</span> : '—'}
                      </td>
                      <td className="py-1.5 tnums">{d.presence_hours != null ? num(d.presence_hours).toFixed(2) : '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={4} className="bg-surface px-3 pb-2 pt-1">
                          <TeamMemberAttendanceDrill employeeId={employeeId} day={d.day} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Prolazi jednog dana za člana (lazy) — HH:MM · smer · terminal · razlog. */
function TeamMemberAttendanceDrill({ employeeId, day }: { employeeId: string; day: string }) {
  const q = useTeamAttendanceEvents(employeeId, day.slice(0, 10));
  if (q.isLoading) return <p className="text-xs text-ink-disabled">Učitavam prolaze…</p>;
  if (q.isError)
    return (
      <p className="text-xs text-status-danger">
        {q.error instanceof ApiError ? q.error.message : 'Greška pri učitavanju prolaza.'}{' '}
        <button onClick={() => void q.refetch()} className="text-accent hover:underline" disabled={q.isFetching}>
          {q.isFetching ? 'Učitavam…' : 'Pokušaj ponovo'}
        </button>
      </p>
    );
  const events = q.data?.data?.events ?? [];
  if (events.length === 0) return <p className="text-xs text-ink-disabled">Nema prolaza.</p>;
  return (
    <ul className="space-y-0.5 text-xs text-ink-secondary">
      {events.map((e, i) => (
        <li key={i} className="tnums">
          {hhmm(e.event_ts_local)} · {DIR_LABEL[e.direction] ?? e.direction} · {e.terminal_name ?? '—'}
          {e.reason ? <em className="text-ink-disabled"> ({e.reason})</em> : null}
        </li>
      ))}
    </ul>
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
      toast('Korekcija uneta.');
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
    <Dialog open onClose={onClose} title={`Korekcija kucanja — ${member.fullName || ''}`} footer={footer}>
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
