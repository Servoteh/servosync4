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
  useMakeupApprove,
  useMakeupReject,
  useMakeupComplete,
  useMakeupStorno,
  useMakeupDelete,
  useGrantBonusGo,
  newClientEventId,
  type MakeupRequest,
  type TxResponse,
} from '@/api/kadrovska';

/** RPC odgovori prolaze kroz BE kao TxResponse<jsonb> — čitamo defanzivno. */
function rpcData(res: unknown): Record<string, unknown> {
  return ((res as TxResponse<Record<string, unknown>> | undefined)?.data ?? {}) as Record<string, unknown>;
}
import { SummaryChips } from '../common';
import { compareByName, normEmp, type EmpRow } from './shared';
import { NoticeBar, ReasonDialog, useNotice } from './requests-common';

// ============================================================================
// Nadoknada sati — inbox zahteva (port 1.0 makeupTab.js, pravilnik čl. 19–21).
// Tok: pending → sef_approved → approved → completed; reject iz pending/
// sef_approved; storno iz approved/completed (dan_odmora vraća −1 dan GO).
// Dvostepenost + dual_control presuđuje RPC makeup_approve na sy15 (BE proxy).
// „Dan odmora": posle FINALNOG odobrenja FE zove POST /vacation/bonus (+1 dan
// GO, dedup already_granted). ⚠️ TODO(P1a): BE approve/reject NE zovu
// kadr_queue_makeup_notification — mejl zaposlenom izostaje dok BE ne doda.
// ============================================================================

const STATUS_META: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: 'warn', label: 'Na čekanju' },
  sef_approved: { tone: 'info', label: 'Odobrio šef (čeka HR)' },
  approved: { tone: 'success', label: 'Odobreno (čeka nadoknadu)' },
  completed: { tone: 'success', label: 'Nadoknađeno' },
  rejected: { tone: 'danger', label: 'Odbijeno' },
  storniran: { tone: 'neutral', label: 'Stornirano' },
};

const selectCls =
  'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

function s(r: MakeupRequest, key: string): string {
  const v = r[key];
  return v == null ? '' : String(v);
}

