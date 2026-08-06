'use client';

import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import {
  useGanttOverlay,
  useGanttReassign,
  useGanttSearchAll,
  useMachines,
  type GanttRow,
} from '@/api/plan-proizvodnje';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { effectiveMinutes, isoDay, rowKey, toIsoAtWorkStart } from './gant-utils';

/**
 * „Dodaj na plan" (zahtev 046/26) — iz liste operacija KOJE NISU na gantu postavi se
 * planirani početak; kraj se izvodi iz trajanja (override ili TPZ + TK × kom). Tek time
 * stavka dobija bar na osi (`planned_start_at IS NOT NULL`).
 *
 * A4 (Strahinjine primedbe): pretraga je SERVER-side po celoj bazi (`scope=sve`), ne po
 * učitanom feed-u. Feed je LIMIT 5000 (prod 03.08.2026: 16.394 kandidata → manje od
 * trećine učitano) i sužen aktivnim filterima taba, pa je klijentska pretraga tiho
 * promašivala otvorene operacije (crtež 1083492: škart-klon vidljiv, serija ne). Server
 * pretraga vraća i završene/zatvorene/kooperaciju — prikazane SA RAZLOGOM zašto nisu za
 * dodavanje, umesto da tiho nestanu (A5). Izuzetak 064/26: „završena" operacija sa
 * NEPOTPUNOM količinom na otvorenom RN-u se IPAK može dodati, uz upozorenje — v.
 * `stanjeStavke`. Škart/dorada klonovi se poznaju po sufiksu -S# u RN-u i nikad ne
 * zaklanjaju seriju — sortirano po RN + operaciji.
 *
 * A6: mašina se menja PO STAVCI pre dodavanja (olovka u koloni Mašina) — isti mehanizam
 * i permisije kao detalj-dijalog (`/reassign`: guard grupe mašina + audit; druga grupa i
 * dalje traži prinudni premeštaj kroz tab „Po mašini").
 *
 * Ne dira ručni redosled smene (`shift_sort_order`) — gant je paralelan pogled.
 */
