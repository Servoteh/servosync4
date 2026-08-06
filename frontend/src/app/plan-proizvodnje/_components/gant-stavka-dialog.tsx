'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Link2, X } from 'lucide-react';
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
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { openBigtehnPdfTab, sanitizeDrawingNo } from './shared';
import {
  addMinutesLocal,
  effectiveMinutes,
  hoursInputFromMinutes,
  hoursLabel,
  isoLocalMinute,
  keepIfSameMinute,
  minutesFromHoursInput,
  overlayErrorMessage,
  readyReason,
  scrapBadge,
  technologyMinutes,
} from './gant-utils';
import { GantLanacDialog, ucitajPlanLanca } from './gant-lanac-dialog';
import type { ShiftChainPlan } from '@/api/plan-proizvodnje';

/**
 * Detalj gant stavke (zahtev 046/26) — „popover" nad barom, izveden kao kit `Dialog`
 * (isti obrazac kao ostali modali modula; nema plutajućih slojeva koji bi curili iz
 * horizontalno skrolovane ose).
 *
 * Gore su AUTO podaci iz tehnologije/RN-a (samo za čitanje): naziv pozicije, količina,
 * crtež, RN, predmet (sklop), faza obrade. Dole su POLJA koja planer menja: mašina,
 * početak, kraj, trajanje (override), „uslov" (predecessor) i ručni override završenosti.
 * Spremnost je prikaz (DA zeleno / NE crveno + razlog) — kanon presuđuje backend —
 * plus RUČNI override „fizički znamo da je spremna" (Paket B; postojeći `ready_override`
 * mehanizam, isti kao „SPREMNO (override)" u tabu „Po mašini").
 *
 * Termini su na MINUT (datum + sati:minuti, `datetime-local`) i sinhronizovani
 * (Strahinjine primedbe 1 i 2). Pravilo:
 *   • izmena POČETKA ili TRAJANJA odmah preračuna KRAJ (kraj = početak + trajanje;
 *     trajanje = kucani override, inače tehnologija TPZ + TK × kom);
 *   • ručno kucan KRAJ važi doslovno — trajanje se NE preračunava iz raspona (bar sme
 *     preko vikenda/zastoja: raspon ≠ radni minuti) — dok sledeća izmena početka ili
 *     trajanja ponovo ne izračuna kraj;
 *   • prazan KRAJ se pri snimanju izvede iz početka + trajanja (isto pravilo).
 *
 * TRAJANJE se od 076/26 KUCA U SATIMA („upišem 2 → 120 minuta"), a čuva i šalje u
 * MINUTIMA — prevod je samo u ovom polju (`minutesFromHoursInput` /
 * `hoursInputFromMinutes` u `gant-utils`). Prevlačenje i razvlačenje bara na gantu i
 * dalje pišu minute; da nije tako, jedan potez mišem bi promenio trajanje 60 puta.
 */
