'use client';

import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';
import {
  signAttachmentUrl,
  type ChangeRequestAttachment,
  type ChangeRequestDetail,
} from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';

/**
 * Tab „Zahtev" — IMMUTABLE original podnosioca (opis + očekivano/trenutno) + prilozi.
 * Slike: thumbnail preko signed URL → klik = lightbox. Audio: `<audio controls>` +
 * transkript ispod. PDF/fajl: link (otvara signed URL). Signed URL se dohvata
 * on-demand po prilogu (1h; row-scope u servisu — tuđ zahtev je već 404 na detalju).
 */
export function RequestTab({ detail }: { detail: ChangeRequestDetail }) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  return (
    <section className="space-y-4">
      <div className="rounded-panel border border-line bg-surface p-5">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Opis (original)
        </h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{detail.description}</p>

        {(detail.expectedBehavior || detail.currentBehavior) && (
          <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
            {detail.expectedBehavior && (
              <div>
                <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Očekivano ponašanje
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                  {detail.expectedBehavior}
                </p>
              </div>
            )}
            {detail.currentBehavior && (
              <div>
                <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Trenutno ponašanje
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                  {detail.currentBehavior}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-md font-semibold text-ink">
          Prilozi{detail.attachments.length ? ` (${detail.attachments.length})` : ''}
        </h2>
        {detail.attachments.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema priloga.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {detail.attachments.map((att) => (
              <AttachmentCard
                key={att.id}
                requestId={detail.id}
                att={att}
                onOpenImage={setLightbox}
              />
            ))}
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          <button
            className="absolute right-4 top-4 rounded-control bg-black/40 p-2 text-white hover:bg-black/60"
            aria-label="Zatvori"
            onClick={() => setLightbox(null)}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="Prilog"
            className="max-h-[90vh] max-w-full rounded-panel object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </section>
  );
}

/** Jedan prilog — leno dohvata signed URL kad je vidljiv (slika/audio odmah, fajl na klik). */
function AttachmentCard({
  requestId,
  att,
  onOpenImage,
}: {
  requestId: number;
  att: ChangeRequestAttachment;
  onOpenImage: (url: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsUrl = att.kind === 'IMAGE' || att.kind === 'AUDIO';

  useEffect(() => {
    if (!needsUrl) return;
    let cancelled = false;
    signAttachmentUrl(requestId, att.id)
      .then((res) => {
        if (!cancelled) setUrl(res.data.url);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, att.id, needsUrl]);

  async function openFile() {
    try {
      const res = await signAttachmentUrl(requestId, att.id);
      window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      {att.kind === 'IMAGE' && (
        <button
          type="button"
          onClick={() => url && onOpenImage(url)}
          className="block w-full overflow-hidden rounded-control bg-surface-2"
          aria-label={`Otvori sliku ${att.originalName}`}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={att.originalName}
              className="max-h-56 w-full object-cover"
            />
          ) : (
            <div className="grid h-32 place-items-center text-2xs text-ink-secondary">
              {error ? 'Slika nedostupna' : 'Učitavanje…'}
            </div>
          )}
        </button>
      )}

      {att.kind === 'AUDIO' && (
        <div>
          {url ? (
            <audio controls src={url} className="w-full">
              Vaš pregledač ne podržava audio.
            </audio>
          ) : (
            <p className="text-2xs text-ink-secondary">{error ? 'Audio nedostupan' : 'Učitavanje…'}</p>
          )}
          {att.transcript ? (
            <div className="mt-2 rounded-control bg-surface-2 px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                Transkript
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{att.transcript}</p>
            </div>
          ) : (
            <p className="mt-2 text-2xs text-ink-secondary">Transkript još nije dostupan.</p>
          )}
        </div>
      )}

      {att.kind === 'FILE' && (
        <button
          type="button"
          onClick={() => void openFile()}
          className="flex w-full items-center gap-2 rounded-control px-1 py-2 text-left text-sm text-accent hover:underline"
        >
          <FileText className="h-4 w-4 shrink-0" aria-hidden />
          {att.originalName}
        </button>
      )}

      <p className="mt-2 truncate text-2xs text-ink-secondary" title={att.originalName}>
        {att.originalName} · {formatDateTime(att.createdAt)}
      </p>
      {error && att.kind !== 'IMAGE' && att.kind !== 'AUDIO' && (
        <p className="mt-1 text-2xs text-status-danger">{error}</p>
      )}
    </div>
  );
}
