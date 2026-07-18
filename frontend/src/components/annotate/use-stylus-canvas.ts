'use client';

// Stylus drawing engine over a transparent <canvas> laid on top of the rendered
// PDF page. Built for a Samsung tablet + S Pen:
//
//   • Palm rejection: by default only `pointerType === 'pen'` draws. Finger and
//     palm contacts are ignored so the controller can rest a hand on the glass
//     while writing. A "finger mode" prop (allowTouch) lets touch draw too, for
//     tablets without a pen.
//   • Pressure → line width: e.pressure (0..1) maps between min/max px so the
//     stroke thins/thickens like a real pen. Devices that report no pressure
//     (report a flat 0.5) still get a sensible mid width.
//   • Strokes are kept as VECTORS (arrays of points), not baked pixels. That
//     makes Undo and the eraser trivial and lossless: we just drop points/
//     strokes and re-render. Re-render is batched with requestAnimationFrame.
//   • Eraser removes whole strokes it passes over (hit-test against segments),
//     which matches how people expect to "scratch out" a pen mark.
//
// Export: getMergedBlob(bgCanvas) flattens the PDF page (drawn to bgCanvas by the
// annotator) plus the ink into one opaque PNG Blob, ready to upload.

import { useCallback, useEffect, useRef, useState } from 'react';

export type PenColor = 'black' | 'red' | 'blue';
export type Tool = 'pen' | 'eraser';

export const PEN_COLORS: Record<PenColor, string> = {
  black: '#1a1a1a',
  red: '#d6453d',
  blue: '#1971c2',
};

/** One captured sample along a stroke (canvas-pixel coords + pressure-scaled width). */
interface StrokePoint {
  x: number;
  y: number;
  width: number;
}

interface Stroke {
  color: string;
  points: StrokePoint[];
}

const MIN_WIDTH = 1.5;
const MAX_WIDTH = 5.5;
/** Eraser hit radius in canvas px (generous — tablets are imprecise). */
const ERASER_RADIUS = 14;

export interface StylusCanvasApi {
  /** Attach to the transparent ink <canvas>. */
  ref: React.RefObject<HTMLCanvasElement | null>;
  /** Spread onto the ink <canvas> — pointer handlers + touch-action guard. */
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    style: React.CSSProperties;
  };
  undo: () => void;
  clear: () => void;
  setColor: (c: PenColor) => void;
  color: PenColor;
  setTool: (t: Tool) => void;
  tool: Tool;
  hasStrokes: boolean;
  /**
   * Flatten background (rendered page) + ink into one opaque PNG Blob. The ink
   * canvas and bgCanvas MUST share the same pixel dimensions (the annotator
   * guarantees this). Rejects if the canvas cannot produce a blob.
   */
  getMergedBlob: (bgCanvas: HTMLCanvasElement) => Promise<Blob>;
  /**
   * Reset all strokes (e.g. when navigating to another PDF page). Ink for each
   * page is independent; the annotator calls this on page change.
   */
  reset: () => void;
}

