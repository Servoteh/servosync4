'use client';

import { useState } from 'react';
import { Clock, NotebookPen, Trash2 } from 'lucide-react';
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
import { PAID_LEAVE_CATALOG } from '@/app/kadrovska/_components/odsustva/shared';

export function MakeupSection() {
  const q = useMakeupPaidLeave();
  const rows = q.data?.data?.makeup ?? [];
  const [open, setOpen] = useState(false);
  const delM = useDeleteMakeup();

  return (
    <Section
      icon={<Clock className="h-4 w-4 text-ink-secondary" />}
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
                    <button onClick={() => confirm('Obrisati zahtev?') && delM.mutate({ id: r.id })} className="text-status-danger hover:underline" aria-label="Obriši zahtev" title="Obriši zahtev">
                      <Trash2 className="h-4 w-4" aria-hidden />
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
    // AUDIT-K4: iste provere kao 1.0 (mojProfil/index.js:1513-1527). Server ih
    // ponavlja — ovde su da korisnik grešku vidi odmah, a ne posle slanja.
    const danOdmora = compensationType === 'dan_odmora';
    if (danOdmora) {
      if (!weekendWorkDate) return setErr('Unesi datum rada vikendom.');
      const dow = new Date(`${weekendWorkDate}T00:00:00`).getDay(); // 0=ned, 6=sub
      if (dow !== 0 && dow !== 6) return setErr('Datum rada mora biti subota ili nedelja.');
      if (!(absenceHours >= 8 && absenceHours <= 24))
        return setErr(
          'Za +1 dan odmora potrebno je najmanje 8h rada (ceo dan). Za manje sati podnesi zahtev za nadoknadu sati.',
        );
    } else {
      if (!absenceDate) return setErr('Unesi datum izostanka.');
      if (!(absenceHours > 0 && absenceHours <= 24)) return setErr('Broj sati mora biti 0.5–24.');
      if (!makeupPlan.trim()) return setErr('Predlog nadoknade je obavezan.');
    }
    if (!reason.trim()) return setErr('Razlog je obavezan.');
    if (makeupDeadline && absenceDate && makeupDeadline < absenceDate)
      return setErr('Rok nadoknade ne može biti pre datuma izostanka.');
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
      icon={<NotebookPen className="h-4 w-4 text-ink-secondary" />}
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
                    <button onClick={() => confirm('Obrisati zahtev?') && delM.mutate({ id: r.id })} className="text-status-danger hover:underline" aria-label="Obriši zahtev" title="Obriši zahtev">
                      <Trash2 className="h-4 w-4" aria-hidden />
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
  // Prikazna procena (bez praznika — server računa merodavan broj i upisuje ga).
  const days = dateFrom && dateTo ? workDays(dateFrom, dateTo) : 0;
  const selectedBasis = PAID_LEAVE_CATALOG.find((c) => c.code === leaveType);

  async function save() {
    setErr(null);
    if (!leaveType) return setErr('Izaberi osnov.');
    if (!dateFrom || !dateTo) return setErr('Izaberi period.');
    if (selectedBasis?.maxDays != null && days > selectedBasis.maxDays)
      return setErr(
        `Za osnov „${selectedBasis.label}" pravilnik predviđa najviše ${selectedBasis.maxDays} radnih dana.`,
      );
    try {
      await submitM.mutateAsync({
        clientEventId: newClientEventId(),
        leaveType,
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
        {/* AUDIT-K4: osnov je KODIRAN, ne slobodan tekst — `paid_leave_reason_map`
            za nepoznat string pada na ELSE i gubi pravni osnov. Grupe prate
            pravilnik (čl. 35 st. 1 = u fondu od 5 dana; st. 2 = van fonda). */}
        <FormField label="Osnov" required hint={selectedBasis?.maxDays ? `Po pravilniku: do ${selectedBasis.maxDays} radnih dana` : undefined}>
          <select
            value={leaveType}
            onChange={(e) => setType(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="">— izaberi osnov —</option>
            <optgroup label="U okviru fonda od 5 radnih dana godišnje">
              {PAID_LEAVE_CATALOG.filter((c) => c.group === 'fond').map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                  {c.maxDays ? ` (do ${c.maxDays} d)` : ''}
                </option>
              ))}
            </optgroup>
            <optgroup label="Van fonda od 5 dana">
              {PAID_LEAVE_CATALOG.filter((c) => c.group === 'van').map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                  {c.maxDays ? ` (do ${c.maxDays} d)` : ''}
                </option>
              ))}
            </optgroup>
          </select>
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
