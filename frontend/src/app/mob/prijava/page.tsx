'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useChangePassword } from '@/api/auth';
import { ApiError } from '@/api/client';
import { isSafeInternalPath } from '@/lib/safe-path';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';

/**
 * Prijava U SCOPE-U instalirane mobilne aplikacije (`/mob/prijava`).
 *
 * 🔴 ZAŠTO POSTOJI IAKO `/login` VEĆ POSTOJI:
 * `mob.webmanifest` od 02.08.2026 ima `scope: "/mob"` (ranije `/`), da 3.0 WebAPK na
 * Androidu ne bi polagao pravo na CEO origin — a na tom origin-u pod `/m` živi STARA
 * 1.0 mobilna (Cloudflare `worker/index.ts` je proksira). Cena uskog scope-a je poznata
 * zamka: instalirana aplikacija svaku navigaciju VAN scope-a otvara spolja (Android:
 * pregledač u zasebnom prozoru; iOS: Safari, koji od 16.4 ima ODVOJEN storage). Da su
 * ~26 `/mob` ekrana i dalje na istek sesije slali na `/login`, radnik bi se prijavljivao
 * u Safariju, token bi pao u pogrešnu teglu, a povratak u aplikaciju bi ga opet zatekao
 * odjavljenog — beskonačna petlja prijave.
 * Zato `/mob` guard-ovi vode OVDE. `/login` ostaje netaknut za desktop i za već
 * instalirane ljuske sa starim (`/`) scope-om — i one rade, jer je `/mob/prijava`
 * unutar oba scope-a.
 *
 * Ekran pokriva OBA vanredna toka koja bi inače izbacila iz aplikacije:
 *   1. nema sesije            → forma za prijavu;
 *   2. `mustChangePassword`   → forma za novu lozinku (B2; `lib/auth-context.tsx` za
 *      `/mob` putanje forsira ovu rutu umesto `/promena-lozinke`).
 * Posle uspeha se ide na zapamćen `/mob` deep-link, inače na `/mob` — nikad kroz
 * `landingRoute()`, jer bi hub-uloge sletele na `/pocetna`, dakle van scope-a.
 *
 * Markup je namerno „mobilni blizanac", ne deljena komponenta sa `/login` i
 * `/promena-lozinke`: `/mob` ekrani su i inače zasebne, touch-first implementacije
 * (mob/kadrovska, mob/odsustva…), a logika — jedini deo koji sme da se raziđe — ide
 * kroz iste hook-ove (`useAuth().login`, `useChangePassword`).
 */

/** Min. dužina nove lozinke (paritet backend B2 i `/promena-lozinke`). */
const MIN_LEN = 8;

/** Meta posle prijave — UVEK unutar `/mob` (scope instalirane aplikacije). */
function cilj(): string {
  try {
    const entry = sessionStorage.getItem('ss2.entryPath');
    sessionStorage.removeItem('ss2.entryPath');
    // `ss2.entryPath` pamti AuthProvider pre nego što guard preusmeri (deep-link iz 1.0
    // prečice ili notifikacije). Van `/mob` ga NE poštujemo: izlazak iz scope-a odmah
    // posle prijave je tačno ono što ovaj ekran sprečava; `/mob/prijava` bi bila petlja.
    if (
      isSafeInternalPath(entry) &&
      entry.startsWith('/mob') &&
      !entry.startsWith('/mob/prijava')
    ) {
      return entry;
    }
  } catch {
    /* sessionStorage blokiran — `/mob` je uvek ispravna meta */
  }
  return '/mob';
}

export default function MobPrijavaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const forced = user?.mustChangePassword === true;

  // Prijavljen i bez prinudne promene → nazad u aplikaciju.
  useEffect(() => {
    if (isLoading || !user || forced) return;
    router.replace(cilj());
  }, [user, isLoading, forced, router]);

  if (isLoading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-app px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-ink">
            SERVOSYNC{' '}
            <span className="align-middle rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-bold text-accent">
              3.0
            </span>
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {forced ? 'Postavi novu lozinku pre nastavka.' : 'Servoteh · mobilni'}
          </p>
        </div>

        {forced ? <NovaLozinkaForma /> : <PrijavaForma />}
      </div>
    </main>
  );
}

