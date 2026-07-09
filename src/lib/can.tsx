'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import type { Permission } from '@/lib/permissions';

/**
 * Permission gate (AUTHZ_UNIFIED §8 Faza 2b). Renders `children` only if the current
 * user's role grants `permission`. Fail-closed: hidden while permissions load / on absence.
 *
 * This hides UI affordances; it is NOT the security boundary — the backend guard is
 * (shadow mode now, enforce later). Use for buttons/actions that mutate.
 *
 *   <Can permission="strukture.write"><Button>Nova operacija</Button></Can>
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : fallback}</>;
}

/** Imperative check for conditional logic (disabled states, redirects). */
export function useCan(): (permission: Permission) => boolean {
  return useAuth().can;
}
