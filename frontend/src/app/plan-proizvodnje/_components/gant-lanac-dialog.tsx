'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CornerDownRight } from 'lucide-react';
import { newClientId } from '@/api/plan-montaze';
import {
  ganttShiftChainPreview,
  useGanttShiftChain,
  type ShiftChainPlan,
} from '@/api/plan-proizvodnje';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDateTime } from '@/lib/format';
import { overlayErrorMessage } from './gant-utils';

/**
 * Potvrda kaskadnog pomeranja lanca (zahtev 075/26 — F2 iz 046/26).
 *
 * Otvara se SAMO kad gest nije očigledan: dugačak lanac (> 8 pozicija), lanac koji
 * dodiruje ZAVRŠENU poziciju, ili prikaz u kom FE ne vidi ceo lanac (aktivan filter,
 * odsečen feed, čvor van iscrtanih redova). Kratko prevlačenje ide bez ijednog klika —
 * v. `gantt-tab.tsx` `onUp`.
 *
 * Dijalog prikazuje PLAN sa servera (`dryRun`), ne sopstveni račun: `stavke[].new_start`
 * je izračunat ISTIM SQL izrazom kojim će se i upisati, pa ono što planer potvrdi jeste
 * ono što se dogodi. Potvrda šalje `expectedHash` iz tog plana — ako se plan u
 * međuvremenu promenio, server vraća 409 sa SVEŽIM planom i dijalog se prerenderuje bez
 * drugog poziva.
 */
