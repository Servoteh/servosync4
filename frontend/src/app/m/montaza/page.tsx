'use client';

// Stara ruta `/m/montaza` → kanonska `/mob/montaza` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyMontazaRedirectPage() {
  return <LegacyMobRedirect to="/mob/montaza" label="Plan montaže" />;
}
