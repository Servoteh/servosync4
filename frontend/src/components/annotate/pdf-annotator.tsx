'use client';

// Fullscreen PDF annotator for QC controllers on a tablet (Samsung + S Pen).
// Replaces marking up a printed work order by hand: open the RN (or a drawing)
// PDF, write/draw over it with the pen, and save the result as a flattened PNG
// attached to the order (uploaded into quality_documents).
//
// Rendering model:
//   • pdfjs renders the CURRENT page onto an opaque "background" canvas, sized to
//     the container width but at a higher (DPR- and zoom-scaled) backing-store
//     resolution for crisp lines and legible text.
//   • A transparent "ink" canvas is absolutely positioned on top at the exact
//     same pixel dimensions; use-stylus-canvas owns the drawing.
//   • On save, the two are flattened into one PNG (getMergedBlob).
//
// Ink is per-page: switching pages clears the ink layer (each page annotates
// independently and is saved separately).
//
// UI is Serbian (latinica); code/comments English (new module — allowed).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Hand,
  Loader2,
  Pencil,
  Save,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { apiBlob, ApiError } from '@/api/client';
import { cn } from '@/lib/cn';
import { openPdfDocument, type PDFDocumentProxy } from './pdfjs-loader';
import { PEN_COLORS, useStylusCanvas, type PenColor } from './use-stylus-canvas';

/** What to annotate: a work-order RN print, a drawing PDF, or a raw Blob. */
export type AnnotateSource =
  | { kind: 'workOrder'; id: number; identNumber?: string }
  | { kind: 'drawing'; id: number }
  | { kind: 'blob'; blob: Blob };

export interface PdfAnnotatorProps {
  source: AnnotateSource;
  /** Persist the flattened annotated page. `pageIndex` is 0-based. */
  onSave: (png: Blob, pageIndex: number) => Promise<void>;
  onClose: () => void;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
/** Cap the backing-store scale so huge plotter drawings don't blow up memory. */
const MAX_RENDER_SCALE = 4;

const COLOR_SWATCHES: { key: PenColor; label: string }[] = [
  { key: 'black', label: 'Crna' },
  { key: 'red', label: 'Crvena' },
  { key: 'blue', label: 'Plava' },
];

async function fetchSourceBytes(source: AnnotateSource): Promise<ArrayBuffer> {
  if (source.kind === 'blob') return source.blob.arrayBuffer();
  const path =
    source.kind === 'workOrder'
      ? `/v1/work-orders/${source.id}/print`
      : `/v1/tech-processes/drawings/${source.id}/pdf/content`;
  const blob = await apiBlob(path);
  return blob.arrayBuffer();
}

function friendlyLoadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Dokument nije pronađen (404).';
    if (err.status === 503) return 'Servis trenutno nije dostupan (503). Pokušajte ponovo.';
    return err.message || 'Greška pri učitavanju dokumenta.';
  }
  const msg = err instanceof Error ? err.message : '';
  if (/password/i.test(msg)) return 'Dokument je zaštićen lozinkom i ne može se prikazati.';
  return 'Nije moguće učitati PDF dokument.';
}

