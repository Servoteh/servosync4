// Low-level API client for the ServoSync NestJS backend (prefix /api).
// Components never call this directly — only TanStack Query hooks in src/api/*.
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';

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
  const res = await fetch(API + path, {
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
