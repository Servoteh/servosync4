'use client';

/**
 * Mobilna „Odobravanja" (/mob/odobravanja) — PLAN_MOB_3.0 Faza 2, talas A
 * (paritet 1.0 mobilnog `/m/odobravanja`). TANAK omotač nad `GET /v1/kadrovska/requests`
 * (`useRequests`) i postojećim odlukama (`useVacationVacreqApprove` / `useVacationReject` /
 * makeup / paid-leave / nop hookovi) — nula nove poslovne logike: dvostepeno odobravanje
 * (1. nivo „šef" → finalno „HR/uprava"), dual-control (isti korisnik ne može oba nivoa),
 * `nop` samo uprava, i „+1 dan GO za rad vikendom" preslikani su sa
 * `app/kadrovska/_components/odmori/odobravanje-tab.tsx`. Server (RPC) je autoritet.
 *
 * Gate: `kadrovska.vacreq_manage` (∨ `vacreq_admin`; uprava dodatno vidi „Neplaćeno").
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, ChevronLeft, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import { RejectModal } from '@/app/kadrovska/_components/odmori/request-modals';
import {
  daysInclusive,
  holidaySetFromRows,
  workDaysInclusive,
} from '@/app/kadrovska/_components/odmori/helpers';
import {
  newClientEventId,
  useRequests,
  useKadrMe,
  useEmployees,
  useHolidays,
  useVacationVacreqApprove,
  useVacationReject,
  useVacationReschedule,
  useVacationRevise,
  useMakeupApprove,
  useMakeupReject,
  usePaidLeaveApprove,
  usePaidLeaveReject,
  useNopApprove,
  useNopReject,
} from '@/api/kadrovska';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

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

const TYPE_ORDER: ReqType[] = ['go', 'makeup', 'paid', 'nop'];
const TYPE_LABEL: Record<ReqType, string> = {
  go: 'Godišnji odmor',
  makeup: 'Nadoknada sati',
  paid: 'Plaćeno odsustvo',
  nop: 'Neplaćeno',
};
const PAID_LEAVE_LABEL: Record<string, string> = {
  vencanje: 'Sklapanje braka', rodjenje_deteta: 'Rođenje deteta', smrt_clana: 'Smrt člana porodice',
  dobrovoljno_davanje_krvi: 'Davanje krvi', selidba: 'Selidba', ispit: 'Polaganje ispita', drugo: 'Drugo',
};
/** Stepen odobravanja → kanonski `StatusBadge` (DS §7), isti tonovi kao desktop. */
const STEP_BADGE: Record<Step, { tone: Tone; label: string }> = {
  sef: { tone: 'warn', label: '1. nivo (šef)' },
  hr: { tone: 'success', label: 'finalno (HR/uprava)' },
  admin: { tone: 'info', label: 'odluka (uprava)' },
};

