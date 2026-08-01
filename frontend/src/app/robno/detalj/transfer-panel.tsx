'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  useReverseTransfer,
  useTransfer,
  type StockDocumentDetail,
} from '@/api/robno';

/**
 * Panel „Prenos između magacina" na detalju dokumenta.
 *
 * ZAŠTO: prenos je PAR dokumenata (PREIZ izlaz + PREUL ulaz). Detalj JEDNE strane
 * bez druge ne govori gde je roba otišla — a obe strane nose isti broj („0001/2026")
 * jer se numerišu po vrsti, pa se iz same liste ne razlikuju. Panel pokazuje ceo par
 * i nudi jedinu ispravnu ispravku: STORNO (ogledalni par), ne brisanje stavki.
 */
export function TransferPanel({ doc }: { doc: StockDocumentDetail }) {
  const router = useRouter();
  const pair = useTransfer(doc.kind === 'PRENOS' ? doc.id : null);
  const reverse = useReverseTransfer();
  const [reason, setReason] = useState('');

  if (doc.kind !== 'PRENOS') return null;

  // Jednostrani prenos zatečen pre ispravke od 27.07.2026 — backend vraća 409 sa
  // objašnjenjem. To se mora VIDETI, a ne ćutati: roba tog dokumenta nije zadužena
  // ni u jednom magacinu.
  if (pair.isError) {
    const msg =
      pair.error instanceof ApiError
        ? pair.error.message
        : 'Podaci o prenosu nisu dostupni.';
    return (
      <section className="rounded-panel border border-status-danger/40 bg-status-danger-bg p-4">
        <h2 className="text-md font-semibold text-status-danger">
          Prenos je nepotpun
        </h2>
        <p className="mt-1 text-sm text-ink">{msg}</p>
      </section>
    );
  }

  if (pair.isLoading || !pair.data) {
    return (
      <section className="rounded-panel border border-line p-4 text-sm text-ink-secondary">
        Učitavanje podataka o prenosu…
      </section>
    );
  }

  const p = pair.data.data;
  const isOutbound = p.outbound.id === doc.id;

  const side = (
    label: string,
    d: typeof p.outbound,
    warehouseId: number,
    current: boolean,
  ) => (
    <div
      className={`flex-1 rounded-panel border p-3 ${
        current ? 'border-accent bg-surface-2' : 'border-line'
      }`}
    >
      <div className="text-xs uppercase text-ink-secondary">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="tnums font-semibold text-ink">{d.documentNumber}</span>
        <span className="text-xs text-ink-secondary">{d.documentTypeCode}</span>
        {current && <StatusBadge tone="info" label="ovaj dokument" />}
      </div>
      <div className="mt-1 text-sm text-ink-secondary">
        Magacin {warehouseId} · {d.items.length} stavki
      </div>
      {!current && (
        <button
          className="mt-2 text-sm text-accent underline"
          onClick={() => router.push(`/robno/detalj?id=${d.id}`)}
        >
          Otvori drugu stranu
        </button>
      )}
    </div>
  );

  return (
    <section className="space-y-3 rounded-panel border border-line p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold text-ink">
          Prenos između magacina
        </h2>
        {p.reversed && (
          <StatusBadge
            tone="warn"
            label={`Storniran dokumentom #${p.reversalDocId ?? '—'}`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {side('Razdužuje (izlaz)', p.outbound, p.sourceWarehouseId, isOutbound)}
        <ArrowRight
          className="h-5 w-5 shrink-0 text-ink-secondary"
          aria-hidden
        />
        {side('Zadužuje (ulaz)', p.inbound, p.targetWarehouseId, !isOutbound)}
      </div>

      {p.reversed ? (
        <p className="text-sm text-ink-secondary">
          Prenos je storniran — roba je vraćena u izvorni magacin ogledalnim parom
          dokumenata. Storno se ne stornira; ako robu ipak treba premestiti, napravi
          nov prenos.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-ink-secondary">
            Razlog storna (ide u napomenu oba dokumenta)
            <input
              className="h-9 rounded-control border border-line bg-surface px-3 text-base text-ink"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="npr. pogrešan magacin"
            />
          </label>
          <Button
            variant="secondary"
            loading={reverse.isPending}
            title="Pravi ogledalni par: roba se vraća u izvorni magacin. Ispravka prenosa ide isključivo ovako."
            onClick={() =>
              reverse.mutate(
                { id: doc.id, reason: reason.trim() || undefined },
                {
                  onSuccess: (res) => {
                    toast('Prenos je storniran.');
                    router.push(`/robno/detalj?id=${res.data.outbound.id}`);
                  },
                  onError: (e) =>
                    toast(
                      e instanceof ApiError && e.status === 403
                        ? 'Nemate dozvolu za storno prenosa.'
                        : `Storno nije uspeo: ${(e as Error).message}`,
                    ),
                },
              )
            }
          >
            <Undo2 className="h-4 w-4" aria-hidden />
            Storniraj prenos
          </Button>
        </div>
      )}
    </section>
  );
}
