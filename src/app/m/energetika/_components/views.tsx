'use client';

// Touch-first prikaz Energetike (port 1.0 src/ui/mobile/myEnergetika.js, presuda E2).
// iframe HMI (SVG sinoptici) nije upotrebljiv na telefonu → native touch kontrole.
// M1 (pregled): 5 kartica + aktivni alarmi + poslednje komande. M2 (po sistemu):
// touch kontrole po sistemu. READ prikazi rade uvek; KOMANDE se prikazuju samo kad
// `control` (= energetika.control I COMMANDS_ENABLED) — u R3 je to false (stub, E R2).
//
// Čist prikaz: klik na komandno dugme emituje `CmdIntent`, a ljuska (page.tsx) sklopi
// {target,value,label} i pokrene tok (paritet 1.0 handleCommandClick → runCommand).

import type { ReactNode } from 'react';
import {
  K1_DEVICES,
  K1_ZONES,
  cmdStatusLabel,
  f0,
  f1,
  fmtAgo,
  fmtWhen,
  heroFor,
  isLiveOnline,
  k1Val,
  kot3Live,
  kot3Rooms,
  rowsFor,
  sigenVal,
  siteIco,
  siteName,
  siteStatus,
  type ScadaAlarm,
  type ScadaCommand,
  type ScadaSite,
  type ScadaSnapshotRow,
  type SiteStatusTone,
} from '@/lib/scada';

// Dinamički čitači payload-a (jsonb je spoljni, netipizovan — cast je nameran).
type Obj = Record<string, unknown>;
const O = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const A = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const N = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Opis kliknutog komandnog dugmeta (ljuska ga interpretira). */
export type CmdIntent = { cmd: string } & Record<string, string | number | undefined>;

export interface ViewCtx {
  sites?: ScadaSite[];
  snaps: Map<string, ScadaSnapshotRow>;
  alarms: ScadaAlarm[];
  commands: ScadaCommand[];
  /** energetika.control I COMMANDS_ENABLED (R3 stub: false). */
  control: boolean;
  cmdBusy: string | null;
  onIntent: (i: CmdIntent) => void;
  onOpenSite: (key: string) => void;
  onBackOverview: () => void;
}

const PILL_TONE: Record<SiteStatusTone, string> = {
  on: 'bg-status-success-bg text-status-success',
  off: 'bg-status-danger-bg text-status-danger',
  stale: 'bg-status-warn-bg text-status-warn',
};