export function GantStavkaDialog({
  open,
  row,
  onClose,
  ordinals,
}: {
  open: boolean;
  row: GanttRow;
  onClose: () => void;
  /**
   * C1 (046/26): stavke ISTE mašine sa rednim brojem iz gant prikaza (Paket A
   * numeracija) — polje „Uslov" kroz njih prihvata i GOLI redni broj („poveži
   * rednim brojem"): ukucan broj se mapira u stavku i nudi kao prvi rezultat.
   */
  ordinals?: { broj: number; row: GanttRow }[];
}) {
  const save = useGanttOverlay({ ok: 'Sačuvano', err: overlayErrorMessage });
  const reassign = useGanttReassign();
  const machines = useMachines();

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  /** Trajanje-override u SATIMA (076/26) — baza i API ostaju u minutima. */
  const [dur, setDur] = useState('');
  const [machine, setMachine] = useState('');
  const [pred, setPred] = useState<OpRow | null>(null);
  // 075/26 — „Pomeri lanac…": put KUCANJA dobija kaskadu, ali svesno i kroz pregled.
  const [lanacDana, setLanacDana] = useState('1');
  const [lanacPlan, setLanacPlan] = useState<ShiftChainPlan | null>(null);
  const [lanacUcitava, setLanacUcitava] = useState(false);

  // `row` dobija NOVU identičnost posle svake optimističke izmene/refetch-a (npr. čekiranje
  // „Završeno" iz ovog istog dijaloga). Init sme da se odigra SAMO pri otvaranju i promeni
  // stavke — inače bi nesnimljen unos termina tiho pao na stare serverske vrednosti.
  const rowKey = `${row.work_order_id}:${row.line_id}`;
  const rowRef = useRef(row);
  rowRef.current = row;

  useEffect(() => {
    const r = rowRef.current;
    setStart(r.planned_start_at ? isoLocalMinute(new Date(r.planned_start_at)) : '');
    setEnd(r.planned_end_at ? isoLocalMinute(new Date(r.planned_end_at)) : '');
    setDur(hoursInputFromMinutes(r.planned_duration_minutes));
    setMachine(r.effective_machine_code ?? '');
    setPred(null);
  }, [rowKey, open]);

  /**
   * Pretraga prethodne operacije BEZ same stavke — samo-uslov je ciklus dužine 1 koji
   * backend ionako odbija (422 `predecessor_self_reference`); planeru se ne nudi.
   *
   * C1: čist BROJ (1–3 cifre) se tumači i kao REDNI BROJ stavke na ovoj mašini (Paket A
   * numeracija u gantu) — pogodak ide kao PRVI rezultat, i kad je serverska pretraga
   * ispod praga od 2 znaka (jednocifren broj). Tekstualna pretraga RN/crtež ostaje ispod.
   */
  const useOpsSearchBezSebe = (q: string) => {
    const res = useOperationsSearch(q);
    const data = useMemo(() => {
      const term = q.trim();
      const extra: OpRow[] = [];
      if (ordinals && /^\d{1,3}$/.test(term)) {
        const hit = ordinals.find((o) => o.broj === Number(term));
        if (hit && `${hit.row.work_order_id}:${hit.row.line_id}` !== rowKey) {
          // GanttRow nosi sva polja koja ComboBox/setPredecessor čitaju (id-jevi, RN,
          // operacija, crtež, naziv) — ostatak OpRow ugovora pokriva index-potpis.
          extra.push({ ...(hit.row as unknown as OpRow), __redni_broj: hit.broj });
        }
      }
      const list = (res.data?.data ?? []).filter(
        (o) =>
          `${o.work_order_id}:${o.line_id}` !== rowKey &&
          !extra.some((x) => x.work_order_id === o.work_order_id && x.line_id === o.line_id),
      );
      if (!res.data && extra.length === 0) return res.data;
      return { ...(res.data ?? {}), data: [...extra, ...list] };
    }, [res.data, rowKey, q, ordinals]);
    return { ...res, data };
  };

  const tech = technologyMinutes(row);
  const eff = effectiveMinutes(row);
  const ready = row.is_ready_for_machine === true;
  const done = row.is_completed_effective === true;
  // 069/26: nenadoknađen škart — BE kolona, uz FE fallback za stariji odgovor.
  const skart = scrapBadge(row);
  /**
   * Ima li pozicija MERLJIVU količinu (inače automatika pada na zastavicu kioska).
   * ⚠️ Uslovljeno i PRISUSTVOM kolone: frontend (Cloudflare) i backend (GH Actions) se
   * deployuju nezavisno, pa nekoliko minuta nov ekran priča sa starim serverom. Bez ovog
   * uslova bi u tom prozoru checkbox stajao štikliran „Završeno", a red ispod pisao
   * „Automatski: 0 / 100 dobrih kom." — dva odgovora na istom ekranu, tačno klasa greške
   * zbog koje 069 i postoji. Bez kolone se vraćamo na stari, istinit tekst.
   */
  const imaDobre = row.komada_done_good != null;
  const mereno = imaDobre && (row.komada_total ?? 0) > 0 && row.is_non_machining !== true;
  /**
   * 079/26 — broj crteža je link na PDF SAMO kad crtež postoji. Izmereno na produ
   * 05.08.2026: od 218 naloga u planu njih 107 (49 %) ima PDF sadržaj, pa bi bezuslovan
   * link na polovini pozicija vodio u prazno. `!== false` (a ne `=== true`) jer se
   * frontend (Cloudflare) i backend (GH Actions) deployuju nezavisno: dok BE još ne
   * vraća kolonu, `undefined` znači „ne znam" i link se nudi — promašaj tada uredno
   * javi „PDF nije pronađen" umesto da ekran tiho ostane bez funkcije. Isti obrazac
   * kao `hasPdf` u TP proceduri.
   */
  const hasPdf = row.has_bigtehn_drawing !== false && !!sanitizeDrawingNo(row.broj_crteza);
  const overrideDone = row.planned_done !== null && row.planned_done !== undefined;
  const manualReady = row.is_ready_manual === true;
  // Izračunata spremnost BEZ override-a (FE ogledalo BE `is_ready_rb` laterala): nema
  // prethodne blokirajuće operacije = 'none' (prva) ili 'completed' (sve otkucane).
  const computedReady =
    row.previous_operation_status === 'none' || row.previous_operation_status === 'completed';

  /**
   * Minuti za pravilo „kraj = početak + trajanje": kucani override → tehnologija →
   * 24 h (stavka bez tehnologije mora imati vidljiv bar; isti fallback kao `barEnd`).
   * Namerno NE gleda zatečeni override iz baze kad je polje ispražnjeno — prazno
   * polje znači „vrati na tehnologiju", pa i auto-kraj mora da prati tehnologiju.
   *
   * 076/26: polje nosi SATE, pa se ovde i pretvara u minute (`null` = prazno,
   * `NaN` = neispravan unos — oba padaju na tehnologiju dok se kuca).
   */
  function liveMinutes(durStr: string): number {
    const min = minutesFromHoursInput(durStr);
    if (min !== null && Number.isFinite(min)) return min;
    return tech > 0 ? tech : 24 * 60;
  }

  /** Izmena početka AUTOMATSKI preračuna kraj (Strahinjina primedba 2). */
  function changeStart(v: string) {
    setStart(v);
    if (v) setEnd(addMinutesLocal(v, liveMinutes(dur)));
  }

  /** Izmena trajanja AUTOMATSKI preračuna kraj (kraj = početak + trajanje). */
  function changeDur(v: string) {
    setDur(v);
    if (start) setEnd(addMinutesLocal(start, liveMinutes(v)));
  }

  /**
   * Snimanje termina (minutna granularnost). Kraj je TAČNO ono što stoji u polju —
   * auto-izračunat ili ručno kucan; trajanje se dodaje na početak SAMO kad je polje
   * kraja prazno. Nepromenjen minut zadržava zatečene sekunde (`keepIfSameMinute`),
   * pa je snimanje IDEMPOTENTNO: otvaranje dijaloga i „Sačuvaj termin" bez ijedne
   * izmene daje identičan interval (nasleđeni dan-kanon krajevi 23:59:59.999 prežive).
   */
  function saveTermini() {
    if (!start) {
      toast('⚠ Zadaj planirani početak (datum i vreme).');
      return;
    }
    // 076/26: polje je u SATIMA, upis u minutima (DTO je `@IsInt`) — v. `minutesFromHoursInput`.
    const durNum = minutesFromHoursInput(dur);
    if (durNum !== null && !Number.isFinite(durNum)) {
      toast('⚠ Trajanje se unosi u SATIMA, kao broj veći od 0 (npr. 2 ili 1,5).');
      return;
    }
    const startIso = keepIfSameMinute(row.planned_start_at, start) ?? new Date(start).toISOString();
    const startMs = new Date(startIso).getTime();
    let endIso: string;
    if (end) {
      const kept = keepIfSameMinute(row.planned_end_at, end);
      // Zatečene sekunde se odbacuju ako bi dale naopak interval (nasleđen loš podatak).
      endIso = kept && new Date(kept).getTime() >= startMs ? kept : new Date(end).toISOString();
    } else {
      endIso = new Date(startMs + liveMinutes(dur) * 60_000).toISOString();
    }
    if (new Date(endIso).getTime() < startMs) {
      toast('⚠ Kraj ne može biti pre početka — ispravi datum/vreme kraja (ili ga isprazni).');
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

  /**
   * 075/26 — „Pomeri lanac…": pomeri ovu poziciju I sve ispod nje u lancu za ukucan broj
   * CELIH dana. Ide ISKLJUČIVO kroz pregled (`dryRun`) pa potvrdu — put kucanja nema
   * gest koji bi rekao „ovoliko", pa planer mora da vidi šta tačno potpisuje.
   *
   * 🔴 `saveTermini` NAMERNO ne izvodi deltu sam od sebe: ono polje piše proizvoljan
   * `datetime-local` na MINUT, a kaskada radi u celim danima. Pomak koji nije ceo broj
   * dana odgurnuo bi ceo lanac u noć ili vikend (6 od 10 izmerenih pozitivnih razmaka su
   * upravo granica kalendara).
   */
  async function otvoriLanac() {
    const dana = Number(String(lanacDana).replace(',', '.'));
    if (!Number.isInteger(dana) || dana === 0) {
      toast('⚠ Pomak se zadaje kao CEO broj dana, različit od nule (npr. 5 ili -2).');
      return;
    }
    setLanacUcitava(true);
    const res = await ucitajPlanLanca(row.work_order_id, row.line_id, dana);
    setLanacUcitava(false);
    if ('greska' in res) {
      toast(`⚠ ${res.greska}`);
      return;
    }
    if (res.plan.ciklus) {
      toast(`⚠ Veze prave petlju (${res.plan.ciklus.ivica}) — razveži pa pomeri.`);
      return;
    }
    setLanacPlan(res.plan);
  }

  /**
   * Ručni override spremnosti (Strahinjin komentar uz 046/26): „DA" i kad prethodne
   * operacije nisu otkucane — fizički znamo da je pozicija spremna. POSTOJEĆI
   * `ready_override` mehanizam (isti kao „SPREMNO (override)" u tabu „Po mašini");
   * BE pečatira ko/kada, a `is_ready_for_machine = override OR izračunato`, pa boja
   * bara na gantu reaguje bez ijedne izmene canvas-a. Skidanje vraća izračunato.
   */
  function toggleReadyOverride(checked: boolean) {
    save.mutate({ workOrderId: row.work_order_id, lineId: row.line_id, readyOverride: checked });
  }

  return (
    <>
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
          <Fact
            label="Crtež"
            value={row.broj_crteza}
            onOpen={hasPdf ? () => void openBigtehnPdfTab(row.broj_crteza) : undefined}
          />
          <Fact label="RN" value={row.rn_ident_broj} />
          <Fact label="Predmet (sklop)" value={sklop(row)} />
          <Fact label="Kupac" value={row.customer_short ?? row.customer_name} />
          <Fact label="Faza obrade" value={`${String(row.operacija ?? '—')} · ${row.opis_rada ?? '—'}`} />
          <Fact label="Materijal" value={row.materijal} />
          <Fact label="Rok izrade" value={row.rok_izrade ? formatDate(row.rok_izrade) : null} />
          {/* 076/26: sati su sada MERA u kojoj planer kuca, pa idu prvi; minuti ostaju
              uz njih (baza je u minutima). Decimalni zarez — kanon dizajn sistema. */}
          <Fact
            label="Tehnologija (TPZ + TK × kom)"
            value={tech > 0 ? `${hoursLabel(tech)} (${tech} min)` : null}
          />
          {/* 069/26: „Urađeno" pokazuje DOBRE komade, jer se po njima sudi gotovost.
              Bez toga bi pozicija sa škartom pisala „100 / 100" a stajala bez kvačice —
              što je za planera kvar, a ne objašnjenje. Zbir svih kvaliteta se NE gubi:
              dobija svoj red („Otkucano") čim se razlikuje, pa dva ekrana koja broje
              različito imaju oba broja jedan pored drugog, umesto da se ćutke raziđu.
              Bez BE kolone (stariji odgovor) vraća se stara, istinita etiketa. */}
          {imaDobre ? (
            <Fact label="Urađeno (dobri)" value={`${row.komada_done_good} / ${row.komada_total ?? 0} kom`} />
          ) : (
            <Fact label="Urađeno" value={`${row.komada_done ?? 0} / ${row.komada_total ?? 0} kom`} />
          )}
          {imaDobre && (row.komada_done ?? 0) !== row.komada_done_good ? (
            <Fact label="Otkucano (svi kvaliteti)" value={`${row.komada_done ?? 0} kom`} />
          ) : null}
          {(row.scrap_pieces ?? 0) > 0 ? (
            <Fact label="Škart" value={`${row.scrap_pieces} kom${skart ? ' · nije nadoknađen' : ''}`} />
          ) : null}
          {(row.rework_pieces ?? 0) > 0 ? <Fact label="Dorada" value={`${row.rework_pieces} kom`} /> : null}
          <Fact label="Ručni redosled smene" value={row.shift_sort_order != null ? `#${row.shift_sort_order}` : 'auto'} />
        </div>

        {/* ── Spremnost (prikaz; kanon je BE) + ručni override (Paket B) ── */}
        <div
          className={cn(
            'rounded-panel border px-3 py-2 text-sm',
            ready
              ? 'border-status-success/40 bg-status-success-bg'
              : 'border-status-danger/40 bg-status-danger-bg',
          )}
        >
          <div className={cn('flex items-center gap-2', ready ? 'text-status-success' : 'text-status-danger')}>
            <span className="font-semibold">Spremnost: {ready ? 'DA' : 'NE'}</span>
            <span className="text-ink-secondary">· {readyReason(row)}</span>
            {row.is_urgent ? <span className="ml-auto font-semibold">HITNO</span> : null}
          </div>
          <label className="mt-1.5 flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={manualReady}
              onChange={(e) => toggleReadyOverride(e.target.checked)}
            />
            Označi kao spremno (ručno)
          </label>
          <p className="mt-0.5 text-2xs text-ink-secondary">
            {manualReady ? (
              <>
                Ručni override
                {row.ready_override_by ? ` · ${row.ready_override_by}` : ''}
                {row.ready_override_at ? ` · ${formatDateTime(row.ready_override_at)}` : ''} — izračunato
                (bez override-a): {computedReady ? 'DA' : 'NE'} ·{' '}
                {readyReason({ ...row, is_ready_for_machine: computedReady, is_ready_manual: false })}. Skidanje
                override-a vraća izračunato.
              </>
            ) : (
              <>Izračunato iz prethodnih operacija. Štikliraj kad je pozicija fizički spremna, a sistem to još ne vidi.</>
            )}
          </p>
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

          {/* 076/26: polje prima SATE (2 → 120 min). `type="text"` + `inputMode="decimal"`
              JER `input[type=number]` odbacuje srpski decimalni zarez — „1,5" bi u njemu
              stiglo kao prazna vrednost, pa bi polje ćutke gutalo pola unosa. Nema više ni
              `min={1}`: minimum je jedan MINUT, a ne jedan sat. */}
          <Field label="Trajanje (h) — override">
            <input
              type="text"
              inputMode="decimal"
              value={dur}
              onChange={(e) => changeDur(e.target.value)}
              placeholder={hoursInputFromMinutes(tech || null)}
              aria-label="Trajanje u satima (override)"
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink tnums"
            />
            <p className="mt-1 text-2xs text-ink-disabled">
              Unosi se u <strong>satima</strong> (2 = 2 h = 120 min; decimalni zarez: 1,5 = 90 min).
              Prazno = iz tehnologije ({hoursLabel(tech)} = {tech} min). Trenutno u primeni:{' '}
              {hoursLabel(eff)} = {eff} min. Izmena odmah preračunava planirani kraj.
            </p>
          </Field>

          <Field label="Planirani početak">
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => changeStart(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
            <p className="mt-1 text-2xs text-ink-disabled">
              Datum i vreme (sati:minuti). Izmena pomera kraj: kraj = početak + trajanje.
            </p>
          </Field>

          <Field label="Planirani kraj">
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
            <p className="mt-1 text-2xs text-ink-disabled">
              Automatski: početak + trajanje (i preko ponoći). Ručno kucan kraj važi doslovno — dok ponovo ne
              promeniš početak ili trajanje. Prazno = izračunato pri snimanju.
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
                getSublabel={(o) => {
                  // C1: pogodak po rednom broju nosi marker — planer vidi ZAŠTO je prvi.
                  const rb = typeof o.__redni_broj === 'number' ? `#${o.__redni_broj} na ovoj mašini · ` : '';
                  return `${rb}${o.broj_crteza ?? ''} ${o.naziv_dela ?? ''}`.trim();
                }}
                placeholder={ordinals ? 'Traži RN / crtež — ili redni broj…' : 'Traži RN / crtež…'}
              />
            )}
            {/* 075/26: F2 je ISPORUČEN — tekst mora da opiše stvarno ponašanje.
                Ranije je pisalo „Ne pomera termine automatski — to je F2." */}
            <p className="mt-1 text-2xs text-ink-disabled">
              Ručna FS veza (počinje posle završetka). Prevlačenje bara pomera i sve pozicije
              ispod u lancu za isti broj dana.
              {ordinals ? ' Možeš ukucati i redni broj stavke sa ove mašine (npr. 3).' : null}
              {' '}Vezu praviš i prevlačenjem kružića sa kraja bara na drugi bar u gantu.
            </p>
            {/* 075/26 — kaskada i iz kartice: unos u CELIM danima, pa pregled pa potvrda. */}
            {row.planned_start_at ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={lanacDana}
                  onChange={(e) => setLanacDana(e.target.value)}
                  aria-label="Pomak lanca u danima"
                  className="h-8 w-16 rounded-control border border-line bg-surface px-2 text-sm text-ink tnums"
                />
                <span className="text-2xs text-ink-disabled">dana</span>
                <Button
                  variant="secondary"
                  className="h-8 px-3 text-xs"
                  loading={lanacUcitava}
                  onClick={() => void otvoriLanac()}
                >
                  Pomeri lanac…
                </Button>
              </div>
            ) : null}
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
              ) : mereno ? (
                // 069/26: objašnjenje MORA da prati pravilo. Dok je pisalo „iz kucanja
                // operatera", planer je čitao staru zastavicu („neko je pritisnuo Kraj
                // rada") dok je kvačica već sudila po količini — dva različita odgovora
                // na istom ekranu.
                <>
                  Automatski: {row.komada_done_good ?? 0} / {row.komada_total} dobrih kom
                  {skart ? ` · škart ${row.scrap_pieces} kom nije nadoknađen` : ''}.
                </>
              ) : (
                <>
                  Automatski iz kucanja operatera ({row.is_done_in_bigtehn ? 'otkucano' : 'još nije otkucano'})
                  {' '}— pozicija nema merljivu količinu.
                </>
              )}
            </p>
          </Field>
        </div>
      </div>
    </Dialog>
    {/* 075/26 — potvrda kaskade iz kartice. SIBLING dijaloga stavke (ne dete), da
        `Esc` sloj i stacking budu isti kao kod svakog drugog modala; kartica ostaje
        otvorena ispod, a po uspehu se zatvara i ona — termini koje prikazuje su
        upravo promenjeni, pa bi inače prikazivala staro stanje. */}
    {lanacPlan && (
      <GantLanacDialog
        open
        plan={lanacPlan}
        nevidljivih={0}
        onClose={() => setLanacPlan(null)}
        onDone={(p) => {
          setLanacPlan(null);
          toast(
            `✓ Pomereno ${p.totals.pomereno}${p.totals.preskoceno > 0 ? ` · preskočeno ${p.totals.preskoceno}` : ''}`,
          );
          onClose();
        }}
      />
    )}
    </>
  );
}

