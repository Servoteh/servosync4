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

export function getToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(resolveApiBase() + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

/**
 * Kao `apiFetch`, ali za multipart upload (`FormData`): `Content-Type` se NE
 * postavlja ručno — browser sam upisuje `multipart/form-data; boundary=…`.
 * Isti Authorization / ApiError tok kao `apiFetch`.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(resolveApiBase() + path, {
    method: 'POST',
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

/** Kao `apiFetch`, ali vraća binarni `Blob` (PDF štampa i sl.). Isti auth header. */
export async function apiBlob(path: string, options: RequestInit = {}): Promise<Blob> {
  const token = getToken();
  const res = await fetch(resolveApiBase() + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let message = 'Greška u komunikaciji sa serverom';
    try {
      const body = await res.json();
      if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