function Pill({ snap }: { snap: ScadaSnapshotRow | null | undefined }) {
  const [label, tone] = siteStatus(snap);
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PILL_TONE[tone]}`}>
      {label}
    </span>
  );
}

const sectionTitle = 'mt-4 mb-1 text-xs font-semibold uppercase tracking-wider text-ink-secondary';
const panel = 'rounded-panel border border-line bg-surface divide-y divide-line-soft';
const note = 'rounded-panel border border-line bg-surface-2 px-3 py-2 text-sm text-ink-secondary';
const noteWarn = 'rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn';
const drow = 'flex items-center gap-2 px-3 py-2.5';
const cmdBtn =
  'ml-auto rounded-control border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none';
const segBtn =
  'flex-1 rounded-control border border-line px-2 py-2 text-sm font-medium disabled:opacity-40 disabled:pointer-events-none';
const stepBtn =
  'grid h-9 w-9 place-items-center rounded-control border border-line bg-surface text-lg font-semibold text-ink disabled:opacity-40 disabled:pointer-events-none';

function Lamp({ on, bad }: { on?: boolean; bad?: boolean }) {
  const cls = bad ? 'bg-status-danger' : on ? 'bg-status-success' : 'bg-status-neutral';
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

// ───────────────────────────────────────────────────────────── M1: pregled

function SiteCard({ ctx, siteKey }: { ctx: ViewCtx; siteKey: string }) {
  const snap = ctx.snaps.get(siteKey) ?? null;
  const p = snap?.payload ?? null;
  const [num, unit, lbl] = heroFor(siteKey, p);
  const rows = rowsFor(siteKey, p);
  return (
    <button
      type="button"
      onClick={() => ctx.onOpenSite(siteKey)}
      className="w-full rounded-panel border border-line bg-surface p-3 text-left active:bg-surface-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-ink">
          {siteIco(siteKey)} {siteName(siteKey, ctx.sites)}
        </span>
        <Pill snap={snap} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="tabular-nums text-3xl font-semibold text-ink">{num}</span>
        <span className="text-sm text-ink-secondary">{unit}</span>
        <span className="ml-1 text-xs text-ink-secondary">{lbl}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 text-sm">
        {rows.map(([l, v]) => (
          <span key={l} className="flex justify-between gap-2 text-ink-secondary">
            <span>{l}</span>
            <b className="text-ink">{v}</b>
          </span>
        ))}
      </div>
      <div className="mt-1 text-xs text-ink-secondary">
        ⟳ {snap?.updatedAt ? fmtAgo(snap.updatedAt) : 'nema podataka'}
      </div>
    </button>
  );
}

function AlarmRow({ a, sites }: { a: ScadaAlarm; sites?: ScadaSite[] }) {
  const sev = Number(a.severity);
  const dot = sev <= 2 ? 'bg-status-danger' : sev === 3 ? 'bg-status-warn' : 'bg-status-info';
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0">
        <div className="truncate text-sm text-ink">{a.text || a.code || 'Alarm'}</div>
        <div className="text-xs text-ink-secondary">
          {siteName(a.siteKey, sites)} · {fmtWhen(a.raisedAt)}
        </div>
      </div>
    </div>
  );
}

function CmdRow({ c, sites }: { c: ScadaCommand; sites?: ScadaSite[] }) {
  const st = cmdStatusLabel(c.status);
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0">
        <code className="text-sm text-ink">{c.target}</code>
        <div className="text-xs text-ink-secondary">
          {siteName(c.siteKey, sites)} · {fmtWhen(c.requestedAt)}
        </div>
      </div>
      <span className="ml-auto shrink-0 text-xs font-medium text-ink-secondary">{st.label}</span>
    </div>
  );
}

export function OverviewView({ ctx }: { ctx: ViewCtx }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {['kot1', 'kot2', 'kot3', 'solar-kaco', 'solar-sigen'].map((k) => (
          <SiteCard key={k} ctx={ctx} siteKey={k} />
        ))}
      </div>

      <div className={sectionTitle}>🚨 Aktivni alarmi ({ctx.alarms.length})</div>
      {ctx.alarms.length ? (
        <div className={panel}>
          {ctx.alarms.map((a) => (
            <AlarmRow key={a.id} a={a} sites={ctx.sites} />
          ))}
        </div>
      ) : (
        <div className="rounded-panel border border-status-success/30 bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Nema aktivnih alarma.
        </div>
      )}

      <div className={sectionTitle}>📤 Poslednje komande</div>
      {ctx.commands.length ? (
        <div className={panel}>
          {ctx.commands.map((c) => (
            <CmdRow key={c.id} c={c} sites={ctx.sites} />
          ))}
        </div>
      ) : (
        <div className={note}>Još nema poslatih komandi.</div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────── M2: po sistemu

function SiteHeader({ ctx, siteKey }: { ctx: ViewCtx; siteKey: string }) {
  const snap = ctx.snaps.get(siteKey) ?? null;
  return (
    <>
      <button
        type="button"
        onClick={ctx.onBackOverview}
        className="text-sm font-medium text-accent"
      >
        ← Pregled sistema
      </button>
      <div className="mt-2 flex items-center gap-2">
        <span className="font-semibold text-ink">
          {siteIco(siteKey)} {siteName(siteKey, ctx.sites)}
        </span>
        <Pill snap={snap} />
        <span className="ml-auto text-xs text-ink-secondary">
          ⟳ {snap?.updatedAt ? fmtAgo(snap.updatedAt) : 'nema podataka'}
        </span>
      </div>
      {ctx.cmdBusy && (
        <div className={`mt-2 ${noteWarn}`}>
          ⏳ Komanda u toku (<code>{ctx.cmdBusy}</code>) — sačekaj ishod…
        </div>
      )}
    </>
  );
}

function useDis(ctx: ViewCtx, siteKey: string) {
  const snap = ctx.snaps.get(siteKey) ?? null;
  return !!ctx.cmdBusy || !isLiveOnline(snap);
}

function OfflineNote({ ctx, siteKey }: { ctx: ViewCtx; siteKey: string }) {
  const snap = ctx.snaps.get(siteKey) ?? null;
  if (isLiveOnline(snap)) return null;
  return <div className={noteWarn}>⚠️ Sistem nije na mreži — komande su privremeno onemogućene.</div>;
}

/* ── kot1 (Unitronics) ── */
function Kot1View({ ctx }: { ctx: ViewCtx }) {
  const key = 'kot1';
  const p = ctx.snaps.get(key)?.payload ?? null;
  const { control, onIntent } = ctx;
  const dis = useDis(ctx, key);
  const cool = k1Val(p, 'GREJ_HLAD') === 1;
  const auto = (k1Val(p, 'AUTO_MAN') ?? 0) > 0;

  return (
    <div className="space-y-2">
      <SiteHeader ctx={ctx} siteKey={key} />
      <OfflineNote ctx={ctx} siteKey={key} />

      <div className={sectionTitle}>Režim rada</div>
      {control ? (
        <div className="flex gap-2">
          <button
            className={`${segBtn} ${cool ? '' : 'bg-accent-subtle'}`}
            disabled={dis}
            onClick={() => onIntent({ cmd: 'k1mode', tag: 'GREJ_HLAD' })}
          >
            {cool ? '❄ HLAĐENJE' : '🔥 GREJANJE'}
          </button>
          <button
            className={`${segBtn} ${auto ? 'bg-accent-subtle' : ''}`}
            disabled={dis}
            onClick={() => onIntent({ cmd: 'k1mode', tag: 'AUTO_MAN' })}
          >
            {auto ? 'AUTO' : 'RUČNO'}
          </button>
          <button
            className={`${segBtn} text-status-warn`}
            disabled={dis}
            onClick={() => onIntent({ cmd: 'k1reset' })}
          >
            ⟳ Reset VFD
          </button>
        </div>
      ) : (
        <div className={note}>
          {p ? `${cool ? '❄ Hlađenje' : '🔥 Grejanje'} · ${auto ? 'AUTO' : 'RUČNO'}` : '—'}
        </div>
      )}

      <div className={sectionTitle}>Zone · temperatura i cilj</div>
      <div className={panel}>
        {K1_ZONES.map((z, i) => (
          <div key={`${z.sp}-${i}`} className="px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-ink">{z.l}</span>
              <span className="tabular-nums text-ink">{f1(k1Val(p, z.t))} °C</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xs text-ink-secondary">cilj</span>
              {control && (
                <button
                  className={stepBtn}
                  disabled={dis}
                  aria-label={`Smanji ${z.l}`}
                  onClick={() => onIntent({ cmd: 'k1sp', sp: z.sp, d: -0.5 })}
                >
                  −
                </button>
              )}
              <b className="tabular-nums text-ink">{f1(k1Val(p, z.sp))}</b>
              <span className="text-xs text-ink-secondary">°C</span>
              {control && (
                <button
                  className={stepBtn}
                  disabled={dis}
                  aria-label={`Povećaj ${z.l}`}
                  onClick={() => onIntent({ cmd: 'k1sp', sp: z.sp, d: 0.5 })}
                >
                  +
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className={sectionTitle}>Uređaji (kaloriferi K1–K5 · pumpe P1–P4)</div>
      <div className={panel}>
        {K1_DEVICES.map((d) => {
          const on = (k1Val(p, d) ?? 0) > 0;
          const man = (k1Val(p, `RK_${d}`) ?? 0) > 0;
          return (
            <div key={d} className={drow}>
              <Lamp on={on} />
              <span className="w-8 font-medium text-ink">{d}</span>
              <span className="text-sm text-ink-secondary">
                {p ? (on ? 'RADI' : 'STOJI') : '—'}
              </span>
              {control && (
                <button
                  className={`${cmdBtn} ${man ? 'bg-accent-subtle' : ''}`}
                  disabled={dis}
                  onClick={() => onIntent({ cmd: 'k1man', tag: `RK_${d}` })}
                >
                  Ručno {man ? 'ON' : 'OFF'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── kot2 (Siemens) ── */
function Kot2View({ ctx }: { ctx: ViewCtx }) {
  const key = 'kot2';
  const p = ctx.snaps.get(key)?.payload ?? null;
  const { control, onIntent } = ctx;
  const dis = useDis(ctx, key);
  const m = O(O(p).modes);
  const sp = O(p).setpoint;
  const estopBad = p ? !!(m.webEstop || m.estopOk === false) : false;

  const devList = (items: Obj[], cmdKind: string) =>
    items.map((x, i) => (
      <div key={`${String(x.key)}-${i}`} className={drow}>
        <Lamp on={!!x.on} />
        <span className="text-ink">{String(x.label || x.key || '?')}</span>
        <span className="text-sm text-ink-secondary">{x.on ? 'RADI' : 'STOJI'}</span>
        {control && x.cmd ? (
          <button
            className={`${cmdBtn} ${x.on ? 'bg-accent-subtle' : ''}`}
            disabled={dis}
            onClick={() => onIntent({ cmd: cmdKind, key: String(x.key ?? '') })}
          >
            {x.on ? 'Isključi' : 'Uključi'}
          </button>
        ) : null}
      </div>
    ));

  const sevCls: Record<string, string> = {
    alarm: 'bg-status-danger',
    warn: 'bg-status-warn',
    info: 'bg-status-info',
  };

  return (
    <div className="space-y-2">
      <SiteHeader ctx={ctx} siteKey={key} />
      <OfflineNote ctx={ctx} siteKey={key} />

      <div className={sectionTitle}>Zadata temperatura</div>
      <div className="flex items-center justify-center gap-3 rounded-panel border border-line bg-surface py-4">
        {control && (
          <button
            className={stepBtn}
            disabled={dis}
            aria-label="Smanji zadatu temperaturu"
            onClick={() => onIntent({ cmd: 'k2sp', d: -1 })}
          >
            −
          </button>
        )}
        <b className="tabular-nums text-4xl font-semibold text-ink">{sp != null ? f0(sp) : '—'}</b>
        <span className="text-ink-secondary">°C</span>
        {control && (
          <button
            className={stepBtn}
            disabled={dis}
            aria-label="Povećaj zadatu temperaturu"
            onClick={() => onIntent({ cmd: 'k2sp', d: 1 })}
          >
            +
          </button>
        )}
      </div>
      {control && <div className="text-center text-xs text-ink-secondary">opseg 10–30 °C</div>}

      {control && (
        <>
          <div className={sectionTitle}>Režim rada</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`${segBtn} ${m.auto ? 'bg-accent-subtle' : ''}`}
              disabled={dis}
              onClick={() => onIntent({ cmd: 'k2mode', tag: 'Web_Automatski_Rezim', name: 'AUTOMATSKI režim' })}
            >
              AUTO
            </button>
            <button
              className={`${segBtn} ${m.manual ? 'bg-accent-subtle' : ''}`}
              disabled={dis}
              onClick={() => onIntent({ cmd: 'k2mode', tag: 'Web_Rucni_Rezim', name: 'RUČNI režim' })}
            >
              RUČNO
            </button>
            <button
              className={`${segBtn} ${m.heating ? 'bg-accent-subtle' : ''}`}
              disabled={dis}
              onClick={() => onIntent({ cmd: 'k2mode', tag: 'Web_Grejanje', name: 'GREJANJE' })}
            >
              🔥 GREJANJE
            </button>
            <button
              className={`${segBtn} ${m.cooling ? 'bg-accent-subtle' : ''}`}
              disabled={dis}
              onClick={() => onIntent({ cmd: 'k2mode', tag: 'Web_Hladjenje', name: 'HLAĐENJE' })}
            >
              ❄ HLAĐENJE
            </button>
          </div>
          <div className={panel}>
            <div className={drow}>
              <Lamp on={!!m.boiler} />
              <span className="text-ink">Kotao (ručno)</span>
              <span className="text-sm text-ink-secondary">{m.boiler ? 'RADI' : 'STOJI'}</span>
              <button
                className={`${cmdBtn} ${m.boiler ? 'bg-accent-subtle' : ''}`}
                disabled={dis}
                onClick={() => onIntent({ cmd: 'k2boiler' })}
              >
                {m.boiler ? 'Isključi' : 'Uključi'}
              </button>
            </div>
            <div className={drow}>
              <Lamp on={!estopBad} bad={estopBad} />
              <span className="text-ink">E-stop</span>
              <span className={`text-sm ${estopBad ? 'text-status-danger' : 'text-ink-secondary'}`}>
                {p ? (estopBad ? 'AKTIVAN' : 'OK') : '—'}
              </span>
            </div>
          </div>
        </>
      )}

      <div className={sectionTitle}>Temperature</div>
      <div className={panel}>
        {A(O(p).temps).length ? (
          A(O(p).temps).map((t, i) => (
            <div key={`${String(t.key)}-${i}`} className="flex items-center justify-between px-3 py-2">
              <span className="text-ink">{String(t.label || t.key || '?')}</span>
              <b className={`tabular-nums ${t.fault ? 'text-status-danger' : 'text-ink'}`}>
                {t.fault ? 'KVAR' : `${f1(t.value)} °C`}
              </b>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema podataka.</div>
        )}
      </div>

      <div className={sectionTitle}>Pumpe</div>
      <div className={panel}>
        {A(O(p).pumps).length ? (
          devList(A(O(p).pumps), 'k2pump')
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema podataka.</div>
        )}
      </div>

      <div className={sectionTitle}>Kaloriferi</div>
      <div className={panel}>
        {A(O(p).kaloriferi).length ? (
          devList(A(O(p).kaloriferi), 'k2kal')
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema podataka.</div>
        )}
      </div>

      <div className={sectionTitle}>Raspored rada po hali</div>
      <div className={panel}>
        {A(O(p).schedule).length ? (
          A(O(p).schedule).map((x, i) => (
            <div key={`sched-${i}`} className={drow}>
              <span className="text-ink">Hala {String(x.hala ?? '?')}</span>
              <span className="text-sm text-ink-secondary">
                {String(x.start ?? '—')}–{String(x.end ?? '—')} h
              </span>
              {control && (
                <div className="ml-auto flex gap-1">
                  <button
                    className={cmdBtn}
                    disabled={dis}
                    onClick={() =>
                      onIntent({
                        cmd: 'k2sched',
                        var: String(x.pocVar || ''),
                        hala: String(x.hala ?? ''),
                        kind: 'poc',
                        cur: String(x.start ?? 0),
                      })
                    }
                  >
                    ✎ početak
                  </button>
                  <button
                    className={cmdBtn}
                    disabled={dis}
                    onClick={() =>
                      onIntent({
                        cmd: 'k2sched',
                        var: String(x.krajVar || ''),
                        hala: String(x.hala ?? ''),
                        kind: 'kraj',
                        cur: String(x.end ?? 0),
                      })
                    }
                  >
                    ✎ kraj
                  </button>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema rasporeda.</div>
        )}
      </div>

      <div className={sectionTitle}>Alarmi postrojenja ({A(O(p).alarms).length})</div>
      {A(O(p).alarms).length ? (
        <div className={panel}>
          {A(O(p).alarms).map((a, i) => (
            <div key={`al-${i}`} className="flex items-start gap-2 px-3 py-2">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${sevCls[String(a.sev)] || 'bg-status-warn'}`}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="text-sm text-ink">
                  {String(a.text || `${a.word ?? 'W?'}.${a.bit ?? '?'}`)}
                </div>
                <div className="text-xs text-ink-secondary">
                  {String(a.word ?? '')}.{String(a.bit ?? '')}
                </div>
              </div>
              {control && a.reset ? (
                <button
                  className={cmdBtn}
                  disabled={dis}
                  onClick={() =>
                    onIntent({
                      cmd: 'k2areset',
                      tag: String(a.reset),
                      text: String(a.text || a.reset),
                    })
                  }
                >
                  RESET
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-panel border border-status-success/30 bg-status-success-bg px-3 py-2 text-sm text-status-success">
          Nema aktivnih alarma.
        </div>
      )}
    </div>
  );
}

