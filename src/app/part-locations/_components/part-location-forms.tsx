'use client';

import { useEffect, useState } from 'react';
import { PART_QUALITY } from '@/api/tech-processes';
import { useWorkOrders, type WorkOrder } from '@/api/work-orders';
import {
  usePositions,
  useCreatePartLocation,
  useTransferPartLocation,
  useRequisitionPartLocation,
  type Position,
} from '@/api/part-locations';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { ErrorText, QUALITY_OPTIONS } from './common';

// --- ComboBox izvori (usePositions/useWorkOrders vraćaju { data, meta } — oblik
//     koji ComboBox očekuje kroz `search.data.data`). ---

/** RN combo: pretraga po identu/nazivu/crtežu; bira ceo `WorkOrder` (nosi `worker`). */
function useWorkOrderSearch(q: string) {
  return useWorkOrders({ q: q || undefined });
}

/** Pozicija/polica combo: pretraga po šifri/opisu. */
function usePositionSearch(q: string) {
  return usePositions({ q: q || undefined });
}

function RnField({
  value,
  onChange,
}: {
  value: WorkOrder | null;
  onChange: (w: WorkOrder | null) => void;
}) {
  return (
    <ComboBox<WorkOrder>
      value={value}
      onChange={onChange}
      useSearch={useWorkOrderSearch}
      getKey={(w) => w.id}
      getLabel={(w) => w.identNumber}
      getSublabel={(w) => w.partName || w.drawingNumber || ''}
      placeholder="Ident RN, naziv, crtež…"
    />
  );
}

function PositionField({
  value,
  onChange,
  placeholder,
}: {
  value: Position | null;
  onChange: (p: Position | null) => void;
  placeholder?: string;
}) {
  return (
    <ComboBox<Position>
      value={value}
      onChange={onChange}
      useSearch={usePositionSearch}
      getKey={(p) => p.id}
      getLabel={(p) => p.positionCode}
      getSublabel={(p) => p.description || ''}
      placeholder={placeholder ?? 'Šifra ili opis pozicije…'}
    />
  );
}

function QualitySelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 w-full rounded-control border border-line bg-surface px-2.5 text-base text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
    >
      {QUALITY_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Ceo broj ≥ 1 iz string state-a (prazno/nevalidno → NaN → dugme onemogućeno). */
function parseQty(qty: string): number {
  return Number.parseInt(qty, 10);
}
function qtyValid(qty: string): boolean {
  const n = parseQty(qty);
  return Number.isInteger(n) && n >= 1;
}

function Footer({
  onClose,
  onSubmit,
  pending,
  disabled,
}: {
  onClose: () => void;
  onSubmit: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <button
        onClick={onClose}
        className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
      >
        Otkaži
      </button>
      <Button onClick={onSubmit} loading={pending} disabled={disabled}>
        Snimi
      </Button>
    </>
  );
}

// ------------------------------------------------------------------ Unos lokacije (+qty)

/**
 * "Unos lokacije" — placement (+quantity) iskontrolisanog dela (POST /part-locations).
 * `workerId` (izvršilac) se izvodi iz radnika izabranog RN-a — do User↔Worker auth
 * veze isti FK-safe fallback kao backend za prenos/trebovanje (TODO(auth)).
 */
export function CreatePartLocationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [workOrder, setWorkOrder] = useState<WorkOrder | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [qualityTypeId, setQualityTypeId] = useState<number>(PART_QUALITY.GOOD);
  const [qty, setQty] = useState('');
  const create = useCreatePartLocation();

  useEffect(() => {
    if (open) {
      setWorkOrder(null);
      setPosition(null);
      setQualityTypeId(PART_QUALITY.GOOD);
      setQty('');
    }
  }, [open]);

  const workerId = workOrder?.worker?.id ?? null;
  const noWorker = workOrder != null && workerId == null;
  const canSubmit = workOrder != null && position != null && workerId != null && qtyValid(qty);

  async function submit() {
    if (workOrder == null || position == null || workerId == null || !qtyValid(qty)) return;
    try {
      await create.mutateAsync({
        workOrderId: workOrder.id,
        positionId: position.id,
        qualityTypeId,
        workerId,
        quantity: parseQty(qty),
      });
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Unos lokacije"
      footer={
        <Footer onClose={onClose} onSubmit={submit} pending={create.isPending} disabled={!canSubmit} />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Postavljanje iskontrolisanog dela na policu (+kom). Predmet i radnik se izvode iz RN-a.
        </p>
        <FormField label="Radni nalog (RN)" required>
          <RnField value={workOrder} onChange={setWorkOrder} />
          {noWorker && (
            <p className="mt-1 text-xs text-status-danger">
              Izabrani RN nema dodeljenog radnika — unos nije moguć.
            </p>
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Pozicija/polica" required>
            <PositionField value={position} onChange={setPosition} />
          </FormField>
          <FormField label="Kvalitet" required>
            <QualitySelect value={qualityTypeId} onChange={setQualityTypeId} />
          </FormField>
        </div>
        <FormField label="Količina (kom)" required hint="Ceo broj ≥ 1.">
          <Input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
        </FormField>
        <ErrorText error={create.error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Prenos (−qty izvor / +qty cilj)

/**
 * "Prenos" — dela sa police na policu (POST /part-locations/transfer). Izvorna i
 * ciljna pozicija moraju biti različite; prenosi se u okviru istog kvaliteta
 * (stanje je fungibilno samo unutar iste klase, §3.4).
 */
export function TransferPartLocationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [workOrder, setWorkOrder] = useState<WorkOrder | null>(null);
  const [fromPosition, setFromPosition] = useState<Position | null>(null);
  const [toPosition, setToPosition] = useState<Position | null>(null);
  const [qualityTypeId, setQualityTypeId] = useState<number>(PART_QUALITY.GOOD);
  const [qty, setQty] = useState('');
  const transfer = useTransferPartLocation();

  useEffect(() => {
    if (open) {
      setWorkOrder(null);
      setFromPosition(null);
      setToPosition(null);
      setQualityTypeId(PART_QUALITY.GOOD);
      setQty('');
    }
  }, [open]);

  const samePosition =
    fromPosition != null && toPosition != null && fromPosition.id === toPosition.id;
  const canSubmit =
    workOrder != null &&
    fromPosition != null &&
    toPosition != null &&
    !samePosition &&
    qtyValid(qty);

  async function submit() {
    if (workOrder == null || fromPosition == null || toPosition == null || samePosition || !qtyValid(qty))
      return;
    try {
      await transfer.mutateAsync({
        workOrderId: workOrder.id,
        fromPositionId: fromPosition.id,
        toPositionId: toPosition.id,
        qualityTypeId,
        quantity: parseQty(qty),
      });
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Prenos dela"
      footer={
        <Footer onClose={onClose} onSubmit={submit} pending={transfer.isPending} disabled={!canSubmit} />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Premeštanje dela sa jedne police na drugu (−kom sa izvora, +kom na cilj).
        </p>
        <FormField label="Radni nalog (RN)" required>
          <RnField value={workOrder} onChange={setWorkOrder} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Iz pozicije" required>
            <PositionField
              value={fromPosition}
              onChange={setFromPosition}
              placeholder="Izvorna polica…"
            />
          </FormField>
          <FormField label="U poziciju" required>
            <PositionField
              value={toPosition}
              onChange={setToPosition}
              placeholder="Ciljna polica…"
            />
          </FormField>
        </div>
        {samePosition && (
          <p className="text-xs text-status-danger">
            Izvorna i ciljna pozicija ne smeju biti iste.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Kvalitet" required>
            <QualitySelect value={qualityTypeId} onChange={setQualityTypeId} />
          </FormField>
          <FormField label="Količina (kom)" required hint="Ceo broj ≥ 1.">
            <Input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
            />
          </FormField>
        </div>
        <ErrorText error={transfer.error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Trebovanje (−qty)

/**
 * "Trebovanje" — uklanjanje/izdavanje dela sa police (POST /part-locations/requisition,
 * removal −qty). Backend odbija ako neto stanje na poziciji (za dati kvalitet) < količine.
 */
export function RequisitionPartLocationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [workOrder, setWorkOrder] = useState<WorkOrder | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [qualityTypeId, setQualityTypeId] = useState<number>(PART_QUALITY.GOOD);
  const [qty, setQty] = useState('');
  const requisition = useRequisitionPartLocation();

  useEffect(() => {
    if (open) {
      setWorkOrder(null);
      setPosition(null);
      setQualityTypeId(PART_QUALITY.GOOD);
      setQty('');
    }
  }, [open]);

  const canSubmit = workOrder != null && position != null && qtyValid(qty);

  async function submit() {
    if (workOrder == null || position == null || !qtyValid(qty)) return;
    try {
      await requisition.mutateAsync({
        workOrderId: workOrder.id,
        positionId: position.id,
        qualityTypeId,
        quantity: parseQty(qty),
      });
      onClose();
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Trebovanje dela"
      footer={
        <Footer
          onClose={onClose}
          onSubmit={submit}
          pending={requisition.isPending}
          disabled={!canSubmit}
        />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Izdavanje/uklanjanje dela sa police (−kom). Ne može preko raspoloživog neto stanja.
        </p>
        <FormField label="Radni nalog (RN)" required>
          <RnField value={workOrder} onChange={setWorkOrder} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Pozicija/polica" required>
            <PositionField value={position} onChange={setPosition} />
          </FormField>
          <FormField label="Kvalitet" required>
            <QualitySelect value={qualityTypeId} onChange={setQualityTypeId} />
          </FormField>
        </div>
        <FormField label="Količina (kom)" required hint="Ceo broj ≥ 1.">
          <Input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
        </FormField>
        <ErrorText error={requisition.error} />
      </div>
    </Dialog>
  );
}
