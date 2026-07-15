'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListChecks, LogOut, RotateCcw, UserRound } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/api/client';
import {
  useControl,
  useDecodeBarcode,
  useIdentifyWorker,
  useLabelData,
  useMyOpen,
  useOpenSession,
  useScan,
  useStartWork,
  useStopWork,
  useWorkerMe,
  type KioskDrawingRef,
  type KioskWorker,
  type KioskWorkOrder,
  type OperationBarcodeFields,
  type OrderBarcodeFields,
} from '@/api/kiosk';
import { useTechProcessCard } from '@/api/tech-processes';
import { printControlLabels } from '@/lib/label-print';
import { formatDate, formatNumber } from '@/lib/format';
import { ScanField } from './scan-field';
import { BigMessage, type MessageTone } from './big-message';
import { WorkPanel } from './work-panel';
import { ControlPanel, type ControlSubmit } from './control-panel';
import { ReprintPanel } from './reprint-panel';
import { MyOpenPanel } from './my-open-panel';

interface OrderState {
  raw: string;
  fields: OrderBarcodeFields;
  workOrder: KioskWorkOrder | null;
  operationCount: number;
  /** Routing RN-a — operacija je validna i kad tech_processes red još ne postoji. */
  routing: { operationNumber: number; workCenterCode: string }[];
}
interface OperationState {
  raw: string;
  fields: OperationBarcodeFields;
  /** true = završna kontrola (operations.significantForFinishing) → KONTROLA režim. */
  finalControl: boolean;
  workCenterName: string | null;
  /** true = operacija bez postupka (opšti nalog) — uvek otvorena; nikad „Zatvorena". */
  withoutProcess: boolean;
}
type Feedback = { tone: MessageTone; title: string; detail?: string };

/** Deljeni terminal: posle uspešnog kucanja radnik se auto-odjavi (sledeći može da se prijavi). */
const AUTO_LOGOUT_SECONDS = 20;

function errMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return 'Nepoznata greška — pokušajte ponovo.';
}

