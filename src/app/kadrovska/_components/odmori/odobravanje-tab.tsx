'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  useRequests,
  useKadrMe,
  useEmployees,
  useVacationVacreqApprove,
  useVacationReject,
  useMakeupApprove,
  useMakeupReject,
  useMakeupStorno,
  useMakeupDelete,
  usePaidLeaveApprove,
  usePaidLeaveReject,
  useNopApprove,
  useNopReject,
  useGrantBonusGo,
  newClientEventId,
} from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import { toRosterEmp, type RosterEmp } from './types';
import { RejectModal } from './request-modals';
import { useOdmoriUi } from './ui';

type ReqType = 'go' | 'makeup' | 'paid' | 'nop';
type Step = 'sef' | 'hr' | 'admin';

interface AnyReq {
  id: string;
  employeeId: string;
  status: string;
  createdAt?: string;
  submittedBy?: string | null;
  requestedBy?: string | null;
  note?: string | null;
  reason?: string | null;
  level1By?: string | null;
  [k: string]: unknown;
}
interface InboxItem { type: ReqType; step: Step; r: AnyReq }

const TYPE_LABEL: Record<ReqType, string> = { go: 'Godišnji odmor', makeup: 'Nadoknada sati', paid: 'Plaćeno odsustvo', nop: 'Neplaćeno' };
const PAID_LEAVE_LABEL: Record<string, string> = {
  vencanje: 'Sklapanje braka', rodjenje_deteta: 'Rođenje deteta', smrt_clana: 'Smrt člana porodice',
  dobrovoljno_davanje_krvi: 'Davanje krvi', selidba: 'Selidba', ispit: 'Polaganje ispita', drugo: 'Drugo',
};