export function NadoknadaTab() {
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
  const [rejectFor, setRejectFor] = useState<MakeupRequest | null>(null);
  const [stornoFor, setStornoFor] = useState<MakeupRequest | null>(null);
  const { notice, show } = useNotice();

  const reqQ = useRequests({}, canManage);
  const dirQ = useDirectory();
  const approve = useMakeupApprove();
  const reject = useMakeupReject();
  const complete = useMakeupComplete();
  const storno = useMakeupStorno();
  const del = useMakeupDelete();
  const grantBonus = useGrantBonusGo();

  const emps: Map<string, EmpRow> = useMemo(() => {
    const m = new Map<string, EmpRow>();
    for (const r of (dirQ.data?.data ?? []).map(normEmp)) m.set(r.id, r);
    return m;
  }, [dirQ.data]);
  const empName = (id: string) => emps.get(id)?.name || id.slice(0, 8);

  // Row-scope: BE/RLS presuđuje (šef dobija samo svoje kroz GET /requests);
  // FE dodatno filtrira po managedSubDeptIds kad directory izlaže sub_department_id.
  const items = useMemo(() => {
    const all = reqQ.data?.data?.makeup ?? [];
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
    const c = { pending: 0, sef: 0, approved: 0, completed: 0 };
    for (const r of items) {
      if (r.status === 'pending') c.pending++;
      else if (r.status === 'sef_approved') c.sef++;
      else if (r.status === 'approved') c.approved++;
      else if (r.status === 'completed') c.completed++;
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

  async function grantBonusGo(r: MakeupRequest) {
    try {
      await grantBonus.mutateAsync({
        clientEventId: newClientEventId(),
        employeeId: r.employeeId,
        workDate: s(r, 'weekendWorkDate') || r.absenceDate,
        days: 1,
        reason: r.reason || 'Rad vikendom',
        makeupRequestId: r.id,
      });
      show('ok', '🏖 +1 dan GO dodat u saldo');
    } catch (e) {
      const msg = String((e as ApiError)?.message || '');
      if (msg.includes('already_granted')) show('ok', 'Dan je već dodat u saldo');
      else show('warn', 'Zahtev je odobren, ali +1 dan GO nije upisan — dodajte ručno.');
    }
  }

  async function doApprove(r: MakeupRequest) {
    if (busyIds.has(r.id)) return;
    const isFinalize = r.status === 'sef_approved';
    const danOdmora = s(r, 'compensationType') === 'dan_odmora';
    const who = empName(r.employeeId);
    const ctx = danOdmora
      ? `rad vikendom ${formatDate(s(r, 'weekendWorkDate') || r.absenceDate)} (${r.absenceHours}h)`
      : `${formatDate(r.absenceDate)} (${r.absenceHours}h)`;
    const sta = danOdmora ? 'dan odmora (+1 dan GO)' : 'nadoknadu sati';
    const body = isFinalize
      ? `Finalizovati (HR) ${sta} zaposlenog ${who} za ${ctx}?${danOdmora ? ' Zaposlenom se dodaje +1 dan godišnjeg odmora u saldo.' : ''}`
      : isAdmin
        ? `Odobriti direktno ${sta} zaposlenog ${who} za ${ctx}?${danOdmora ? ' Zaposlenom se dodaje +1 dan godišnjeg odmora u saldo.' : ''}`
        : `Odobriti kao šef (1. nivo) ${sta} zaposlenog ${who} za ${ctx}? Prosleđuje se HR-u.`;
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
      show('ok', danOdmora ? 'Odobreno' : 'Nadoknada odobrena — radnik treba da nadoknadi do roka');
      // FINALNO odobrenje 'dan_odmora' → +1 dan GO (dedup u RPC-u)
      if (danOdmora) await grantBonusGo(r);
    } catch (e) {
      const ae = e as ApiError;
      show('warn', ae?.status === 403 ? 'Nemate dozvolu za ovu akciju' : 'Greška pri odobravanju');
    } finally {
      setBusy(r.id, false);
    }
  }

  async function doComplete(r: MakeupRequest) {
    if (busyIds.has(r.id)) return;
    if (
      !window.confirm(
        `Potvrditi da je ${empName(r.employeeId)} nadoknadio/la sate (${r.absenceHours}h za ${formatDate(r.absenceDate)})? Stavka se zatvara.`,
      )
    )
      return;
    setBusy(r.id, true);
    try {
      const res = await complete.mutateAsync({ id: r.id, clientEventId: newClientEventId() });
      const status = String(rpcData(res).status ?? '');
      show('ok', status === 'already_processed' ? 'Već obrađeno — osvežavam' : 'Nadoknada zabeležena kao izvršena');
    } catch {
      show('warn', 'Greška pri zatvaranju stavke');
    } finally {
      setBusy(r.id, false);
    }
  }

  async function doReject(r: MakeupRequest, note: string) {
    try {
      const res = await reject.mutateAsync({ id: r.id, note });
      const status = String(rpcData(res).status ?? '');
      show('ok', status === 'already_processed' ? 'Već obrađeno' : 'Zahtev odbijen');
      setRejectFor(null);
    } catch {
      show('warn', 'Greška pri odbijanju');
    }
  }

  async function doStorno(r: MakeupRequest, note: string) {
    try {
      const res = await storno.mutateAsync({ id: r.id, note });
      show('ok', Number(rpcData(res).reversed_days ?? 0) > 0 ? 'Stornirano — −1 dan GO vraćen iz salda' : 'Stornirano');
      setStornoFor(null);
    } catch (e) {
      const msg = String((e as ApiError)?.message || '');
      if (msg.includes('not_approved')) show('warn', 'Storno je moguć samo za odobren/nadoknađen zahtev.');
      else if (msg.includes('not_allowed') || (e as ApiError)?.status === 403) show('warn', 'Nemate dozvolu za storno.');
      else show('warn', 'Greška pri storniranju.');
    }
  }

  async function doDelete(r: MakeupRequest) {
    if (!window.confirm('Obrisati ovaj zahtev za nadoknadu? Trajno.')) return;
    try {
      await del.mutateAsync({ id: r.id });
      show('ok', 'Obrisano');
    } catch (e) {
      const ae = e as ApiError;
      const msg = String(ae?.message || '');
      if (msg.includes('must_storno_first'))
        show('warn', 'Odobren/nadoknađen zahtev se ne briše direktno — prvo Storniraj, pa obriši');
      else if (ae?.status === 403) show('warn', 'Nemate dozvolu za brisanje');
      else show('warn', 'Brisanje nije uspelo');
    }
  }

  const cols: Column<MakeupRequest>[] = [
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
    { key: 'dept', header: 'Odeljenje', render: (r) => emps.get(r.employeeId)?.department || '—' },
    { key: 'absDate', header: 'Izostanak', render: (r) => (r.absenceDate ? formatDate(r.absenceDate) : '—') },
    { key: 'hours', header: 'Sati', align: 'right', numeric: true, render: (r) => `${Number(r.absenceHours || 0)}h` },
    {
      key: 'deadline',
      header: 'Rok',
      render: (r) =>
        s(r, 'compensationType') === 'dan_odmora' ? '—' : r.makeupDeadline ? formatDate(r.makeupDeadline) : '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const danOdmora = s(r, 'compensationType') === 'dan_odmora';
        const meta = STATUS_META[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        const label =
          danOdmora && (r.status === 'approved' || r.status === 'completed') ? 'Odobreno (+1 dan GO)' : meta.label;
        return <StatusBadge tone={meta.tone} label={label} />;
      },
    },
    {
      key: 'detail',
      header: 'Razlog / plan',
      render: (r) => {
        const danOdmora = s(r, 'compensationType') === 'dan_odmora';
        const parts = [
          r.reason,
          danOdmora ? '' : r.makeupPlan,
          r.status === 'storniran' && s(r, 'stornoNote') ? `storno: ${s(r, 'stornoNote')}` : '',
        ].filter(Boolean);
        return (
          <div className="max-w-60 text-xs text-ink-secondary">
            {danOdmora && (
              <span className="mr-1 inline-flex rounded-full bg-status-success-bg px-2 py-0.5 text-2xs font-medium text-status-success">
                🏖 Dan odmora (rad vikendom {formatDate(s(r, 'weekendWorkDate') || r.absenceDate)})
              </span>
            )}
            {parts.join(' · ') || '—'}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        const danOdmora = s(r, 'compensationType') === 'dan_odmora';
        const busy = busyIds.has(r.id);
        const showStorno = canManage && ['approved', 'completed'].includes(r.status);
        const showDelete = isHr && ['pending', 'sef_approved', 'rejected', 'storniran'].includes(r.status) && !isManagement;
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
            {r.status === 'approved' && !danOdmora && (
              <Button variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doComplete(r)} title="Nadoknada izvršena — zatvori stavku">
                ✔ Završeno
              </Button>
            )}
            {showStorno && (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={() => setStornoFor(r)}
                title={`Poništi odobrenje${danOdmora ? ' — vraća −1 dan GO iz salda' : ''}`}
              >
                ↩ Storniraj
              </Button>
            )}
            {showDelete && (
              <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => doDelete(r)} title="Trajno obriši zahtev">
                🗑
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
        Zahtevi za nadoknadu sati vidljivi su rukovodiocima sa pravom upravljanja zahtevima (kadrovska.vacreq_manage).
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
          { label: 'Za nadoknadu', value: counts.approved, tone: counts.approved ? 'accent' : 'default' },
          { label: 'Nadoknađeno', value: counts.completed },
          { label: 'Ukupno', value: items.length },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="">Svi statusi</option>
          <option value="pending">Na čekanju</option>
          <option value="sef_approved">Odobrio šef (čeka HR)</option>
          <option value="approved">Odobreno (čeka nadoknadu)</option>
          <option value="completed">Nadoknađeno</option>
          <option value="rejected">Odbijeno</option>
          <option value="storniran">Stornirano</option>
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
          title="Odbij zahtev za nadoknadu"
          subtitle={`${empName(rejectFor.employeeId)} — ${formatDate(rejectFor.absenceDate)} (${rejectFor.absenceHours}h)`}
          confirmLabel="Odbij"
          requireNote
          onConfirm={(note) => doReject(rejectFor, note)}
          onClose={() => setRejectFor(null)}
        />
      )}
      {stornoFor && (
        <ReasonDialog
          title="↩ Storno zahteva za nadoknadu"
          subtitle={`${empName(stornoFor.employeeId)} — ${formatDate(stornoFor.absenceDate)} (${stornoFor.absenceHours}h)${
            s(stornoFor, 'compensationType') === 'dan_odmora' ? ' · dan odmora: skida se +1 dan GO iz salda' : ''
          }`}
          confirmLabel="↩ Storniraj"
          requireNote={false}
          onConfirm={(note) => doStorno(stornoFor, note)}
          onClose={() => setStornoFor(null)}
        />
      )}
    </div>
  );
}
