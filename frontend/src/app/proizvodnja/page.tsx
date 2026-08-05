'use client';

// Stara 1.0 ruta `/proizvodnja` → 3.0 `/plan-proizvodnje` (cutover 1.0, 05.08.2026).
// Golo `/proizvodnja` je u 1.0 otvaralo pod-modul Planiranje
// (`src/ui/proizvodnja/index.js` DEFAULT_SUB = 'planiranje'), pa se preslikava tamo.
// `/plan-proizvodnje` i `/pracenje-proizvodnje` u 3.0 imaju ista imena kao u 1.0 —
// njima stub ne treba.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyProizvodnjaRedirectPage() {
  return <LegacyDesktopRedirect to="/plan-proizvodnje" label="Proizvodnja — planiranje" />;
}
