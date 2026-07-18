'use client';

import { Info } from 'lucide-react';
import type { Tone } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';

/** Traka sa porukom greške liste (isti obrazac kao work-orders/tech-processes/pdm). */
export const errorBox =
  'rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger';

/**
 * Napomena „uskoro" za planiranje/BOM eksploziju — van obima ovog talasa
 * (MODULE_SPEC_mrp §7, čeka BACKEND_RULES §11.3). Ista tipografija kao
 * `EmptyState` / `ComingSoonNote` na `part-locations`, kao kompaktna traka
 * jer tabela iznad/ispod nije prazna.
 */
export function ComingSoonNote({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-panel border border-line-soft bg-surface-2/60 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
      <div>
        <p className="text-base text-ink-secondary">{title}</p>
        <p className="text-sm text-ink-disabled">{hint}</p>
      </div>
    </div>
  );
}

/** Količina sa jedinicom mere (DESIGN_SYSTEM §5 — "24 kom") ili '—'. */
export function qtyLabel(qty: number | null | undefined, unit?: string | null): string {
  if (qty == null) return '—';
  return unit ? `${formatNumber(qty)} ${unit}` : formatNumber(qty);
}

/**
 * "Obrađena" potreba se pouzdano zna samo preko `planId` (migration/05:
 * „Status obradjenosti: MRP_Potrebe.IDPlan NOT NULL = obradjena"). Raw šifra
 * `status` (0..4) nema potvrđenu kanonsku mapu dok se planiranje ne dizajnira
 * (§11.3) — prikazuje se odvojeno, ne prevodi se u tekst.
 */
export function planMeta(planId: number | null): { tone: Tone; label: string } {
  return planId != null
    ? { tone: 'success', label: 'U planu' }
    : { tone: 'neutral', label: 'Bez plana' };
}

/** `Izvor` potrebe: 1 = automatski (BOM eksplozija), 2 = ručno (migration/08 §6). */
export function sourceLabel(source: number): string {
  if (source === 1) return 'Automatski (BOM)';
  if (source === 2) return 'Ručno';
  return `Izvor ${source}`;
}

/** `TipEksplozije`: 1 = top-level, 2 = puna (MODULE_SPEC_mrp §3.4). */
export function explosionLabel(type: number | null): string {
  if (type === 1) return 'Top-level';
  if (type === 2) return 'Puna eksplozija';
  return '—';
}

/**
 * Pokrivenost stavke — dokumentovana formula (migration/05: `StatusArtikla`
 * 2=crveno Slobodno≤0, 1=žuto Slobodno<Potrebno, 0=zeleno), računa se ovde iz
 * `freeStock`/`requiredQuantity` koje API već vraća — pouzdanije nego oslanjanje
 * na raw `itemStatus` (workflow šifra stavke, drugo polje, nepotvrđeno značenje).
 */
export function coverageMeta(
  freeStock: number | null,
  required: number,
): { tone: Tone; label: string } {
  if (freeStock == null) return { tone: 'neutral', label: 'Nema zalihe' };
  if (freeStock <= 0) return { tone: 'danger', label: 'Nedostaje' };
  if (freeStock < required) return { tone: 'warn', label: 'Delimično' };
  return { tone: 'success', label: 'Pokriveno' };
}
