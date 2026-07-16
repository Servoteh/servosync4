'use client';

import { useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import {
  useTalks,
  useTalkDetail,
  useAcknowledgeTalk,
  usePosition,
  useCompanyValues,
  useColleaguesOnLeave,
  type TalkRow,
} from '@/api/moj-profil';
import { useMyIssuedTools, useMyConsumed } from '@/api/reversi';
import { Section } from './section';

// ------------------------------------------------------------------ Razgovori — labele (paritet 1.0 talks.js)

const TALK_TYPE_LABEL: Record<string, string> = {
  godisnji: 'Godišnji (učinak i zarada)',
  korektivni: 'Korektivni',
  jedan_na_jedan: '1-na-1',
  ostalo: 'Ostalo',
};
const RAISE_DECISION_LABEL: Record<string, string> = {
  da: 'Povećanje — DA',
  ne: 'Bez povećanja',
  odlozeno: 'Odloženo',
};
const CPLAN_STATUS_LABEL: Record<string, string> = {
  otvoren: 'Otvoren',
  u_toku: 'U toku',
  zatvoren_uspesno: 'Zatvoren — uspešno',
  zatvoren_neuspesno: 'Zatvoren — neuspešno',
};
const MEASURE_STATUS_LABEL: Record<string, string> = {
  otvoreno: 'Otvoreno',
  u_toku: 'U toku',
  ispunjeno: 'Ispunjeno',
  neispunjeno: 'Neispunjeno',
};

// ------------------------------------------------------------------ Razgovori

export function TalksSection() {
  const q = useTalks();
  const rows = q.data?.data ?? [];
  const ackM = useAcknowledgeTalk();
  const pending = rows.filter((t) => t.shared_at && !t.acknowledged_at).length;
  const [openTalk, setOpenTalk] = useState<TalkRow | null>(null);

  return (
    <Section icon="🗣" title="Razgovori sa nadređenim" badge={pending ? <StatusBadge tone="warn" label={`${pending} čeka`} /> : undefined}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Još nema podeljenih zapisnika razgovora.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => {
            const acked = !!t.acknowledged_at;
            const typeLabel = (t.talk_type && TALK_TYPE_LABEL[t.talk_type]) || 'Razgovor';
            return (
              <li key={t.id} className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-3 py-2">
                <button type="button" onClick={() => setOpenTalk(t)} className="min-w-0 flex-1 text-left hover:opacity-80">
                  <div className="text-sm font-medium text-ink">
                    {typeLabel}
                    {t.title ? ` · ${t.title}` : ''}
                  </div>
                  <div className="text-xs text-ink-secondary">{t.talk_date ? formatDate(t.talk_date) : ''} · otvori zapisnik</div>
                </button>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={acked ? 'success' : 'warn'} label={acked ? '✔ potvrđeno' : '⏳ čeka potvrdu'} />
                  {!acked && t.shared_at && (
                    <Button variant="secondary" onClick={() => ackM.mutate({ id: t.id })} className="h-7 text-xs">
                      ✔ Upoznat/a sam
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {openTalk && <TalkDetailModal talk={openTalk} onClose={() => setOpenTalk(null)} />}
    </Section>
  );
}

/** Detalji zapisnika razgovora (paritet 1.0 myTalks.js `_openTalkView`): zapisnik md +
 *  💰 odluka o zaradi (godišnji) + ⚠ korektivne mere sa rokovima. Ack dugme u podnožju. */
function TalkDetailModal({ talk, onClose }: { talk: TalkRow; onClose: () => void }) {
  const q = useTalkDetail(talk.id);
  const ackM = useAcknowledgeTalk();
  const d = q.data?.data;
  const typeLabel = (talk.talk_type && TALK_TYPE_LABEL[talk.talk_type]) || 'Razgovor';
  const acked = !!(d?.acknowledged_at ?? talk.acknowledged_at);
  const canAck = !acked && !!talk.shared_at;

  const plans = d?.correctivePlans ?? [];

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Zatvori
      </Button>
      {canAck && (
        <Button
          loading={ackM.isPending}
          onClick={async () => {
            await ackM.mutateAsync({ id: talk.id });
            onClose();
          }}
        >
          ✔ Upoznat/a sam sa sadržajem
        </Button>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={`🗣 ${typeLabel}${talk.title ? ` — ${talk.title}` : ''}`} size="lg" footer={footer}>
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-secondary">
            {d?.talk_date ? formatDate(d.talk_date) : talk.talk_date ? formatDate(talk.talk_date) : ''}
            {d?.conducted_by ? ` · Vodio: ${d.conducted_by}` : ''}
            {acked && d?.acknowledged_at ? ` · ✔ potvrdio/la si ${formatDate(d.acknowledged_at)}` : ''}
          </p>

          <div className="rounded-control border border-line-soft p-3">
            <h4 className="mb-1 text-sm font-semibold text-ink">Zapisnik</h4>
            {d?.zapisnik_md ? (
              <Markdown source={d.zapisnik_md} className="text-sm text-ink-secondary" />
            ) : (
              <p className="text-sm text-ink-disabled">—</p>
            )}
          </div>

          {talk.talk_type === 'godisnji' && d?.raise_decision && (
            <div className="rounded-control border border-line-soft p-3">
              <h4 className="mb-1 text-sm font-semibold text-ink">💰 Odluka o zaradi</h4>
              <p className="text-sm text-ink">
                <strong>{RAISE_DECISION_LABEL[d.raise_decision] ?? d.raise_decision}</strong>
                {d.raise_percent != null ? ` · ${d.raise_percent}%` : ''}
                {d.raise_effective_from ? ` · važi od ${formatDate(d.raise_effective_from)}` : ''}
              </p>
              {d.raise_note && <p className="mt-1 text-sm text-ink-secondary">{d.raise_note}</p>}
            </div>
          )}

          {plans.length > 0 && (
            <div className="rounded-control border border-line-soft p-3">
              <h4 className="mb-1 text-sm font-semibold text-ink">⚠ Korektivne mere</h4>
              {plans.map((p) => (
                <div key={p.id} className="mb-2 last:mb-0">
                  {p.reason_md && <Markdown source={p.reason_md} className="mb-1 text-sm text-ink-secondary" />}
                  <p className="text-xs text-ink-secondary">
                    Status plana: <strong>{CPLAN_STATUS_LABEL[p.status] ?? p.status}</strong>
                    {p.followup_date ? ` · follow-up razgovor ${formatDate(p.followup_date)}` : ''}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-ink">
                    {p.measures.map((m, i) => (
                      <li key={i}>
                        {m.description_md}
                        <span className="text-ink-secondary">
                          {' '}
                          — {MEASURE_STATUS_LABEL[m.status] ?? m.status}
                          {m.due_date ? `, rok ${formatDate(m.due_date)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ Opis pozicije

export function PositionSection() {
  const q = usePosition();
  const p = q.data?.data;
  return (
    <Section icon="📈" title="Pozicija i razvoj">
      {!p ? (
        <p className="text-sm text-ink-disabled">Vaša pozicija nije povezana sa opisom posla — obratite se HR-u.</p>
      ) : (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-ink">{p.name}</h3>
          {p.reportsToLine && <p className="text-sm text-ink-secondary">▸ Linijski odgovara: {p.reportsToLine}</p>}
          <MdBlock title="📝 Svrha radnog mesta" md={p.summaryMd} />
          <MdBlock title="🛡 Ključne odgovornosti" md={p.responsibilitiesMd} />
          <MdBlock title="⚖ Ovlašćenja" md={p.authorityMd} />
          <MdBlock title="✅ Obaveze" md={p.dutiesMd} />
          <MdBlock title="📊 KPI / merila uspeha" md={p.kpiMd} />
          <MdBlock title="🎓 Kvalifikacije" md={p.qualificationsMd} />
          <MdBlock title="🤝 Ključna saradnja" md={p.collaborationMd} />
          <MdBlock title="🎯 Očekivanja" md={p.expectationsMd} />
        </div>
      )}
    </Section>
  );
}

function MdBlock({ title, md }: { title: string; md: string | null }) {
  if (!md) return null;
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-ink">{title}</h4>
      <Markdown source={md} className="text-sm text-ink-secondary" />
    </div>
  );
}

// ------------------------------------------------------------------ Vrednosti firme

export function CompanyValuesSection() {
  const q = useCompanyValues();
  const c = q.data?.data;
  return (
    <Section icon="💎" title="Vrednosti firme">
      {!c ? (
        <p className="text-sm text-ink-disabled">Nema unetih vrednosti firme.</p>
      ) : (
        <div className="space-y-3">
          <MdBlock title="🚀 Misija" md={c.missionMd} />
          <MdBlock title="🔭 Vizija" md={c.visionMd} />
          <MdBlock title="💎 Vrednosti" md={c.valuesMd} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Kolege na odsustvu

const ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  slava: 'Krsna slava',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  slobodan: 'Slobodan dan',
  ostalo: 'Ostalo',
};

export function ColleaguesSection() {
  const q = useColleaguesOnLeave();
  const rows = q.data?.data ?? [];
  return (
    <Section icon="👥" title="Kolege na odsustvu">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Niko trenutno nije na odsustvu.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="text-ink">
                🟠 {c.full_name}
                {c.department && <span className="text-ink-secondary"> · {c.department}</span>}
              </span>
              <span className="text-ink-secondary">
                {ABS_TYPE_LABELS[c.type] || c.type} · {formatDate(c.date_from)} → {formatDate(c.date_to)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Zaduženja (revers) — reuse Reversi API

export function ReversiSection() {
  const issuedQ = useMyIssuedTools();
  const consumedQ = useMyConsumed();
  const issued = issuedQ.data?.data ?? [];
  const consumed = consumedQ.data?.data ?? [];
  if (issued.length === 0 && consumed.length === 0) return null;

  return (
    <Section icon="🔧" title="Zaduženja (revers)">
      {issued.length > 0 && (
        <>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Trenutna zaduženja</h3>
          <table className="mb-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Predmet</th>
                <th className="py-1.5">Br. dokumenta</th>
                <th className="py-1.5">Izdato</th>
                <th className="py-1.5">Rok povr.</th>
                <th className="py-1.5">Kol.</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((r, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="py-1.5 text-ink">{[r.oznaka, r.naziv].filter(Boolean).join(' — ')}</td>
                  <td className="py-1.5 tnums text-ink-secondary">{r.doc_number}</td>
                  <td className="py-1.5 tnums">{formatDate(r.issued_at)}</td>
                  <td className="py-1.5 tnums">{r.expected_return_date ? formatDate(r.expected_return_date) : '—'}</td>
                  <td className="py-1.5 tnums">{r.quantity} {r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {consumed.length > 0 && (
        <>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Potrošeno</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Predmet</th>
                <th className="py-1.5">Kol.</th>
                <th className="py-1.5">Datum</th>
              </tr>
            </thead>
            <tbody>
              {consumed.map((r, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="py-1.5 text-ink">{[r.oznaka, r.naziv].filter(Boolean).join(' — ')}</td>
                  <td className="py-1.5 tnums">{r.quantity}</td>
                  <td className="py-1.5 tnums">{formatDate(r.consumed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
