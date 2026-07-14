'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchSastanci, type SearchResult } from '@/api/sastanci';
import { AkcijaStatusBadge, SastanakStatusBadge } from './common';
import { useDetailNav } from './detail-nav';

/**
 * Komandna paleta (Ctrl/⌘+K) — globalna pretraga sastanaka + akcija (paritet 1.0
 * searchSastanciGlobal, min 2 znaka). Enter/klik → skok.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useDetailNav();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult>({ akcije: [], sastanci: [] });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 20);
    else {
      setQ('');
      setRes({ akcije: [], sastanci: [] });
    }
  }, [open]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setRes({ akcije: [], sastanci: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await searchSastanci(t);
        if (!cancelled) setRes(r.data);
      } catch {
        if (!cancelled) setRes({ akcije: [], sastanci: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q]);

  if (!open) return null;

  function goSastanak(id: string) {
    nav.open(id);
    onClose();
  }
  function goAkcija(a: SearchResult['akcije'][number]) {
    if (a.sastanak_id) goSastanak(a.sastanak_id);
    else onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/40 p-4 pt-[10vh]" onClick={onClose} role="presentation">
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-panel border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Pretraga"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter') {
                if (res.sastanci[0]) goSastanak(res.sastanci[0].id);
                else if (res.akcije[0]) goAkcija(res.akcije[0]);
              }
            }}
            placeholder="Traži sastanke i zadatke…"
            className="w-full bg-transparent text-base text-ink placeholder:text-ink-disabled focus:outline-none"
          />
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {q.trim().length < 2 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-disabled">Ukucaj bar 2 znaka.</p>
          ) : loading ? (
            <p className="px-4 py-6 text-center text-sm text-ink-disabled">Pretraga…</p>
          ) : res.sastanci.length === 0 && res.akcije.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-disabled">Nema rezultata.</p>
          ) : (
            <>
              {res.sastanci.length > 0 && (
                <div className="py-1">
                  <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-disabled">Sastanci</div>
                  {res.sastanci.map((s) => (
                    <button key={s.id} onClick={() => goSastanak(s.id)} className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-surface-2">
                      <span className="truncate text-sm text-ink">{s.naslov}</span>
                      <SastanakStatusBadge status={s.status} />
                    </button>
                  ))}
                </div>
              )}
              {res.akcije.length > 0 && (
                <div className="border-t border-line-soft py-1">
                  <div className="px-4 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-disabled">Zadaci</div>
                  {res.akcije.map((a) => (
                    <button key={a.id} onClick={() => goAkcija(a)} className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-surface-2">
                      <span className="truncate text-sm text-ink">{a.naslov}</span>
                      <AkcijaStatusBadge status={a.effective_status} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