function stepBadge(step: Step) {
  if (step === 'sef') return <Badge color="#B07A1E" title="Prvi nivo — operativna saglasnost">1. nivo (šef)</Badge>;
  if (step === 'hr') return <Badge color="#3B8C4E" title="Drugi nivo — finalno odobrenje">finalno (HR/uprava)</Badge>;
  return <Badge color="#2563eb" title="Odluka uprave">odluka (admin)</Badge>;
}
function Badge({ children, color, title }: { children: React.ReactNode; color: string; title?: string }) {
  return <span className="rounded border px-1.5 py-0.5 text-[0.65rem]" style={{ color, borderColor: `${color}55` }} title={title}>{children}</span>;
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

export function OdobravanjeTab({ onCount }: { onCount?: (n: number) => void }) {
  const { can, user } = useAuth();
  const canVacreq = can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE) || can(PERMISSIONS.KADROVSKA_VACREQ_ADMIN);
  const { showToast, confirm } = useOdmoriUi();
  const myEmail = (user?.email || '').toLowerCase();

  const meQ = useKadrMe();
  const me = meQ.data?.data;
  const reqQ = useRequests({}, canVacreq);
  const empQ = useEmployees({ pageSize: 1000 });

  const vacApprove = useVacationVacreqApprove();
  const vacReject = useVacationReject();
  const mkApprove = useMakeupApprove();
  const mkReject = useMakeupReject();
  const mkStorno = useMakeupStorno();
  const mkDelete = useMakeupDelete();
  const plApprove = usePaidLeaveApprove();
  const plReject = usePaidLeaveReject();
  const nopApprove = useNopApprove();
  const nopReject = useNopReject();
  const bonus = useGrantBonusGo();

  const [rejectFor, setRejectFor] = useState<InboxItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const empById = useMemo(() => {
    const m = new Map<string, RosterEmp>();
    for (const e of empQ.data?.data ?? []) m.set(sv(e, 'id'), toRosterEmp(e));
    return m;
  }, [empQ.data]);
  const empName = (id: string) => empById.get(id)?.name || '—';

  function actionable(type: ReqType, r: AnyReq): Step | null {
    if (type === 'nop') return r.status === 'pending' && me?.isAdmin ? 'admin' : null;
    if (!canVacreq) return null;
    if (r.status === 'pending') return 'sef';
    if (r.status === 'sef_approved' && me?.isHrOrAdmin && (r.level1By || '').toLowerCase() !== myEmail) return 'hr';
    return null;
  }

  const inbox: InboxItem[] = useMemo(() => {
    const bundle = reqQ.data?.data;
    if (!bundle) return [];
    const out: InboxItem[] = [];
    const push = (type: ReqType, arr: AnyReq[]) => {
      for (const r of arr) { const step = actionable(type, r); if (step) out.push({ type, step, r }); }
    };
    push('go', (bundle.vacation ?? []) as unknown as AnyReq[]);
    push('makeup', (bundle.makeup ?? []) as unknown as AnyReq[]);
    push('paid', (bundle.paidLeave ?? []) as unknown as AnyReq[]);
    push('nop', (bundle.nop ?? []) as unknown as AnyReq[]);
    out.sort((a, b) => String(a.r.createdAt || '').localeCompare(String(b.r.createdAt || '')));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqQ.data, me, myEmail, canVacreq]);

  const byType = useMemo(() => {
    const c = { go: 0, makeup: 0, paid: 0, nop: 0 };
    for (const it of inbox) c[it.type]++;
    onCount?.(inbox.length);
    return c;
  }, [inbox, onCount]);

  function describe(it: InboxItem): string {
    const r = it.r;
    if (it.type === 'go') return `${formatDate(String(r.dateFrom))} – ${formatDate(String(r.dateTo))} · ${r.daysCount || ''} dana`;
    if (it.type === 'makeup') {
      return r.compensationType === 'dan_odmora'
        ? `Rad vikendom ${formatDate(String(r.weekendWorkDate || r.absenceDate))} (${r.absenceHours}h) → +1 dan GO u saldo`
        : `Izostanak ${formatDate(String(r.absenceDate))} (${r.absenceHours}h)${r.makeupPlan ? ` · plan: ${r.makeupPlan}` : ''}`;
    }
    if (it.type === 'paid') return `${PAID_LEAVE_LABEL[String(r.leaveType)] || r.leaveType} · ${formatDate(String(r.dateFrom))} – ${formatDate(String(r.dateTo))} · ${r.daysCount || ''} dana`;
    return `${formatDate(String(r.workDate))}${r.reason ? ` · ${r.reason}` : ''}`;
  }

  async function approve(it: InboxItem) {
    setBusyId(it.r.id);
    try {
      const cid = newClientEventId();
      const res =
        it.type === 'go' ? await vacApprove.mutateAsync({ id: it.r.id, clientEventId: cid })
        : it.type === 'makeup' ? await mkApprove.mutateAsync({ id: it.r.id, clientEventId: cid })
        : it.type === 'paid' ? await plApprove.mutateAsync({ id: it.r.id, clientEventId: cid })
        : await nopApprove.mutateAsync({ id: it.r.id, clientEventId: cid });
      const data = (res as { data?: { status?: string; requested?: number; remaining?: number } }).data ?? {};
      const st = data.status;
      if (st === 'dual_control') { showToast('⚠ Isti korisnik ne može oba nivoa istog zahteva.'); return; }
      if (st === 'exceeds_balance') { showToast(`⚠ GO premašuje saldo (traženo ${data.requested}, preostalo ${data.remaining}).`); return; }
      if (st === 'already_processed') { showToast('ℹ Zahtev je već obrađen — lista osvežena'); return; }
      showToast(st === 'sef_approved' ? '✅ Odobreno (1. nivo) — prosleđeno HR-u' : '✅ Odobreno');
      // Rad vikendom → +1 dan GO (finalno odobrenje makeup 'dan_odmora').
      if (it.type === 'makeup' && st === 'approved' && it.r.compensationType === 'dan_odmora') {
        try {
          await bonus.mutateAsync({
            clientEventId: newClientEventId(),
            employeeId: it.r.employeeId,
            workDate: String(it.r.weekendWorkDate || it.r.absenceDate),
            days: 1,
            reason: String(it.r.reason || 'Rad vikendom'),
            makeupRequestId: it.r.id,
          });
          showToast('🏖 +1 dan GO dodat u saldo');
        } catch (e) {
          if (String(e instanceof Error ? e.message : e).includes('already_granted')) showToast('ℹ Dan je već dodat u saldo');
          else showToast('⚠ Zahtev odobren, ali +1 dan GO nije upisan — dodajte ručno.');
        }
      }
    } catch (e) {
      showToast(e instanceof ApiError && e.status === 403 ? '⚠ Nemate dozvolu za ovu akciju.' : '⚠ Greška pri odobravanju.');
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(note: string): Promise<string | null> {
    if (!rejectFor) return null;
    const it = rejectFor;
    try {
      if (it.type === 'go') await vacReject.mutateAsync({ id: it.r.id, note, clientEventId: newClientEventId() });
      else if (it.type === 'makeup') await mkReject.mutateAsync({ id: it.r.id, note });
      else if (it.type === 'paid') await plReject.mutateAsync({ id: it.r.id, note });
      else await nopReject.mutateAsync({ id: it.r.id, note });
      showToast('🚫 Zahtev odbijen');
      return null;
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? 'Nemate dozvolu.' : 'Greška pri odbijanju.';
    }
  }

  async function storno(it: InboxItem) {
    const note = window.prompt(`Storno zahteva za nadoknadu — ${empName(it.r.employeeId)}. Razlog storna (opciono):`, '');
    if (note === null) return;
    setBusyId(it.r.id);
    try {
      await mkStorno.mutateAsync({ id: it.r.id, note: note.trim() });
      showToast('↩ Stornirano');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes('not_approved')) showToast('⚠ Storno je moguć samo za odobren/nadoknađen zahtev.');
      else showToast('⚠ Greška pri storniranju.');
    } finally { setBusyId(null); }
  }

  async function deleteMakeup(it: InboxItem) {
    if (!(await confirm({ title: 'Brisanje zahteva', body: `Trajno obrisati zahtev za nadoknadu — ${empName(it.r.employeeId)}?`, confirmLabel: 'Obriši', danger: true }))) return;
    setBusyId(it.r.id);
    try {
      await mkDelete.mutateAsync({ id: it.r.id });
      showToast('🗑 Obrisano');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes('must_storno_first')) showToast('⚠ Odobren/nadoknađen zahtev se ne briše direktno — prvo ↩ Storniraj.');
      else showToast('⚠ Brisanje nije uspelo.');
    } finally { setBusyId(null); }
  }

  if (!canVacreq && !me?.isAdmin) {
    return <p className="text-sm text-ink-secondary">Objedinjeni inbox „Za odobravanje" vidljiv je rukovodiocima sa pravom upravljanja zahtevima.</p>;
  }

  return (
    <section className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Godišnji', value: byType.go, tone: byType.go ? 'warn' : 'default' },
          { label: 'Nadoknada', value: byType.makeup, tone: byType.makeup ? 'warn' : 'default' },
          { label: 'Plaćeno', value: byType.paid, tone: byType.paid ? 'warn' : 'default' },
          ...(me?.isAdmin ? [{ label: 'Neplaćeno', value: byType.nop, tone: (byType.nop ? 'warn' : 'default') as 'warn' | 'default' }] : []),
        ]}
      />

      {reqQ.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : inbox.length === 0 ? (
        <EmptyState title="Nema ničega za odobravanje 🎉" hint="Svi zahtevi u tvom opsegu su obrađeni." />
      ) : (
        <div className="space-y-2">
          {inbox.map((it) => {
            const busy = busyId === it.r.id;
            const nm = empName(it.r.employeeId);
            const isDanOdmora = it.type === 'makeup' && it.r.compensationType === 'dan_odmora';
            return (
              <div key={`${it.type}-${it.r.id}`} className="flex items-start gap-3 rounded-panel border border-line bg-surface p-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-ink-secondary">{initials(nm)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-ink">{nm}</span>
                    <Badge color="#64748b">{TYPE_LABEL[it.type]}</Badge>
                    {isDanOdmora && <Badge color="#3B8C4E">🏖 Dan odmora</Badge>}
                    {stepBadge(it.step)}
                  </div>
                  <div className="mt-0.5 text-sm text-ink-secondary">{describe(it)}</div>
                  {(it.r.note || it.r.reason) && <div className="mt-0.5 text-xs text-ink-secondary">{it.r.note || it.r.reason}</div>}
                  <div className="mt-0.5 text-[0.7rem] text-ink-disabled">
                    Podneo/la: {it.r.submittedBy || it.r.requestedBy || '—'}{it.r.createdAt ? ` · ${formatDate(it.r.createdAt)}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => approve(it)}>✔ Odobri</Button>
                  <Button variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setRejectFor(it)}>✘ Odbij</Button>
                  {it.type === 'makeup' && me?.isHrOrAdmin && (
                    <>
                      <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => storno(it)} title="Poništi odobrenje (za dan_odmora vraća −1 dan GO)">↩ Storniraj</Button>
                      <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => deleteMakeup(it)} title="Trajno obriši zahtev">🗑</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rejectFor && (
        <RejectModal
          title={`Odbij zahtev — ${TYPE_LABEL[rejectFor.type]}`}
          subtitle={empName(rejectFor.r.employeeId)}
          requireReason={rejectFor.type === 'go'}
          onConfirm={onReject}
          onClose={() => setRejectFor(null)}
        />
      )}
    </section>
  );
}
