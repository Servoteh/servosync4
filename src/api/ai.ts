'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ============================================================================
// AI asistent — 3.0 TALAS B (MODULE_SPEC_sastanci_ai_30.md §4). Port edge
// `ai-chat` u NestJS `/v1/ai/*`. Upis istorije je SERVER-SIDE (RLS INSERT = samo
// service role); FE samo čita niti/poruke/limit i šalje chat/stt/refine.
// ============================================================================

const BASE = '/v1/ai';

export type Engine = 'openai' | 'claude' | 'gemini' | 'kimi';
export const ENGINES: Engine[] = ['openai', 'claude', 'gemini', 'kimi'];
export const ENGINE_LABEL: Record<Engine, string> = {
  openai: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  kimi: 'Kimi',
};

export interface AiConversation {
  id: string;
  userId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  scope: 'personal' | 'project' | string;
  projectRef: string | null;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | string;
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
  createdAt: string;
  authorName: string | null;
  imagePath: string | null;
}

/** ai_chat_ja() — pozdrav (snapshot 12.07: ime/puno_ime/pozicija/odeljenje). */
export interface AiJa {
  ime: string | null;
  puno_ime?: string | null;
  pozicija?: string | null;
  odeljenje?: string | null;
}

export interface AiLimit {
  used: number;
  limit: number;
  remaining: number;
}

export interface AiProject {
  project_code: string;
  project_name: string | null;
}

export interface AiChatResult {
  ok: boolean;
  conversationId: string;
  reply: string;
  model: string;
  scope: string;
  projectRef: string | null;
  authorName: string | null;
  title?: string;
  imagePath?: string;
  remaining: number;
  limit: number;
}

const KEYS = {
  all: ['ai'] as const,
  conversations: ['ai', 'conversations'] as const,
  messages: (id: string) => ['ai', 'conversations', id, 'messages'] as const,
  me: ['ai', 'me'] as const,
  limit: ['ai', 'limit'] as const,
  projects: ['ai', 'projects'] as const,
};

// ------------------------------------------------------------------ queries

export function useAiMe() {
  return useQuery({
    queryKey: KEYS.me,
    queryFn: () => apiFetch<{ data: AiJa | null }>(`${BASE}/me`),
  });
}

export function useAiLimit() {
  return useQuery({
    queryKey: KEYS.limit,
    queryFn: () => apiFetch<{ data: AiLimit }>(`${BASE}/limit`),
  });
}

export function useAiConversations() {
  return useQuery({
    queryKey: KEYS.conversations,
    queryFn: () => apiFetch<{ data: AiConversation[] }>(`${BASE}/conversations`),
  });
}

export function useAiMessages(conversationId: string | null) {
  return useQuery({
    queryKey: conversationId ? KEYS.messages(conversationId) : ['ai', 'conversations', 'none', 'messages'],
    enabled: !!conversationId,
    queryFn: () => apiFetch<{ data: AiMessage[] }>(`${BASE}/conversations/${conversationId}/messages`),
  });
}

export function useAiProjects() {
  return useQuery({
    queryKey: KEYS.projects,
    queryFn: () => apiFetch<{ data: AiProject[] }>(`${BASE}/projects`),
  });
}

/** Potpisan URL priloga (ai-chat-images) — imperativno, path `{convId}/{ime}`. */
export function fetchAiImageUrl(path: string): Promise<{ data: { url: string; expiresIn: number } }> {
  return apiFetch(`${BASE}/images/sign?path=${encodeURIComponent(path)}`);
}

// ------------------------------------------------------------------ mutations

export interface ChatVars {
  message: string;
  engine?: Engine;
  conversationId?: string;
  projectRef?: string;
  /** Vision prilog (klijentski resize na ≤1568px pre slanja — vidi resizeImageFile). */
  image?: Blob | null;
}

/**
 * `/ai/chat` — sa slikom multipart, bez slike JSON. Odgovor nosi remaining/limit
 * (upozorenje „još X poruka danas") i conversationId (retry ne pravi orphan nit).
 * Invalidiramo niti + poruke te niti + limit posle uspeha.
 */
export function useAiChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ChatVars): Promise<{ data: AiChatResult }> => {
      if (v.image) {
        const fd = new FormData();
        fd.append('message', v.message ?? '');
        if (v.engine) fd.append('engine', v.engine);
        if (v.conversationId) fd.append('conversationId', v.conversationId);
        if (v.projectRef) fd.append('projectRef', v.projectRef);
        fd.append('image', v.image, 'slika.jpg');
        return apiUpload<{ data: AiChatResult }>(`${BASE}/chat`, fd);
      }
      return apiFetch<{ data: AiChatResult }>(`${BASE}/chat`, {
        method: 'POST',
        body: JSON.stringify({
          message: v.message,
          engine: v.engine,
          conversationId: v.conversationId,
          projectRef: v.projectRef,
        }),
      });
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: KEYS.conversations });
      void qc.invalidateQueries({ queryKey: KEYS.limit });
      void qc.invalidateQueries({ queryKey: KEYS.messages(res.data.conversationId) });
    },
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { ok: boolean } }>(`${BASE}/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.conversations }),
  });
}

/* ── STT (🎤 Whisper) + refine (✨) — presečna infra (P4) ── */

export interface SttResult {
  ok: boolean;
  text: string;
  model: string;
}
/** Govor → tekst. `context`: 'chat' (razgovor) ili 'zapisnik' (tehnički). */
export function transcribeAudio(
  audio: Blob,
  opts: { lang?: string; context?: 'chat' | 'zapisnik' } = {},
): Promise<{ data: SttResult }> {
  const fd = new FormData();
  fd.append('audio', audio, 'snimak.webm');
  if (opts.lang) fd.append('lang', opts.lang);
  if (opts.context) fd.append('context', opts.context);
  return apiUpload<{ data: SttResult }>(`${BASE}/stt`, fd);
}

export type RefineProfil =
  | 'montaza_opis'
  | 'montaza_problem'
  | 'montaza_napomena'
  | 'zapisnik'
  | 'zadatak'
  | 'napomena';

export interface RefineResult {
  ok: boolean;
  text: string;
  model: string;
}
/** „✨ Doteraj tekst" po profilu dokumenta. */
export function refineText(tekst: string, profil?: RefineProfil): Promise<{ data: RefineResult }> {
  return apiFetch<{ data: RefineResult }>(`${BASE}/refine`, {
    method: 'POST',
    body: JSON.stringify({ tekst, profil }),
  });
}
