'use client';

import { useEffect, useRef, useState } from 'react';
import { HelpCircle, MessageSquare, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { toast } from '@/lib/toast';
import {
  useAddComment,
  useReturnForInfo,
  useUploadAttachments,
  type ChangeRequestComment,
  type ChangeRequestDetail,
} from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';
import { AttachmentGrid } from './request-tab';

/** Maksimum priloga uz JEDNU poruku (BE broji po komentaru, ne po zahtevu). */
const MAX_PER_COMMENT = 10;

/**
 * Tab „Pitanja" — komentari (admin ↔ podnosilac). Dopune u NEEDS_INFO idu ovuda
 * (§10.3: original se ne prepisuje).
 *
 * Admin „Pitanje podnosiocu" kad je prelaz moguć (SUBMITTED/ANALYZED) ide ATOMSKI
 * kroz `return-for-info` (komentar isQuestion=true + prelaz NEEDS_INFO + mejl — jedan
 * poziv, bez krhkog dvokoraka). Kad prelaz NIJE moguć (npr. već NEEDS_INFO) → običan
 * komentar isQuestion=true, label „Označi kao pitanje".
 *
 * Zahtev 029/26: uz poruku se šalju i prilozi (slika ekrana, PDF, glasovna poruka).
 * Redosled je nužno dvokoračan — komentar prvo dobije `id`, pa se fajlovi kače na njega
 * (`POST /:id/attachments` sa `commentId`). Ako drugi korak padne, poruka OSTAJE poslata:
 * ne šaljemo je ponovo, nego nudimo ponovni pokušaj otpreme na taj isti komentar.
 *
 * `focusSignal` (iz banera „Odgovori") — svaka promena fokusira polje; `onFocusConsumed`
 * javlja roditelju da resetuje signal (da ručni povratak na tab ne fokusira ponovo).
 */
export function QuestionsTab({
  detail,
  isAdmin,
  focusSignal,
  onFocusConsumed,
}: {
  detail: ChangeRequestDetail;
  isAdmin: boolean;
  focusSignal?: number;
  onFocusConsumed?: () => void;
}) {
  const [body, setBody] = useState('');
  const [isQuestion, setIsQuestion] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  /** Dropzone je skriven dok se ne zatraži — poruka bez priloga ostaje jednopotezna. */
  const [showAttachments, setShowAttachments] = useState(false);
  /** Komentar je poslat, ali otprema priloga pala → ponovni pokušaj ide na OVAJ id. */
  const [retryCommentId, setRetryCommentId] = useState<number | null>(null);
  const add = useAddComment();
  const returnForInfo = useReturnForInfo();
  const upload = useUploadAttachments();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Prelaz u „Vraćen na dopunu" je moguć samo iz Podnet / AI obrađen.
  const canReturn = detail.status === 'SUBMITTED' || detail.status === 'ANALYZED';
  const busy = add.isPending || returnForInfo.isPending || upload.isPending;

  // Baner „Odgovori" (owner, NEEDS_INFO) fokusira polje za odgovor; posle fokusa
  // javljamo roditelju da resetuje signal (bez ponovnog fokusa na sledeći render).
  useEffect(() => {
    if (focusSignal && focusSignal > 0) {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onFocusConsumed?.();
    }
  }, [focusSignal, onFocusConsumed]);

  /** Drugi korak slanja: kači izabrane fajlove na već upisan komentar. */
  async function attachTo(commentId: number, sentMessage: string) {
    try {
      await upload.mutateAsync({ id: detail.id, files, commentId });
      setFiles([]);
      setShowAttachments(false);
      setRetryCommentId(null);
      toast(sentMessage);
    } catch (e) {
      // Poruka je POSLATA — ne ponavljamo je; nudimo ponovnu otpremu na isti komentar.
      setRetryCommentId(commentId);
      toast(`Poruka je poslata, ali prilozi nisu otpremljeni: ${(e as Error).message}`);
    }
  }

  async function submit() {
    if (busy) return; // re-entrancy: dupli klik ne šalje dvaput
    // Zaostala otprema posle pada — šaljemo SAMO fajlove, bez novog komentara.
    if (retryCommentId != null) {
      if (files.length === 0) {
        setRetryCommentId(null);
        return;
      }
      await attachTo(retryCommentId, 'Prilozi su dodati.');
      return;
    }
    const text = body.trim();
    if (!text) return;
    const asQuestion = isAdmin && isQuestion;
    const okMessage = asQuestion
      ? canReturn
        ? 'Pitanje poslato — zahtev vraćen podnosiocu na dopunu.'
        : 'Komentar označen kao pitanje.'
      : 'Komentar dodat.';
    try {
      let commentId: number | null = null;
      if (asQuestion && canReturn) {
        // Atomski: pitanje kao komentar + prelaz NEEDS_INFO + mejl (jedan poziv).
        const res = await returnForInfo.mutateAsync({ id: detail.id, questions: [text] });
        commentId = res.data.questionCommentIds?.[0] ?? null;
      } else {
        const res = await add.mutateAsync({
          id: detail.id,
          body: text,
          isQuestion: asQuestion || undefined,
        });
        commentId = res.data.id;
      }
      // Poruka je prošla — polje se prazni pre otpreme, da se ne pošalje dvaput.
      setBody('');
      setIsQuestion(false);
      if (files.length > 0 && commentId != null) await attachTo(commentId, okMessage);
      else if (files.length > 0)
        // Server nije vratio id poruke — fajlovi ostaju izabrani, ali korisnik mora da zna
        // da NISU otišli (tiho gubljenje priloga je gore od jasne poruke).
        toast('Poruka je poslata, ali prilozi nisu vezani za nju — pošaljite ih novom porukom.');
      else toast(okMessage);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const questionLabel = canReturn ? 'Pitanje podnosiocu (vraća na dopunu)' : 'Označi kao pitanje';
  const submitLabel =
    retryCommentId != null
      ? 'Otpremi prilog ponovo'
      : isAdmin && isQuestion
        ? canReturn
          ? 'Pošalji pitanje'
          : 'Označi kao pitanje'
        : 'Dodaj komentar';

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        {detail.comments.length === 0 ? (
          <p className="text-sm text-ink-secondary">Još nema pitanja ni komentara.</p>
        ) : (
          detail.comments.map((c) => <CommentRow key={c.id} c={c} />)
        )}
      </div>

      <div className="rounded-panel border border-line bg-surface p-4">
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          disabled={retryCommentId != null}
          placeholder={isAdmin ? 'Napišite komentar ili pitanje podnosiocu…' : 'Dodajte pojašnjenje ili odgovor…'}
        />

        {/* 029/26: prilog uz SAMU poruku — slika ekrana / PDF / glasovna poruka. */}
        {showAttachments ? (
          <div className="mt-3">
            <AttachmentInput
              value={files}
              onChange={setFiles}
              onReject={(m) => toast(m)}
              max={MAX_PER_COMMENT}
              disabled={upload.isPending}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAttachments(true)}
            className="mt-3 inline-flex items-center gap-2 text-sm text-accent hover:underline"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
            Dodaj prilog
          </button>
        )}

        {retryCommentId != null && (
          <p className="mt-3 rounded-control bg-status-warn-bg px-3 py-2 text-2xs text-ink">
            Poruka je poslata, ali prilozi nisu otpremljeni. Pokušajte otpremu ponovo —
            fajlovi se kače na tu istu poruku.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {isAdmin && retryCommentId == null && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={isQuestion}
                onChange={(e) => setIsQuestion(e.target.checked)}
              />
              {questionLabel}
            </label>
          )}
          <Button
            className="ml-auto"
            onClick={submit}
            loading={busy}
            disabled={retryCommentId != null ? files.length === 0 : !body.trim()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}

function CommentRow({ c }: { c: ChangeRequestComment }) {
  const Icon = c.isQuestion ? HelpCircle : MessageSquare;
  const author = c.authorName ?? `Korisnik #${c.authorUserId}`;
  const attachments = c.attachments ?? [];
  return (
    <div
      className={`rounded-panel border px-4 py-3 ${
        c.isQuestion ? 'border-status-warn/40 bg-status-warn-bg' : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-center gap-2 text-2xs text-ink-secondary">
        <Icon
          className={`h-3.5 w-3.5 ${c.isQuestion ? 'text-status-warn' : 'text-ink-secondary'}`}
          aria-hidden
        />
        <span>{author}</span>
        <span>·</span>
        <span>{formatDateTime(c.createdAt)}</span>
        {c.isQuestion && <span className="font-medium text-status-warn">Pitanje</span>}
        {attachments.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Paperclip className="h-3 w-3" aria-hidden />
            {attachments.length}
          </span>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{c.body}</p>
      {attachments.length > 0 && (
        <div className="mt-3">
          <AttachmentGrid requestId={c.requestId} attachments={attachments} compact />
        </div>
      )}
    </div>
  );
}
