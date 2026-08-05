'use client';

// Stara 1.0 ruta `/maintenance/assets/facilities` → 3.0 `/odrzavanje?tab=objekti` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyMaintenanceAssetsFacilitiesRedirectPage() {
  return <LegacyDesktopRedirect to="/odrzavanje?tab=objekti" label="Objekti" />;
}
