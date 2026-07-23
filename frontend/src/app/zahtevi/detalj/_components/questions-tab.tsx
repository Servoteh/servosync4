'use client';

import { useEffect, useRef, useState } from 'react';
import { HelpCircle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useAddComment,
  useDecision,
  type ChangeRequestComment,
  type ChangeRequestDetail,
} from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';

/**
 * Tab „Pitanja" — komentari (admin ↔ podnosilac). Dopune u NEEDS_INFO idu ovuda
 * (§10.3: original se ne prepisuje).
 *
 * Admin „Pitanje podnosiocu": komentar se snima kao isQuestion=true (vizuelno
 * označen + banner podnosiocu), a status se prebacuje u NEEDS_INFO ODVOJENIM
 * pozivom (decision needs-info) SAMO kad je prelaz moguć (SUBMITTED/ANALYZED).
 * Kad prelaz nije moguć (npr. već NEEDS_INFO) → samo komentar, label „Označi kao
 * pitanje". Komentar više nikad sam ne menja status (BE revizija 23.07).
 *
 * `focusSignal` (iz banera „Odgovori") — svaka promena fokusira textarea.
 */
export function QuestionsTab({
  detail,
  isAdmin,
  focusSignal,
}: {
  detail: ChangeRequestDetail;
  isAdmin: boolean;
  focusSignal?: number;
}) {
  const [body, setBody] = useState('');
  const [isQuestion, setIsQuestion] = useState(false);
  const add = useAddComment();
  const decide = useDecision();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Prelaz u „Vraćen na dopunu" je moguć samo iz Podnet / AI obrađen.
  const canReturn = detail.status === 'SUBMITTED' || detail.status === 'ANALYZED';
  const busy = add.isPending || decide.isPending;

  // Baner „Odgovori" (owner, NEEDS_INFO) fokusira polje za odgovor.
  useEffect(() => {
    if (focusSignal && focusSignal > 0) {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusSignal]);

  async function submit() {
    const text = body.trim();
    if (!text) return;
    const asQuestion = isAdmin && isQuestion;
    try {
      await add.mutateAsync({ id: detail.id, body: text, isQuestion: asQuestion || undefined });
      // Pitanje adminu vraća zahtev na dopunu — ali samo kad je prelaz moguć.
      if (asQuestion && canReturn) {
        await decide.mutateAsync({
          id: detail.id,
          action: 'needs-info',
          note: 'Pitanja su u tabu „Pitanja".',
        });
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
