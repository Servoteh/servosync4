'use client';

// Stara 1.0 ruta `/projektni-biro` → 3.0 `/pb` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyProjektniBiroRedirectPage() {
  return <LegacyDesktopRedirect to="/pb" label="Projektni biro" />;
}
