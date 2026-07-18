'use client';

// Workflow dijalozi primopredaje (Odobri / Lansiraj / Vrati na čekanje) — deljeni
// između expand detalja (handover-detail.tsx) i taba „Odobrene" (approved-tab.tsx).
// Svaki dijalog sam drži svoju mutaciju; greška iz backenda se prikazuje unutra
// (dijalog ostaje otvoren dok akcija ne uspe).

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import {
  useApproveHandover,
  useApproveHandoverBatch,
  useLaunchHandover,
  useRejectHandoverBatch,
  useReturnHandoverToPending,
  useTechnologistsLookup,
  type Handover,
  type HandoverBatchResult,
  type LaunchedWorkOrderRef,
} from '@/api/handovers';
import type { WorkerRef } from '@/api/tech-processes';
import { openWorkOrderRnPdf } from '@/api/work-orders';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { ErrorText, LEGACY_TOOLTIP, Textarea, warnBox } from './common';

/**
 * „Grupni mod" za odobri/odbij CELE primopredaje (runda 2 t.4) — svi ID-jevi
 * PENDING pozicija istog broja nacrta + broj pozicija (za naslov/poruku).
 * Kad je prosleđen, dijalog gađa `approve-batch`/`reject-batch` umesto
 * pojedinačnog endpointa.
 */
export interface HandoverBatch {
  handoverIds: number[];
  count: number;
  draftNumber: string;
}

