'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Info,
  Lock,
  Save,
  Unlock,
} from 'lucide-react';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import {
  izmenjenaPolja,
  redosledFokusa,
  sledecePolje,
  sporneStavke,
  type Brana,
  type OpcijaPolja,
  type PoljeDef,
  type Provera,
  type SekcijaDef,
  type TonProvere,
} from './pravila';

/**
 * PUN EKRAN matičnog sloga (artikal / komitent) — zajednička školjka za „nov zapis“
 * i „izmena postojećeg“. Dijalog nije mesto unosa (odluka vlasnika); duga forma ide
 * kao stranica sa sekcijama (DESIGN_SYSTEM §4.3).
 *
 * Ponašanje koje ovaj fajl garantuje (PLAN_UNOS_DOKUMENATA §2.5–2.7):
 *   • Enter = sledeće polje, nikad slanje forme; poslednje polje → dugme „Snimi“.
 *   • Trajno zaključana polja se PRESKAČU u toku fokusa (da prst ne staje na mrtvom polju).
 *   • Provera se javlja u trenutku kucanja, uz poruku ŠTA da se uradi.
 *   • Ctrl+S nikad ne prolazi tiho: kad je brana zatvorena, kaže zašto.
 *
 * ⚠️ Komitenti uvoze ovaj fajl preko `@/app/artikli/_forma/polja` — granica ovog posla
 * su samo `app/artikli/**`, `app/komitenti/**` i `api/masters.ts`, pa deljeni blok ne
 * sme u `components/ui-kit`. Kad brana padne, ceo `_forma` folder ide u ui-kit.
 *
 * Zbog te deljene upotrebe su obe novije mogućnosti — GUSTA 12-kolonska mreža
 * (`SekcijaDef.mreza`) i SKLOPIVA sekcija (`SekcijaDef.sklopivo`) — uvedene ADITIVNO i
 * OPCIONO: sekcija koja ih ne zada crta se i ponaša tačno kao pre (komitenti se ne
 * pomeraju ni za piksel). Gusta mreža postoji zato što BigBit forma „Unos artikala“ ima
 * do 7 polja u redu, a upravo redosled i susedstvo polja korisnici pamte.
 */

/* ─────────────────────────────────────────────────────────── stil po tonu */

const BOJA_TONA: Record<TonProvere, string> = {
  neutralno: 'text-ink-secondary',
  'u-toku': 'text-ink-secondary',
  ok: 'text-status-success',
  upozorenje: 'text-status-warn',
  greska: 'text-status-danger',
};

const IVICA_TONA: Record<TonProvere, string> = {
  neutralno: '',
  'u-toku': '',
  ok: 'border-status-success',
  upozorenje: 'border-status-warn',
  greska: 'border-status-danger',
};

function IkonaTona({ ton }: { ton: TonProvere }) {
  if (ton === 'ok') return <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  if (ton === 'greska' || ton === 'upozorenje')
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  return null;
}

/* ────────────────────────────────────────────────────────────── BRANA panel */

/**
 * Traka koja stoji IZNAD forme od prvog piksela — korisnik mora da vidi da upis ne
 * prolazi PRE nego što išta otkuca, ne posle. Sadrži i tehničke uslove sa izvorom u
 * kodu, da vlasnik vidi šta tačno blokira odluku.
 */