export function useStylusCanvas(options: { allowTouch: boolean }): StylusCanvasApi {
  const { allowTouch } = options;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const [color, setColor] = useState<PenColor>('black');
  const [tool, setTool] = useState<Tool>('pen');
  const [hasStrokes, setHasStrokes] = useState(false);

  // Refs mirror state so the raw pointer handlers (stable identity) read fresh
  // values without re-subscribing.
  const colorRef = useRef(color);
  const toolRef = useRef(tool);
  const allowTouchRef = useRef(allowTouch);
  colorRef.current = color;
  toolRef.current = tool;
  allowTouchRef.current = allowTouch;

  const syncHasStrokes = useCallback(() => {
    setHasStrokes(strokesRef.current.length > 0 || (activeRef.current?.points.length ?? 0) > 0);
  }, []);

  /** Schedule one re-render of the ink layer on the next frame (batched). */
  const scheduleRender = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const all = activeRef.current
        ? [...strokesRef.current, activeRef.current]
        : strokesRef.current;
      for (const stroke of all) drawStroke(ctx, stroke);
    });
  }, []);

  const pointFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // CSS px → canvas backing-store px (canvas is rendered at DPR-scaled size).
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    // Some devices report pressure 0 on move without buttons; treat 0 as mid.
    const p = e.pressure > 0 && e.pressure <= 1 ? e.pressure : 0.5;
    const base = MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * p;
    // Widen strokes to match the DPR-scaled backing store so lines look the same
    // thickness regardless of device pixel ratio.
    const width = base * (scaleX + scaleY) * 0.5;
    return { x, y, width };
  }, []);

  const shouldDraw = useCallback((e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return true; // desktop testing
    // touch: only when finger mode is on (otherwise palm/finger are ignored)
    return allowTouchRef.current;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!shouldDraw(e)) return;
      // A pen contact wins over any in-progress touch stroke (palm rejection).
      if (e.pointerType === 'pen' && activePointerIdRef.current != null) {
        activeRef.current = null;
      }
      if (activePointerIdRef.current != null) return; // one stroke at a time
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      activePointerIdRef.current = e.pointerId;
      const pt = pointFromEvent(e);
      if (toolRef.current === 'eraser') {
        eraseAt(pt.x, pt.y);
        activeRef.current = null;
      } else {
        activeRef.current = { color: PEN_COLORS[colorRef.current], points: [pt] };
      }
      scheduleRender();
      syncHasStrokes();
    },
    [pointFromEvent, scheduleRender, shouldDraw, syncHasStrokes],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerId !== activePointerIdRef.current) return;
      e.preventDefault();
      // Coalesced events give smoother lines under fast strokes.
      const events =
        typeof e.nativeEvent.getCoalescedEvents === 'function'
          ? e.nativeEvent.getCoalescedEvents()
          : [e.nativeEvent];
      for (const raw of events.length ? events : [e.nativeEvent]) {
        const proxy = { ...e, clientX: raw.clientX, clientY: raw.clientY, pressure: raw.pressure };
        const pt = pointFromEvent(proxy as React.PointerEvent<HTMLCanvasElement>);
        if (toolRef.current === 'eraser') eraseAt(pt.x, pt.y);
        else activeRef.current?.points.push(pt);
      }
      scheduleRender();
    },
    [pointFromEvent, scheduleRender],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerId !== activePointerIdRef.current) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      activePointerIdRef.current = null;
      const active = activeRef.current;
      if (active && active.points.length > 0) strokesRef.current.push(active);
      activeRef.current = null;
      scheduleRender();
      syncHasStrokes();
    },
    [scheduleRender, syncHasStrokes],
  );

  // Erase every stroke that passes within ERASER_RADIUS of (x, y).
  function eraseAt(x: number, y: number) {
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter((s) => !strokeHit(s, x, y, ERASER_RADIUS));
    if (strokesRef.current.length !== before) syncHasStrokes();
  }

  const undo = useCallback(() => {
    strokesRef.current.pop();
    activeRef.current = null;
    scheduleRender();
    syncHasStrokes();
  }, [scheduleRender, syncHasStrokes]);

  const clear = useCallback(() => {
    strokesRef.current = [];
    activeRef.current = null;
    scheduleRender();
    syncHasStrokes();
  }, [scheduleRender, syncHasStrokes]);

  const reset = useCallback(() => {
    strokesRef.current = [];
    activeRef.current = null;
    activePointerIdRef.current = null;
    scheduleRender();
    syncHasStrokes();
  }, [scheduleRender, syncHasStrokes]);

  const getMergedBlob = useCallback(async (bgCanvas: HTMLCanvasElement): Promise<Blob> => {
    const ink = canvasRef.current;
    if (!ink) throw new Error('Ink platno nije spremno.');
    const out = document.createElement('canvas');
    out.width = bgCanvas.width;
    out.height = bgCanvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Nije moguće pripremiti platno za snimanje.');
    // Opaque white base so the flattened PNG isn't transparent where the page is.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(bgCanvas, 0, 0, out.width, out.height);
    ctx.drawImage(ink, 0, 0, out.width, out.height);
    return new Promise<Blob>((resolve, reject) => {
      out.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Snimanje slike nije uspelo.'))),
        'image/png',
      );
    });
  }, []);

  // Re-render once the canvas is mounted / sized, and cancel any pending frame
  // on unmount.
  useEffect(() => {
    scheduleRender();
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [scheduleRender]);

  return {
    ref: canvasRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endStroke,
      onPointerLeave: endStroke,
      onPointerCancel: endStroke,
      // Disable native gestures on the ink layer so pen strokes aren't stolen by
      // scroll/zoom. The container handles scrolling instead.
      style: { touchAction: 'none' },
    },
    undo,
    clear,
    setColor,
    color,
    setTool,
    tool,
    hasStrokes,
    getMergedBlob,
    reset,
  };
}

// ─────────────────────────────────────────────────────────── drawing helpers

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  if (pts.length === 1) {
    // A single tap = a dot.
    ctx.beginPath();
    ctx.fillStyle = stroke.color;
    ctx.arc(pts[0].x, pts[0].y, pts[0].width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Variable width: draw segment-by-segment using the running point width.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.beginPath();
    ctx.lineWidth = (a.width + b.width) / 2;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/** True if any segment of the stroke passes within `r` px of (x, y). */
function strokeHit(stroke: Stroke, x: number, y: number, r: number): boolean {
  const pts = stroke.points;
  if (pts.length === 1) return dist2(pts[0].x, pts[0].y, x, y) <= r * r;
  for (let i = 1; i < pts.length; i++) {
    if (pointSegmentDist2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r * r) {
      return true;
    }
  }
  return false;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegmentDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return dist2(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist2(px, py, ax + t * abx, ay + t * aby);
}
