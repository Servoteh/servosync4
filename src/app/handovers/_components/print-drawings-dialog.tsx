'use client';

// P3: modal „Štampaj sve crteže" — štampa svih crteža nacrta/primopredaje
// odjednom, grupisano po detektovanom formatu strane: laser grupe (A4/A3) pa
// ploter grupe (A2/A1/A0), pa poseban format. JEDNA grupa = JEDAN print job:
// fetch spojenog PDF-a (backend pdf-lib merge) → skriveni iframe +
// contentWindow.print() → browser SISTEMSKI dijalog bira štampač za celu
// grupu. „Otvori PDF" (novi tab) je fallback ako sistemska štampa ne krene.

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Printer } from 'lucide-react';
import {
  fetchPrintBundlePdf,
  useDraftPrintBundle,
  useHandoverPrintBundle,
  type PrintBundleGroup,
  type PrintBundleItem,
  type PrintBundleScope,
  type PrintPageFormat,
} from '@/api/handovers';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import { ErrorText } from './common';

/** Redosled prikaza grupa: laser (A4/A3) pre plotera (A2/A1/A0), poseban format poslednji. */
const DISPLAY_ORDER: PrintPageFormat[] = ['A4', 'A3', 'A2', 'A1', 'A0', 'custom'];

/** Legacy paritet: HP LaserJet za A4/A3, EPSON ploter za A2–A0 (izbor štampača je na browseru). */
const GROUP_LABEL: Record<PrintPageFormat, string> = {
  A4: 'A4 · laserski štampač',
  A3: 'A3 · laserski štampač',
  A2: 'A2 · ploter',
  A1: 'A1 · ploter',
  A0: 'A0 · ploter',
  custom: 'Poseban format',
};

function itemLabel(item: PrintBundleItem): string {
  return item.drawingNumber
    ? `${item.drawingNumber} / ${item.revision ?? '—'}`
    : `#${item.drawingId}`;
}

/** Srpska množina za "crtež": 1 crtež / 2 crteža... (dovoljno za ovaj prikaz). */
function crtezPlural(n: number): string {
  return n === 1 ? 'crtež' : 'crteža';
}

/**
 * Štampa PDF blob-a kroz skriveni iframe + `contentWindow.print()` — otvara se
 * sistemski print dijalog (korisnik bira štampač). Iframe je 0×0 van toka (ne
 * `display:none` — pojedini browseri takav iframe ne štampaju). objectURL i
 * iframe se čiste na `afterprint`; pošto Chrome PDF viewer taj događaj ne
 * garantuje, postoji i fallback tajmer (print dijalog ume dugo da stoji
 * otvoren dok se bira štampač, pa je tajmer dug).
 */
function printPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(fallback);
    URL.revokeObjectURL(url);
    iframe.remove();
  };
  const fallback = window.setTimeout(cleanup, 10 * 60_000);

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    win.addEventListener('afterprint', () => {
      // print() blokira dok je dijalog otvoren — čišćenje ide van tog stack-a.
      window.setTimeout(cleanup, 0);
    });
    // Pauza da PDF viewer u iframe-u stigne da se renderuje pre print() —
    // `load` se okida kad viewer PRIMI dokument, ne kad ga iscrta, pa pauza
    // raste sa veličinom blob-a (150 ms + ~50 ms/MB, najviše 3 s) da veliki
    // spojeni PDF ne odštampa prazan/nepotpun pregled.
    const renderDelayMs = Math.min(150 + Math.ceil(blob.size / 1_048_576) * 50, 3_000);
    window.setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        // Sistemska štampa nije krenula — korisnik ima „Otvori PDF" fallback.
        cleanup();
      }
    }, renderDelayMs);
  };
  iframe.src = url;
  document.body.appendChild(iframe);
}

