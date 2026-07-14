'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import { generateVacationDecisionPdf } from '@/lib/hr-pdf';
import {
  useRequests,
  useKadrMe,
  useEmployees,
  useVacationBalance,
  useHolidays,
  useVacationVacreqApprove,
  useVacationReject,
  useVacationReschedule,
  useVacationRevise,
  useVacationDelete,
  useUploadDocument,
  useDispatchNotifications,
  signDocument,
  fetchEmployeePii,
  newClientEventId,
  type VacationRequest,
} from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import { toRosterEmp, type RosterEmp } from './types';
import { holidaySetFromRows, nextWorkingDay, daysInclusive } from './helpers';
import { RejectModal, RescheduleModal } from './request-modals';
import { useOdmoriUi } from './ui';

const STATUS_TONE: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'warn', label: 'Na čekanju' },
  sef_approved: { tone: 'info', label: 'Odobrio šef (čeka HR)' },
  approved: { tone: 'success', label: 'Odobreno' },
  rejected: { tone: 'danger', label: 'Odbijeno' },
  canceled: { tone: 'neutral', label: 'Otkazano' },
};

interface RpcResult { status?: string; requested?: number; remaining?: number }
function rpcStatus(res: unknown): RpcResult {
  return ((res as { data?: unknown } | null)?.data as RpcResult | null) ?? {};
}

