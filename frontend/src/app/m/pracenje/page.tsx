'use client';

// Stara ruta `/m/pracenje` → kanonska `/mob/pracenje` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyPracenjeRedirectPage() {
  return <LegacyMobRedirect to="/mob/pracenje" label="Praćenje" />;
}
