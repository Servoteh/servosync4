'use client';

// Stara ruta `/m/energetika` → kanonska `/mob/energetika` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyEnergetikaRedirectPage() {
  return <LegacyMobRedirect to="/mob/energetika" label="Energetika" />;
}
