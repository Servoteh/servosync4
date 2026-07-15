// Lazy loader for pdfjs-dist. Kept out of the initial bundle: the whole module
// (and the ~1 MB pdf.js core) is pulled in only when the annotator actually
// opens, via a dynamic import. Everything here runs in the browser — callers
// live inside 'use client' components and never invoke this during SSR/prerender.
//
// Worker strategy (important for this deployment):
//   • LAN access is plain http, i.e. NOT a secure context, and a strict CSP
//     forbids third-party origins → the pdf.js worker MUST be same-origin and
//     bundled locally, never a CDN.
//   • `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` is the
//     canonical webpack asset-URL form: webpack emits the worker file into
//     `_next/static/...` at build time and rewrites the URL to that same-origin
//     asset. This keeps `next build` (static export) and tsc happy — no
//     `import.meta` left dangling, no external fetch.
//   • Fallback: if the dedicated worker cannot start (rare sandboxed/webview
//     cases), we retry with the worker disabled (`GlobalWorkerOptions.workerSrc`
//     stays empty and getDocument runs the parser on the main thread). Slower,
//     but it renders — better than a hard failure on a controller's tablet.

import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
} from 'pdfjs-dist/types/src/display/api';

// Minimal shape of the pdfjs module surface we touch — avoids leaking the full
// (and noisy) default-export type while staying precise where it matters.
type PdfjsModule = {
  getDocument: (
    src: ArrayBuffer | Uint8Array | { data: ArrayBuffer | Uint8Array; isEvalSupported?: boolean },
  ) => PDFDocumentLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
  version: string;
};

let modulePromise: Promise<PdfjsModule> | null = null;
let workerConfigured = false;
let workerDisabled = false;

/** Load pdfjs once (cached) and configure the same-origin bundled worker. */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist').then((mod) => {
      const pdfjs = mod as unknown as PdfjsModule;
      if (!workerConfigured && !workerDisabled) {
        try {
          // Bundled, same-origin worker asset (see file header for why).
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.min.mjs',
            import.meta.url,
          ).toString();
          workerConfigured = true;
        } catch {
          // Could not resolve the asset URL → fall back to main-thread parsing.
          workerDisabled = true;
          pdfjs.GlobalWorkerOptions.workerSrc = '';
        }
      }
      return pdfjs;
    });
  }
  return modulePromise;
}

/**
 * Open a PDF from raw bytes and return the pdfjs document proxy. Retries once
 * with the worker disabled if the dedicated worker fails to start.
 *
 * The buffer is copied into a fresh Uint8Array because pdfjs transfers/consumes
 * the underlying ArrayBuffer, which would detach a Blob's shared buffer.
 */
export async function openPdfDocument(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const makeData = () => new Uint8Array(bytes.slice(0));
  try {
    return await pdfjs.getDocument({ data: makeData(), isEvalSupported: false }).promise;
  } catch (err) {
    // Worker failed to boot (not a bad-PDF error) → retry on the main thread.
    if (!workerDisabled && isWorkerStartupError(err)) {
      workerDisabled = true;
      pdfjs.GlobalWorkerOptions.workerSrc = '';
      return pdfjs.getDocument({ data: makeData(), isEvalSupported: false }).promise;
    }
    throw err;
  }
}

/** Heuristic: distinguish "worker couldn't start" from "this is not a valid PDF". */
function isWorkerStartupError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /worker|fetch|import|dynamically imported module|failed to construct/i.test(msg);
}

export type { PDFDocumentProxy };