/** Forma prijave (email + lozinka). Enter šalje (native submit). */
function PrijavaForma() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [lozinka, setLozinka] = useState('');
  const [greske, setGreske] = useState<{ email?: string; lozinka?: string; root?: string }>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: { email?: string; lozinka?: string } = {};
    if (!email.trim()) next.email = 'Unesite email';
    if (!lozinka) next.lozinka = 'Unesite lozinku';
    if (Object.keys(next).length) {
      setGreske(next);
      return;
    }
    setGreske({});
    setBusy(true);
    try {
      await login(email.trim(), lozinka);
      // Preusmeravanje radi efekat u stranici (čim `user` stigne) — ili forma za novu
      // lozinku, ako nalog nosi `mustChangePassword`.
    } catch (err) {
      // 401 = neuspela prijava → NAMERNO neutralno (nikad se ne odaje da li nalog postoji).
      // 400 = telo nije prošlo validaciju (P12, 06.08.2026) — ovaj ekran, za razliku od
      // `/login`, ne proverava OBLIK email-a pre slanja, pa „pera" bez @ sada stiže kao 400.
      // Bez ove grane korisnik bi dobio „proveri vezu", a veza je ispravna — greška je unos.
      // Backend poruka govori isključivo o obliku unosa, pa je bezbedno prikazati je.
      setGreske({
        root:
          err instanceof ApiError && err.status === 401
            ? 'Pogrešan email ili lozinka'
            : err instanceof ApiError && err.status === 400
              ? err.message
              : 'Prijava trenutno nije moguća. Proveri vezu pa pokušaj ponovo.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-panel border border-line bg-surface p-6">
      <FormField label="Email" required error={greske.email}>
        <Input
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoComplete="username"
          autoFocus
          placeholder="ime@servoteh.local"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </FormField>

      <FormField label="Lozinka" required error={greske.lozinka}>
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={lozinka}
          onChange={(e) => setLozinka(e.target.value)}
        />
      </FormField>

      {greske.root && (
        <p className="text-sm text-status-danger" role="alert">
          {greske.root}
        </p>
      )}

      <Button type="submit" loading={busy} className="w-full">
        Prijavi se
      </Button>
    </form>
  );
}

/** Prinudna promena lozinke (B2) — ista logika kao `/promena-lozinke`, ali u scope-u. */
function NovaLozinkaForma() {
  const router = useRouter();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [nova, setNova] = useState('');
  const [potvrda, setPotvrda] = useState('');
  const [greske, setGreske] = useState<{
    current?: string;
    nova?: string;
    potvrda?: string;
    root?: string;
  }>({});
  const busy = change.isPending;

  const sacuvaj = useCallback(async () => {
    const g: { current?: string; nova?: string; potvrda?: string } = {};
    if (!current) g.current = 'Unesite trenutnu lozinku';
    if (nova.length < MIN_LEN) g.nova = `Nova lozinka mora imati najmanje ${MIN_LEN} karaktera`;
    if (!potvrda) g.potvrda = 'Potvrdite novu lozinku';
    else if (nova !== potvrda) g.potvrda = 'Lozinke se ne poklapaju';
    if (Object.keys(g).length) {
      setGreske(g);
      return;
    }
    setGreske({});
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: nova });
      toast('Lozinka je promenjena.');
      router.replace(cilj());
    } catch (err) {
      setGreske({
        root:
          err instanceof ApiError && err.status === 401
            ? 'Trenutna lozinka nije ispravna'
            : err instanceof ApiError && err.status === 400
              ? `Nova lozinka mora imati najmanje ${MIN_LEN} karaktera`
              : 'Promena lozinke trenutno nije moguća. Pokušaj ponovo.',
      });
    }
  }, [current, nova, potvrda, change, router]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void sacuvaj();
      }}
      className="space-y-4 rounded-panel border border-line bg-surface p-6"
    >
      <FormField label="Trenutna lozinka" required error={greske.current}>
        <Input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </FormField>

      <FormField
        label="Nova lozinka"
        required
        error={greske.nova}
        hint={`Najmanje ${MIN_LEN} karaktera.`}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={nova}
          onChange={(e) => setNova(e.target.value)}
        />
      </FormField>

      <FormField label="Potvrda nove lozinke" required error={greske.potvrda}>
        <Input
          type="password"
          autoComplete="new-password"
          value={potvrda}
          onChange={(e) => setPotvrda(e.target.value)}
        />
      </FormField>

      {greske.root && (
        <p className="text-sm text-status-danger" role="alert">
          {greske.root}
        </p>
      )}

      <Button type="submit" loading={busy} className="w-full">
        Sačuvaj novu lozinku
      </Button>
    </form>
  );
}
