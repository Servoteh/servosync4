/**
 * Preostalo za INITIAL_PLACEMENT — „Uloži preostalo sa naloga (K kom)" (059/26).
 *
 * VERAN port 1.0 `computeLocInitialRemainder` (src/lib/lokacijeFilters.js:123):
 *   K = max(0, komada_total − Σ već smeštenog po nalogu)
 * `null` kad ukupno nije pouzdano (RN nema `komada`/`piece_count`, ili je
 * negativan) — tada se opcija sa brojem NE nudi i brana količine se NE primenjuje
 * (isti fail-open kao 1.0). `Math.max(0, …)` pokriva data glitch „uloženo više
 * od naloga": preostalo je 0, nikad negativno (upozorenje prikazuje pozivalac).
 *
 * Napomena o izvorima (izmereno na produ 03.08, nalog sa Duškove slike):
 * sy15 `bigtehn_work_orders_cache` ident `9811-3/56` → komada=3; u
 * `loc_item_placements` (order 9811-3, TP 56) uloženo 1 na D43/Magacin →
 * preostalo 2 — tačno „(2 kom)" sa 1.0 ekrana. Server (`loc_create_movement`)
 * ovu granicu NE sprovodi (nema `exceeds_order_quantity` u živoj fn) — brana je
 * klijentska, kao u 1.0.
 */
export function computeInitialRemainder(
  pieceCount: number | null | undefined,
  placements: ReadonlyArray<{ quantity?: string | number | null }>,
): number | null {
  // B1 (verify 059): odsutan total NIJE 0 — `Number(null) === 0` bi u debounce
  // prozoru / za RN bez komada lažno javio „kompletno uložen (0 od kom.)".
  if (pieceCount == null) return null;
  const total = Number(pieceCount);
  if (!Number.isFinite(total) || total < 0) return null;
  const placed = placements.reduce((a, r) => a + (Number(r?.quantity) || 0), 0);
  return Math.max(0, total - placed);
}
