const UPSTREAM = 'https://servoteh-plan-montaze.pages.dev';

/*
 * Same-origin kapija za staru 1.0 mobilnu: instalirani Capacitor APK učitava
 * /m sa ovog domena, a nativni plugini (barkod skener, STT, push) rade samo
 * dok WebView ostaje na server.url origin-u — redirect na drugi domen izbaci
 * app u spoljni browser. Zato se 1.0 sadržaj proksira odavde.
 * /m/* stiže do Worker-a SAMO kad ne postoji 3.0 asset (novi mobilni moduli
 * /m/montaza, /m/prisustvo… imaju prednost jer se assets služe pre skripte).
 */
function jeStaraMobilna(pathname: string): boolean {
  return (
    pathname === '/m' ||
    pathname.startsWith('/m/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest'
  );
}

export default {
  async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
    const url = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && jeStaraMobilna(url.pathname)) {
      return fetch(UPSTREAM + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        redirect: 'follow',
      });
    }
    return env.ASSETS.fetch(request);
  },
};
