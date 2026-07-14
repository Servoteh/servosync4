'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useVacation,
  useSubmitVacation,
  useReviseVacation,
  useCancelVacation,
  useDeleteVacation,
  type VacationRequest,
} from '@/api/moj-profil';
import { Section, statusLabel, statusTone } from './section';

const MIN_DATE = '2026-05-01';

/** Radni dani (Pon–Pet) uključivo — informativno; praznici se ne oduzimaju na FE (server je autoritet). */
function workDays(from: string, to: string): number {
  const s = new Date(from);
  const e = new Date(to);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  let n = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function VacationSection() {
  const q = useVacation();
  const data = q.data?.data;
  const [modal, setModal] = useState<{ mode: 'new' | 'edit'; req?: VacationRequest } | null>(null);
  const cancelM = useCancelVacation();
  const deleteM = useDeleteVacation();

  const balance = data?.balance;
  const requests = data?.requests ?? [];
  const remaining = balance ? (balance.days_remaining ?? null) : null;

  return (
    <Section
      icon="🏖"
      title="Godišnji odmor"
      defaultOpen
      actions={
        <Button onClick={() => setModal({ mode: 'new' })} className="h-8">
          + Podnesi zahtev
        </Button>
      }
    >
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : (
        <>
          {/* Saldo */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Ukupno (pravo do danas)" value={balance ? num(balance.days_earned ?? balance.days_total) + num(balance.days_carried_over) : '—'} hint="zarađeno + preneto" />
            <StatCard label="Iskorišćeno" value={balance ? num(balance.days_used) : '—'} />
            <StatCard label="Preostalo" value={remaining ?? '—'} tone={remaining != null && num(remaining) <= 3 ? 'warn' : 'ok'} />
          </div>

          {/* Zahtevi */}
          <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Moji zahtevi</h3>
          {requests.length === 0 ? (
            <p className="text-sm text-ink-disabled">Još nema podnetih zahteva za godišnji odmor.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                    <th className="py-1.5">Od</th>
                    <th className="py-1.5">Do</th>
                    <th className="py-1.5">Dana</th>
                    <th className="py-1.5">Status</th>
                    <th className="py-1.5">Napomena</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const editable = ['pending', 'sef_approved', 'approved'].includes(r.status);
                    return (
                      <tr key={r.id} className="border-b border-line-soft">
                        <td className="py-1.5 tnums">{formatDate(r.date_from)}</td>
                        <td className="py-1.5 tnums">{formatDate(r.date_to)}</td>
                        <td className="py-1.5 tnums">{r.days_count}</td>
                        <td className="py-1.5">
                          <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />
                        </td>
                        <td className="py-1.5 text-ink-secondary">{r.note || '—'}</td>
                        <td className="py-1.5">
                          <div className="flex justify-end gap-1 text-xs">
                            {editable && (
                              <>
                                <button onClick={() => setModal({ mode: 'edit', req: r })} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface-2">
                                  ✎ Izmeni
                                </button>
                                <button
                                  onClick={() => confirm('Otkazati zahtev?') && cancelM.mutate({ id: r.id })}
                                  className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface-2"
                                >
                                  ✖ Otkaži
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => confirm('Trajno obrisati zahtev?') && deleteM.mutate({ id: r.id })}
                              className="rounded px-1.5 py-0.5 text-status-danger hover:bg-surface-2"
                            >
                              🗑
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Istorija */}
          {data && data.history.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary">GO istorija (ranije godine)</h3>
              <ul className="text-sm text-ink-secondary">
                {data.history.map((h, i) => (
                  <li key={i} className="tnums">
                    {h.year}: {num(h.days_used ?? h.used)} dana
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {modal && <VacationModal mode={modal.mode} req={modal.req} remaining={remaining} onClose={() => setModal(null)} />}
    </Section>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-control border border-line bg-surface-2 px-3 py-2">
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className={tone === 'warn' ? 'text-xl font-semibold text-status-warn' : 'text-xl font-semibold text-ink'}>{value}</div>
      {hint && <div className="text-2xs text-ink-disabled">{hint}</div>}
    </div>
  );
}

function VacationModal({
  mode,
  req,
  remaining,
  onClose,
}: {
  mode: 'new' | 'edit';
  req?: VacationRequest;
  remaining: number | null;
  onClose: () => void;
}) {
  const [dateFrom, setDateFrom] = useState(req?.date_from?.slice(0, 10) ?? '');
  const [dateTo, setDateTo] = useState(req?.date_to?.slice(0, 10) ?? '');
  const [note, setNote] = useState(req?.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitVacation();
  const reviseM = useReviseVacation();
  const days = dateFrom && dateTo ? workDays(dateFrom, dateTo) : 0;

  async function save() {
    setErr(null);
    if (!dateFrom || !dateTo) return setErr('Izaberi period.');
    if (dateTo < dateFrom) return setErr('„Do" ne može biti pre „Od".');
    if (dateFrom < MIN_DATE) return setErr(`Najraniji dozvoljeni datum je ${formatDate(MIN_DATE)}`);
    try {
      if (mode === 'edit' && req) {
        await reviseM.mutateAsync({ id: req.id, dateFrom, dateTo, daysCount: days, note: note || undefined });
      } else {
        await submitM.mutateAsync({ clientEventId: newClientEventId(), dateFrom, dateTo, daysCount: days, note: note || undefined });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Slanje nije uspelo.');
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Otkaži
      </Button>
      <Button onClick={save} loading={submitM.isPending || reviseM.isPending}>
        {mode === 'edit' ? 'Sačuvaj' : 'Podnesi zahtev'}
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={mode === 'edit' ? 'Izmena zahteva za godišnji' : 'Zahtev za godišnji odmor'} footer={footer}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Od datuma" required>
            <Input type="date" min={MIN_DATE} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </FormField>
          <FormField label="Do datuma" required>
            <Input type="date" min={MIN_DATE} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </FormField>
        </div>
        <p className="text-sm text-ink-secondary">
          Radnih dana: <b className="tnums">{days}</b>
          {remaining != null && <span> · Preostalo GO: {remaining}</span>}
        </p>
        <FormField label="Napomena">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
        </FormField>
      </div>
    </Dialog>
  );
}