/** Fallback: otvori spojeni PDF u novom tabu (isti obrazac kao `openWorkOrderRnPdf`). */
function openPdfBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const itemRow = 'flex items-center gap-2.5 px-3 py-1.5';
const sectionHeading = 'text-2xs font-semibold uppercase tracking-[0.08em]';
const smallActionBtn = 'h-7 gap-1.5 px-2.5 text-xs';

export function PrintDrawingsDialog({
  open,
  onClose,
  scope,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  /** Nacrt (svi crteži) ili primopredaja (jedan crtež) — bira koji hook/rute se koriste. */
  scope: PrintBundleScope;
  /** Kontekst u vrhu modala, npr. "Nacrt G-260706-001". */
  subtitle?: string;
}) {
  // Oba hooka su uvek pozvana (rules-of-hooks); aktivan je samo onaj za scope.
  const draftBundle = useDraftPrintBundle(open && scope.kind === 'draft' ? scope.id : null);
  const handoverBundle = useHandoverPrintBundle(
    open && scope.kind === 'handover' ? scope.id : null,
  );
  const query = scope.kind === 'draft' ? draftBundle : handoverBundle;
  const bundle = query.data?.data;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  // Default selekcija = SVE štampljive stavke (ne-isključene sa PDF-om);
  // resetuje se pri svakom otvaranju i kad bundle stigne/refetch-uje.
  useEffect(() => {
    if (!open) return;
    setPrintError(null);
    setSelected(
      new Set(
        (bundle?.items ?? []).filter((i) => !i.excluded && i.hasPdf).map((i) => i.drawingId),
      ),
    );
  }, [open, bundle]);

  const items = useMemo(() => bundle?.items ?? [], [bundle]);
  const byDrawing = useMemo(() => new Map(items.map((i) => [i.drawingId, i])), [items]);
  const groups = useMemo(
    () =>
      [...(bundle?.groups ?? [])].sort(
        (a, b) => DISPLAY_ORDER.indexOf(a.format) - DISPLAY_ORDER.indexOf(b.format),
      ),
    [bundle],
  );
  const missing = items.filter((i) => !i.excluded && !i.hasPdf);
  const excludedItems = items.filter((i) => i.excluded);

  function toggle(drawingId: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(drawingId);
      else next.delete(drawingId);
      return next;
    });
  }

  async function printGroup(group: PrintBundleGroup, mode: 'print' | 'open') {
    const ids = group.drawingIds.filter((id) => selected.has(id));
    if (!ids.length || busyKey) return; // guard i protiv duplog klika
    setBusyKey(`${mode}:${group.format}`);
    setPrintError(null);
    try {
      // Cela grupa → ?format= (backend filtrira po detekciji), podskup → ?drawingIds=.
      const blob = await fetchPrintBundlePdf(
        scope,
        ids.length === group.count ? { format: group.format } : { drawingIds: ids },
      );
      if (mode === 'print') printPdfBlob(blob);
      else openPdfBlob(blob);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : 'Greška pri preuzimanju PDF-a za štampu.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Štampaj sve crteže"
      footer={
        <button
          onClick={onClose}
          className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
        >
          Zatvori
        </button>
      }
    >
      <div className="space-y-4">
        {subtitle && <p className="text-sm font-semibold text-ink">{subtitle}</p>}
        <p className="text-xs text-ink-disabled">
          Jedna grupa formata = jedan print job: „Štampaj” otvara sistemski dijalog u kome birate
          JEDAN štampač za celu grupu (A4/A3 laser, A2–A0 ploter). Štampajte u razmeri 100%
          („Actual size”), bez uklapanja na stranu.
        </p>

        {query.isLoading && <p className="text-sm text-ink-disabled">Učitavanje crteža…</p>}
        <ErrorText error={query.error} />

        {bundle && (
          <>
            {missing.length > 0 && (
              <p
                className="rounded-control border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger"
                role="alert"
              >
                Nedostaje PDF za {formatNumber(missing.length)} {crtezPlural(missing.length)} — te
                stavke nisu selektabilne i ne štampaju se.
              </p>
            )}

            {groups.length === 0 && (
              <p className="text-sm text-ink-secondary">
                Nijedan crtež nema uskladišten PDF — nema šta da se štampa.
              </p>
            )}

            {groups.map((group) => {
              const selectedCount = group.drawingIds.filter((id) => selected.has(id)).length;
              return (
                <section
                  key={group.format}
                  className="overflow-hidden rounded-control border border-line"
                >
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/40 px-3 py-2">
                    <span className="text-sm font-semibold text-ink">
                      {GROUP_LABEL[group.format]}{' '}
                      <span className="font-normal text-ink-secondary">
                        · {formatNumber(group.count)} {crtezPlural(group.count)}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Button
                        onClick={() => printGroup(group, 'print')}
                        loading={busyKey === `print:${group.format}`}
                        disabled={busyKey != null || selectedCount === 0}
                        className={smallActionBtn}
                      >
                        <Printer className="h-3.5 w-3.5" aria-hidden />
                        Štampaj ({selectedCount})
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => printGroup(group, 'open')}
                        loading={busyKey === `open:${group.format}`}
                        disabled={busyKey != null || selectedCount === 0}
                        className={smallActionBtn}
                        title="Fallback ako sistemska štampa ne krene — spojeni PDF u novom tabu."
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Otvori PDF
                      </Button>
                    </span>
                  </header>
                  <ul className="divide-y divide-line">
                    {group.drawingIds.map((id) => {
                      const item = byDrawing.get(id);
                      if (!item) return null;
                      return (
                        <li key={id}>
                          <label className={`${itemRow} cursor-pointer hover:bg-surface-2/60`}>
                            <input
                              type="checkbox"
                              checked={selected.has(id)}
                              onChange={(e) => toggle(id, e.target.checked)}
                              className="h-4 w-4 shrink-0 accent-accent"
                            />
                            <span className="tnums shrink-0 font-semibold text-ink">
                              {itemLabel(item)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-ink-secondary">
                              {item.name || '—'}
                            </span>
                            {item.sizeKb != null && (
                              <span className="tnums shrink-0 text-xs text-ink-disabled">
                                {formatNumber(item.sizeKb)} KB
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}

            {missing.length > 0 && (
              <section className="space-y-1">
                <p className={`${sectionHeading} text-status-danger`}>
                  Bez PDF-a ({missing.length})
                </p>
                <ul className="divide-y divide-line rounded-control border border-status-danger/30">
                  {missing.map((item) => (
                    <li key={item.drawingId} className={itemRow}>
                      <input
                        type="checkbox"
                        checked={false}
                        disabled
                        className="h-4 w-4 shrink-0"
                        aria-label={`${itemLabel(item)} — nema PDF`}
                      />
                      <span className="tnums shrink-0 font-semibold text-status-danger">
                        {itemLabel(item)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-status-danger/80">
                        {item.name || '—'}
                      </span>
                      <StatusBadge tone="danger" label="Nema PDF" />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {excludedItems.length > 0 && (
              <section className="space-y-1">
                <p className={`${sectionHeading} text-ink-secondary`}>
                  Isključene iz primopredaje ({excludedItems.length})
                </p>
                <ul className="divide-y divide-line rounded-control border border-line">
                  {excludedItems.map((item) => (
                    <li key={item.drawingId} className={`${itemRow} opacity-60`}>
                      <input
                        type="checkbox"
                        checked={false}
                        disabled
                        className="h-4 w-4 shrink-0"
                        aria-label={`${itemLabel(item)} — isključena iz primopredaje`}
                      />
                      <span className="tnums shrink-0 font-semibold text-ink">
                        {itemLabel(item)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-secondary">
                        {item.name || '—'}
                      </span>
                      <StatusBadge tone="neutral" label="Isključena" />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {printError && (
              <p className="text-sm text-status-danger" role="alert">
                {printError}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
