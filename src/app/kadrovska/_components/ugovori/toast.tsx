'use client';

import { useEffect, useState } from 'react';

// Lagani toast (Kadrovska nema globalni sistem). `pushToast` zove bilo koji
// helper/tok; `ToastHost` renderuje stek u donjem desnom uglu (auto-nestaje 5s).

type Listener = (msg: string) => void;
const listeners = new Set<Listener>();

export function pushToast(msg: string): void {
  listeners.forEach((l) => l(msg));
}

interface ToastItem {
  id: number;
  msg: string;
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let seq = 0;
    const l: Listener = (msg) => {
      const id = ++seq;
      setItems((xs) => [...xs, { id, msg }]);
      window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2">
      {items.map((it) => (
        <div
          key={it.id}
          className="pointer-events-auto rounded-panel border border-line bg-surface px-4 py-2.5 text-sm text-ink shadow-xl"
          role="status"
        >
          {it.msg}
        </div>
      ))}
    </div>
  );
}
