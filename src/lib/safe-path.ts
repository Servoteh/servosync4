/**
 * Bezbedna INTERNA ruta za redirect (auth entry / deep-link handoff). Sprečava
 * open-redirect: slaba provera `startsWith('/') && !startsWith('//')` propušta
 * backslash trik `/\evil.com` — WHATWG URL parser za http/https tretira `\` kao `/`
 * pa `new URL('/\evil.com', origin)` pobegne na `https://evil.com`. Ulaz može doći
 * iz SIROVOG URL fragment-a (top-level SSO handoff), koji browser NE normalizuje, pa
 * se ne smemo osloniti na normalizaciju — proveravamo eksplicitno.
 *
 * Prihvata samo: string koji počinje sa `/`, bez `//` (protocol-relative), bez
 * backslash/kontrolnih znakova, koji se razreši u ISTI origin, i nije `/login`.
 */
export function isSafeInternalPath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (!p.startsWith('/') || p.startsWith('//')) return false;
  // backslash → URL parser ga svede na `/` (cross-origin); kontrolni znaci = rizik.
  if (/[\\\x00-\x1f\x7f]/.test(p)) return false;
  let u: URL;
  try {
    u = new URL(p, 'https://internal.invalid');
  } catch {
    return false;
  }
  if (u.origin !== 'https://internal.invalid') return false; // pobegao van origin-a
  if (u.pathname === '/login' || u.pathname.startsWith('/login/')) return false;
  return true;
}
