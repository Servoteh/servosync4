'use client';

// Stara 1.0 ruta `/moj-profil` → 3.0 `/profil` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyMojProfilRedirectPage() {
  return <LegacyDesktopRedirect to="/profil" label="Moj profil" />;
}
