'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import type { DueLiability } from '@/api/placanja';

/**
 * 3-WAY MATCH upozorenja na pripremi plaćanja (naručeno/primljeno/fakturisano).
 *
 * ⚠️ POSLOVNO PRAVILO (odluka korisnika, izričita): odstupanje se PRIJAVLJUJE, ali
 * NIKAD ne blokira plaćanje. Ova komponenta je ISKLJUČIVO vizuelno upozorenje —
 * ne onemogućava nijedan checkbox, ni dugme „Kreiraj naloge"/„Potpiši"/„Izvezi FX",
 * i ne menja selekciju. Ako se ikad pojavi `disabled={... hasMatchWarnings ...}`,
 * to je greška, ne funkcija.
 *
 * Backend šalje `matchWarnings`/`hasMatchWarnings` UZ postojeća polja dospele
 * obaveze (`payment-preparation.service.ts` → `DueLiability`). Tip se ovde proširuje
 * lokalno (polja su dodata na odgovor, `@/api/placanja` nije menjan) — polja su
 * opciona da stariji odgovor i dalje radi.
 */

/** Jedno upozorenje uz dospelu obavezu — 1:1 sa backend `PaymentMatchWarning`. */
export interface DueMatchWarning {
  code: string;
  level: 'INFO' | 'WARNING';
  /** Srpski opis („fakturisano više od primljenog" i sl.) — ide u tooltip. */
  message: string;
  orderId: number;
  orderNumber: string;
  supplierId: number;
  lineNo: number | null;
  documentNumbers: string[];
}

/** Dospela obaveza sa 3-way match upozorenjima (dodatna polja odgovora). */
export type DueLiabilityWithMatch = DueLiability & {
  matchWarnings?: DueMatchWarning[];
  hasMatchWarnings?: boolean;
};

/** Upozorenja jedne stavke (prazno kad backend nema modul nabavke povezan). */
export function warningsOf(row: DueLiabilityWithMatch): DueMatchWarning[] {
  return row.matchWarnings ?? [];
}

/** Broj stavaka koje nose bar jedno upozorenje nivoa WARNING. */
export function countRowsWithWarnings(rows: DueLiabilityWithMatch[]): number {
  return rows.filter((r) => warningsOf(r).some((w) => w.level === 'WARNING')).length;
}

/**
 * Ikonica upozorenja u redu pripreme plaćanja. Tooltip (`title`) nosi pun tekst
 * svih nalaza — npr. „Fakturisano 120 kom, a primljeno 100 kom — fakturisano više
 * nego primljeno." Bez nalaza red ostaje prazan (crtica), bez vizuelne buke.
 */
export function MatchWarningCell({ row }: { row: DueLiabilityWithMatch }) {
  const warnings = warningsOf(row);
  if (warnings.length === 0) return <span className="text-ink-disabled">—</span>;

  const hasWarning = warnings.some((w) => w.level === 'WARNING');
  const title = warnings
    .map((w) => `${w.orderNumber}${w.lineNo != null ? ` / st. ${w.lineNo}` : ''}: ${w.message}`)
    .join('\n');

  return (
    <span
      title={title}
      aria-label={`Odstupanje po narudžbenici: ${title}`}
      className={`inline-flex items-center gap-1 ${
        hasWarning ? 'text-status-warn' : 'text-status-info'
      }`}
    >
      {hasWarning ? (
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <Info className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <span className="tnums text-xs">{warnings.length}</span>
    </span>
  );
}

/**
 * Zbirna traka iznad tabele — koliko stavaka nosi upozorenje. Namerno u `warn`
 * tonu (kanonska mapa §7), sa izričitom porukom da plaćanje NIJE blokirano.
 */
export function MatchWarningsBanner({ rows }: { rows: DueLiabilityWithMatch[] }) {
  const count = countRowsWithWarnings(rows);
  if (count === 0) return null;

  const codes = new Set<string>();
  for (const r of rows)
    for (const w of warningsOf(r)) if (w.level === 'WARNING') codes.add(w.code);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-2">
      <span className="flex items-center gap-2 text-sm font-medium text-status-warn">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {formatNumber(count)} stavk{count === 1 ? 'a nosi' : 'i nose'} odstupanje
        naručeno/primljeno/fakturisano.
      </span>
      <span className="text-sm text-ink-secondary">
        Upozorenje je informativno — plaćanje se normalno priprema, potpisuje i izvozi.
      </span>
      <span className="flex flex-wrap gap-1">
        {[...codes].map((c) => (
          <StatusBadge key={c} tone="warn" label={MATCH_CODE_LABEL[c] ?? c} />
        ))}
      </span>
    </div>
  );
}

/** Kratke srpske oznake kodova (isti katalog kao modul Nabavka). */
const MATCH_CODE_LABEL: Record<string, string> = {
  QTY_OVER_RECEIPT: 'Fakturisano > primljeno',
  QTY_UNDER_RECEIPT: 'Fakturisano < primljeno',
  PRICE_VARIANCE: 'Odstupanje cene',
  QTY_OVER_ORDER: 'Primljeno > naručeno',
  NO_RECEIPT: 'Faktura bez prijema',
};
