'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Cog,
  GraduationCap,
  DraftingCompass,
  FileText,
  Hammer,
  History,
  Layers,
  ListTodo,
  Mic,
  Monitor,
  Radar,
  Repeat,
  Search,
  UserCheck,
  UserCircle,
  Users,
  Users2,
  Warehouse,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';

/**
 * Mobilna početna `/mob` (PLAN_MOB_3.0.md, Faza 0) — kartice ka 3.0 mobilnim
 * ekranima, paritet ideje 1.0 `/m` huba. Van AppShell-a (full-screen mobilni
 * panel, isti obrazac kao `/mob/lokacije` i `/mob/prisustvo`).
 *
 * ⚠️ Prostor `/mob/*` je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`)
 * sve `/m/*` na javnom domenu proksira na 1.0 mobilnu (pages.dev), pa 3.0 stranica
 * pod `/m` tamo ne bi bila dostupna. Isti origin = APK WebView ljuska ostaje živa.
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 *
 * Vidljivost kartice je OGLEDALO gate-a ciljnog ekrana (`requires`); kartica bez
 * `requires` je dostupna svakom prijavljenom (ciljni ekran nema permisiju).
 */

type MobLink = {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Permisija ciljnog ekrana; bez nje = svaki prijavljen korisnik. */
  requires?: Permission;
};

/**
 * Stavka huba: pločica u gridu (bez `children`) ili GRUPA (pun red preko obe
 * kolone — glavni ulaz + uvučeni pod-ulazi u istom panelu). Grupa se koristi kad
 * jedan modul ima više mobilnih ulaza (Montaža: plan + izveštaj + neusaglašenosti),
 * da hub ne bude niz nepovezanih pločica istog modula.
 */
type MobEntry = MobLink & { children?: MobLink[] };

