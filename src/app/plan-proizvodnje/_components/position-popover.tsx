'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';

/**
 * Popover „Idi na poziciju N" (GAP-PM-09) — port 1.0 onOpenPositionPopover.
 * Number input sa clamp-om (1..total), ✓/Enter potvrđuje, ×/Esc/klik-van zatvara,
 * flip-up ako ispada van viewport-a.
 */
export function PositionPopover({
  anchor,
  total,
  current,
  onSubmit,
  onClose,
}: {
  anchor: DOMRect;
  total: number;
  current: number;
  onSubmit: (pos: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(String(current));
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 4 });

  // Flip-up ako popover ispada ispod viewport-a.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = anchor.bottom + 4;
    if (r.bottom > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 4);
    setPos({ left: Math.max(8, anchor.left), top });
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function onDocDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  function submit() {
    const raw = Number(value);
    if (!Number.isFinite(raw)) {
      onClose();
      return;
    }
    const clamped = Math.max(1, Math.min(total, Math.round(raw)));
    if (clamped !== raw) toast(`Pozicija je van opsega — podešeno na ${clamped}.`);
    onSubmit(clamped);
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Unesi poziciju u redosledu mašine"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1000 }}
      className="w-56 rounded-panel border border-line bg-surface p-3 shadow-xl"
    >
      <label className="mb-1.5 block text-xs font-medium text-ink">
        Pozicija u redosledu mašine <span className="text-ink-disabled">(1–{total})</span>
      </label>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={total}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Nova pozicija"
          className="h-8 w-16 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        />
        <button
          type="button"
          onClick={submit}
          title="Sačuvaj (Enter)"
          className="h-8 rounded-control bg-accent px-2 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          ✓
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Otkaži (Esc)"
          className="h-8 rounded-control border border-line px-2 text-sm text-ink-secondary hover:bg-surface-2"
        >
          ×
        </button>
      </div>
    </div>
  );
}