export default function MobOdobravanjaPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const canVacreq =
    can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE) || can(PERMISSIONS.KADROVSKA_VACREQ_ADMIN);
  const ready = !!user && !permissionsPending && !permissionsError;

  const meQ = useKadrMe();
  const me = meQ.data?.data;
  // Gejt PRE zahteva: bez prava (ili dok dozvole ne stignu) ne ispaljuj /requests.
  const reqQ = useRequests({}, ready && canVacreq);
  const empQ = useEmployees({ pageSize: 1000 });

  const vacApprove = useVacationVacreqApprove();
  const vacReject = useVacationReject();
  const vacReschedule = useVacationReschedule();
  const vacRevise = useVacationRevise();
  const mkApprove = useMakeupApprove();
  const mkReject = useMakeupReject();
  const plApprove = usePaidLeaveApprove();
  const plReject = usePaidLeaveReject();
  const nopApprove = useNopApprove();
  const nopReject = useNopReject();

  const [rejectFor, setRejectFor] = useState<InboxItem | null>(null);
  const [moveFor, setMoveFor] = useState<InboxItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Praznici (za tačan broj radnih dana pri pomeranju) — tek kad se dijalog otvori.
  const holQ = useHolidays(
    { from: `${new Date().getFullYear()}-01-01`, to: `${new Date().getFullYear() + 1}-01-31` },
    !!moveFor,
  );

  const myEmail = (user?.email || '').toLowerCase();
  const empName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of empQ.data?.data ?? []) m.set(e.id, e.full_name);
    return (id: string) => m.get(id) || '—';
  }, [empQ.data]);

  const inbox: InboxItem[] = useMemo(() => {
    const bundle = reqQ.data?.data;
    if (!bundle) return [];
    // Isti stepenik kao desktop: pending → 1. nivo (šef); sef_approved → finalno (HR/
    // uprava, ali NE isti korisnik koji je dao 1. nivo); nop → samo uprava.
    const actionable = (type: ReqType, r: AnyReq): Step | null => {
      if (type === 'nop') return r.status === 'pending' && me?.isAdmin ? 'admin' : null;
      if (!canVacreq) return null;
      if (r.status === 'pending') return 'sef';
      if (r.status === 'sef_approved' && me?.isHrOrAdmin && (r.level1By || '').toLowerCase() !== myEmail) return 'hr';
      return null;
    };
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
  }, [reqQ.data, me, myEmail, canVacreq]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }
  if (!canVacreq && !me?.isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Odobravanje zahteva vide rukovodioci sa pravom upravljanja GO zahtevima
        (potrebno `kadrovska.vacreq_manage`).
      </main>
    );
  }

  function describe(it: InboxItem): string {
    const r = it.r;
    if (it.type === 'go') return `${formatDate(String(r.dateFrom))} – ${formatDate(String(r.dateTo))} · ${r.daysCount || ''} dana`;
    if (it.type === 'makeup') {
      return r.compensationType === 'dan_odmora'
        ? `Rad vikendom ${formatDate(String(r.weekendWorkDate || r.absenceDate))} (${r.absenceHours}h) → +1 dan GO u saldo (kucani sati tog dana se brišu — zamena, ne duplo)`
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
      const data = (res as { data?: { status?: string; requested?: number; remaining?: number; hours_cleared?: number } }).data ?? {};
      const st = data.status;
      if (st === 'dual_control') { toast('⚠ Isti korisnik ne može oba nivoa istog zahteva.'); return; }
      if (st === 'exceeds_balance') { toast(`⚠ GO premašuje saldo (traženo ${data.requested}, preostalo ${data.remaining}).`); return; }
      if (st === 'already_processed') { toast('ℹ Zahtev je već obrađen — lista osvežena'); return; }
      // Rad vikendom (makeup 'dan_odmora'): +1 dan GO upisuje BE ATOMSKI sa
      // odobrenjem (i briše kucane sate tog dana — zamena, ne duplo plaćanje);
      // FE više NE šalje odvojen POST /vacation/bonus — isti tok kao desktop.
      if (it.type === 'makeup' && st === 'approved' && it.r.compensationType === 'dan_odmora') {
        const cleared = Number(data.hours_cleared ?? 0);
        toast(`✅ Odobreno — 🏖 +1 dan GO upisan u saldo${cleared > 0 ? ' · kucani sati tog dana su obrisani' : ''}`);
      } else {
        toast(st === 'sef_approved' ? '✅ Odobreno (1. nivo) — prosleđeno HR-u' : '✅ Odobreno');
      }
    } catch (e) {
      toast(e instanceof ApiError && e.status === 403 ? '⚠ Nemate dozvolu za ovu akciju.' : '⚠ Greška pri odobravanju.');
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
      toast('🚫 Zahtev odbijen');
      return null;
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? 'Nemate dozvolu.' : 'Greška pri odbijanju.';
    }
  }

  /** „Pomeri" — nov termin GO zahteva.
   *  RPC `hr_reschedule_vacation_request` radi SAMO nad odobrenim zahtevom (inače vraća
   *  `not_approved`), a u inboxu su pending/sef_approved → tu ide `revise` (nov termin,
   *  zahtev se vraća na 1. nivo). Grana po statusu ostaje da bi ekran bio tačan i ako
   *  se inbox ikad proširi odobrenim zahtevima. */
  async function onMove(from: string, to: string, days: number): Promise<string | null> {
    if (!moveFor) return null;
    const it = moveFor;
    try {
      const res = it.r.status === 'approved'
        ? await vacReschedule.mutateAsync({ id: it.r.id, dateFrom: from, dateTo: to, daysCount: days, clientEventId: newClientEventId() })
        : await vacRevise.mutateAsync({ id: it.r.id, dateFrom: from, dateTo: to, daysCount: days, clientEventId: newClientEventId() });
      const data = (res as { data?: { status?: string; requested?: number; remaining?: number } }).data ?? {};
      if (data.status === 'exceeds_balance') return `Nije moguće: traženo ${data.requested} radnih dana, dostupno ${data.remaining}.`;
      if (data.status === 'not_found' || data.status === 'not_editable') { toast('ℹ Zahtev se više ne može menjati — lista osvežena'); return null; }
      toast(data.status === 'rescheduled' ? '✅ Termin izmenjen' : '✅ Termin izmenjen — zahtev ide na odobravanje');
      return null;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) return 'Nemate dozvolu za izmenu ovog zahteva.';
        if (e.status === 409) return 'Novi termin se preklapa sa drugim odsustvom.';
      }
      return 'Greška pri izmeni termina.';
    }
  }

  const groups = TYPE_ORDER.map((t) => ({ type: t, items: inbox.filter((i) => i.type === t) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Odobravanja</h1>
          <p className="truncate text-xs text-ink-secondary">
            {inbox.length > 0 ? `${inbox.length} na čekanju` : (user.fullName ?? user.email)}
          </p>
        </div>
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-5 p-4">
        {reqQ.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : reqQ.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Zahtevi nisu učitani (mreža ili dozvola). Osveži stranicu.
          </p>
        ) : inbox.length === 0 ? (
          <EmptyState title="Nema ničega za odobravanje 🎉" hint="Svi zahtevi u tvom opsegu su obrađeni." />
        ) : (
          groups.map((g) => (
            <section key={g.type} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                {TYPE_LABEL[g.type]} · {g.items.length}
              </h2>
              <ul className="space-y-2">
                {g.items.map((it) => {
                  const busy = busyId === it.r.id;
                  const isDanOdmora = it.type === 'makeup' && it.r.compensationType === 'dan_odmora';
                  return (
                    <li key={`${it.type}-${it.r.id}`} className="rounded-panel border border-line bg-surface p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-md font-semibold text-ink">{empName(it.r.employeeId)}</span>
                        <StatusBadge tone={STEP_BADGE[it.step].tone} label={STEP_BADGE[it.step].label} />
                        {isDanOdmora && <StatusBadge tone="success" label="Dan odmora" />}
                      </div>
                      <p className="mt-1 text-sm text-ink-secondary">{describe(it)}</p>
                      {(it.r.note || it.r.reason) && (
                        <p className="mt-1 text-sm text-ink-secondary">{it.r.note || it.r.reason}</p>
                      )}
                      <p className="mt-1 text-xs text-ink-disabled">
                        Podneo/la: {it.r.submittedBy || it.r.requestedBy || '—'}
                        {it.r.createdAt ? ` · ${formatDate(it.r.createdAt)}` : ''}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button className="h-11 flex-1" disabled={busy} onClick={() => void approve(it)}>
                          <Check className="h-4 w-4" aria-hidden /> Odobri
                        </Button>
                        <Button variant="danger" className="h-11 flex-1" disabled={busy} onClick={() => setRejectFor(it)}>
                          <X className="h-4 w-4" aria-hidden /> Odbij
                        </Button>
                        {it.type === 'go' && (
                          <Button variant="secondary" className="h-11 w-full" disabled={busy} onClick={() => setMoveFor(it)}>
                            <CalendarClock className="h-4 w-4" aria-hidden /> Pomeri termin
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </main>

      {rejectFor && (
        <RejectModal
          title={`Odbij zahtev — ${TYPE_LABEL[rejectFor.type]}`}
          subtitle={empName(rejectFor.r.employeeId)}
          requireReason={rejectFor.type === 'go'}
          onConfirm={onReject}
          onClose={() => setRejectFor(null)}
        />
      )}
      {moveFor && (
        <MoveDialog
          employeeName={empName(moveFor.r.employeeId)}
          dateFrom={String(moveFor.r.dateFrom || '').slice(0, 10)}
          dateTo={String(moveFor.r.dateTo || '').slice(0, 10)}
          holidays={holidaySetFromRows(holQ.data?.data)}
          onSubmit={onMove}
          onClose={() => setMoveFor(null)}
        />
      )}
    </div>
  );
}

/** Nov termin GO zahteva iz inboxa (mobilna varijanta desktop „Izmeni termin" modala —
 *  bez izbora režima: zahtev na čekanju uvek ide nazad na odobravanje). */
function MoveDialog({
  employeeName,
  dateFrom,
  dateTo,
  holidays,
  onSubmit,
  onClose,
}: {
  employeeName: string;
  dateFrom: string;
  dateTo: string;
  holidays: Set<string>;
  onSubmit: (from: string, to: string, days: number) => Promise<string | null>;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const days = from && to && to >= from ? workDaysInclusive(from, to, holidays) : 0;
  const cal = from && to && to >= from ? daysInclusive(from, to) : 0;

  async function submit() {
    setError(null);
    if (!from || !to) { setError('Unesi oba datuma.'); return; }
    if (to < from) { setError('Datum „do" ne sme biti pre datuma „od".'); return; }
    if (from === dateFrom && to === dateTo) { onClose(); return; }
    setBusy(true);
    const err = await onSubmit(from, to, days);
    if (err) { setError(err); setBusy(false); return; }
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Pomeri termin godišnjeg"
      footer={
        <>
          <Button variant="secondary" className="h-11" onClick={onClose}>Otkaži</Button>
          <Button className="h-11" onClick={() => void submit()} loading={busy}>Sačuvaj termin</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          {employeeName} — trenutno {formatDate(dateFrom)} do {formatDate(dateTo)}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Novi datum od" required>
            <Input type="date" className="h-11 text-md" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Novi datum do" required>
            <Input type="date" className="h-11 text-md" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </div>
        <p className="text-sm text-ink">
          Radnih dana: <b className="tnums">{days || '—'}</b>
          {cal !== days && cal > 0 && <span className="text-ink-secondary"> ({cal} kal.)</span>}
        </p>
        <p className="text-xs text-ink-secondary">
          Nov termin vraća zahtev na 1. nivo odobravanja.
        </p>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
