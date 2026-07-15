'use client';

// Plan montaže — dijalozi faze (increment 5): opis faze + povezani crteži.
// Paritet 1.0 descriptionDialog.js + linkedDrawingsDialog.js. Snimanje ide kroz
// onSave (parent ažurira PhaseVM + zakazuje autosave). Povezani crteži: ručni unos
// broja + exists-check (bigtehn keš) sa ✓/✗ indikatorom.

import { useEffect, useState } from 'react';
import { Trash2, Check, X, ExternalLink } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { fetchDrawingsExists, fetchDrawingSignedUrl } from '@/api/plan-montaze';

export function PhaseDescriptionDialog({
  open,
  onClose,
  phaseName,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  phaseName: string;
  initial: string;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Opis faze — ${phaseName || '—'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={() => { onSave(text.trim()); onClose(); }}>Snimi</Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder="Detaljan opis faze (postupci, napomene, specifičnosti)…"
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
      />
    </Dialog>
  );
}

export function PhaseLinkedDrawingsDialog({
  open,
  onClose,
  phaseName,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  phaseName: string;
  initial: string[];
  onSave: (list: string[]) => void;
}) {
  const [list, setList] = useState<string[]>(initial);
  const [input, setInput] = useState('');
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [opening, setOpening] = useState<string | null>(null);

  async function openDrawing(no: string) {
    setOpening(no);
    try {
      const res = await fetchDrawingSignedUrl(no);
      if (res.data) window.open(res.data, '_blank', 'noopener');
    } catch {
      /* nema PDF-a u kešu / bez dozvole */
    } finally {
      setOpening(null);
    }
  }

  useEffect(() => {
    if (open) {
      setList(initial);
      setInput('');
    }
  }, [open, initial]);

  // Exists-check za trenutnu listu (bigtehn keš).
  useEffect(() => {
    if (!open || list.length === 0) {
      setExists({});
      return;
    }
    let alive = true;
    fetchDrawingsExists(list)
      .then((res) => {
        if (!alive) return;
        const m: Record<string, boolean> = {};
        for (const r of res.data) m[r.drawing_no] = r.exists;
        setExists(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, list]);

  function add() {
    const nums = input
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!nums.length) return;
    setList((prev) => {
      const set = new Set(prev);
      for (const n of nums) set.add(n);
      return [...set];
    });
    setInput('');
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Povezani crteži — ${phaseName || '—'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={() => { onSave(list); onClose(); }}>Snimi</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="Broj crteža (npr. SC-12345); više odvoji zarezom…"
            className="h-9 flex-1 rounded-control border border-line bg-surface px-3 text-sm text-ink"
          />
          <Button variant="secondary" onClick={add} disabled={!input.trim()}>Dodaj</Button>
        </div>

        {list.length === 0 ? (
          <p className="py-3 text-center text-sm text-ink-disabled">Nema povezanih crteža.</p>
        ) : (
          <ul className="space-y-1">
            {list.map((no) => {
              const ex = exists[no];
              return (
                <li key={no} className="flex items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm">
                  <span className="tnums font-medium text-ink">{no}</span>
                  {ex === true ? (
                    <span className="flex items-center gap-0.5 text-xs text-status-success"><Check className="h-3.5 w-3.5" aria-hidden /> u kešu</span>
                  ) : ex === false ? (
                    <span className="flex items-center gap-0.5 text-xs text-status-warn"><X className="h-3.5 w-3.5" aria-hidden /> nije nađen</span>
                  ) : null}
                  {ex !== false && (
                    <button
                      type="button"
                      onClick={() => openDrawing(no)}
                      disabled={opening === no}
                      className="ml-auto flex items-center gap-1 rounded-control border border-line px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
                      title="Otvori PDF crteža"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> PDF
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setList((prev) => prev.filter((x) => x !== no))}
                    className={cn('rounded-control p-1 text-status-danger hover:bg-status-danger-bg', ex === false && 'ml-auto')}
                    aria-label="Ukloni"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
