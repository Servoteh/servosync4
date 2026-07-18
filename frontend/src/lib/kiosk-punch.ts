// Punch poziv za kapijski kiosk prisustva (F2 pilot). Kiosk je JAVNA ruta
// (/kiosk-prisustvo — tablet bez prijave); barijera je „device key" (x-kiosk-key,
// localStorage na tabletu) + skenirani lični QR token zaposlenog.
//
// ── ARHITEKTURA (BE odluka) ─────────────────────────────────────────────────
// 1.0 punch ide na Supabase EDGE funkciju `kiosk-punch` (živi na sy15), koja zove
// SECURITY DEFINER RPC `kiosk_record_punch` (service role → attendance_events,
// source='kiosk', auto smer ulaz/izlaz, dedup <30s). 2.0 front NEMA Supabase
// klijent ni anon ključ, pa su URL/apikey RUNTIME-konfigurabilni (bez rebuild-a,
// ključ NIJE zapečen u statički bundle):
//   window.__SERVOSYNC_KIOSK_PUNCH_URL__     → npr. https://<sy15>/functions/v1/kiosk-punch
//   window.__SERVOSYNC_KIOSK_PUNCH_APIKEY__  → Supabase anon (Kong gateway ga traži)
// (fallback: NEXT_PUBLIC_KIOSK_PUNCH_URL / _APIKEY iz build env-a). Ops ih postavlja
// u out/config.js na kiosk-tabletu.
//
// TODO(BE): čistiji 3.0 put je NestJS proxy `POST /v1/kadrovska/kiosk/punch`
// (public ruta bez JWT, guard x-kiosk-key header → poziva RPC kiosk_record_punch),
// pa front ne bi trebao Supabase kredencijale — samo NestJS bazu koju već zna.
// Kad taj endpoint zaživi, preusmeri resolveKioskPunchUrl() na njega.

declare global {
  interface Window {
    __SERVOSYNC_KIOSK_PUNCH_URL__?: string;
    __SERVOSYNC_KIOSK_PUNCH_APIKEY__?: string;
  }
}

/** Odgovor edge funkcije `kiosk-punch` (paritet 1.0). */
export interface KioskPunchResult {
  ok: boolean;
  direction?: 'in' | 'out';
  employee_name?: string;
  time?: string;
  duplicate?: boolean;
  error?: string;
}

function resolveKioskPunchUrl(): string | null {
  if (typeof window !== 'undefined') {
    const override = window.__SERVOSYNC_KIOSK_PUNCH_URL__?.trim();
    if (override) return override.replace(/\/+$/, '');
  }
  const env = process.env.NEXT_PUBLIC_KIOSK_PUNCH_URL?.trim();
  return env ? env.replace(/\/+$/, '') : null;
}

function resolveKioskApikey(): string | null {
  if (typeof window !== 'undefined') {
    const override = window.__SERVOSYNC_KIOSK_PUNCH_APIKEY__?.trim();
    if (override) return override;
  }
  return process.env.NEXT_PUBLIC_KIOSK_PUNCH_APIKEY?.trim() || null;
}

/** Da li je kiosk-punch endpoint uopšte podešen (za jasan „nije podešen" ekran). */
export function isKioskPunchConfigured(): boolean {
  return !!resolveKioskPunchUrl();
}

/** Pošalji skenirani token na kiosk-punch endpoint. Nikad ne baca — vraća
 *  strukturisan rezultat (kiosk mora ostati živ i pri mrežnoj grešci). */
export async function kioskPunch(token: string, deviceKey: string): Promise<KioskPunchResult> {
  const url = resolveKioskPunchUrl();
  if (!url) return { ok: false, error: 'not_configured' };
  const apikey = resolveKioskApikey();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-kiosk-key': deviceKey,
        ...(apikey ? { apikey, Authorization: `Bearer ${apikey}` } : {}),
      },
      body: JSON.stringify({ token }),
    });
    const data = (await res.json().catch(() => ({ ok: false, error: 'bad_response' }))) as KioskPunchResult;
    return data;
  } catch {
    return { ok: false, error: 'mreza' };
  }
}
