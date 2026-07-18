'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  newClientEventId,
  useEngineers,
  useWorkReports,
  useWorkReportSummary,
  useCreateWorkReport,
  useDeleteWorkReport,
} from '@/api/projektni-biro';
import { formatDate } from '@/lib/format';

const WEEKDAYS = ['Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub', 'Ned'];

// PB-F4: minimalni lokalni tipovi za Web Speech API (bez biblioteka).
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function IzvestajiTab() {
  const { can } = useAuth();
  const canReports = can(PERMISSIONS.PB_REPORTS_OWN) || can(PERMISSIONS.PB_REPORTS_ALL);
  const engineersQ = useEngineers();

  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const monthFrom = ymd(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const monthTo = ymd(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
  const monthQ = useWorkReports({ from: monthFrom, to: monthTo });

  // dan → sati (za tačkice u kalendaru)
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of monthQ.data?.data ?? []) {
      const key = String(r.datum).slice(0, 10);
      m.set(key, (m.get(key) ?? 0) + num(r.sati));
    }
    return m;
  }, [monthQ.data]);

  const dayEntries = (monthQ.data?.data ?? []).filter((r) => String(r.datum).slice(0, 10) === selectedDay);

  // Kalendar ćelije (Mon-first, 6 nedelja)
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startDow = (first.getDay() + 6) % 7; // Mon=0
    const out: (Date | null)[] = [];
    for (let i = 0; i < startDow; i++) out.push(null);
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) out.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const [engineerId, setEngineerId] = useState('');
  const [sati, setSati] = useState(8);
  const [opis, setOpis] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const createM = useCreateWorkReport();
  const delM = useDeleteWorkReport();

  // PB-F4: glasovni unos (STT) za polje "Opis rada".
  const [sttSupported, setSttSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    // Detekcija u efektu izbegava hydration mismatch (server uvek false).
    setSttSupported(getSpeechRecognitionCtor() != null);
    return () => {
      try {
        recogRef.current?.stop();
      } catch {
        /* ignore */
      }
      recogRef.current = null;
    };
  }, []);

  function toggleDictation() {
    if (recogRef.current) {
      try {
        recogRef.current.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recog = new Ctor();
    recog.lang = 'sr-RS';
    recog.continuous = false;
    recog.interimResults = false;
    recog.onresult = (ev) => {
      let text = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      text = text.trim();
      if (text) setOpis((prev) => (prev ? `${prev} ${text}` : text));
    };
    recog.onend = () => {
      recogRef.current = null;
      setListening(false);
    };
    recog.onerror = () => {
      recogRef.current = null;
      setListening(false);
      setErr('Glasovni unos nije uspeo — proveri dozvolu za mikrofon.');
    };
    recogRef.current = recog;
    setListening(true);
    try {
      recog.start();
    } catch {
      recogRef.current = null;
      setListening(false);
    }
  }

  async function save() {
    setErr(null);
    if (sati < 0.5 || sati > 12) {
      setErr('Sati moraju biti između 0.5 i 12.');
      return;
    }
    try {
      await createM.mutateAsync({
        clientEventId: newClientEventId(),
        datum: selectedDay,
        sati,
        opis: opis || undefined,
        employeeId: engineerId || undefined,
      });
      setOpis('');
    } catch {
      setErr('Čuvanje nije uspelo.');
    }
  }

  // Obračun po periodu
  const [pFrom, setPFrom] = useState(monthFrom);
  const [pTo, setPTo] = useState(ymd(new Date()));
  const [pEng, setPEng] = useState('');
  const [summaryReq, setSummaryReq] = useState<{ from: string; to: string; employeeId?: string } | null>(null);
  const summaryQ = useWorkReportSummary(summaryReq);
  const summaryRows = summaryQ.data?.data ?? [];
  const totalHours = summaryRows.reduce((s, r) => s + num(r.total_hours ?? r.sati ?? r.hours), 0);
  const totalCount = summaryRows.reduce((s, r) => s + num(r.report_count ?? r.count ?? r.n), 0);

  const monthLabel = cursor.toLocaleDateString('sr-Latn', { month: 'long', year: 'numeric' });
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Kalendar */}
      <div className="rounded-panel border border-line bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            ←
          </button>
          <span className="text-sm font-medium capitalize text-ink">{monthLabel}</span>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            →
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-2xs text-ink-secondary">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1 font-semibold">
              {w}
            </div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={i} />;
            const key = ymd(d);
            const hrs = byDay.get(key);
            const dow = d.getDay();
            const weekend = dow === 0 || dow === 6;
            const isSel = key === selectedDay;
            const isToday = key === ymd(new Date());
            return (
              <button
                key={i}
                onClick={() => setSelectedDay(key)}
                className={cn(
                  'flex h-10 flex-col items-center justify-center rounded-control text-sm',
                  weekend && 'text-ink-disabled',
                  isToday && 'ring-1 ring-accent',
                  isSel ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2',
                )}
              >
                <span>{d.getDate()}</span>
                {hrs != null && <span className={cn('text-2xs', isSel ? 'text-accent-fg' : 'text-accent')}>• {hrs.toFixed(1)}h</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Unos za dan */}
      <div className="rounded-panel border border-line bg-surface p-3">
        <h3 className="mb-2 text-sm font-semibold text-ink">Izveštaj za {formatDate(selectedDay)}</h3>
        {!canReports ? (
          <p className="text-sm text-ink-secondary">Nemate pravo unosa izveštaja rada.</p>
        ) : (
          <div className="space-y-3">
            {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-xs text-status-danger">{err}</p>}
            <FormField label="Inženjer" hint="Prazno = vaš profil">
              <select value={engineerId} onChange={(e) => setEngineerId(e.target.value)} className={selCls}>
                <option value="">— ja —</option>
                {(engineersQ.data?.data ?? []).map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.full_name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={`Sati: ${sati.toFixed(1)}`} hint="0.5–12">
              <input type="range" min={0.5} max={12} step={0.5} value={sati} onChange={(e) => setSati(Number(e.target.value))} className="w-full" />
            </FormField>
            <FormField label="Opis rada">
              <div className="space-y-2">
                <Textarea value={opis} onChange={(e) => setOpis(e.target.value)} rows={3} placeholder="Kratki opis šta je urađeno tog dana…" />
                {sttSupported && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant={listening ? 'danger' : 'secondary'}
                      onClick={toggleDictation}
                      aria-pressed={listening}
                      className={cn('h-8 px-3 text-sm', listening && 'animate-pulse')}
                    >
                      {listening ? '⏺ Slušam… (stop)' : '🎙 Glasovni unos'}
                    </Button>
                    {listening && <span className="text-xs text-status-danger">Diktiranje aktivno…</span>}
                  </div>
                )}
              </div>
            </FormField>
            <Button onClick={save} loading={createM.isPending} className="w-full">
              Sačuvaj
            </Button>
          </div>
        )}
        <div className="mt-3 border-t border-line pt-3">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Unosi za dan</h4>
          {monthQ.isError ? (
            <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
          ) : dayEntries.length === 0 ? (
            <p className="text-xs text-ink-disabled">Nema unosa.</p>
          ) : (
            <ul className="space-y-1">
              {dayEntries.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-2 py-1.5 text-sm">
                  <span>
                    <b className="tnums">{num(r.sati).toFixed(1)}h</b> {r.opis ? `· ${r.opis}` : ''}
                  </span>
                  <button onClick={() => delM.mutate({ id: r.id })} className="text-ink-disabled hover:text-status-danger" aria-label="Obriši">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Obračun po periodu */}
      <div className="rounded-panel border border-line bg-surface p-3">
        <h3 className="mb-2 text-sm font-semibold text-ink">Obračun po periodu</h3>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Od">
              <Input type="date" value={pFrom} onChange={(e) => setPFrom(e.target.value)} />
            </FormField>
            <FormField label="Do">
              <Input type="date" value={pTo} onChange={(e) => setPTo(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Inženjer">
            <select value={pEng} onChange={(e) => setPEng(e.target.value)} className={selCls}>
              <option value="">Svi inženjeri</option>
              {(engineersQ.data?.data ?? []).map((en) => (
                <option key={en.id} value={en.id}>
                  {en.full_name}
                </option>
              ))}
            </select>
          </FormField>
          <Button variant="secondary" onClick={() => setSummaryReq({ from: pFrom, to: pTo, employeeId: pEng || undefined })} className="w-full">
            Izračunaj
          </Button>
        </div>
        {summaryReq && (
          <div className="mt-3 border-t border-line pt-3">
            {summaryQ.isError ? (
              <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-ink-secondary">
                    {totalCount} izveštaja · {pFrom} — {pTo}
                  </span>
                  <span className="font-semibold text-ink">{totalHours.toFixed(1)}h ukupno</span>
                </div>
                <ul className="space-y-1">
                  {summaryRows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between text-sm">
                      <span className="text-ink">{(r.full_name ?? r.employee_name ?? '—') as string}</span>
                      <span className="tnums text-ink-secondary">
                        {num(r.report_count ?? r.count ?? r.n)} izv. · {num(r.total_hours ?? r.sati ?? r.hours).toFixed(1)}h
                      </span>
                    </li>
                  ))}
                  {summaryRows.length === 0 && <li className="text-xs text-ink-disabled">Nema izveštaja u periodu.</li>}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