function OrderHeadline({ order }: { order: OrderState }) {
  const wo = order.workOrder;
  return (
    <div className="rounded-panel border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          Radni nalog
        </span>
        <span className="tnums text-4xl font-bold text-ink">{order.fields.identNumber}</span>
        {wo?.partName && <span className="text-2xl text-ink">{wo.partName}</span>}
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-lg text-ink-secondary">
        {wo?.drawingNumber && (
          <div>
            <dt className="inline">Crtež: </dt>
            <dd className="tnums inline text-ink">{wo.drawingNumber}</dd>
          </div>
        )}
        {wo && (
          <div>
            <dt className="inline">Potrebno: </dt>
            <dd className="tnums inline font-semibold text-ink">{formatNumber(wo.pieceCount)} kom</dd>
          </div>
        )}
        {wo?.productionDeadline && (
          <div>
            <dt className="inline">Rok: </dt>
            <dd className="inline text-ink">{formatDate(wo.productionDeadline)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function KioskScanner() {
  const { logout } = useAuth();
  const identify = useIdentifyWorker();
  const decode = useDecodeBarcode();
  const scan = useScan();
  const control = useControl();
  const startWork = useStartWork();
  const stopWork = useStopWork();
  const labelData = useLabelData();
  const [reprinting, setReprinting] = useState(false);

  // Radnik/kontrolor prijavljen ID karticom (BarKodUnos2024 ekran 1).
  const [worker, setWorker] = useState<{ card: string; info: KioskWorker } | null>(null);
  // LIČNI nalog (users.worker_id) preskače karticu; posle „Odjava radnika" kartica se opet traži.
  const me = useWorkerMe();
  const [cardGate, setCardGate] = useState(false);
  // „Moji otvoreni" (runda 2 t.3) — panel zamenjuje skener korak dok je otvoren.
  const [myOpen, setMyOpen] = useState(false);
  const [order, setOrder] = useState<OrderState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Živa vrednost iz scan/finish/control odgovora (brži prikaz od refetch-a kartice).
  const [override, setOverride] = useState<{ id: number; made: number; finished: boolean } | null>(
    null,
  );
  // Posle završne kontrole NE štampamo automatski — nudimo panel sa brojem
  // nalepnica (default 1, Nesa 2026-07-10). Ovde stoje podaci sveže nalepnice
  // dok kontrolor ne izabere broj i ne odštampa.
  const [controlLabel, setControlLabel] = useState<{
    label: Omit<Parameters<typeof printControlLabels>[0], 'copies'>;
    controlled: number;
  } | null>(null);

  const cardKey = order
    ? {
        projectId: order.fields.projectId,
        identNumber: order.fields.identNumber,
        variant: order.fields.variant,
      }
    : null;
  const card = useTechProcessCard(cardKey);

  // Svi redovi tehnološkog postupka za skeniranu operaciju (po RC + broju operacije).
  const matchedRows = useMemo(() => {
    if (!operation || !card.data) return null;
    const rows = card.data.data.rows.filter(
      (r) =>
        r.workCenterCode === operation.fields.workCenterCode &&
        (operation.fields.operationNumber === null ||
          r.operationNumber === operation.fields.operationNumber),
    );
    return rows.length ? rows : null;
  }, [operation, card.data]);

  // Red tehnološkog postupka za skeniranu operaciju — isti izbor kao backend scan:
  // prvo nezavršene, pa najmanji id.
  const matched = useMemo(() => {
    if (!matchedRows) return null;
    return [...matchedRows].sort(
      (a, b) => Number(!!a.isProcessFinished) - Number(!!b.isProcessFinished) || a.id - b.id,
    )[0];
  }, [matchedRows]);

  // „Napravljeno" = Σ komada SVIH redova operacije (svi kvaliteti dobar+dorada+škart;
  // storno redovi su negativni pa se netuju) — NE pieceCount jednog (matched) reda (odluka #4).
  const groupSum = useMemo(
    () => (matchedRows ? matchedRows.reduce((sum, r) => sum + r.pieceCount, 0) : 0),
    [matchedRows],
  );

  // Stanje vremenske sesije (A-4) — vodi START/STOP režim u WorkPanel-u.
  // Isključeno za završnu kontrolu (ta ima svoj panel/tok).
  const openSession = useOpenSession({
    orderBarcode: order?.raw,
    operationBarcode: operation?.raw,
    workerCard: worker?.card,
    enabled: !!order && !!operation && !!worker && operation?.finalControl !== true,
  });
  const session = openSession.data?.data.open ? openSession.data.data.session : null;

  // Brojač „Moji otvoreni" (runda 2 t.3) — samo za bedž u headeru; puna lista
  // se otvara u MyOpenPanel-u. Lični nalog šalje kartica=null (backend čita JWT).
  const myOpenCount = useMyOpen(worker?.card ?? null, !!worker);
  const openCount = myOpenCount.data?.data.length ?? 0;

  // Auto-odjava posle uspešnog kucanja (deljeni terminal) — vidljivo odbrojavanje.
  // Definisano PRE resetOrder da nema TDZ u deps nizovima kasnijih callback-ova/efekata.
  const [logoutIn, setLogoutIn] = useState<number | null>(null);
  const cancelAutoLogout = useCallback(() => setLogoutIn(null), []);
  const armAutoLogout = useCallback(() => setLogoutIn(AUTO_LOGOUT_SECONDS), []);

  const resetOrder = useCallback(() => {
    cancelAutoLogout();
    setOrder(null);
    setOperation(null);
    setOverride(null);
    setControlLabel(null);
    setFeedback(null);
  }, [cancelAutoLogout]);

  const resetWorker = useCallback(() => {
    setWorker(null);
    setCardGate(true); // eksplicitna odjava → sledeći radnik se identifikuje karticom
    setMyOpen(false);
    setLogoutIn(null);
    resetOrder();
  }, [resetOrder]);

  // Auto-odjava: tik na sekundu (setTimeout po tiku, ne interval); na 0 pozovi resetWorker
  // (NE useAuth().logout — to ruši ceo terminal). resetWorker vrati cardGate=true.
  useEffect(() => {
    if (logoutIn === null) return;
    if (logoutIn <= 0) {
      resetWorker();
      return;
    }
    const t = setTimeout(() => setLogoutIn((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [logoutIn, resetWorker]);

  // Auto-prijava iz LIČNOG naloga (worker/me): preskoči karticu (odluka Nesa 2026-07-09).
  // Deljeni nalozi (kontrola@, tehnologija@) vraćaju null → ostaje kartica.
  useEffect(() => {
    if (worker || cardGate) return;
    const info = me.data?.data;
    if (!info) return;
    setWorker({ card: info.cardId, info });
    setFeedback({
      tone: 'info',
      title: `Prijavljen: ${info.fullName ?? info.username} (nalog)`,
      detail: info.isController
        ? 'Kontrolor — skenirajte NALOG radnog naloga.'
        : 'Skenirajte NALOG radnog naloga.',
    });
  }, [me.data, worker, cardGate]);

  // Esc zatvara „Moji otvoreni" panel (DESIGN_SYSTEM §8). Dijalog potvrde unutar
  // panela ima svoj Esc (kit Dialog) — ovaj hvata samo kad panela ima a dijaloga nema.
  useEffect(() => {
    if (!myOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMyOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [myOpen]);

  async function onCardScan(cardId: string) {
    cancelAutoLogout();
    try {
      const { data } = await identify.mutateAsync(cardId);
      setWorker({ card: cardId, info: data });
      setFeedback({
        tone: 'info',
        title: `Prijavljen: ${data.fullName ?? data.username}`,
        detail: data.isController
          ? 'Kontrolor — skenirajte NALOG radnog naloga.'
          : 'Skenirajte NALOG radnog naloga.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Kartica nije prepoznata', detail: errMessage(e) });
    }
  }

  async function onOrderScan(barcode: string) {
    cancelAutoLogout();
    try {
      const { data } = await decode.mutateAsync(barcode);
      if (data.type !== 'nalog') {
        setFeedback({
          tone: 'danger',
          title: 'Pogrešan barkod',
          detail: 'Skenirajte NALOG barkod (počinje sa RNZ).',
        });
        return;
      }
      setOperation(null);
      setOverride(null);
      setOrder({
        raw: barcode,
        fields: data.fields,
        workOrder: data.workOrder,
        operationCount: data.techProcess.operationCount,
        routing: data.routing,
      });
      setFeedback(
        data.workOrder
          ? {
              tone: 'info',
              title: 'Nalog učitan',
              detail: `RN ${data.workOrder.identNumber} · ${data.workOrder.partName} — sada skenirajte OPERACIJU.`,
            }
          : {
              tone: 'info',
              title: 'Nalog nije nađen u bazi',
              detail: `RN ${data.fields.identNumber} — skenirajte operaciju za prijavu rada.`,
            },
      );
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Neispravan barkod', detail: errMessage(e) });
    }
  }

  async function onOperationScan(barcode: string) {
    cancelAutoLogout();
    if (!order) return;
    try {
      const { data } = await decode.mutateAsync(barcode);
      if (data.type !== 'operacija') {
        setFeedback({
          tone: 'danger',
          title: 'Pogrešan barkod',
          detail: 'Skenirajte OPERACIJU barkod (počinje sa S).',
        });
        return;
      }
      if (data.fields.revision !== order.fields.revision) {
        setFeedback({
          tone: 'danger',
          title: 'Barkod ne pripada nalogu',
          detail: 'Revizija se ne poklapa — operacija je sa drugog otiska. Skenirajte pravu operaciju.',
        });
        return;
      }
      setOverride(null);
      setControlLabel(null);
      setOperation({
        raw: barcode,
        fields: data.fields,
        finalControl: data.operation?.significantForFinishing ?? false,
        workCenterName: data.operation?.workCenterName ?? null,
        withoutProcess: data.operation?.withoutProcess ?? false,
      });
      setFeedback(
        data.operation?.significantForFinishing
          ? { tone: 'info', title: 'Završna kontrola', detail: 'Unesite komade, kvalitet i lokaciju, pa štampajte nalepnice.' }
          : null,
      );
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Neispravan barkod', detail: errMessage(e) });
    }
  }

  async function onEvidentiraj(pieces: number) {
    cancelAutoLogout();
    if (!order || !operation || !worker) return;
    try {
      const { data } = await scan.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        pieceCount: pieces,
        workerCard: worker.card,
      });
      // „Napravljeno" je Σ grupe: dodaj upravo prijavljene komade na zbir PRE mutacije
      // (backend techProcess.pieceCount je kumulativ SAMO tog reda, ne grupe).
      const madeAfter = groupSum + data.reportedPieces;
      setOverride({
        id: data.techProcess.id,
        made: madeAfter,
        finished: !!data.techProcess.isProcessFinished,
      });
      const parts = [
        `Napravljeno ${formatNumber(madeAfter)}${
          data.plannedPieces != null ? ' / ' + formatNumber(data.plannedPieces) : ''
        } kom`,
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      if (data.staleWorkOrder) {
        setFeedback({
          tone: 'info',
          title: `Star otisak — rad je evidentiran (${formatNumber(pieces)} kom)`,
          detail: [
            `Nalog je štampan u varijanti ${data.printedVariant}, tekuća je ${data.currentVariant}.`,
            'Tehnologija/crtež su verovatno izmenjeni — preuzmite novi odštampan nalog.',
            ...parts,
          ].join(' · '),
        });
      } else {
        setFeedback({
          tone: 'success',
          title: `Evidentirano ${formatNumber(pieces)} kom`,
          detail: parts.join(' · '),
        });
      }
      armAutoLogout();
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Prijava nije uspela', detail: errMessage(e) });
    }
  }

  async function onZapocni() {
    cancelAutoLogout();
    if (!order || !operation || !worker) return;
    try {
      const { data } = await startWork.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        workerCard: worker.card,
      });
      await openSession.refetch();
      const detail: string[] = [];
      if (data.multitaskingWarning) detail.push(data.multitaskingWarning);
      if (data.staleWorkOrder)
        detail.push(
          `Star otisak: štampan u varijanti ${data.printedVariant}, tekuća je ${data.currentVariant}.`,
        );
      setFeedback({
        tone: data.staleWorkOrder || data.multitaskingWarning ? 'info' : 'success',
        title: 'Rad započet',
        detail: detail.length
          ? detail.join(' · ')
          : 'Merenje vremena je pokrenuto — skenirajte STOP („Završi rad") kad završite.',
      });
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Početak rada nije uspeo', detail: errMessage(e) });
    }
  }

  async function onZavrsiRad(pieces: number) {
    cancelAutoLogout();
    if (!order || !operation || !worker) return;
    try {
      const { data } = await stopWork.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        workerCard: worker.card,
        pieceCount: pieces,
      });
      // „Napravljeno" je Σ grupe: zbir PRE mutacije + upravo prijavljeni komadi
      // (backend techProcess.pieceCount je kumulativ SAMO tog reda, ne grupe).
      const madeAfter = groupSum + data.reportedPieces;
      setOverride({
        id: data.techProcess.id,
        made: madeAfter,
        finished: !!data.techProcess.isProcessFinished,
      });
      await openSession.refetch();
      const sec = data.session.elapsedSeconds;
      const dur =
        sec >= 3600
          ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
          : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      const parts = [
        `Napravljeno ${formatNumber(madeAfter)}${
          data.plannedPieces != null ? ' / ' + formatNumber(data.plannedPieces) : ''
        } kom`,
        `Trajanje ${dur}`,
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      setFeedback({
        tone: 'success',
        title: `Rad završen (${formatNumber(pieces)} kom)`,
        detail: parts.join(' · '),
      });
      armAutoLogout();
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Završetak rada nije uspeo', detail: errMessage(e) });
    }
  }

  async function onKontrola(input: ControlSubmit) {
    cancelAutoLogout();
    if (!order || !operation || !worker) {
      setFeedback({
        tone: 'danger',
        title: 'Kontrola nije moguća',
        detail: 'Nedostaje nalog, operacija ili prijava karticom.',
      });
      return;
    }
    try {
      // Create-on-scan: backend nalazi/otvara red kontrole iz barkodova (ne treba tp.id).
      const { data } = await control.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        workerCard: worker.card,
        ...input,
      });
      setOverride({
        id: data.techProcess.id,
        made: data.controlledCumulative,
        finished: data.operationFinished,
      });

      // NE štampamo automatski (Nenad 15.07): kontrola je snimljena, a broj
      // nalepnica bira kontrolor u panelu ispod (default 1). Podatke sveže
      // nalepnice čuvamo do štampe.
      setControlLabel({
        label: { fields: data.label.fields, barcode: data.label.barcode },
        controlled: data.controlledPieces,
      });

      const parts: string[] = [];
      if (data.confirmedOperations > 0)
        parts.push(`Potvrđeno ${formatNumber(data.confirmedOperations)} neotkucanih operacija.`);
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      if (data.childOrderPending) parts.push('Nalog za doradu/škart sledi u narednoj fazi.');
      // A-5 (shadow): upozorenje o ovlašćenju kontrolora / razdvajanju dužnosti — istaknuto.
      const warned = !!data.controllerWarnings?.length;
      if (warned) parts.unshift(data.controllerWarnings!.join(' · '));

      if (!data.operationFinished) {
        // Operacija još nije dostigla plan — kontrola snimljena delimično; prikaži ukupno/preostalo.
        const remaining =
          data.plannedPieces != null
            ? Math.max(0, data.plannedPieces - data.controlledCumulative)
            : null;
        parts.unshift(
          `Iskontrolisano ukupno ${formatNumber(data.controlledCumulative)}${
            data.plannedPieces != null ? ' / ' + formatNumber(data.plannedPieces) : ''
          } kom${remaining != null ? ` — preostalo ${formatNumber(remaining)}` : ''}`,
        );
      } else {
        parts.unshift(`Iskontrolisano ${formatNumber(data.controlledPieces)} kom`);
      }
      setFeedback({
        tone: warned ? 'info' : 'success',
        title: 'Kontrola snimljena — izaberite broj nalepnica i štampajte',
        detail: parts.join(' · '),
      });
      // Auto-odjava se NE armira ovde — čeka se štampa nalepnica (onPrintControlLabels).
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Kontrola nije uspela', detail: errMessage(e) });
    }
  }

  /** Štampa nalepnica POSLE kontrole — broj bira kontrolor (default 1, Nesa 10.07). */
  async function onPrintControlLabels(copies: number) {
    cancelAutoLogout();
    if (!controlLabel) return;
    setReprinting(true);
    try {
      const print = await printControlLabels({ ...controlLabel.label, copies });
      if (print.ok) {
        setFeedback({
          tone: 'success',
          title: `Nalepnice poslate na štampu (${formatNumber(copies)})`,
        });
      } else {
        setFeedback({
          tone: 'danger',
          title: 'Štampa nalepnica nije uspela',
          detail: `${print.reason ?? 'nepoznata greška'} — proveri da je label-proxy pokrenut na OVOM računaru (localhost:8765; frontend/tools/label-proxy).`,
        });
      }
      armAutoLogout();
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Štampa nije uspela', detail: errMessage(e) });
    } finally {
      setReprinting(false);
    }
  }

  /** DOŠTAMPAVANJE — kontrola već urađena: samo štampa, bez diranja evidencije. */
  async function onReprint(copies: number) {
    cancelAutoLogout();
    if (!order?.workOrder) {
      setFeedback({
        tone: 'danger',
        title: 'Štampa nije moguća',
        detail: 'Radni nalog nije razrešen iz barkoda.',
      });
      return;
    }
    setReprinting(true);
    try {
      const { data } = await labelData.mutateAsync({
        workOrderId: order.workOrder.id,
        quantity: copies,
      });
      const print = await printControlLabels({
        fields: data.fields,
        barcode: data.barcode,
        copies,
      });
      if (print.ok) {
        setFeedback({
          tone: 'success',
          title: `Nalepnice poslate na štampu (${formatNumber(copies)})`,
        });
      } else {
        setFeedback({
          tone: 'danger',
          title: 'Štampa nalepnica nije uspela',
          detail: `${print.reason ?? 'nepoznata greška'}`,
        });
      }
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Štampa nije uspela', detail: errMessage(e) });
    } finally {
      setReprinting(false);
    }
  }

  // --- render: prvo prijava karticom, pa nalog → operacija → panel ---

  if (!worker && !cardGate && me.isLoading) {
    return (
      <main className="grid flex-1 place-items-center bg-app text-xl text-ink-secondary">
        Prijava…
      </main>
    );
  }

  if (!worker) {
    return (
      <main className="flex flex-1 flex-col bg-app">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-6 py-4">
          <span className="text-2xl font-bold text-ink">Kiosk — prijava radom</span>
          <button
            onClick={logout}
            className="inline-flex h-14 items-center gap-2 rounded-control px-4 text-lg font-medium text-ink-secondary hover:bg-surface-2"
          >
            <LogOut className="h-5 w-5" aria-hidden />
            Odjava terminala
          </button>
        </header>
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-auto p-6">
          {feedback && <BigMessage tone={feedback.tone} title={feedback.title} detail={feedback.detail} />}
          <ScanField
            key="scan-card"
            label="Prijava za rad — skenirajte ID karticu"
            placeholder="ID kartica…"
            hint="Prislonite čitač na svoju identifikacionu karticu."
            onScan={onCardScan}
          />
        </div>
      </main>
    );
  }

  const stepNo = order ? (operation ? 3 : 2) : 1;
  const stepLabel = stepNo === 1 ? 'Skeniraj nalog' : stepNo === 2 ? 'Skeniraj operaciju' : operation?.finalControl ? 'Kontrola' : 'Prijava rada';

  const made = override?.made ?? groupSum;
  // Operacija bez postupka (opšti nalog): zatvoreni redovi su istorija — nikad „Zatvorena", panel ostaje otvoren.
  const finished =
    override?.finished ?? (operation?.withoutProcess ? false : !!matched?.isProcessFinished);
  const planned = order?.workOrder?.pieceCount ?? null;
  const opName = matched?.operation?.workCenterName ?? operation?.workCenterName ?? operation?.fields.workCenterCode ?? '';
  const operationLabel = operation
    ? `${operation.fields.operationNumber != null ? `Op. ${operation.fields.operationNumber} · ` : ''}${opName}`
    : '';
  const cardLoading = !!operation && card.isLoading;
  // Revizioni signal crteža sa kartice — backend ga šalje uz `drawing`. Kartični
  // `drawing` tip (TechProcessCard) ne nosi revizione fields, pa čitamo kroz
  // kiosk drawing tip; `revisionStale` = RN je na starijoj reviziji od najnovije.
  const cardDrawing = (card.data?.data.drawing ?? null) as KioskDrawingRef | null;
  // Operacija je „u nalogu" ako ima tech_processes red ILI je u routingu RN-a
  // (za RN kreiran u 2.0 red se otvara pri prvom skenu — create-on-scan).
  const inRouting =
    !!operation &&
    !!order?.routing.some(
      (r) =>
        r.workCenterCode === operation.fields.workCenterCode &&
        (operation.fields.operationNumber === null ||
          r.operationNumber === operation.fields.operationNumber),
    );
  const missing = !!operation && !!card.data && !matched && !inRouting;
  // Završna kontrola → KONTROLA panel (i kad red još ne postoji: create-on-scan).
  // Panel za štampu nalepnica POSLE sveže kontrole ima prednost nad kontrolom/reprint-om.
  const showControl = !!operation?.finalControl && !finished && !cardLoading && !controlLabel;
  // Kontrola VEĆ urađena → nudi se samo DOŠTAMPAVANJE nalepnica (Nesa 2026-07-10).
  const showReprint = !!operation?.finalControl && finished && !cardLoading && !controlLabel;

  return (
    <main className="flex flex-1 flex-col bg-app">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-bold text-ink">Kiosk — prijava rada</span>
          <span className="rounded-full bg-accent-subtle px-3 py-1 text-base font-semibold text-accent">
            Korak {stepNo}/3 — {stepLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-lg text-ink md:inline-flex">
            <UserRound className="h-5 w-5 text-ink-secondary" aria-hidden />
            {worker.info.fullName ?? worker.info.username}
          </span>
          {/* „Moji otvoreni" (runda 2 t.3) — veliko touch dugme, N iz hooka;
              otvara panel umesto skener koraka. Sakriveno dok je panel otvoren. */}
          {!myOpen && (
            <button
              onClick={() => {
                cancelAutoLogout();
                setMyOpen(true);
              }}
              className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-accent bg-accent-subtle px-5 text-lg font-semibold text-accent hover:bg-accent-subtle/70"
            >
              <ListChecks className="h-5 w-5" aria-hidden />
              Moji otvoreni {openCount > 0 && <span className="tnums">({openCount})</span>}
            </button>
          )}
          {order && !myOpen && (
            <button
              onClick={resetOrder}
              className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-line bg-surface px-5 text-lg font-semibold text-ink hover:bg-surface-2"
            >
              <RotateCcw className="h-5 w-5" aria-hidden />
              Novi nalog
            </button>
          )}
          <button
            onClick={resetWorker}
            className="inline-flex h-14 items-center gap-2 rounded-control px-4 text-lg font-medium text-ink-secondary hover:bg-surface-2"
          >
            <LogOut className="h-5 w-5" aria-hidden />
            Odjava radnika
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-auto p-6">
        {myOpen ? (
          <MyOpenPanel card={worker.card} onBack={() => setMyOpen(false)} />
        ) : (
          <>
        {order && <OrderHeadline order={order} />}

        {feedback && <BigMessage tone={feedback.tone} title={feedback.title} detail={feedback.detail} />}

        {logoutIn !== null && (
          <div className="rounded-panel border-2 border-accent bg-accent-subtle p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <span className="text-lg font-semibold text-ink">
                Automatska odjava za <span className="tnums text-accent">{logoutIn}</span> s — sledeći
                radnik može da se prijavi.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelAutoLogout}
                  className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-line bg-surface px-5 text-lg font-semibold text-ink hover:bg-surface-2"
                >
                  Ostani prijavljen
                </button>
                <button
                  onClick={resetWorker}
                  className="inline-flex h-14 items-center gap-2 rounded-control bg-status-danger px-5 text-lg font-semibold text-white hover:bg-status-danger/90"
                >
                  Odjavi odmah
                </button>
              </div>
            </div>
          </div>
        )}

        {!order && (
          <ScanField
            key="scan-order"
            label="Korak 1 — skenirajte NALOG"
            placeholder="RNZ:…"
            hint="Prislonite čitač na barkod radnog naloga (počinje sa RNZ)."
            onScan={onOrderScan}
          />
        )}

        {order && !operation && (
          <ScanField
            key="scan-operation"
            label="Korak 2 — skenirajte OPERACIJU"
            placeholder="S:…"
            hint="Prislonite čitač na barkod operacije (počinje sa S) sa istog naloga."
            onScan={onOperationScan}
          />
        )}

        {/* Revizija crteža zastarela (RN na starijoj reviziji od najnovije) —
            UPOZORENJE iznad panela (work/control); ne blokira rad (odluka 15.07). */}
        {order && operation && cardDrawing?.revisionStale && (
          <div className="rounded-panel border-2 border-status-warn/40 bg-status-warn-bg px-5 py-4 text-lg font-semibold text-status-warn">
            ⚠ Crtež {order.workOrder?.drawingNumber ?? '—'}: RN je na reviziji{' '}
            {cardDrawing.revision ?? '—'}, postoji novija revizija{' '}
            {cardDrawing.latestRevision ?? '—'} — proveri da nalog nije zastareo.
          </div>
        )}

        {order && operation && showControl && (
          <ControlPanel
            key={operation.raw}
            operationLabel={operationLabel}
            planned={planned}
            busy={control.isPending}
            onSubmit={onKontrola}
          />
        )}

        {/* Posle sveže kontrole: štampa nalepnica na zahtev (default 1, ručno povećaj). */}
        {order && operation && controlLabel && (
          <ReprintPanel
            key={`ctrl-labels-${operation.raw}`}
            operationLabel={operationLabel}
            controlled={controlLabel.controlled}
            busy={reprinting}
            onPrint={onPrintControlLabels}
            heading="Kontrola snimljena"
            note="Izaberite broj nalepnica i štampajte (podrazumevano 1)."
          />
        )}

        {order && operation && showReprint && (
          <ReprintPanel
            key={`reprint-${operation.raw}`}
            operationLabel={operationLabel}
            controlled={made}
            busy={reprinting}
            onPrint={onReprint}
          />
        )}

        {order && operation && !showControl && !showReprint && (
          <WorkPanel
            key={operation.raw}
            operationLabel={operationLabel}
            identMark={operation.fields.identMark}
            drawing={card.data?.data.drawing ?? null}
            planned={planned}
            made={made}
            finished={finished}
            missing={missing}
            loading={cardLoading}
            openSession={session}
            sessionLoading={openSession.isLoading}
            zapocinjanje={startWork.isPending}
            zavrsavanje={stopWork.isPending}
            onZapocni={onZapocni}
            onZavrsiRad={onZavrsiRad}
            evidentiranje={scan.isPending}
            onEvidentiraj={onEvidentiraj}
          />
        )}
          </>
        )}
      </div>
    </main>
  );
}
