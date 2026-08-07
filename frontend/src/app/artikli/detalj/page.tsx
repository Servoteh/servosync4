'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import {
  ULAZI_ARTIKAL,
  adresaDetaljaSaRezimom,
  citajIzvor,
  hrefIzvora,
  type IzvorArtikla,
} from '@/lib/povratak-na-listu';
import { parseIdParam } from '@/lib/deep-link';
import { useArtikal, useItemLookups } from '@/api/masters';
import { MaticniEkran } from '../_forma/polja';
import { BRANA_ARTIKAL } from '../_forma/pravila';
import {
  NEPOKRIVENO_ARTIKAL,
  SEKCIJE_ARTIKAL,
  opcijeSifarnikaArtikla,
  vrednostiIzArtikla,
} from '../_forma/artikal-polja';

/**
 * Kartica artikla — pun matični slog (67 BigBit kolona), grupisan po sekcijama iz
 * `backend/docs/migration/BIGBIT_ARTIKLI.md` §1.
 *
 * Ekran ima DVA REŽIMA na istoj ruti: `pregled` (kartica) i `izmena` (pun ekran forme,
 * `?rezim=izmena`). Izmena je danas ZAKLJUČANA — `items` piše samo sync, a full refresh
 * radi `deleteMany({})`, pa bi svaka ispravka nestala na sledećem sync-u (v. `BRANA_ARTIKAL`).
 * Zato režim postoji, ali „Snimi“ ne prolazi i ekran kaže šta da se uradi umesto toga.
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment: dinamički segmenti NE rade na static
 * exportu (`output: "export"`) — klijentska navigacija traži neizvezen prerender pa
 * hard-404 (incident 22.07). Id se čita iz `window.location.search` u `useEffect`-u,
 * NIKAD kroz `useSearchParams` (on bi tražio Suspense oko cele strane). Isto važi i za
 * `?rezim=` — režim je u URL-u da osvežavanje strane ne izbaci korisnika iz izmene.
 */

type Rezim = 'pregled' | 'izmena';

