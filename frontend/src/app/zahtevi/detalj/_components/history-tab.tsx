'use client';

import type { ChangeRequestDetail, ChangeRequestEvent } from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';
import { eventLabel, statusMeta } from '../../_lib/status';

/**
 * Tab „Istorija" — insert-only event timeline (change_request_events) čitljivo na
 * srpskom + realizaciona polja (grana/PR/commit/verzija/izvršilac). Realizaciona
 * polja se UNOSE kroz admin action-bar (POST /status); ovde su READ-ONLY prikaz
 * (izmena je dostupna adminu u action-baru pri realizacionom prelazu).
 */
export function HistoryTab({ detail }: { detail: ChangeRequestDetail }) {
  const hasLinks =
    detail.branchName || detail.prUrl || detail.commitSha || detail.deliveredVersion || detail.implementedBy;

  return (
    <section className="space-y-4">
      {hasLinks && (
        <div className="rounded-panel border border-line bg-surface p-5">
          <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Realizacija
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {detail.branchName && (
              <LinkField label="Grana">
                <span className="tnums text-ink">{detail.branchName}</span>
              </LinkField>
            )}
            {detail.prUrl && (
              <LinkField label="Pull request">
                <a
                  href={detail.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-accent hover:underline"
                >
                  {detail.prUrl}
                </a>
              </LinkField>
            )}
            {detail.commitSha && (
              <LinkField label="Commit">
                <span className="tnums text-ink">{detail.commitSha}</span>
              </LinkField>
            )}
            {detail.deliveredVersion && (
              <LinkField label="Verzija isporuke">
                <span className="text-ink">{detail.deliveredVersion}</span>
              </LinkField>
            )}
            {detail.implementedBy && (
              <LinkField label="Izvršilac">
                <span className="text-ink">{detail.implementedBy}</span>
              </LinkField>
            )}
          </dl>
        </div>
      )}

      <div className="rounded-panel border border-line bg-surface p-5">
        <h2 className="mb-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Događaji
        </h2>
        {detail.events.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema zabeleženih događaja.</p>
        ) : (
          <ol className="space-y-3">
            {detail.events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function LinkField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

/** Jedan event — tačka na timeline-u + čitljiv opis + detalji (from→to za status). */
function EventRow({ ev }: { ev: ChangeRequestEvent }) {
  const data = ev.data ?? {};
  const from = typeof data.from === 'string' ? statusMeta(data.from).label : null;
  const to = typeof data.to === 'string' ? statusMeta(data.to).label : null;
  const note = typeof data.note === 'string' ? data.note : null;
  const field = typeof data.field === 'string' ? data.field : null;

  return (
    <li className="flex gap-3">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-neutral" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm text-ink">
          {eventLabel(ev.type)}
          {from && to && (
            <span className="text-ink-secondary">
              {' '}
              — {from} → {to}
            </span>
          )}
          {ev.type === 'META_CHANGED' && field && (
            <span className="text-ink-secondary"> — {field}</span>
          )}
        </p>
        {note && <p className="mt-0.5 text-2xs text-ink-secondary">„{note}"</p>}
        <p className="mt-0.5 text-2xs text-ink-secondary">
          {ev.actorUserId != null ? `Korisnik #${ev.actorUserId}` : 'Sistem / AI'} ·{' '}
          {formatDateTime(ev.createdAt)}
        </p>
      </div>
    </li>
  );
}
