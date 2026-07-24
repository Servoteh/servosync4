'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles,
  AlertTriangle,
  Copy,
  Download,
  Pencil,
  RefreshCw,
  Loader2,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import {
  useRetriage,
  useApproveAnalysis,
  usePatchAnalysis,
  useReturnForInfo,
  type ChangeRequestAiAnalysis,
  type ChangeRequestDetail,
  type TriageResult,
  type AnalysisResult,
} from '@/api/zahtevi';

/**
 * Tab „AI analiza" (MODULE_SPEC_zahtevi §8.2) — trijažni sažetak + predlozi + duplikati
 * (linkovi) + ocena sa obrazloženjem; detaljna analiza (kartice); potrošnja tokena +
 * model; PENDING → spinner (polling je u page.tsx); FAILED → poruka + retry. Claude paket:
 * prikaz markdown-a + Kopiraj/Preuzmi + admin inline edit. „Prosledi pitanja podnosiocu".
 */
export function AiTab({
  detail,
  isAdmin,
}: {
  detail: ChangeRequestDetail;
  isAdmin: boolean;
}) {
  // Najnovija trijaža / detaljna (analyses su desc po createdAt iz BE include-a).
  const triage = detail.analyses.find((a) => a.kind === 'TRIAGE') ?? null;
  const detailed = detail.analyses.find((a) => a.kind === 'DETAILED') ?? null;

  if (detail.analyses.length === 0) {
    return (
      <section className="space-y-4">
        <div className="rounded-panel border border-line bg-surface p-5 text-sm text-ink-secondary">
          AI trijaža još nije pokrenuta. Trijaža se pokreće automatski pri podnošenju.
        </div>
        {isAdmin && detail.status === 'SUBMITTED' && (
          <RetriageButton id={detail.id} label="Pokreni trijažu" />
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {triage && <TriageCard detail={detail} triage={triage} isAdmin={isAdmin} />}
      {detailed && <DetailedCard detail={detail} analysis={detailed} isAdmin={isAdmin} />}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════ TRIJAŽA */

function TriageCard({
  detail,
  triage,
  isAdmin,
}: {
  detail: ChangeRequestDetail;
  triage: ChangeRequestAiAnalysis;
  isAdmin: boolean;
}) {
  const result = (triage.result ?? null) as TriageResult | null;

  return (
    <div className="rounded-panel border border-line bg-surface p-5">
      <SectionHeader
        icon={<Sparkles className="h-4 w-4 text-status-info" aria-hidden />}
        title="AI trijaža"
        analysis={triage}
      />

      {triage.status === 'PENDING' && <PendingRow label="Trijaža u toku…" />}

      {triage.status === 'FAILED' && (
        <FailedRow
          errorCode={triage.errorCode}
          action={isAdmin ? <RetriageButton id={detail.id} label="Ponovi trijažu" /> : null}
        />
      )}

      {triage.status === 'DONE' && result && (
        <div className="mt-3 space-y-4">
          {result.summary && (
            <p className="whitespace-pre-wrap text-sm text-ink">{result.summary}</p>
          )}

          {/* Ocena + obrazloženje — SAMO admin (tihi režim 24.07: korisnik ne vidi ocenu/scoreReason;
              obrazloženje odbijanja mu se prikazuje u headeru na REJECTED). */}
          {isAdmin && result.score != null && (
            <div className="rounded-control bg-surface-2 px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                AI ocena
              </p>
              <p className="mt-1 text-sm text-ink">
                <span className="tnums font-semibold">{result.score}★</span>
                {result.scoreReason ? ` — ${result.scoreReason}` : ''}
              </p>
            </div>
          )}

          {/* Predlozi klasifikacije. */}
          <div className="flex flex-wrap gap-2">
            {result.module && <Chip label={`Modul: ${result.module}`} />}
            {result.kind && <Chip label={`Tip: ${result.kind}`} />}
            {result.priorityProposal && <Chip label={`Prioritet: ${result.priorityProposal}`} />}
            {result.areas?.map((a) => <Chip key={a} label={a} />)}
          </div>

          {/* Duplikati sa linkovima. */}
          {result.duplicates?.length > 0 && (
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                Mogući duplikati
              </p>
              <ul className="mt-1 space-y-1">
                {result.duplicates.map((d) => (
                  <li key={d.requestId} className="text-sm text-ink">
                    <Link
                      href={`/zahtevi/detalj?id=${d.requestId}`}
                      className="text-accent hover:underline"
                    >
                      Zahtev #{d.requestId}
                    </Link>{' '}
                    <span className="text-2xs text-ink-secondary">
                      ({d.confidence === 'HIGH' ? 'visoka' : 'srednja'} pouzdanost)
                    </span>{' '}
                    — {d.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Nejasnoće / pitanja. */}
          {result.questions?.length > 0 && (
            <OpenQuestions
              detail={detail}
              questions={result.questions}
              isAdmin={isAdmin}
              heading="Nejasnoće iz trijaže"
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ DETALJNA */

function DetailedCard({
  detail,
  analysis,
  isAdmin,
}: {
  detail: ChangeRequestDetail;
  analysis: ChangeRequestAiAnalysis;
  isAdmin: boolean;
}) {
  const result = (analysis.result ?? null) as AnalysisResult | null;

  return (
    <div className="rounded-panel border border-line bg-surface p-5">
      <SectionHeader
        icon={<Sparkles className="h-4 w-4 text-accent" aria-hidden />}
        title="Detaljna AI analiza"
        analysis={analysis}
      />

      {analysis.status === 'PENDING' && <PendingRow label="Detaljna analiza u toku…" />}

      {analysis.status === 'FAILED' && (
        <FailedRow
          errorCode={analysis.errorCode}
          action={
            isAdmin ? (
              <ApproveAnalysisButton id={detail.id} label="Pokušaj ponovo" />
            ) : null
          }
        />
      )}

      {analysis.status === 'DONE' && result && (
        <div className="mt-3 space-y-4">
          <AnalysisBlock title="Razumevanje" text={result.understanding} />
          {result.affectedModules?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {result.affectedModules.map((m) => <Chip key={m} label={m} />)}
            </div>
          )}
          <AnalysisBlock title="Uticaj" text={result.impact} />
          <AnalysisList title="Rizici" items={result.risks} tone="warn" />
          <AnalysisList title="Konflikti" items={result.conflicts} tone="warn" />
          <AnalysisList title="Acceptance kriterijumi" items={result.acceptanceCriteria} />
          <AnalysisList title="Test scenariji" items={result.testScenarios} ordered />

          <div className="flex flex-wrap gap-2">
            {result.estimate && <Chip label={`Procena: ${result.estimate}`} />}
            {result.priorityProposal && (
              <Chip label={`Predlog prioriteta: ${result.priorityProposal}`} />
            )}
          </div>

          {result.openQuestions?.length > 0 && (
            <OpenQuestions
              detail={detail}
              questions={result.openQuestions}
              isAdmin={isAdmin}
              heading="Otvorena pitanja"
            />
          )}

          {/* Claude paket. */}
          <ClaudePackage detail={detail} analysis={analysis} isAdmin={isAdmin} />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ CLAUDE PAKET */

function ClaudePackage({
  detail,
  analysis,
  isAdmin,
}: {
  detail: ChangeRequestDetail;
  analysis: ChangeRequestAiAnalysis;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const pkg = analysis.claudePackage ?? '';

  function copy() {
    void navigator.clipboard
      .writeText(pkg)
      .then(() => toast('Claude paket kopiran.'))
      .catch(() => toast('Kopiranje nije uspelo.'));
  }

  function download() {
    const blob = new Blob([pkg], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zahtev-${detail.reqNo.replace('/', '-')}-claude-paket.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!pkg && !isAdmin) return null;

  return (
    <div className="rounded-panel border border-accent/30 bg-accent-subtle p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Claude paket
        </p>
        <div className="flex flex-wrap gap-2">
          {pkg && (
            <>
              <Button variant="secondary" onClick={copy}>
                <Copy className="h-4 w-4" aria-hidden />
                Kopiraj
              </Button>
              <Button variant="secondary" onClick={download}>
                <Download className="h-4 w-4" aria-hidden />
                Preuzmi .md
              </Button>
            </>
          )}
          {isAdmin && (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden />
              Izmeni
            </Button>
          )}
        </div>
      </div>
      {pkg ? (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-control bg-surface px-3 py-2 text-2xs text-ink">
          {pkg}
        </pre>
      ) : (
        <p className="mt-2 text-2xs text-ink-secondary">Paket nije generisan.</p>
      )}
      {editing && (
        <EditPackageDialog
          id={detail.id}
          analysisId={analysis.id}
          initial={pkg}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function EditPackageDialog({
  id,
  analysisId,
  initial,
  onClose,
}: {
  id: number;
  analysisId: number;
  initial: string;
  onClose: () => void;
}) {
  const patch = usePatchAnalysis();
  const [text, setText] = useState(initial);

  function save() {
    patch.mutate(
      { id, analysisId, claudePackage: text },
      {
        onSuccess: () => {
          toast('Claude paket sačuvan.');
          onClose();
        },
        onError: (e) => toast((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      size="lg"
      title="Izmena Claude paketa"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={patch.isPending}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} />
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════ OTVORENA PITANJA */

/**
 * Prikaz nejasnoća/pitanja + admin akcija „Prosledi podnosiocu": kreira komentare
 * isQuestion=true i vrati zahtev u NEEDS_INFO (POST decision needs-info). Jedan klik
 * uz potvrdu (§8.3). Ne-admin samo vidi listu.
 */
function OpenQuestions({
  detail,
  questions,
  isAdmin,
  heading,
}: {
  detail: ChangeRequestDetail;
  questions: string[];
  isAdmin: boolean;
  heading: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const returnForInfo = useReturnForInfo();
  const canForward =
    isAdmin && (detail.status === 'SUBMITTED' || detail.status === 'ANALYZED');

  async function forward() {
    // Re-entrancy: dupli klik ne sme dvaput POST-ovati SVA pitanja.
    if (returnForInfo.isPending) return;
    try {
      // JEDAN atomski poziv: sva pitanja (isQuestion:true) + prelaz NEEDS_INFO + mejl.
      // Bez note (decisionNote ostaje null) — pitanja žive kao komentari (23.07 review).
      await returnForInfo.mutateAsync({ id: detail.id, questions });
      toast('Pitanja prosleđena podnosiocu (zahtev vraćen na dopunu).');
      setConfirm(false);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {heading}
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {questions.map((q, i) => (
          <li key={i} className="text-sm text-ink">
            {q}
          </li>
        ))}
      </ul>
      {canForward && (
        <Button variant="secondary" className="mt-2" onClick={() => setConfirm(true)}>
          <Send className="h-4 w-4" aria-hidden />
          Prosledi pitanja podnosiocu
        </Button>
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(false)}
          title="Prosleđivanje pitanja"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Otkaži
              </Button>
              <Button
                onClick={() => void forward()}
                loading={returnForInfo.isPending}
              >
                Prosledi
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink">
            Pitanja se dodaju kao komentari i zahtev se vraća podnosiocu na dopunu
            (status „Vraćen na dopunu"). Nastaviti?
          </p>
        </Dialog>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ helperi */

function RetriageButton({ id, label }: { id: number; label: string }) {
  const retriage = useRetriage();
  return (
    <Button
      variant="secondary"
      loading={retriage.isPending}
      onClick={() =>
        retriage.mutate(id, {
          onSuccess: () => toast('Trijaža pokrenuta.'),
          onError: (e) => toast((e as Error).message),
        })
      }
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}

function ApproveAnalysisButton({ id, label }: { id: number; label: string }) {
  const approve = useApproveAnalysis();
  return (
    <Button
      variant="secondary"
      loading={approve.isPending}
      onClick={() =>
        approve.mutate(id, {
          onSuccess: () => toast('Analiza pokrenuta.'),
          onError: (e) => toast((e as Error).message),
        })
      }
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}

function SectionHeader({
  icon,
  title,
  analysis,
}: {
  icon: React.ReactNode;
  title: string;
  analysis: ChangeRequestAiAnalysis;
}) {
  const tokens =
    analysis.tokensIn != null || analysis.tokensOut != null
      ? `${analysis.tokensIn ?? 0}→${analysis.tokensOut ?? 0} tok`
      : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-md font-semibold text-ink">{title}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-secondary">
        {analysis.model && <span className="tnums">{analysis.model}</span>}
        {tokens && <span className="tnums">· {tokens}</span>}
        {analysis.finishedAt && <span>· {formatDateTime(analysis.finishedAt)}</span>}
      </div>
    </div>
  );
}

function PendingRow({ label }: { label: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-ink-secondary">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

function FailedRow({
  errorCode,
  action,
}: {
  errorCode: string | null;
  action: React.ReactNode;
}) {
  const msg =
    errorCode === 'not_configured'
      ? 'AI nije konfigurisan na serveru (nedostaje API ključ). Zahtev radi normalno; trijaža/analiza se može ponoviti kad se ključ postavi.'
      : `AI korak nije uspeo (${errorCode ?? 'greška'}).`;
  return (
    <div className="mt-3 space-y-2 rounded-control bg-status-danger-bg px-3 py-2">
      <div className="flex items-start gap-2 text-sm text-status-danger">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{msg}</span>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

function AnalysisBlock({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {title}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{text}</p>
    </div>
  );
}

function AnalysisList({
  title,
  items,
  ordered,
  tone,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  tone?: 'warn';
}) {
  if (!items || items.length === 0) return null;
  const List = ordered ? 'ol' : 'ul';
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {title}
      </p>
      <List className={`mt-1 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
        {items.map((it, i) => (
          <li
            key={i}
            className={`text-sm ${tone === 'warn' ? 'text-status-warn' : 'text-ink'}`}
          >
            {it}
          </li>
        ))}
      </List>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">
      {label}
    </span>
  );
}
