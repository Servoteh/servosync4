'use client';

import { Fragment, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useAttendance,
  useAttendanceEvents,
  useSubmitCorrection,
  type AttendanceDay,
} from '@/api/moj-profil';
import { Section } from './section';

function ym(d: Date): { from: string; to: string; label: string } {
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  return { from, to, label: d.toLocaleDateString('sr-Latn', { month: 'long', year: 'numeric' }) };
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function hhmm(v: unknown): string {
  const s = v == null ? '' : String(v);
  // 'HH:MM' iz time kolone ili '…THH:MM' iz timestampa.
  if (s.includes('T')) return s.slice(11, 16) || '—';
  return s.slice(0, 5) || '—';
}
const DIR_LABEL: Record<string, string> = {
  in: 'Ulaz',
  out: 'Izlaz',
  break: 'Pauza',
  official_out: 'Služb. izlaz',
  other: 'Ostalo',
  unknown: '—',
};

export function AttendanceSection() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const { from, to, label } = ym(cursor);
  const q = useAttendance({ from, to });
  const days = q.data?.data?.days ?? [];
  const [corr, setCorr] = useState<AttendanceDay | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Section icon="⏱" title="Moje prisustvo (ulazi/izlazi)">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
          ‹
        </button>
        <span className="text-sm font-medium capitalize text-ink">{label}</span>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          disabled={cursor.getMonth() >= new Date().getMonth() && cursor.getFullYear() >= new Date().getFullYear()}
          className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
        >
          ›
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-disabled">
        Prolazi sa kapije, hala i kioska. Klik na red = prolazi tog dana. ✎ korigovano · ⚠ izlaz nije otkucan · 🌙 preko ponoći.
      </p>
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : days.length === 0 ? (
        <p className="text-sm text-ink-disabled">Nema prolaza u ovom mesecu.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Dan</th>
              <th className="py-1.5">Ulaz</th>
              <th className="py-1.5">Izlaz</th>
              <th className="py-1.5">Sati</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => {
              const firstIn = d.first_in ?? d.time_in;
              const lastOut = d.last_out ?? d.time_out;
              const overnight = !!firstIn && !!lastOut && String(lastOut) < String(firstIn);
              const openIntervals = num(d.open_intervals);
              const missingOut = (openIntervals > 0 || (!!firstIn && !lastOut)) && d.day.slice(0, 10) !== today && !overnight;
              const corrected = d.corrected === true;
              const isOpen = openDay === d.day;
              return (
                <Fragment key={i}>
                  <tr
                    className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    onClick={() => setOpenDay(isOpen ? null : d.day)}
                  >
                    <td className="py-1.5 tnums">
                      {formatDate(d.day)}{' '}
                      {corrected ? (
                        <span title="Korigovano uz obrazloženje">✎</span>
                      ) : missingOut ? (
                        <span className="text-status-warn" title="Izlaz nije otkucan">
                          ⚠
                        </span>
                      ) : overnight ? (
                        <span title="Smena preko ponoći">🌙</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 tnums">{hhmm(firstIn)}</td>
                    <td className="py-1.5 tnums">
                      {lastOut ? hhmm(lastOut) : missingOut ? <span className="text-status-warn">nije otkucan</span> : '—'}
                    </td>
                    <td className="py-1.5 tnums">{d.presence_hours != null ? num(d.presence_hours).toFixed(2) : '—'}</td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setCorr(d);
                        }}
                        className="text-xs text-accent hover:underline"
                      >
                        Ispravi
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className="bg-surface-2 px-3 pb-3 pt-1">
                        <AttendanceDrill day={d.day} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {corr && <CorrectionModal day={corr} onClose={() => setCorr(null)} />}
    </Section>
  );
}

/** Prolazi jednog dana (lazy) — HH:MM · smer · terminal · razlog. */
function AttendanceDrill({ day }: { day: string }) {
  const q = useAttendanceEvents(day.slice(0, 10));
  if (q.isLoading) return <p className="text-xs text-ink-disabled">Učitavam prolaze…</p>;
  const events = q.data?.data ?? [];
  if (events.length === 0) return <p className="text-xs text-ink-disabled">Nema prolaza.</p>;
  return (
    <ul className="space-y-0.5 text-xs text-ink-secondary">
      {events.map((e, i) => (
        <li key={i} className="tnums">
          {hhmm(e.event_ts_local)} · {DIR_LABEL[e.direction] ?? e.direction} · {e.terminal_name ?? '—'}
          {e.reason && <em className="text-ink-disabled"> ({e.reason})</em>}
        </li>
      ))}
    </ul>
  );
}

function CorrectionModal({ day, onClose }: { day: AttendanceDay; onClose: () => void }) {
  const [timeIn, setIn] = useState('');
  const [timeOut, setOut] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitCorrection();

  async function save() {
    setErr(null);
    if (reason.trim().length < 5) return setErr('Obrazloženje je obavezno (min 5 znakova).');
    try {
      await submitM.mutateAsync({
        clientEventId: newClientEventId(),
        day: String(day.day).slice(0, 10),
        timeIn: timeIn || undefined,
        timeOut: timeOut || undefined,
        reason: reason.trim(),
      });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Slanje nije uspelo.');
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Odustani
      </Button>
      <Button onClick={save} loading={submitM.isPending}>
        Sačuvaj korekciju
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title="✎ Korekcija kucanja" footer={footer}>
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">Dan: {formatDate(day.day)} — dodajete samo vreme koje NIJE otkucano.</p>
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ulaz (ako fali)">
            <Input type="time" value={timeIn} onChange={(e) => setIn(e.target.value)} />
          </FormField>
          <FormField label="Izlaz (ako fali)">
            <Input type="time" value={timeOut} onChange={(e) => setOut(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Obrazloženje (obavezno)" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="npr. Zaboravio sam da otkucam izlaz, otišao u 15:30" />
        </FormField>
      </div>
    </Dialog>
  );
}
