'use client';

import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import { useAiModels, useSetAiModel, type AiModelSetting, type AiModelTarget } from '@/api/podesavanja';

// ============================================================================
// Sistem tab — dijagnostika + WRITE za dva AI modela (paritet 1.0
// `src/ui/podesavanja/systemTab.js` + `services/sastanciAi.js` + `services/montazaIzvestajAi.js`).
// Radio-kartice: `change` → odmah `useSetAiModel({target, model})`; 403 (42501) →
// revert na prethodni izbor + toast „samo admin". Modeli + default-i preslikani iz 1.0.
// ============================================================================

interface AiModelOption {
  id: string;
  label: string;
  opis: string;
}

/** Dozvoljeni modeli za sažimanje zapisnika sastanaka (default = Opus). */
const SASTANCI_MODELI: AiModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', opis: 'Najkvalitetniji — najskuplji' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', opis: 'Balans kvaliteta i cene' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', opis: 'Najbrži i najjeftiniji' },
];
const SASTANCI_DEFAULT = 'claude-opus-4-8';

/** Dozvoljeni modeli za izveštaje montera (default = Sonnet — MONTAZA_AI_DEFAULT_MODEL). */
const MONTAZA_MODELI: AiModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', opis: 'Najkvalitetniji — najskuplji' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', opis: 'Balans kvaliteta i cene (preporuka za fotke)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', opis: 'Najbrži i najjeftiniji' },
];
const MONTAZA_DEFAULT = 'claude-sonnet-4-6';

function modelLabel(models: AiModelOption[], id: string): string {
  return models.find((m) => m.id === id)?.label ?? id;
}

/** Sačuvani model → id koji smemo prikazati (fallback na default ako je nepoznat/prazan). */
function resolveModel(setting: AiModelSetting, models: AiModelOption[], fallback: string): string {
  const m = setting?.model ?? '';
  return models.some((x) => x.id === m) ? m : fallback;
}

export function SistemTab() {
  const q = useAiModels();
  const data = q.data?.data;

  // KPI: konekcija = uspeh učitavanja modela kroz backend; config = ima li bar jedan model podešen.
  const online = q.isSuccess && !q.isError;
  const configured = !!(data?.sastanci?.model || data?.montaza?.model);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Settings className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Sistem</h2>
          <p className="text-xs text-ink-secondary">Dijagnostika i AI modeli</p>
        </div>
      </div>

      {/* KPI dijagnostika (minimalno — paritet 1.0 nije kritičan) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi
          label="Konekcija"
          value={q.isLoading ? 'Provera…' : online ? 'Online' : 'Offline'}
          sub={online ? 'Backend dostupan' : 'Backend nedostupan'}
          tone={q.isLoading ? 'neutral' : online ? 'ok' : 'warn'}
        />
        <Kpi
          label="AI konfiguracija"
          value={configured ? 'OK' : 'Podrazumevano'}
          sub={configured ? 'model je podešen' : 'koristi se default model'}
          tone={configured ? 'ok' : 'neutral'}
        />
        <Kpi label="Platforma" value="Servosync 2.0" sub="NestJS · sy15" tone="neutral" />
      </div>

      <AiModelCard
        title="AI model — Sažmi zapisnik (Sastanci)"
        sub="Bira se koji Claude model generiše rezime sastanaka. Menja se odmah, bez restarta."
        target="sastanci"
        models={SASTANCI_MODELI}
        setting={data?.sastanci ?? null}
        fallback={SASTANCI_DEFAULT}
        loading={q.isLoading}
      />
      <AiModelCard
        title="AI model — Izveštaji montera (Montaža)"
        sub="Bira se koji Claude model analizira tekst i fotke montera (Montaža → Izveštaji). Menja se odmah."
        target="montaza"
        models={MONTAZA_MODELI}
        setting={data?.montaza ?? null}
        fallback={MONTAZA_DEFAULT}
        loading={q.isLoading}
      />
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'ok' | 'warn' | 'neutral' }) {
  const border =
    tone === 'ok' ? 'border-status-success/40 bg-status-success-bg' : tone === 'warn' ? 'border-status-warn/40 bg-status-warn-bg' : 'border-line bg-surface';
  return (
    <div className={`rounded-panel border px-3 py-2 ${border}`}>
      <div className="text-2xs uppercase text-ink-secondary">{label}</div>
      <div className="text-sm font-semibold text-ink">{value}</div>
      <div className="text-xs text-ink-secondary">{sub}</div>
    </div>
  );
}

/** Jedna radio-kartica za izbor AI modela; odmah snima, na grešku vraća prethodni izbor. */
function AiModelCard({
  title,
  sub,
  target,
  models,
  setting,
  fallback,
  loading,
}: {
  title: string;
  sub: string;
  target: AiModelTarget;
  models: AiModelOption[];
  setting: AiModelSetting;
  fallback: string;
  loading: boolean;
}) {
  const setM = useSetAiModel();
  const serverModel = resolveModel(setting, models, fallback);
  // Lokalni izbor: optimistički se pomera na klik, revert-uje se na grešku.
  const [selected, setSelected] = useState(serverModel);

  // Kad stigne/promeni se serverska vrednost (npr. posle invalidacije), poravnaj lokalni izbor.
  useEffect(() => {
    setSelected(serverModel);
  }, [serverModel]);

  const disabled = setM.isPending || loading;

  async function choose(model: string) {
    if (model === selected) return;
    const prev = selected;
    setSelected(model); // optimistički
    try {
      await setM.mutateAsync({ target, model });
      toast(`✨ Sačuvano: ${modelLabel(models, model)}`);
    } catch (e) {
      setSelected(prev); // revert
      const forbidden = e instanceof ApiError && e.status === 403;
      toast(forbidden ? '⚠ Samo admin može da menja model' : '⚠ Čuvanje nije uspelo');
    }
  }

  const name = `ai-model-${target}`;
  const groupId = `${name}-group`;

  return (
    <div className="max-w-2xl rounded-panel border border-line bg-surface p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-ink-secondary">{sub}</p>
      </div>
      <div role="radiogroup" aria-labelledby={groupId} className="space-y-2">
        <span id={groupId} className="sr-only">
          {title}
        </span>
        {models.map((m) => {
          const checked = selected === m.id;
          return (
            <label
              key={m.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2 transition-colors ${
                checked ? 'border-accent/50 bg-accent-subtle' : 'border-line bg-surface hover:bg-surface-2'
              } ${disabled ? 'cursor-progress opacity-70' : ''}`}
            >
              <input
                type="radio"
                name={name}
                value={m.id}
                checked={checked}
                disabled={disabled}
                onChange={() => void choose(m.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium text-ink">{m.label}</span>
                <span className="text-xs text-ink-secondary">{m.opis}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-ink-disabled">
        {loading ? (
          'Učitavam trenutni izbor…'
        ) : (
          <>
            Trenutno: <span className="font-mono text-ink-secondary">{modelLabel(models, selected)}</span>
            {setting?.updated_at && <span> · {formatDateTime(setting.updated_at)}</span>}
            {setting?.updated_by && <span> · {setting.updated_by}</span>}
          </>
        )}
      </p>
    </div>
  );
}
