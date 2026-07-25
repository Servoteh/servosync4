'use client';

// Stara ruta `/m/ai` → kanonska `/mob/ai` (PLAN_MOB_3.0 Faza 0).
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyAiRedirectPage() {
  return <LegacyMobRedirect to="/mob/ai" label="AI asistent" />;
}
