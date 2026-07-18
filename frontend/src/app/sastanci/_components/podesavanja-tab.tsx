'use client';

import { useEffect, useState } from 'react';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useAiModel, usePrefs, useSetAiModel, useUpdatePrefs, type Prefs } from '@/api/sastanci';
import { INPUT_CLS } from './common';

// Podešavanja notifikacija (paritet 1.0 podesavanjaNotifikacijaTab) + AI model (admin).
const PREF_LABELS: { key: keyof Omit<Prefs, 'email'>; label: string; note?: string }[] = [
  { key: 'onMeetingInvite', label: 'Pozivnica za sastanak' },
  { key: 'onMeetingLocked', label: 'Zapisnik po zaključavanju', note: 'obavezno — zvanična distribucija' },
  { key: 'onMeetingReminder', label: 'Podsetnik pred sastanak' },
  { key: 'onActionReminder', label: 'Podsetnik za zadatke (rokovi)' },
  { key: 'onNewAkcija', label: 'Nova akcija (sistemski isključeno)' },
  { key: 'onChangeAkcija', label: 'Izmena akcije (sistemski isključeno)' },
];

const AI_MODELI: { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export function PodesavanjaTab() {
  const prefsQ = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const [local, setLocal] = useState<Partial<Prefs>>({});

  useEffect(() => {
    if (prefsQ.data?.data) setLocal(prefsQ.data.data);
  }, [prefsQ.data]);

  function toggle(key: keyof Omit<Prefs, 'email'>) {
    const next = { ...local, [key]: !local[key] };
    setLocal(next);
    updatePrefs.mutate({ [key]: next[key] });
  }

  return (
    <div className="max-w-xl space-y-6">
      <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Obaveštenja (mejl)</h2>
        {prefsQ.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : (
          <ul className="space-y-2">
            {PREF_LABELS.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">
                  {p.label}
                  {p.note && <span className="block text-xs text-ink-disabled">{p.note}</span>}
                </span>
                <input
                  type="checkbox"
                  checked={!!local[p.key]}
                  onChange={() => toggle(p.key)}
                  className="h-4 w-4"
                  aria-label={p.label}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <Can permission={PERMISSIONS.SASTANCI_AI_MODEL}>
        <AiModelSection />
      </Can>
    </div>
  );
}

function AiModelSection() {
  const modelQ = useAiModel();
  const setModel = useSetAiModel();
  const current = modelQ.data?.data?.model ?? 'claude-opus-4-8';

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">AI model za rezime zapisnika</h2>
      <div className="flex items-center gap-2">
        <select
          className={`${INPUT_CLS} w-auto`}
          value={current}
          onChange={(e) => setModel.mutate({ model: e.target.value })}
        >
          {AI_MODELI.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        {setModel.isPending && <span className="text-xs text-ink-secondary">Čuvanje…</span>}
      </div>
      <p className="text-xs text-ink-disabled">Koristi se za „✨ Sažmi zapisnik" (Claude).</p>
    </section>
  );
}
