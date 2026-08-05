'use client';

// Stara 1.0 ruta `/maintenance/katalog` → 3.0 `/odrzavanje?tab=masine` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyMaintenanceKatalogRedirectPage() {
  return <LegacyDesktopRedirect to="/odrzavanje?tab=masine" label="Katalog mašina" />;
}
