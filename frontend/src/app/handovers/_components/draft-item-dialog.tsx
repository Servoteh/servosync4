'use client';

// Zahtev 027/26 (Igor Voštić, 26.07): pun rad nad NACRTOM kao nad dokumentom —
// izmena broja komada postojeće stavke i brisanje pogrešno ubačene stavke.
// Do sada je „Izmeni" menjalo samo zaglavlje nacrta, a stavke su se mogle samo
// dodavati. Obe akcije rade SAMO dok je nacrt radni (nije zaključan/predat) —
// backend kapija je krajnja istina (422), UI dugmad se ne prikazuje za zaključan.

import { useEffect, useState } from 'react';
import {
  useDeleteDraftItem,
  useUpdateDraftItem,
  type HandoverDraftItem,
} from '@/api/handovers';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatNumber } from '@/lib/format';
import { ConfirmDialog, ErrorText, Textarea } from './common';

const cancelBtn =
  'rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';

/** Broj/revizija crteža stavke — isti prikaz kao u tabeli stavki i odluci. */
export function draftItemLabel(item: HandoverDraftItem): string {
  return item.drawing
    ? `${item.drawing.drawingNumber} / ${item.drawing.revision}`
    : `#${item.drawingId}`;
}

/**
 * Izmena STAVKE nacrta — broj komada za izradu i napomena
 * (PATCH /v1/handover-drafts/:id/items/:itemId). Crtež se namerno ne menja:
 * zamena crteža bi zaobišla provere koje backend radi pri dodavanju (odobren
 * PDM status, duplikat na predmetu), pa se radi kao brisanje + „Dodaj u nacrt".
 *
 * Nije isto što i odluka „Dopuni" (§6.5.4): ta upisuje `decision_action` i skida
 * blokadu predaje sporne stavke; ovo je obična ispravka pogrešnog unosa i
 * odluku ne dira (sporna stavka i dalje traži odluku pre predaje).
 */
export function EditDraftItemDialog({
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
  const update = useUpdateDraftItem();
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');

  // Reset-na-open: prefill tekućih vrednosti stavke (isti obrazac kao odluka).
  useEffect(() => {
    if (!open || !item) return;
    update.reset();
    setQuantity(String(item.quantityToProduce));
    setNote(item.note ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  if (!item) return null;

  // Ista validacija kao backend DTO (ceo broj ≥ 1) — 400 inače.
  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty >= 1;

  function submit() {
    if (!item || !qtyValid) return;
    update.mutate(
      {
        draftId,
        itemId: item.id,
        data: { quantityToProduce: qty, note: note.trim() || null },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izmena stavke nacrta"
      footer={
        <>
          <button onClick={onClose} disabled={update.isPending} className={cancelBtn}>
            Otkaži
          </button>
          <Button onClick={submit} loading={update.isPending} disabled={!qtyValid}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Crtež <span className="tnums font-semibold text-ink">{draftItemLabel(item)}</span>
          {item.drawing?.name ? ` · ${item.drawing.name}` : ''}
        </p>
        <FormField
          label="Broj komada za izradu"
          required
          error={qtyValid ? undefined : 'Mora biti ceo broj ≥ 1.'}
          hint={`Tekuća količina: ${formatNumber(item.quantityToProduce)} kom.`}
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-32"
          />
        </FormField>
        <FormField label="Napomena">
          <Textarea
            value={note}
            maxLength={250}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
        <ErrorText error={update.error} />
      </div>
    </Dialog>
  );
}

/**
 * Potvrda brisanja stavke iz nacrta (DELETE /v1/handover-drafts/:id/items/:itemId).
 * HARD brisanje — tabela nema `deleted_at`; trag ko je brisao ostaje u
 * `audit_log`. Ako stavka treba da OSTANE evidentirana a ne ide u primopredaju,
 * pravi put je odluka „Isključi" (§6.5.4), zato je to napisano u poruci.
 */
export function DeleteDraftItemDialog({
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
  const del = useDeleteDraftItem();

  useEffect(() => {
    if (open) del.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  if (!item) return null;

  return (
    <ConfirmDialog
      open={open}
      title="Brisanje stavke iz nacrta"
      confirmLabel="Obriši"
      danger
      loading={del.isPending}
      error={del.error}
      onCancel={onClose}
      onConfirm={() => del.mutate({ draftId, itemId: item.id }, { onSuccess: onClose })}
      message={
        <>
          Stavka <span className="tnums font-semibold text-ink">{draftItemLabel(item)}</span> (
          {formatNumber(item.quantityToProduce)} kom) se briše iz nacrta — bez opoziva.
          {item.preCheckDuplicate
            ? ' Ako stavka treba da ostane evidentirana a ne ide u ovu primopredaju, koristi odluku „Isključi”.'
            : ''}
        </>
      }
    />
  );
}
