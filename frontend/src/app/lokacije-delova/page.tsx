'use client';

// Stara 1.0 ruta `/lokacije-delova` → 3.0 `/lokacije` (cutover 1.0, 05.08.2026).
// Stub postoji samo zbog obeleživača i starih linkova — vidi
// src/components/legacy-desktop-redirect.tsx.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyLokacijeDelovaRedirectPage() {
  return <LegacyDesktopRedirect to="/lokacije" label="Lokacije delova" />;
}
