'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

// In-app notifikacije (D8 „zvonce") — backend /api/v1/notifications.
// Redovi su materijalizovani PO-PRIMAOCU; backend filtrira po workerId iz JWT-a
// (users.worker_id), pa nalog bez vezanog radnika ima prazan inbox (nije greška).

export interface AppNotification {
  id: number;
  /** 'kontrola.skart' | 'kontrola.dorada' | 'primopredaja.nova' | … */
  type: string;
  message: string;
  /** 'work_orders' | 'handover_drafts' | null — za navigaciju na modul. */
  refTable: string | null;
  refId: number | null;
  recipientWorkerId: number;
  createdAt: string;
  readAt: string | null;
}

const NOTIFICATIONS_KEY = ['notifications'];

/** Broj nepročitanih — polling na 30 s (crveni badge na zvoncetu u AppShell-u). */
export function useUnreadNotificationsCount(enabled: boolean) {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'unread-count'],
    queryFn: () =>
      apiFetch<{ data: { unread: number } }>('/v1/notifications/unread-count'),
    refetchInterval: 30_000,
    enabled,
  });
}

/** Inbox (najnovije prvo) — učitava se tek kad se panel zvonceta otvori. */
export function useNotifications(enabled: boolean, limit = 30) {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'list', limit],
    queryFn: () =>
      apiFetch<{
        data: AppNotification[];
        meta: { workerId: number | null; limit: number; unreadCount: number };
      }>(`/v1/notifications?limit=${limit}`),
    enabled,
  });
}

/** Označi jednu pročitanom (klik na stavku panela). */
export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: AppNotification }>(`/v1/notifications/${id}/read`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

/** „Označi sve" — sve nepročitane radnika odjednom. */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { updated: number } }>('/v1/notifications/read-all', {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
