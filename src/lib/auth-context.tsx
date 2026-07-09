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
import { useLogin, useMe, useMyPermissions, type PublicUser } from '@/api/auth';
import type { Permission } from '@/lib/permissions';

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
