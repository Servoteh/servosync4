'use client';

import { Flashlight } from 'lucide-react';
import type { FocusRing, ScanDiag } from '@/lib/use-camera-controls';

/**
 * Zajedničke kontrole preko kadra skenera: zoom klizač, torch dugme, prsten
 * tap-fokusa i dijagnostički red. Izgled je 1:1 sa reversi/lokacije ljuskom
 * (koje su ih imale prve) — ovde su izdvojene da montaža i mob-održavanje
 * dobiju iste kontrole bez još jedne kopije.
 */

/** −/klizač/+ · vidi se SAMO kad uređaj izlaže `zoom` capability. */
export function ScanZoomBar({
  min,
  max,
  step,
  value,
  onChange,
  onStep,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-control bg-black/55 px-2 py-1">
      <button
        type="button"
        aria-label="Smanji zoom"
        className="rounded-control bg-white/10 px-2.5 py-1 text-sm"
        onClick={() => onStep(-1)}
      >
        −
      </button>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label="Zoom"
        className="flex-1 accent-accent"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tnums w-10 text-right text-xs">{value.toFixed(1)}×</span>
      <button
        type="button"
        aria-label="Povećaj zoom"
        className="rounded-control bg-white/10 px-2.5 py-1 text-sm"
        onClick={() => onStep(1)}
      >
        +
      </button>
    </div>
  );
}

/** Baterijska lampa. Na Androidu se NIKAD ne prikazuje (1.0 paritet — v. `readTorchSupport`). */
export function ScanTorchButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Baterijska lampa"
      aria-pressed={on}
      className={`rounded-full p-1.5 hover:bg-white/10 ${on ? 'text-status-warn' : 'text-white'}`}
    >
      <Flashlight className="h-5 w-5" aria-hidden />
    </button>
  );
}

/** Prsten tap-fokusa: pun = fokus primenjen, isprekidan = uređaj ne dozvoljava. */
export function ScanFocusRing({ ring }: { ring: FocusRing | null }) {
  if (!ring) return null;
  return (
    <div
      className={`pointer-events-none absolute z-10 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
        ring.ok ? 'border-white/90' : 'border-dashed border-white/40'
      }`}
      style={{ left: ring.x, top: ring.y }}
      aria-hidden
    />
  );
}

/**
 * Dijagnostički red za teren (05.08.2026). Bez njega se problem sa skenerom na
 * konkretnom telefonu gađa naslepo: ne vidi se ni koji je model (Chrome ga krije
 * u UA), ni da li je picker izabrao sočivo, ni da li je AF uopšte primenjen, ni
 * koliki je zoom, ni da li je nišan-gejt aktivan. Sitno i prigušeno — stoji uz
 * `app <hash>` marker, radnika ne ometa, a Nenad ga pročita naglas.
 */
export function ScanDiagLine({ diag, appVersion }: { diag: ScanDiag; appVersion?: string }) {
  return (
    <div className="tnums pointer-events-none select-text text-2xs leading-tight text-white/45">
      {appVersion ? <span>app {appVersion} · </span> : null}
      <span>{diag.model}</span>
      <span> · soč: {diag.lens}</span>
      <span> · AF: {diag.af}</span>
      <span> · zum: {diag.zoom}</span>
      <span> · nišan-gejt: {diag.roi ? 'DA' : 'ne'}</span>
    </div>
  );
}
