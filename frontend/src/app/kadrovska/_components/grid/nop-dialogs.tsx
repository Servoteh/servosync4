'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { fmtYmd } from '@/lib/grid-audit';
import { newClientEventId, useRequests, useNopApprove, useNopReject, useSubmitNop } from '@/api/kadrovska';

/** Neplaćeno (nop) — admin lista predloga + Odobri/Odbij. Port _openNopApprovalsModal. */
export function NopApprovalsDialog({
  open,
  monthLabel,
  nameById,
  canDecide,
  onClose,
}: {
  open: boolean;
  monthLabel: string;
  nameById: (empId: string) => string;
  canDecide: boolean;
  onClose: () => void;
}) {
  const q = useRequests({ source: 'nop', status: 'pending' }, open);
  const approve = useNopApprove();
  const reject = useNopReject();
  const rows = q.data?.data.nop ?? [];

  return (
    <Dialog open={open} onClose={onClose} title={`✍ Neplaćeno — predlozi (${monthLabel})`}>
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema predloga na čekanju.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-control border border-line-soft px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{nameById(r.employeeId)}</span>
                <span className="text-2xs tabular-nums text-ink-secondary">{fmtYmd(r.workDate)}</span>
              </div>
              {r.reason && <p className="mt-1 text-sm text-ink">{r.reason}</p>}
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-2xs text-ink-disabled">Predložio: {r.requestedBy || '—'}</span>
                {canDecide && (
                  <div className="flex gap-2">
                    <Button variant="secondary" className="h-7 px-2 text-xs" loading={approve.isPending} onClick={() => approve.mutate({ id: r.id, clientEventId: newClientEventId() })}>
                      ✔ Odobri
                    </Button>
                    <Button variant="danger" className="h-7 px-2 text-xs" loading={reject.isPending} onClick={() => reject.mutate({ id: r.id })}>
                      ✘ Odbij
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Non-admin unos „nop" → predlog upravi. Port requestNop. */
export function NopRequestDialog({
  open,
  employeeName,
  ymd,
  employeeId,
  onDone,
  onClose,
}: {
  open: boolean;
  employeeName: string;
  ymd: string;
  employeeId: string;
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const submit = useSubmitNop();

  function send() {
    submit.mutate(
      { clientEventId: newClientEventId(), employeeId, workDate: ymd, reason: reason.trim() || undefined },
      {
        onSuccess: (res) => {
          onDone(res.data?.deduped ? 'Predlog za ovaj dan već postoji na čekanju.' : '📨 Predlog za neplaćeno poslat upravi na odobrenje.');
          setReason('');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Predlog za neplaćeno odsustvo"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="primary" loading={submit.isPending} onClick={send}>
            Pošalji predlog
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p className="text-sm text-ink">
          {employeeName} · <span className="tabular-nums">{fmtYmd(ymd)}</span>
        </p>
        <p className="text-xs text-ink-secondary">Neplaćeno odsustvo mora odobriti uprava. Predlog se ne upisuje u grid dok ne bude odobren.</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Razlog (opciono)…" rows={3} />
      </div>
    </Dialog>
  );
}
