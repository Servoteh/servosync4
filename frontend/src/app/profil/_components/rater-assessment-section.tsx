'use client';

import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import {
  useRaterInbox,
  useRaterAssessment,
  useSaveRaterScores,
  useSaveRaterAnswers,
  useSubmitRater,
  type RaterInboxRow,
} from '@/api/moj-profil';
import { Section } from './section';

/**
 * 360° — ekran OCENJIVAČA (kolega / rukovodilac).
 *
 * ⚠️ AUDIT-K6 (26.07): do sada je jedini način da kolega popuni procenu bio 1.0
 * `ocena.html?token=` — stranica koja u 3.0 ne postoji (svaka pozivnica je vodila
 * na 404, pa se kampanja tiho zaglavljivala: `invited_at` upisan, nijedna ocena
 * ne stigne). Taj tok se oslanja na `assessment_submit_by_token`, DEFINER funkciju
 * bez ikakve autentifikacije — ko dobije token, predaje ocenu u tuđe ime.
 * Kako su SVI ocenjivači (self/peer/leader) zaposleni sa nalogom, ovde je nativni
 * autentifikovani tok; token u mejlu više nije potreban.
 *
 * Ulaz: kartica u „Mom profilu" + deep-link iz pozivnice `/profil?ocena=<raterId>`.
 */

const KIND_LABEL: Record<string, string> = {
  peer: 'Kolega',
  leader: 'Rukovodilac',
  self: 'Samoprocena',
};

const LEVELS = [1, 2, 3, 4, 5];

