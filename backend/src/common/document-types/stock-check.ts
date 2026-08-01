/**
 * PROVERA ZALIHA — jedna vrednost, jedno mesto.
 * ===========================================================================
 * ZAŠTO POSTOJI OVAJ FAJL (nalaz adversarnog pregleda 28.07.2026, VISOK)
 * ---------------------------------------------------------------------------
 * Dva modula su nezavisno odlučila šta znači `document_types.stock_check = NULL`
 * i odlučila SUPROTNO, svaki sa uverljivim obrazloženjem:
 *
 *   • registar vrsta → `OFF`   („tvrd blok na nekonfigurisanoj vrsti bi zaustavio
 *                                magacin zbog rupe u šifarniku")
 *   • robna izmena   → `BLOCK` („pad na OFF bi bez ijedne poruke otvorio
 *                                negativne zalihe")
 *
 * Oba obrazloženja su tačna, i baš zato nijedno ne sme da pobedi tiho. Posledica
 * razlaza je bila vidljiva korisniku: ekran po registru javi „ova vrsta ne
 * proverava zalihe" i pusti unos 100 kom na stanju 10, a ruta isti taj unos
 * odbije sa 422 „nema dovoljno zalihe". Korisnik dobija dva suprotna odgovora na
 * isto pitanje, i nijedan nije pogrešan sam po sebi.
 *
 * RAZREŠENJE: `BLOCK` — poravnava se PRIJAVA sa SPROVOĐENJEM, ne obrnuto.
 * ---------------------------------------------------------------------------
 * Prva verzija ove popravke uzela je `WARN` kao „srednji put": ni tiho u minus,
 * ni zaustavljen magacin. Zvučalo je uravnoteženo i **bilo je pogrešno** —
 * oborilo je sedam zatečenih testova u `document-edit.service.spec.ts`, među
 * njima i „nova stavka preko raspoloživog → 422". Migracija je `stock_check`
 * posejala za 10 od 57 vrsta i **nijednu robnu izlaznu**, pa bi `WARN` ugasio
 * branu od prekoračenja zalihe na praktično svim dokumentima koji se stvarno
 * koriste. Niko to nije tražio, a niko ne bi ni primetio dok se ne pojave
 * negativne zalihe.
 *
 * Pravilo koje iz toga sledi: kad se PRIJAVA i SPROVOĐENJE raziđu, ispravlja se
 * prijava. Sprovođenje (`BLOCK`) je živo, konzervativno i nasleđeno; menjati ga
 * usput, radi doslednosti, znači tiho skidati kočnicu. Registar zato sada
 * prijavljuje `BLOCK` — ekran govori istinu o onome što će se stvarno desiti, a
 * ponašanje ostaje nepromenjeno.
 *
 * Cena je poznata i prihvaćena: vrsta koja nije podešena blokira prekoračenje.
 * To je ista stvar koja se dešava i danas — jedina razlika je što korisnik sada
 * unapred vidi da će se desiti, umesto da ga dočeka 422 posle unosa.
 *
 * Vrednost je namerno u `common/`, van oba modula: da bi se razišli, neko bi
 * morao SVESNO da uvede drugu konstantu, a ne slučajno da napiše svoj fallback.
 */

/** Režim provere zaliha (`document_types.stock_check`). */
export type StockCheck = "BLOCK" | "WARN" | "OFF";

/** Dozvoljene vrednosti — isto što i CHECK ograničenje u bazi. */
export const STOCK_CHECK_VALUES: readonly StockCheck[] = ["BLOCK", "WARN", "OFF"];

/**
 * Šta znači nepopunjena kolona. JEDINA podrazumevana vrednost u sistemu —
 * i registar i robne rute je čitaju odavde.
 */
export const DEFAULT_STOCK_CHECK: StockCheck = "BLOCK";

/**
 * Pročitaj režim iz sirove vrednosti kolone. Nepoznata vrednost se tretira kao
 * nepopunjena: šifarnik može da nosi zatečeno smeće iz uvoza, a ni tada se ne
 * sme ni tiho propustiti ni zaustaviti magacin.
 */
export function parseStockCheck(raw: string | null | undefined): StockCheck {
  const value = (raw ?? "").trim().toUpperCase();
  return (STOCK_CHECK_VALUES as readonly string[]).includes(value)
    ? (value as StockCheck)
    : DEFAULT_STOCK_CHECK;
}

/** Srpski naziv režima — za poruke i ekran. */
export const STOCK_CHECK_LABEL: Record<StockCheck, string> = {
  BLOCK: "zabrani prekoračenje zalihe",
  WARN: "upozori na prekoračenje zalihe",
  OFF: "ne proveravaj zalihe",
};
