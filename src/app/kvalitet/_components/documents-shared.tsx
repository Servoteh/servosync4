'use client';

// Deljene komponente za QC dokumente (tab „Dokumenti" + sekcija u detalju
// izveštaja). QC dokumenti se UPLOADUJU KROZ APLIKACIJU i čuvaju u PostgreSQL
// (bytea, presedan drawing_pdfs) — nema share-a ni mount-a (odluka 15.07).
//   • AddDocDialog     — upload jednog ili više fajlova (sekvencijalno, kao PDM uvoz)
//   • DeleteDocConfirm — potvrda brisanja (KVALITET_WRITE)
//   • DocumentsSection — lista + „Dodaj fajl" u detalju izveštaja (veza reportId)

import { useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Can, useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  openQualityDoc,
  useDeleteQualityDoc,
  useQualityDocs,
  useUploadQualityDoc,
  type QualityDoc,
} from '@/api/kvalitet';

/** Veličina u KB → čitljiv string (KB do 1024, dalje MB sa jednom decimalom). */
export function formatDocSize(kb: number | null | undefined): string {
  if (kb == null) return '—';
  if (kb >= 1024) return `${formatNumber(Math.round((kb / 1024) * 10) / 10)} MB`;
  return `${formatNumber(kb)} KB`;
}

// Kamera na telefonu/tabletu se nudi automatski jer accept sadrži `image/*`
// (OS file picker prikaže „Slikaj / Take Photo"). Ne postavljamo `capture`
// atribut jer bi zaključao unos SAMO na kameru — a treba i PDF i galerija.
const DOC_ACCEPT = 'application/pdf,image/*';

interface FileOutcome {
  fileName: string;
  tone: Tone;
  label: string;
  message: string | null;
}

/**
 * Dijalog „Dodaj fajl" — upload jednog ili više QC dokumenata. Fajlovi se šalju
 * SEKVENCIJALNO (backend prima jedan po pozivu), sa prikazom progresa i ishoda po
 * fajlu (uspeh / greška). Veza (reportId / techProcessId) dolazi iz mesta poziva;
 * `showIdentField` dodaje opciono ručno vezivanje za RN (ident broj).
 */