/* ── kot3 (Loxone) ── */
function Kot3View({ ctx }: { ctx: ViewCtx }) {
  const key = 'kot3';
  const p = ctx.snaps.get(key)?.payload ?? null;
  const { control, onIntent } = ctx;
  const dis = useDis(ctx, key);
  const tags = A(O(p).tags);
  const rooms = kot3Rooms(p);
  const live = O(O(p).live);

  const switches = tags.filter((t) => t.kind === 'switch' && t.writable);
  const byRoom = new Map<string, Obj[]>();
  for (const t of switches) {
    const r = String(t.room || 'Ostalo');
    if (!byRoom.has(r)) byRoom.set(r, []);
    byRoom.get(r)!.push(t);
  }

  return (
    <div className="space-y-2">
      <SiteHeader ctx={ctx} siteKey={key} />
      <OfflineNote ctx={ctx} siteKey={key} />

      <div className={sectionTitle}>Sobe ({rooms.length})</div>
      <div className={panel}>
        {rooms.length ? (
          rooms.map((rc, i) => {
            const states = O(rc.states);
            const cur = kot3Live(p, states.tempActual);
            const ttRaw = kot3Live(p, states.tempTarget);
            const cooling = ttRaw != null && ttRaw <= 0;
            const mode = cooling ? 'cool' : 'heat';
            const target = cooling
              ? kot3Live(p, states.comfortTemperatureCool)
              : kot3Live(p, states.tempTarget);
            const fan = tags.find((t) => t.type === 'ValueSelector' && t.room === rc.room);
            let fanEl: ReactNode = null;
            if (fan) {
              const fs = O(fan.states);
              const maxRaw = kot3Live(p, fs.max);
              const max = maxRaw && maxRaw > 0 ? Math.round(maxRaw) : 3;
              const curFanRaw = kot3Live(p, fs.value);
              const curFan = curFanRaw != null ? Math.round(curFanRaw) : 0;
              fanEl = (
                <div className="mt-1 flex items-center gap-1">
                  <span className="mr-1 text-xs text-ink-secondary">Ventilator</span>
                  {Array.from({ length: max + 1 }, (_, n) => (
                    <button
                      key={n}
                      className={`grid h-8 w-8 place-items-center rounded-control border border-line text-sm ${
                        n === curFan ? 'bg-accent-subtle font-semibold text-ink' : 'text-ink-secondary'
                      } disabled:opacity-40`}
                      disabled={dis || !control}
                      onClick={() =>
                        onIntent({
                          cmd: 'k3fan',
                          key: String(fan.key),
                          room: String(rc.room || ''),
                          n,
                        })
                      }
                    >
                      {n}
                    </button>
                  ))}
                </div>
              );
            }
            return (
              <div key={`room-${i}`} className="px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-ink">{String(rc.room || rc.name || 'Soba')}</span>
                  <span className="tabular-nums text-ink">{f1(cur)} °C</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-ink-secondary">cilj{cooling ? ' ❄' : ''}</span>
                  <b className="tabular-nums text-ink">{f1(target)}</b>
                  <span className="text-xs text-ink-secondary">°C</span>
                  {control && (
                    <button
                      className={stepBtn}
                      disabled={dis}
                      aria-label={`Promeni cilj ${String(rc.room || '')}`}
                      onClick={() =>
                        onIntent({
                          cmd: 'k3temp',
                          key: String(rc.key || ''),
                          room: String(rc.room || ''),
                          mode,
                          cur: target != null ? String(target) : '',
                        })
                      }
                    >
                      ✎
                    </button>
                  )}
                </div>
                {fanEl}
              </div>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema sobnih regulatora.</div>
        )}
      </div>

      <div className={sectionTitle}>Prekidači</div>
      {byRoom.size ? (
        [...byRoom.entries()].map(([room, list]) => (
          <div key={room} className={panel}>
            <div className="px-3 py-1.5 text-xs font-semibold text-ink-secondary">{room}</div>
            {list.map((t, i) => {
              const on = (N(live[String(O(t.states).active)]) ?? 0) > 0;
              return (
                <div key={`${String(t.key)}-${i}`} className={drow}>
                  <Lamp on={on} />
                  <span className="text-ink">{String(t.name || t.key || '?')}</span>
                  <span className="text-sm text-ink-secondary">{on ? 'ON' : 'OFF'}</span>
                  {control && (
                    <button
                      className={`${cmdBtn} ${on ? 'bg-accent-subtle' : ''}`}
                      disabled={dis}
                      onClick={() =>
                        onIntent({
                          cmd: 'k3sw',
                          key: String(t.key || ''),
                          name: String(t.name || t.key || ''),
                        })
                      }
                    >
                      {on ? 'Isključi' : 'Uključi'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))
      ) : (
        <div className={note}>Nema upravljivih prekidača.</div>
      )}
    </div>
  );
}

/* ── solar-sigen ── */
function SigenView({ ctx }: { ctx: ViewCtx }) {
  const key = 'solar-sigen';
  const p = ctx.snaps.get(key)?.payload ?? null;
  const { onIntent } = ctx;
  const sigenControl = ctx.control && O(p).control === true;
  const dis = useDis(ctx, key);
  const systems = A(O(p).systems);
  const modes = A(O(p).modes);

  return (
    <div className="space-y-2">
      <SiteHeader ctx={ctx} siteKey={key} />
      <OfflineNote ctx={ctx} siteKey={key} />

      <div className={sectionTitle}>Sistemi ({systems.length})</div>
      {systems.length ? (
        systems.map((sy, i) => {
          const id = String(sy.systemId ?? '');
          const rawMode = sigenVal(p, id, 'operatingMode');
          const modeRow = modes.find((mm) => Number(mm.value) === Number(rawMode));
          const modeName = modeRow
            ? String(modeRow.name)
            : rawMode != null
              ? `Režim ${rawMode}`
              : '—';
          const kpi: [string, string][] = [
            ['PV', `${f1(sigenVal(p, id, 'pvPower'))} kW`],
            ['Potrošnja', `${f1(sigenVal(p, id, 'loadPower'))} kW`],
            ['Mreža (±)', `${f1(sigenVal(p, id, 'gridPower'))} kW`],
            ['Baterija (±)', `${f1(sigenVal(p, id, 'batteryPower'))} kW`],
            ['Nivo baterije', `${f0(sigenVal(p, id, 'batterySoc'))} %`],
          ];
          return (
            <div key={`sys-${i}`} className="rounded-panel border border-line bg-surface p-3">
              <div className="mb-1 text-sm font-semibold text-ink">
                ☀️ {String(sy.name || id || '?')}
              </div>
              {kpi.map(([l, v]) => (
                <div key={l} className="flex justify-between py-0.5 text-sm">
                  <span className="text-ink-secondary">{l}</span>
                  <b className="tabular-nums text-ink">{v}</b>
                </div>
              ))}
              <div className="flex justify-between py-0.5 text-sm">
                <span className="text-ink-secondary">Režim rada</span>
                <b className="text-ink">{modeName}</b>
              </div>
              {sigenControl && modes.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {modes.map((mm, j) => (
                    <button
                      key={`m-${j}`}
                      className={`${segBtn} ${Number(mm.value) === Number(rawMode) ? 'bg-accent-subtle' : ''}`}
                      disabled={dis}
                      onClick={() =>
                        onIntent({
                          cmd: 'sgmode',
                          sys: id,
                          sysname: String(sy.name || id || ''),
                          mode: Number(mm.value),
                          name: String(mm.name || mm.value),
                        })
                      }
                    >
                      {String(mm.name || mm.value)}
                    </button>
                  ))}
                </div>
              ) : ctx.control && p && O(p).control !== true ? (
                <div className="mt-1 text-xs text-ink-secondary">
                  Promena režima je zaključana (cloud bez kontrole).
                </div>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className={note}>Nema konfigurisanih sistema.</div>
      )}
    </div>
  );
}

/* ── solar-kaco (read-only) ── */
function KacoView({ ctx }: { ctx: ViewCtx }) {
  const key = 'solar-kaco';
  const p = ctx.snaps.get(key)?.payload ?? null;
  const plant = O(O(p).plant);
  const list = A(O(p).inverters);
  const rep = plant.reportingInverters;
  const cnt = plant.count;

  return (
    <div className="space-y-2">
      <SiteHeader ctx={ctx} siteKey={key} />

      <div className={sectionTitle}>Postrojenje</div>
      <div className={`${panel} p-0`}>
        <div className="flex justify-between px-3 py-2 text-sm">
          <span className="text-ink-secondary">Trenutna snaga</span>
          <b className="tabular-nums text-ink">{f1(plant.kw)} kW</b>
        </div>
        <div className="flex justify-between px-3 py-2 text-sm">
          <span className="text-ink-secondary">Proizvodnja danas</span>
          <b className="tabular-nums text-ink">{f1(plant.kwhDay)} kWh</b>
        </div>
        <div className="flex justify-between px-3 py-2 text-sm">
          <span className="text-ink-secondary">Invertori javljaju</span>
          <b className="tabular-nums text-ink">
            {rep != null && cnt != null ? `${rep}/${cnt}` : '—'}
          </b>
        </div>
      </div>

      <div className={sectionTitle}>Invertori ({list.length})</div>
      <div className={panel}>
        {list.length ? (
          list.map((inv, i) => {
            const off = !inv.online;
            const pac = N(inv.pAc);
            const kw = pac != null ? (pac / 1000).toFixed(1) : '—';
            const name = `INV ${inv.address != null ? inv.address : inv.name || '?'}`;
            return (
              <div key={`inv-${i}`} className={drow}>
                <Lamp on={!off} />
                <span className="text-ink">{name}</span>
                <span className="text-sm text-ink-secondary">
                  {off ? '—' : `${kw} kW`} · {f1(inv.temp)} °C
                </span>
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${
                    off ? 'bg-status-danger-bg text-status-danger' : 'bg-status-success-bg text-status-success'
                  }`}
                >
                  {off ? 'OFFLINE' : 'RADI'}
                </span>
              </div>
            );
          })
        ) : (
          <div className="px-3 py-2 text-sm text-ink-secondary">Nema podataka o invertorima.</div>
        )}
      </div>
      <div className="text-xs text-ink-secondary">
        Solar KACO je read-only (blue&apos;Log nema kontrolni API).
      </div>
    </div>
  );
}

export function SiteView({ ctx, siteKey }: { ctx: ViewCtx; siteKey: string }) {
  if (siteKey === 'kot1') return <Kot1View ctx={ctx} />;
  if (siteKey === 'kot2') return <Kot2View ctx={ctx} />;
  if (siteKey === 'kot3') return <Kot3View ctx={ctx} />;
  if (siteKey === 'solar-sigen') return <SigenView ctx={ctx} />;
  if (siteKey === 'solar-kaco') return <KacoView ctx={ctx} />;
  return <div className="p-6 text-center text-ink-secondary">Nepoznat sistem.</div>;
}
