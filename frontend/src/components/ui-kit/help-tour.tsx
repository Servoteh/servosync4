'use client';

// HelpTour — vođena tura korak-po-korak (PLAN_INFO_VODIC_2026-07). Ručno pisana, BEZ
// novih zavisnosti: zatamnjen overlay + „reflektor" (spotlight) oko ciljnog elementa
// (getBoundingClientRect + scrollIntoView) + oblačić koraka (Nazad/Dalje/Preskoči +
// brojač). Koraci ciljaju HelpSpot id-jeve (`data-help-id`); korak čiji cilj NIJE u
// DOM-u se preskače (tura ne puca kad element ne postoji ili je na drugoj stranici).
// Radi na 360px (oblačić klampovan u ekran). Esc/„Preskoči" zatvaraju (Esc kroz provider).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useHelpModeOptional, type HelpContextValue } from './help-mode';

export interface HelpTourStep {
  /** HelpSpot id (`data-help-id`) koji ovaj korak cilja. */
  spotId: string;
  /** Nadjačava naslov iz registra. */
  title?: string;
  /** Nadjačava tekst iz registra. */
  text?: string;
}

export function HelpTour({ steps }: { steps: HelpTourStep[] }) {
  const ctx = useHelpModeOptional();
  if (!ctx || !ctx.tourOpen) return null;
  return <HelpTourRunner steps={steps} ctx={ctx} />;
}

function selectorFor(spotId: string): string {
  return `[data-help-id="${spotId}"]`;
}

function HelpTourRunner({ steps, ctx }: { steps: HelpTourStep[]; ctx: HelpContextValue }) {
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Prisutni koraci (cilj postoji u DOM-u) — računamo POSLE commit-a (spotovi tek tada
  // renderuju `data-help-id`). Do tada `computed=false` (jedan frame bez prikaza).
  const [present, setPresent] = useState<HelpTourStep[]>([]);
  const [computed, setComputed] = useState(false);
  useEffect(() => {
    const found = steps.filter((s) => document.querySelector(selectorFor(s.spotId)));
    setPresent(found);
    setComputed(true);
  }, [steps]);

  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = present[i];

  const locate = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(selectorFor(step.spotId)) as HTMLElement | null;
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);

  // Skrol do cilja + praćenje pozicije (scroll/resize) dok je korak aktivan.
  useEffect(() => {
    if (!step) return;
    const el = document.querySelector(selectorFor(step.spotId)) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
    locate();
    const t = window.setTimeout(locate, reduceMotion ? 0 : 280); // posle skrola
    window.addEventListener('scroll', locate, true);
    window.addEventListener('resize', locate);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('scroll', locate, true);
      window.removeEventListener('resize', locate);
    };
  }, [step, locate, reduceMotion]);

  // Nema nijednog prisutnog koraka na ovoj stranici → zatvori (Provedi me ne radi ništa loše).
  useEffect(() => {
    if (computed && present.length === 0) ctx.stopTour();
  }, [computed, present.length, ctx]);

  const reg = step ? ctx.entry(step.spotId) : undefined;
  const title = step?.title ?? reg?.title ?? '';
  const text = step?.text ?? reg?.text ?? '';

  if (!computed || present.length === 0 || !step) return null;

  const close = () => ctx.stopTour();
  const next = () => {
    if (i < present.length - 1) setI(i + 1);
    else close();
  };
  const prev = () => setI((v) => Math.max(0, v - 1));

  const vw = typeof window !== 'undefined' ? window.innerWidth : 360;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 640;
  const bubbleW = Math.min(340, vw - 24);
  const bubbleH = 200; // procena za izbor gore/dole
  const bubble = (() => {
    if (!rect) return { left: (vw - bubbleW) / 2, top: Math.max(16, vh / 2 - bubbleH / 2) };
    let left = rect.left;
    if (left + bubbleW > vw - 12) left = vw - 12 - bubbleW;
    if (left < 12) left = 12;
    let top: number;
    if (rect.bottom + 12 + bubbleH < vh) top = rect.bottom + 12;
    else if (rect.top - 12 - bubbleH > 0) top = rect.top - 12 - bubbleH;
    else top = Math.max(12, vh - bubbleH - 12);
    return { left, top };
  })();

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Vođena tura">
      {/* Reflektor: providan prozor oko cilja + ogromna senka zatamni ostalo. Bez cilja =
          pun scrim. Senka je crni scrim (isti obrazac kao Dialog/CommandPalette). */}
      {rect ? (
        <div
          style={{
            position: 'fixed',
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            borderRadius: 10,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)',
            outline: '2px solid var(--accent)',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-black/55" />
      )}

      {/* Hvatač klikova — blokira stranicu ispod ture (oblačić je iznad, prima klik). */}
      <div className="fixed inset-0" aria-hidden onClick={(e) => e.stopPropagation()} />

      {/* Oblačić koraka */}
      <div
        style={{ position: 'fixed', left: bubble.left, top: bubble.top, width: bubbleW }}
        className="rounded-panel border border-line bg-surface p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-md font-semibold text-ink">{title}</p>
          <button
            type="button"
            onClick={close}
            aria-label="Zatvori turu"
            className="-mr-1 -mt-1 rounded-control p-1 text-ink-secondary hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">{text}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-2xs tabular-nums text-ink-secondary">
            Korak {i + 1} od {present.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-control px-2 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              Preskoči
            </button>
            <button
              type="button"
              onClick={prev}
              disabled={i === 0}
              className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Nazad
            </button>
            <button
              type="button"
              onClick={next}
              className="inline-flex items-center gap-1 rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            >
              {i < present.length - 1 ? 'Dalje' : 'Završi'}
              {i < present.length - 1 && <ChevronRight className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
