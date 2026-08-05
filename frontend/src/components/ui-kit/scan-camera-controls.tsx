'use client';

import { useRef, useState } from 'react';
import { Flashlight } from 'lucide-react';
import {
  readScanFlag,
  writeScanFlag,
  type ScanFlag,
  type ScanFlagValue,
} from '@/lib/camera-controls';
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
  const [open, setOpen] = useState(false);
  const holdRef = useRef(0);

  // DUG PRITISAK otvara prekidače. Prekidači su do sada postojali samo u
  // `sessionStorage`, a Nenad je NA TERENU — bez konzole nije mogao ni da ih
  // upali ni da ih ugasi, pa se nije moglo izmeriti šta zapravo pomaže.
  //
  // 450 ms, a ne 600: Androidov sopstveni prag dugog pritiska je ~500 ms, pa kad
  // sistem krene da hvata ručice selekcije Chrome ispali `pointercancel` —
  // `cancelHold` tada ubije tajmer i panel se NIKAD ne otvori. Iz istog razloga
  // je red `select-none` (bio `select-text`) i `contextmenu` je preventovan.
  const startHold = () => {
    holdRef.current = window.setTimeout(() => setOpen((v) => !v), 450);
  };
  const cancelHold = () => {
    if (holdRef.current) {
      clearTimeout(holdRef.current);
      holdRef.current = 0;
    }
  };

  return (
    <div className="pointer-events-auto">
      <div
        role="button"
        tabIndex={0}
        aria-label="Dijagnostika skenera — dug pritisak otvara prekidače"
        aria-expanded={open}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => e.preventDefault()} // dug pritisak ne sme da otvori meni sistema
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="tnums select-none text-2xs leading-tight text-white/45"
      >
        {appVersion ? <span>app {appVersion} · </span> : null}
        <span>{diag.model}</span>
        <span> · soč: {diag.lens}</span>
        <span> · AF: {diag.af}</span>
        <span> · zum: {diag.zoom}</span>
        {/* „aktivno" = ono što dekoder STVARNO radi u ovoj sesiji; prekidač koji
            se s tim ne slaže se ispisuje posebno, sa napomenom da čeka restart. */}
        <span> · nišan-gejt: {diag.roi ? 'DA' : 'ne'}</span>
        {diag.roiPending && (
          <span className="text-status-warn">
            {' '}
            (prekidač: {diag.roiPending === 'on' ? 'uklj' : 'isklj'} → važi od sledećeg otvaranja)
          </span>
        )}
      </div>
      {open && <ScanDebugSwitches onClose={() => setOpen(false)} />}
    </div>
  );
}

const FLAG_LABELS: { key: ScanFlag; label: string }[] = [
  { key: 'ss3_scan_roi_gate', label: 'Nišan-gejt (čitaj samo iz prozora)' },
  { key: 'ss3_scan_autozoom', label: 'Auto zum 2× na startu' },
  { key: 'ss3_scan_af_kick', label: 'Periodično izoštravanje' },
];

/**
 * Terenski prekidači. Sve tri opcije imaju stanje `auto` (odluka po profilu
 * uređaja), `uklj` i `isklj`. Vrednosti žive u `sessionStorage` i čitaju se pri
 * KAČENJU dekodera, pa promena važi od sledećeg otvaranja skenera — zato je to
 * i napisano na panelu, da se ne meri pogrešna stvar.
 */
function ScanDebugSwitches({ onClose }: { onClose: () => void }) {
  const [, force] = useState(0);
  const set = (key: ScanFlag, value: ScanFlagValue) => {
    writeScanFlag(key, value);
    force((n) => n + 1);
  };

  return (
    <div className="mt-1 space-y-1.5 rounded-control bg-black/80 p-2 text-2xs text-white/80">
      {FLAG_LABELS.map(({ key, label }) => {
        const cur = readScanFlag(key);
        return (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="flex-1">{label}</span>
            <div className="flex gap-1">
              {([null, 'on', 'off'] as ScanFlagValue[]).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => set(key, v)}
                  aria-pressed={cur === v}
                  className={`rounded-control px-2 py-0.5 ${
                    cur === v ? 'bg-accent text-white' : 'bg-white/10 text-white/70'
                  }`}
                >
                  {v === null ? 'auto' : v === 'on' ? 'uklj' : 'isklj'}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-white/50">
        Promena važi od SLEDEĆEG otvaranja skenera — zatvori pa otvori ponovo.
      </p>
      <button type="button" onClick={onClose} className="rounded-control bg-white/10 px-2 py-0.5">
        Zatvori
      </button>
    </div>
  );
}
