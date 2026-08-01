import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CalendarDays,
  CalendarRange,
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
import { PERMISSIONS, type Permission } from '@/lib/permissions';

/**
 * JEDAN izvor istine o mobilnim modulima (`/mob`) — PLAN_MOB_IZGLED_1.0_PARITET, F1.
 *
 * Koriste ga DVA ekrana: hub `/mob` (mreža kartica) i „Više" `/mob/vise` (lista svih
 * modula, paritet 1.0 `moduleEntries()` iz `src/ui/mobile/mobileAppShell.js`). Lista
 * se NE duplira — nov modul se dodaje ovde i pojavi se na oba mesta.
 *
 * Vidljivost stavke je OGLEDALO gate-a ciljnog ekrana (`requires`); stavka bez
 * `requires` je dostupna svakom prijavljenom (ciljni ekran nema permisiju).
 */

export type MobLink = {
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
export type MobEntry = MobLink & { children?: MobLink[] };

export const MOB_MODULES: MobEntry[] = [
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

/**
 * Moduli vidljivi datom korisniku. Grupa se filtrira po SVOM gate-u, pa se
 * nezavisno filtriraju pod-ulazi (npr. Neusaglašenosti traže i pravo prijave, ne
 * samo `montaza.read`). Isti rezultat koriste i hub i „Više" — bez lokalnih kopija.
 */
export function visibleMobModules(can: (permission: Permission) => boolean): MobEntry[] {
  return MOB_MODULES.filter((m) => !m.requires || can(m.requires)).map((m) =>
    m.children ? { ...m, children: m.children.filter((s) => !s.requires || can(s.requires)) } : m,
  );
}
