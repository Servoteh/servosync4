'use client';

// Stara 1.0 ruta `/hub` (izbornik modula) → 3.0 `/pocetna` (cutover 1.0, 05.08.2026).
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyHubRedirectPage() {
  return <LegacyDesktopRedirect to="/pocetna" label="Početna" />;
}
