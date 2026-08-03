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
 * dodavanje (npr. „završeno (21/200 kom)" kad je operater otkucao kraj procesa na
 * delimičnoj količini), umesto da tiho nestanu (A5). Škart/dorada klonovi se poznaju po
 * sufiksu -S# u RN-u i nikad ne zaklanjaju seriju — sortirano po RN + operaciji.
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
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows.slice(0, 300);
    const local = rows.filter((r) =>
      [r.rn_ident_broj, r.broj_crteza, r.naziv_dela, r.effective_machine_code]
        .some((v) => String(v ?? '').toLowerCase().includes(t)),
    );
    const server = t === serverQ.toLowerCase() ? search.data?.data : undefined;
    if (!server) return local.slice(0, 300);
    const seen = new Set(server.map(rowKey));
    return [...server, ...local.filter((r) => !seen.has(rowKey(r)))].slice(0, 300);
  }, [rows, q, serverQ, search.data]);

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
                        <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => add(r)}>
                          <Plus className="h-3.5 w-3.5" aria-hidden /> Dodaj
                        </Button>
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
                        : 'Ništa nije pronađeno — proveri broj crteža / RN.'
                      : 'Nema učitanih stavki van plana — ukucaj crtež ili RN za pretragu po celoj bazi.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-ink-disabled">
          Prikazano najviše 300 stavki. Pretraga (crtež / RN / naziv) ide po celoj bazi i
          prikazuje i završene / zatvorene operacije sa razlogom zašto nisu za dodavanje;
          škart/dorada klonovi nose sufiks -S# u RN-u.
          {search.isFetching ? ' Tražim…' : ''}
        </p>
      </div>
    </Dialog>
  );
}

type Stanje = { addable: true; label?: never; ok?: never } | { addable: false; label: string; ok?: boolean };

/**
 * Zašto stavka (ni)je za dodavanje. Redosled presuđivanja: već na planu → završeno
 * (operater otkucao kraj procesa — i na delimičnoj količini, zato se prikazuje X/Y kom)
 * → RN zatvoren → kooperacija → arhivirana. Sve ostalo je otvorena operacija sa „Dodaj".
 */
function stanjeStavke(r: GanttRow, added: boolean): Stanje {
  if (added || r.planned_start_at) return { addable: false, label: '✓ na planu', ok: true };
  if (r.is_completed_effective || r.is_done_in_bigtehn || r.local_status === 'completed')
    return { addable: false, label: `završeno (${r.komada_done ?? 0}/${r.komada_total ?? 0} kom)` };
  if (r.rn_zavrsen) return { addable: false, label: 'RN završen' };
  if (r.is_cooperation_effective) return { addable: false, label: 'u kooperaciji' };
  if (r.overlay_archived_at) return { addable: false, label: 'arhivirano' };
  return { addable: true };
}
