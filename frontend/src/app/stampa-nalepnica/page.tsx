'use client';

// Stara 1.0 ruta `/stampa-nalepnica` → 3.0 `/lokacije?tab=stampa` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyStampaNalepnicaRedirectPage() {
  return <LegacyDesktopRedirect to="/lokacije?tab=stampa" label="Štampa nalepnica" />;
}
