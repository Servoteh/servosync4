'use client';

import { useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { generateReversiPdf } from '@/lib/reversi-pdf';
import {
  fetchSignaturePdfUrl,
  useReversiDocument,
  useUploadSignaturePdf,
  type ReversiDocumentDetail,
} from '@/api/reversi';

/**
 * Potpisnica dokumenta: „Generiši" (client jsPDF → upload na BE, bucket
 * reversal-pdf) i „Preuzmi" (potpisan URL). Manage-only. Za razliku od 1.0
 * fire-and-forget, greška uploada se prikazuje.
 */
export function SignaturePdfActions({ doc, manage }: { doc: ReversiDocumentDetail; manage: boolean }) {
  const upload = useUploadSignaturePdf();
  const refetch = useReversiDocument(doc.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const blob = await generateReversiPdf(doc);
      await upload.mutateAsync({ docId: doc.id, blob });
      await refetch.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generisanje potpisnice nije uspelo.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setError(null);
    try {
      const { data } = await fetchSignaturePdfUrl(doc.id);
      window.open(data.url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preuzimanje nije uspelo.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      {doc.pdfStoragePath && (
        <Button variant="secondary" onClick={() => void download()}>
          Preuzmi potpisnicu
        </Button>
      )}
      {manage && (
        <Button variant="secondary" loading={busy} onClick={() => void generate()}>
          {doc.pdfStoragePath ? 'Regeneriši potpisnicu' : 'Generiši potpisnicu'}
        </Button>
      )}
      {error && <span className="text-xs text-status-danger">{error}</span>}
    </div>
  );
}
