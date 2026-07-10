'use client';

// Ručni uvoz PDM izvoza (XML crteža / PDF-ova) — dijalog sa dugmadi u header-u
// taba „Log uvoza". Backend prima JEDAN fajl po pozivu (isti endpointi koje
// koristi i pdm-bridge), pa se izabrani fajlovi šalju SEKVENCIJALNO
// (for..await); rezultat po fajlu ide u listu: uspeh / preskočen / greška +
// statusMessage backenda. Poslovno odbijanje je HTTP 2xx sa success:false;
// HTTP greške stižu kroz ApiError. Tastatura (DESIGN_SYSTEM §8): Esc zatvara
// (kit Dialog), Enter pokreće slanje.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { FormField } from '@/components/ui-kit/form-field';
import { cn } from '@/lib/cn';
import {
  useImportDrawingPdf,
  useImportDrawingXml,
  type ImportPdfResult,
  type ImportXmlResult,
} from '@/api/pdm';

export type ImportKind = 'xml' | 'pdf';

const KIND_META: Record<
  ImportKind,
  { title: string; accept: string; fieldLabel: string; hint: string }
> = {
  xml: {
    title: 'Uvoz XML izvoza (PDM)',
    accept: '.xml',
    fieldLabel: 'XML fajlovi',
    hint: 'SolidWorks PDM izvoz crteža/sklopa — može više fajlova odjednom, šalju se redom.',
  },
  pdf: {
    title: 'Uvoz PDF crteža',
    accept: '.pdf,application/pdf',
    fieldLabel: 'PDF fajlovi',
    hint: 'PDF crteža iz PDM izvoza — može više fajlova odjednom, šalju se redom.',
  },
};

/** Benigno upozorenje za PDF koji je stigao pre svog XML-a (drawingExists:false). */
const PDF_WAITING_MESSAGE = 'Crtež još nije uvezen — PDF je sačuvan i čeka XML.';

interface FileOutcome {
  fileName: string;
  tone: Tone;
  label: string;
  /** statusMessage iz backenda, odnosno poruka ApiError-a za HTTP grešku. */
  message: string | null;
  /** Benigno upozorenje (PDF pre XML-a) — poruka u warn boji, ishod je uspeh. */
  benign?: boolean;
}

function xmlOutcome(fileName: string, r: ImportXmlResult): FileOutcome {
  if (!r.success)
    return { fileName, tone: 'danger', label: 'Greška', message: r.statusMessage ?? 'Uvoz odbijen.' };
  // Skip celog fajla (root već postoji) backend signalizira kroz stats.skippedExisting.
  if (r.stats?.skippedExisting)
    return { fileName, tone: 'neutral', label: 'Preskočen', message: r.statusMessage };
  return { fileName, tone: 'success', label: 'Uspešno', message: r.statusMessage };
}

function pdfOutcome(fileName: string, r: ImportPdfResult): FileOutcome {
  if (!r.success)
    return { fileName, tone: 'danger', label: 'Greška', message: r.statusMessage ?? 'Uvoz odbijen.' };
  if (r.drawingExists === false)
    return { fileName, tone: 'success', label: 'Uspešno', message: PDF_WAITING_MESSAGE, benign: true };
  return { fileName, tone: 'success', label: 'Uspešno', message: r.statusMessage };
}

export function ImportDialog({
  kind,
  open,
  onClose,
}: {
  kind: ImportKind;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const importXml = useImportDrawingXml();
  const importPdf = useImportDrawingPdf();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<FileOutcome[]>([]);
  const [sending, setSending] = useState(false);

  // Reset pri svakom otvaranju.
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setResults([]);
    setSending(false);
  }, [open, kind]);

  const meta = KIND_META[kind];

  function close() {
    // Dok slanje traje zatvaranje (Esc/overlay/Zatvori) se blokira — prekid
    // usred niza bi ostavio deo fajlova neposlat bez ikakvog traga u UI.
    if (sending) return;
    // Mutacije već invalidiraju na svaki uspeh; ovo hvata i slučaj kad su svi
    // pokušaji pali kao HTTP greške (backend je log možda ipak upisao).
    if (results.length > 0) qc.invalidateQueries({ queryKey: ['pdm', 'import-log'] });
    onClose();
  }

  async function submit() {
    if (sending || files.length === 0) return;
    setSending(true);
    setResults([]);
    // SEKVENCIJALNO — backend prima jedan fajl po pozivu; redosled izbora se
    // čuva (roditeljski sklopovi pre delova, kao legacy skripta).
    for (const file of files) {
      let outcome: FileOutcome;
      try {
        if (kind === 'xml') {
          const res = await importXml.mutateAsync(file);
          outcome = xmlOutcome(file.name, res.data);
        } else {
          const res = await importPdf.mutateAsync(file);
          outcome = pdfOutcome(file.name, res.data);
        }
      } catch (e) {
        outcome = {
          fileName: file.name,
          tone: 'danger',
          label: 'Greška',
          message: e instanceof Error ? e.message : 'Greška u komunikaciji sa serverom',
        };
      }
      setResults((prev) => [...prev, outcome]);
    }
    setSending(false);
    setFiles([]);
    if (inputRef.current) inputRef.current.value = '';
  }

  // Enter pokreće slanje (Esc već zatvara kroz kit Dialog). Ref čuva svež
  // closure; Enter na dugmetu ostaje klik tog dugmeta (ne kradem ga).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      e.preventDefault();
      void submitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={close}
      title={meta.title}
      footer={
        <>
          <button
            onClick={close}
            disabled={sending}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Zatvori
          </button>
          <Button
            onClick={() => void submit()}
            loading={sending}
            disabled={files.length === 0}
            title="Enter pokreće slanje"
          >
            Uvezi{files.length > 0 ? ` (${files.length})` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={meta.fieldLabel} hint={meta.hint}>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={meta.accept}
            disabled={sending}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className={cn(
              'block w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink',
              'file:mr-3 file:rounded-control file:border-0 file:bg-surface-2 file:px-3 file:py-1 file:text-sm file:font-medium file:text-ink',
              'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          />
        </FormField>

        {sending && (
          <p className="text-sm text-ink-secondary" role="status">
            Slanje fajla {Math.min(results.length + 1, files.length)} od {files.length}… fajlovi
            se šalju jedan po jedan.
          </p>
        )}

        {results.length > 0 && (
          <ul className="divide-y divide-line rounded-control border border-line">
            {results.map((r, i) => (
              <li key={`${r.fileName}-${i}`} className="flex items-start gap-2.5 px-3 py-1.5">
                <span className="tnums min-w-0 shrink-0 break-all font-semibold text-ink">
                  {r.fileName}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 break-words text-xs',
                    r.benign
                      ? 'text-status-warn'
                      : r.tone === 'danger'
                        ? 'text-status-danger'
                        : 'text-ink-secondary',
                  )}
                >
                  {r.message || '—'}
                </span>
                <StatusBadge tone={r.tone} label={r.label} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
