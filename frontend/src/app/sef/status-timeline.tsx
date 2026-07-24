'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDateTime } from '@/lib/format';
import { useSefStatusLog, type SefStatusLogEntry } from '@/api/sef';

/**
 * SEF status-istorija (timeline) jednog reda — izlaznog (outboxId) ILI ulaznog
 * (incomingId). T3/A8. Modalni prikaz hronološke liste zapisa iz sef_status_log
 * (status, vreme, korisnik, note). Deljena komponenta: koriste je i izlazni outbox
 * tab (/sef) i ulazni tab (incoming-tab). Data isključivo kroz @/api/sef hook.
 */

/** Status/događaj → tonska boja (kanonska mapa §7 + događaji DRY_RUN/ERROR). */
function eventTone(status: string): Tone {
  switch (status) {
    case 'PENDING':
      return 'warn';
    case 'SENT':
    case 'NEW':
      return 'info';
    case 'DELIVERED':
    case 'ACCEPTED':
      return 'success';
    case 'REJECTED':
    case 'ERROR':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Status/događaj → čitljiva srpska oznaka; nepoznat → sirov status. */
const EVENT_LABEL: Record<string, string> = {
  PENDING: 'U redu',
  SENT: 'Poslato',
  DELIVERED: 'Isporučeno',
  REJECTED: 'Odbijeno',
  CANCELLED: 'Stornirano',
  DRY_RUN: 'Probno (DRY-RUN)',
  ERROR: 'Greška',
  NEW: 'Preuzeto',
  SEEN: 'Pregledano',
  ACCEPTED: 'Prihvaćeno',
};

export function StatusTimelineDialog({
  title,
  outboxId,
  incomingId,
  onClose,
}: {
  title: string;
  outboxId?: number;
  incomingId?: number;
  onClose: () => void;
}) {
  const q = useSefStatusLog({ outboxId, incomingId }, true);
  const rows = q.data?.data ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Zatvori
        </Button>
      }
    >
      {q.isLoading ? (
        <div className="grid place-items-center py-8 text-sm text-ink-secondary">
          Učitavanje…
        </div>
      ) : q.error ? (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(q.error as Error).message}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nema zapisa"
          hint="Istorija statusa je još prazna."
        />
      ) : (
        <ol className="space-y-2">
          {rows.map((r) => (
            <TimelineItem key={r.id} entry={r} />
          ))}
        </ol>
      )}
    </Dialog>
  );
}

function TimelineItem({ entry }: { entry: SefStatusLogEntry }) {
  return (
    <li className="rounded-control border border-line bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={eventTone(entry.status)}
          label={EVENT_LABEL[entry.status] ?? entry.status}
        />
        <span className="text-2xs text-ink-secondary">
          {formatDateTime(entry.createdAt)}
        </span>
        {entry.userId != null && (
          <span className="text-2xs text-ink-disabled">korisnik #{entry.userId}</span>
        )}
      </div>
      {entry.note && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{entry.note}</p>
      )}
    </li>
  );
}