export function PdfAnnotator({ source, onSave, onClose }: PdfAnnotatorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // Guards concurrent renders (page/zoom/resize can overlap); a monotonically
  // increasing token; only the latest render is allowed to paint.
  const renderTokenRef = useRef(0);

  // "Finger mode": off by default → palm rejection (only the S Pen draws). The
  // hook re-reads allowTouch on every render, so passing live state is enough.
  const [allowTouch, setAllowTouch] = useState(false);
  const ink = useStylusCanvas({ allowTouch });

  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // ── load document ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const bytes = await fetchSourceBytes(source);
        const doc = await openPdfDocument(bytes);
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setPageIndex(0);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(friendlyLoadError(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      const d = docRef.current;
      docRef.current = null;
      if (d) void d.destroy();
    };
    // Re-load only when the underlying source identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey(source)]);

  // ── render current page ──────────────────────────────────────────────────
  const renderPage = useCallback(async () => {
    const doc = docRef.current;
    const container = containerRef.current;
    const bg = bgCanvasRef.current;
    const inkCanvas = ink.ref.current;
    if (!doc || !container || !bg || !inkCanvas) return;

    const token = ++renderTokenRef.current;
    setRendering(true);
    try {
      const page = await doc.getPage(pageIndex + 1);
      if (token !== renderTokenRef.current) return;

      const base = page.getViewport({ scale: 1 });
      // Fit the page width to the available container width, then apply zoom and
      // a device-pixel-ratio multiplier for crisp rendering — capped.
      const containerWidth = Math.max(320, container.clientWidth - 8);
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      const fitScale = containerWidth / base.width;
      const cssScale = fitScale * zoom;
      const renderScale = Math.min(cssScale * dpr, MAX_RENDER_SCALE);
      const viewport = page.getViewport({ scale: renderScale });

      const pxW = Math.round(viewport.width);
      const pxH = Math.round(viewport.height);
      // Backing store at render resolution; CSS size at (render/dpr) so it lays
      // out at the intended on-screen size. Ink canvas matches exactly.
      const cssW = Math.round(pxW / dpr);
      const cssH = Math.round(pxH / dpr);

      for (const c of [bg, inkCanvas]) {
        c.width = pxW;
        c.height = pxH;
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }

      const ctx = bg.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context nedostupan');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pxW, pxH);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (token !== renderTokenRef.current) return;
      // Re-render ink so it stays visible at the new backing-store size.
      ink.clear();
    } catch (err) {
      if (token === renderTokenRef.current) {
        setLoadError(friendlyLoadError(err));
      }
    } finally {
      if (token === renderTokenRef.current) setRendering(false);
    }
    // ink.ref / ink.clear are stable; page/zoom drive re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, zoom]);

  useEffect(() => {
    if (loading || loadError) return;
    void renderPage();
  }, [loading, loadError, renderPage]);

  // Re-fit on container resize (orientation change / window resize).
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!loading && !loadError) void renderPage();
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [loading, loadError, renderPage]);

  // ── actions ────────────────────────────────────────────────────────────
  const goPage = useCallback(
    (next: number) => {
      if (rendering || saving) return;
      const clamped = Math.max(0, Math.min(pageCount - 1, next));
      if (clamped !== pageIndex) setPageIndex(clamped);
    },
    [pageCount, pageIndex, rendering, saving],
  );

  async function handleSave() {
    if (saving) return;
    const bg = bgCanvasRef.current;
    if (!bg) return;
    setSaving(true);
    setSaveError(null);
    try {
      const png = await ink.getMergedBlob(bg);
      await onSave(png, pageIndex);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Snimanje nije uspelo.');
    } finally {
      setSaving(false);
    }
  }

  // Esc closes (only when idle so a save-in-flight isn't abandoned).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const busy = rendering || saving;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70" role="dialog" aria-modal="true">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {/* Tools */}
        <div className="flex items-center gap-1 rounded-control border border-line p-0.5">
          <ToolButton
            active={ink.tool === 'pen'}
            onClick={() => ink.setTool('pen')}
            label="Olovka"
          >
            <Pencil className="h-5 w-5" aria-hidden />
          </ToolButton>
          <ToolButton
            active={ink.tool === 'eraser'}
            onClick={() => ink.setTool('eraser')}
            label="Guma"
          >
            <Eraser className="h-5 w-5" aria-hidden />
          </ToolButton>
        </div>

        {/* Colors */}
        <div className="flex items-center gap-1.5 px-1">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                ink.setColor(c.key);
                ink.setTool('pen');
              }}
              aria-label={c.label}
              title={c.label}
              className={cn(
                'h-8 w-8 rounded-full border-2 transition-transform',
                ink.color === c.key && ink.tool === 'pen'
                  ? 'scale-110 border-ink'
                  : 'border-line',
              )}
              style={{ backgroundColor: PEN_COLORS[c.key] }}
            />
          ))}
        </div>

        {/* Undo / Clear */}
        <div className="flex items-center gap-1">
          <IconButton onClick={ink.undo} disabled={!ink.hasStrokes} label="Poništi">
            <Undo2 className="h-5 w-5" aria-hidden />
          </IconButton>
          <IconButton onClick={ink.clear} disabled={!ink.hasStrokes} label="Obriši sve">
            <Trash2 className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>

        {/* Finger mode */}
        <button
          type="button"
          onClick={() => setAllowTouch((v) => !v)}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-control border px-3 text-sm font-medium',
            allowTouch
              ? 'border-accent bg-accent-subtle text-accent'
              : 'border-line text-ink-secondary hover:bg-surface-2',
          )}
          aria-pressed={allowTouch}
          title="Kada je uključeno, može se pisati i prstom (inače samo olovkom)."
        >
          <Hand className="h-4 w-4" aria-hidden />
          Piši prstom
        </button>

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <IconButton
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
            disabled={zoom <= ZOOM_MIN || busy}
            label="Umanji"
          >
            <ZoomOut className="h-5 w-5" aria-hidden />
          </IconButton>
          <span className="tnums w-12 text-center text-sm text-ink-secondary">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
            disabled={zoom >= ZOOM_MAX || busy}
            label="Uvećaj"
          >
            <ZoomIn className="h-5 w-5" aria-hidden />
          </IconButton>
        </div>

        <span className="flex-1" />

        {/* Page nav */}
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <IconButton onClick={() => goPage(pageIndex - 1)} disabled={pageIndex <= 0 || busy} label="Prethodna strana">
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </IconButton>
            <span className="tnums min-w-[64px] text-center text-sm text-ink">
              {pageCount ? pageIndex + 1 : 0} / {pageCount}
            </span>
            <IconButton
              onClick={() => goPage(pageIndex + 1)}
              disabled={pageIndex >= pageCount - 1 || busy}
              label="Sledeća strana"
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </IconButton>
          </div>
        )}

        {/* Save / Cancel */}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading || !!loadError || !ink.hasStrokes}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-control px-4 text-sm font-medium',
            'bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:pointer-events-none',
          )}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : savedFlash ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          {savedFlash ? 'Sačuvano' : 'Sačuvaj'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden />
          Otkaži
        </button>
      </div>

      {/* Canvas stage */}
      <div ref={containerRef} className="relative flex-1 overflow-auto bg-[#4b5563] p-1">
        {loading && (
          <div className="absolute inset-0 grid place-items-center text-white">
            <span className="inline-flex items-center gap-2 text-sm">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              Učitavanje dokumenta…
            </span>
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm rounded-panel border border-status-danger/40 bg-surface p-5 text-center">
              <p className="text-sm font-semibold text-status-danger">{loadError}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-4 rounded-control border border-line px-4 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
              >
                Zatvori
              </button>
            </div>
          </div>
        )}

        {/* Page + ink stack. Kept mounted (even during load) so canvases exist. */}
        <div
          className={cn(
            'relative mx-auto w-fit shadow-2xl',
            (loading || loadError) && 'invisible',
          )}
        >
          <canvas ref={bgCanvasRef} className="block bg-white" />
          <canvas ref={ink.ref} className="absolute left-0 top-0" {...ink.handlers} />
          {rendering && !loading && (
            <div className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-control bg-black/60 px-2 py-1 text-xs text-white">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Priprema strane…
            </div>
          )}
        </div>

        {saveError && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
            <p className="pointer-events-auto rounded-control bg-status-danger px-3 py-2 text-sm text-white shadow-lg" role="alert">
              {saveError}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── small controls

function ToolButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'inline-flex h-8 w-9 items-center justify-center rounded-[5px]',
        active ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-control text-ink-secondary hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

/** Stable identity string for a source (drives document reload effect). */
function sourceKey(source: AnnotateSource): string {
  if (source.kind === 'blob') return `blob:${source.blob.size}:${source.blob.type}`;
  return `${source.kind}:${source.id}`;
}
