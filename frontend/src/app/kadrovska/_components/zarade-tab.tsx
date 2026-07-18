'use client';

import { useEffect, useState } from 'react';
import { UsloviView } from './zarade/uslovi-view';
import { ObracunView } from './zarade/obracun-view';

// Zarade (P9) — admin-only (tab vidljiv samo uz kadrovska.salary; page.tsx gate).
// Dva sub-taba (paritet 1.0 salaryTab.js): 📜 Uslovi zarade / 🧾 Mesečni obračun.
// Izbor sub-taba se pamti u localStorage (1.0 `pm_salary_subtab`).

const SUBTAB_KEY = 'pm_salary_subtab';
type Sub = 'terms' | 'payroll';

function readSubtab(): Sub {
  try {
    const v = localStorage.getItem(SUBTAB_KEY);
    return v === 'payroll' ? 'payroll' : 'terms';
  } catch {
    return 'terms';
  }
}

export function ZaradeTab() {
  const [sub, setSub] = useState<Sub>('terms');
  useEffect(() => setSub(readSubtab()), []);

  function pick(v: Sub) {
    setSub(v);
    try { localStorage.setItem(SUBTAB_KEY, v); } catch { /* private mode */ }
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1" role="tablist" aria-label="Zarade">
        <button
          role="tab"
          aria-selected={sub === 'terms'}
          onClick={() => pick('terms')}
          className={`rounded-control px-3 py-1.5 text-sm font-medium ${sub === 'terms' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
        >
          📜 Uslovi zarade
        </button>
        <button
          role="tab"
          aria-selected={sub === 'payroll'}
          onClick={() => pick('payroll')}
          className={`rounded-control px-3 py-1.5 text-sm font-medium ${sub === 'payroll' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}
        >
          🧾 Mesečni obračun
        </button>
      </div>
      <p className="text-xs text-ink-secondary">
        🔒 Zarade su vidljive isključivo administratoru (HR namerno nema pristup). Zaključan obračun je nepromenljiv.
      </p>
      {sub === 'terms' ? <UsloviView /> : <ObracunView />}
    </div>
  );
}
