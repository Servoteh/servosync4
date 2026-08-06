'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  FileText,
  GanttChartSquare,
  Layers,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useQueryTab } from '@/lib/use-query-tab';
import { consumeParam, parseIdParam } from '@/lib/deep-link';
import { AppShell, WideMode } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/app/reversi/_components/tabs';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { PlanTab } from './_components/plan-tab';
import { GanttTab } from './_components/gantt-tab';
import { TotalGanttTab } from './_components/total-gantt-tab';
import { NeusaglasenostiTab } from './_components/neusaglasenosti-tab';

type ViewKey = 'hub' | 'plan' | 'gantt' | 'total' | 'izvestaji' | 'neusaglasenosti';

/** Pogledi modula — hub kartice + tab traka (redosled kao 1.0 view tabs). */
const VIEWS: { key: Exclude<ViewKey, 'hub'>; label: string; icon: LucideIcon; desc: string }[] = [
  { key: 'plan', label: 'Plan', icon: Table2, desc: 'Tabela faza po pozicijama — statusi, procenti, rokovi' },
  { key: 'gantt', label: 'Gantt', icon: GanttChartSquare, desc: 'Vremenska linija faza aktivnog projekta' },
  { key: 'total', label: 'Ukupan Gant', icon: Layers, desc: 'Svi projekti na jednoj vremenskoj osi' },
  { key: 'izvestaji', label: 'Izveštaji', icon: FileText, desc: 'AI servisni izveštaji montera — tekst i fotke u PDF' },
  {
    key: 'neusaglasenosti',
    label: 'Neusaglašenosti',
    icon: AlertTriangle,
    desc: 'Prijava i praćenje odstupanja na montaži (zahtev 004/26)',
  },
];

/** Samo konkretni pogledi su validni deep-linkovi; sve ostalo → hub. */
const VALID = new Set<ViewKey>(['plan', 'gantt', 'total', 'izvestaji', 'neusaglasenosti']);

/**
 * Čitač JEDNOKRATNOG deep-link parametra `?id=<neusaglašenost>` (mejl menadžmentu i zvonce:
 * `/montaza?view=neusaglasenosti&id=N`). Renderuje `null` — kanon iz buga 077/26.
 *
 * Zašto `useSearchParams`, uz repo-pravilo da ga izbegavamo: parametar se do sada čitao u
 * efektu sa PRAZNIM nizom zavisnosti, tj. samo pri montiranju. Next App Router NAMERNO
 * izostavlja query iz ključa za remount (`createRouterCacheKey(activeSegment, true)`), pa
 * `/montaza` → `/montaza?view=neusaglasenosti&id=12` ne remontira stranu i nov `id` se tiho
 * gubi — a zvonce stoji na SVAKOJ strani, uključujući samu Montažu, pa taj slučaj okida
 * redovno. `popstate` ne pomaže (`router.push` ga ne okida), a `servosync:nav` ovde ne bi
 * mogao da „potroši" parametar u pravom trenutku (URL se menja tek posle push-a).
 *
 * Čitač je zato izdvojen u komponentu koja vraća `null` i stoji pod `<Suspense fallback={null}>`
 * ISPOD auth-gejta — bailout pogađa samo to prazno podstablo, pa strana ostaje statički
 * prerenderovana (provereno u izlazu `next build`: `/montaza` je `○ (Static)`).
 *
 * Troši se ISKLJUČIVO `id`. `view` je TRAJNO stanje adrese (bookmark/F5/highlight podstavke
 * u sidebaru moraju da pogode isti pogled) i nikad se ne skida.
 */
function DeepLinkNcParam({ onOpen }: { onOpen: (id: number) => void }) {
  const params = useSearchParams();
  const raw = params.get('id');
  useEffect(() => {
    const id = parseIdParam(raw);
    if (id == null) return;
    onOpen(id);
    consumeParam('id');
  }, [raw, onOpen]);
  return null;
}