const CARDS: MobEntry[] = [
  {
    // GRUPA (kao Montaža): jedan modul, više mobilnih ulaza — glavni je sken/
    // premeštanje, deca su magacin ekstre iz Faze 2 (1.0 `/m/lookup`, `/m/batch`,
    // `/m/history`). Gate grupe = LOKACIJE_READ; batch traži i `lokacije.move`,
    // pa ekran (ne kartica) presuđuje — kartica ostaje ogledalo READ gate-a, a
    // radnik bez `move` unutra vidi jasnu poruku umesto skrivene stavke.
    href: '/mob/lokacije',
    label: 'Magacin / Lokacije',
    hint: 'skeniraj deo → gde stoji → premesti',
    icon: Warehouse,
    requires: PERMISSIONS.LOKACIJE_READ,
    children: [
      {
        href: '/mob/lokacije/pretraga',
        label: 'Gde je crtež?',
        hint: 'broj crteža → police i količine',
        icon: Search,
      },
      {
        href: '/mob/lokacije/batch',
        label: 'Batch premeštanje',
        hint: 'jedna polica → skeniraj delove u nizu',
        icon: Layers,
      },
      {
        href: '/mob/lokacije/istorija',
        label: 'Moja istorija',
        hint: 'moja poslednja premeštanja',
        icon: History,
      },
    ],
  },
  {
    // Klasni BE gate modula je `reversi.read`; povraćaj/izdavanje unutra traže
    // `reversi.manage` (dugmad se tada i prikazuju) — kartica nosi READ gate.
    href: '/mob/reversi',
    label: 'Moji reversi',
    hint: 'zaduženi alat, LZO, rezni, potrošeno',
    icon: Repeat,
    requires: PERMISSIONS.REVERSI_READ,
  },
  {
    href: '/mob/prisustvo',
    label: 'Prisustvo uživo',
    hint: 'ko je prisutan, na pauzi, odsutan',
    icon: Users,
    requires: PERMISSIONS.KADROVSKA_ATTENDANCE,
  },
  {
    // HR read-only pregled — `kadrovska.read` je KANON vidljivosti modula
    // (paritet 1.0 canAccessKadrovska); stroža prava (ugovori/PII) su unutra.
    href: '/mob/kadrovska',
    label: 'Kadrovska',
    hint: 'zaposleni, ugovori, odsustva (pregled)',
    icon: Users2,
    requires: PERMISSIONS.KADROVSKA_READ,
  },
  {
    // Ekran nema eksplicitnu permisiju (guard = prijava; `profile.self` ima svaka
    // rola, a RPC „own ∨ manager" presuđuje red) → kartica za sve prijavljene.
    href: '/mob/moje-prisustvo',
    label: 'Moje prisustvo',
    hint: 'moji prolazi + prijava korekcije',
    icon: UserCheck,
  },
  {
    // „Za mene" živi na `sastanci` endpoint-ima (/my, /akcije, /teme) — svi su iza
    // class-level `sastanci.read` na BE-u, pa kartica nosi ISTI gate kao Sastanci.
    href: '/mob/za-mene',
    label: 'Za mene',
    hint: 'moje akcije, sastanci, predlozi',
    icon: ListTodo,
    requires: PERMISSIONS.SASTANCI_READ,
  },
  {
    // Self-service (`profile.self` ima svaka rola) → kartica za sve prijavljene.
    href: '/mob/odsustva',
    label: 'Odsustva / GO',
    hint: 'saldo, zahtev za godišnji, rešenje',
    icon: CalendarDays,
  },
  {
    // Isto: „Moji sati" je self-service karnet (profile.self), bez posebne permisije.
    href: '/mob/sati',
    label: 'Moji sati',
    hint: 'mesečni sati + primedba HR-u',
    icon: Clock,
  },
  {
    // Ekran sam rešava prazno stanje (nema aktivnog run-a) — kartica za sve.
    href: '/mob/onboarding',
    label: 'Uvođenje',
    hint: 'moji zadaci uvođenja — štikliraj sam',
    icon: GraduationCap,
  },
  {
    href: '/mob/odobravanja',
    label: 'Odobravanja',
    hint: 'zahtevi tima — odobri, odbij, pomeri',
    icon: ClipboardCheck,
    requires: PERMISSIONS.KADROVSKA_VACREQ_MANAGE,
  },
  {
    href: '/mob/montaza',
    label: 'Montaža',
    hint: 'plan, faze, izveštaji',
    icon: Hammer,
    requires: PERMISSIONS.MONTAZA_READ,
    children: [
      {
        // Gate ciljnog ekrana = montaza.read, već pokriven gate-om grupe.
        href: '/mob/izvestaj',
        label: 'Izveštaj',
        hint: 'tekst + fotke → AI → PDF',
        icon: FileText,
      },
      {
        href: '/mob/neusaglasenosti',
        label: 'Neusaglašenosti',
        hint: 'prijavi odstupanje — slikaj i pošalji',
        icon: AlertTriangle,
        requires: PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE,
      },
    ],
  },
  {
    // Projektni biro — klasni BE gate `/v1/pb` je `pb.read` (svi prijavljeni ga
    // imaju po katalogu); izmena napretka unutra traži `pb.progress`.
    href: '/mob/projektovanje',
    label: 'Projektovanje',
    hint: 'moji PB zadaci — status i procenat',
    icon: DraftingCompass,
    requires: PERMISSIONS.PB_READ,
  },
  {
    href: '/mob/odrzavanje',
    label: 'Održavanje',
    hint: 'karton sredstva, prijava kvara, QR',
    icon: Cog,
    requires: PERMISSIONS.ODRZAVANJE_READ,
  },
  {
    // Ekran nema read gate (1.0 paritet: pogonski radnici su primarni korisnici;
    // PRACENJE_READ bi sakrio karticu monterima/CNC-u) — override unutra čuva
    // PRACENJE_MANAGE.
    href: '/mob/pracenje',
    label: 'Praćenje',
    hint: 'predmeti → pozicije → status',
    icon: Radar,
  },
  {
    // Isto: operater na mašini je ciljni korisnik, ekran bez read gate-a;
    // izmene unutra čuva PLAN_PROIZVODNJE_EDIT.
    href: '/mob/proizvodnja',
    label: 'Proizvodnja',
    hint: 'red operacija po mašini',
    icon: CalendarRange,
  },
  {
    href: '/mob/sastanci',
    label: 'Sastanci',
    hint: 'pregled, RSVP, status akcija',
    icon: CalendarClock,
    requires: PERMISSIONS.SASTANCI_READ,
  },
  {
    // Self-service raskrsnica (`profile.self` ima svaka rola) → svi prijavljeni.
    href: '/mob/profil',
    label: 'Moj profil',
    hint: 'GO saldo, opis pozicije, moj tim',
    icon: UserCircle,
  },
  {
    href: '/mob/energetika',
    label: 'Energetika',
    hint: 'SCADA nadzor + touch komande',
    icon: Zap,
    requires: PERMISSIONS.ENERGETIKA_READ,
  },
  {
    href: '/mob/ai',
    label: 'AI asistent',
    hint: 'pitaj o nalozima, predmetima, planu',
    icon: Bot,
    requires: PERMISSIONS.AI_CHAT,
  },
  {
    // Diktafon (scenario B): telefon diktira srpski, tekst ide u „sanduče", Claude
    // Code ga povuče na računaru. Isti gate kao STT/refine (ai.chat).
    href: '/mob/diktafon',
    label: 'Diktiraj za Claude',
    hint: 'govori srpski → tekst → pošalji na računar',
    icon: Mic,
    requires: PERMISSIONS.AI_CHAT,
  },
];

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

