'use client';

// Stara ruta `/m/sastanci` → kanonska `/mob/sastanci` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
// `?open=<id>` deep-link se prenosi (LegacyMobRedirect nosi query).
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacySastanciRedirectPage() {
  return <LegacyMobRedirect to="/mob/sastanci" label="Sastanci" />;
}