export function BranaPanel({
  brana,
  proba,
  onProba,
}: {
  brana: Brana;
  proba: boolean;
  onProba: (v: boolean) => void;
}) {
  const [uslovi, setUslovi] = useState(false);
  if (brana.otvorena) return null;

  return (
    <section className="rounded-panel border border-status-warn/50 bg-status-warn-bg p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-status-warn" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-base font-semibold text-ink">{brana.naslov}</h2>
          <p className="text-sm text-ink">{brana.poruka}</p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            <button
              type="button"
              onClick={() => setUslovi((v) => !v)}
              className="text-xs font-medium text-ink-secondary underline underline-offset-2 hover:text-ink"
            >
              {uslovi ? 'Sakrij' : 'Prikaži'} šta mora da se uradi pre otvaranja ({brana.uslovi.length})
            </button>

            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-ink-secondary sm:min-h-0">
              <input
                type="checkbox"
                checked={proba}
                onChange={(e) => onProba(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                <strong className="font-semibold text-ink">Proba unosa</strong> — polja se otključavaju
                da se ekran može isprobati; <strong>ništa se ne snima</strong>.
              </span>
            </label>
          </div>

          {uslovi && (
            <ol className="mt-2 space-y-2 border-t border-status-warn/30 pt-3">
              {brana.uslovi.map((u, i) => (
                <li key={u.izvor + i} className="text-xs text-ink-secondary">
                  <span className="mr-1 font-semibold text-ink">{i + 1}.</span>
                  {u.tekst}
                  <span className="mt-0.5 block break-all font-mono text-2xs text-ink-disabled">
                    {u.izvor}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── polja koja ne pokrivamo */

export interface NepokrivenoPolje {
  labela: string;
  razlog: string;
}

/**
 * Polja koja BigBit ima a ovaj ekran svesno NE nudi. Stoje na ekranu (a ne samo u
 * izveštaju) da operater ne traži polje koje ne postoji i da se vidi šta 4.0 još
 * duguje šifarniku.
 */
export function NepokrivenaPolja({ stavke }: { stavke: NepokrivenoPolje[] }) {
  const [otvoreno, setOtvoreno] = useState(false);
  if (stavke.length === 0) return null;
  return (
    <section className="rounded-panel border border-line bg-surface-2 p-4">
      <button
        type="button"
        onClick={() => setOtvoreno((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary"
      >
        <Info className="h-4 w-4" aria-hidden />
        BigBit polja koja ovaj ekran ne nudi ({stavke.length}) — {otvoreno ? 'sakrij' : 'prikaži'}
      </button>
      {otvoreno && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
          {stavke.map((s) => (
            <div key={s.labela} className="min-w-0">
              <dt className="text-xs font-medium text-ink">{s.labela}</dt>
              <dd className="text-xs text-ink-secondary">{s.razlog}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/* ──────────────────────────────────────────────────────────── jedno polje */

/**
 * ZATEČENA mreža (sekcija BEZ `mreza`): 1 → 2 → 3 → 4 kolone. Ključevi 1/2/4 moraju
 * ostati SLOVO U SLOVO isti — komitenti se crtaju ovom mrežom i ne smeju da se pomere.
 * Ključevi 3/6/8/12 postoje samo da polje pisano za gustu mrežu ne ostane bez klase ako
 * ikad završi u zatečenoj sekciji; tamo se ponaša kao „ceo red“, što je bezbedan ishod.
 */
const RASPON: Record<number, string> = {
  1: '',
  2: 'sm:col-span-2',
  4: 'col-span-full',
  3: 'sm:col-span-2',
  6: 'col-span-full',
  8: 'col-span-full',
  12: 'col-span-full',
};

/**
 * GUSTA mreža (`mreza: 12`) — 1 → 2 → 6 → 12 kolona. Raspon je izražen u dvanaestinama
 * širine BigBit forme, pa jedan red BigBit forme = jedan red mreže na širokom ekranu.
 * Na telefonu (ispod `sm`) sve pada u JEDNU kolonu, kako traži DESIGN_SYSTEM §11.
 */
const RASPON_12: Record<number, string> = {
  1: 'md:col-span-1 xl:col-span-1',
  2: 'md:col-span-1 xl:col-span-2',
  3: 'md:col-span-2 xl:col-span-3',
  4: 'md:col-span-2 xl:col-span-4',
  6: 'md:col-span-3 xl:col-span-6',
  8: 'sm:col-span-2 md:col-span-4 xl:col-span-8',
  12: 'col-span-full',
};

const MREZA_ZATECENA = 'gap-x-6 gap-y-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
const MREZA_GUSTA = 'gap-x-4 gap-y-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-6 xl:grid-cols-12';

function Polje({
  def,
  mreza,
  opcije,
  vrednost,
  provera,
  zakljucano,
  razlogZakljucanja,
  otkljucano,
  onOtkljucaj,
  onPromena,
  onBlur,
  registruj,
}: {
  def: PoljeDef;
  /** Mreža sekcije u kojoj polje stoji; `undefined` = zatečena 4-kolonska. */
  mreza?: 12;
  /**
   * Opcije dovučene sa servera za OVO polje (šifarnici koji se pune u toku rada).
   * Imaju prednost nad statičkim `def.opcije`; `undefined` = polje ih ne dobija spolja.
   */
  opcije?: OpcijaPolja[];
  vrednost: string;
  provera: Provera;
  zakljucano: boolean;
  razlogZakljucanja: string | null;
  otkljucano: boolean;
  onOtkljucaj: () => void;
  onPromena: (v: string) => void;
  onBlur: () => void;
  registruj: (el: HTMLElement | null) => void;
}) {
  const idPolja = `polje-${def.id}`;
  const idPoruke = `${idPolja}-poruka`;
  const trajnoZakljucano = Boolean(def.zakljucano);
  const cenovnoZakljucano = Boolean(def.otkljucajDvoklikom) && !otkljucano;
  const readOnly = zakljucano || trajnoZakljucano || cenovnoZakljucano;

  // Zajedničko za sve tipove polja. `readOnly`/`maxLength` NISU atributi `<select>`-a,
  // pa se dodaju samo tamo gde važe (select se zaključava sa `disabled`).
  const zajednicko = {
    id: idPolja,
    'data-polje': def.id,
    'aria-readonly': readOnly || undefined,
    'aria-invalid': provera.ton === 'greska' || undefined,
    'aria-describedby': provera.poruka || def.napomena ? idPoruke : undefined,
    tabIndex: trajnoZakljucano ? -1 : undefined,
    value: vrednost,
    onBlur,
    className: cn(
      readOnly && 'cursor-default bg-surface-2 text-ink-secondary',
      !readOnly && IVICA_TONA[provera.ton],
    ),
  };
  const tekstualno = { ...zajednicko, readOnly, maxLength: def.maxDuzina };

  const tabelaRaspona = mreza === 12 ? RASPON_12 : RASPON;

  /**
   * Opcije za `izbor`: serverske (`opcije`) imaju prednost nad statičkim `def.opcije`.
   *
   * Kad ih NEMA nijednih, polje se crta kao TEKSTUALNO, ne kao prazan `<select>`. Bez tog
   * pravila polje sa šifarnikom koji još nije stigao (prvi render, pad mreže) izgleda kao da
   * artikal nema grupu — `<select>` čija lista ne sadrži tekuću vrednost prikazuje prazno,
   * pa se podatak TIHO GUBI iz vida. Ovako se šifra uvek vidi i može se otkucati.
   */
  const opcijeIzbora = opcije ?? def.opcije ?? [];
  const izborBezListe = def.tip === 'izbor' && opcijeIzbora.length === 0;

  return (
    <div className={cn('min-w-0 space-y-1.5', tabelaRaspona[def.raspon ?? 1] ?? '')}>
      {/* Dugme „otključaj“ stoji PORED labele, ne u njoj — interaktivni element unutar
          <label> bi klikom istovremeno aktivirao i polje. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={idPolja} className="text-xs font-medium text-ink">
          {def.labela}
          {def.obavezno && <span className="text-status-danger"> *</span>}
        </label>
        {cenovnoZakljucano && (
          <button
            type="button"
            onClick={onOtkljucaj}
            title="Zaključano da se cena ne prekuca slučajno (BigBit obrazac). Klikni da otključaš."
            className="inline-flex items-center gap-1 rounded-control px-1 text-2xs text-ink-disabled hover:text-ink"
          >
            <Lock className="h-3 w-3" aria-hidden />
            otključaj
          </button>
        )}
        {def.otkljucajDvoklikom && otkljucano && (
          <span className="inline-flex items-center gap-1 text-2xs text-status-warn">
            <Unlock className="h-3 w-3" aria-hidden />
            otključano
          </span>
        )}
        {trajnoZakljucano && (
          <span title={def.zakljucano} className="inline-flex">
            <Lock className="h-3 w-3 text-ink-disabled" aria-hidden />
          </span>
        )}
      </div>

      {def.tip === 'memo' ? (
        <Textarea
          {...tekstualno}
          ref={registruj as (el: HTMLTextAreaElement | null) => void}
          rows={3}
          onChange={(e) => onPromena(e.target.value)}
        />
      ) : (def.tip === 'izbor' && !izborBezListe) || def.tip === 'da-ne' ? (
        <Select
          {...zajednicko}
          ref={registruj as (el: HTMLSelectElement | null) => void}
          disabled={readOnly}
          placeholder={def.obavezno ? undefined : '—'}
          options={
            def.tip === 'da-ne'
              ? [
                  { value: 'da', label: 'Da' },
                  { value: 'ne', label: 'Ne' },
                ]
              : opcijeIzbora
          }
          onChange={(e) => onPromena(e.target.value)}
        />
      ) : (
        <Input
          {...tekstualno}
          ref={registruj as (el: HTMLInputElement | null) => void}
          type={def.tip === 'datum' ? 'date' : 'text'}
          inputMode={def.tip === 'broj' ? 'decimal' : undefined}
          onDoubleClick={def.otkljucajDvoklikom && !otkljucano ? onOtkljucaj : undefined}
          onChange={(e) => onPromena(e.target.value)}
          className={cn(tekstualno.className, def.tip === 'broj' && 'tnums text-right')}
        />
      )}

      {(provera.poruka || def.napomena || razlogZakljucanja) && (
        <p
          id={idPoruke}
          className={cn('flex items-start gap-1 text-2xs', BOJA_TONA[provera.ton])}
          role={provera.ton === 'greska' ? 'alert' : undefined}
        >
          <IkonaTona ton={provera.ton} />
          <span className="min-w-0">
            {provera.poruka ?? razlogZakljucanja ?? def.napomena}
          </span>
        </p>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── ceo ekran */

export interface MaticniEkranProps {
  naslov: string;
  /** Desno od naslova (šifra, status…). */
  oznaka?: ReactNode;
  brana: Brana;
  sekcije: SekcijaDef[];
  nepokriveno?: NepokrivenoPolje[];
  vrednosti: Record<string, string>;
  /** Polazni (serverski) slog — za brojanje izmena u režimu izmene. */
  polazneVrednosti?: Record<string, string> | null;
  onPromena: (sledece: Record<string, string>) => void;
  /** Kuda vodi „Nazad“ i Esc. */
  onIzlaz: () => void;
  /**
   * `pregled` = KARTICA sloga: isti raspored i iste labele kao unos, ali sve read-only i bez
   * ijedne radnje koja piše (nema „Snimi“, nema „Probe unosa“, nema provera koje traže ispravku).
   * Uveden da kartica ne bi imala SVOJ spisak polja — raspored mora imati jedan izvor, inače
   * se dva ekrana razilaze pri prvoj izmeni (BigBit paritet, zahtev vlasnika 04.08.2026).
   */
  rezim: 'unos' | 'izmena' | 'pregled';
  /**
   * Opcije padajućih listi po `PoljeDef.id`, dovučene sa servera (šifarnici koji se pune u
   * toku rada — npr. grupa/podgrupa/PodPodgrupa uz BigBit kaskadu). Imaju prednost nad
   * statičkim `PoljeDef.opcije`; polje bez ijedne opcije se crta kao tekstualno (v. `Polje`).
   */
  opcijePolja?: Record<string, OpcijaPolja[]>;
  /** Dodatna dugmad u komandnoj traci, levo od „Nazad“ (npr. „Izmeni“ na kartici). */
  akcije?: ReactNode;
  /** Traka iznad forme (npr. „artikal se učitava“, greška servera). */
  zaglavljeDodatak?: ReactNode;
}

export function MaticniEkran({
  naslov,
  oznaka,
  brana,
  sekcije,
  nepokriveno = [],
  vrednosti,
  polazneVrednosti = null,
  onPromena,
  onIzlaz,
  rezim,
  opcijePolja,
  akcije,
  zaglavljeDodatak,
}: MaticniEkranProps) {
  const samoPregled = rezim === 'pregled';
  const [proba, setProba] = useState(false);
  const [otkljucana, setOtkljucana] = useState<Record<string, boolean>>({});
  const polja = useRef<Record<string, HTMLElement | null>>({});
  const snimiRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Sklopljene sekcije, po naslovu. Stanje živi OVDE, a ne u samoj sekciji, jer od njega
   * zavisi i redosled fokusa: polje zatvorene sekcije nije u DOM-u, pa Enter na njemu ne
   * bi imao gde da stane (fokus bi tiho zastao usred forme).
   */
  const [sklopljene, setSklopljene] = useState<Record<string, boolean>>(() => {
    const pocetno: Record<string, boolean> = {};
    for (const s of sekcije) if (s.sklopivo && s.podrazumevanoZatvoreno) pocetno[s.naslov] = true;
    return pocetno;
  });

  // `pregled` je kartica — zaključana je uvek, bez obzira na branu i „Probu unosa“.
  const zakljucano = samoPregled || (!brana.otvorena && !proba);

  const otvoreneSekcije = useMemo(
    () => sekcije.filter((s) => !(s.sklopivo && sklopljene[s.naslov])),
    [sekcije, sklopljene],
  );

  /**
   * Fokus preskače polja koja su TRAJNO zaključana — prst ne staje na mrtvom polju —
   * i polja iz sklopljenih sekcija, koja uopšte nisu iscrtana.
   */
  const redosled = useMemo(
    () =>
      redosledFokusa(otvoreneSekcije).filter((id) => {
        for (const s of otvoreneSekcije) for (const p of s.polja) if (p.id === id) return !p.zakljucano;
        return true;
      }),
    [otvoreneSekcije],
  );

  const prvoPolje = redosled[0];
  useEffect(() => {
    // Fokus na prvo polje pri otvaranju (DESIGN_SYSTEM §6). U zaključanom stanju se
    // fokus NE otima — nema šta da se kuca, a čitač ekrana bi pročitao mrtvo polje.
    if (zakljucano || !prvoPolje) return;
    polja.current[prvoPolje]?.focus();
  }, [zakljucano, prvoPolje]);

  const fokusiraj = useCallback((id: string) => {
    const el = polja.current[id];
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  const objasniBranu = useCallback(() => {
    toast(brana.poruka);
  }, [brana.poruka]);

  // Ctrl+S i Esc. Ctrl+S NIKAD ne prolazi tiho: ako se ne može snimiti, kaže zašto.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        objasniBranu();
        return;
      }
      if (e.key === 'Escape') {
        // Esc pripada NAJGORNJEM sloju. Dijalozi idu kroz `escape-layer` (capture +
        // stopImmediatePropagation) pa dovde ni ne stignu; komandna paleta i pomoć
        // rade `preventDefault` na svom slušaocu — to je znak da je Esc već potrošen
        // i da ekran ne sme da odnese korisnika sa forme.
        if (e.defaultPrevented) return;
        const cilj = e.target as HTMLElement | null;
        if (cilj?.closest?.('[role="dialog"]')) return;
        e.preventDefault();
        if (proba) toast('Proba je odbačena — ništa nije bilo snimljeno.');
        onIzlaz();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [objasniBranu, onIzlaz, proba]);

  /** Enter = sledeće polje; poslednje polje → dugme „Snimi“ (nikad slanje forme). */
  const naTaster = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const cilj = e.target as HTMLElement;
      if (cilj.tagName === 'TEXTAREA') return; // memo: Enter pravi novi red
      const id = cilj.dataset?.polje;
      if (!id) return;
      e.preventDefault();
      const sledeci = sledecePolje(redosled, id);
      if (sledeci) fokusiraj(sledeci);
      else snimiRef.current?.focus();
    },
    [fokusiraj, redosled],
  );

  const postavi = useCallback(
    (id: string, v: string) => onPromena({ ...vrednosti, [id]: v }),
    [onPromena, vrednosti],
  );

  // Dok su polja zaključana nema šta da se ispravlja — traka bi samo galamila
  // („PIB je obavezan“) na formi u koju se ne može kucati.
  const sporne = useMemo(
    () => (zakljucano ? [] : sporneStavke(sekcije, vrednosti)),
    [zakljucano, sekcije, vrednosti],
  );

  const izmene = useMemo(
    () => (polazneVrednosti ? izmenjenaPolja(sekcije, polazneVrednosti, vrednosti) : []),
    [polazneVrednosti, sekcije, vrednosti],
  );

  return (
    <AppShell>
      <PageHeader
        title={naslov}
        count={oznaka}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge
              tone={samoPregled ? 'neutral' : brana.otvorena ? 'info' : 'warn'}
              label={
                samoPregled
                  ? 'Pregled'
                  : brana.otvorena
                    ? rezim === 'unos'
                      ? 'Unos'
                      : 'Izmena'
                    : 'Zaključano'
              }
            />
            {akcije}
            <Button variant="secondary" onClick={onIzlaz}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 sm:p-6">
        {zaglavljeDodatak}

        {/* Kartica ne piše ništa, pa nema ni brane ni „Probe unosa“ — objašnjenje zašto je
            unos zatvoren stoji na ekranu izmene, gde je i relevantno. */}
        {!samoPregled && <BranaPanel brana={brana} proba={proba} onProba={setProba} />}

        {proba && (
          <p className="rounded-panel border border-status-info/40 bg-status-info-bg px-4 py-2 text-sm text-status-info">
            Proba je uključena. Polja rade (Enter vodi na sledeće, zarez je decimalni,
            PIB se proverava dok se kuca), ali <strong>„Snimi“ ostaje zatvoren</strong> i ništa ne
            odlazi na server.
          </p>
        )}

        <div onKeyDown={naTaster} className="space-y-4">
          {sekcije.map((s) => {
            const zatvorena = Boolean(s.sklopivo && sklopljene[s.naslov]);
            const klasaNaslova =
              'text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary';
            return (
              <section key={s.naslov} className="rounded-panel border border-line bg-surface p-4">
                {s.sklopivo ? (
                  <h2>
                    <button
                      type="button"
                      aria-expanded={!zatvorena}
                      onClick={() =>
                        setSklopljene((o) => ({ ...o, [s.naslov]: !zatvorena }))
                      }
                      className={cn(
                        // Cilj za prst na dodiru (DESIGN_SYSTEM §11) — na mišu ostaje tanka traka.
                        'flex min-h-11 w-full items-center gap-2 text-left sm:min-h-0',
                        klasaNaslova,
                      )}
                    >
                      <ChevronRight
                        className={cn('h-4 w-4 shrink-0 transition-transform', !zatvorena && 'rotate-90')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        {s.naslov} ({s.polja.length}) — {zatvorena ? 'prikaži' : 'sakrij'}
                      </span>
                    </button>
                  </h2>
                ) : (
                  <h2 className={klasaNaslova}>{s.naslov}</h2>
                )}

                {s.opis && !zatvorena && <p className="mt-1 text-xs text-ink-disabled">{s.opis}</p>}

                {!zatvorena && (
                  <div
                    className={cn('mt-3 grid', s.mreza === 12 ? MREZA_GUSTA : MREZA_ZATECENA)}
                  >
                    {s.polja.map((p) => {
                      const v = vrednosti[p.id] ?? '';
                      // Dok je forma zaključana provera se NE prikazuje: crveno „PIB je
                      // obavezan“ na polju u koje se ne može kucati je šum, ne pomoć.
                      const provera: Provera =
                        zakljucano || !p.proveri
                          ? { ton: 'neutralno', poruka: null }
                          : p.proveri(v, vrednosti);
                      return (
                        <Polje
                          key={p.id}
                          def={p}
                          mreza={s.mreza}
                          opcije={opcijePolja?.[p.id]}
                          vrednost={v}
                          provera={provera}
                          zakljucano={zakljucano}
                          razlogZakljucanja={p.zakljucano ?? p.napomena ?? null}
                          otkljucano={Boolean(otkljucana[p.id])}
                          onOtkljucaj={() => setOtkljucana((o) => ({ ...o, [p.id]: true }))}
                          onPromena={(nv) => postavi(p.id, nv)}
                          onBlur={() => {
                            if (!p.normalizuj) return;
                            const sredjeno = p.normalizuj(v);
                            if (sredjeno !== v) postavi(p.id, sredjeno);
                          }}
                          registruj={(el) => {
                            polja.current[p.id] = el;
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <NepokrivenaPolja stavke={nepokriveno} />
      </div>

      {/* Zakucana traka akcija — na svakoj širini (360 px uključivo) mora da se vidi
          stanje zapisa i „Snimi“; skroluje samo forma iznad, ne cela strana.
          U režimu `pregled` je nema: kartica ništa ne snima, pa bi traka nudila radnju
          koje nema (a „Odustani“ na ekranu koji ne menja ništa samo zbunjuje). */}
      {!samoPregled && (
      <div className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 sm:px-6">
        <p className="min-w-0 flex-1 text-xs text-ink-secondary">
          {sporne.length > 0 ? (
            <span className="text-status-warn">
              {sporne.length === 1
                ? `1 polje traži pažnju: ${sporne[0].labela} — ${sporne[0].poruka}`
                : `${sporne.length} polja traže pažnju (prvo: ${sporne[0].labela}).`}
            </span>
          ) : izmene.length > 0 ? (
            <span className="text-status-info">
              {izmene.length === 1 ? 'Dirano je 1 polje' : `Dirano je ${izmene.length} polja`} —{' '}
              {brana.otvorena ? 'nije još snimljeno.' : 'ništa nije snimljeno (upis je zaključan).'}
            </span>
          ) : (
            'Enter vodi na sledeće polje · Ctrl+S snima · Esc izlazi'
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onIzlaz}>
            Odustani
          </Button>
          <Button
            ref={snimiRef}
            disabled={!brana.otvorena}
            title={brana.otvorena ? undefined : brana.poruka}
            onClick={objasniBranu}
          >
            <Save className="h-4 w-4" aria-hidden />
            Snimi
          </Button>
        </div>
      </div>
      )}
    </AppShell>
  );
}
