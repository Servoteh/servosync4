'use client';

import { useState } from 'react';
import { HelpCircle, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { useAddComment, type ChangeRequestComment, type ChangeRequestDetail } from '@/api/zahtevi';
import { formatDateTime } from '@/lib/format';

/**
 * Tab „Pitanja" — komentari (admin ↔ podnosilac). Dopune u NEEDS_INFO idu ovuda
 * (§10.3: original se ne prepisuje). Admin sme da čekira „Pitanje podnosiocu"
 * (isQuestion → BE prebacuje zahtev u NEEDS_INFO ako je prelaz dozvoljen).
 */
export function QuestionsTab({
  detail,
  isAdmin,
}: {
  detail: ChangeRequestDetail;
  isAdmin: boolean;
}) {
  const [body, setBody] = useState('');
  const [isQuestion, setIsQuestion] = useState(false);
  const add = useAddComment();

  function submit() {
    const text = body.trim();
    if (!text) return;
    add.mutate(
      { id: detail.id, body: text, isQuestion: isAdmin ? isQuestion : undefined },
      {
        onSuccess: () => {
          setBody('');
          setIsQuestion(false);
          toast(isQuestion ? 'Pitanje poslato podnosiocu.' : 'Komentar dodat.');
        },
        onError: (e) => toast((e as Error).message),
      },
    );
  }

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
              Pitanje podnosiocu (vraća na dopunu)
            </label>
          )}
          <Button className="ml-auto" onClick={submit} loading={add.isPending} disabled={!body.trim()}>
            {isQuestion ? 'Pošalji pitanje' : 'Dodaj komentar'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function CommentRow({ c }: { c: ChangeRequestComment }) {
  const Icon = c.isQuestion ? HelpCircle : MessageSquare;
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
        <span className="tnums">Korisnik #{c.authorUserId}</span>
        <span>·</span>
        <span>{formatDateTime(c.createdAt)}</span>
        {c.isQuestion && <span className="font-medium text-status-warn">Pitanje</span>}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{c.body}</p>
    </div>
  );
}
