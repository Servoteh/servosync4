'use client';

// Stara 1.0 ruta `/reset-password` → 3.0 `/promena-lozinke` (cutover 1.0, 05.08.2026).
//
// ⚠️ Nije 1:1 tok: 1.0 je ovde primala Supabase recovery token iz hash-a
// (`#access_token=…&type=recovery`) ili `?code=`, dok je 3.0 `/promena-lozinke`
// self-service izmena za PRIJAVLJENOG korisnika (traži staru lozinku). Token se
// prenosi (hash i query se čuvaju) ali se ne koristi. Reset lozinke u 3.0 radi
// admin i saopštava je korisniku — vidi docs/PLAN_IZMENE_KORISNIKA_2026-07.md.
// Stub postoji da stari mejl-link ne završi na 404, ne da nadomesti tok.
import { LegacyDesktopRedirect } from '@/components/legacy-desktop-redirect';

export default function LegacyResetPasswordRedirectPage() {
  return <LegacyDesktopRedirect to="/promena-lozinke" label="Promena lozinke" />;
}