/**
 * Plan montaže — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md). Hub landing + 4 pogleda
 * (Plan / Gantt / Ukupan Gant / Izveštaji) sa deep-link-om `?view=`. Paritet 1.0
 * planMontaze/index.js: bez ?view= parametra ulaz je HUB (izbor prikaza karticama);
 * ?view=plan|gantt|total|izvestaji vodi pravo u pogled. Modul „Montaža" je UNGATED
 * u 1.0 → svaka aktivna rola ulazi; edit/izveštaji gate-ovi su per-akcija.
 */
export default function MontazaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  // Pogled živi u `?view=` kroz deljeni hook (PLAN_NAV_PODMENIJI §4.3): čita na mount-u,
  // prati `popstate` i `servosync:nav` (klik na stavku „Montaža → Gantt" u sidebaru/paleti
  // menja pogled i kad smo VEĆ na /montaza — Next tada ne remount-uje stranu), a `changeView`
  // upisuje URL nazad. `omitDefault` čuva 1.0 paritet: hub = /montaza BEZ `?view=`.
  const [view, changeView] = useQueryTab<ViewKey>('view', 'hub', { valid: VALID, omitDefault: true });
  // Deep-link ka konkretnoj neusaglašenosti (mejl menadžmentu i zvonce:
  // `?view=neusaglasenosti&id=N`). Sam parametar čita <DeepLinkNcParam> (vidi komentar uz
  // tu komponentu); ovde ostaje samo reakcija. `null` = nema aktivnog deep-linka.
  const [deepLinkNcId, setDeepLinkNcId] = useState<number | null>(null);
  // Tab javlja kad je otvorio detalj → gasimo signal. Bez ovoga bi prop ostao postavljen,
  // pa bi svaki povratak na pogled „Neusaglašenosti" ponovo otvarao isti zapis (isti kvar
  // kao viseći `?id=` u adresi, samo u React stanju).
  const consumeNcDeepLink = useCallback(() => setDeepLinkNcId(null), []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  // Tab traka (samo van huba): „Meni" vraća na hub — paritet 1.0 view tabs.
  const tabs: TabItem<ViewKey>[] = [{ key: 'hub', label: 'Meni' }, ...VIEWS];

  return (
    <AppShell>
      {/* Renderuje `null` — vidi komentar uz DeepLinkNcParam zašto stoji pod Suspense-om. */}
      <Suspense fallback={null}>
        <DeepLinkNcParam onOpen={setDeepLinkNcId} />
      </Suspense>
      {/* Gantt pogledi su „široki": sidebar se auto-sklanja dok su aktivni (F1 shell);
          hub/plan/izveštaji zadržavaju normalan raspored. */}
      <WideMode active={view === 'gantt' || view === 'total'} />
      <PageHeader title="Plan montaže" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        {view === 'hub' ? (
          <div className="mx-auto w-full max-w-3xl">
            <h2 className="mb-4 text-sm font-medium text-ink-secondary">Izaberite prikaz</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {VIEWS.map((v) => {
                const Icon = v.icon;
                return (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => changeView(v.key)}
                    className="flex flex-col items-start gap-2 rounded-panel border border-line bg-surface p-4 text-left transition-colors hover:bg-surface-2"
                  >
                    <Icon className="h-7 w-7 text-accent" aria-hidden />
                    <span className="text-sm font-semibold text-ink">{v.label}</span>
                    <span className="text-xs text-ink-secondary">{v.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <Tabs tabs={tabs} value={view} onChange={changeView} ariaLabel="Pogledi Plana montaže" />

            {view === 'plan' && <PlanTab />}
            {view === 'gantt' && <GanttTab />}
            {view === 'total' && <TotalGanttTab />}
            {view === 'izvestaji' && <IzvestajiTab />}
            {view === 'neusaglasenosti' && (
              <NeusaglasenostiTab deepLinkId={deepLinkNcId} onDeepLinkConsumed={consumeNcDeepLink} />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
