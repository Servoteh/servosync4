'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import {
  useRequests,
  useKadrMe,
  useDirectory,
  usePaidLeaveApprove,
  usePaidLeaveReject,
  usePaidLeaveDelete,
  newClientEventId,
  type PaidLeaveRequest,
  type TxResponse,
} from '@/api/kadrovska';
import { SummaryChips } from '../common';
import { PAID_LEAVE_LABEL, normEmp, type EmpRow } from './shared';
import { NoticeBar, ReasonDialog, useNotice } from './requests-common';

// ============================================================================
// Plaćeno odsustvo — inbox zahteva (port 1.0 paidLeaveTab.js, pravilnik čl. 13–16).
// Tok: pending → sef_approved → approved (RPC paid_leave_approve pri finalizaciji
// upisuje absences type='placeno'); reject sa obaveznim razlogom; brisanje
// approved/rejected (za approved RPC čisti i absences i 'pl' kodove iz grida).
// ⚠️ TODO(P1a): BE approve/reject ne zovu kadr_queue_paidleave_notification (mejl).
// ============================================================================

const STATUS_META: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'warn', label: 'Na čekanju' },
  sef_approved: { tone: 'info', label: 'Odobrio šef (čeka HR)' },
  approved: { tone: 'success', label: 'Odobreno' },
  rejected: { tone: 'danger', label: 'Odbijeno' },
};

const selectCls =
  'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

function rpcData(res: unknown): Record<string, unknown> {
  return ((res as TxResponse<Record<string, unknown>> | undefined)?.data ?? {}) as Record<string, unknown>;
}
function s(r: PaidLeaveRequest, key: string): string {
  const v = r[key];
  return v == null ? '' : String(v);
}

