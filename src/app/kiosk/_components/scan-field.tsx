'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ScanLine } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Veliko auto-focus polje koje hvata skener. Skener „kuca" kao tastatura i
 * završava sa Enter → tada zovemo `onScan(value)` i praznimo polje. Polje
 * ostaje fokusirano (refocus na blur) da nijedan skenirani znak ne promakne;
 * fokus se NE otima kada radnik prstom pipne dugme (relatedTarget != null).
 */
export function ScanField({
  label,
  hint,
  placeholder,
  onScan,
}: {
  label: string;
  hint?: string;
  placeholder: string;
  onScan: (value: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function submit() {
    const v = value.trim();
    setValue('');
    if (v) onScan(v);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="rounded-panel border-2 border-dashed border-accent/40 bg-accent-subtle p-6">
      <div className="mb-3 flex items-center gap-3 text-xl font-bold uppercase tracking-wide text-accent">
        <ScanLine className="h-7 w-7 shrink-0" aria-hidden />
        {label}
      </div>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // fokus otišao na dugme → ne otimaj; inače vrati (skener mora pisati ovde)
          if (e.relatedTarget) return;
          ref.current?.focus();
        }}
        placeholder={placeholder}
        inputMode="none"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        className={cn(
          'tnums h-20 w-full rounded-control border-2 border-line bg-surface px-6 text-3xl font-semibold tracking-wide text-ink',
          'placeholder:font-normal placeholder:tracking-normal placeholder:text-ink-disabled',
          'focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none',
        )}
      />
      {hint && <p className="mt-3 text-lg text-ink-secondary">{hint}</p>}
    </div>
  );
}
