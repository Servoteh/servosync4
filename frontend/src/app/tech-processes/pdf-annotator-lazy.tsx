'use client';

// Lazy loader for the tablet annotation surface (F3c). The real component lives in
// `@/components/annotate/pdf-annotator` and is owned by another agent; it pulls in
// `pdfjs-dist`, which is heavy, so we load it only on demand via `next/dynamic`
// (ssr:false — canvas/PDF rendering is browser-only) to keep it out of the main
// bundle. The prop contract below is the agreed interface; if the real module is
// not yet present in the working tree, an ambient shim (annotate-shim.d.ts) keeps
// `tsc` green — the final verify against the real component is authoritative.

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

/** Where the annotator gets the document to draw over. */
export type AnnotatorSource =
  | { kind: 'workOrder'; id: number; identNumber?: string | null }
  | { kind: 'drawing'; id: number; identNumber?: string | null }
  | { kind: 'blob'; blob: Blob; identNumber?: string | null };

/** Public props of the annotator (mirror of the component owned by the other agent). */
export interface PdfAnnotatorProps {
  source: AnnotatorSource;
  /** Called with the flattened annotated page as a PNG blob + its 0-based page index. */
  onSave: (png: Blob, pageIndex: number) => Promise<void>;
  onClose: () => void;
}

/**
 * `next/dynamic` with an explicit prop type. We cast the imported module to the
 * expected component type so callers get full type-checking regardless of whether
 * the real module or the ambient shim is resolved at compile time.
 */
export const PdfAnnotator = dynamic(
  () =>
    import('@/components/annotate/pdf-annotator').then(
      (m) => m.PdfAnnotator as ComponentType<PdfAnnotatorProps>,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="grid min-h-[60vh] place-items-center text-sm text-ink-secondary">
        Učitavanje alata za pisanje…
      </div>
    ),
  },
) as ComponentType<PdfAnnotatorProps>;
