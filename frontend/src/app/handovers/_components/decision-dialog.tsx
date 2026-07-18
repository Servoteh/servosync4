'use client';

import { useEffect, useState } from 'react';
import {
  DRAFT_ITEM_DECISION,
  useDecideDraftItem,
  type HandoverDraftItem,
} from '@/api/handovers';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDateTime, formatNumber } from '@/lib/format';
import { DRAFT_ITEM_DECISION_LABEL, ErrorText, NativeSelect } from './common';

const cancelBtn =
  'rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';

/** Opcije akcije — backend `DecideDraftItemDto` ugovor (1/2/3), P4 §6.5.4. */
const ACTION_OPTIONS: { id: number; label: string }[] = [
  { id: DRAFT_ITEM_DECISION.EXCLUDE, label: 'Isključi stavku — ne ide u primopredaju' },
  { id: DRAFT_ITEM_DECISION.RESUBMIT, label: 'Predaj ponovo — svesno, količina ostaje' },
  { id: DRAFT_ITEM_DECISION.ADJUST, label: 'Dopuni — koriguj količinu za izradu' },
];

/**
 * Odluka projektanta nad SPORNOM stavkom nacrta (`pre_check_duplicate`, P4
 * §6.5.4 / legacy `OdlukaAkcija`): 1=Isključi, 2=Predaj ponovo, 3=Dopuni (nova
 * količina OBAVEZNA — backend 400 inače, UI drži dugme disabled). Re-odluka je
 * dozvoljena dok nacrt nije zaključan (backend 422 za zaključan). Greška iz
 * backenda se prikazuje unutra; uspeh invalidira nacrte (stavke se osveže).
 */
export function DecideDraftItemDialog({
  draftId,
  item,
  open,
  onClose,
}: {
  draftId: number;
  item: HandoverDraftItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const decide = useDecideDraftItem();
  const [action, setAction] = useState<number>(DRAFT_ITEM_DECISION.EXCLUDE);
  const [newQuantity, setNewQuantity] = useState('');

  // Reset-na-open: prefill postojeće odluke (re-odluka) odnosno tekuće količine.
  useEffect(() => {
    if (!open || !item) return;
    decide.reset();
    setAction(
      item.decisionAction > 0 ? item.decisionAction : DRAFT_ITEM_DECISION.EXCLUDE,
    );
    setNewQuantity(String(item.quantityToProduce));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  if (!item) return null;

  const needsQuantity = action === DRAFT_ITEM_DECISION.ADJUST;
  const qty = Number(newQuantity);
  const qtyValid = Number.isInteger(qty) && qty >= 1;
  const canSubmit = !needsQuantity || qtyValid;

  function submit() {
    if (!item || !canSubmit) return;
    decide.mutate(
      {
        draftId,
        itemId: item.id,
        action,
        // Količina se šalje SAMO uz akciju 3 (backend 400 inače).
        newQuantity: needsQuantity ? qty : undefined,
      },
      { onSuccess: onClose },
    );
  }

  const drawingLabel = item.drawing
    ? `${item.drawing.drawingNumber} / ${item.drawing.revision}`
    : `#${item.drawingId}`;
  // Gde je duplikat — `preCheck*` id-jevi iz backend pre-check-a (§6.5.4).
  const whereDuplicate = item.preCheckWorkOrderId
    ? `ranije puštan na RN #${item.preCheckWorkOrderId}`
    : item.preCheckDraftId
      ? `ranije predat na nacrtu #${item.preCheckDraftId}`
      : 'ranije puštan na istom predmetu';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Odluka o spornoj stavci"
      footer={
        <>
          <button onClick={onClose} disabled={decide.isPending} className={cancelBtn}>
            Otkaži
          </button>
          <Button onClick={submit} loading={decide.isPending} disabled={!canSubmit}>
            Snimi odluku
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Crtež <span className="tnums font-semibold text-ink">{drawingLabel}</span> je označen kao
          duplikat — {whereDuplicate}. Odluka projektanta je obavezna pre predaje nacrta u
          primopredaju.
        </p>
        {item.decisionAction > 0 && (
          <p className="text-xs text-ink-disabled">
            Postojeća odluka: {DRAFT_ITEM_DECISION_LABEL[item.decisionAction] ?? '—'}
            {item.decisionDateTime ? ` · ${formatDateTime(item.decisionDateTime)}` : ''} — snimanjem
            se menja.
          </p>
        )}
        <FormField label="Akcija" required>
          <NativeSelect
            value={action}
            onChange={(e) => setAction(Number(e.target.value))}
            className="w-full"
          >
            {ACTION_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {needsQuantity && (
          <FormField
            label="Nova količina za izradu"
            required
            hint={`Ceo broj ≥ 1 — zamenjuje tekuću količinu (${formatNumber(item.quantityToProduce)}).`}
          >
            <Input
              type="number"
              min={1}
              value={newQuantity}
              onChange={(e) => setNewQuantity(e.target.value)}
            />
          </FormField>
        )}
        <ErrorText error={decide.error} />
      </div>
    </Dialog>
  );
}
