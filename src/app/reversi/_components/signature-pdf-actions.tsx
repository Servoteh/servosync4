'use client';

import { useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { generateReversiPdf } from '@/lib/reversi-pdf';
import {
  fetchSignaturePdfUrl,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const blob = await generateReversiPdf(doc);
      // upload.onSuccess invalidira ['reversi','documents'] → obuhvata i detail
      // query ovog dokumenta, pa ručni refetch nije potreban.
      await upload.mutateAsync({ docId: doc.id, blob });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generisanje potpisnice nije uspelo.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setError(null);
    // Otvori prozor SINHRONO (u okviru klik-gesta) pa mu tek onda postavi URL —
    // inače (posle await-a) popup blocker tiho pojede presigned link.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    try {
      const { data } = await fetchSignaturePdfUrl(doc.id);
      if (win) win.location.href = data.url;
      else window.location.href = data.url; // popup blokiran → fallback u istom tabu
    } catch (e) {
      win?.close();
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
