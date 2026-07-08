'use client';

import { useCallback, useMemo, useState } from 'react';
import { LogOut, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/api/client';
import {
  useDecodeBarcode,
  useFinish,
  useScan,
  type KioskWorkOrder,
  type OperationBarcodeFields,
  type OrderBarcodeFields,
} from '@/api/kiosk';
import { useTechProcessCard } from '@/api/tech-processes';
import { formatDate, formatNumber } from '@/lib/format';
import { ScanField } from './scan-field';
import { BigMessage, type MessageTone } from './big-message';
import { WorkPanel } from './work-panel';

interface OrderState {
  raw: string;
  fields: OrderBarcodeFields;
  workOrder: KioskWorkOrder | null;
  operationCount: number;
}
interface OperationState {
  raw: string;
  fields: OperationBarcodeFields;
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
  const decode = useDecodeBarcode();
  const scan = useScan();
  const finish = useFinish();

  const [order, setOrder] = useState<OrderState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Živa vrednost iz scan/finish odgovora (brži prikaz od refetch-a kartice).
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

  const reset = useCallback(() => {
    setOrder(null);
    setOperation(null);
    setOverride(null);
    setFeedback(null);
  }, []);

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
      if (data.fields.printTimer !== order.fields.printTimer) {
        setFeedback({
          tone: 'danger',
          title: 'Barkod ne pripada nalogu',
          detail: 'PrnTimer se ne poklapa — operacija je sa drugog naloga. Skenirajte pravu operaciju.',
        });
        return;
      }
      setOverride(null);
      setOperation({ raw: barcode, fields: data.fields });
      setFeedback(null);
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Neispravan barkod', detail: errMessage(e) });
    }
  }

  async function onEvidentiraj(pieces: number) {
    if (!order || !operation) return;
    try {
      const { data } = await scan.mutateAsync({
        orderBarcode: order.raw,
        operationBarcode: operation.raw,
        pieceCount: pieces,
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
      setFeedback({
        tone: 'success',
        title: `Evidentirano ${formatNumber(pieces)} kom`,
        detail: parts.join(' · '),
      });
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Prijava nije uspela', detail: errMessage(e) });
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
      const { data } = await finish.mutateAsync({ id });
      setOverride({ id: data.techProcess.id, made: data.techProcess.pieceCount, finished: true });
      const parts = [`Zatvoreno sa ${formatNumber(data.finishedPieces)} kom`];
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      setFeedback({ tone: 'success', title: 'Operacija zatvorena', detail: parts.join(' · ') });
    } catch (e) {
      setFeedback({ tone: 'danger', title: 'Zatvaranje nije uspelo', detail: errMessage(e) });
    }
  }

  const stepNo = order ? (operation ? 3 : 2) : 1;
  const stepLabel = stepNo === 1 ? 'Skeniraj nalog' : stepNo === 2 ? 'Skeniraj operaciju' : 'Prijava rada';

  const made = override?.made ?? matched?.pieceCount ?? 0;
  const finished = override?.finished ?? !!matched?.isProcessFinished;
  const planned = order?.workOrder?.pieceCount ?? null;
  const opName = matched?.operation?.workCenterName ?? operation?.fields.workCenterCode ?? '';
  const operationLabel = operation
    ? `${operation.fields.operationNumber != null ? `Op. ${operation.fields.operationNumber} · ` : ''}${opName}`
    : '';
  const cardLoading = !!operation && card.isLoading;
  const missing = !!operation && !!card.data && !matched;

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
          <span className="hidden text-lg text-ink-secondary md:inline">{workerName}</span>
          {order && (
            <button
              onClick={reset}
              className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-line bg-surface px-5 text-lg font-semibold text-ink hover:bg-surface-2"
            >
              <RotateCcw className="h-5 w-5" aria-hidden />
              Novi nalog
            </button>
          )}
          <button
            onClick={logout}
            className="inline-flex h-14 items-center gap-2 rounded-control px-4 text-lg font-medium text-ink-secondary hover:bg-surface-2"
          >
            <LogOut className="h-5 w-5" aria-hidden />
            Odjava
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

        {order && operation && (
          <WorkPanel
            key={operation.raw}
            operationLabel={operationLabel}
            identMark={operation.fields.identMark}
            planned={planned}
            made={made}
            finished={finished}
            missing={missing}
            loading={cardLoading}
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