export default function MobHubPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen korisnik na svež login video prazan hub.
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // Pad učitavanja dozvola (retry:false — ostaje za sesiju) ≠ stvarna zabrana.
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  // Grupa se filtrira po svom gate-u, pa se nezavisno filtriraju pod-ulazi
  // (npr. Neusaglašenosti traže i pravo prijave, ne samo montaza.read).
  const visible = CARDS.filter((c) => !c.requires || can(c.requires)).map((c) =>
    c.children
      ? { ...c, children: c.children.filter((s) => !s.requires || can(s.requires)) }
      : c,
  );

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">ServoSync</h1>
          <p className="truncate text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
        </div>
        <Link
          href="/"
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-control border border-line bg-surface-2 px-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <Monitor className="h-4 w-4" aria-hidden />
          Desktop verzija
        </Link>
      </header>

      <main className="p-4">
        {visible.length === 0 ? (
          <EmptyState
            title="Nema dostupnih modula"
            hint="Vaša uloga nema pristup nijednom mobilnom ekranu — javite se administratoru."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map((c) => {
              const Icon = c.icon;

              // Grupa (Montaža): pun red, glavni ulaz + pod-ulazi u istom panelu.
              // Bez `overflow-hidden` — fokus prsten je spoljna senka i bio bi odsečen;
              // uglovi se zato zaokružuju po redu (prvi/poslednji).
              if (c.children) {
                const subs = c.children;
                return (
                  <div
                    key={c.href}
                    className="col-span-2 rounded-panel border border-line bg-surface"
                  >
                    <Link
                      href={c.href}
                      className={`flex min-h-14 items-center gap-3 p-4 active:bg-surface-2 ${
                        subs.length === 0 ? 'rounded-panel' : 'rounded-t-panel'
                      } ${FOCUS}`}
                    >
                      <Icon className="h-7 w-7 shrink-0 text-accent" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-ink">{c.label}</span>
                        <span className="block text-xs text-ink-secondary">{c.hint}</span>
                      </span>
                      <ChevronRight className="h-5 w-5 shrink-0 text-ink-disabled" aria-hidden />
                    </Link>

                    {subs.map((s, i) => {
                      const SubIcon = s.icon;
                      return (
                        <Link
                          key={s.href}
                          href={s.href}
                          className={`flex min-h-11 items-center gap-3 border-t border-line py-2.5 pl-6 pr-4 active:bg-surface-2 ${
                            i === subs.length - 1 ? 'rounded-b-panel' : ''
                          } ${FOCUS}`}
                        >
                          <SubIcon className="h-5 w-5 shrink-0 text-ink-secondary" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-ink">{s.label}</span>
                            <span className="block text-xs text-ink-secondary">{s.hint}</span>
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                        </Link>
                      );
                    })}
                  </div>
                );
              }

              return (
                <Link
                  key={c.href}
                  href={c.href}
                  className={`flex min-h-24 flex-col gap-2 rounded-panel border border-line bg-surface p-4 active:bg-surface-2 ${FOCUS}`}
                >
                  <Icon className="h-7 w-7 shrink-0 text-accent" aria-hidden />
                  <span className="text-sm font-semibold text-ink">{c.label}</span>
                  <span className="text-xs text-ink-secondary">{c.hint}</span>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