/**
 * Jedan AUTO podatak (etiketa + vrednost). Uz `onOpen` vrednost postaje dugme-link
 * (079/26 — broj crteža otvara PDF u novom tabu); bez njega ostaje običan tekst, pa
 * pozicija bez crteža izgleda kao i do sada, umesto da nudi link koji ne vodi nikuda.
 * Izgled dugmeta = isti kao „Crtež" u TP proceduri (ikonica + akcentni tekst).
 */
function Fact({
  label,
  value,
  onOpen,
}: {
  label: string;
  value: string | number | null | undefined;
  onOpen?: () => void;
}) {
  const text = value != null && value !== '' ? String(value) : '—';
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-ink-disabled">{label}</div>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex max-w-full items-center gap-1 rounded-control text-accent hover:underline"
          title="Otvori PDF crteža u novom tabu"
        >
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{text}</span>
        </button>
      ) : (
        <div className="truncate text-ink" title={value != null ? String(value) : undefined}>
          {text}
        </div>
      )}
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

/**
 * Sklop kome pozicija pripada — C2 (046/26): BE `sklop_naziv` po 053 strukturi praćenja
 * (override → auto sastavnica; virtuelni sklop = naziv iz šifrarnika). Fallback za red
 * bez sklopa/stariji BE = prvi segment RN ident broja (kanon „broj predmeta/TP/varijanta").
 */
function sklop(row: GanttRow): string | null {
  if (row.sklop_naziv) {
    return `${row.sklop_naziv}${row.sklop_rn_ident ? ` (${row.sklop_rn_ident})` : ''}`;
  }
  const rn = row.rn_ident_broj;
  if (!rn) return null;
  const first = String(rn).split(/[-/]/)[0]?.trim();
  return first || null;
}
