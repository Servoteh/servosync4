'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, getRefreshToken, getToken, setRefreshToken, setToken } from '@/api/client';
import {
  logoutServer,
  ssoExchange,
  useLogin,
  useMe,
  useMyPermissions,
  type PublicUser,
} from '@/api/auth';
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
  /**
   * True dok se /auth/me/permissions još učitava (odvojeno od `isLoading`, koji prati
   * SAMO /auth/me). `can()` je fail-closed dok se dozvole ne učitaju, pa ekrani koji
   * gejtuju sadržaj preko `can()` (hub) ovim izbegavaju prolazni „nema pristupa" flash
   * dok /auth/me već ima podatke a dozvole još stižu.
   */
  permissionsPending: boolean;
  /** True ako je upit dozvola pao (retry:false → ostaje za sesiju; razlikuj od „nema modula"). */
  permissionsError: boolean;
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

  /* Ulazna putanja se pamti PRE nego što per-page guard preusmeri na /login
     (guard je useEffect → posle prvog rendera; state inicijalizator je sinhron).
     Login stranica je čita umesto landingRoute — deep-link iz 1.0 iframe-a
     (npr. /energetika, /montaza) preživi SSO handoff. Konzumira se na loginu. */
  useState(() => {
    if (typeof window === 'undefined') return;
    try {
      const p = window.location.pathname + window.location.search;
      if (p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/login')) {
        sessionStorage.setItem('ss2.entryPath', p);
      }
    } catch { /* sessionStorage nedostupan (npr. blokiran u iframe-u) — landingRoute fallback */ }
  });

  useEffect(() => {
    setHasToken(!!getToken());
    setReady(true);
  }, []);

  // SSO iz 1.0 shella: samo u iframe-u i samo DOK nema sesije. Efekat je vezan za
  // `hasToken` (ne samo mount): kad istekli token padne na /auth/me (401 → hasToken
  // false), handshake se PONOVO naoruža i zatraži svež 1.0 token od roditelja.
  // Ranije je radio samo na mount-u uz `getToken()` guard, pa je ISTEKAO token
  // (JWT_EXPIRES_IN=7d) trajno zaglavio korisnika na login formi u iframe-u —
  // SSO-only (JIT) nalozi imaju random lozinku i ne mogu ručno da se prijave
  // (slučaj Dragan Ristanić, 17.07.2026). 1.0 bridge drži trajan listener pa
  // odgovara na `ss2-sso-ready` kad god stigne.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!ready || hasToken) return;
    if (window.parent === window) return;

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
        setRefreshToken(res.refreshToken);
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
  }, [ready, hasToken]);

  const meQuery = useMe(ready && hasToken);
  const permsQuery = useMyPermissions(ready && hasToken);

  // `me` padne SAMO kroz auth 401 (istekao/nevažeći token, refresh već iscrpljen) →
  // nazad na odjavljeno: čistimo OBA tokena (u iframe-u hasToken=false ponovo naoružava
  // SSO handshake). NA MREŽNU GREŠKU (server nedostupan — pogon offline) NE diramo
  // sesiju: inače bi prolazna rupa oborila validnu 30-dnevnu sesiju. Ostali statusi
  // (5xx) takođe ne obaraju sesiju — to nije dokaz da je token nevažeći.
  useEffect(() => {
    if (!meQuery.isError) return;
    const err = meQuery.error;
    if (err instanceof ApiError && err.status === 401) {
      setToken(null);
      setRefreshToken(null);
      setHasToken(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meQuery.isError, meQuery.error]);

  const login = async (email: string, password: string) => {
    await loginMut.mutateAsync({ email, password });
    setHasToken(true);
  };

  const logout = () => {
    logoutServer(getRefreshToken()); // best-effort revoke pre lokalnog čišćenja
    setToken(null);
    setRefreshToken(null);
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
    // Odvojeno od isLoading: /auth/me i /auth/me/permissions su dva paralelna upita, a
    // ['me'] se pre-seed-uje (login/SSO) pa meQuery ume da NIJE pending dok permsQuery
    // još stiže — hub tada mora da čeka dozvole, ne da prikaže „nema pristupa".
    permissionsPending: hasToken && permsQuery.isPending,
    permissionsError: hasToken && permsQuery.isError,
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
