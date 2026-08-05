'use client';

// Stara 1.0 ruta `/m/history` → kanonska `/mob/lokacije/istorija` (cutover 1.0, 05.08.2026).
// Stub za obeleživače, APK prečicu i LAN `:3000` — vidi ._components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyHistoryRedirectPage() {
  return <LegacyMobRedirect to="/mob/lokacije/istorija" label="Moja istorija" />;
}
