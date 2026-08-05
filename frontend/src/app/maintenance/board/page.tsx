'use client';

// Stara 1.0 ruta `/maintenance/board` → 3.0 `/odrzavanje?tab=board` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyMaintenanceBoardRedirectPage() {
  return <LegacyDesktopRedirect to="/odrzavanje?tab=board" label="Tabla održavanja" />;
}
