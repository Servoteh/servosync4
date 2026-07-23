'use client';

import { useEffect, useRef, useState } from 'react';
import { HelpCircle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useAddComment,
  useReturnForInfo,
  type ChangeRequestComment,
  type ChangeRequestDetail,
} from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';
import { AddAttachments, OWNER_ATTACH_STATUSES } from './request-tab';

/**
 * Tab „Pitanja" — komentari (admin ↔ podnosilac). Dopune u NEEDS_INFO idu ovuda
 * (§10.3: original se ne prepisuje).
 *
 * Admin „Pitanje podnosiocu" kad je prelaz moguć (SUBMITTED/ANALYZED) ide ATOMSKI
 * kroz `return-for-info` (komentar isQuestion=true + prelaz NEEDS_INFO + mejl — jedan
 * poziv, bez krhkog dvokoraka). Kad prelaz NIJE moguć (npr. već NEEDS_INFO) → običan
 * komentar isQuestion=true, label „Označi kao pitanje".
 *
 * `focusSignal` (iz banera „Odgovori") — svaka promena fokusira polje; `onFocusConsumed`
 * javlja roditelju da resetuje signal (da ručni povratak na tab ne fokusira ponovo).
 */
export function QuestionsTab({
  detail,
  isAdmin,
  isOwner = false,
  focusSignal,
  onFocusConsumed,
}: {
  detail: ChangeRequestDetail;
  isAdmin: boolean;
  isOwner?: boolean;
  focusSignal?: number;
  onFocusConsumed?: () => void;
}) {
  const [body, setBody] = useState('');
  const [isQuestion, setIsQuestion] = useState(false);
  const add = useAddComment();
  const returnForInfo = useReturnForInfo();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Prelaz u „Vraćen na dopunu" je moguć samo iz Podnet / AI obrađen.
  const canReturn = detail.status === 'SUBMITTED' || detail.status === 'ANALYZED';
  const busy = add.isPending || returnForInfo.isPending;

  // Baner „Odgovori" (owner, NEEDS_INFO) fokusira polje za odgovor; posle fokusa
  // javljamo roditelju da resetuje signal (bez ponovnog fokusa na sledeći render).
  useEffect(() => {
    if (focusSignal && focusSignal > 0) {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onFocusConsumed?.();
    }
  }, [focusSignal, onFocusConsumed]);

  async function submit() {
    if (busy) return; // re-entrancy: dupli klik ne šalje dvaput
    const text = body.trim();
    if (!text) return;
    const asQuestion = isAdmin && isQuestion;
    try {
      if (asQuestion && canReturn) {
        // Atomski: pitanje kao komentar + prelaz NEEDS_INFO + mejl (jedan poziv).
        await returnForInfo.mutateAsync({ id: detail.id, questions: [text] });
      } else {
        await add.mutateAsync({ id: detail.id, body: text, isQuestion: asQuestion || undefined });
      }
      setBody('');
      setIsQuestion(false);
      toast(
        asQuestion
          ? canReturn
            ? 'Pitanje poslato — zahtev vraćen podnosiocu na dopunu.'
            : 'Komentar označen kao pitanje.'
          : 'Komentar dodat.',
      );
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const questionLabel = canReturn ? 'Pitanje podnosiocu (vraća na dopunu)' : 'Označi kao pitanje';
  const submitLabel = isAdmin && isQuestion ? (canReturn ? 'Pošalji pitanje' : 'Označi kao pitanje') : 'Dodaj komentar';

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
          placeholder={isAdmin ? 'Napišite komentar ili pitanje podnosiocu…' : 'Dodajte pojašnjenje ili odgovor…'}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {isAdmin && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={isQuestion}
                onChange={(e) => setIsQuestion(e.target.checked)}
              />
              {questionLabel}
            </label>
          )}
          <Button className="ml-auto" onClick={submit} loading={busy} disabled={!body.trim()}>
            {submitLabel}
          </Button>
        </div>
      </div>

      {/* Odgovor na dopunu često traži i dokaz (slika ekrana, dokument) — prilozi
          dostupni i OVDE, ne samo u tabu „Zahtev" (primedba 23.07: „nema opcije"). */}
      {isOwner && OWNER_ATTACH_STATUSES.includes(detail.status) && (
        <AddAttachments requestId={detail.id} existing={detail.attachments.length} />
      )}
    </section>
  );
}

function CommentRow({ c }: { c: ChangeRequestComment }) {
  const Icon = c.isQuestion ? HelpCircle : MessageSquare;
  const author = c.authorName ?? `Korisnik #${c.authorUserId}`;
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
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{c.body}</p>
    </div>
  );
}
