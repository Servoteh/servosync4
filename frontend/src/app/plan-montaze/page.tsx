'use client';

// Stara 1.0 ruta `/plan-montaze` → 3.0 `/montaza` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyPlanMontazeRedirectPage() {
  return <LegacyDesktopRedirect to="/montaza" label="Plan montaže" />;
}
