'use client';

// Stara ruta `/m/odrzavanje` → kanonska `/mob/odrzavanje` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyOdrzavanjeRedirectPage() {
  return <LegacyMobRedirect to="/mob/odrzavanje" label="Održavanje" />;
}
