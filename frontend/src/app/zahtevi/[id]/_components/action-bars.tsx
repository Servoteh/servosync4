'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useSubmitZahtev,
  useWithdrawZahtev,
  useDeleteZahtev,
  useUpdateZahtev,
  useDecision,
  useSetRealizationStatus,
  useApproveAnalysis,
  useRestore,
  useRetriage,
  type ChangeRequestDetail,
  type DecisionAction,
  type RealizationAction,
} from '@/api/zahtevi';

/* ═══════════════════════════════════════════════════════════════ OWNER */

/**
 * Owner akcije po statusu (§1.3): submit (DRAFT/NEEDS_INFO), withdraw
 * (DRAFT/SUBMITTED/NEEDS_INFO), izmena sadržaja (SAMO DRAFT), brisanje nacrta
 * (SAMO DRAFT). Dopuna u NEEDS_INFO ide kroz tab „Pitanja" (komentar), ne ovde.
 */
export function OwnerActions({ detail }: { detail: ChangeRequestDetail }) {
  const router = useRouter();
  const submit = useSubmitZahtev();
  const withdraw = useWithdrawZahtev();
  const del = useDeleteZahtev();

  const [editOpen, setEditOpen] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canSubmit = detail.status === 'DRAFT' || detail.status === 'NEEDS_INFO';
  const canWithdraw = ['DRAFT', 'SUBMITTED', 'NEEDS_INFO'].includes(detail.status);
  const canEdit = detail.status === 'DRAFT';
  const canDelete = detail.status === 'DRAFT';

  if (!canSubmit && !canWithdraw && !canEdit && !canDelete) return null;

  return (
    <div className="flex flex-wrap gap-2 rounded-panel border border-line bg-surface p-3">
      {canSubmit && (
        <Button
          loading={submit.isPending}
          onClick={() =>
            submit.mutate(detail.id, {
              onSuccess: () => toast('Zahtev je podnet.'),
              onError: (e) => toast((e as Error).message),
            })
          }
        >
          {detail.status === 'NEEDS_INFO' ? 'Ponovo podnesi' : 'Podnesi'}
        </Button>
      )}
      {canEdit && (
        <Button variant="secondary" onClick={() => setEditOpen(true)}>
          Izmeni
        </Button>
      )}
      {canWithdraw && (
        <Button variant="ghost" onClick={() => setConfirmWithdraw(true)}>
          Povuci
        </Button>
      )}
      {canDelete && (
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Obriši nacrt
        </Button>
      )}

      {editOpen && (
        <EditDraftDialog detail={detail} onClose={() => setEditOpen(false)} />
      )}

      <ConfirmDialog
        open={confirmWithdraw}
        title="Povlačenje zahteva"
        message="Zahtev se arhivira i više neće biti u obradi. Nastaviti?"
        confirmLabel="Povuci"
        loading={withdraw.isPending}
        onCancel={() => setConfirmWithdraw(false)}
        onConfirm={() =>
          withdraw.mutate(detail.id, {
            onSuccess: () => {
              setConfirmWithdraw(false);
              toast('Zahtev je povučen.');
            },
            onError: (e) => toast((e as Error).message),
          })
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Brisanje nacrta"
        message="Nacrt se trajno briše. Ova radnja se ne može poništiti."
        confirmLabel="Obriši"
        danger
        loading={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          del.mutate(detail.id, {
            onSuccess: () => {
              toast('Nacrt je obrisan.');
              router.push('/zahtevi');
            },
            onError: (e) => toast((e as Error).message),
          })
        }
      />
    </div>
  );
}

/** Izmena sadržaja nacrta (title/description/expected/current) — SAMO DRAFT. */
function EditDraftDialog({
  detail,
  onClose,
}: {
  detail: ChangeRequestDetail;
  onClose: () => void;
}) {
  const update = useUpdateZahtev();
  const [title, setTitle] = useState(detail.title);
  const [description, setDescription] = useState(detail.description);
  const [expected, setExpected] = useState(detail.expectedBehavior ?? '');
  const [current, setCurrent] = useState(detail.currentBehavior ?? '');
  const [err, setErr] = useState<string | null>(null);

  function save() {
    setErr(null);
    if (!title.trim()) return setErr('Naslov ne može biti prazan.');
    if (!description.trim()) return setErr('Opis ne može biti prazan.');
    update.mutate(
      {
        id: detail.id,
        patch: {
          title: title.trim(),
          description: description.trim(),
          expectedBehavior: expected.trim() || null,
          currentBehavior: current.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast('Nacrt je izmenjen.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      size="lg"
      title="Izmena nacrta"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={update.isPending}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </FormField>
        <FormField label="Opis" required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} />
        </FormField>
        <FormField label="Očekivano ponašanje">
          <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} rows={2} />
        </FormField>
        <FormField label="Trenutno ponašanje">
          <Textarea value={current} onChange={(e) => setCurrent(e.target.value)} rows={2} />
        </FormField>
      </div>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════ ADMIN */

const DECISION_LABEL: Record<DecisionAction, string> = {
  approve: 'Odobri realizaciju',
  reject: 'Odbij',
  'needs-info': 'Vrati na dopunu',
  merge: 'Spoji',
  defer: 'U backlog',
  archive: 'Arhiviraj',
};

const REALIZATION_LABEL: Record<RealizationAction, string> = {
  planned: 'Planiraj',
  'in-progress': 'U realizaciju',
  'ready-for-test': 'Spremno za test',
  testing: 'Na testiranje',
  done: 'Završi',
};

/**
 * Dozvoljene admin presude po statusu (§1.3). „approve" iz SUBMITTED preskače
 * detaljnu analizu (dozvoljeno). Realizacioni prelazi idu kroz POST /status.
 */
function decisionsFor(status: string): DecisionAction[] {
  switch (status) {
    case 'SUBMITTED':
      return ['approve', 'needs-info', 'reject', 'merge', 'defer', 'archive'];
    case 'ANALYZED':
      return ['approve', 'needs-info', 'reject', 'merge', 'defer', 'archive'];
    case 'NEEDS_INFO':
      return ['archive'];
    case 'DEFERRED':
      return ['archive'];
    case 'MERGED':
    case 'DONE':
      return ['archive'];
    default:
      return [];
  }
}

function realizationsFor(status: string): RealizationAction[] {
  switch (status) {
    case 'APPROVED':
      return ['planned', 'in-progress'];
    case 'PLANNED':
      return ['in-progress'];
    case 'IN_PROGRESS':
      return ['ready-for-test'];
    case 'READY_FOR_TEST':
      return ['testing', 'done'];
    case 'TESTING':
      return ['done', 'in-progress'];
    default:
      return [];
  }
}

/**
 * Admin action-bar (§1.3): odluke (approve/reject/needs-info/merge/defer/archive)
 * kroz POST /decision + realizacioni prelazi kroz POST /status (sa link poljima
 * grana/PR/commit/verzija/izvršilac). Prazan kad status nema admin akcija.
 */
export function AdminActions({ detail }: { detail: ChangeRequestDetail }) {
  const [decision, setDecision] = useState<DecisionAction | null>(null);
  const [realization, setRealization] = useState<RealizationAction | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const approveAnalysis = useApproveAnalysis();
  const restore = useRestore();
  const retriage = useRetriage();

  const decisions = decisionsFor(detail.status);
  const realizations = realizationsFor(detail.status);

  // AI admin akcije (§8.4):
  //  - „Odobri AI analizu" (odobrenje #1) na SUBMITTED — pokreće detaljnu analizu.
  //  - „Ponovi trijažu" kad trijaža nije uspela (FAILED) ili je nema, a status je SUBMITTED.
  //  - „Vrati u obradu" (restore) na AI-odbačenom (REJECTED sa event AI_REJECTED).
  const hasDoneTriage = detail.analyses.some(
    (a) => a.kind === 'TRIAGE' && a.status === 'DONE',
  );
  const triageFailed = detail.analyses.some(
    (a) => a.kind === 'TRIAGE' && a.status === 'FAILED',
  );
  const canApproveAnalysis = detail.status === 'SUBMITTED';
  const canRetriage =
    detail.status === 'SUBMITTED' && (triageFailed || !hasDoneTriage);
  const wasAiRejected =
    detail.status === 'REJECTED' &&
    detail.events.some((e) => e.type === 'AI_REJECTED') &&
    detail.mergedIntoId == null;

  if (
    decisions.length === 0 &&
    realizations.length === 0 &&
    !canApproveAnalysis &&
    !canRetriage &&
    !wasAiRejected
  )
    return null;

  return (
    <div className="space-y-2 rounded-panel border border-accent/30 bg-accent-subtle p-3">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        Administracija
      </p>
      <div className="flex flex-wrap gap-2">
        {canApproveAnalysis && (
          <Button
            variant="primary"
            loading={approveAnalysis.isPending}
            onClick={() =>
              approveAnalysis.mutate(detail.id, {
                onSuccess: () => toast('AI analiza odobrena — analiza je pokrenuta.'),
                onError: (e) => toast((e as Error).message),
              })
            }
          >
            Odobri AI analizu
          </Button>
        )}
        {canRetriage && (
          <Button
            variant="secondary"
            loading={retriage.isPending}
            onClick={() =>
              retriage.mutate(detail.id, {
                onSuccess: () => toast('Trijaža pokrenuta.'),
                onError: (e) => toast((e as Error).message),
              })
            }
          >
            Ponovi trijažu
          </Button>
        )}
        {wasAiRejected && (
          <Button variant="secondary" onClick={() => setConfirmRestore(true)}>
            Vrati u obradu
          </Button>
        )}
        {decisions.map((a) => (
          <Button
            key={a}
            variant={a === 'approve' ? 'primary' : a === 'reject' ? 'danger' : 'secondary'}
            onClick={() => setDecision(a)}
          >
            {DECISION_LABEL[a]}
          </Button>
        ))}
        {realizations.map((a) => (
          <Button key={a} variant="secondary" onClick={() => setRealization(a)}>
            {REALIZATION_LABEL[a]}
          </Button>
        ))}
      </div>

      <ConfirmDialog
        open={confirmRestore}
        title="Vraćanje u obradu"
        message="AI je automatski odbio ovaj zahtev (ocena 0). Vraćanjem se vraća u status Podnet i admin ga ponovo procenjuje. Nastaviti?"
        confirmLabel="Vrati u obradu"
        loading={restore.isPending}
        onCancel={() => setConfirmRestore(false)}
        onConfirm={() =>
          restore.mutate(detail.id, {
            onSuccess: () => {
              setConfirmRestore(false);
              toast('Zahtev je vraćen u obradu.');
            },
            onError: (e) => toast((e as Error).message),
          })
        }
      />


      {decision && (
        <DecisionDialog
          detail={detail}
          action={decision}
          onClose={() => setDecision(null)}
        />
      )}
      {realization && (
        <RealizationDialog
          detail={detail}
          action={realization}
          onClose={() => setRealization(null)}
        />
      )}
    </div>
  );
}

/** Dijalog presude — napomena (opciono; obavezno za reject/needs-info) + merge cilj. */
function DecisionDialog({
  detail,
  action,
  onClose,
}: {
  detail: ChangeRequestDetail;
  action: DecisionAction;
  onClose: () => void;
}) {
  const decide = useDecision();
  const [note, setNote] = useState('');
  const [mergeIntoId, setMergeIntoId] = useState('');
  const [logDecision, setLogDecision] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const noteRequired = action === 'reject' || action === 'needs-info';
  const showLog = action === 'approve' || action === 'reject';

  function confirm() {
    setErr(null);
    if (noteRequired && !note.trim())
      return setErr('Napomena je obavezna za ovu odluku (podnosilac je vidi).');
    if (action === 'merge') {
      const target = Number(mergeIntoId);
      if (!Number.isInteger(target) || target <= 0)
        return setErr('Unesite ID kanonskog zahteva.');
      if (target === detail.id) return setErr('Zahtev se ne može spojiti sam sa sobom.');
    }
    decide.mutate(
      {
        id: detail.id,
        action,
        note: note.trim() || undefined,
        mergeIntoId: action === 'merge' ? Number(mergeIntoId) : undefined,
        logDecision: showLog ? logDecision : undefined,
      },
      {
        onSuccess: () => {
          toast('Odluka je zabeležena.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title={DECISION_LABEL[action]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant={action === 'reject' ? 'danger' : 'primary'} onClick={confirm} loading={decide.isPending}>
            Potvrdi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        {action === 'merge' && (
          <FormField label="ID kanonskog zahteva" required hint="Zahtev u koji se ovaj spaja (npr. 12).">
            <Input
              value={mergeIntoId}
              onChange={(e) => setMergeIntoId(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder="12"
            />
          </FormField>
        )}
        <FormField
          label="Napomena"
          required={noteRequired}
          hint={noteRequired ? 'Podnosilac vidi obrazloženje.' : 'Opciono.'}
        >
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </FormField>
        {showLog && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={logDecision}
              onChange={(e) => setLogDecision(e.target.checked)}
            />
            Zabeleži u Decision Log (stiže u F4)
          </label>
        )}
      </div>
    </Dialog>
  );
}

/** Dijalog realizacionog prelaza — opciona link polja (grana/PR/commit/verzija/izvršilac). */
function RealizationDialog({
  detail,
  action,
  onClose,
}: {
  detail: ChangeRequestDetail;
  action: RealizationAction;
  onClose: () => void;
}) {
  const setStatus = useSetRealizationStatus();
  const [branchName, setBranchName] = useState(detail.branchName ?? '');
  const [prUrl, setPrUrl] = useState(detail.prUrl ?? '');
  const [commitSha, setCommitSha] = useState(detail.commitSha ?? '');
  const [deliveredVersion, setDeliveredVersion] = useState(detail.deliveredVersion ?? '');
  const [implementedBy, setImplementedBy] = useState(detail.implementedBy ?? '');
  const [err, setErr] = useState<string | null>(null);

  function confirm() {
    setErr(null);
    setStatus.mutate(
      {
        id: detail.id,
        action,
        branchName: branchName.trim() || undefined,
        prUrl: prUrl.trim() || undefined,
        commitSha: commitSha.trim() || undefined,
        deliveredVersion: deliveredVersion.trim() || undefined,
        implementedBy: implementedBy.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast('Status ažuriran.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      size="lg"
      title={REALIZATION_LABEL[action]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={confirm} loading={setStatus.isPending}>
            Potvrdi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        <p className="text-2xs text-ink-secondary">
          Link polja su opciona — popunite ih kad su poznati (ručni unos u V1).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Grana">
            <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} maxLength={120} placeholder="feat/…" />
          </FormField>
          <FormField label="Verzija isporuke">
            <Input value={deliveredVersion} onChange={(e) => setDeliveredVersion(e.target.value)} maxLength={60} placeholder="main 2026-07-25" />
          </FormField>
          <FormField label="PR URL">
            <Input value={prUrl} onChange={(e) => setPrUrl(e.target.value)} maxLength={300} placeholder="https://…" />
          </FormField>
          <FormField label="Commit">
            <Input value={commitSha} onChange={(e) => setCommitSha(e.target.value)} maxLength={64} />
          </FormField>
          <FormField label="Izvršilac">
            <Input value={implementedBy} onChange={(e) => setImplementedBy(e.target.value)} maxLength={120} placeholder="Opus agent / Nenad" />
          </FormField>
        </div>
      </div>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════ shared */

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  loading,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Otkaži
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{message}</p>
    </Dialog>
  );
}
