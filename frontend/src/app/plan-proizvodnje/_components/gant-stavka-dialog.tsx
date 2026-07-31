'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';
import {
  useGanttOverlay,
  useGanttReassign,
  useMachines,
  useOperationsSearch,
  type GanttRow,
  type OpRow,
} from '@/api/plan-proizvodnje';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  effectiveMinutes,
  isoDay,
  keepIfSameDay,
  readyReason,
  technologyMinutes,
  toIsoAtDayEnd,
  toIsoAtWorkStart,
} from './gant-utils';

/**
 * Detalj gant stavke (zahtev 046/26) — „popover" nad barom, izveden kao kit `Dialog`
 * (isti obrazac kao ostali modali modula; nema plutajućih slojeva koji bi curili iz
 * horizontalno skrolovane ose).
 *
 * Gore su AUTO podaci iz tehnologije/RN-a (samo za čitanje): naziv pozicije, količina,
 * crtež, RN, predmet (sklop), faza obrade. Dole su POLJA koja planer menja: mašina,
 * početak, kraj, trajanje (override), „uslov" (predecessor) i ručni override završenosti.
 * Spremnost je prikaz (DA zeleno / NE crveno + razlog) — kanon presuđuje backend.
 */
export function GantStavkaDialog({
  open,
  row,
  onClose,
}: {
  open: boolean;
  row: GanttRow;
  onClose: () => void;
}) {
  const save = useGanttOverlay({ ok: 'Sačuvano', err: overlayErrorMessage });
  const reassign = useGanttReassign();
  const machines = useMachines();

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [dur, setDur] = useState('');
  const [machine, setMachine] = useState('');
  const [pred, setPred] = useState<OpRow | null>(null);

  // `row` dobija NOVU identičnost posle svake optimističke izmene/refetch-a (npr. čekiranje
  // „Završeno" iz ovog istog dijaloga). Init sme da se odigra SAMO pri otvaranju i promeni
  // stavke — inače bi nesnimljen unos termina tiho pao na stare serverske vrednosti.
  const rowKey = `${row.work_order_id}:${row.line_id}`;
  const rowRef = useRef(row);
  rowRef.current = row;

  useEffect(() => {
    const r = rowRef.current;
    setStart(r.planned_start_at ? isoDay(new Date(r.planned_start_at)) : '');
    setEnd(r.planned_end_at ? isoDay(new Date(r.planned_end_at)) : '');
    setDur(r.planned_duration_minutes != null ? String(r.planned_duration_minutes) : '');
    setMachine(r.effective_machine_code ?? '');
    setPred(null);
  }, [rowKey, open]);

  /**
   * Pretraga prethodne operacije BEZ same stavke — samo-uslov je ciklus dužine 1 koji
   * backend ionako odbija (422 `predecessor_self_reference`); planeru se ne nudi.
   */
  const useOpsSearchBezSebe = (q: string) => {
    const res = useOperationsSearch(q);
    const data = useMemo(() => {
      const list = res.data?.data;
      if (!list) return res.data;
      return { ...res.data, data: list.filter((o) => `${o.work_order_id}:${o.line_id}` !== rowKey) };
    }, [res.data, rowKey]);
    return { ...res, data };
  };

  const tech = technologyMinutes(row);
  const eff = effectiveMinutes(row);
  const ready = row.is_ready_for_machine === true;
  const done = row.is_completed_effective === true;
  const overrideDone = row.planned_done !== null && row.planned_done !== undefined;

  /**
   * Snimanje termina. Kraj je TAČNO ono što je planer uneo (dan koji je ukucao), a
   * trajanje se dodaje na početak SAMO kad je polje kraja prazno. Trajanje se nikad ne
   * sabira sa kucanim krajem — to je pravilo koje čini snimanje IDEMPOTENTNIM: otvaranje
   * dijaloga i „Sačuvaj termin" bez ijedne izmene daje identičan interval (ranije je
   * svako snimanje guralo kraj za po jedan dan, pa je plan tiho odlazio unapred).
   */
  function saveTermini() {
    if (!start) {
      toast('⚠ Zadaj planirani početak.');
      return;
    }
    const durNum = dur.trim() === '' ? null : Number(dur.trim());
    if (durNum !== null && (!Number.isFinite(durNum) || durNum < 1)) {
      toast('⚠ Trajanje mora biti broj minuta veći od 0.');
      return;
    }
    // Dan-nivo provera (polja su `input[type=date]`, pa 'yyyy-MM-dd' poredi leksikografski).
    if (end && end < start) {
      toast('⚠ Kraj ne može biti pre početka — ispravi datum kraja (ili ga isprazni).');
      return;
    }
    // Nepromenjen dan zadržava zatečeni sat (drag/resize satnica preživljava snimanje);
    // promenjen dan dobija kanonski sat: početak = 07:00, kraj = kraj tog dana.
    const startIso = keepIfSameDay(row.planned_start_at, start) ?? toIsoAtWorkStart(start);
    const startMs = new Date(startIso).getTime();
    let endIso: string;
    if (end) {
      const kept = keepIfSameDay(row.planned_end_at, end);
      // Zatečen sat se odbacuje ako bi dao naopak interval (nasleđen loš podatak).
      endIso = kept && new Date(kept).getTime() >= startMs ? kept : toIsoAtDayEnd(end);
    } else {
      const min = durNum ?? (eff > 0 ? eff : 24 * 60);
      endIso = new Date(startMs + min * 60_000).toISOString();
    }
    if (new Date(endIso).getTime() < startMs) {
      toast('⚠ Kraj ne može biti pre početka — ispravi datume.');
      return;
    }
    save.mutate(
      {
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedStartAt: startIso,
        plannedEndAt: endIso,
        plannedDurationMinutes: durNum,
      },
      { onSuccess: onClose },
    );
  }

  function skiniSaPlana() {
    save.mutate(
      {
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedStartAt: null,
        plannedEndAt: null,
      },
      { onSuccess: onClose },
    );
  }

  function changeMachine(code: string) {
    setMachine(code);
    if (!code || code === row.effective_machine_code) return;
    reassign.mutate(
      { workOrderId: row.work_order_id, lineId: row.line_id, targetMachine: code },
      {
        onSuccess: () => toast('✓ Mašina promenjena'),
        onError: (e) => {
          setMachine(row.effective_machine_code ?? '');
          const msg = String((e as Error)?.message ?? '');
          toast(
            msg.includes('machine_group_mismatch')
              ? '⚠ Druga grupa mašina — prebaci kroz tab „Po mašini" (traži prinudni premeštaj i razlog).'
              : '⚠ Mašina nije promenjena.',
          );
        },
      },
    );
  }

  function setPredecessor(op: OpRow | null) {
    if (op && `${op.work_order_id}:${op.line_id}` === rowKey) {
      toast('⚠ Stavka ne može da zavisi od same sebe.');
      return;
    }
    setPred(op);
    save.mutate(
      {
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        predecessorWorkOrderId: op ? op.work_order_id : null,
        predecessorLine: op ? op.line_id : null,
      },
      // Odbijen izbor ne sme da ostane prikazan kao da je prihvaćen (razlog javlja hook).
      { onError: () => setPred(null) },
    );
  }

  function toggleDone(checked: boolean) {
    save.mutate({ workOrderId: row.work_order_id, lineId: row.line_id, plannedDone: checked });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${row.rn_ident_broj ?? '—'} · op. ${String(row.operacija ?? '—')}`}
      size="lg"
      dismissable={false}
      footer={
        <div className="flex w-full items-center gap-2">
          {row.planned_start_at ? (
            <Button variant="danger" onClick={skiniSaPlana} loading={save.isPending}>
              Skini sa plana
            </Button>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={saveTermini} loading={save.isPending}>
              Sačuvaj termin
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* ── AUTO podaci (iz RN-a / tehnologije) ── */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-panel border border-line bg-surface-2 p-3 text-sm md:grid-cols-3">
          <Fact label="Naziv pozicije" value={row.naziv_dela} />
          <Fact label="Količina" value={row.komada_total != null ? `${row.komada_total} kom` : null} />
          <Fact label="Crtež" value={row.broj_crteza} />
          <Fact label="RN" value={row.rn_ident_broj} />
          <Fact label="Predmet (sklop)" value={sklop(row)} />
          <Fact label="Kupac" value={row.customer_short ?? row.customer_name} />
          <Fact label="Faza obrade" value={`${String(row.operacija ?? '—')} · ${row.opis_rada ?? '—'}`} />
          <Fact label="Materijal" value={row.materijal} />
          <Fact label="Rok izrade" value={row.rok_izrade ? formatDate(row.rok_izrade) : null} />
          <Fact
            label="Tehnologija (TPZ + TK × kom)"
            value={tech > 0 ? `${tech} min (${(tech / 60).toFixed(1)} h)` : null}
          />
          <Fact label="Urađeno" value={`${row.komada_done ?? 0} / ${row.komada_total ?? 0} kom`} />
          <Fact label="Ručni redosled smene" value={row.shift_sort_order != null ? `#${row.shift_sort_order}` : 'auto'} />
        </div>

        {/* ── Spremnost (prikaz; kanon je BE) ── */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-panel border px-3 py-2 text-sm',
            ready
              ? 'border-status-success/40 bg-status-success-bg text-status-success'
              : 'border-status-danger/40 bg-status-danger-bg text-status-danger',
          )}
        >
          <span className="font-semibold">Spremnost: {ready ? 'DA' : 'NE'}</span>
          <span className="text-ink-secondary">· {readyReason(row)}</span>
          {row.is_urgent ? <span className="ml-auto font-semibold">HITNO</span> : null}
        </div>

        {/* ── Polja ── */}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Mašina">
            <select
              value={machine}
              onChange={(e) => changeMachine(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            >
              <option value="">(bez mašine)</option>
              {(machines.data?.data ?? []).map((m) => (
                <option key={m.rj_code} value={m.rj_code}>
                  {m.rj_code}
                  {m.name ? ` · ${m.name}` : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-2xs text-ink-disabled">
              Originalna mašina iz tehnologije: {row.original_machine_code ?? '—'}
            </p>
          </Field>

          <Field label="Trajanje (min) — override">
            <input
              type="number"
              min={1}
              value={dur}
              onChange={(e) => setDur(e.target.value)}
              placeholder={String(tech || '')}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink tnums"
            />
            <p className="mt-1 text-2xs text-ink-disabled">
              Prazno = iz tehnologije ({tech} min). Trenutno u primeni: {eff} min.
            </p>
          </Field>

          <Field label="Planirani početak">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
          </Field>

          <Field label="Planirani kraj">
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
            <p className="mt-1 text-2xs text-ink-disabled">
              Zaključno sa tim danom. Prazno = izvedeno iz početka + trajanja.
            </p>
          </Field>

          <Field label="Uslov (prethodna stavka)">
            {row.predecessor_work_order_id && !pred ? (
              <div className="flex items-center gap-2 rounded-control border border-line bg-surface px-2 py-1.5 text-sm">
                <Link2 className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                <span className="truncate tnums">
                  RN {row.predecessor_work_order_id} · linija {row.predecessor_line}
                </span>
                <button
                  type="button"
                  onClick={() => setPredecessor(null)}
                  className="ml-auto text-ink-disabled hover:text-status-danger"
                  aria-label="Ukloni uslov"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <ComboBox<OpRow>
                value={pred}
                onChange={setPredecessor}
                useSearch={useOpsSearchBezSebe}
                getKey={(o) => `${o.work_order_id}:${o.line_id}`}
                getLabel={(o) => `${o.rn_ident_broj ?? o.work_order_id} · op. ${String(o.operacija ?? '—')}`}
                getSublabel={(o) => `${o.broj_crteza ?? ''} ${o.naziv_dela ?? ''}`.trim()}
                placeholder="Traži RN / crtež…"
              />
            )}
            <p className="mt-1 text-2xs text-ink-disabled">
              Ručna FS veza (počinje posle završetka). Ne pomera termine automatski — to je F2.
            </p>
          </Field>

          <Field label="Završeno">
            <label className="flex h-9 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={done} onChange={(e) => toggleDone(e.target.checked)} />
              {done ? 'Završeno' : 'Nije završeno'}
            </label>
            <p className="mt-1 text-2xs text-ink-disabled">
              {overrideDone ? (
                <>
                  Ručni override ({row.planned_done ? 'DA' : 'NE'})
                  {row.planned_done_by ? ` · ${row.planned_done_by}` : ''}{' '}
                  <button
                    type="button"
                    className="underline hover:text-accent"
                    onClick={() =>
                      save.mutate({ workOrderId: row.work_order_id, lineId: row.line_id, plannedDone: null })
                    }
                  >
                    vrati na automatski
                  </button>
                </>
              ) : (
                <>Automatski iz kucanja operatera ({row.is_done_in_bigtehn ? 'otkucano' : 'još nije otkucano'}).</>
              )}
            </p>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Prevod BE 422 kodova u razlog na srpskom — planer mora da vidi ZAŠTO nije sačuvano,
 * a ne generično „Nije sačuvano". Nepoznat kod → undefined (hook javlja podrazumevanu).
 */
const BE_RAZLOZI: Record<string, string> = {
  predecessor_self_reference: 'Stavka ne može da zavisi od same sebe.',
  predecessor_pair_incomplete: 'Uslov mora imati i RN i liniju prethodne operacije.',
  planned_end_before_start: 'Kraj ne može biti pre početka — ispravi datume.',
  invalid_timestamp: 'Neispravan datum termina.',
};

function overlayErrorMessage(e: unknown): string | undefined {
  const msg = String((e as Error)?.message ?? '');
  for (const [code, razlog] of Object.entries(BE_RAZLOZI)) {
    if (msg.includes(code)) return razlog;
  }
  return undefined;
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-ink-disabled">{label}</div>
      <div className="truncate text-ink" title={value != null ? String(value) : undefined}>
        {value != null && value !== '' ? String(value) : '—'}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-secondary">{label}</div>
      {children}
    </div>
  );
}

/** Predmet (sklop) = prvi segment RN ident broja (kanon „broj predmeta/TP/varijanta"). */
function sklop(row: GanttRow): string | null {
  const rn = row.rn_ident_broj;
  if (!rn) return null;
  const first = String(rn).split(/[-/]/)[0]?.trim();
  return first || null;
}
