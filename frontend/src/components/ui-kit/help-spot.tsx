'use client';

// HelpSpot — omotač oko polja/akcije koji u info režimu dodaje malu „i" oznaku i
// oblačić sa objašnjenjem (PLAN_INFO_VODIC_2026-07). Van režima je ČIST passthrough
// (renderuje samo decu — bez omotača, bez troška, ne menja DOM strukturu/layout).
//
// U režimu: apsolutno pozicioniran marker (ne pomera layout, ne krade fokus), oblačić
// na klik/tap/hover/fokus, `aria-describedby`, Esc zatvara (kroz provider, slojevito).
// Oblačić je `position: fixed` sa klampovanjem u ekran — na 360px uvek unutar vidljivog.
// Tekst dolazi iz registra po `id` (ili `title`/`text` propovima). `data-help-id` na
// omotaču služi vođenoj turi da nađe cilj (HelpTour).

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useHelpModeOptional, type HelpContextValue } from './help-mode';

export function HelpSpot({
  id,
  children,
  title,
  text,
  variant = 'block',
  className,
}: {
  id: string;
  children: ReactNode;
  /** Nadjačava naslov iz registra. */
  title?: string;
  /** Nadjačava tekst iz registra. */
  text?: string;
  /** `block` (div, podrazumevano) ili `inline` (span — npr. uz status značku). */
  variant?: 'block' | 'inline';
  className?: string;
}) {
  const ctx = useHelpModeOptional();
  // Van režima (ili bez providera) = čist passthrough: nula omotača, nula troška.
  if (!ctx || !ctx.active) return <>{children}</>;
  return (
    <HelpSpotActive id={id} title={title} text={text} variant={variant} className={className} ctx={ctx}>
      {children}
    </HelpSpotActive>
  );
}

function HelpSpotActive({
  id,
  title,
  text,
  variant,
  className,
  ctx,
  children,
}: {
  id: string;
  title?: string;
  text?: string;
  variant: 'block' | 'inline';
  className?: string;
  ctx: HelpContextValue;
  children: ReactNode;
}) {
  const reg = ctx.entry(id);
  const t = title ?? reg?.title ?? '';
  const body = text ?? reg?.text ?? '';
  const open = ctx.openSpotId === id;
  const tipId = useId();
  const markerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; above: boolean } | null>(
    null,
  );

  // Odloženo zatvaranje (hover intent) — glatka putanja marker → oblačić preko procepa.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (ctx.openSpotId === id) ctx.setOpenSpotId(null);
    }, 140);
  }, [cancelClose, ctx, id]);
  useEffect(() => () => cancelClose(), [cancelClose]);

  // Pozicija oblačića (fixed, klampovano u ekran) — računa se pri otvaranju i uz scroll/resize.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const compute = () => {
      const m = markerRef.current;
      if (!m) return;
      const r = m.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(300, vw - 16);
      let left = r.left;
      if (left + width > vw - 8) left = vw - 8 - width;
      if (left < 8) left = 8;
      // Ispod markera ako ima mesta, inače iznad (procena visine oblačića ~ 150px).
      const above = r.bottom + 8 + 150 > vh && r.top - 8 > 150;
      const top = above ? r.top - 8 : r.bottom + 8;
      setPos({ left, top, width, above });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  const Wrapper = variant === 'inline' ? 'span' : 'div';

  return (
    <Wrapper
      data-help-id={id}
      className={cn('relative', variant === 'inline' && 'inline-flex', className)}
    >
      {children}
      <button
        ref={markerRef}
        type="button"
        aria-label={`Objašnjenje: ${t}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelClose();
          ctx.setOpenSpotId(open ? null : id);
        }}
        onMouseEnter={() => {
          cancelClose();
          ctx.setOpenSpotId(id);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          cancelClose();
          ctx.setOpenSpotId(id);
        }}
        onBlur={scheduleClose}
        className="absolute -right-1 -top-1 z-10 grid h-4 w-4 place-items-center rounded-full bg-accent text-[10px] font-bold leading-none text-accent-fg shadow ring-1 ring-surface focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <span aria-hidden className="-mt-px font-serif italic">
          i
        </span>
      </button>
      {open && pos && (
        <div
          id={tipId}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            width: pos.width,
            transform: pos.above ? 'translateY(-100%)' : undefined,
            zIndex: 60,
          }}
          className="rounded-panel border border-line bg-surface p-3 shadow-xl"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {t && <p className="mb-1 text-sm font-semibold text-ink">{t}</p>}
          <p className="text-xs leading-relaxed text-ink-secondary">{body}</p>
        </div>
      )}
    </Wrapper>
  );
}
