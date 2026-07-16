'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, FileText, PenLine, Check, Save } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import {
  useSelfAssessment,
  useSaveSelfScores,
  useSaveSelfAnswers,
  useSubmitSelfAssessment,
  type SelfAssessmentData,
  type AssessmentScopeRow,
  type FrameworkGroup,
  type CompetenceQuestion,
} from '@/api/moj-profil';
import { Radar, RADAR_COLORS, type RadarSeries } from '@/app/kadrovska/_components/razvoj/radar';
import { exportAssessmentPdf } from '@/lib/hr-pdf';
import { Section } from './section';
import { WideModal } from '@/app/kadrovska/_components/razvoj/shared';

/**
 * Moj profil → Samoprocena kompetencija (360°) — P4-FE (paritet 1.0
 * src/ui/mojProfil/myAssessment.js). Zaposleni ocenjuje sebe po kompetencijama
 * svoje pozicije (skala 0–5 sa deskriptorom nivoa), upisuje odgovore na otvorena
 * pitanja, vidi svoj radar uživo, čuva (bulk scores+answers) i podnosi. Kad
 * rukovodilac podeli 360° rezultat (visibleToEmployee), prikazuje se uporedni
 * radar (Samoprocena/Kolege/Rukovodilac/Cilj) + tabela proseka po grupi.
 *
 * Editovanje samo dok je status collecting/draft; posle je prikaz read-only.
 * Radar = reuse kadrovska `_components/razvoj/radar.tsx` (isti SVG, CSP-safe).
 */

const SCOPE_BADGE: Record<string, { bg: string; t: string }> = {
  core: { bg: '#0891b2', t: 'OSNOVNO' },
  strucna: { bg: '#2563eb', t: 'STRUČNO' },
  liderska: { bg: '#7c3aed', t: 'LIDERSTVO' },
};

interface Group {
  id: number;
  name: string;
  scope: string;
  comps: { id: number; name: string }[];
}

export function AssessmentSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section icon={<BarChart3 className="h-4 w-4 text-ink-secondary" />} title="Samoprocena kompetencija (360°)">
      <p className="mb-3 text-sm text-ink-secondary">
        Oceni sebe po kompetencijama svoje pozicije (skala 0–5). Kolega iz tima i rukovodilac ocenjuju zasebno i anonimno.
        Svoj uporedni rezultat (radar) vidiš kada ga rukovodilac podeli posle razgovora.
      </p>
      <Button onClick={() => setOpen(true)} title="Samoprocena po kompetencijama">
        <BarChart3 className="h-4 w-4" aria-hidden /> Otvori samoprocenu
      </Button>
      {open && <AssessmentModal onClose={() => setOpen(false)} />}
    </Section>
  );
}

function AssessmentModal({ onClose }: { onClose: () => void }) {
  const q = useSelfAssessment(undefined, true);
  const data = q.data?.data ?? null;

  return (
    <WideModal open onClose={onClose} maxWidth="980px" title="Moja procena kompetencija">
      {q.isLoading ? (
        <p className="py-8 text-center text-ink-secondary">Otvaram procenu…</p>
      ) : q.isError ? (
        <ErrMsg msg="Greška pri učitavanju procene." />
      ) : !data || !data.assessmentId ? (
        <ErrMsg msg="Vaš zaposlenički profil ili pozicija nisu povezani — obratite se HR-u." />
      ) : data.scope.length === 0 ? (
        <ErrMsg msg="Vaša pozicija još nema definisan profil kompetencija — obratite se HR-u." />
      ) : (
        <AssessmentForm data={data} onClose={onClose} />
      )}
    </WideModal>
  );
}

function ErrMsg({ msg }: { msg: string }) {
  return <p className="py-8 text-center text-status-warn">{msg}</p>;
}