export function PlacenoTab() {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE);

  const meQ = useKadrMe();
  const me = meQ.data?.data;
  const isAdmin = !!me?.isAdmin;
  const isHr = !!me?.isHrOrAdmin;
  const isManagement = !!me?.isManagement;

  const [statusF, setStatusF] = useState('pending');
  const [q, setQ] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [rejectFor, setRejectFor] = useState<PaidLeaveRequest | null>(null);
  const { notice, show } = useNotice();

  const reqQ = useRequests({}, canManage);
  const dirQ = useDirectory();
  const approve = usePaidLeaveApprove();
  const reject = usePaidLeaveReject();
  const del = usePaidLeaveDelete();

  const emps: Map<string, EmpRow> = useMemo(() => {
    const m = new Map<string, EmpRow>();
    for (const r of (dirQ.data?.data ?? []).map(normEmp)) m.set(r.id, r);
    return m;
  }, [dirQ.data]);
  const empName = (id: string) => emps.get(id)?.name || id.slice(0, 8);

  // Row-scope: RLS/BE presuđuje; FE filtrira po managedSubDeptIds kad postoji sub_department_id.
  const items = useMemo(() => {
    const all = reqQ.data?.data?.paidLeave ?? [];
    const managed = me?.managedSubDeptIds;
    if (!managed || managed.length === 0 || isAdmin || isHr) return all;
    const set = new Set(managed);
    return all.filter((r) => {
      const sd = emps.get(r.employeeId)?.subDepartmentId;
      return sd == null ? true : set.has(sd);
    });
  }, [reqQ.data, me, isAdmin, isHr, emps]);

  const filtered = useMemo(() => {
    const lq = q.trim().toLowerCase();
    return items.filter((r) => {
      if (statusF && r.status !== statusF) return false;
      if (lq) {
        const hay = `${empName(r.employeeId)} ${r.submittedBy || ''}`.toLowerCase();
        if (!hay.includes(lq)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, statusF, q, emps]);

  const counts = useMemo(() => {
    const c = { pending: 0, sef: 0, approved: 0, rejected: 0 };
    for (const r of items) {
      if (r.status === 'pending') c.pending++;
      else if (r.status === 'sef_approved') c.sef++;
      else if (r.status === 'approved') c.approved++;
      else if (r.status === 'rejected') c.rejected++;
    }
    return c;
  }, [items]);

  function setBusy(id: string, b: boolean) {
    setBusyIds((prev) => {
      const n = new Set(prev);
      if (b) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  async function doApprove(r: PaidLeaveRequest) {
    if (busyIds.has(r.id)) return;
    const isFinalize = r.status === 'sef_approved';
    const who = empName(r.employeeId);
    const ctx = `${PAID_LEAVE_LABEL[r.leaveType] || r.leaveType}, ${formatDate(r.dateFrom)} – ${formatDate(r.dateTo)}`;
    const body = isFinalize
      ? `Finalizovati (HR) plaćeno odsustvo zaposlenog ${who} (${ctx})? Kreira se evidencija odsustva.`
      : isAdmin
        ? `Odobriti direktno plaćeno odsustvo zaposlenog ${who} (${ctx})? Kreira se evidencija odsustva.`
        : `Odobriti kao šef (1. nivo) plaćeno odsustvo zaposlenog ${who} (${ctx})? Prosleđuje se HR-u.`;
    if (!window.confirm(body)) return;

    setBusy(r.id, true);
    try {
      const res = await approve.mutateAsync({ id: r.id, clientEventId: newClientEventId() });
      const status = String(rpcData(res).status ?? '');
      if (status === 'already_processed') {
        show('ok', 'Već obrađeno — osvežavam');
        return;
      }
      if (status === 'dual_control') {
        show('warn', 'Isti korisnik ne može 1. i 2. nivo — finalizuje druga osoba (HR/uprava)');
        return;
      }
      if (status === 'sef_approved') {
        show('ok', 'Odobreno (1. nivo) — prosleđeno HR-u');
        return;
      }
      if (status !== 'approved') {
        show('warn', `Neočekivan status: ${status || '—'}`);
        return;
      }
      show('ok', 'Plaćeno odsustvo odobreno — evidencija dodata');
    } catch (e) {
      const ae = e as ApiError;
      const msg = String(ae?.message || '').toLowerCase();
      if (msg.includes('23p01') || msg.includes('overlap') || msg.includes('preklap') || ae?.status === 409)
        show('warn', 'Period se preklapa sa drugim odsustvom ovog zaposlenog.');
      else if (ae?.status === 403) show('warn', 'Nemate dozvolu za ovu akciju');
      else show('warn', 'Greška pri odobravanju');
    } finally {
      setBusy(r.id, false);
    }
  }

  async function doReject(r: PaidLeaveRequest, note: string) {
    try {
      const res = await reject.mutateAsync({ id: r.id, note });
      const status = String(rpcData(res).status ?? '');
      show('ok', status === 'already_processed' ? 'Već obrađeno' : 'Zahtev odbijen');
      setRejectFor(null);
    } catch {
      show('warn', 'Greška pri odbijanju');
    }
  }

  async function doDelete(r: PaidLeaveRequest) {
    const wasApproved = r.status === 'approved';
    const body = wasApproved
      ? 'Obrisati ovo odobreno plaćeno odsustvo? Povlače se i evidencija odsustva i kod „pl" iz mesečnog grida za te dane. Trajno.'
      : 'Obrisati ovaj zahtev za plaćeno odsustvo? Trajno.';
    if (!window.confirm(body)) return;
    try {
      await del.mutateAsync({ id: r.id });
      show('ok', wasApproved ? 'Obrisano — grid i evidencija očišćeni' : 'Obrisano');
    } catch (e) {
      show('warn', (e as ApiError)?.status === 403 ? 'Nemate dozvolu za brisanje' : 'Brisanje nije uspelo');
    }
  }

  const cols: Column<PaidLeaveRequest>[] = [
    {
      key: 'emp',
      header: 'Zaposleni',
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{empName(r.employeeId)}</div>
          {r.submittedBy && <div className="text-2xs text-ink-secondary">{r.submittedBy}</div>}
        </div>
      ),
    },
    { key: 'basis', header: 'Osnov', render: (r) => PAID_LEAVE_LABEL[r.leaveType] || r.leaveType },
    { key: 'from', header: 'Od', render: (r) => (r.dateFrom ? formatDate(r.dateFrom) : '—') },
    { key: 'to', header: 'Do', render: (r) => (r.dateTo ? formatDate(r.dateTo) : '—') },
    { key: 'days', header: 'Dana', align: 'right', numeric: true, render: (r) => r.daysCount },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const meta = STATUS_META[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        return <StatusBadge tone={meta.tone} label={meta.label} />;
      },
    },
    {
      key: 'detail',
      header: 'Dokaz / obrazloženje',
      render: (r) => (
        <div className="max-w-60 text-xs text-ink-secondary">
          {[s(r, 'proofNote'), r.reason].filter(Boolean).join(' · ') || '—'}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const busy = busyIds.has(r.id);
        const showDelete = canManage && ['approved', 'rejected'].includes(r.status) && !isManagement;
        if (!canManage) return <span className="text-xs text-ink-secondary">—</span>;
        return (
          <div className="flex flex-wrap justify-end gap-1.5">
            {r.status === 'pending' && (
              <>
                <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doApprove(r)} title={isAdmin ? 'Odobri direktno' : 'Odobri kao šef (1. nivo)'}>
                  ✔ {isAdmin ? 'Odobri' : 'Odobri (šef)'}
                </Button>
                <Button variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setRejectFor(r)}>
                  ✘ Odbij
                </Button>
              </>
            )}
            {r.status === 'sef_approved' && (
              <>
                {isHr && (
                  <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doApprove(r)} title="Finalizuj (HR/uprava)">
                    ✔ Finalizuj (HR)
                  </Button>
                )}
                <Button variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setRejectFor(r)}>
                  ✘ Odbij
                </Button>
              </>
            )}
            {showDelete && (
              <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doDelete(r)}>
                Obriši
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  if (!canManage) {
    return (
      <p className="text-sm text-ink-secondary">
        Zahtevi za plaćeno odsustvo vidljivi su rukovodiocima sa pravom upravljanja zahtevima (kadrovska.vacreq_manage).
        Podnošenje je u modulu „Moj profil".
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <NoticeBar notice={notice} />
      <SummaryChips
        items={[
          { label: 'Na čekanju', value: counts.pending, tone: counts.pending ? 'warn' : 'default' },
          { label: 'Čeka HR', value: counts.sef, tone: counts.sef ? 'warn' : 'default' },
          { label: 'Odobreno', value: counts.approved },
          { label: 'Odbijeno', value: counts.rejected },
          { label: 'Ukupno', value: items.length },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="">Svi statusi</option>
          <option value="pending">Na čekanju</option>
          <option value="sef_approved">Odobrio šef (čeka HR)</option>
          <option value="approved">Odobreni</option>
          <option value="rejected">Odbijeni</option>
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga po imenu…" />
        <span className="ml-auto text-sm text-ink-secondary">
          {filtered.length === items.length ? `${items.length} zahteva` : `${filtered.length} / ${items.length} zahteva`}
        </span>
      </div>

      <DataTable
        columns={cols}
        rows={filtered}
        rowKey={(r) => r.id}
        loading={reqQ.isLoading}
        empty={<EmptyState title="Nema zahteva" hint={'Zaposleni podnose zahteve iz modula „Moj profil".'} />}
      />

      {rejectFor && (
        <ReasonDialog
          title="Odbij plaćeno odsustvo"
          subtitle={`${empName(rejectFor.employeeId)} — ${PAID_LEAVE_LABEL[rejectFor.leaveType] || rejectFor.leaveType}`}
          confirmLabel="Odbij"
          requireNote
          onConfirm={(note) => doReject(rejectFor, note)}
          onClose={() => setRejectFor(null)}
        />
      )}
    </div>
  );
}
