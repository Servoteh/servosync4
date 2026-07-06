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
import { useLogin, useMe, type PublicUser } from '@/api/auth';

interface AuthContextValue {
  user: PublicUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
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

  const value: AuthContextValue = {
    user: hasToken ? (meQuery.data ?? null) : null,
    isLoading: !ready || (hasToken && meQuery.isPending),
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
