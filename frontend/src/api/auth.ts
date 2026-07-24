'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, setRefreshToken, setToken } from './client';

export interface PublicUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
  /** Test nalog (backend AUTHZ_READONLY_USER_IDS): mutacije padaju 403, shell prikazuje baner. */
  readOnly?: boolean;
  /** Admin je zatražio prinudnu promenu lozinke → shell preusmerava na /promena-lozinke (B2). */
  mustChangePassword?: boolean;
}

interface LoginResponse {
  accessToken: string;
  /** Refresh token (BACKEND_RULES §7) — čuva se uz access token za tihi auto-refresh. */
  refreshToken: string;
  user: PublicUser;
}

/** Current user, resolved from the stored token. */
export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<PublicUser>('/auth/me'),
    enabled,
    retry: false,
  });
}

export interface MyPermissions {
  role: string;
  permissions: string[];
  /** true = backend also denies (403); false = shadow mode (evaluate+log, allow). */
  enforced: boolean;
}

/** Role-derived permission keys for the logged-in user (AUTHZ_UNIFIED §8 Faza 2). */
export function useMyPermissions(enabled: boolean) {
  return useQuery({
    queryKey: ['me', 'permissions'],
    queryFn: () => apiFetch<MyPermissions>('/auth/me/permissions'),
    enabled,
    retry: false,
  });
}

/**
 * SSO sa ServoSync 1.0 shell-a (iframe modul „Tehnologija"): menja 1.0 access
 * token za NAŠ token preko POST /auth/sso. Plain funkcija (ne hook) — poziva
 * se iz `message` listener-a u AuthProvider-u. 401 = nema aktivnog 2.0 naloga
 * za taj email → pozivalac ćuti i ostavlja običan login ekran.
 */
export function ssoExchange(token: string) {
  return apiFetch<LoginResponse>('/auth/sso', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

/** Email + password login; stores the token and primes the `me` cache. */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => {
      setToken(data.accessToken);
      setRefreshToken(data.refreshToken);
      qc.setQueryData(['me'], data.user);
    },
  });
}

/**
 * Self-service promena lozinke (B2): POST /auth/change-password (isti guard kao /me).
 * 401 = pogrešna trenutna lozinka, 400 = nova prekratka. Po uspehu odmah skida
 * `mustChangePassword` iz keša `['me']` — enforce redirect (auth-context) prestaje bez
 * čekanja na refetch, pa stranica može bezbedno da preusmeri na landing.
 */
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ data: { changed: boolean; sy15Synced: boolean } }>(
        '/auth/change-password',
        { method: 'POST', body: JSON.stringify(vars) },
      ),
    onSuccess: () => {
      qc.setQueryData<PublicUser | undefined>(['me'], (old) =>
        old ? { ...old, mustChangePassword: false } : old,
      );
    },
  });
}

/**
 * Best-effort revoke refresh tokena na serveru pri odjavi. Fire-and-forget:
 * greške se gutaju (odjava mora uspeti lokalno bez obzira na mrežu/server, a
 * `/auth/logout` je idempotentan i vraća `{ ok: true }` i za nepoznat token).
 */
export function logoutServer(refreshToken: string | null): void {
  if (!refreshToken) return;
  void apiFetch<{ ok: boolean }>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  }).catch(() => {
    /* best-effort — mrežna/server greška se ignoriše */
  });
}
