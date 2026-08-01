// Kanonski prikaz KVALITETA i STATUSA jednog kucanja (`tech_processes` red).
//
// Zahtev 033/26 („Prikaz škarta u realizaciji"): kad kontrola otkuca ŠKART, kolona
// „Status" je do sada pokazivala zeleno „Završen" — formalno tačno (red JESTE
// zatvoren), ali dovodi u zabludu jer komadi nisu upotrebljivi. Zato škart
// PREGAZI „Završen" i prikazuje se crveno (DESIGN_SYSTEM.md §7).
//
// Deljeno jer isti red kucanja prikazuju četiri ekrana: Realizacija (lista
// kucanja + kartica kucanja), Evidencija u proizvodnji, i Kvalitet → Aktivnost
// kontrole. Mapa je ovde jedna — ranije je `QUALITY_META` bila iskopirana u dva
// ekrana, pa je nova vrsta statusa morala da se dodaje na dva mesta.

import { PART_QUALITY } from '@/api/tech-processes';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';

/** Kvalitet dela (`part_quality_types`): 0 = dobar, 1 = dorada, 2 = škart. */
export const QUALITY_META: Record<number, { tone: Tone; label: string }> = {
  [PART_QUALITY.GOOD]: { tone: 'success', label: 'Dobar' },
  [PART_QUALITY.REWORK]: { tone: 'warn', label: 'Dorada' },
  [PART_QUALITY.SCRAP]: { tone: 'danger', label: 'Škart' },
};

/** Pilula „Kvalitet" (opisna kolona): Dobar / Dorada / Škart. */
export function QualityBadge({ qualityTypeId }: { qualityTypeId: number }) {
  const m = QUALITY_META[qualityTypeId] ?? QUALITY_META[PART_QUALITY.GOOD];
  return <StatusBadge tone={m.tone} label={m.label} />;
}

/**
 * Pilula „Status" jednog kucanja. Prioritet: **ŠKART › Završen › otvoren**.
 *
 * Delimičan škart ne postoji na nivou reda: kontrola svaki kvalitet kuca u
 * ZASEBAN `tech_processes` red (tech-processes.service.ts `control()`), pa je red
 * ili škart ili nije. Podela količine (npr. 8 dobar + 2 škart) vidi se kao dva
 * reda + agregat operacije („Σ 10 kom (8 dobar · 0 dorada · 2 škart)"), a na
 * nivou RN-a „Gotovost" ionako broji samo dobre komade (`madeGoodPieces`), pa
 * nepopunjen nalog tamo sam od sebe nije „Gotovo".
 *
 * `openLabel` se razlikuje po ekranu („U izradi" u Realizaciji, „Otvoren" u
 * Evidenciji / Aktivnosti kontrole) — zatečeno ponašanje ostaje nepromenjeno.
 */
export function TechEntryStatusBadge({
  qualityTypeId,
  isProcessFinished,
  openLabel = 'U izradi',
}: {
  qualityTypeId: number | null | undefined;
  isProcessFinished: boolean | null | undefined;
  openLabel?: string;
}) {
  if (qualityTypeId === PART_QUALITY.SCRAP)
    return <StatusBadge tone="danger" label="ŠKART" />;
  return isProcessFinished ? (
    <StatusBadge tone="success" label="Završen" />
  ) : (
    <StatusBadge tone="info" label={openLabel} />
  );
}