export function DodajNaPlanDialog({
  open,
  onClose,
  rows,
  defaultDay,
}: {
  open: boolean;
  onClose: () => void;
  rows: GanttRow[];
  defaultDay: Date;
}) {
  const save = useGanttOverlay();
  const reassign = useGanttReassign();
  const machines = useMachines();
  const [day, setDay] = useState(() => isoDay(defaultDay));
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());
  /** rowKey stavke čija se mašina trenutno menja (A6) — najviše jedan editor otvoren. */
  const [editKey, setEditKey] = useState<string | null>(null);

  // Debounce server pretrage: kucanje ne sme da ispali upit po slovu (inner query nad
  // work_order_operations je skup). TanStack keš po termu čuva ponovljene pretrage.
  const [serverQ, setServerQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setServerQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const search = useGanttSearchAll(serverQ);

  /**
   * Bez terma: učitani nedodati redovi (brzo listanje). Sa termom: server rezultat
   * (kompletan, svi statusi) + lokalni pogoci koji nisu u njemu (pokriva i pretragu po
   * šifri mašine, koju server ILIKE ne gleda). Guard `t === serverQ` sprečava mešanje
   * sveže ukucanog terma sa zaostalim server rezultatom prethodnog terma.
   */
  /** Server rezultat odgovara BAŠ ovom termu (ne zaostatku prethodnog iz debounce-a). */
  const serverAktivan = serverQ.length >= 2 && q.trim().toLowerCase() === serverQ.toLowerCase();

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows.slice(0, 300);
    const local = rows.filter((r) =>
      [r.rn_ident_broj, r.broj_crteza, r.naziv_dela, r.effective_machine_code]
        .some((v) => String(v ?? '').toLowerCase().includes(t)),
    );
    const server = serverAktivan ? search.data?.data : undefined;
    if (!server) return local.slice(0, 300);
    const seen = new Set(server.map(rowKey));
    return [...server, ...local.filter((r) => !seen.has(rowKey(r)))].slice(0, 300);
  }, [rows, q, serverAktivan, search.data]);

  function add(r: GanttRow) {
    const startIso = toIsoAtWorkStart(day);
    const min = effectiveMinutes(r);
    save.mutate(
      {
        workOrderId: r.work_order_id,
        lineId: r.line_id,
        plannedStartAt: startIso,
        plannedEndAt: new Date(new Date(startIso).getTime() + (min > 0 ? min : 24 * 60) * 60_000).toISOString(),
      },
      { onSuccess: () => setAdded((s) => new Set(s).add(rowKey(r))) },
    );
  }

  /** A6: promena mašine pre dodavanja — isti tok/poruke kao detalj-dijalog. */
  function promeniMasinu(r: GanttRow, code: string) {
    setEditKey(null);
    if (!code || code === r.effective_machine_code) return;
    reassign.mutate(
      { workOrderId: r.work_order_id, lineId: r.line_id, targetMachine: code },
      {
        onSuccess: () => toast('✓ Mašina promenjena'),
        onError: (e) => {
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodaj stavke na plan"
      size="xl"
      footer={
        <div className="ml-auto">
          <Button onClick={onClose}>Gotovo</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-ink-secondary">Termin (početak)</label>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Traži po RN / crtežu / nazivu / mašini"
            aria-label="Pretraga stavki"
            className="h-9 flex-1 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
          />
        </div>

        <div className="max-h-[55vh] overflow-auto rounded-panel border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
              <tr>
                <th className="px-3 py-1.5 text-left">RN</th>
                <th className="px-3 py-1.5 text-left">Pozicija</th>
                <th className="px-3 py-1.5 text-left">Operacija</th>
                <th className="px-3 py-1.5 text-left">Mašina</th>
                <th className="px-3 py-1.5 text-right">Kom</th>
                <th className="px-3 py-1.5 text-right">Trajanje</th>
                <th className="px-3 py-1.5 text-left">Rok</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const key = rowKey(r);
                const st = stanjeStavke(r, added.has(key));
                const min = effectiveMinutes(r);
                return (
                  <tr key={key} className="border-b border-line-soft">
                    <td className="tnums px-3 py-1.5">{r.rn_ident_broj ?? '—'}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5" title={r.naziv_dela ?? ''}>
                      {r.naziv_dela ?? r.broj_crteza ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      {String(r.operacija ?? '—')} · {r.opis_rada ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      {!st.addable ? (
                        r.effective_machine_code ?? '—'
                      ) : editKey === key ? (
                        <select
                          autoFocus
                          aria-label="Promeni mašinu"
                          value={r.effective_machine_code ?? ''}
                          onChange={(e) => promeniMasinu(r, e.target.value)}
                          onBlur={() => setEditKey(null)}
                          className="h-7 w-44 rounded-control border border-line bg-surface px-1 text-xs text-ink"
                        >
                          {(machines.data?.data ?? []).map((m) => (
                            <option key={m.rj_code} value={m.rj_code}>
                              {m.rj_code}
                              {m.name ? ` · ${m.name}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditKey(key)}
                          title="Promeni mašinu pre dodavanja"
                          className="inline-flex items-center gap-1 rounded-control px-1 py-0.5 text-ink hover:bg-surface-2 hover:text-accent"
                        >
                          {r.effective_machine_code ?? '—'}
                          <Pencil className="h-3 w-3 text-ink-disabled" aria-hidden />
                        </button>
                      )}
                    </td>
                    <td className="tnums px-3 py-1.5 text-right">{r.komada_total ?? 0}</td>
                    <td className="tnums px-3 py-1.5 text-right">{min} min</td>
                    <td className="px-3 py-1.5">{r.rok_izrade ? formatDate(r.rok_izrade) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">
                      {st.addable ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => add(r)}>
                            <Plus className="h-3.5 w-3.5" aria-hidden /> Dodaj
                          </Button>
                          {st.warn ? (
                            <span className="whitespace-nowrap text-2xs text-status-warn">{st.warn}</span>
                          ) : null}
                        </div>
                      ) : (
                        <span className={cn('whitespace-nowrap text-2xs', st.ok ? 'text-status-success' : 'text-ink-disabled')}>
                          {st.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-sm text-ink-disabled">
                    {q.trim().length >= 2
                      ? search.isFetching
                        ? 'Tražim po celoj bazi…'
                        : search.isError
                          ? 'Pretraga po celoj bazi nije uspela — pokušaj ponovo.'
                          : 'Ništa nije pronađeno — proveri broj crteža / RN.'
                      : 'Nema učitanih stavki van plana — ukucaj crtež ili RN za pretragu po celoj bazi.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {/* Pad server pretrage NE sme da izgleda kao „nema pogodaka" — pošten razlog + retry
            (lokalni pogoci iz učitanog feed-a ostaju u tabeli, pa obaveštenje ide i uz redove). */}
        {q.trim().length >= 2 && search.isError ? (
          <p className="text-2xs text-status-danger">
            ⚠ Pretraga po celoj bazi nije uspela — prikazani su samo učitani redovi.{' '}
            <button
              type="button"
              className="underline hover:text-accent"
              onClick={() => void search.refetch()}
            >
              Pokušaj ponovo
            </button>
          </p>
        ) : null}
        {/* BE seče na meta.limit (izmereno: q='00' → 22.861 pogodaka) — bez ovog upozorenja
            planer misli da vidi sve. `serverAktivan` čuva od banera zaostalog terma. */}
        {serverAktivan && search.data?.meta?.truncated ? (
          <p className="text-2xs text-status-warn">
            Pretraga pogađa više od {search.data.meta.limit} stavki — prikazan je samo deo;
            suzi pretragu.
          </p>
        ) : null}
        <p className="text-2xs text-ink-disabled">
          Prikazano najviše 300 stavki. Pretraga (crtež / RN / naziv) ide po celoj bazi i
          prikazuje i završene / zatvorene operacije sa razlogom zašto nisu za dodavanje;
          operacija završena na delu količine (otvoren RN) može se dodati uz upozorenje;
          škart/dorada klonovi nose sufiks -S# u RN-u.
          {search.isFetching ? ' Tražim…' : ''}
        </p>
      </div>
    </Dialog>
  );
}

type Stanje =
  | { addable: true; warn?: string; label?: never; ok?: never }
  | { addable: false; warn?: never; label: string; ok?: boolean };

/**
 * Zašto stavka (ni)je za dodavanje. Redosled presuđivanja: već na planu → završeno
 * → RN zatvoren → RN kroz završnu kontrolu → kooperacija → arhivirana. Sve ostalo je
 * otvorena operacija sa „Dodaj".
 *
 * 064/26 (Nenad presudio 04.08.2026, opcija A): „završena" operacija sa NEPOTPUNOM
 * količinom na OTVORENOM RN-u dobija ŽIVO „Dodaj" + upozorenje „završeno na X/Y kom —
 * dodaje se svejedno". Pogon kuca „Kraj rada" na kiosku kao kraj SMENE, ne kraj
 * operacije (izmereno na produ 04.08.2026: 1.039 op / 420 RN blokirano delimičnim
 * krajem procesa; 597/1.084 op ima rad NASTAVLJEN posle zatvaranja — slučaj 1119578:
 * „završeno (0/1 kom)" a radnik i dalje radi na njoj). Izuzetak je NAMERNO uzak:
 * otvara ga SAMO kucanje operatera (`is_done_in_bigtehn`) — planerski pečati
 * (`planned_done`, `local_status='completed'`), puna količina, RN završen / kroz
 * završnu kontrolu, kooperacija i arhiva blokiraju kao i do sada. Kanon „završene
 * operacije" (bool_or nad tech_processes) se NE menja — ostali ekrani netaknuti;
 * sistemska presuda kanona je otvoreno pitanje 046 #109 (Strahinja/Negovan).
 *
 * `plan_rn_final_control_done` (M6): scope=sve pretraga skida i EFF_FILTER, pa RN koji
 * je prošao završnu kontrolu stiže ovde i sa NEOTKUCANIM operacijama — bez ove grane
 * takva operacija bi dobila živ „Dodaj" i planer bi isplanirao gotov RN (izmereno na
 * produ 03.08.2026: 537 operacija u tom stanju).
 *
 * 069/26: količina se meri DOBRIM komadima, isto kao gotovost u gantu. Bez toga bi se
 * dva ekrana protivrečila baš u slučaju zbog kog 069 i postoji: pozicija sa 5 škarta od
 * 100 nosi na gantu oznaku „ŠKART" (fali 5 dobrih), a picker bi je odbio sa „završeno
 * (100/100 kom)" — dakle planer vidi da nešto fali, a ne može to da isplanira. Izmereno
 * na produ 05.08.2026: 4 takve pozicije danas, ali svaki budući škart pada u istu klasu.
 * Smer greške je bezbedan: širi se SAMO na pozicije kojima po novom kanonu fali dobrih.
 */
function stanjeStavke(r: GanttRow, added: boolean): Stanje {
  if (added || r.planned_start_at) return { addable: false, label: '✓ na planu', ok: true };
  const plannerDone = r.planned_done === true || r.local_status === 'completed';
  if (r.is_completed_effective || r.is_done_in_bigtehn || plannerDone) {
    const total = r.komada_total ?? 0;
    // `?? komada_done` = stariji BE odgovor bez 069 kolone (CF deploy je nezavisan).
    const done = r.komada_done_good ?? r.komada_done ?? 0;
    const delimicnoNaOtvorenom =
      r.is_done_in_bigtehn === true && !plannerDone && total > 0 && done < total &&
      !r.rn_zavrsen && !r.plan_rn_final_control_done &&
      !r.is_cooperation_effective && !r.overlay_archived_at;
    if (delimicnoNaOtvorenom)
      return { addable: true, warn: `završeno na ${done}/${total} kom — dodaje se svejedno` };
    return { addable: false, label: `završeno (${done}/${total} kom)` };
  }
  if (r.rn_zavrsen) return { addable: false, label: 'RN završen' };
  if (r.plan_rn_final_control_done) return { addable: false, label: 'RN kroz završnu kontrolu' };
  if (r.is_cooperation_effective) return { addable: false, label: 'u kooperaciji' };
  if (r.overlay_archived_at) return { addable: false, label: 'arhivirano' };
  return { addable: true };
}
