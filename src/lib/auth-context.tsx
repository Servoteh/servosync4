'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken, setToken } from '@/api/client';
import { ssoExchange, useLogin, useMe, useMyPermissions, type PublicUser } from '@/api/auth';
import type { Permission } from '@/lib/permissions';

/**
 * SSO handshake sa ServoSync 1.0 shell-om (mi smo iframe modul „Tehnologija").
 * Protokol: mi → parent `{type:'ss2-sso-ready'}`; parent → mi `{type:'ss2-sso-token',
 * token}` (1.0 access token) → POST /auth/sso → naš token + user. Origin se
 * proverava u OBA smera; van iframe-a ili sa postojećom sesijom = no-op.
 */
const SSO_PARENT_ORIGINS = [
  'https://servosync.servoteh.com',
  'http://192.168.64.28:8090', // LAN fallback front (1.5)
];

interface AuthContextValue {
  user: PublicUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Permission keys granted to the current user (empty until loaded). */
  permissions: ReadonlySet<string>;
  /** True if the user's role grants `permission`. Fail-closed while loading. */
  can: (permission: Permission) => boolean;
  /** Backend enforcement state (false = shadow mode). Informational for the UI. */
  enforced: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(false);
  const [ready, setReady] = useState(false);
  const loginMut = useLogin();

  useEffect(() => {
    setHasToken(!!getToken());
    setReady(true);
  }, []);

  // SSO iz 1.0 shell-a: samo u iframe-u i samo bez postojeće sesije.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.parent === window || getToken()) return;

    let done = false;
    const onMessage = async (event: MessageEvent) => {
      if (done) return;
      if (!SSO_PARENT_ORIGINS.includes(event.origin)) return;
      const data = event.data as { type?: string; token?: string } | null;
      if (data?.type !== 'ss2-sso-token' || !data.token) return;
      done = true;
      try {
        const res = await ssoExchange(data.token);
        setToken(res.accessToken);
        qc.setQueryData(['me'], res.user);
        setHasToken(true);
      } catch {
        // nema aktivnog 2.0 naloga za ovaj email → ostaje običan login ekran
      }
    };
    window.addEventListener('message', onMessage);
    // javi roditelju da smo spremni (targetOrigin mora biti tačan → probaj oba dozvoljena)
    for (const origin of SSO_PARENT_ORIGINS) {
      try { window.parent.postMessage({ type: 'ss2-sso-ready' }, origin); } catch { /* ignore */ }
    }
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meQuery = useMe(ready && hasToken);
  const permsQuery = useMyPermissions(ready && hasToken);

  // A rejected `me` (expired/invalid token) drops us back to logged-out.
  useEffect(() => {
    if (meQuery.isError) {
      setToken(null);
      setHasToken(false);
    }
  }, [meQuery.isError]);

  const login = async (email: string, password: string) => {
    await loginMut.mutateAsync({ email, password });
    setHasToken(true);
  };

  const logout = () => {
    setToken(null);
    setHasToken(false);
    qc.clear();
  };

  const permissions: ReadonlySet<string> = new Set(
    hasToken ? (permsQuery.data?.permissions ?? []) : [],
  );

  const value: AuthContextValue = {
    user: hasToken ? (meQuery.data ?? null) : null,
    isLoading: !ready || (hasToken && meQuery.isPending),
    login,
    logout,
    permissions,
    can: (permission) => permissions.has(permission),
    enforced: permsQuery.data?.enforced ?? false,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