export function RaterAssessmentSection({ openRaterId }: { openRaterId?: string | null }) {
  const inbox = useRaterInbox();
  const rows = inbox.data?.data ?? [];
  const [active, setActive] = useState<string | null>(null);

  // Deep-link iz mejla: otvori tačno tu procenu čim stigne inbox.
  useEffect(() => {
    if (openRaterId) setActive(openRaterId);
  }, [openRaterId]);

  const pending = rows.filter((r) => r.rater_status !== 'submitted');

  return (
    <Section title="360° procene koje ocenjujem" icon={<Users className="h-4 w-4" aria-hidden />}>
      {rows.length === 0 ? (
        <EmptyState title="Nemate zaduženja za ocenjivanje" />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.rater_id} className="flex flex-wrap items-center gap-2 rounded-control border border-line-soft p-2">
              <span className="font-medium text-ink">{r.employee_name || '—'}</span>
              <span className="text-2xs text-ink-secondary">
                {KIND_LABEL[r.rater_kind] ?? r.rater_kind}
                {r.period_label ? ` · ${r.period_label}` : ''}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {r.rater_status === 'submitted' ? (
                  <StatusBadge tone="success" label="Predato" />
                ) : (
                  <Button className="h-7 px-2 text-xs" onClick={() => setActive(r.rater_id)}>
                    Popuni ocenu
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="mt-2 text-2xs text-ink-secondary">
          Čeka vas {pending.length} nepopunjen{pending.length === 1 ? 'a procena' : 'ih procena'}.
        </p>
      )}
      {active && <RaterModal raterId={active} onClose={() => setActive(null)} onDone={() => void inbox.refetch()} />}
    </Section>
  );
}

function RaterModal({
  raterId,
  onClose,
  onDone,
}: {
  raterId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const q = useRaterAssessment(raterId);
  const saveScores = useSaveRaterScores();
  const saveAnswers = useSaveRaterAnswers();
  const submitM = useSubmitRater();
  const d = q.data?.data;

  const [scores, setScores] = useState<Map<number, { level: number | null; comment: string }>>(new Map());
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!d) return;
    const sm = new Map<number, { level: number | null; comment: string }>();
    for (const s of d.scores) sm.set(s.competence_id, { level: s.level, comment: s.comment ?? '' });
    setScores(sm);
    const am = new Map<string, string>();
    for (const a of d.answers) am.set(a.question_code, a.answer_text ?? '');
    setAnswers(am);
  }, [d]);

  /** Kompetencije iz opsega procene, grupisane (isti izvor kao samoprocena). */
  const groups = useMemo(() => {
    const byGroup = new Map<number, { id: number; name: string; comps: { id: number; name: string }[] }>();
    for (const s of d?.scope ?? []) {
      if (!byGroup.has(s.group_id)) byGroup.set(s.group_id, { id: s.group_id, name: s.group_name, comps: [] });
      byGroup.get(s.group_id)!.comps.push({ id: s.competence_id, name: s.competence_name });
    }
    return [...byGroup.values()];
  }, [d]);

  const unscored = useMemo(
    () => groups.flatMap((g) => g.comps).filter((c) => scores.get(c.id)?.level == null).length,
    [groups, scores],
  );

  function setLevel(compId: number, level: number) {
    setScores((m) => {
      const n = new Map(m);
      const cur = n.get(compId) ?? { level: null, comment: '' };
      // Ponovni klik na istu ocenu = poništi (dozvoljeno je ostaviti prazno).
      n.set(compId, { ...cur, level: cur.level === level ? null : level });
      return n;
    });
  }

  async function persist(): Promise<boolean> {
    setErr(null);
    try {
      await saveScores.mutateAsync({
        raterId,
        items: [...scores.entries()].map(([competenceId, v]) => ({
          competenceId,
          level: v.level,
          comment: v.comment || undefined,
        })),
      });
      if (answers.size)
        await saveAnswers.mutateAsync({
          raterId,
          items: [...answers.entries()].map(([questionCode, answerText]) => ({ questionCode, answerText })),
        });
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Čuvanje nije uspelo.');
      return false;
    }
  }

  async function onSave() {
    setMsg(null);
    if (await persist()) setMsg('Sačuvano — možete nastaviti kasnije.');
  }

  async function onSubmit() {
    setMsg(null);
    if (unscored > 0) {
      setErr(`Ostalo je ${unscored} neocenjenih kompetencija.`);
      return;
    }
    if (!(await persist())) return;
    try {
      await submitM.mutateAsync({ raterId });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Predaja nije uspela.');
    }
  }

  const busy = saveScores.isPending || saveAnswers.isPending || submitM.isPending;

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Zatvori
      </Button>
      <Button variant="secondary" onClick={onSave} loading={busy}>
        Sačuvaj
      </Button>
      <Button onClick={onSubmit} loading={busy}>
        Predaj ocenu
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`360° ocena — ${d?.assessment?.employee_name ?? ''}`}
      footer={footer}
    >
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : !d ? (
        <p className="text-sm text-status-danger">Procena nije dostupna.</p>
      ) : (
        <div className="space-y-4">
          {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
          {msg && <p className="rounded-control bg-status-success-bg px-2 py-1 text-sm text-status-success">{msg}</p>}
          <p className="text-2xs text-ink-secondary">
            Ocenjujete kao: <strong>{KIND_LABEL[d.raterKind] ?? d.raterKind}</strong>
            {d.assessment?.period_label ? ` · period ${d.assessment.period_label}` : ''}
          </p>

          {groups.map((g) => (
            <div key={g.id} className="rounded-control border border-line-soft p-3">
              <h4 className="mb-2 text-sm font-semibold text-ink">{g.name}</h4>
              <div className="space-y-3">
                {g.comps.map((c) => {
                  const cur = scores.get(c.id) ?? { level: null, comment: '' };
                  return (
                    <div key={c.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">{c.name}</span>
                        <span className="ml-auto flex gap-1">
                          {LEVELS.map((lv) => (
                            <button
                              key={lv}
                              type="button"
                              aria-label={`${c.name}: ocena ${lv}`}
                              aria-pressed={cur.level === lv}
                              onClick={() => setLevel(c.id, lv)}
                              className={`h-7 w-7 rounded-control border text-xs tabular-nums ${
                                cur.level === lv
                                  ? 'border-accent bg-accent text-on-accent'
                                  : 'border-line text-ink-secondary hover:border-accent'
                              }`}
                            >
                              {lv}
                            </button>
                          ))}
                        </span>
                      </div>
                      <Textarea
                        value={cur.comment}
                        onChange={(e) =>
                          setScores((m) => {
                            const n = new Map(m);
                            n.set(c.id, { ...(n.get(c.id) ?? { level: null, comment: '' }), comment: e.target.value });
                            return n;
                          })
                        }
                        maxLength={2000}
                        placeholder="Komentar (opciono)"
                        className="mt-1"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {d.questions.length > 0 && (
            <div className="rounded-control border border-line-soft p-3">
              <h4 className="mb-2 text-sm font-semibold text-ink">Pitanja</h4>
              <div className="space-y-3">
                {d.questions.map((qq) => (
                  <div key={qq.code}>
                    <p className="text-sm text-ink">{qq.text_sr}</p>
                    <Textarea
                      value={answers.get(qq.code) ?? ''}
                      onChange={(e) =>
                        setAnswers((m) => {
                          const n = new Map(m);
                          n.set(qq.code, e.target.value);
                          return n;
                        })
                      }
                      maxLength={4000}
                      className="mt-1"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {unscored > 0 && (
            <p className="text-2xs text-ink-secondary">
              Neocenjenih kompetencija: <strong className="tabular-nums">{unscored}</strong> — predaja traži da sve budu ocenjene.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

export type { RaterInboxRow };
