'use client';

// Stara ruta `/m/prisustvo` → kanonska `/mob/moje-prisustvo` (PLAN_MOB_3.0 Faza 0).
// ⚠️ PREIMENOVANA meta: `/mob/prisustvo` je DRUGI ekran (pregled prisustva uživo,
// kadrovska), pa G6 self-service („moje prisustvo + korekcije") ide na `/mob/moje-prisustvo`.
// Stub SAMO za LAN `:3000` i stare obeleživače — vidi ../_components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyPrisustvoRedirectPage() {
  return <LegacyMobRedirect to="/mob/moje-prisustvo" label="Moje prisustvo" />;
}