export function GantLanacDialog({
  open,
  plan: planProp,
  /** Koliko stavki plana NIJE iscrtano na ekranu (računa tab nad `layoutRows`). */
  nevidljivih,
  onClose,
  onDone,
}: {
  open: boolean;
  plan: ShiftChainPlan;
  nevidljivih: number;
  onClose: () => void;
  onDone: (plan: ShiftChainPlan) => void;
}) {
  const shift = useGanttShiftChain();
  const [plan, setPlan] = useState<ShiftChainPlan>(planProp);
  const [zastarelo, setZastarelo] = useState(false);
  // Ključ idempotencije se kuje pri OTVARANJU (i posle 409, uz svež plan) — ne u
  // `mutationFn`: retry React Query-ja ponavlja iste varijable, pa ključ mora tu.
  const [eventId, setEventId] = useState(() => newClientId());

  useEffect(() => {
    setPlan(planProp);
    setZastarelo(false);
    setEventId(newClientId());
  }, [planProp]);

  function pomeri() {
    shift.mutate(
      {
        workOrderId: plan.sidro?.work_order_id ?? '',
        lineId: plan.sidro?.line_id ?? '',
        deltaDays: plan.delta_dana,
        clientEventId: eventId,
        expectedHash: plan.hash,
      },
      {
        onSuccess: (r) => {
          onDone(r.data);
          onClose();
        },
        onError: (e) => {
          // 409 nosi SVEŽ plan u telu — prerenderuj bez drugog poziva.
          const body = e instanceof ApiError ? (e.body as { plan?: ShiftChainPlan } | null) : null;
          if (body?.plan) {
            setPlan(body.plan);
            setZastarelo(true);
            setEventId(newClientId());
            return;
          }
          onClose();
        },
      },
    );
  }

  const dani = plan.delta_dana;
  const smer = dani > 0 ? `+${dani}` : String(dani);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Pomeriti lanac za ${smer} ${danLabel(dani)}? — ${plan.totals.pomereno} ${pozicijaLabel(plan.totals.pomereno)}`}
      size="xl"
      dismissable={false}
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose} disabled={shift.isPending}>
            Odustani
          </Button>
          {/* Onemogućeno dok traje upis — dvoklik bi dao DVOSTRUKU deltu. */}
          <Button onClick={pomeri} loading={shift.isPending} disabled={shift.isPending}>
            Pomeri
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {zastarelo ? (
          <p className="flex items-start gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Plan se u međuvremenu promenio — pogledaj ponovo pre potvrde.
          </p>
        ) : null}

        <p className="text-2xs text-ink-secondary">
          Sve pozicije se pomeraju za <b>isti broj dana</b> — razmaci između njih ostaju
          nepromenjeni. Redosled na mašini će se preurediti: ređanje je po terminu.
          {nevidljivih > 0
            ? ` ${nevidljivih} ${pozicijaLabel(nevidljivih)} nije prikazano na ekranu (van prozora ili van 300 iscrtanih redova).`
            : ''}
        </p>

        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
              <tr>
                <th className="px-2 py-1.5 text-left">RN</th>
                <th className="px-2 py-1.5 text-left">Op.</th>
                <th className="px-2 py-1.5 text-left">Crtež</th>
                <th className="px-2 py-1.5 text-left">Mašina</th>
                <th className="px-2 py-1.5 text-left">Početak</th>
                <th className="px-2 py-1.5 text-left">Novi početak</th>
              </tr>
            </thead>
            <tbody>
              {plan.stavke.map((s, i) => (
                <tr
                  key={`${s.work_order_id}:${s.line_id}`}
                  className={
                    // Sidro (prvi red) je vizuelno odvojeno — to je pozicija koju je
                    // planer stvarno uhvatio, ostalo je posledica.
                    i === 0
                      ? 'border-b-2 border-line bg-surface-2/60 font-medium'
                      : 'border-b border-line-soft'
                  }
                >
                  <td className="px-2 py-1 tnums">
                    <span style={{ paddingLeft: uvlacenje(s.dubina) }} className="inline-flex items-center gap-1">
                      {s.dubina > 0 ? (
                        <CornerDownRight className="h-3 w-3 shrink-0 text-ink-disabled" aria-hidden />
                      ) : null}
                      {s.rn_ident_broj ?? s.work_order_id}
                    </span>
                  </td>
                  <td className="px-2 py-1 tnums">{String(s.operacija ?? '—')}</td>
                  <td className="px-2 py-1">{s.broj_crteza ?? '—'}</td>
                  <td className="px-2 py-1">{s.machine ?? '—'}</td>
                  <td className="px-2 py-1 tnums text-ink-secondary">
                    {s.planned_start_at ? formatDateTime(s.planned_start_at) : '—'}
                  </td>
                  <td className="px-2 py-1 tnums font-medium text-accent">
                    {s.new_start ? formatDateTime(s.new_start) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {plan.preskoceno.length > 0 ? (
          <div>
            <div className="mb-1 text-xs font-medium text-ink-secondary">Neće se pomeriti</div>
            <ul className="space-y-0.5 rounded-panel border border-line bg-surface-2 px-3 py-2 text-2xs text-ink-secondary">
              {plan.preskoceno.map((s) => (
                <li key={`${s.work_order_id}:${s.line_id}`} className="flex gap-2">
                  <span className="tnums">
                    {s.rn_ident_broj ?? s.work_order_id} · op. {String(s.operacija ?? '—')}
                  </span>
                  <span className="text-ink-disabled">— {s.razlog}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Uvlačenje po dubini u lancu (px) — plitko, da tabela ostane čitljiva i na 16 nivoa. */
function uvlacenje(dubina: number): number {
  return Math.min(dubina, 8) * 10;
}

function danLabel(n: number): string {
  return Math.abs(n) === 1 ? 'dan' : 'dana';
}

function pozicijaLabel(n: number): string {
  return n === 1 ? 'pozicija' : 'pozicija';
}

/**
 * Pregled kaskade za put kroz DIJALOG (dugme „Pomeri lanac…" u kartici pozicije i
 * neizvestan potez u gantu). Vraća plan ili poruku greške na srpskom — pozivalac
 * odlučuje da li otvara dijalog ili diže toast.
 */
export async function ucitajPlanLanca(
  workOrderId: string,
  lineId: string,
  deltaDays: number,
): Promise<{ plan: ShiftChainPlan } | { greska: string }> {
  try {
    const r = await ganttShiftChainPreview({ workOrderId, lineId, deltaDays });
    return { plan: r.data };
  } catch (e) {
    return { greska: overlayErrorMessage(e) ?? 'Pregled lanca nije uspeo.' };
  }
}
