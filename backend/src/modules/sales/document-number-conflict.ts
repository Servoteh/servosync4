import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * BRANA: BROJ KOJI SE IZDAJE NE SME VEĆ POSTOJATI U KNJIZI (odluka O-F11, 05.08.2026).
 * =============================================================================
 *
 * ── ŠTA JE KVAR KOJI OVO SPREČAVA ─────────────────────────────────────────────
 * Preuzimanje sa BigBita je **01.04.2027 — usred godine**. Izmereno nad uvezenom
 * knjigom 2026: BigBit je već izdao izlazne fakture u TAČNO našem obliku `N/GG` bez
 * vodeće nule — IFR 95 različitih brojeva (`100/26`–`261/26`), IFUSL 32, IFGP 21; od
 * 2.453 reda oblika `N/26` njih **1.404 nema vodeću nulu**. Tempo je 23–49 novih
 * brojeva mesečno, pa januar–mart 2027. potroši još ~90–110 brojeva PRE preuzimanja.
 *
 * Da 4.0 tada krene od 1, izdavao bi brojeve koje BigBit u istoj godini već ima. A
 * otvorene stavke se grupišu po `(konto, komitent, broj)` **bez vrste dokumenta**
 * (`saldakonti/open-items.service.ts`), pa bi se dve različite obaveze tiho spojile u
 * jednu: jedna otvorena stavka na zbir oba iznosa, sa ranijim dospećem, i kamata na
 * duplo veći iznos. Nijedna kontrola to ne bi prijavila — dokument balansira.
 *
 * ── GDE JE BRANA POSTAVLJENA: NA OBA KRAJA, I TO NAMERNO ──────────────────────
 *
 *  (1) PRI UPISU STARTNOG BROJA (ekran „Brojači dokumenata" u Podešavanjima) —
 *      `assertStartNumberAboveBook`. Odbija `last_number` NIŽI od najvećeg broja te
 *      serije koji već stoji u knjizi. To hvata GREŠKU U UNOSU, u trenutku kad je
 *      čovek napravio i dok gleda u ekran koji mu kaže tačan broj. Bez ovog kraja bi
 *      pogrešno otkucan startni broj isplivao tek mesecima kasnije, mid-knjiženje, i
 *      to nekom drugom.
 *
 *  (2) PRI IZDAVANJU BROJA (`numbering.service.ts` → `next`) — `resolveFreeSequence`.
 *      Kandidat se proverava neposredno pre nego što postane broj dokumenta, UNUTAR
 *      iste transakcije i pod istom bravom kojom se brojač povećava. To hvata sve što
 *      posle upisa startnog broja UĐE u knjigu: BigBit i 4.0 rade PARALELNO do aprila
 *      2027, noćni uvoz svake noći dosipa nove BigBit stavke, a knjigovođa ume i ručno
 *      da proknjiži nalog. Startni broj podešen u ponedeljak ne zna šta će u knjizi
 *      biti u petak.
 *
 * ZAŠTO NIJE DOVOLJAN SAMO JEDAN KRAJ: (1) rešava samo prvi dan — posle njega knjiga
 * raste, a brojač ne zna za to. (2) sam po sebi radi, ali tek u trenutku knjiženja,
 * kad je najskuplje stati; bez (1) bi svaka pogrešna cifra u startnom broju značila
 * desetine preskočenih brojeva ili zaustavljeno knjiženje.
 *
 * ── ZAŠTO IZDAVANJE PRESKAČE, A NE ODBIJA (do granice) ────────────────────────
 * Kad je kandidat zauzet, izdavanje PRESKAČE na prvi slobodan broj (najviše
 * `MAX_COLLISION_SKIP` koraka) umesto da baci grešku.
 *
 * Odbijanje bi ovde bilo TRAJNA BLOKADA, ne upozorenje: rezervacija broja se poništava
 * zajedno sa transakcijom knjiženja (v. `numbering.service.ts`), pa bi svaki sledeći
 * pokušaj ponovo izračunao ISTI zauzet kandidat i ponovo pao. Knjigovođa bi ostao bez
 * ijednog načina da proknjiži račun dok neko ne uđe u Podešavanja — a možda je zauzet
 * samo JEDAN broj, slučajno uvezen te noći.
 *
 * Preskakanje pravi rupu u nizu (npr. `262/26` pa `264/26`), i to je prihvatljivo:
 * propisi traže da broj bude jedinstven i neponovljiv, ne da niz bude bez rupa, a
 * upravo rupa je ono što se u knjizi VIDI i može da se objasni. Suprotno — dva
 * dokumenta sa istim brojem — se ne vidi nigde dok ne stigne pogrešna opomena.
 *
 * ── ZAŠTO IPAK POSTOJI GRANICA (`MAX_COLLISION_SKIP`) ─────────────────────────
 * Preskakanje bez granice bi tiho progutalo POGREŠNO PODEŠEN BROJAČ: brojač na 0 uz
 * knjigu koja ima 261 broj bi na prvom knjiženju prošao 261 korak i izdao `262/26`
 * kao da je sve u redu — dakle sam bi „popravio" podešavanje koje čovek treba da
 * potvrdi, i to bez ijednog traga. Posle granice se staje GLASNO, sa porukom koja
 * imenuje izmereni najveći broj i ekran na kom se on upisuje. Granica time razdvaja
 * dve različite pojave: slučajan sudar (nekoliko brojeva → preskoči) i pogrešno
 * podešavanje (desetine brojeva → čovek mora da odluči).
 *
 * ── ŠTA SE PROVERAVA, A ŠTA NE ───────────────────────────────────────────────
 * Proverava se ISKLJUČIVO `ledger_entries.document_number` — to je „knjiga" u kojoj
 * grupisanje otvorenih stavki i pravi štetu, i jedino mesto gde se sretnu i naši i
 * uvezeni BigBit dokumenti.
 *
 * `invoices` se NAMERNO ne proverava: tamo `@@unique([companyId, documentType,
 * documentNumber])` već odbija dupli broj u istoj vrsti, a sudar PREKO vrsta je
 * nemoguć po konstrukciji — sve izlazne fakture dele JEDAN brojač (`@FAKTURA`), a
 * svaka druga serija nosi svoj prefiks (`A-`, `PROF-`, `PON-`, `REV-`; O-F5/O-F6/O-F7),
 * pa su serije disjunktne kao STRINGOVI. Dodatna provera nad `invoices` ne bi uhvatila
 * nijedan slučaj koji ova ne hvata, a knjiženje bi platilo još jedan upit.
 *
 * ── 🔴 SAMO KUPČEVA STRANA KNJIGE (ispravka posle merenja nad produkcijom) ────
 * `ledger_entries.document_number` NE drži samo NAŠE brojeve. Na ulaznoj fakturi tu
 * stoji DOBAVLJAČEV broj — njegov niz, njegova numeracija, nama potpuno strana.
 *
 * IZMERENO NA PRODUKCIJI 05.08.2026 (22.258 stavki, sve sa brojem dokumenta), brojevi
 * oblika `N/26` bez prefiksa, po klasi konta:
 *
 *     konto 435 (dobavljači)          581 stavki    najveći broj  14.630
 *     konto 270 (PDV u ulaznim fakt.) 252 stavki    najveći broj 138.030
 *     konto 132 (roba u magacinu)     293 stavki    najveći broj   6.733
 *     ──────────────────────────────────────────────────────────────────
 *     konto 204 (KUPCI U ZEMLJI)      411 stavki    najveći broj     261  ← NAŠ niz
 *     konto 470 (izlazni PDV)         236 stavki    najveći broj     261  (ista dokumenta)
 *     konto 604 (prihodi od prodaje)  166 stavki    najveći broj     261  (ista dokumenta)
 *
 * Da se merilo nad CELOM knjigom, „najveći već izdat broj" za 2026. bio bi **138.030**
 * — dobavljačev broj sa konta 270. Ekran bi tražio da se startni broj podesi na 138.030,
 * a brana pri upisu bi ODBIJALA tačnu vrednost 261. Alat napravljen da spreči grešku
 * postao bi alat koji tačan unos ne dozvoljava.
 *
 * ZAŠTO JE OGRANIČENJE NA KLASU 20 TAČNO, A NE ZAOBILAŽENJE PROBLEMA: šteta od duplog
 * broja nastaje u grupisanju otvorenih stavki, a ono ide po
 * `(account_code, analytical_code, document_number)` — dakle po KONTU I KOMITENTU, ne
 * samo po broju. Dobavljačev `138030/26` stoji na kontu obaveza (43x) uz DOBAVLJAČA kao
 * analitiku; naš `138030/26` bi stajao na kontu potraživanja (204x/205x) uz KUPCA. To su
 * dve različite grupe i one se ne mogu spojiti ni u jednom izveštaju. Sudar je moguć
 * jedino unutar iste klase konta — a naš izlazni dokument UVEK zadužuje kupca
 * (`buildSalesLedgerLines`: 2040 DUG / 6140 POT / 4702 POT; izvoz 2050, avans isti kupčev
 * konto). Zato se meri klasa 20 („Potraživanja od kupaca") i ništa drugo.
 */

/**
 * Koliko uzastopno zauzetih brojeva izdavanje sme da preskoči pre nego što stane.
 * 50 je izabrano nad izmerenim tempom BigBita (23–49 novih brojeva MESEČNO): jedan
 * mesec zaostatka se preskoči i posao ide dalje, a sve preko toga je podešavanje koje
 * traži čoveka, ne automatiku.
 */
export const MAX_COLLISION_SKIP = 50;

/**
 * Najveći redni broj koji regex hvata (7 cifara). Postoji zbog `::int` u SQL-u:
 * zatečen string oblika `99999999999999/26` bi inače oborio ceo upit greškom o prekoračenju
 * opsega, i to na EKRANU koji treba da pomogne. Sedam cifara je 9.999.999 dokumenata
 * godišnje — red veličine iznad svega što se može izdati.
 */
const MAX_SEQ_DIGITS = 7;

/**
 * Klasa konta na kojoj žive NAŠI izlazni dokumenti — „Potraživanja od kupaca" (20xx:
 * 2040 kupci u zemlji, 2050 kupci u inostranstvu, 2023 ostali kupci u zemlji…).
 *
 * Ovo je granica merenja, ne kozmetika: bez nje bi se u „našu" seriju ubrojali
 * DOBAVLJAČEVI brojevi sa ulaznih faktura (izmereno 138.030 nasuprot našem 261) —
 * v. veliki komentar na vrhu fajla.
 */
const CUSTOMER_ACCOUNT_PREFIX = "20";

/** Godina u dvocifrenom obliku: 2026 → „26", 2005 → „05" (uvek dve cifre). */
export function twoDigitYear(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}

/**
 * Broj dokumenta iz serije, rednog broja i godine: `("A-", 7, 2026)` → `A-7/26`.
 * JEDNO mesto koje sastavlja broj — i numeracija i ekran brojača i poruke o grešci
 * moraju da pokazuju isti string, inače ekran savetuje broj koji se neće izdati.
 */
export function documentNumberOf(
  prefix: string,
  seq: number,
  year: number,
): string {
  return `${prefix}${seq}/${twoDigitYear(year)}`;
}

/** Escapes za POSIX ERE — prefiksi su naši (`A-`, `PROF-`), ali pravilo ne sme da zavisi od toga. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * POSIX regex koji hvata TAČNO brojeve jedne serije u jednoj godini.
 * Za `@FAKTURA` (prazan prefiks) i 2026: `^([0-9]{1,7})/26$` — `A-5/26` ne prolazi.
 *
 * Godina se NE traži preko `journal_entries.year` nego iz SAMOG BROJA: godina je deo
 * broja dokumenta (`/26`), pa je poklapanje po stringu tačno i onda kad je BigBit stavka
 * uvezena u nalog druge godine (a jeste — uvoz nosi svoje datume).
 */
function seriesPattern(prefix: string, year: number): string {
  return `^${escapeRegex(prefix)}([0-9]{1,${MAX_SEQ_DIGITS}})/${twoDigitYear(year)}$`;
}

/** Ono što je o jednoj seriji izmereno u knjizi. */
export interface BookUsage {
  /** Najveći redni broj te serije koji već postoji u knjizi; `null` = nijedan. */
  maxSeq: number | null;
  /** Koliko stavki glavne knjige nosi broj iz te serije (ista faktura ima više stavki). */
  entryCount: number;
  /** Najveći broj kao STRING, onako kako stoji u knjizi (`261/26`); `null` = nijedan. */
  maxNumber: string | null;
}

/** Minimum klijenta koji `measureBookUsage` traži (Prisma ili transakcija). */
type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Šta knjiga već zna o ovoj seriji i godini — jedan upit, za ekran i za branu upisa.
 *
 * ⚠️ Ovo NIJE brzi put knjiženja: regex prolazi kroz `document_number` i indeks mu ne
 * pomaže. Zato se zove SAMO sa ekrana Podešavanja (nekoliko poziva dnevno), dok
 * izdavanje broja ide na tačno poklapanje stringa (v. `resolveFreeSequence`), koje
 * indeks `idx_ledger_entries_document_number` pokriva.
 */
export async function measureBookUsage(
  db: RawClient,
  prefix: string,
  year: number,
): Promise<BookUsage> {
  const pattern = seriesPattern(prefix, year);
  const rows = await db.$queryRaw<
    Array<{ max_seq: number | null; entry_count: bigint | number }>
  >`
    SELECT MAX((regexp_match(document_number, ${pattern}))[1]::int) AS max_seq,
           COUNT(*) AS entry_count
    FROM ledger_entries
    WHERE document_number ~ ${pattern}
      AND account_code LIKE ${CUSTOMER_ACCOUNT_PREFIX + "%"}
  `;
  const row = rows[0];
  const maxSeq = row?.max_seq ?? null;
  return {
    maxSeq,
    entryCount: Number(row?.entry_count ?? 0),
    maxNumber: maxSeq == null ? null : documentNumberOf(prefix, maxSeq, year),
  };
}

/**
 * ISTO MERENJE, ALI ZA CEO EKRAN ODJEDNOM — jedan upit umesto (serija × godina).
 *
 * ZAŠTO POSTOJI pored `measureBookUsage`: ekran prikazuje 5 serija × nekoliko godina, a
 * svaki poziv `measureBookUsage` je PUN PROLAZ kroz `ledger_entries` (regex, indeks ne
 * pomaže). Dvadesetak punih prolaza po otvaranju ekrana je cena koju niko ne plaća
 * svesno — a znala bi da izađe kao „Podešavanja se dugo učitavaju", bez ijednog traga
 * odakle. Ovako je jedan prolaz, a grupisanje radi baza.
 *
 * Prefiks se ne traži po registru nego se ČITA iz samog broja (`^([A-Z]{0,6}-?)`), pa
 * upit ne mora da se menja kad se doda nova serija. Brojevi čiji prefiks nije u registru
 * (npr. zatečen BigBit oblik `IFR-657/25`) se prosto ne poklope ni sa jednom serijom i
 * ostaju van prikaza — što je tačno: oni nisu naš niz.
 */
export async function measureBookUsageAll(
  db: RawClient,
): Promise<Map<string, BookUsage>> {
  const rows = await db.$queryRaw<
    Array<{
      prefix: string | null;
      yy: string | null;
      max_seq: number | null;
      entry_count: bigint | number;
    }>
  >`
    SELECT m[1] AS prefix,
           m[3] AS yy,
           MAX(m[2]::int) AS max_seq,
           COUNT(*) AS entry_count
    FROM (
      SELECT regexp_match(
               document_number,
               ${`^([A-Z]{0,6}-?)([0-9]{1,${MAX_SEQ_DIGITS}})/([0-9]{2})$`}
             ) AS m
      FROM ledger_entries
      WHERE document_number IS NOT NULL
        AND account_code LIKE ${CUSTOMER_ACCOUNT_PREFIX + "%"}
    ) s
    WHERE m IS NOT NULL
    GROUP BY 1, 2
  `;

  const out = new Map<string, BookUsage>();
  for (const r of rows) {
    const prefix = r.prefix ?? "";
    const yy = r.yy ?? "";
    const maxSeq = r.max_seq ?? null;
    out.set(bookUsageKey(prefix, yy), {
      maxSeq,
      entryCount: Number(r.entry_count ?? 0),
      maxNumber: maxSeq == null ? null : `${prefix}${maxSeq}/${yy}`,
    });
  }
  return out;
}

/** Ključ mape iz `measureBookUsageAll`: prefiks serije + dvocifrena godina. */
export function bookUsageKey(prefix: string, twoDigit: string): string {
  return `${prefix}|${twoDigit}`;
}

/** Prazno merenje — serija koju knjiga uopšte ne poznaje. */
export const EMPTY_BOOK_USAGE: BookUsage = {
  maxSeq: null,
  entryCount: 0,
  maxNumber: null,
};

/** Minimum klijenta koji provera zauzetosti traži (Prisma ili transakcija). */
type LedgerClient = Pick<Prisma.TransactionClient, "ledgerEntry">;

/**
 * Prvi SLOBODAN redni broj počev od `startSeq` — srce brane pri izdavanju.
 *
 * Vraća i `skipped` (preskočeni zauzeti brojevi) da bi pozivalac mogao da to zapiše u
 * dnevnik: preskok je normalan ishod, ali NIJE ćutljiv — bez traga bi rupa u nizu bila
 * neobjašnjiva knjigovođi koji je posle traži.
 *
 * ⚠️ DVA KORAKA, I TO NAMERNO: prvo se proveri SAMO kandidat (jedan indeksni pogodak —
 * to je 99,99 % slučajeva i ne sme da košta ništa), pa tek kad je zauzet ide jedan
 * grupni upit za ceo prozor preskoka. Suprotan redosled bi svakom knjiženju u firmi
 * naplatio prozor od 50 brojeva zbog situacije koja se dešava jednom godišnje.
 */
export async function resolveFreeSequence(
  db: LedgerClient,
  prefix: string,
  startSeq: number,
  year: number,
): Promise<{ seq: number; documentNumber: string; skipped: string[] }> {
  const first = documentNumberOf(prefix, startSeq, year);
  const takenFirst = await db.ledgerEntry.findFirst({
    // `accountCode` filter je ISTA granica koju koristi i merenje za ekran: broj se
    // smatra zauzetim samo ako stoji na KUPČEVOJ strani knjige. Bez toga bi dobavljačev
    // broj sa ulazne fakture (izmereno: `14630/26` na kontu 435, `138030/26` na 270)
    // terao numeraciju da preskače brojeve koji su za naš niz potpuno slobodni.
    where: {
      documentNumber: first,
      accountCode: { startsWith: CUSTOMER_ACCOUNT_PREFIX },
    },
    select: { id: true },
  });
  if (!takenFirst) return { seq: startSeq, documentNumber: first, skipped: [] };

  // Kandidat je zauzet → jedan grupni upit nad celim prozorom preskoka.
  const window: string[] = [];
  for (let i = 1; i <= MAX_COLLISION_SKIP; i++) {
    window.push(documentNumberOf(prefix, startSeq + i, year));
  }
  const takenRows = await db.ledgerEntry.findMany({
    where: {
      documentNumber: { in: window },
      accountCode: { startsWith: CUSTOMER_ACCOUNT_PREFIX },
    },
    select: { documentNumber: true },
    distinct: ["documentNumber"],
  });
  const taken = new Set(takenRows.map((r) => r.documentNumber));

  const skipped: string[] = [first];
  for (let i = 1; i <= MAX_COLLISION_SKIP; i++) {
    const candidate = window[i - 1];
    if (!taken.has(candidate)) {
      return { seq: startSeq + i, documentNumber: candidate, skipped };
    }
    skipped.push(candidate);
  }

  // Prešli smo granicu: ovo više nije slučajan sudar nego pogrešno podešen brojač.
  throw new UnprocessableEntityException(
    `Brojač je zaostao za knjigom: brojevi od „${first}" do „${window[window.length - 1]}" ` +
      `(${MAX_COLLISION_SKIP + 1} uzastopnih) već postoje u glavnoj knjizi, pa se nijedan ne ` +
      `sme izdati ponovo — dva dokumenta sa istim brojem bi se u saldakontima spojila u jednu ` +
      `otvorenu stavku. Broj se NE preskače dalje automatski, jer ovoliki zaostatak znači da ` +
      `startni broj nije podešen. Otvorite Podešavanja → Brojači dokumenata, tamo piše koji je ` +
      `najveći broj već u knjizi, i upišite ga kao poslednji izdati broj — sledeći dokument ` +
      `kreće od prvog sledećeg.`,
  );
}

/**
 * BRANA PRI UPISU STARTNOG BROJA. Odbija `lastNumber` niži od onoga što knjiga već ima.
 *
 * ZAŠTO `<` A NE `<=`: `lastNumber` je POSLEDNJI IZDATI broj, a sledeći dokument dobija
 * `lastNumber + 1`. Kad je u knjizi najveći `261/26`, upis 261 je TAČAN unos — sledeći
 * je `262/26`, prvi slobodan. Upis 260 bi značio da će `261/26` biti izdat po drugi put.
 */
export function assertStartNumberAboveBook(
  lastNumber: number,
  usage: BookUsage,
  seriesLabel: string,
  year: number,
): void {
  if (usage.maxSeq == null || lastNumber >= usage.maxSeq) return;
  throw new UnprocessableEntityException(
    `Poslednji izdati broj za seriju „${seriesLabel}" u ${year}. ne sme biti manji od ` +
      `${usage.maxSeq}: glavna knjiga već sadrži dokument „${usage.maxNumber}" ` +
      `(${usage.entryCount} ${usage.entryCount === 1 ? "stavka" : "stavki"} knjiženja). ` +
      `Sa upisanom vrednošću ${lastNumber} sledeći dokument bi dobio broj koji u knjizi već ` +
      `postoji, a otvorene stavke se grupišu po broju dokumenta bez vrste — dve različite ` +
      `obaveze bi se tiho spojile u jednu. Upišite ${usage.maxSeq} (sledeći dokument dobija ` +
      `prvi slobodan broj) ili veći broj.`,
  );
}
