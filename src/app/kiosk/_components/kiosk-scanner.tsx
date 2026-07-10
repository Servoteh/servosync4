'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut, RotateCcw, UserRound } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/api/client';
import {
  useControl,
  useDecodeBarcode,
  useFinish,
  useIdentifyWorker,
  useLabelData,
  useOpenSession,
  useScan,
  useStartWork,
  useStopWork,
  useWorkerMe,
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
}
type Feedback = { tone: MessageTone; title: string; detail?: string };

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

export function KioskScanner({ workerName }: { workerName: string }) {
  const { logout } = useAuth();
  const identify = useIdentifyWorker();
  const decode = useDecodeBarcode();
  const scan = useScan();
  const finish = useFinish();
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
  const [order, setOrder] = useState<OrderState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Živa vrednost iz scan/finish/control odgovora (brži prikaz od refetch-a kartice).
  const [override, setOverride] = useState<{ id: number; made: number; finished: boolean } | null>(
    null,
  );

  const cardKey = order
    ? {
        projectId: order.fields.projectId,
        identNumber: order.fields.identNumber,
        variant: order.fields.variant,
      }
    : null;
  const card = useTechProcessCard(cardKey);

  // Red tehnološkog postupka za skeniranu operaciju (po RC + broju operacije).
  const matched = useMemo(() => {
    if (!operation || !card.data) return null;
    const rows = card.data.data.rows.filter(
      (r) =>
        r.workCenterCode === operation.fields.workCenterCode &&
        (operation.fields.operationNumber === null ||
          r.operationNumber === operation.fields.operationNumber),
    );
    if (!rows.length) return null;
    // isti izbor kao backend scan: prvo nezavršene, pa najmanji id.
    return [...rows].sort(
      (a, b) => Number(!!a.isProcessFinished) - Number(!!b.isProcessFinished) || a.id - b.id,
    )[0];
  }, [operation, card.data]);

  // Stanje vremenske sesije (A-4) — vodi START/STOP režim u WorkPanel-u.
  // Isključeno za završnu kontrolu (ta ima svoj panel/tok).
  const openSession = useOpenSession({
    orderBarcode: order?.raw,
    operationBarcode: operation?.raw,
    workerCard: worker?.card,
    enabled: !!order && !!operation && !!worker && operation?.finalControl !== true,
  });
  const session = openSession.data?.data.open ? openSession.data.data.session : null;

  const resetOrder = useCallback(() => {
    setOrder(null);
    setOperation(null);
    setOverride(null);
    setFeedback(null);
  }, []);

  const resetWorker = useCallback(() => {
    setWorker(null);
    setCardGate(true); // eksplicitna odjava → sledeći radnik se identifikuje karticom
    resetOrder();
  }, [resetOrder]);

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

  async function onCardScan(cardId: string) {
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
      setOperation({
        raw: barcode,
        fields: data.fields,
        finalControl: data.operation?.significantForFinishing ?? false,
        workCenterName: data.operation?.workCenterName ?? null,
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
    if (!order || !operation || !worker) return;
    try {
      const { data } = await scan.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        pieceCount: pieces,
        workerCard: worker.card,
      });
      setOverride({
        id: data.techProcess.id,
        made: data.techProcess.pieceCount,
        finished: !!data.techProcess.isProcessFinished,
      });
      const parts = [
        `Napravljeno ${formatNumber(data.techProcess.pieceCount)}${
          data.plannedPieces != null ? ' / ' + formatNumber(data.plannedPieces) : ''
        } kom`,
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      if (data.staleWorkOrder) {
        setFeedback({
          tone: 'info',
          title: `⚠ Star otisak — rad je evidentiran (${formatNumber(pieces)} kom)`,
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
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Prijava nije uspela', detail: errMessage(e) });
    }
  }

  async function onZapocni() {
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
          `⚠ Star otisak: štampan u varijanti ${data.printedVariant}, tekuća je ${data.currentVariant}.`,
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
    if (!order || !operation || !worker) return;
    try {
      const { data } = await stopWork.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        workerCard: worker.card,
        pieceCount: pieces,
      });
      setOverride({
        id: data.techProcess.id,
        made: data.techProcess.pieceCount,
        finished: !!data.techProcess.isProcessFinished,
      });
      await openSession.refetch();
      const sec = data.session.elapsedSeconds;
      const dur =
        sec >= 3600
          ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
          : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      const parts = [
        `Napravljeno ${formatNumber(data.techProcess.pieceCount)}${
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
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Završetak rada nije uspeo', detail: errMessage(e) });
    }
  }

  async function onZatvori() {
    const id = matched?.id ?? override?.id;
    if (id == null) {
      setFeedback({
        tone: 'danger',
        title: 'Nije moguće zatvoriti',
        detail: 'Operacija nije pronađena u tehnološkom postupku.',
      });
      return;
    }
    try {
      const { data } = await finish.mutateAsync({ id, workerCard: worker?.card });
      setOverride({ id: data.techProcess.id, made: data.techProcess.pieceCount, finished: true });
      const parts = [`Zatvoreno sa ${formatNumber(data.finishedPieces)} kom`];
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      setFeedback({ tone: 'success', title: 'Operacija zatvorena', detail: parts.join(' · ') });
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Zatvaranje nije uspelo', detail: errMessage(e) });
    }
  }

  async function onKontrola(input: ControlSubmit) {
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
      setOverride({ id: data.techProcess.id, made: data.controlledPieces, finished: true });

      // Štampa nalepnica (RNZ) — jedna po komadu (BarKodUnos2024 ekran 7).
      const print = await printControlLabels({
        fields: data.label.fields,
        barcode: data.label.barcode,
        copies: data.controlledPieces,
      });

      const parts = [`Iskontrolisano ${formatNumber(data.controlledPieces)} kom`];
      if (data.confirmedOperations > 0)
        parts.push(`Potvrđeno ${formatNumber(data.confirmedOperations)} neotkucanih operacija.`);
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      if (data.childOrderPending) parts.push('Nalog za doradu/škart sledi u narednoj fazi.');
      // A-5 (shadow): upozorenje o ovlašćenju kontrolora / razdvajanju dužnosti — istaknuto.
      const warned = !!data.controllerWarnings?.length;
      if (warned) parts.unshift(`⚠ ${data.controllerWarnings!.join(' · ⚠ ')}`);

      if (print.ok) {
        setFeedback({
          tone: warned ? 'info' : 'success',
          title: `Kontrola završena · nalepnice poslate (${formatNumber(data.controlledPieces)})`,
          detail: parts.join(' · '),
        });
      } else {
        const why =
          print.reason === 'no_proxy_url'
            ? 'Label-proxy nije podešen — nalepnice nisu odštampane.'
            : `Štampa nalepnica nije uspela (${print.reason}) — proveri da je label-proxy pokrenut na OVOM računaru (start.bat, localhost:8765; frontend/tools/label-proxy).`;
        setFeedback({
          tone: 'info',
          title: 'Kontrola završena — nalepnice NISU odštampane',
          detail: [why, ...parts].join(' · '),
        });
      }
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Kontrola nije uspela', detail: errMessage(e) });
    }
  }

  /** DOŠTAMPAVANJE — kontrola već urađena: samo štampa, bez diranja evidencije. */
  async function onReprint(copies: number) {
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

  const made = override?.made ?? matched?.pieceCount ?? 0;
  const finished = override?.finished ?? !!matched?.isProcessFinished;
  const planned = order?.workOrder?.pieceCount ?? null;
  const opName = matched?.operation?.workCenterName ?? operation?.workCenterName ?? operation?.fields.workCenterCode ?? '';
  const operationLabel = operation
    ? `${operation.fields.operationNumber != null ? `Op. ${operation.fields.operationNumber} · ` : ''}${opName}`
    : '';
  const cardLoading = !!operation && card.isLoading;
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
  const showControl = !!operation?.finalControl && !finished && !cardLoading;
  // Kontrola VEĆ urađena → nudi se samo DOŠTAMPAVANJE nalepnica (Nesa 2026-07-10).
  const showReprint = !!operation?.finalControl && finished && !cardLoading;

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
          {order && (
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
        {order && <OrderHeadline order={order} />}

        {feedback && <BigMessage tone={feedback.tone} title={feedback.title} detail={feedback.detail} />}

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

        {order && operation && showControl && (
          <ControlPanel
            key={operation.raw}
            operationLabel={operationLabel}
            planned={planned}
            busy={control.isPending}
            onSubmit={onKontrola}
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
            zatvaranje={finish.isPending}
            onEvidentiraj={onEvidentiraj}
            onZatvori={onZatvori}
          />
        )}
      </div>
    </main>
  );
}
