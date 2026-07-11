'use client';

import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import {
  DRAFT_ITEM_DECISION,
  HANDOVER_STATUS,
  type HandoverDraftItem,
  type StatusRef,
} from '@/api/handovers';
import { ApiError } from '@/api/client';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { cn } from '@/lib/cn';

// ─────────────────────────────────────────────────────────────── greške

/** Poruka greške iz backend odgovora (ApiError nosi srpsku poruku servisa). */
export function errMsg(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

export function ErrorText({ error }: { error: unknown }) {
  const msg = errMsg(error);
  if (!msg) return null;
  return (
    <p className="text-sm text-status-danger" role="alert">
      {msg}
    </p>
  );
}

export const errorBox =
  'rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger';

/** Warn varijanta `errorBox`-a — soft upozorenja (nisu blokada), P4 §6.5.3/§6.5.4. */
export const warnBox =
  'rounded-panel border border-status-warn/30 bg-status-warn-bg px-4 py-3 text-sm text-status-warn';

// ─────────────────────────────────────────────────────────────── potvrda akcije

/**
 * Dijalog za potvrdu akcije (umesto window.confirm) — kit Dialog + dva dugmeta,
 * isti obrazac kao na Radnicima/Strukturama. `danger` boji potvrdno dugme u
 * status-danger za destruktivne akcije; `error` prikazuje grešku iz mutacije
 * unutar dijaloga (dijalog ostaje otvoren dok se ne uspe).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Potvrdi',
  cancelLabel = 'Otkaži',
  onConfirm,
  onCancel,
  loading,
  danger,
  error,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  danger?: boolean;
  error?: unknown;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button
            onClick={onCancel}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            {cancelLabel}
          </button>
          <Button
            onClick={onConfirm}
            loading={loading}
            className={danger ? 'bg-status-danger text-white hover:bg-status-danger' : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">{message}</p>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────── sitni kontrolisani elementi

export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink',
        'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'min-h-20 w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink',
        'placeholder:text-ink-disabled',
        'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    />
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── legacy redovi

/** Tooltip za legacy primopredaje — isti tekst na bedžu i na disabled dugmadima. */
export const LEGACY_TOOLTIP =
  'Sinhronizovano iz QBigTehn — akcije do cutover-a u QBigTehn';

/**
 * Mali neutralni bedž „Legacy" — red primopredaje deriviran sync-om iz QBigTehn
 * tRN-a (`isLegacy` iz backend enrich-a). Benigno: pregled i štampa crteža rade
 * normalno; odobri/odbij/otkucaj/lansiraj/vrati do cutover-a blokira backend
 * guard (409, poruka iz backenda je krajnja istina) — UI drži dugmad disabled.
 */
export function LegacyBadge() {
  return (
    <span title={LEGACY_TOOLTIP} className="inline-flex">
      <StatusBadge tone="neutral" label="Legacy" />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────── statusi

/**
 * Status primopredaje (`HANDOVER_STATUS`) — kanonska mapa, ISTI ton/labela kao
 * `WO_STATUS` na Radnim nalozima (backend: ista `handover_statuses` lookup
 * tabela, vrednosti 1:1 preslikane, vidi handovers.service.ts).
 */
const HANDOVER_STATUS_META: Record<number, { tone: Tone; label: string }> = {
  [HANDOVER_STATUS.PENDING]: { tone: 'neutral', label: 'U obradi' },
  [HANDOVER_STATUS.APPROVED]: { tone: 'success', label: 'Saglasan' },
  [HANDOVER_STATUS.REJECTED]: { tone: 'danger', label: 'Odbijeno' },
  [HANDOVER_STATUS.LAUNCHED]: { tone: 'info', label: 'Lansiran' },
};
export function handoverStatusMeta(statusId: number): { tone: Tone; label: string } {
  return HANDOVER_STATUS_META[statusId] ?? { tone: 'neutral', label: 'U obradi' };
}

export const HANDOVER_STATUS_OPTIONS: { id: number; label: string }[] = [
  { id: HANDOVER_STATUS.PENDING, label: 'U obradi' },
  { id: HANDOVER_STATUS.APPROVED, label: 'Saglasan' },
  { id: HANDOVER_STATUS.REJECTED, label: 'Odbijeno' },
  { id: HANDOVER_STATUS.LAUNCHED, label: 'Lansiran' },
];

/**
 * Status nacrta (`handover_draft_statuses`) — DESIGN_SYSTEM §7 ne pokriva ovaj
 * domen i seed nije potvrđen (backend komentar: "nepotvrđen seed"), zato ton
 * ide heuristikom po nazivu iz API-ja (isti obrazac kao `pdm-helpers.ts` →
 * `drawingStatusMeta`), ne po fiksnom id-u. Integrator: prebaciti u kanonsku
 * mapu (§7) čim se seed potvrdi sa Vasom.
 */
export function draftStatusMeta(status: StatusRef | null): { tone: Tone; label: string } {
  const label = status?.name ?? '—';
  const n = label.toLowerCase();
  let tone: Tone = 'neutral';
  if (/lansir/.test(n)) tone = 'success';
  else if (/odbij|storn/.test(n)) tone = 'danger';
  else if (/\bpredat\b/.test(n)) tone = 'info';
  else if (/primopredaj/.test(n)) tone = 'warn';
  return { tone, label };
}

/**
 * Tip nacrta (`handover_drafts.draft_type`, SmallInt 0/1/2 — vrednosti iz
 * backend `dto/create-handover-draft.dto.ts`, NE menjati). Labele po legacy
 * rečniku (P4_SPEC §0 default: „Parcijalna predaja delova/podsklopova" /
 * „Glavni sklop"); mapiranje vrednosti 0/1/2 potvrđuje biro (§8 #6) —
 * korekcija labele ide SAMO ovde.
 */
export const DRAFT_TYPE_LABEL: Record<number, string> = {
  0: 'Glavni sklop',
  1: 'Parcijalna predaja — delovi',
  2: 'Parcijalna predaja — podsklopovi',
};
export function draftTypeLabel(draftType: number): string {
  return DRAFT_TYPE_LABEL[draftType] ?? `#${draftType}`;
}
/** Opcije za select „Tip nacrta" — izvedene iz iste konstante (jedan izvor labela). */
export const DRAFT_TYPE_OPTIONS: { id: number; label: string }[] = Object.entries(
  DRAFT_TYPE_LABEL,
).map(([id, label]) => ({ id: Number(id), label }));

// ─────────────────────────────────────────────────────────────── sporne stavke (§6.5.4)

/**
 * Sporna stavka BEZ odluke projektanta: pre-check duplikat koji nije isključen
 * i nema `decision_action` — tačno kriterijum backend submit gate-a (422
 * „Nacrt ima sporne stavke bez odluke projektanta"). UI: badge „Sporna" +
 * blokirano „Predaj u primopredaju" dok postoji ijedna.
 */
export function isUnresolvedDisputedItem(item: HandoverDraftItem): boolean {
  return (
    item.preCheckDuplicate &&
    !item.excludeFromHandover &&
    item.decisionAction === DRAFT_ITEM_DECISION.NONE
  );
}

/** Labela VEĆ DONETE odluke (prikaz u tabeli stavki) — akcije iz `DRAFT_ITEM_DECISION`. */
export const DRAFT_ITEM_DECISION_LABEL: Record<number, string> = {
  [DRAFT_ITEM_DECISION.NONE]: 'Bez odluke',
  [DRAFT_ITEM_DECISION.EXCLUDE]: 'Isključena',
  [DRAFT_ITEM_DECISION.RESUBMIT]: 'Predata ponovo',
  [DRAFT_ITEM_DECISION.ADJUST]: 'Dopunjena',
};
