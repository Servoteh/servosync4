'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ImagePlus, Plus, Send, Trash2, X, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { aiMdLite } from '@/lib/ai-md';
import { resizeImageFile } from '@/lib/image-resize';
import { DictateButton } from '@/components/voice-controls';
import {
  ENGINES,
  ENGINE_LABEL,
  fetchAiImageUrl,
  useAiChat,
  useAiConversations,
  useAiLimit,
  useAiMe,
  useAiMessages,
  useAiProjects,
  useDeleteConversation,
  type AiConversation,
  type Engine,
} from '@/api/ai';

const ENGINE_KEY = 'ss_ai_engine';

function getEngine(): Engine {
  if (typeof window === 'undefined') return 'openai';
  const v = localStorage.getItem(ENGINE_KEY) as Engine | null;
  return v && ENGINES.includes(v) ? v : 'openai';
}

/** Srpski vokativ (heuristika paritet 1.0 imeVokativ). */
function vokativ(ime: string | null | undefined): string {
  const n = (ime ?? '').trim();
  if (!n) return 'kolega';
  if (n === 'Petar') return 'Petre';
  if (n === 'Aleksandar') return 'Aleksandre';
  if (/[aeiou]$/i.test(n)) return n;
  return n + 'e';
}

/**
 * AI asistent chat (paritet 1.0 aiAsistent + mobile myAi). `variant`:
 *  - desktop: sidebar istorije levo, Enter = pošalji;
 *  - mobile: istorija u sheet-u, Enter = novi red (slanje dugmetom).
 */
