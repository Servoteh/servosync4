import type { Tone } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import type { DrawingStatusRef } from '@/api/pdm';

/** Masa sa jedinicom (kg) ili '—' (DESIGN_SYSTEM §5 — količine sa jedinicom). */
export function weightLabel(weight: number | null | undefined): string {
  return weight == null ? '—' : `${formatNumber(weight)} kg`;
}

/**
 * PDM status → ton pilule + labela.
 *
 * NAPOMENA: kanonska mapa statusa (DESIGN_SYSTEM §7) trenutno ne pokriva PDM
 * statuse crteža — dok se ne uvedu u mapu, ton se izvodi heuristikom po nazivu
 * (default neutralan). Integrator: uvesti PDM statuse u §7 i zameniti heuristiku.
 */
export function drawingStatusMeta(
  status: DrawingStatusRef | null,
  pdmStatus?: string | null,
): { tone: Tone; label: string } {
  const label = status?.name ?? pdmStatus ?? '—';
  const n = label.toLowerCase();
  let tone: Tone = 'neutral';
  if (/(odobr|objav|usvoj|zavr|verifikov|aktiv)/.test(n)) tone = 'success';
  else if (/(izrad|toku|revizij|kreir|nacrt)/.test(n)) tone = 'info';
  else if (/(čeka|ceka|proveri|provera)/.test(n)) tone = 'warn';
  else if (/(otkaz|zastar|poništ|ponist|odbij|nevaž|nevaz|obrisan)/.test(n)) tone = 'danger';
  return { tone, label };
}
