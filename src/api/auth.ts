'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, setToken } from './client';

export interface PublicUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
}

interface LoginResponse {
  accessToken: string;
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
      qc.setQueryData(['me'], data.user);
    },
  });
}
