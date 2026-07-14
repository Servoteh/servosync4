'use client';

// P3 (Dosije) deljeni primitivci — labele/statusi portovani iz 1.0
// (medicalExamsModal / certificatesModal / employeeAuditModal / auditLog.js).
// Datumi: native <input type="date"> daje YYYY-MM-DD (validan ISO8601 date za BE).

import type { ReactNode } from 'react';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';

/* ── Tip pregleda / sertifikata (1.0 EXAM_TYPE_LABELS / CERT_TYPE_LABELS) ── */
export const EXAM_TYPE_LABELS: Record<string, string> = {
  redovan: 'Redovan',
  prethodni: 'Prethodni',
  periodicni: 'Periodični',
  ciljani: 'Ciljani',
  vanredni: 'Vanredni',
};

export const CERT_TYPE_LABELS: Record<string, string> = {
  driver_license: 'Vozačka dozvola',
  forklift: 'Viljuškar',
  welding: 'Varenje',
  znr: 'ZNR (zaštita na radu)',
  iso: 'ISO sertifikat',
  electrical: 'Elektro licenca',
  height: 'Rad na visini',
  other: 'Ostalo',
};

/* ── Audit (1.0 auditLog.js / employeeAuditModal.js) ── */
export const AUDIT_TABLE_LABELS: Record<string, string> = {
  salary_terms: 'Uslovi zarade',
  salary_payroll: 'Mesečni obračun',
  contracts: 'Ugovori',
  vacation_entitlements: 'Pravo na GO',
  vacation_balances: 'Saldo GO',
  kadr_medical_exams: 'Lekarski pregledi',
  kadr_certificates: 'Sertifikati',
};
export const AUDIT_ACTION: Record<string, { label: string; tone: Tone }> = {
  INSERT: { label: 'Dodato', tone: 'success' },
  UPDATE: { label: 'Izmenjeno', tone: 'info' },
  DELETE: { label: 'Obrisano', tone: 'danger' },
};
/** Lepe labele polja u audit diff-u (1.0 employeeAuditModal _fieldLabel). */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  salary_type: 'Tip zarade',
  amount: 'Iznos',
  amount_type: 'Neto / Bruto',
  currency: 'Valuta',
  hourly_rate: 'Satnica',
  effective_from: 'Važi od',
  effective_to: 'Važi do',
  transport_allowance_rsd: 'Prevoz (RSD)',
  per_diem_rsd: 'Din. dnevnica',
  per_diem_eur: 'Dev. dnevnica',
  contract_ref: 'Ref. ugovora',
  note: 'Napomena',
  date_from: 'Od',
  date_to: 'Do',
  contract_type: 'Tip ugovora',
  number: 'Broj',
  position: 'Pozicija',
  is_active: 'Aktivan',
  days_total: 'Godišnja baza (dana)',
  days_carried_over: 'Preneto (dana)',
  days_used: 'Iskorišćeno',
  days_remaining: 'Preostalo',
  year: 'Godina',
  exam_date: 'Datum pregleda',
  valid_until: 'Važi do',
  exam_type: 'Tip pregleda',
  cost_rsd: 'Trošak (RSD)',
  institution: 'Ustanova',
  cert_type: 'Tip sertifikata',
  cert_name: 'Naziv',
  issued_on: 'Izdat',
  expires_on: 'Ističe',
  status: 'Status',
};

const AUDIT_HIDDEN = new Set(['id', 'created_by', 'updated_by', 'created_at', 'updated_at']);
export function auditFieldLabel(k: string): string {
  return AUDIT_FIELD_LABELS[k] ?? k;
}
export function auditIsHidden(k: string): boolean {
  return AUDIT_HIDDEN.has(k);
}
export function auditFmtValue(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-ink-disabled">—</span>;
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'object') return <code className="text-xs">{JSON.stringify(v)}</code>;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDate(v.slice(0, 10));
  return String(v);
}

/** Diff before/after → samo promenjena polja (1.0 diffAuditRow). */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, { before: unknown; after: unknown }> {
  const b = before ?? {};
  const a = after ?? {};
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === 'created_at' || k === 'updated_at') continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out[k] = { before: b[k], after: a[k] };
  }
  return out;
}

/* ── Datum-istek → status (1.0 statusFromValid / statusBadge) ── */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const to = new Date(String(dateStr).slice(0, 10));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((to.getTime() - today.getTime()) / 86400000);
}

/** Pilula isteka datuma. `lifetime` = kad je prazno „Trajno" (sertifikati) umesto „—". */
export function ExpiryBadge({ date, lifetime = false }: { date: string | null | undefined; lifetime?: boolean }) {
  if (!date) return lifetime ? <StatusBadge tone="neutral" label="Trajno" /> : <span className="text-ink-disabled">—</span>;
  const d = daysUntil(date);
  if (d == null) return <span className="text-ink-disabled">—</span>;
  if (d < 0) return <StatusBadge tone="danger" label="Istekao" />;
  if (d <= 30) return <StatusBadge tone="warn" label={`ističe za ${d}d`} />;
  return <StatusBadge tone="success" label="važi" />;
}

/** Status pill iz view `status` kolone (medical/cert status view). */
export function StatusFromView({ status, daysLeft }: { status: string | null | undefined; daysLeft?: number | null }) {
  switch (status) {
    case 'expired':
      return <StatusBadge tone="danger" label="Istekao" />;
    case 'expiring_soon':
      return <StatusBadge tone="warn" label={daysLeft != null ? `ističe za ${daysLeft}d` : 'ističe uskoro'} />;
    case 'ok':
      return <StatusBadge tone="success" label="važi" />;
    case 'lifetime':
      return <StatusBadge tone="neutral" label="Trajno" />;
    case 'never':
      return <StatusBadge tone="neutral" label="nema pregleda" />;
    case 'unknown_expiry':
      return <StatusBadge tone="info" label="bez isteka" />;
    default:
      return <span className="text-ink-disabled">—</span>;
  }
}

export function fmtRsd(n: unknown): string {
  const v = Number(n || 0);
  return `${v.toLocaleString('sr-RS', { maximumFractionDigits: 2 })} RSD`;
}

/** ISO datum → vrednost za <input type="date"> (YYYY-MM-DD) ili ''. */
export function toDateInput(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : '';
}

/* Deljeni class tokeni (parity sa zaposleni-tab SELECT_CLS). */
export const INPUT_CLS =
  'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:border-accent';
export const ROW_BTN =
  'rounded-control border border-line bg-surface px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2 hover:text-ink disabled:opacity-50';
export const ROW_BTN_DANGER =
  'rounded-control border border-status-danger/40 bg-surface px-2 py-0.5 text-xs text-status-danger hover:bg-status-danger-bg disabled:opacity-50';

/** Sekcijski naslov u dosijeu. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
      {action}
    </div>
  );
}

/** Potvrda brisanja (parity 1.0 askConfirm). Nested Dialog — leži iznad dosijea. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Obriši',
  danger = true,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Otkaži
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink">{body}</div>
    </Dialog>
  );
}
