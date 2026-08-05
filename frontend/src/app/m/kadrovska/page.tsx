'use client';

// Stara 1.0 ruta `/m/kadrovska` → kanonska `/mob/kadrovska` (cutover 1.0, 05.08.2026).
// Stub za obeleživače, APK prečicu i LAN `:3000` — vidi ._components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyKadrovskaRedirectPage() {
  return <LegacyMobRedirect to="/mob/kadrovska" label="Kadrovska" />;
}
