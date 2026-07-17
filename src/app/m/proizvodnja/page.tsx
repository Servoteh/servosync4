'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useMachines,
  useMachineOperationsAccum,
  useUpsertOverlay,
  type OpRow,
} from '@/api/plan-proizvodnje';
import { StatusPill, nextStatus, progressLabel } from '../../plan-proizvodnje/_components/shared';

/** Mobilni Plan proizvodnje (/m/proizvodnja) — operater bira mašinu → red operacija + status/SPREMNO/napomena smene. */
export default function MobileProizvodnjaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [machine, setMachine] = useState('');
  const machines = useMachines();
  const ops = useMachineOperationsAccum(machine || null);
  const overlay = useUpsertOverlay();
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const [noteFor, setNoteFor] = useState<OpRow | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const rows = ops.rows;

  function cycle(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate(
      { workOrderId: o.work_order_id, lineId: o.line_id, localStatus: nextStatus(o.local_status) },
      { onSuccess: () => toast('✅ Sačuvano'), onError: () => toast('⚠ Nije sačuvano') },
    );
  }
  function toggleReady(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate(
      { workOrderId: o.work_order_id, lineId: o.line_id, readyOverride: !o.ready_override },
      { onSuccess: () => toast('✅ Sačuvano'), onError: () => toast('⚠ Nije sačuvano') },
    );
  }

  return (
    <main className="min-h-screen bg-app p-3">
      <h1 className="mb-3 text-md font-semibold text-ink">Proizvodnja</h1>
      <select
        value={machine}
        onChange={(e) => setMachine(e.target.value)}
        className="mb-3 h-10 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
      >
        <option value="">— izaberi mašinu —</option>
        {(machines.data?.data ?? []).map((m) => (
          <option key={m.rj_code} value={m.rj_code}>
            {m.rj_code}
            {m.naziv || m.name ? ` — ${m.naziv ?? m.name}` : ''}
          </option>
        ))}
      </select>

      {!machine ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Izaberi mašinu.</p>
      ) : ops.isError ? (
        <div className="py-8 text-center text-sm text-status-danger">
          Učitavanje nije uspelo.{' '}
          <button onClick={() => ops.refetch()} className="underline">↻ Pokušaj ponovo</button>
        </div>
      ) : ops.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema otvorenih operacija.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((o) => {
            const hasNote = !!String(o.shift_note ?? '').trim();
            return (
              <div key={`${o.work_order_id}:${o.line_id}`} className="rounded-panel border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{o.broj_crteza ?? '—'}</span>
                  <StatusPill status={o.local_status} onClick={() => cycle(o)} disabled={!canEdit} />
                </div>
                <div className="mt-0.5 text-xs text-ink-secondary">
                  {o.naziv_dela ?? ''} · RN {o.rn_ident_broj ?? '—'} · op {String(o.operacija ?? '')}
                  {o.opis_rada ? ` — ${o.opis_rada}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-disabled">
                  <span>Kom {progressLabel(o)}</span>
                  <span>Rok {formatDate(o.rok_izrade)}</span>
                  {/* Indikatori vidljivi SVIMA (paritet 1.0): ✋ ručno spremno + 📝 napomena. */}
                  {o.ready_override && <span title="Ručno označeno spremno">✋</span>}
                  {hasNote && <span title="Napomena smene">📝</span>}
                  {canEdit && (
                    <>
                      <label className="ml-auto flex items-center gap-1.5 text-ink">
                        <input type="checkbox" checked={!!o.ready_override} onChange={() => toggleReady(o)} /> SPREMNO
                      </label>
                      <button onClick={() => setNoteFor(o)} className="rounded-control border border-line px-2 py-1 text-ink-secondary">
                        📝 Napomena
                      </button>
                    </>
                  )}
                </div>
                {hasNote && !canEdit && <div className="mt-1 text-xs text-ink-secondary">📝 {o.shift_note}</div>}
              </div>
            );
          })}

          {/* Tiho odsecanje na 100 → eksplicitna poruka (SH-06). */}
          {ops.hasMore && (
            <p className="py-2 text-center text-2xs text-ink-disabled">
              Prikazano prvih {rows.length} — ima još (pun spisak na računaru).
            </p>
          )}
        </div>
      )}

      {noteFor && (
        <ShiftNoteSheet
          op={noteFor}
          onClose={() => setNoteFor(null)}
          onSave={(note) => {
            overlay.mutate(
              { workOrderId: noteFor.work_order_id, lineId: noteFor.line_id, shiftNote: note },
              { onSuccess: () => toast('✅ Sačuvano'), onError: () => toast('⚠ Nije sačuvano') },
            );
            setNoteFor(null);
          }}
        />
      )}
    </main>
  );
}

/** Bottom-sheet za napomenu smene (SH-05) — mobilni unos shift_note. */
function ShiftNoteSheet({ op, onClose, onSave }: { op: OpRow; onClose: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState(op.shift_note ?? '');
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" role="dialog" aria-modal onClick={onClose}>
      <div className="w-full rounded-t-panel bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-semibold text-ink">📝 Napomena smene</div>
        <div className="mb-2 text-xs text-ink-secondary">{op.broj_crteza ?? '—'} · op {String(op.operacija ?? '')}</div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="beleška o operaciji…"
          className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-control border border-line px-3 py-2 text-sm text-ink-secondary">Otkaži</button>
          <button onClick={() => onSave(note)} className="rounded-control bg-accent px-3 py-2 text-sm font-medium text-accent-fg">Sačuvaj</button>
        </div>
      </div>
    </div>
  );
}
