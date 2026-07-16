'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useBom, openDrawingPdf, type BomTreeNode } from '@/api/pdm';
import { formatNumber } from '@/lib/format';
import { AddToDraftButton } from './add-to-draft-dialog';

/** Korak uvlačenja po nivou dubine (px) — dinamička vrednost, inline style dozvoljen (§3). */
const INDENT_STEP = 16;

/** Skupi ključeve svih čvorova koji imaju decu (za "Skupi sve"). */
function collectExpandable(nodes: BomTreeNode[], prefix: string, acc: Set<string>): void {
  for (const n of nodes) {
    const key = `${prefix}/${n.componentId}`;
    if (n.children.length) {
      acc.add(key);
      collectExpandable(n.children, key, acc);
    }
  }
}

export function BomTree({ drawingId }: { drawingId: number }) {
  const q = useBom(drawingId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = q.data?.data.tree ?? [];
  const meta = q.data?.meta;

  const allExpandable = useMemo(() => {
    const s = new Set<string>();
    collectExpandable(tree, 'root', s);
    return s;
  }, [tree]);

  const allExpanded = collapsed.size === 0;
  const toggleAll = () => setCollapsed(allExpanded ? new Set(allExpandable) : new Set());
  const toggleNode = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (q.isLoading)
    return <span className="text-sm text-ink-disabled">Učitavanje sastavnice…</span>;
  if (q.error)
    return <span className="text-sm text-status-danger">Greška pri učitavanju sastavnice.</span>;
  if (!tree.length)
    return (
      <span className="text-sm text-ink-disabled">
        Crtež nema sastavnicu (nema direktnih komponenti).
      </span>
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <button
          type="button"
          onClick={toggleAll}
          disabled={allExpandable.size === 0}
          className="rounded-control border border-line px-2.5 py-1 font-medium text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
        >
          {allExpanded ? 'Skupi sve' : 'Proširi sve'}
        </button>
        <span className="tnums">{formatNumber(meta?.componentRows ?? 0)} stavki</span>
        {meta?.pdfSummary ? (
          <span
            className={cn(
              'tnums font-medium',
              meta.pdfSummary.withPdf < meta.pdfSummary.total
                ? 'text-status-warn'
                : 'text-status-success',
            )}
            title="Crteži sa uskladištenim PDF-om od ukupno postojećih u sastavnici"
          >
            Crteži sa PDF-om: {formatNumber(meta.pdfSummary.withPdf)}/
            {formatNumber(meta.pdfSummary.total)}
          </span>
        ) : null}
        {meta?.cyclesDetected ? (
          <StatusBadge tone="warn" label={`Ciklus: ${meta.cyclesDetected}`} />
        ) : null}
        {meta?.truncated ? <StatusBadge tone="warn" label="Skraćeno na dubini 20" /> : null}
        <span className="ml-auto flex items-center gap-3">
          <LegendDot className="bg-status-info" label="nabavni" />
          <LegendDot className="bg-status-danger" label="ne postoji" />
        </span>
      </div>

      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <div className="min-w-[36rem]">
          {tree.map((node) => (
            <BomRow
              key={`root/${node.componentId}`}
              node={node}
              nodeKey={`root/${node.componentId}`}
              collapsed={collapsed}
              onToggle={toggleNode}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function BomRow({
  node,
  nodeKey,
  collapsed,
  onToggle,
}: {
  node: BomTreeNode;
  nodeKey: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(nodeKey);
  const d = node.drawing;
  const missing = d == null;
  // Boja broja crteža: crveno = ciljni crtež ne postoji, plavo = nabavni deo.
  const numberColor = missing
    ? 'text-status-danger'
    : d.isProcurement
      ? 'text-status-info'
      : 'text-ink';

  // „Otvori PDF" (isti obrazac kao detalj crteža — apiBlob kroz JWT, novi tab).
  const [pdfOpening, setPdfOpening] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  const canOpenPdf = node.hasPdf && d != null;

  async function onOpenPdf() {
    if (!d) return;
    setPdfOpening(true);
    setPdfError(false);
    try {
      await openDrawingPdf(d.id);
    } catch {
      setPdfError(true);
    } finally {
      setPdfOpening(false);
    }
  }

  return (
    <>
      <div
        className="flex items-center gap-2 border-b border-line-soft py-1.5 pr-3 text-sm last:border-0"
        style={{ paddingLeft: `${(node.depth - 1) * INDENT_STEP + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(nodeKey)}
            aria-label={isCollapsed ? 'Proširi' : 'Skupi'}
            aria-expanded={!isCollapsed}
            className="shrink-0 rounded-control p-0.5 text-ink-disabled hover:bg-surface-2 hover:text-ink"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')}
              aria-hidden
            />
          </button>
        ) : (
          <span className="inline-block w-[1.375rem] shrink-0" aria-hidden />
        )}

        <span className={cn('tnums shrink-0 font-medium', numberColor)}>
          {d ? d.drawingNumber : `#${node.componentId}`}
        </span>
        {d?.revision && (
          <span className="tnums shrink-0 text-2xs text-ink-disabled">rev {d.revision}</span>
        )}
        <span className="truncate text-ink-secondary">
          {d?.name ?? 'crtež ne postoji'}
        </span>

        {missing && <StatusBadge tone="danger" label="ne postoji" />}
        {node.isCycle && <StatusBadge tone="warn" label="ciklus" />}
        {d?.isProcurement && <StatusBadge tone="info" label="nabavno" />}

        {/* PDF indikator (legacy kolona ima/nema) — samo za postojeći crtež. */}
        {!missing &&
          (node.hasPdf ? (
            <span
              className="shrink-0 rounded-full bg-status-success-bg px-1.5 py-0.5 text-2xs font-semibold text-status-success"
              title="Postoji uskladišten PDF crteža"
            >
              PDF
            </span>
          ) : (
            <span
              className="shrink-0 text-2xs text-ink-disabled"
              title="Nema uskladišten PDF crteža"
            >
              —
            </span>
          ))}

        <span className="ml-auto shrink-0 tnums text-ink">
          {formatNumber(node.requiredQuantity)} kom
        </span>
        <span
          className="shrink-0 tnums text-xs text-ink-disabled"
          title="Ukupno po jednom komadu korenskog sklopa"
        >
          Σ {formatNumber(node.totalQuantity)}
        </span>

        {canOpenPdf && (
          <button
            type="button"
            onClick={onOpenPdf}
            disabled={pdfOpening}
            title={pdfError ? 'Greška pri otvaranju PDF-a — pokušaj ponovo' : 'Otvori PDF crteža'}
            aria-label="Otvori PDF"
            className={cn(
              'inline-flex shrink-0 items-center rounded-control p-1 hover:bg-surface-2 disabled:opacity-40',
              pdfError ? 'text-status-danger' : 'text-ink-secondary hover:text-ink',
            )}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        {!missing && d && (
          <AddToDraftButton
            target={{ drawingId: d.id, drawingNumber: d.drawingNumber, name: d.name }}
            variant="compact"
          />
        )}
      </div>

      {hasChildren &&
        !isCollapsed &&
        node.children.map((c) => (
          <BomRow
            key={`${nodeKey}/${c.componentId}`}
            node={c}
            nodeKey={`${nodeKey}/${c.componentId}`}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-2 w-2 rounded-full', className)} aria-hidden />
      {label}
    </span>
  );
}
