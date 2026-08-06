// Zvonce (D8 notifikacije) — mapiranje reda iz `app_notifications` u ono što korisnik vidi
// i u odredište klika. Izdvojeno iz `app-shell.tsx` da bi bilo pokriveno testom: obe mape
// su ogledalo backenda i tiho zastare kad se doda nov tip obaveštenja.
//
// IZVOR ISTINE (backend, mesta koja upisuju u `app_notifications`):
//   handover-drafts.service.ts     nacrt.kreiran            → handover_drafts
//   handover-drafts.service.ts     primopredaja.nova        → handover_drafts
//   handovers.service.ts           primopredaja.preuzeta    → drawing_handovers
//   handovers.service.ts           primopredaja.odbijena    → drawing_handovers
//   launch-notify.service.ts       primopredaja.lansirana   → work_orders
//   tech-processes.service.ts      kontrola.skart/dorada    → work_orders
//   montaza-neusaglasenosti.svc    montaza.neusaglasenost.nova → montage_nonconformities
//   masina-otpis-notify.service.ts odrzavanje.masina-otpis  → maint_machines
//   quality-events.service.ts      kvalitet.skart/dorada    → quality_events
//   sync/bigbit-mdb-jobs.ts        bigbit.sync.alarm        → app_switches
//
// C20 (06.08.2026): pre ove izmene mapa ruta je pokrivala 5 od 7 `ref_table` vrednosti, a
// mapa bedževa 6 od 11 tipova. Mereno na produkciji (cela istorija tabele, 1.398 redova):
// `quality_events` (12 poruka / 12 ljudi) i `app_switches` (1/1) NISU imali rutu — klik je
// samo označavao pročitanim i zatvarao panel, tj. korisniku se nije desilo baš ništa;
// 100 poruka je u panelu prikazivalo SIROV mašinski ključ („montaza.neusaglasenost.nova")
// umesto srpske labele.

import type { Tone } from '@/components/ui-kit/status-badge';

export interface NotificationBadgeMeta {
  tone: Tone;
  label: string;
}

/** Tip notifikacije → StatusBadge (kanonska mapa statusa, DESIGN_SYSTEM §7). */
export const NOTIFICATION_BADGE: Record<string, NotificationBadgeMeta> = {
  'kontrola.skart': { tone: 'danger', label: 'Škart' },
  'kontrola.dorada': { tone: 'warn', label: 'Dorada' },
  'primopredaja.nova': { tone: 'info', label: 'Primopredaja' },
  'primopredaja.preuzeta': { tone: 'info', label: 'Preuzeta izrada' },
  // Zahtev 016/26: planer dobija zvonce kad se primopredaja lansira u proizvodnju.
  // Ton/labela prate kanonsku mapu statusa RN-a (DESIGN_SYSTEM §7) — „Lansiran" je
  // info svuda drugde (work-orders, handovers), pa ne sme ovde biti success.
  'primopredaja.lansirana': { tone: 'info', label: 'Lansiran' },
  // Zahtev 037/26: šef proizvodnje dobija zvonce kad se mašina otpiše (treba da
  // preraspodeli poslove). `warn`, ne `danger` — nije kvar nego planska radnja.
  'odrzavanje.masina-otpis': { tone: 'warn', label: 'Otpis mašine' },
  // C20: šest tipova je do sada padalo na fallback i prikazivalo mašinski ključ.
  'nacrt.kreiran': { tone: 'info', label: 'Nov nacrt' },
  'primopredaja.odbijena': { tone: 'danger', label: 'Odbijena primopredaja' },
  // Prijava sa kioska iznad praga — isti tonovi kao `kontrola.*` (ista je stvar,
  // drugi tok: pogon prijavljuje, kontrola potvrđuje).
  'kvalitet.skart': { tone: 'danger', label: 'Škart' },
  'kvalitet.dorada': { tone: 'warn', label: 'Dorada' },
  'montaza.neusaglasenost.nova': { tone: 'warn', label: 'Neusaglašenost' },
  // Nadzor uvoza iz BigBita (`bigbit-mdb-jobs.ts`) — kanal koji postoji da bi se kvar VIDEO.
  'bigbit.sync.alarm': { tone: 'danger', label: 'BigBit uvoz' },
};

/** Fallback za tip koji backend uvede pre nego što ga frontend nauči. */
const FALLBACK_BADGE: NotificationBadgeMeta = { tone: 'neutral', label: 'Obaveštenje' };

/**
 * Bedž za tip notifikacije. Nepoznat tip više NE prikazuje mašinski ključ — sam tekst
 * poruke stoji odmah ispod bedža i nosi sadržaj.
 */
export function notificationBadge(type: string | null | undefined): NotificationBadgeMeta {
  return (type && NOTIFICATION_BADGE[type]) || FALLBACK_BADGE;
}

/** `ref_table` → ruta modula (funkcija prima `ref_id` za deep-link kad modul to podržava). */
export const NOTIFICATION_ROUTE: Record<string, (refId: number | null) => string> = {
  // Zahtev 016/26: klik na zvonce vodi pravo na lansirani RN (ekran već čita ?open=).
  work_orders: (id) => (id != null ? `/work-orders?open=${id}` : '/work-orders'),
  // `ref_id` (draft.id) se BACA: /nacrti nema deep-link parametar za pojedinačan nacrt.
  // Najveći kanal u sistemu (942 poruke / 15 ljudi u 30 dana) — čitač na /nacrti je
  // zaseban posao, ne stane u C20 (menja stranu, ne mapu).
  handover_drafts: () => '/nacrti',
  // Isto: /handovers ni tab ne drži u URL-u (`useState<TabKey>('pending')`).
  drawing_handovers: () => '/handovers',
  // Neusaglašenosti na montaži (zahtev 004/26): deep-link otvara detalj u tabu.
  montage_nonconformities: (id) =>
    `/montaza?view=neusaglasenosti${id != null ? `&id=${id}` : ''}`,
  // Mašina je ključana TEKSTOM (machine_code), a `ref_id` je Int → nema deep-linka na
  // karton; vodimo na registar mašina, a šifra stoji u tekstu notifikacije. (Mejl za ISTI
  // događaj gađa `/odrzavanje/masine?code=<šifra>` — asimetrija ostaje dok se ne uvede
  // tekstualni ref u šemi; svih 8 izmerenih redova ima `ref_id IS NULL`.)
  maint_machines: () => '/odrzavanje?tab=masine',
  // C20: `ref_id` je ovde event.id, ali `SkartDoradaTab` NE čita nijedan URL parametar,
  // pa bi `?event=N` bio mrtav parametar. Vodimo na tab „Škart i dorada" — isto odredište
  // koje mejl za isti događaj već šalje (quality-events-mail.service.ts).
  quality_events: () => '/kvalitet?tab=skart-dorada',
  // C20: watchdog uvoza iz BigBita. `ref_id` je tvrdo `null` (bigbit-mdb-jobs.ts), pa ruta
  // bez id-ja ništa ne gubi; prekidač i sva upozorenja žive u Podešavanja → Integracije.
  app_switches: () => '/podesavanja?tab=integracije',
};

/**
 * Ruta za red obaveštenja, ili `null` kad odredišta nema (nepoznat/prazan `ref_table`).
 * Pozivalac MORA da obradi `null` — tiho zatvaranje panela izgleda kao da je akcija
 * uspela, što je gore od greške.
 */
export function resolveNotificationRoute(
  refTable: string | null | undefined,
  refId: number | null | undefined,
): string | null {
  if (!refTable) return null;
  const build = NOTIFICATION_ROUTE[refTable];
  return build ? build(refId ?? null) : null;
}