/** Spisak preskočenih pozicija iz batch odgovora (id + razlog) — warn box. */
function SkippedList({ skipped }: { skipped: HandoverBatchResult['skipped'] }) {
  if (!skipped.length) return null;
  return (
    <div className={warnBox}>
      <p className="font-medium">
        Preskočeno pozicija: <span className="tnums">{skipped.length}</span>
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {skipped.map((s) => (
          <li key={s.id}>
            <span className="tnums">#{s.id}</span> — {s.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

const cancelBtn =
  'rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Tooltip omotač za disabled potvrdno dugme legacy primopredaje — kit Button
 * ima `disabled:pointer-events-none`, pa `title` mora na roditeljski span.
 * Poslednja odbrana za stariji/otvoren dijalog: trigger dugmad su već disabled,
 * a backend 409 poruka je krajnja istina (prikaz kroz ErrorText/ApiError tok).
 */
function LegacyGuardSpan({ legacy, children }: { legacy: boolean; children: ReactNode }) {
  return (
    <span title={legacy ? LEGACY_TOOLTIP : undefined} className="inline-flex">
      {children}
    </span>
  );
}

/**
 * Odobravanje primopredaje (U OBRADI → SAGLASAN) — Miljan (šef tehnologije)
 * OBAVEZNO bira tehnologa koji piše TP; bez izbora dugme je disabled. Rok
 * izrade (P4 §6.5.1) je OPCION dok Miljan ne potvrdi obaveznost (§8 #8) —
 * upisuje se u primopredaju i propagira u RN pri kucanju TP-a/lansiranju.
 */
export function ApproveHandoverDialog({
  handover,
  open,
  onClose,
  batch,
}: {
  handover: Handover;
  open: boolean;
  onClose: () => void;
  /**
   * Grupni mod (runda 2 t.4) — kad je prosleđen, dijalog odobrava SVE PENDING
   * pozicije istog nacrta odjednom (approve-batch); bez njega je pojedinačno.
   */
  batch?: HandoverBatch;
}) {
  const approve = useApproveHandover();
  const approveBatch = useApproveHandoverBatch();
  const [technologist, setTechnologist] = useState<WorkerRef | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [comment, setComment] = useState('');
  const [urgent, setUrgent] = useState(false);
  // Rezultat batch-a (approved + skipped) — success ekran ostaje dok korisnik ne zatvori.
  const [result, setResult] = useState<HandoverBatchResult | null>(null);

  useEffect(() => {
    if (!open) return;
    approve.reset();
    approveBatch.reset();
    setTechnologist(null);
    setDueDate('');
    setComment('');
    setUrgent(false);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pending = approve.isPending || approveBatch.isPending;
  const error = batch ? approveBatch.error : approve.error;

  function submit() {
    if (!technologist) return;
    if (batch) {
      approveBatch.mutate(
        {
          handoverIds: batch.handoverIds,
          technologistId: technologist.id,
          dueDate: dueDate || undefined,
          comment: comment.trim() || undefined,
          isUrgent: urgent || undefined,
        },
        { onSuccess: (res) => setResult(res.data) },
      );
      return;
    }
    approve.mutate(
      {
        id: handover.id,
        technologistId: technologist.id,
        dueDate: dueDate || undefined,
        comment: comment.trim() || undefined,
        // Paket A t.10 — šalje se samo kad je štriklirano (hook izostavlja false).
        isUrgent: urgent || undefined,
      },
      { onSuccess: onClose },
    );
  }

  const title = batch
    ? `Odobri ceo nacrt ${batch.draftNumber} — ${batch.count} ${batch.count === 1 ? 'pozicija' : 'pozicija'}`
    : 'Odobravanje primopredaje';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        result ? (
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        ) : (
          <>
            <button onClick={onClose} className={cancelBtn}>
              Otkaži
            </button>
            <LegacyGuardSpan legacy={!batch && handover.isLegacy}>
              <Button
                onClick={submit}
                loading={pending}
                disabled={!technologist || (!batch && handover.isLegacy)}
              >
                {batch ? 'Odobri ceo nacrt' : 'Odobri'}
              </Button>
            </LegacyGuardSpan>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Odobreno <span className="tnums font-semibold">{result.approved}</span>{' '}
            {result.approved === 1 ? 'pozicija' : 'pozicija'}.
          </p>
          <SkippedList skipped={result.skipped} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-disabled">
            {batch ? (
              <>
                Sve pozicije nacrta{' '}
                <span className="tnums">{batch.draftNumber}</span> ({batch.count}) prelaze u status
                „Saglasan” i dodeljuju se izabranom tehnologu.
              </>
            ) : (
              <>
                Crtež{' '}
                <span className="tnums">
                  {handover.drawing
                    ? `${handover.drawing.drawingNumber} / ${handover.drawing.revision}`
                    : `#${handover.drawingId}`}
                </span>{' '}
                prelazi u status „Saglasan” i dodeljuje se tehnologu koji kuca TP.
              </>
            )}
          </p>
          <FormField label="Tehnolog" required hint="Piše tehnološki postupak (TP) za ovaj RN.">
            <ComboBox<WorkerRef>
              value={technologist}
              onChange={setTechnologist}
              useSearch={useTechnologistsLookup}
              getKey={(t) => t.id}
              getLabel={(t) => t.fullName ?? t.username}
              getSublabel={(t) => t.username}
              placeholder="Ime tehnologa…"
            />
          </FormField>
          <FormField
            label="Rok izrade"
            hint="Opciono — upisuje se u primopredaju i propagira u RN pri kucanju TP-a/lansiranju."
          >
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormField>
          {/* HITNO (Paket A t.10) — crveni bedž uz status svuda gde se primopredaja lista. */}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={urgent}
              onChange={(e) => setUrgent(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span className="font-medium text-status-danger">HITNO</span>
            <span className="text-xs text-ink-secondary">
              — primopredaja se svuda označava crvenim bedžom „HITNO”.
            </span>
          </label>
          <FormField label="Komentar">
            <Textarea
              value={comment}
              maxLength={250}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Npr. prioritetno — kupac čeka…"
            />
          </FormField>
          <ErrorText error={error} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Grupno ODBIJANJE cele primopredaje (runda 2 t.4) — sve PENDING pozicije istog
 * nacrta odjednom. Razlog je OBAVEZAN (mala textarea). Posle uspeha prikaže
 * „Odbijeno N pozicija" + spisak preskočenih.
 */
export function RejectAllHandoverDialog({
  batch,
  open,
  onClose,
}: {
  batch: HandoverBatch;
  open: boolean;
  onClose: () => void;
}) {
  const rejectBatch = useRejectHandoverBatch();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<HandoverBatchResult | null>(null);

  useEffect(() => {
    if (!open) return;
    rejectBatch.reset();
    setReason('');
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit() {
    if (!reason.trim()) return;
    rejectBatch.mutate(
      { handoverIds: batch.handoverIds, reason: reason.trim() },
      { onSuccess: (res) => setResult(res.data) },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Odbij ceo nacrt ${batch.draftNumber} — ${batch.count} pozicija`}
      footer={
        result ? (
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        ) : (
          <>
            <button onClick={onClose} className={cancelBtn}>
              Otkaži
            </button>
            <Button
              onClick={submit}
              loading={rejectBatch.isPending}
              disabled={!reason.trim()}
              className="bg-status-danger text-white hover:bg-status-danger"
            >
              Odbij ceo nacrt
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Odbijeno <span className="tnums font-semibold">{result.approved}</span>{' '}
            {result.approved === 1 ? 'pozicija' : 'pozicija'}.
          </p>
          <SkippedList skipped={result.skipped} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-disabled">
            Sve pozicije nacrta <span className="tnums">{batch.draftNumber}</span> ({batch.count})
            prelaze u status „Odbijeno”.
          </p>
          <FormField label="Razlog odbijanja" required hint="Obavezno — najviše 250 karaktera.">
            <Textarea
              value={reason}
              maxLength={250}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              placeholder="Npr. nacrt se menja — nova revizija crteža…"
            />
          </FormField>
          <ErrorText error={rejectBatch.error} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Lansiranje primopredaje (SAGLASAN → LANSIRAN). Posle uspeha se NE zatvara
 * odmah — success ekran nudi „Otvori RN” (deep-link na /work-orders?open=ID) i
 * „Štampaj RN” (isti RN PDF kao na Radnim nalozima). Invalidacija listi ide tek
 * pri zatvaranju, da red (i ovaj dijalog u njemu) ne nestane pre klika.
 */
export function LaunchHandoverDialog({
  handover,
  open,
  onClose,
}: {
  handover: Handover;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const launch = useLaunchHandover();
  const [dueDate, setDueDate] = useState('');
  const [comment, setComment] = useState('');
  const [launched, setLaunched] = useState<LaunchedWorkOrderRef | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    launch.reset();
    setDueDate('');
    setComment('');
    setLaunched(null);
    setPrintError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['handovers'] });
    qc.invalidateQueries({ queryKey: ['work-orders'] });
  }

  function close() {
    // Dok je mutacija u toku zatvaranje (Otkaži/Esc/overlay) se blokira —
    // inače uspešan launch prođe bez invalidacije (dijalog je unmount-ovan),
    // lista ostane stale i ponovni klik na „Lansiraj" vraća 409.
    if (launch.isPending) return;
    if (launched) invalidate();
    onClose();
  }

  function submit() {
    launch.mutate(
      { id: handover.id, dueDate: dueDate || undefined, comment: comment.trim() || undefined },
      { onSuccess: (res) => setLaunched(res.data.workOrder) },
    );
  }

  function openRn() {
    if (!launched) return;
    invalidate();
    router.push(`/work-orders?open=${launched.id}`);
  }

  async function onPrint() {
    if (!launched) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await openWorkOrderRnPdf(launched.id);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : 'Greška pri štampi radnog naloga.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Lansiranje primopredaje"
      footer={
        launched ? (
          <Button variant="secondary" onClick={close}>
            Zatvori
          </Button>
        ) : (
          <>
            <button onClick={close} disabled={launch.isPending} className={cancelBtn}>
              Otkaži
            </button>
            <LegacyGuardSpan legacy={handover.isLegacy}>
              <Button onClick={submit} loading={launch.isPending} disabled={handover.isLegacy}>
                Lansiraj RN
              </Button>
            </LegacyGuardSpan>
          </>
        )
      }
    >
      {launched ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            RN <span className="tnums font-semibold">{launched.identNumber}</span> je lansiran.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={openRn}>Otvori RN</Button>
            <Button variant="secondary" onClick={onPrint} loading={printing}>
              <Printer className="h-4 w-4" aria-hidden />
              Štampaj RN
            </Button>
          </div>
          {printError && (
            <p className="text-sm text-status-danger" role="alert">
              {printError}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-disabled">
            {handover.workOrder
              ? `RN ${handover.workOrder.identNumber} (otkucan TP) se lansira — novi nalog se ne kreira.`
              : 'Kreira se novi radni nalog iz podataka nacrta povezanog sa ovim crtežom.'}
          </p>
          <FormField label="Rok isporuke">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </FormField>
          <FormField label="Napomena">
            <Textarea
              value={comment}
              maxLength={250}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Npr. lansirano za sledeću smenu…"
            />
          </FormField>
          <ErrorText error={launch.error} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * „Vrati na čekanje” — undo odobravanja (SAGLASAN → U OBRADI, tehnolog se
 * razdužuje). Ako je RN već otkucan backend vraća 409 sa identNumber-om RN-a i
 * uputom da se RN prvo obriše/razreši — poruka se prikazuje u dijalogu.
 */
export function ReturnToPendingDialog({
  handover,
  open,
  onClose,
}: {
  handover: Handover;
  open: boolean;
  onClose: () => void;
}) {
  const returnToPending = useReturnHandoverToPending();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    returnToPending.reset();
    setReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit() {
    returnToPending.mutate(
      { id: handover.id, reason: reason.trim() || undefined },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Vraćanje na čekanje"
      footer={
        <>
          <button onClick={onClose} className={cancelBtn}>
            Otkaži
          </button>
          <LegacyGuardSpan legacy={handover.isLegacy}>
            <Button
              onClick={submit}
              loading={returnToPending.isPending}
              disabled={handover.isLegacy}
            >
              Vrati na čekanje
            </Button>
          </LegacyGuardSpan>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Primopredaja za crtež{' '}
          <span className="tnums font-semibold text-ink">
            {handover.drawing
              ? `${handover.drawing.drawingNumber} / ${handover.drawing.revision}`
              : `#${handover.drawingId}`}
          </span>{' '}
          se vraća iz „Saglasan” u „U obradi” i dodela tehnologa se poništava. Ako je RN već
          otkucan, prvo ga obrišite/razrešite na Radnim nalozima.
        </p>
        <FormField label="Razlog" hint="Opciono, najviše 250 karaktera — upisuje se u komentar statusa.">
          <Textarea
            value={reason}
            maxLength={250}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="Npr. pogrešno odobreno — menja se revizija crteža…"
          />
        </FormField>
        <ErrorText error={returnToPending.error} />
      </div>
    </Dialog>
  );
}
