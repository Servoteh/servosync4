'use client';

import { useState, useRef } from 'react';
import { ThumbsUp, Trash2, Paperclip } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  newClientEventId,
  useTips,
  useTip,
  useTipCategories,
  useProjects,
  useSaveTip,
  useToggleTipLike,
  useSoftDeleteTip,
  useUploadTipFile,
  useDeleteTipFile,
  signTipFile,
  type PbTipRow,
} from '@/api/projektni-biro';

/** Prilog saveta — oblik iz `pb_get_eng_tip` RPC (`files` polje, snake_case). */
type TipFile = {
  id: string;
  file_name: string;
  mime_type?: string | null;
  is_image?: boolean;
  size_bytes?: number | string | null;
  storage_path?: string;
};

export function SavetiTab() {
  const { can } = useAuth();
  const canWrite = can(PERMISSIONS.PB_TIPS_WRITE);
  const canAdmin = can(PERMISSIONS.PB_ADMIN);

  const [q, setQ] = useState('');
  const [catIds, setCatIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<'recent' | 'popular'>('recent');
  const [myOnly, setMyOnly] = useState(false);
  const [includeDrafts, setIncludeDrafts] = useState(canAdmin);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const categoriesQ = useTipCategories();
  const tipsQ = useTips({
    q: q || undefined,
    categoryId: catIds.size === 1 ? [...catIds][0] : undefined,
    sort,
    myOnly,
    includeDrafts,
  });
  const tips = tipsQ.data?.data ?? [];
  const toggleLike = useToggleTipLike();

  function toggleCat(id: string) {
    setCatIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga saveta…" />
        <div className="inline-flex gap-1 rounded-control border border-line p-0.5">
          {(['recent', 'popular'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn('rounded px-2 py-1 text-xs', sort === s ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2')}
            >
              {s === 'recent' ? 'Najnoviji' : 'Najpopularniji'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={myOnly} onChange={(e) => setMyOnly(e.target.checked)} /> Samo moji
        </label>
        {canWrite && (
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} /> Nacrti
          </label>
        )}
        <div className="ml-auto">
          {canWrite && (
            <Button
              onClick={() => {
                setEditId(null);
                setEditorOpen(true);
              }}
            >
              ＋ Novi savet
            </Button>
          )}
        </div>
      </div>

      {/* Kategorije chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setCatIds(new Set())}
          className={cn('rounded-full border px-2.5 py-1 text-xs', catIds.size === 0 ? 'border-accent bg-accent-subtle text-ink' : 'border-line text-ink-secondary hover:bg-surface-2')}
        >
          Sve
        </button>
        {(categoriesQ.data?.data ?? []).map((c) => (
          <button
            key={c.id}
            onClick={() => toggleCat(c.id)}
            className={cn('rounded-full border px-2.5 py-1 text-xs', catIds.has(c.id) ? 'border-accent bg-accent-subtle text-ink' : 'border-line text-ink-secondary hover:bg-surface-2')}
          >
            {c.ikona ? `${c.ikona} ` : ''}
            {c.naziv}
          </button>
        ))}
      </div>

      <div className="text-xs text-ink-secondary">{tips.length} saveta</div>

      {tipsQ.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : tipsQ.isError ? (
        <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
      ) : tips.length === 0 ? (
        <EmptyState title="Nema saveta" hint="Promeni pretragu ili dodaj prvi savet." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tips.map((t) => (
            <TipCard key={t.id} tip={t} onOpen={() => setDetailId(t.id)} onLike={() => toggleLike.mutate({ id: t.id })} />
          ))}
        </div>
      )}

      {detailId && (
        <TipDetail
          id={detailId}
          canWrite={canWrite}
          onClose={() => setDetailId(null)}
          onEdit={(id) => {
            setDetailId(null);
            setEditId(id);
            setEditorOpen(true);
          }}
        />
      )}
      {editorOpen && <TipEditor tipId={editId} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

function TipCard({ tip, onOpen, onLike }: { tip: PbTipRow; onOpen: () => void; onLike: () => void }) {
  const excerpt = (tip.telo ?? '').replace(/[#*`]/g, '').slice(0, 140);
  return (
    <div className="flex flex-col rounded-panel border border-line bg-surface p-3">
      <button onClick={onOpen} className="flex-1 text-left">
        <div className="flex items-center gap-2 text-xs text-ink-secondary">
          {tip.category_name && <span className="rounded-full bg-surface-2 px-2 py-0.5">{tip.category_name}</span>}
          {tip.status === 'draft' && <span className="rounded-full bg-status-warn-bg px-2 py-0.5 text-status-warn">DRAFT</span>}
          <span className="ml-auto">{tip.created_at ? formatDate(tip.created_at) : ''}</span>
        </div>
        <h3 className="mt-1.5 font-semibold text-ink">{tip.naslov}</h3>
        <p className="mt-1 text-sm text-ink-secondary">{excerpt}</p>
        {tip.tags && tip.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tip.tags.map((tag) => (
              <span key={tag} className="text-xs text-accent">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="mt-2 flex items-center justify-between border-t border-line-soft pt-2 text-xs text-ink-secondary">
        <span>{(tip.author_name as string) ?? ''}</span>
        <button onClick={onLike} className={cn('flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2', tip.liked_by_me && 'text-accent')}>
          <ThumbsUp className="h-3.5 w-3.5" /> {tip.likes_count ?? 0}
        </button>
      </div>
    </div>
  );
}

function TipDetail({ id, canWrite, onClose, onEdit }: { id: string; canWrite: boolean; onClose: () => void; onEdit: (id: string) => void }) {
  const q = useTip(id);
  const delM = useSoftDeleteTip();
  const t = q.data?.data;
  const footer = (
    <>
      {canWrite && t && (
        <>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm('Obrisati savet?')) {
                delM.mutate({ id });
                onClose();
              }
            }}
          >
            Obriši
          </Button>
          <Button variant="secondary" onClick={() => onEdit(id)}>
            Izmeni
          </Button>
        </>
      )}
      <Button onClick={onClose}>Zatvori</Button>
    </>
  );
  return (
    <Dialog open onClose={onClose} title={t?.naslov ?? 'Savet'} footer={footer}>
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : !t ? (
        <p className="text-sm text-status-danger">Savet nije pronađen.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
            {t.category_name && <span className="rounded-full bg-surface-2 px-2 py-0.5">{t.category_name}</span>}
            {(t.author_name as string) && <span>{t.author_name as string}</span>}
            {t.created_at && <span>· {formatDate(t.created_at)}</span>}
            {t.status === 'draft' && <span className="rounded-full bg-status-warn-bg px-2 py-0.5 text-status-warn">DRAFT</span>}
          </div>
          {(t.vendor as string) && <p className="text-sm text-ink-secondary">Dobavljač: {t.vendor as string}</p>}
          {(t.url as string) && (
            <a href={t.url as string} target="_blank" rel="noopener noreferrer" className="text-sm text-accent underline">
              {t.url as string}
            </a>
          )}
          <Markdown source={t.telo} />
          {t.tags && (t.tags as string[]).length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {(t.tags as string[]).map((tag) => (
                <span key={tag} className="text-xs text-accent">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function TipEditor({ tipId, onClose }: { tipId: string | null; onClose: () => void }) {
  const detail = useTip(tipId);
  const saveM = useSaveTip();
  const categoriesQ = useTipCategories();
  const projectsQ = useProjects();
  const existing = detail.data?.data;
  const files = (existing?.files as TipFile[] | undefined) ?? [];

  const [naslov, setNaslov] = useState('');
  const [telo, setTelo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [tags, setTags] = useState('');
  const [vendor, setVendor] = useState('');
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  if (tipId && existing && !loaded) {
    setLoaded(true);
    setNaslov(existing.naslov ?? '');
    setTelo(existing.telo ?? '');
    setCategoryId((existing.category_id as string) ?? '');
    setTags((existing.tags as string[] | undefined)?.join(', ') ?? '');
    setVendor((existing.vendor as string) ?? '');
    setUrl((existing.url as string) ?? '');
    setProjectId((existing.project_id as string) ?? '');
    setStatus((existing.status as 'draft' | 'published') ?? 'draft');
  }

  async function save() {
    setErr(null);
    if (naslov.trim().length < 3) return setErr('Naslov mora imati bar 3 znaka.');
    if (telo.trim().length < 10) return setErr('Telo mora imati bar 10 znakova.');
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
    try {
      await saveM.mutateAsync({
        clientEventId: newClientEventId(),
        id: tipId ?? undefined,
        naslov: naslov.trim(),
        telo: telo.trim(),
        categoryId: categoryId || undefined,
        tags: tagList,
        vendor: vendor || undefined,
        url: url || undefined,
        projectId: projectId || undefined,
        status,
      });
      onClose();
    } catch {
      setErr('Čuvanje nije uspelo.');
    }
  }

  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';
  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Otkaži
      </Button>
      <Button onClick={save} loading={saveM.isPending}>
        Sačuvaj
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={tipId ? 'Izmena saveta' : 'Novi savet'} footer={footer}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <FormField label="Naslov" required>
          <Input value={naslov} onChange={(e) => setNaslov(e.target.value)} maxLength={200} />
        </FormField>
        <FormField label="Kategorija">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selCls}>
            <option value="">—</option>
            {(categoriesQ.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.naziv}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Telo (markdown)" required>
          <div className="mb-1 flex gap-1">
            <button onClick={() => setPreview(false)} className={cn('rounded px-2 py-0.5 text-xs', !preview ? 'bg-accent text-accent-fg' : 'text-ink-secondary')}>
              Pisanje
            </button>
            <button onClick={() => setPreview(true)} className={cn('rounded px-2 py-0.5 text-xs', preview ? 'bg-accent text-accent-fg' : 'text-ink-secondary')}>
              Pregled
            </button>
          </div>
          {preview ? (
            <div className="min-h-32 rounded-control border border-line bg-surface-2 px-3 py-2">
              <Markdown source={telo} />
            </div>
          ) : (
            <Textarea value={telo} onChange={(e) => setTelo(e.target.value)} rows={10} />
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tagovi" hint="Zarezom razdvojeni (max 10)">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </FormField>
          <FormField label="Dobavljač">
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={120} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} />
          </FormField>
          <FormField label="Projekat">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selCls}>
              <option value="">—</option>
              {(projectsQ.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.project_code, p.project_name].filter(Boolean).join(' — ')}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Status">
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={status === 'draft'} onChange={() => setStatus('draft')} /> Nacrt
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={status === 'published'} onChange={() => setStatus('published')} /> Objavljen
            </label>
          </div>
        </FormField>

        {tipId ? (
          <TipFilesSection tipId={tipId} files={files} />
        ) : (
          <div className="border-t border-line pt-4">
            <h3 className="mb-1 text-sm font-semibold text-ink">📎 Prilozi</h3>
            <p className="text-xs text-ink-disabled">Sačuvajte savet da biste mogli da dodate priloge.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Prilozi saveta

function TipFilesSection({ tipId, files }: { tipId: string; files: TipFile[] }) {
  const upM = useUploadTipFile();
  const delM = useDeleteTipFile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(list: FileList | null) {
    if (!list?.length) return;
    setErr(null);
    try {
      for (const f of Array.from(list)) {
        await upM.mutateAsync({ tipId, file: f, clientEventId: newClientEventId() });
      }
    } catch {
      setErr('Otpremanje priloga nije uspelo.');
    }
    if (inputRef.current) inputRef.current.value = '';
  }
  async function open(fileId: string) {
    setErr(null);
    try {
      const res = await signTipFile(fileId);
      window.open(res.data.url, '_blank', 'noopener');
    } catch {
      setErr('Otvaranje priloga nije uspelo.');
    }
  }
  async function remove(fileId: string) {
    if (!confirm('Obrisati prilog?')) return;
    setErr(null);
    try {
      await delM.mutateAsync({ fileId });
    } catch {
      setErr('Brisanje priloga nije uspelo.');
    }
  }

  return (
    <section className="border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">📎 Prilozi</h3>
        <>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} />
          <Button variant="ghost" onClick={() => inputRef.current?.click()} loading={upM.isPending} className="h-7 px-2 text-xs">
            ＋ Dodaj fajl
          </Button>
        </>
      </div>
      {err && <p className="mb-1 text-xs text-status-danger">{err}</p>}
      <div className="space-y-1">
        {files.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-3 py-1.5">
            <button onClick={() => open(f.id)} className="flex min-w-0 items-center gap-2 text-left">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
              <span className="truncate text-sm text-ink hover:underline">{f.file_name}</span>
            </button>
            <button onClick={() => remove(f.id)} className="text-ink-disabled hover:text-status-danger" aria-label="Obriši prilog">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {files.length === 0 && <p className="text-xs text-ink-disabled">Nema priloga.</p>}
      </div>
    </section>
  );
}
