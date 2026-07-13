'use client';

// Touch-first Energetika — `/m/energetika` (presuda E2: iframe HMI ne radi na telefonu
// → native touch kontrole). Ljuska + tok komandi; prikazi su u ./_components/views.
// Gate: energetika.read (admin+menadzment). KOMANDE su R3 stub (COMMANDS_ENABLED=false
// → `control` je false, kontrole se ne prikazuju); tok (potvrda → insert → poll →
// cancel-on-timeout) je IMPLEMENTIRAN i spreman za E R2 (semantika ZAMRZNUTA).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  sendScadaCommandFlow,
  useActiveAlarms,
  useRecentCommands,
  useScadaSites,
  useScadaSnapshots,
} from '@/api/energetika';
import {
  COMMANDS_ENABLED,
  K1_SP_RANGES,
  k1Val,
  type ScadaSnapshotRow,
} from '@/lib/scada';
import { OverviewView, SiteView, type CmdIntent, type ViewCtx } from './_components/views';

type ModalState =
  | { kind: 'confirm'; text: string }
  | { kind: 'prompt'; title: string; hint?: string; value: string; inputMode: string };

export default function MobileEnergetikaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();

  const [view, setView] = useState<'overview' | 'site'>('overview');
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [cmdBusy, setCmdBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [promptVal, setPromptVal] = useState('');
  const resolverRef = useRef<((v: unknown) => void) | null>(null);
  const aliveRef = useRef(true);

  const readOk = can(PERMISSIONS.ENERGETIKA_READ);
  const control = can(PERMISSIONS.ENERGETIKA_CONTROL) && COMMANDS_ENABLED;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const snapshotsQ = useScadaSnapshots(readOk);
  const sitesQ = useScadaSites(readOk);
  const alarmsQ = useActiveAlarms(readOk);
  const commandsQ = useRecentCommands(10, readOk);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-ink-secondary">Učitavanje…</main>;
  }

  if (!readOk) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center">
        <div>
          <div className="text-4xl">🔒</div>
          <h1 className="mt-2 text-lg font-semibold text-ink">Nemaš pristup</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Energetika / SCADA je dostupna samo administratorima i menadžmentu.
          </p>
        </div>
      </main>
    );
  }

  const snaps = new Map<string, ScadaSnapshotRow>(
    (snapshotsQ.data?.data ?? []).map((s) => [s.siteKey, s]),
  );

  // ── modali (promise-based, paritet 1.0 confirmModal/promptSheet) ──
  function confirmModal(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      resolverRef.current = resolve as (v: unknown) => void;
      setModal({ kind: 'confirm', text });
    });
  }
  function promptSheet(cfg: {
    title: string;
    hint?: string;
    value: string;
    inputMode?: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      resolverRef.current = resolve as (v: unknown) => void;
      setPromptVal(cfg.value);
      setModal({ kind: 'prompt', title: cfg.title, hint: cfg.hint, value: cfg.value, inputMode: cfg.inputMode || 'decimal' });
    });
  }
  function closeModal(result: unknown) {
    const r = resolverRef.current;
    resolverRef.current = null;
    setModal(null);
    r?.(result);
  }

  // ── komandni tok (paritet 1.0 runCommand — ZAMRZNUTA semantika; R3 stub) ──
  async function runCommand(vars: {
    siteKey: string;
    target: string;
    value: Record<string, unknown>;
    label: string;
  }) {
    if (!control) return;
    if (cmdBusy) {
      setToast('⏳ Sačekaj — prethodna komanda još traje.');
      return;
    }
    const ok = await confirmModal(vars.label);
    if (!ok) return;
    setCmdBusy(vars.target);
    const res = await sendScadaCommandFlow(
      { siteKey: vars.siteKey, target: vars.target, value: vars.value },
      { onToast: (m) => setToast(m), shouldContinue: () => aliveRef.current },
    );
    if (res.ok) setToast('✅ Komanda primenjena');
    else if (res.error) setToast(`🚫 ${res.error}`);
    setCmdBusy(null);
    void qc.invalidateQueries({ queryKey: ['energetika'] });
  }

  // ── intent iz view-a → sastavi {target,value,label} (paritet handleCommandClick) ──
  async function handleIntent(i: CmdIntent) {
    const pOf = (k: string) => snaps.get(k)?.payload ?? null;

    // kot1
    if (i.cmd === 'k1sp') {
      const sp = String(i.sp);
      const cur = k1Val(pOf('kot1'), sp);
      const base = cur ?? 20;
      const [min, max] = K1_SP_RANGES[sp] || [5, 35];
      const nv = Math.min(max, Math.max(min, Math.round((base + Number(i.d)) * 2) / 2));
      if (!Number.isFinite(nv)) return;
      if (cur != null && nv === cur) {
        setToast(`⚠ ${sp}: dozvoljeni opseg je ${min}–${max} °C.`);
        return;
      }
      return runCommand({ siteKey: 'kot1', target: sp, value: { v: nv }, label: `Kotlarnica 1 · ${sp} → ${nv} °C` });
    }
    if (i.cmd === 'k1mode') {
      const tag = String(i.tag);
      const cur = (k1Val(pOf('kot1'), tag) ?? 0) > 0 ? 1 : 0;
      const next = cur ? 0 : 1;
      const human =
        tag === 'GREJ_HLAD'
          ? next === 1
            ? 'HLAĐENJE'
            : 'GREJANJE'
          : next === 1
            ? 'AUTO'
            : 'RUČNO upravljanje';
      return runCommand({ siteKey: 'kot1', target: tag, value: { v: next }, label: `Kotlarnica 1 · prebaci na ${human}` });
    }
    if (i.cmd === 'k1man') {
      const tag = String(i.tag);
      const on = (k1Val(pOf('kot1'), tag) ?? 0) > 0;
      return runCommand({
        siteKey: 'kot1',
        target: tag,
        value: { v: on ? 0 : 1 },
        label: `Kotlarnica 1 · ${tag.replace('RK_', '')} ručno ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}`,
      });
    }
    if (i.cmd === 'k1reset') {
      return runCommand({ siteKey: 'kot1', target: 'RESET_VFD', value: { v: 1 }, label: 'Kotlarnica 1 · Reset greške frekventnog regulatora (VFD)' });
    }

    // kot2
    if (i.cmd === 'k2sp') {
      const cur = Number((pOf('kot2') as Record<string, unknown> | null)?.setpoint);
      const base = Number.isFinite(cur) ? cur : 20;
      const nv = Math.max(10, Math.min(30, Math.round(base + Number(i.d))));
      return runCommand({ siteKey: 'kot2', target: 'Zeljena_temperatura', value: { v: nv }, label: `Kotlarnica 2 · zadata temperatura → ${nv} °C` });
    }
    if (i.cmd === 'k2mode') {
      const tag = String(i.tag);
      const name = String(i.name || tag);
      return runCommand({ siteKey: 'kot2', target: tag, value: { v: 1 }, label: `Kotlarnica 2 · prebaci na ${name}` });
    }
    if (i.cmd === 'k2boiler') {
      const modes = (pOf('kot2') as Record<string, unknown> | null)?.modes as Record<string, unknown> | undefined;
      const on = !!modes?.boiler;
      return runCommand({
        siteKey: 'kot2',
        target: 'Web_Ukljucenje_kotla_rucno',
        value: { v: on ? 0 : 1 },
        label: `Kotlarnica 2 · kotao (ručno) ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}`,
      });
    }
    if (i.cmd === 'k2pump' || i.cmd === 'k2kal') {
      const p = pOf('kot2') as Record<string, unknown> | null;
      const list = (i.cmd === 'k2pump' ? p?.pumps : p?.kaloriferi) as Record<string, unknown>[] | undefined;
      const item = (list || []).find((x) => String(x.key) === String(i.key));
      if (!item?.cmd) return;
      return runCommand({
        siteKey: 'kot2',
        target: String(item.cmd),
        value: { v: item.on ? 0 : 1 },
        label: `Kotlarnica 2 · ${item.label || item.key} ${item.on ? 'ISKLJUČITI' : 'UKLJUČITI'}`,
      });
    }
    if (i.cmd === 'k2sched') {
      const wvar = String(i.var || '');
      const hala = String(i.hala ?? '');
      const kind = i.kind === 'poc' ? 'početak' : 'kraj';
      if (!wvar) return;
      const raw = await promptSheet({
        title: `Hala ${hala} — ${kind} rada`,
        hint: 'Sat: ceo broj 0–23',
        value: String(i.cur ?? '0'),
        inputMode: 'numeric',
      });
      if (raw == null) return;
      const n = parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n) || n < 0 || n > 23) {
        setToast('⚠ Sat mora biti ceo broj 0–23.');
        return;
      }
      return runCommand({ siteKey: 'kot2', target: wvar, value: { v: n }, label: `Kotlarnica 2 · Hala ${hala}: ${kind} rada → ${n}:00 h` });
    }
    if (i.cmd === 'k2areset') {
      const tag = String(i.tag);
      const text = String(i.text || tag);
      return runCommand({ siteKey: 'kot2', target: tag, value: { v: 1 }, label: `Kotlarnica 2 · RESET alarma: ${text}` });
    }

    // kot3
    if (i.cmd === 'k3temp') {
      const key = String(i.key || '');
      const room = String(i.room || 'Soba');
      const mode = i.mode === 'cool' ? 'cool' : 'heat';
      const raw = await promptSheet({
        title: `${room} — ciljna temperatura`,
        hint: `Opseg 5–35 °C · režim: ${mode === 'cool' ? '❄ hlađenje' : '🔥 grejanje'}`,
        value: String(i.cur ?? '22'),
        inputMode: 'decimal',
      });
      if (raw == null) return;
      const nRaw = Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(nRaw) || nRaw < 5 || nRaw > 35) {
        setToast('⚠ Temperatura mora biti 5–35 °C.');
        return;
      }
      const nv = Math.round(nRaw * 2) / 2;
      return runCommand({
        siteKey: 'kot3',
        target: `room:${key}`,
        value: { v: nv, mode },
        label: `Kotlarnica 3 · ${room}: ${mode === 'cool' ? 'hlađenje' : 'grejanje'} — cilj → ${nv} °C`,
      });
    }
    if (i.cmd === 'k3fan') {
      const key = String(i.key || '');
      const n = Number(i.n);
      const room = String(i.room || 'Soba');
      return runCommand({ siteKey: 'kot3', target: `${key}:value`, value: { v: n }, label: `Kotlarnica 3 · ${room}: ventilator brzina ${n}` });
    }
    if (i.cmd === 'k3sw') {
      const key = String(i.key || '');
      const name = String(i.name || key);
      const p = pOf('kot3') as Record<string, unknown> | null;
      const tags = (p?.tags as Record<string, unknown>[] | undefined) || [];
      const live = (p?.live as Record<string, unknown> | undefined) || {};
      const activeUuid = (tags.find((t) => String(t.key) === key)?.states as Record<string, unknown> | undefined)?.active;
      const on = Number(live[String(activeUuid)]) > 0;
      return runCommand({
        siteKey: 'kot3',
        target: `${key}:value`,
        value: { v: on ? 0 : 1 },
        label: `Kotlarnica 3 · ${name} ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}`,
      });
    }

    // solar-sigen
    if (i.cmd === 'sgmode') {
      const sys = String(i.sys || '');
      const mode = Number(i.mode);
      const name = String(i.name || mode);
      const sysName = String(i.sysname || sys);
      return runCommand({
        siteKey: 'solar-sigen',
        target: 'operatingMode',
        value: { systemId: sys, mode },
        label: `${sysName} · režim rada → ${name}`,
      });
    }
  }

  const ctx: ViewCtx = {
    sites: sitesQ.data,
    snaps,
    alarms: alarmsQ.data ?? [],
    commands: commandsQ.data ?? [],
    control,
    cmdBusy,
    onIntent: (i) => void handleIntent(i),
    onOpenSite: (k) => {
      setSiteKey(k);
      setView('site');
    },
    onBackOverview: () => {
      setView('overview');
      setSiteKey(null);
    },
  };

  function onBack() {
    if (view === 'site') {
      setView('overview');
      setSiteKey(null);
    } else {
      // Sa pregleda nazad na desktop ljusku (toggle „Touch prikaz" vodi ovamo).
      router.push('/energetika');
    }
  }

  const loading = snapshotsQ.isLoading && !snapshotsQ.data;

  return (
    <div className="flex min-h-screen flex-col bg-app">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Nazad"
          className="grid h-9 w-9 place-items-center rounded-control text-lg text-ink hover:bg-surface-2"
        >
          ←
        </button>
        <div>
          <div className="font-semibold text-ink">⚡ Energetika</div>
          <div className="text-xs text-ink-secondary">Kotlarnice · solari · komande</div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="grid place-items-center py-20 text-ink-secondary">
            <div className="text-3xl">⏳</div>
            <div className="mt-2">Učitavam stanje sistema…</div>
          </div>
        ) : snapshotsQ.isError ? (
          <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
            ⚠️ Podaci se nisu učitali (mreža/dozvola) — prikaz može biti zastareo.
          </div>
        ) : view === 'site' && siteKey ? (
          <SiteView ctx={ctx} siteKey={siteKey} />
        ) : (
          <OverviewView ctx={ctx} />
        )}
      </main>

      {/* Potvrda / unos vrednosti (paritet 1.0 confirmModal/promptSheet). */}
      {modal && (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-black/40 p-3 sm:place-items-center"
          onClick={() => closeModal(modal.kind === 'prompt' ? null : false)}
          role="presentation"
        >
          <div
            className="w-full max-w-md rounded-panel border border-line bg-surface p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {modal.kind === 'confirm' ? (
              <>
                <div className="text-md font-semibold text-ink">Potvrda komande</div>
                <p className="mt-2 whitespace-pre-line text-sm text-ink">{modal.text}</p>
                <p className="mt-2 text-xs text-status-warn">
                  ⚠️ Komanda se šalje na živo postrojenje.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    className="rounded-control px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-2"
                    onClick={() => closeModal(false)}
                  >
                    Otkaži
                  </button>
                  <button
                    className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
                    onClick={() => closeModal(true)}
                  >
                    Potvrdi
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-md font-semibold text-ink">{modal.title}</div>
                {modal.hint && <p className="mt-1 text-sm text-ink-secondary">{modal.hint}</p>}
                <input
                  className="mt-3 w-full rounded-control border border-line bg-surface px-3 py-2 text-ink"
                  type="text"
                  inputMode={modal.inputMode as 'decimal' | 'numeric'}
                  autoComplete="off"
                  enterKeyHint="done"
                  autoFocus
                  value={promptVal}
                  onChange={(e) => setPromptVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      closeModal(promptVal);
                    } else if (e.key === 'Escape') {
                      closeModal(null);
                    }
                  }}
                  aria-label={modal.title}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    className="rounded-control px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-2"
                    onClick={() => closeModal(null)}
                  >
                    Otkaži
                  </button>
                  <button
                    className="rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
                    onClick={() => closeModal(promptVal)}
                  >
                    Dalje
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-24px)] max-w-md -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2.5 text-sm text-ink shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