export function AddDocDialog({
  open,
  onClose,
  reportId,
  techProcessId,
  showIdentField = false,
  defaultIdentNumber = '',
}: {
  open: boolean;
  onClose: () => void;
  reportId?: number;
  techProcessId?: number;
  showIdentField?: boolean;
  defaultIdentNumber?: string;
}) {
  const upload = useUploadQualityDoc();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [ident, setIdent] = useState(defaultIdentNumber);
  const [results, setResults] = useState<FileOutcome[]>([]);
  const [sending, setSending] = useState(false);

  // Reset pri svakom otvaranju (čist obrazac + poništeni prethodni ishodi).
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setIdent(defaultIdentNumber);
    setResults([]);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    // Prekid usred niza bi ostavio deo fajlova neposlat bez traga — blokiramo.
    if (sending) return;
    onClose();
  }

  async function submit() {
    if (sending || files.length === 0) return;
    setSending(true);
    setResults([]);
    const identNumber = showIdentField ? ident.trim() || undefined : undefined;
    for (const file of files) {
      let outcome: FileOutcome;
      try {
        const res = await upload.mutateAsync({ file, reportId, techProcessId, identNumber });
        outcome = {
          fileName: res.data.fileName || file.name,
          tone: 'success',
          label: 'Uspešno',
          message: formatDocSize(res.data.sizeKb),
        };
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

  // Enter pokreće slanje (Esc zatvara kroz kit Dialog). Ref čuva svež closure.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'BUTTON' || el?.tagName === 'INPUT') return;
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
      title="Dodaj fajl"
      footer={
        <>
          <button
            onClick={close}
            disabled={sending}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Zatvori
          </button>
          <Button onClick={() => void submit()} loading={sending} disabled={files.length === 0}>
            Otpremi{files.length > 0 ? ` (${files.length})` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField
          label="Fajlovi"
          hint="PDF ili slika (skenirani nalog, kontrolna dokumentacija, fotka). Na telefonu/tabletu se nudi i kamera. Više fajlova se šalje redom."
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={DOC_ACCEPT}
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

        {showIdentField && (
          <FormField label="Vezi za RN (ident broj)" hint="Opciono — poveži dokument sa radnim nalogom.">
            <Input
              value={ident}
              onChange={(e) => setIdent(e.target.value)}
              disabled={sending}
              placeholder="npr. 9400-1/442"
            />
          </FormField>
        )}

        {sending && (
          <p className="text-sm text-ink-secondary" role="status">
            Slanje fajla {Math.min(results.length + 1, files.length)} od {files.length}… fajlovi se
            šalju jedan po jedan.
          </p>
        )}

        {results.length > 0 && (
          <ul className="divide-y divide-line rounded-control border border-line">
            {results.map((r, i) => (
              <li key={`${r.fileName}-${i}`} className="flex items-center gap-2.5 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-medium text-ink" title={r.fileName}>
                  {r.fileName}
                </span>
                <span
                  className={cn(
                    'tnums shrink-0 text-xs',
                    r.tone === 'danger' ? 'text-status-danger' : 'text-ink-secondary',
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

/** Potvrda brisanja jednog QC dokumenta (KVALITET_WRITE gate na pozivaocu). */
export function DeleteDocConfirm({
  doc,
  onClose,
}: {
  doc: QualityDoc | null;
  onClose: () => void;
}) {
  const del = useDeleteQualityDoc();
  return (
    <Dialog
      open={doc != null}
      onClose={onClose}
      title="Brisanje dokumenta"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => {
              if (doc) del.mutate(doc.id, { onSuccess: onClose });
            }}
          >
            Obriši
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-ink">
        <p>
          Trajno obrisati dokument <span className="font-medium">{doc?.fileName}</span>? Ova radnja
          se ne može poništiti.
        </p>
        {del.error && (
          <p className="text-status-danger" role="alert">
            {(del.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Dugme „Otvori" (blob → novi tab) sa lokalnim stanjem učitavanja i greške. */
export function OpenDocButton({ id }: { id: number }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setLoading(true);
        void openQualityDoc(id).finally(() => setLoading(false));
      }}
      disabled={loading}
      className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
    >
      {loading ? 'Otvaram…' : 'Otvori'}
    </button>
  );
}

/**
 * Sekcija „Dokumenti" u detalju izveštaja: lista priloženih dokumenata (otvori /
 * obriši) + „Dodaj fajl" koji uploaduje sa vezom na `reportId`. Uvek dovlači svež
 * skup preko `useQualityDocs({ reportId })` (nezavisno od toga nosi li lista već
 * `documents[]`).
 */
export function DocumentsSection({ reportId }: { reportId: number }) {
  const can = useCan();
  const canWrite = can(PERMISSIONS.KVALITET_WRITE);
  const docs = useQualityDocs({ reportId });
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<QualityDoc | null>(null);

  const rows = docs.data?.data ?? [];

  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Paperclip className="h-4 w-4 text-ink-secondary" aria-hidden />
        <h3 className="text-sm font-semibold text-ink">Dokumenti</h3>
        <span className="tnums text-xs text-ink-secondary">({rows.length})</span>
        <span className="flex-1" />
        <Can permission={PERMISSIONS.KVALITET_WRITE}>
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            <Paperclip className="h-4 w-4" aria-hidden />
            Dodaj fajl
          </Button>
        </Can>
      </div>

      {docs.error ? (
        <p className="text-sm text-status-danger" role="alert">
          {(docs.error as Error).message}
        </p>
      ) : docs.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema priloženih dokumenata.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink" title={d.fileName}>
                  {d.fileName}
                </div>
                <div className="tnums text-2xs text-ink-secondary">
                  {formatDocSize(d.sizeKb)} · {formatDateTime(d.createdAt)}
                  {d.uploadedBy ? ` · ${d.uploadedBy}` : ''}
                </div>
              </div>
              <OpenDocButton id={d.id} />
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setPendingDelete(d)}
                  className="rounded-control border border-status-danger/40 p-1 text-status-danger hover:bg-status-danger/10"
                  aria-label="Obriši dokument"
                  title="Obriši dokument"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <AddDocDialog open={addOpen} onClose={() => setAddOpen(false)} reportId={reportId} />
      <DeleteDocConfirm doc={pendingDelete} onClose={() => setPendingDelete(null)} />
    </section>
  );
}