export default function ArtikalDetaljPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [validId, setValidId] = useState<number | null>(null);
  const [idResolved, setIdResolved] = useState(false);
  const [rezim, setRezim] = useState<Rezim>('pregled');

  /**
   * ODAKLE SE DOŠLO — detalj artikla ima DVA ulaza (pregled artikala i lager lista), pa
   * „Nazad" ne sme da bude zakucan. Do 07.08.2026 su sva tri izlaza (Esc, `onIzlaz`,
   * dugme „Nazad") vodila na `/artikli`, pa je magacioner koji je iz lagera otvorio
   * „Detaljno artikal" završavao na pregledu artikala — sa filterima te druge liste.
   * Vlasnik je to prijavio kao „vrati me na početnu stranu".
   *
   * Isti obrazac kao na kartici artikla; obe strane sada koriste ISTOG pomoćnika.
   */
  const [izvor, setIzvor] = useState<IzvorArtikla>('artikli');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // `parseIdParam` je stroža od golog `Number()`: „0x10" (=16), „1e3" (=1000) i „+5" bi
    // inače prošli, pa prelomljen link iz mejla otvara TUĐI artikal (C20, kanon 077/26).
    setValidId(parseIdParam(params.get('id')));
    setRezim(params.get('rezim') === 'izmena' ? 'izmena' : 'pregled');
    setIzvor(citajIzvor(window.location.search, ULAZI_ARTIKAL, 'artikli'));
    setIdResolved(true);
  }, []);

  /** Povratak na listu iz koje se došlo, SA njenim poslednjim filterima. */
  const nazadNaListu = useCallback(
    () => router.push(hrefIzvora(ULAZI_ARTIKAL[izvor])),
    [router, izvor],
  );

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8 — Esc zatvara najviši sloj). U režimu
  // izmene Esc pripada formi (vraća na karticu), pa se ovaj slušalac gasi.
  useEffect(() => {
    if (rezim === 'izmena') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') nazadNaListu();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nazadNaListu, rezim]);

  const q = useArtikal(validId);
  const sifarnici = useItemLookups();

  // Vrednosti forme se pune iz serverskog sloga i drže zasebno — kartica se ne dira.
  const [vrednosti, setVrednosti] = useState<Record<string, string> | null>(null);
  const ucitan = q.data?.data;
  useEffect(() => {
    if (ucitan) setVrednosti(vrednostiIzArtikla(ucitan));
  }, [ucitan]);
  /** Polazni slog — po njemu se broji šta je operater dirao. */
  const polazne = useMemo(() => (ucitan ? vrednostiIzArtikla(ucitan) : null), [ucitan]);

  /**
   * Opcije combo-a klasifikacije (Grupa → Podgrupa → PodPodgrupa) sa BigBit kaskadom.
   * Zavise od tekućih vrednosti, pa se računaju ovde i prosleđuju ekranu; dok šifarnici
   * nisu stigli lista je prazna i polje se crta kao tekstualno (v. `polja.tsx`).
   */
  const opcije = useMemo(
    () => opcijeSifarnikaArtikla(sifarnici.data?.data, vrednosti ?? {}),
    [sifarnici.data, vrednosti],
  );

  /**
   * Režim ide i u URL (`replace`, ne `push`) — osvežavanje ne izbacuje iz izmene.
   * Adresa se GRADI iz zatečene (`adresaDetaljaSaRezimom`), a ne sklapa iz `id`: sklapanje
   * je brisalo `?izvor=`, pa je lager → Detaljno → Izmeni → F5 → „Nazad" vodio na
   * `/artikli` umesto na lager.
   */
  function promeniRezim(sledeci: Rezim) {
    setRezim(sledeci);
    if (validId === null) return;
    const put = adresaDetaljaSaRezimom(window.location.search, validId, sledeci);
    window.history.replaceState(null, '', `${window.location.pathname}${put}`);
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const a = q.data?.data;

  if (rezim === 'izmena' && a && vrednosti) {
    return (
      <MaticniEkran
        naslov={`Izmena artikla — ${a.name}`}
        oznaka={<span className="tnums">{a.catalogNumber}</span>}
        brana={BRANA_ARTIKAL}
        rezim="izmena"
        sekcije={SEKCIJE_ARTIKAL}
        nepokriveno={NEPOKRIVENO_ARTIKAL}
        vrednosti={vrednosti}
        polazneVrednosti={polazne}
        onPromena={setVrednosti}
        opcijePolja={opcije}
        onIzlaz={() => {
          setVrednosti(vrednostiIzArtikla(a));
          promeniRezim('pregled');
        }}
      />
    );
  }

  /**
   * KARTICA = isti raspored i iste labele kao ekran izmene, samo read-only.
   *
   * Ranije je kartica imala SVOJ spisak polja (logički paneli: Identitet / Klasifikacija /
   * Cene / …) i svoje labele („Poreklo“, „Kutija“, „Raster (ID)“). Time je ekran koji
   * korisnik zapravo otvara odstupao od BigBita, a BigBit raspored se video samo iza dugmeta
   * „Izmeni“ — koje je zaključano, pa ga niko nije ni video. Zato kartica sada renderuje
   * `SEKCIJE_ARTIKAL` kroz `MaticniEkran` u režimu `pregled`: JEDAN izvor rasporeda za oba
   * ekrana, pa se ne mogu razići (zahtev vlasnika 04.08.2026 — „isti raspored, da se ne
   * menja navika korisnika“).
   */
  if (a && vrednosti) {
    return (
      <MaticniEkran
        naslov={a.name}
        oznaka={<span className="tnums">{a.catalogNumber}</span>}
        brana={BRANA_ARTIKAL}
        rezim="pregled"
        sekcije={SEKCIJE_ARTIKAL}
        nepokriveno={NEPOKRIVENO_ARTIKAL}
        vrednosti={vrednosti}
        onPromena={setVrednosti}
        opcijePolja={opcije}
        onIzlaz={nazadNaListu}
        akcije={
          <>
            {a.active ? (
              <StatusBadge tone="success" label="Aktivan" />
            ) : (
              <StatusBadge tone="neutral" label="Neaktivan" />
            )}
            {a.toDelete && <StatusBadge tone="warn" label="Za brisanje" />}
            <Button
              variant="secondary"
              onClick={() => promeniRezim('izmena')}
              title="Otvori pun ekran izmene (upis je zaključan — ekran objašnjava zašto)"
              aria-label="Izmeni"
              className="max-sm:w-9 max-sm:px-0"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Izmeni</span>
            </Button>
          </>
        }
      />
    );
  }

  // Stanja bez sloga (nema id-a, učitavanje, greška) — obična školjka, bez forme.
  return (
    <AppShell>
      <PageHeader
        title="Artikal"
        actions={
          <Button variant="secondary" onClick={nazadNaListu}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Nazad
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {idResolved && validId === null && (
          <EmptyState title="Nedostaje šifra artikla" hint="Otvori artikal iz liste artikala." />
        )}

        {validId !== null && q.isLoading && (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        )}

        {validId !== null && q.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(q.error as Error).message}
          </div>
        )}
      </div>
    </AppShell>
  );
}
