'use client';

// Stara 1.0 ruta `/m/reversi` → kanonska `/mob/reversi` (cutover 1.0, 05.08.2026).
// Stub za obeleživače, APK prečicu i LAN `:3000` — vidi ._components/legacy-redirect.
import { LegacyMobRedirect } from '../_components/legacy-redirect';

export default function LegacyReversiRedirectPage() {
  return <LegacyMobRedirect to="/mob/reversi" label="Moji reversi" />;
}