function AssessmentForm({ data, onClose }: { data: SelfAssessmentData; onClose: () => void }) {
  const saveScoresM = useSaveSelfScores();
  const saveAnswersM = useSaveSelfAnswers();
  const submitM = useSubmitSelfAssessment();

  const raterId = data.selfRater?.id ?? '';
  const status = data.assessment?.status ?? 'collecting';
  const canEdit = status === 'collecting' || status === 'draft';
  const submitted = data.selfRater?.status === 'submitted';
  const visible = !!data.visibleToEmployee;

  // Grupisanje scope-a po grupi (redosled po group_sort).
  const groups = useMemo<Group[]>(() => {
    const map = new Map<number, Group>();
    const order: number[] = [];
    for (const r of data.scope) {
      if (!map.has(r.group_id)) {
        map.set(r.group_id, { id: r.group_id, name: r.group_name, scope: r.scope, comps: [] });
        order.push(r.group_id);
      }
      map.get(r.group_id)!.comps.push({ id: r.competence_id, name: r.competence_name });
    }
    return order
      .map((id) => map.get(id)!)
      .sort((a, b) => sortOf(data.scope, a.id) - sortOf(data.scope, b.id));
  }, [data.scope]);

  // Nivoi po kompetenciji (deskriptor iz frameworka) za live tekst.
  const levelsByComp = useMemo(() => {
    const m = new Map<number, { level: number; descriptor: string }[]>();
    for (const g of data.framework) for (const c of g.competences) m.set(c.id, c.levels);
    return m;
  }, [data.framework]);

  // Otvorena pitanja: opšta (group_id=null) + grupna u opsegu.
  const groupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups]);
  const questions = useMemo(() => {
    const gen = data.questions.filter((qq) => qq.group_id == null);
    const grp = data.questions.filter((qq) => qq.group_id != null && groupIds.has(qq.group_id));
    return [...gen, ...grp];
  }, [data.questions, groupIds]);

  // Lokalno stanje ocena/komentara/odgovora (seed iz servera jednom).
  const [scores, setScores] = useState<Map<number, { level: number | null; comment: string }>>(new Map());
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    const sm = new Map<number, { level: number | null; comment: string }>();
    for (const s of data.scores) sm.set(s.competence_id, { level: s.level, comment: s.comment ?? '' });
    const am = new Map<string, string>();
    for (const a of data.answers) am.set(a.question_code, a.answer_text ?? '');
    setScores(sm);
    setAnswers(am);
    seeded.current = true;
  }, [data.scores, data.answers]);

  function setLevel(compId: number, level: number | null) {
    setScores((prev) => {
      const n = new Map(prev);
      const cur = n.get(compId) ?? { level: null, comment: '' };
      n.set(compId, { ...cur, level });
      return n;
    });
  }
  function setComment(compId: number, comment: string) {
    setScores((prev) => {
      const n = new Map(prev);
      const cur = n.get(compId) ?? { level: null, comment: '' };
      n.set(compId, { ...cur, comment });
      return n;
    });
  }

  // Live radar samoprocene po grupama (prosek nivoa po grupi).
  const selfRadar = useMemo<{ labels: string[]; datasets: RadarSeries[] }>(() => {
    const labels = groups.map((g) => g.name);
    const data0 = groups.map((g) => {
      const vals = g.comps.map((c) => scores.get(c.id)?.level).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
    });
    return { labels, datasets: [{ label: 'Samoprocena', color: RADAR_COLORS.self, data: data0 }] };
  }, [groups, scores]);

  // Podeljeni 360° rezultat (radar + tabela po grupi) iz assessment_results.
  const resByGroup = useMemo(() => {
    const m = new Map<number, { self: number | null; peer: number | null; leader: number | null; target: number | null }>();
    for (const r of data.results)
      if (r.scope_kind === 'group')
        m.set(r.ref_id, {
          self: num(r.self_avg),
          peer: num(r.peer_avg),
          leader: num(r.leader_val),
          target: num(r.target_val),
        });
    return m;
  }, [data.results]);
  const showShared = visible && data.results.length > 0;
  const sharedRadar = useMemo<{ labels: string[]; datasets: RadarSeries[] }>(() => {
    const labels = groups.map((g) => g.name);
    return {
      labels,
      datasets: [
        { label: 'Samoprocena', color: RADAR_COLORS.self, data: groups.map((g) => resByGroup.get(g.id)?.self ?? null) },
        { label: 'Kolege', color: RADAR_COLORS.peer, data: groups.map((g) => resByGroup.get(g.id)?.peer ?? null) },
        { label: 'Rukovodilac', color: RADAR_COLORS.leader, data: groups.map((g) => resByGroup.get(g.id)?.leader ?? null) },
        { label: 'Cilj', color: RADAR_COLORS.target, data: groups.map((g) => resByGroup.get(g.id)?.target ?? null) },
      ],
    };
  }, [groups, resByGroup]);

  const [busy, setBusy] = useState(false);

  async function persist(submit: boolean) {
    if (!raterId) {
      toast('Ocenjivač nije pronađen');
      return;
    }
    setBusy(true);
    try {
      const scoreItems = [...scores.entries()].map(([competenceId, v]) => ({
        competenceId,
        level: v.level,
        comment: v.comment || undefined,
      }));
      if (scoreItems.length) await saveScoresM.mutateAsync({ raterId, items: scoreItems });
      const answerItems = [...answers.entries()].map(([questionCode, answerText]) => ({
        questionCode,
        answerText: answerText || undefined,
      }));
      await saveAnswersM.mutateAsync({ raterId, items: answerItems });
      if (submit) {
        await submitM.mutateAsync({ assessmentId: data.assessmentId! });
        toast('Procena podneta — hvala!');
        onClose();
      } else {
        toast('Sačuvano');
      }
    } catch {
      toast(submit ? 'Podnošenje nije uspelo' : 'Snimanje nije uspelo');
    } finally {
      setBusy(false);
    }
  }

  async function doPdf() {
    setBusy(true);
    try {
      const num1 = (v: unknown) => (v == null ? null : Number(v));
      const groupsPdf = groups.map((g) => {
        const r = resByGroup.get(g.id);
        return { groupName: g.name, scope: g.scope, self: num1(r?.self), peer: num1(r?.peer), leader: num1(r?.leader), target: num1(r?.target) };
      });
      // Rezultati po kompetenciji (za detaljnu tabelu u PDF-u).
      const cRes = new Map<number, { self: number | null; peer: number | null; leader: number | null; target: number | null }>();
      for (const r of data.results)
        if (r.scope_kind === 'competence') cRes.set(r.ref_id, { self: num(r.self_avg), peer: num(r.peer_avg), leader: num(r.leader_val), target: num(r.target_val) });
      const compsPdf: { groupName: string; competenceName: string; self: number | null; peer: number | null; leader: number | null; target: number | null }[] = [];
      for (const g of groups) for (const c of g.comps) { const x = cRes.get(c.id); compsPdf.push({ groupName: g.name, competenceName: c.name, self: x?.self ?? null, peer: x?.peer ?? null, leader: x?.leader ?? null, target: x?.target ?? null }); }
      await exportAssessmentPdf({ employeeName: '', period: data.assessment?.periodLabel || '', groups: groupsPdf, competences: compsPdf });
    } catch (e) {
      toast('PDF nije uspeo: ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        {canEdit ? (
          <>
            Oceni sebe na skali <b>0–5</b> za svaku kompetenciju. Klikni broj — opis nivoa se prikazuje ispod. Ovo je{' '}
            <b>samoprocena</b>; tvoje ocene vidiš samo ti. „Ne znam" = bez ocene.
            {submitted && <span className="ml-1 inline-flex items-center gap-1 font-semibold text-status-success"><Check className="h-3.5 w-3.5" aria-hidden /> Već si predao/la — možeš dopuniti dok je procena otvorena.</span>}
          </>
        ) : (
          <>
            Procena je <b>zatvorena</b> — prikaz je samo za pregled. {visible && 'Ispod je tvoj 360° rezultat.'}
          </>
        )}
      </p>

      {/* Podeljeni 360° rezultat */}
      {showShared && (
        <div className="rounded-panel border border-accent/50 bg-accent-subtle/30 p-3">
          <h4 className="mb-1 flex items-center justify-center gap-1.5 text-center text-sm font-semibold text-ink"><BarChart3 className="h-4 w-4" aria-hidden /> Tvoj 360° rezultat (podeljeno)</h4>
          <div className="mx-auto max-w-[460px]">
            <Radar labels={sharedRadar.labels} datasets={sharedRadar.datasets} />
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs uppercase text-ink-secondary">
                  <th className="py-1 text-left">Grupa</th>
                  <th className="py-1">Ti</th>
                  <th className="py-1">Kolege</th>
                  <th className="py-1">Rukov.</th>
                  <th className="py-1">Cilj</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const r = resByGroup.get(g.id);
                  return (
                    <tr key={g.id} className="border-t border-line-soft">
                      <td className="py-1.5 font-medium text-ink">{g.name}</td>
                      <td className="text-center text-ink-secondary">{f1(r?.self)}</td>
                      <td className="text-center text-ink-secondary">{f1(r?.peer)}</td>
                      <td className="text-center text-ink-secondary">{f1(r?.leader)}</td>
                      <td className="text-center text-ink-secondary">{f1(r?.target)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-center">
            <Button variant="secondary" className="h-8 text-xs" loading={busy} onClick={doPdf}><FileText className="h-4 w-4" aria-hidden /> PDF izveštaj</Button>
          </div>
        </div>
      )}

      {/* Live radar samoprocene */}
      <div className="mx-auto max-w-[460px]">
        <h4 className="mb-1 text-center text-sm font-semibold text-ink">Tvoja samoprocena</h4>
        <Radar labels={selfRadar.labels} datasets={selfRadar.datasets} />
      </div>

      {/* Ocene po grupi/kompetenciji */}
      <div className="space-y-3">
        {groups.map((g) => {
          const badge = SCOPE_BADGE[g.scope] ?? { bg: '#64748b', t: g.scope };
          return (
            <section key={g.id} className="overflow-hidden rounded-panel border border-line bg-surface-2/40">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="rounded px-2 py-0.5 text-2xs font-extrabold tracking-wide text-white" style={{ background: badge.bg }}>{badge.t}</span>
                <span className="text-sm font-semibold text-ink">{g.name}</span>
              </div>
              {g.comps.map((c) => {
                const cur = scores.get(c.id) ?? { level: null, comment: '' };
                const lvls = levelsByComp.get(c.id) ?? [];
                const descL = lvls.find((x) => x.level === cur.level);
                return (
                  <div key={c.id} className="border-b border-line-soft px-3 py-2.5 last:border-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-[160px] flex-1 text-sm font-medium text-ink">{c.name}</span>
                      <div className="flex flex-wrap gap-1">
                        {[0, 1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setLevel(c.id, n)}
                            className={`h-7 w-7 rounded-control border text-sm font-bold ${cur.level === n ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-ink hover:border-accent'} disabled:opacity-60`}
                          >
                            {n}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => setLevel(c.id, null)}
                          className={`h-7 rounded-control border px-2.5 text-xs font-semibold ${cur.level == null ? 'border-ink-secondary bg-ink-secondary text-surface' : 'border-line bg-surface text-ink hover:border-accent'} disabled:opacity-60`}
                        >
                          Ne znam
                        </button>
                      </div>
                    </div>
                    <div className="mt-1.5 min-h-[18px] text-xs text-ink-secondary">
                      {cur.level != null && descL ? `Nivo ${cur.level}: ${descL.descriptor}` : cur.level != null ? `Nivo ${cur.level}` : '— izaberi nivo —'}
                    </div>
                    <input
                      type="text"
                      maxLength={300}
                      readOnly={!canEdit}
                      value={cur.comment}
                      onChange={(e) => setComment(c.id, e.target.value)}
                      placeholder="Komentar (opciono)"
                      className="mt-1.5 h-8 w-full rounded-control border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-ink-disabled read-only:opacity-70"
                    />
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {/* Otvorena pitanja */}
      {questions.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><PenLine className="h-4 w-4" aria-hidden /> Otvorena pitanja</h4>
          {questions.map((qq) => (
            <QuestionField key={qq.code} q={qq} value={answers.get(qq.code) ?? ''} readOnly={!canEdit} onChange={(v) => setAnswers((prev) => new Map(prev).set(qq.code, v))} />
          ))}
        </div>
      )}

      {/* Footer akcije */}
      {canEdit && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" loading={busy} onClick={() => persist(false)}><Save className="h-4 w-4" aria-hidden /> Sačuvaj</Button>
          <Button loading={busy} onClick={() => persist(true)}><Check className="h-4 w-4" aria-hidden /> Podnesi procenu</Button>
        </div>
      )}
    </div>
  );
}

function QuestionField({ q, value, readOnly, onChange }: { q: CompetenceQuestion; value: string; readOnly: boolean; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">{q.text_sr}</label>
      <textarea
        rows={2}
        maxLength={800}
        readOnly={readOnly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tvoj odgovor…"
        className="w-full resize-y rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-disabled read-only:opacity-70"
      />
    </div>
  );
}

/* ── util ── */
function num(v: number | null | undefined): number | null {
  return v == null ? null : Number(v);
}
function f1(v: number | null | undefined): string {
  return v == null ? '—' : Number(v).toFixed(1);
}
function sortOf(scope: AssessmentScopeRow[], groupId: number): number {
  const r = scope.find((x) => x.group_id === groupId);
  return r?.group_sort ?? 0;
}