export function AiChat({ variant = 'desktop' }: { variant?: 'desktop' | 'mobile' }) {
  const me = useAiMe();
  const convs = useAiConversations();
  const projects = useAiProjects();
  const limit = useAiLimit();
  const chat = useAiChat();
  const delConv = useDeleteConversation();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [projectRef, setProjectRef] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>('openai');
  const [input, setInput] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messagesQ = useAiMessages(activeId);
  const messages = messagesQ.data?.data ?? [];

  useEffect(() => setEngine(getEngine()), []);
  useEffect(() => {
    if (limit.data?.data) setRemaining(limit.data.data.remaining);
  }, [limit.data]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, chat.isPending]);

  const conversations = convs.data?.data ?? [];
  const projectConvs = conversations.filter((c) => c.scope === 'project');
  const personalConvs = conversations.filter((c) => c.scope !== 'project');

  const greeting = useMemo(() => {
    const ja = me.data?.data;
    if (!ja) return null;
    return {
      hello: `Zdravo, ${vokativ(ja.ime)}!`,
      sub: [ja.puno_ime, ja.pozicija, ja.odeljenje].filter(Boolean).join(' · '),
    };
  }, [me.data]);

  function newConversation() {
    setActiveId(null);
    setProjectRef(null);
    setInput('');
    setImage(null);
    setSheetOpen(false);
    setShowProjectPicker(false);
  }

  function openConversation(c: AiConversation) {
    setActiveId(c.id);
    setProjectRef(c.scope === 'project' ? c.projectRef : null);
    setSheetOpen(false);
  }

  function pickProject(code: string) {
    setProjectRef(code);
    setActiveId(null);
    setShowProjectPicker(false);
    setSheetOpen(false);
  }

  function setEnginePersist(e: Engine) {
    setEngine(e);
    localStorage.setItem(ENGINE_KEY, e);
  }

  async function send() {
    const msg = input.trim();
    if ((!msg && !image) || chat.isPending) return;
    let imgBlob: Blob | null = null;
    if (image) {
      try {
        imgBlob = await resizeImageFile(image);
      } catch {
        imgBlob = image;
      }
    }
    try {
      const res = await chat.mutateAsync({
        message: msg,
        engine,
        conversationId: activeId ?? undefined,
        projectRef: projectRef ?? undefined,
        image: imgBlob,
      });
      setActiveId(res.data.conversationId);
      setProjectRef(res.data.projectRef ?? null);
      setRemaining(res.data.remaining);
      setInput('');
      setImage(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Slanje nije uspelo.');
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (variant === 'desktop' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const sidebar = (
    <ConversationSidebar
      projectConvs={projectConvs}
      personalConvs={personalConvs}
      activeId={activeId}
      onNew={newConversation}
      onOpen={openConversation}
      onDelete={(id) => {
        if (confirm('Obrisati razgovor?')) {
          delConv.mutate(id);
          if (activeId === id) newConversation();
        }
      }}
      onToggleProjectPicker={() => setShowProjectPicker((v) => !v)}
      showProjectPicker={showProjectPicker}
      projects={projects.data?.data ?? []}
      onPickProject={pickProject}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Sidebar (desktop) */}
      {variant === 'desktop' && (
        <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-surface md:flex">{sidebar}</aside>
      )}

      {/* Sheet istorije (mobile) */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex" role="presentation" onClick={() => setSheetOpen(false)}>
          <div className="w-80 max-w-[85vw] bg-surface" onClick={(e) => e.stopPropagation()}>{sidebar}</div>
          <div className="flex-1 bg-black/40" />
        </div>
      )}

      {/* Chat pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
          {variant === 'mobile' && (
            <button className="rounded-control p-1.5 text-ink-secondary hover:bg-surface-2" onClick={() => setSheetOpen(true)} aria-label="Istorija">
              <MessagesSquare className="h-4 w-4" aria-hidden />
            </button>
          )}
          <Bot className="h-4 w-4 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">AI asistent</div>
            <div className="truncate text-2xs text-ink-secondary">
              {projectRef ? `${projectRef} · deljena nit` : 'interno'}
              {remaining != null && remaining <= 10 ? ` · još ${remaining} poruka danas` : ''}
            </div>
          </div>
          {variant === 'mobile' && (
            <button className="rounded-control p-1.5 text-ink-secondary hover:bg-surface-2" onClick={newConversation} aria-label="Novi razgovor">
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          )}
          <div className="flex flex-wrap gap-1">
            {ENGINES.map((e) => (
              <button
                key={e}
                onClick={() => setEnginePersist(e)}
                className={cn(
                  'rounded-control px-2 py-1 text-xs font-medium',
                  e === engine ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2',
                )}
              >
                {ENGINE_LABEL[e]}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {messages.length === 0 && !chat.isPending ? (
            <div className="mx-auto max-w-md py-10 text-center">
              {greeting && <p className="text-lg font-semibold text-ink">{greeting.hello}</p>}
              {greeting?.sub && <p className="mt-1 text-sm text-ink-secondary">{greeting.sub}</p>}
              <p className="mt-3 text-sm text-ink-secondary">
                Ja sam ServoSync AI asistent. Pitaj me o godišnjem, satima, zadacima, projektu ili bilo čemu iz firme.
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble key={m.id} role={m.role} content={m.content} authorName={m.authorName} imagePath={m.imagePath} isProject={!!projectRef} />
            ))
          )}
          {chat.isPending && (
            <div className="flex justify-start">
              <div className="rounded-panel bg-surface-2 px-3 py-2 text-sm text-ink-secondary">Razmišljam…</div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-line bg-surface p-3">
          {image && (
            <div className="mb-2 flex items-center gap-2 text-xs text-ink-secondary">
              <span className="truncate">🖼 {image.name}</span>
              <button onClick={() => setImage(null)} className="rounded-control p-0.5 hover:bg-surface-2" aria-label="Ukloni sliku">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
            <button
              onClick={() => fileRef.current?.click()}
              className="mb-0.5 rounded-control border border-line p-2 text-ink-secondary hover:bg-surface-2"
              title="Priloži sliku"
              aria-label="Priloži sliku"
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
            </button>
            <div className="mb-0.5">
              <DictateButton context="chat" onText={(t) => setInput((v) => (v ? `${v} ${t}` : t))} className="h-9 w-9" />
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={variant === 'desktop' ? 'Pitaj AI… (Enter za slanje)' : 'Pitaj AI…'}
              className="max-h-40 min-h-9 flex-1 resize-none rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
            <button
              onClick={() => void send()}
              disabled={chat.isPending || (!input.trim() && !image)}
              className="mb-0.5 rounded-control bg-accent p-2 text-accent-fg hover:bg-accent-hover disabled:opacity-40"
              aria-label="Pošalji"
            >
              <Send className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConversationSidebar({
  projectConvs,
  personalConvs,
  activeId,
  onNew,
  onOpen,
  onDelete,
  onToggleProjectPicker,
  showProjectPicker,
  projects,
  onPickProject,
}: {
  projectConvs: AiConversation[];
  personalConvs: AiConversation[];
  activeId: string | null;
  onNew: () => void;
  onOpen: (c: AiConversation) => void;
  onDelete: (id: string) => void;
  onToggleProjectPicker: () => void;
  showProjectPicker: boolean;
  projects: { project_code: string; project_name: string | null }[];
  onPickProject: (code: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? projects.filter((p) => p.project_code.toLowerCase().includes(q.toLowerCase()) || (p.project_name ?? '').toLowerCase().includes(q.toLowerCase()))
    : projects.slice(0, 40);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <button onClick={onNew} className="flex w-full items-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover">
          <Plus className="h-4 w-4" aria-hidden /> Novi razgovor
        </button>
        <button onClick={onToggleProjectPicker} className="flex w-full items-center gap-2 rounded-control border border-line px-3 py-2 text-sm text-ink hover:bg-surface-2">
          💼 Projektna nit
        </button>
        {showProjectPicker && (
          <div className="space-y-1 rounded-control border border-line p-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Šifra / naziv predmeta…" className="w-full rounded-control border border-line bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent" />
            <div className="max-h-40 overflow-auto">
              {filtered.map((p) => (
                <button key={p.project_code} onClick={() => onPickProject(p.project_code)} className="block w-full truncate px-2 py-1 text-left text-sm text-ink hover:bg-surface-2">
                  {p.project_code}{p.project_name ? ` — ${p.project_name}` : ''}
                </button>
              ))}
              {filtered.length === 0 && <p className="px-2 py-1 text-xs text-ink-disabled">Nema predmeta.</p>}
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {projectConvs.length > 0 && (
          <ConvGroup title="💼 Projekti" convs={projectConvs} activeId={activeId} onOpen={onOpen} />
        )}
        <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-disabled">Moji razgovori</div>
        {personalConvs.length === 0 ? (
          <p className="px-2 py-2 text-xs text-ink-disabled">Nema razgovora.</p>
        ) : (
          personalConvs.map((c) => (
            <div key={c.id} className={cn('group flex items-center gap-1 rounded-control px-2', activeId === c.id && 'bg-accent-subtle')}>
              <button onClick={() => onOpen(c)} className="flex-1 truncate py-1.5 text-left text-sm text-ink">{c.title || 'Razgovor'}</button>
              <button onClick={() => onDelete(c.id)} className="rounded-control p-1 text-ink-disabled opacity-0 hover:text-status-danger group-hover:opacity-100" aria-label="Obriši">
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConvGroup({ title, convs, activeId, onOpen }: { title: string; convs: AiConversation[]; activeId: string | null; onOpen: (c: AiConversation) => void }) {
  return (
    <div className="mb-2">
      <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-disabled">{title}</div>
      {convs.map((c) => (
        <button
          key={c.id}
          onClick={() => onOpen(c)}
          className={cn('block w-full truncate rounded-control px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2', activeId === c.id && 'bg-accent-subtle')}
        >
          {c.projectRef || c.title || 'Razgovor'}
        </button>
      ))}
    </div>
  );
}

function MessageBubble({
  role,
  content,
  authorName,
  imagePath,
  isProject,
}: {
  role: string;
  content: string;
  authorName: string | null;
  imagePath: string | null;
  isProject: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] rounded-panel px-3 py-2 text-sm', isUser ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-ink')}>
        {isProject && isUser && authorName && <div className="mb-0.5 text-2xs font-semibold opacity-80">{authorName}</div>}
        {imagePath && <ImageAttachment path={imagePath} />}
        {isUser ? (
          <div className="whitespace-pre-wrap">{content}</div>
        ) : (
          <div className="ai-md whitespace-pre-wrap [&_.ai-code]:rounded [&_.ai-code]:bg-surface [&_.ai-code]:px-1 [&_.ai-pre]:mt-1 [&_.ai-pre]:overflow-x-auto [&_.ai-pre]:rounded [&_.ai-pre]:bg-surface [&_.ai-pre]:p-2" dangerouslySetInnerHTML={{ __html: aiMdLite(content) }} />
        )}
      </div>
    </div>
  );
}

function ImageAttachment({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let ok = true;
    fetchAiImageUrl(path)
      .then((r) => ok && setUrl(r.data.url))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, [path]);
  if (!url) return <div className="mb-1 h-24 w-32 animate-pulse rounded bg-black/10" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Prilog" className="mb-1 max-h-64 max-w-full rounded" />;
}
