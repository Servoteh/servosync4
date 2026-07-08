'use client';

import { Search } from 'lucide-react';

/** Pretraga u komandnoj traci (DESIGN_SYSTEM.md §4). */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Pretraga…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-2.5 py-1.5">
      <Search className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-44 bg-transparent text-sm text-ink placeholder:text-ink-disabled focus:outline-none"
      />
    </div>
  );
}
