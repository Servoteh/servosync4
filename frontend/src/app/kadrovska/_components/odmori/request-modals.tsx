'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate } from '@/lib/format';
import type { VacationRequest } from '@/api/kadrovska';
import { daysInclusive, workDaysInclusive } from './helpers';

/** Odbij zahtev — modal sa (opciono obaveznim) razlogom. */
export function RejectModal({
  title,
  subtitle,
  requireReason,
  onConfirm,
  onClose,
}: {
  title: string;
  subtitle?: string;
  requireReason: boolean;
  onConfirm: (note: string) => Promise<string | null>; // vrati poruku greške ili null (uspeh)
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = note.trim();
    if (requireReason && !trimmed) { setError('Razlog odbijanja je obavezan.'); return; }
    setBusy(true);
    setError(null);
    const err = await onConfirm(trimmed);
    if (err) { setError(err); setBusy(false); return; }
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button variant="danger" onClick={submit} loading={busy}>Odbij</Button>
        </>
      }
    >
      <div className="space-y-3">
        {subtitle && <p className="text-xs text-ink-secondary">{subtitle}</p>}
        <FormField label={`Razlog odbijanja${requireReason ? '' : ' (opciono)'}`} required={requireReason}>
          <Textarea
            rows={3}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Unesite razlog (npr. period zauzet, nedostatak kadra…)"
          />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/** Izmeni termin odobrenog GO — premesti (ostaje odobreno) ili vrati na ponovno odobravanje. */
export function RescheduleModal({
  req,
  employeeName,
  holidays,
  onSubmit,
  onClose,
}: {
  req: VacationRequest;
  employeeName: string;
  holidays: Set<string>;
  onSubmit: (mode: 'move' | 'reapprove', from: string, to: string, days: number) => Promise<string | null>;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(req.dateFrom?.slice(0, 10) || '');
  const [to, setTo] = useState(req.dateTo?.slice(0, 10) || '');
  const [mode, setMode] = useState<'move' | 'reapprove'>('move');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workDays = useMemo(() => (from && to && to >= from ? workDaysInclusive(from, to, holidays) : 0), [from, to, holidays]);
  const calDays = useMemo(() => (from && to && to >= from ? daysInclusive(from, to) : 0), [from, to]);

  async function submit() {
    setError(null);
    if (!from || !to) { setError('Unesite oba datuma.'); return; }
    if (to < from) { setError('Datum DO ne sme biti pre datuma OD.'); return; }
    if (mode === 'move' && from === req.dateFrom?.slice(0, 10) && to === req.dateTo?.slice(0, 10)) { onClose(); return; }
    setBusy(true);
    const err = await onSubmit(mode, from, to, workDays);
    if (err) { setError(err); setBusy(false); return; }
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Izmena termina godišnjeg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={busy}>Sačuvaj termin</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          {employeeName} — trenutno {req.dateFrom ? formatDate(req.dateFrom) : ''} do {req.dateTo ? formatDate(req.dateTo) : ''}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Novi datum OD" required>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink" />
          </FormField>
          <FormField label="Novi datum DO" required>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink" />
          </FormField>
        </div>
        <div className="text-sm">
          Radnih dana: <strong className="tnums">{workDays || '—'}</strong>
          {calDays !== workDays && calDays > 0 && <span className="text-ink-secondary"> ({calDays} kal.)</span>}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Šta uraditi sa zahtevom?</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="reschedmode" checked={mode === 'move'} onChange={() => setMode('move')} className="mt-1" />
            <span><strong>Premesti termin</strong> — zahtev OSTAJE odobren (bez ponovnog odobravanja).</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="reschedmode" checked={mode === 'reapprove'} onChange={() => setMode('reapprove')} className="mt-1" />
            <span><strong>Vrati na ponovno odobravanje</strong> — oslobađa termin i vraća zahtev u „Za odobravanje".</span>
          </label>
        </fieldset>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
