// Low-level API client for the ServoSync NestJS backend (prefix /api).
// Components never call this directly — only TanStack Query hooks in src/api/*.
//
// The backend base URL is resolved at RUNTIME (in the browser), so ONE static
// build serves both access paths without a rebuild:
//   • preko Cloudflare-a (servosync2.servoteh.com / *.pages.dev) → API kroz Tunnel (https)
//   • na LAN-u (IP ili LAN hostname, npr. http://192.168.64.28)   → API na istom hostu, port 3000
// Ako internet padne, LAN put i dalje radi jer ne prolazi kroz Cloudflare edge.
//
// Redosled: eksplicitni override (window.__SERVOSYNC_API_URL__ iz /config.js)
//   → izvođenje iz window.location → build-time env (prerender/testovi) → localhost.

const TUNNEL_API_URL = 'https://api.servosync2.servoteh.com/api';
const LAN_BACKEND_PORT = 3000;

declare global {
  interface Window {
    /** Opcioni runtime override iz /config.js (vidi public/config.js) — pobeđuje sve. */
    __SERVOSYNC_API_URL__?: string;
  }
}

function resolveApiBase(): string {
  if (typeof window !== 'undefined') {
    const override = window.__SERVOSYNC_API_URL__?.trim();
    if (override) return override.replace(/\/+$/, '');

    const { protocol, hostname } = window.location;
    // Servirano sa Cloudflare-a (javni front ili Pages preview) → kroz Tunnel.
    if (hostname.endsWith('.servoteh.com') || hostname.endsWith('.pages.dev')) {
      return TUNNEL_API_URL;
    }
    // Inače LAN/dev: backend je na istom hostu, port 3000, isti protokol kao front.
    return `${protocol}//${hostname}:${LAN_BACKEND_PORT}/api`;
  }

  // Bez window-a (build-time prerender / testovi): build env, pa localhost.
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
}

const TOKEN_KEY = 'servosync.token';
const REFRESH_KEY = 'servosync.refresh';

export function getToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Refresh token (BACKEND_RULES §7): dugoživeći, klizni. Stoji uz access token u
 * localStorage-u; koristi ga samo auto-refresh na 401 (dole) i logout revoke.
 */
export function getRefreshToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
}

export function setRefreshToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * Parsirano telo odgovora greške (kad je JSON). Dodato aditivno — postojeći
     * pozivi koji čitaju samo `message`/`status` rade nepromenjeno. Koristi ga npr.
     * AI chat da iz 502 tela izvuče `conversationId` (retry ne pravi orphan nit).
     */
    public body: unknown = null,
  ) {
    super(message);
  }
}

/**
 * Auto-refresh na 401 (BACKEND_RULES §7): access JWT je kratkotrajan; kad istekne,
 * tiho ga obnavljamo refresh tokenom i ponavljamo originalni zahtev JEDNOM — korisnik
 * ne primećuje. Sam auth tok (login/sso/refresh/logout) je izuzet da ne uđe u petlju.
 */
function isRefreshEligible(path: string): boolean {
  return !(
    path.startsWith('/auth/login') ||
    path.startsWith('/auth/sso') ||
    path.startsWith('/auth/refresh') ||
    path.startsWith('/auth/logout')
  );
}

/** Deljeni in-flight refresh: paralelni 401-ovi čekaju ISTU operaciju (single-flight). */
let refreshInFlight: Promise<boolean> | null = null;

function runRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const used = getRefreshToken();
  if (!used) return false;

  let res: Response;
  try {
    // BEZ Authorization header-a — telo nosi refresh token.
    res = await fetch(resolveApiBase() + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: used }),
    });
  } catch {
    // Mrežni prekid (server nedostupan, npr. pogon offline): NE brišemo tokene —
    // prolazno, sledeći 401 ponovo pokuša. Validna 30-dnevna sesija ne sme da padne
    // zbog mrežne rupe. (Puni efekat traži da i auth-context čisti sesiju samo na
    // ApiError 401, ne na mrežnu grešku — v. auth-context.)
    return false;
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { accessToken?: string; refreshToken?: string }
      | null;
    if (data?.accessToken && data?.refreshToken) {
      setToken(data.accessToken);
      setRefreshToken(data.refreshToken);
      return true;
    }
    return false; // 200 bez očekivanog tela → prolazno, ne diramo sesiju
  }

  // Definitivno odbijanje (400/401/403) = token je stvarno nevažeći...
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // ...OSIM ako je drugi tab u međuvremenu rotirao par (cross-tab trka na 24h
    // granici; dva 1.0 taba dele particionisani localStorage iframe-a): naš `used`
    // je bio zastareo, a u storage-u već stoji svež par → ne brišemo, prepustimo
    // retry sa novim access tokenom.
    if (getRefreshToken() !== used) return true;
    setToken(null);
    setRefreshToken(null);
    return false;
  }

  // 5xx / ostalo: prolazna serverska greška — ne briši, pusti sledeći pokušaj.
  return false;
}

/**
 * `fetch` sa auto-refresh na 401. `buildInit` proizvodi `RequestInit` za DATI access
 * token — poziva se ponovo pri retry-ju, sa svežim tokenom iz storage-a.
 */
async function fetchWithRefresh(
  path: string,
  buildInit: (token: string | null) => RequestInit,
): Promise<Response> {
  const base = resolveApiBase();
  const res = await fetch(base + path, buildInit(getToken()));
  if (res.status !== 401 || !isRefreshEligible(path)) return res;
  const refreshed = await runRefresh();
  if (!refreshed) return res; // refresh pao (tokeni očišćeni) → propusti originalni 401
  return fetch(base + path, buildInit(getToken())); // retry JEDNOM sa novim tokenom
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetchWithRefresh(path, (token) => ({
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }));
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    let body: unknown = null;
    try {
      body = await res.json();
      const m = (body as { message?: unknown })?.message;
      if (m) message = Array.isArray(m) ? m.join(', ') : String(m);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

/**
 * Kao `apiFetch`, ali za multipart upload (`FormData`): `Content-Type` se NE
 * postavlja ručno — browser sam upisuje `multipart/form-data; boundary=…`.
 * Isti Authorization / ApiError tok kao `apiFetch`.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetchWithRefresh(path, (token): RequestInit => ({
    method: 'POST',
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }));
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    let body: unknown = null;
    try {
      body = await res.json();
      const m = (body as { message?: unknown })?.message;
      if (m) message = Array.isArray(m) ? m.join(', ') : String(m);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

/** Kao `apiFetch`, ali vraća binarni `Blob` (PDF štampa i sl.). Isti auth header. */
export async function apiBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const res = await fetchWithRefresh(path, (token) => ({
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }));
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    let body: unknown = null;
    try {
      body = await res.json();
      const m = (body as { message?: unknown })?.message;
      if (m) message = Array.isArray(m) ? m.join(', ') : String(m);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message, body);
  }
  return res.blob();
}

