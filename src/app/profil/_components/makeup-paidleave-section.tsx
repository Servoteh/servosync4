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
  useMakeupPaidLeave,
  useSubmitMakeup,
  useDeleteMakeup,
  useSubmitPaidLeave,
  useDeletePaidLeave,
} from '@/api/moj-profil';
import { Section, statusLabel, statusTone } from './section';

export function MakeupSection() {
  const q = useMakeupPaidLeave();
  const rows = q.data?.data?.makeup ?? [];
  const [open, setOpen] = useState(false);
  const delM = useDeleteMakeup();

  return (
    <Section
      icon="🕗"
      title="Nadoknada sati"
      actions={
        <Button onClick={() => setOpen(true)} className="h-8">
          + Zatraži nadoknadu
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Još nema zahteva za nadoknadu sati.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Izostanak</th>
              <th className="py-1.5">Sati</th>
              <th className="py-1.5">Rok</th>
              <th className="py-1.5">Status</th>
              <th className="py-1.5">Razlog / plan</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-soft">
                <td className="py-1.5 tnums">{formatDate(r.absence_date)}</td>
                <td className="py-1.5 tnums">{r.absence_hours}h</td>
                <td className="py-1.5 tnums">{r.makeup_deadline ? formatDate(r.makeup_deadline) : '—'}</td>
                <td className="py-1.5">
                  <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />
                </td>
                <td className="py-1.5 text-ink-secondary">{r.reason || r.makeup_plan || '—'}</td>
                <td className="py-1.5 text-right">
                  {['pending', 'sef_approved', 'rejected'].includes(r.status) && (
                    <button onClick={() => confirm('Obrisati zahtev?') && delM.mutate({ id: r.id })} className="text-status-danger hover:underline">
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <MakeupModal onClose={() => setOpen(false)} />}
    </Section>
  );
}

function MakeupModal({ onClose }: { onClose: () => void }) {
  const [compensationType, setCT] = useState<'nadoknada' | 'dan_odmora'>('nadoknada');
  const [absenceDate, setAbsenceDate] = useState('');
  const [weekendWorkDate, setWeekend] = useState('');
  const [absenceHours, setHours] = useState(8);
  const [reason, setReason] = useState('');
  const [makeupPlan, setPlan] = useState('');
  const [makeupDeadline, setDeadline] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitMakeup();

  async function save() {
    setErr(null);
    try {
      await submitM.mutateAsync({
        clientEventId: newClientEventId(),
        absenceDate: compensationType === 'dan_odmora' ? weekendWorkDate || absenceDate : absenceDate,
        absenceHours,
        reason: reason || undefined,
        makeupPlan: makeupPlan || undefined,
        makeupDeadline: makeupDeadline || undefined,
        compensationType,
        weekendWorkDate: compensationType === 'dan_odmora' ? weekendWorkDate || undefined : undefined,
      });
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
      <Button onClick={save} loading={submitM.isPending}>
        Pošalji zahtev
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title="Zahtev za nadoknadu sati" footer={footer}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <FormField label="Vrsta zahteva">
          <select value={compensationType} onChange={(e) => setCT(e.target.value as 'nadoknada' | 'dan_odmora')} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink">
            <option value="nadoknada">Nadoknada sati (radim drugi dan)</option>
            <option value="dan_odmora">Dan odmora — radim vikendom (+1 dan GO)</option>
          </select>
        </FormField>
        {compensationType === 'dan_odmora' ? (
          <FormField label="Datum rada vikendom" required>
            <Input type="date" value={weekendWorkDate} onChange={(e) => setWeekend(e.target.value)} />
          </FormField>
        ) : (
          <FormField label="Datum izostanka" required>
            <Input type="date" value={absenceDate} onChange={(e) => setAbsenceDate(e.target.value)} />
          </FormField>
        )}
        <FormField label="Broj sati" hint="0.5–24">
          <Input type="number" min={0.5} max={24} step={0.5} value={absenceHours} onChange={(e) => setHours(Number(e.target.value))} />
        </FormField>
        <FormField label="Razlog">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </FormField>
        {compensationType === 'nadoknada' && (
          <>
            <FormField label="Predlog nadoknade (dani/vreme)">
              <Textarea value={makeupPlan} onChange={(e) => setPlan(e.target.value)} rows={2} maxLength={300} />
            </FormField>
            <FormField label="Rok nadoknade">
              <Input type="date" value={makeupDeadline} onChange={(e) => setDeadline(e.target.value)} />
            </FormField>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Plaćeno odsustvo

export function PaidLeaveSection() {
  const q = useMakeupPaidLeave();
  const rows = q.data?.data?.paidLeave ?? [];
  const [open, setOpen] = useState(false);
  const delM = useDeletePaidLeave();

  return (
    <Section
      icon="📝"
      title="Plaćeno odsustvo"
      actions={
        <Button onClick={() => setOpen(true)} className="h-8">
          + Zatraži plaćeno
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Još nema zahteva za plaćeno odsustvo.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Osnov</th>
              <th className="py-1.5">Od</th>
              <th className="py-1.5">Do</th>
              <th className="py-1.5">Dana</th>
              <th className="py-1.5">Status</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-soft">
                <td className="py-1.5">{r.leave_type}</td>
                <td className="py-1.5 tnums">{formatDate(r.date_from)}</td>
                <td className="py-1.5 tnums">{formatDate(r.date_to)}</td>
                <td className="py-1.5 tnums">{r.days_count}</td>
                <td className="py-1.5">
                  <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />
                </td>
                <td className="py-1.5 text-right">
                  {['pending', 'sef_approved', 'rejected'].includes(r.status) && (
                    <button onClick={() => confirm('Obrisati zahtev?') && delM.mutate({ id: r.id })} className="text-status-danger hover:underline">
                      🗑
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <PaidLeaveModal onClose={() => setOpen(false)} />}
    </Section>
  );
}

function PaidLeaveModal({ onClose }: { onClose: () => void }) {
  const [leaveType, setType] = useState('');
  const [dateFrom, setFrom] = useState('');
  const [dateTo, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [proofNote, setProof] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitPaidLeave();

  function workDays(from: string, to: string): number {
    const s = new Date(from);
    const e = new Date(to);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
    let n = 0;
    const cur = new Date(s);
    while (cur <= e) {
      if (cur.getDay() !== 0 && cur.getDay() !== 6) n++;
      cur.setDate(cur.getDate() + 1);
    }
    return n;
  }
  const days = dateFrom && dateTo ? workDays(dateFrom, dateTo) : 0;

  async function save() {
    setErr(null);
    if (!leaveType.trim()) return setErr('Unesi osnov.');
    if (!dateFrom || !dateTo) return setErr('Izaberi period.');
    try {
      await submitM.mutateAsync({
        clientEventId: newClientEventId(),
        leaveType: leaveType.trim(),
        dateFrom,
        dateTo,
        daysCount: days,
        reason: reason || undefined,
        proofNote: proofNote || undefined,
      });
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
      <Button onClick={save} loading={submitM.isPending}>
        Pošalji zahtev
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title="Zahtev za plaćeno odsustvo" footer={footer}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <FormField label="Osnov" required hint="npr. venčanje, davanje krvi, smrt u porodici…">
          <Input value={leaveType} onChange={(e) => setType(e.target.value)} maxLength={40} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Od datuma" required>
            <Input type="date" value={dateFrom} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Do datuma" required>
            <Input type="date" value={dateTo} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </div>
        <p className="text-sm text-ink-secondary">
          Radnih dana: <b className="tnums">{days}</b>
        </p>
        <FormField label="Obrazloženje">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </FormField>
        <FormField label="Dokaz (opis / broj)">
          <Input value={proofNote} onChange={(e) => setProof(e.target.value)} maxLength={200} />
        </FormField>
      </div>
    </Dialog>
  );
}