export function ZahteviTab({ onOpenCount }: { onOpenCount?: (n: number) => void }) {
  const { can } = useAuth();
  const canVacreq = can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE) || can(PERMISSIONS.KADROVSKA_VACREQ_ADMIN);
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const { showToast, confirm } = useOdmoriUi();
  const meQ = useKadrMe();
  const me = meQ.data?.data;

  const [statusF, setStatusF] = useState<string>('pending');
  const [search, setSearch] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());

  const reqQ = useRequests({}, canVacreq);
  const empQ = useEmployees({ pageSize: 1000 });
  const balQ = useVacationBalance({ year });
  const holQ = useHolidays({ from: `${year}-01-01`, to: `${year + 1}-01-31` });

  const vacreqApprove = useVacationVacreqApprove();
  const reject = useVacationReject();
  const reschedule = useVacationReschedule();
  const revise = useVacationRevise();
  const del = useVacationDelete();
  const upload = useUploadDocument();

  const [rejectFor, setRejectFor] = useState<VacationRequest | null>(null);
  const [reschedFor, setReschedFor] = useState<VacationRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const empById = useMemo(() => {
    const m = new Map<string, RosterEmp>();
    for (const e of empQ.data?.data ?? []) m.set(sv(e, 'id'), toRosterEmp(e));
    return m;
  }, [empQ.data]);

  const all = reqQ.data?.data?.vacation ?? [];

  const counts = useMemo(() => {
    const c = { pending: 0, sef_approved: 0, approved: 0, rejected: 0, total: all.length };
    for (const r of all) {
      if (r.status === 'pending') c.pending++;
      else if (r.status === 'sef_approved') c.sef_approved++;
      else if (r.status === 'approved') c.approved++;
      else if (r.status === 'rejected') c.rejected++;
    }
    return c;
  }, [all]);

  useEffect(() => {
    onOpenCount?.(counts.pending + counts.sef_approved);
  }, [counts.pending, counts.sef_approved, onOpenCount]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (statusF && r.status !== statusF) return false;
      if (year && r.year !== year) return false;
      if (q) {
        const name = (empById.get(r.employeeId)?.name || '').toLowerCase();
        const by = (r.submittedBy || '').toLowerCase();
        if (!name.includes(q) && !by.includes(q)) return false;
      }
      return true;
    });
  }, [all, statusF, year, search, empById]);

  function submitterCell(r: VacationRequest) {
    const who = (r.submittedBy || '').trim();
    if (!who) return '—';
    const when = r.createdAt ? formatDate(r.createdAt) : '';
    const empEmail = (empById.get(r.employeeId)?.email || '').trim().toLowerCase();
    const onBehalf = !empEmail || who.toLowerCase() !== empEmail;
    return (
      <span>
        {who}{when ? ` · ${when}` : ''}
        {onBehalf && <span className="ml-1 rounded border border-line px-1 text-[0.6rem] text-ink-secondary" title="Zahtev je u ime radnika podneo rukovodilac/HR">u ime</span>}
      </span>
    );
  }

  async function doApprove(r: VacationRequest) {
    const who = empById.get(r.employeeId)?.name || r.employeeId.slice(0, 8);
    const period = `${formatDate(r.dateFrom)} – ${formatDate(r.dateTo)}`;
    const isFinalize = r.status === 'sef_approved';
    let body: string, confirmLabel: string;
    if (isFinalize) { body = `Finalizovati (2. nivo / HR) zahtev za GO zaposlenog ${who} u periodu ${period}? Kreira se evidencija odsustva.`; confirmLabel = 'Finalizuj'; }
    else if (me?.isAdmin) { body = `Odobriti direktno (uprava) zahtev za GO zaposlenog ${who} u periodu ${period}? Kreira se evidencija odsustva.`; confirmLabel = 'Odobri'; }
    else { body = `Odobriti kao šef (1. nivo) zahtev za GO zaposlenog ${who} u periodu ${period}? Zahtev se prosleđuje HR-u.`; confirmLabel = 'Odobri (šef)'; }

    if (!(await confirm({ title: 'Odobravanje GO', body, confirmLabel }))) return;
    setBusyId(r.id);
    try {
      const res = await vacreqApprove.mutateAsync({ id: r.id, clientEventId: newClientEventId() });
      const { status, requested, remaining } = rpcStatus(res);
      if (status === 'already_processed') showToast('ℹ Zahtev je u međuvremenu već obrađen — lista osvežena');
      else if (status === 'dual_control') showToast('⚠ Isti korisnik ne može i 1. i 2. nivo — finalizaciju radi druga osoba.');
      else if (status === 'exceeds_balance') showToast(`⚠ GO premašuje saldo (traženo ${requested}, preostalo ${remaining}). Ne može se odobriti.`);
      else if (status === 'sef_approved') showToast('✅ Odobreno (1. nivo) — prosleđeno HR-u na finalizaciju');
      else if (status === 'approved') showToast('✅ Zahtev odobren — odsustvo dodato u evidenciju');
      else showToast('✅ Obrađeno');
    } catch (e) {
      showToast(e instanceof ApiError && e.status === 403 ? '⚠ Nemate dozvolu (rola/opseg)' : '⚠ Greška pri odobravanju');
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(note: string): Promise<string | null> {
    if (!rejectFor) return null;
    try {
      const res = await reject.mutateAsync({ id: rejectFor.id, note, clientEventId: newClientEventId() });
      if (rpcStatus(res).status === 'already_processed') showToast('ℹ Zahtev je već obrađen — lista osvežena');
      else showToast('🚫 Zahtev odbijen');
      return null;
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? 'Nemate dozvolu za odbijanje.' : 'Greška pri odbijanju.';
    }
  }

  async function onReschedule(mode: 'move' | 'reapprove', from: string, to: string, days: number): Promise<string | null> {
    if (!reschedFor) return null;
    try {
      const res = mode === 'reapprove'
        ? await revise.mutateAsync({ id: reschedFor.id, dateFrom: from, dateTo: to, daysCount: days, forceReapproval: true, clientEventId: newClientEventId() })
        : await reschedule.mutateAsync({ id: reschedFor.id, dateFrom: from, dateTo: to, daysCount: days, clientEventId: newClientEventId() });
      const { status, requested, remaining } = rpcStatus(res);
      if (status === 'exceeds_balance') return `Nije moguće: traženo ${requested} radnih dana, dostupno ${remaining}. Dani preko salda ne mogu u godišnji.`;
      if (status === 'not_approved' || status === 'not_editable' || status === 'not_found') { showToast('ℹ Zahtev se više ne može menjati — lista osvežena'); return null; }
      if (status === 'pending') { showToast('✅ Termin izmenjen — zahtev vraćen na odobravanje'); return null; }
      showToast('✅ Termin godišnjeg izmenjen — evidencija ažurirana');
      return null;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) return 'Nemate dozvolu za izmenu ovog zahteva.';
        if (e.status === 409) return 'Novi termin se preklapa sa drugim odsustvom. Izaberite slobodan period.';
      }
      return 'Greška pri izmeni termina.';
    }
  }

  async function onDelete(r: VacationRequest) {
    if (!(await confirm({ title: 'Brisanje zahteva', body: 'Obrisati ovaj zahtev za GO? Akcija je trajna.', confirmLabel: 'Obriši', danger: true }))) return;
    try {
      await del.mutateAsync({ id: r.id });
      showToast('🗑 Zahtev obrisan');
    } catch {
      showToast('⚠ Brisanje nije uspelo');
    }
  }

  async function onResenje(r: VacationRequest) {
    const emp = empById.get(r.employeeId);
    if (!emp) { showToast('⚠ Zaposleni nije pronađen.'); return; }
    if (!emp.position) { showToast('⚠ Zaposlenom nije dodeljeno radno mesto (Zaposleni → Radno mesto).'); return; }
    const days = r.daysCount || daysInclusive(r.dateFrom.slice(0, 10), r.dateTo.slice(0, 10));
    const broj = `GO-${r.year}-${String(r.id).replace(/-/g, '').slice(0, 4).toUpperCase()}`;
    const ok = await confirm({
      title: 'Generisanje rešenja o GO',
      body: `Generisati rešenje o godišnjem odmoru za ${emp.name}\nPeriod: ${formatDate(r.dateFrom)} – ${formatDate(r.dateTo)} (${days} radnih dana)\nBroj: ${broj}\n\nPDF se snima u dokumenta zaposlenog i šalje na mejl (ako ima mejl).`,
      confirmLabel: 'Generiši i sačuvaj',
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      // JMBG (PII) + saldo + datum povratka
      let jmbg = '________________';
      if (canPii) { try { const p = await fetchEmployeePii(emp.id); jmbg = sv(p.data, 'personal_id') || jmbg; } catch { /* nema PII */ } }
      const bal = (balQ.data?.data ?? []).find((b) => sv(b, 'employee_id') === emp.id);
      const saldo = bal ? {
        ukupno: Number(bal.days_earned ?? bal.days_total ?? 0) + Number(bal.days_carried_over ?? 0),
        iskorisceno: Number(bal.days_used ?? 0),
        preostalo: Number(bal.days_remaining_accrued ?? bal.days_remaining ?? 0),
      } : null;
      const returnIso = nextWorkingDay(r.dateTo.slice(0, 10), holidaySetFromRows(holQ.data?.data));

      const { blob, fileName } = await generateVacationDecisionPdf({
        brojResenja: broj,
        datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
        mesto: 'Dobanovci',
        godina: r.year,
        imePrezime: emp.name,
        jmbg,
        radnoMesto: emp.position,
        brojDana: days,
        datumOd: formatDate(r.dateFrom),
        datumDo: formatDate(r.dateTo),
        datumPovratka: returnIso ? formatDate(returnIso) : '________',
        saldo,
        potpisPoslodavac: 'Nenad Jaraković',
      });
      const file = new File([blob], fileName, { type: 'application/pdf' });
      const res = await upload.mutateAsync({
        employeeId: emp.id,
        file,
        docType: 'resenje_go',
        description: `Rešenje o godišnjem odmoru za ${r.year}. (${formatDate(r.dateFrom)} – ${formatDate(r.dateTo)}, ${days} dana)`,
        queueEmail: true,
        emailLabel: 'Rešenje o godišnjem odmoru',
        clientEventId: newClientEventId(),
      });
      showToast('✅ Rešenje sačuvano u dokumenta zaposlenog (mejl u redu ako ima adresu)');
      try {
        const docId = ((res as { data?: { id?: string } }).data)?.id;
        if (docId) { const signed = await signDocument(docId); if (signed?.data) window.open(signed.data, '_blank', 'noopener'); }
      } catch { /* preview best-effort */ }
    } catch (e) {
      showToast('⚠ Greška pri generisanju rešenja: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusyId(null);
    }
  }

  const cols: Column<VacationRequest>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => empById.get(r.employeeId)?.name || r.employeeId.slice(0, 8) },
    { key: 'dep', header: 'Odeljenje', render: (r) => empById.get(r.employeeId)?.department || '—' },
    { key: 'from', header: 'Od', render: (r) => (r.dateFrom ? formatDate(r.dateFrom) : '—') },
    { key: 'to', header: 'Do', render: (r) => (r.dateTo ? formatDate(r.dateTo) : '—') },
    { key: 'days', header: 'Dana', align: 'right', numeric: true, render: (r) => r.daysCount },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = STATUS_TONE[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    { key: 'by', header: 'Podneo/la', render: (r) => <span className="text-xs text-ink-secondary">{submitterCell(r)}</span> },
    { key: 'note', header: 'Napomena', render: (r) => <span className="text-xs text-ink-secondary">{r.note || '—'}</span> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const busy = busyId === r.id;
        const showDelete = me?.isHrOrAdmin && r.status !== 'pending';
        return (
          <div className="flex flex-wrap justify-end gap-1">
            {canVacreq && r.status === 'pending' && (
              <>
                <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doApprove(r)}>✔ {me?.isAdmin ? 'Odobri' : 'Odobri (šef)'}</Button>
                <Button variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setRejectFor(r)}>✘ Odbij</Button>
              </>
            )}
            {canVacreq && r.status === 'sef_approved' && (
              <>
                {me?.isHrOrAdmin && <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doApprove(r)}>✔ Finalizuj (HR)</Button>}
                <Button variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setRejectFor(r)}>✘ Odbij</Button>
              </>
            )}
            {canVacreq && r.status === 'approved' && (
              <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setReschedFor(r)}>✎ Izmeni termin</Button>
            )}
            {canPii && r.status === 'approved' && (
              <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onResenje(r)}>📄 Rešenje</Button>
            )}
            {showDelete && (
              <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onDelete(r)}>Obriši</Button>
            )}
          </div>
        );
      },
    },
  ];

  if (!canVacreq) {
    return <p className="text-sm text-ink-secondary">Zahtevi za GO i odobravanje vidljivi su rukovodiocima sa pravom upravljanja zahtevima.</p>;
  }

  return (
    <section className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Na čekanju', value: counts.pending, tone: counts.pending > 0 ? 'warn' : 'default' },
          { label: 'Čeka HR', value: counts.sef_approved, tone: counts.sef_approved > 0 ? 'warn' : 'default' },
          { label: 'Odobreno', value: counts.approved },
          { label: 'Odbijeno', value: counts.rejected, tone: counts.rejected > 0 ? 'danger' : 'default' },
          { label: 'Ukupno', value: counts.total },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="h-8 rounded-control border border-line bg-surface px-2 text-sm">
          <option value="">Svi statusi</option>
          <option value="pending">Na čekanju</option>
          <option value="sef_approved">Odobrio šef (čeka HR)</option>
          <option value="approved">Odobreni</option>
          <option value="rejected">Odbijeni</option>
        </select>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pretraga po imenu…" className="h-8 w-52 rounded-control border border-line bg-surface px-3 text-sm" />
        <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="h-8 w-24 rounded-control border border-line bg-surface px-2 text-sm" title="Godina" />
        <div className="ml-auto flex items-center gap-2">
          <DispatchButton />
          <span className="text-xs text-ink-secondary">{filtered.length === counts.total ? `${counts.total} zahteva` : `${filtered.length} / ${counts.total} zahteva`}</span>
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={filtered}
        rowKey={(r) => r.id}
        loading={reqQ.isLoading}
        empty={<EmptyState title="Nema zahteva za prikaz" />}
      />

      {rejectFor && (
        <RejectModal
          title="Odbij zahtev za GO"
          subtitle={`${empById.get(rejectFor.employeeId)?.name || ''} — ${rejectFor.dateFrom ? formatDate(rejectFor.dateFrom) : ''} do ${rejectFor.dateTo ? formatDate(rejectFor.dateTo) : ''}`}
          requireReason
          onConfirm={onReject}
          onClose={() => setRejectFor(null)}
        />
      )}
      {reschedFor && (
        <RescheduleModal
          req={reschedFor}
          employeeName={empById.get(reschedFor.employeeId)?.name || ''}
          holidays={holidaySetFromRows(holQ.data?.data)}
          onSubmit={onReschedule}
          onClose={() => setReschedFor(null)}
        />
      )}
    </section>
  );
}

/** 🔔 „Pošalji čekaće" — ručni HR dispatch. */
function DispatchButton() {
  const dispatch = useDispatchNotifications();
  const { showToast } = useOdmoriUi();
  async function run() {
    try {
      const res = await dispatch.mutateAsync();
      const { processed = 0, sent = 0, failed = 0 } = res.data ?? {};
      if (processed === 0) showToast('ℹ Nema čekajućih notifikacija u redu');
      else showToast(`📧 Dispatch: ${sent} poslato, ${failed} neuspešno (od ${processed} u redu)`);
    } catch {
      showToast('⚠ Dispatch nije uspeo (proveri vezu/dozvole)');
    }
  }
  return (
    <Button variant="secondary" className="h-8 px-2 text-xs" loading={dispatch.isPending} onClick={run} title="Odmah pošalji sve čekaće notifikacije (ne čekaj cron)">
      🔔 Pošalji čekaće
    </Button>
  );
}
