import { Prisma } from "@prisma/client";

/**
 * CENTRALNE PDV STOPE PO `goodsTaxRateCode` (BigBit `R_Tarife`).
 * =============================================================================
 *
 * VREDNOSTI SU RAZLOMCI (0.20 = 20%) — pogodno za množenje osnovice PDV-om u posting engine-u
 * (`aggregateDocAmounts`). Kalkulacija (`CalculationService.taxRateOf`), `item-lookup` i
 * `advance-vat` koriste ISTU mapu kao fallback kad `tax_rates` tabela nema red, uz konverziju
 * u PROCENAT (×100) jer `KalkMP` formula radi sa `ΣStopa/100` (doc 39 §A).
 *
 * ⚠️ NA PRODUKCIJI JE OVA MAPA JEDINI IZVOR STOPE — `tax_rates` JE PRAZNA
 * ─────────────────────────────────────────────────────────────────────────────
 * Izmereno 02.08.2026 (`servosync-pg`): `SELECT count(*) FROM tax_rates` → **0 redova**.
 * Oba resolvera koja gledaju registar (`CalculationService.taxRateOf`,
 * `ItemLookupService`) zato UVEK padnu na ovu mapu, a `PostingEngine.aggregateDocAmounts`
 * i `documentVatTotals` je čitaju direktno — bez posrednika. Greška ovde nije „fallback
 * greška", nego JEDINA stopa koju sistem zna.
 *
 * ⚠️ ISPRAVLJEN KVAR (02.08.2026): 4 OD 5 REDOVA MAPE BILI SU NETAČNI
 * ─────────────────────────────────────────────────────────────────────────────
 * Mapa se pozivala na „doc 43 §4", ali doc 43 §4 NE DAJE NIJEDNU NUMERIČKU ŠIFRU — samo
 * imena kolona (Osnovna/Zeleznica/Posebna). Numeričko mapiranje je bila pretpostavka.
 * Zlatni izvor su STVARNI REDOVI tabele izvučeni iz produkcijske baze:
 * `_legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/R_Tarife.csv` (potvrđuje i
 * doc 18 §3.1, izvučeno nezavisno iz `BB_T_25.MDB`):
 *
 *   Tarifa | Osnovna | Zeleznica | Gradska | Ratna | Posebna | Opis                  | Vazi do    | PDVGrupa
 *   -------|---------|-----------|---------|-------|---------|-----------------------|------------|---------
 *   0      |    0    |     0     |    0    |   0   |    0    | Roba od dob van PDV-a |     —      | VANPDV
 *   1      |    0    |     0     |    0    |   0   |    0    | Roba i usluge bez por.|     —      | BEZPDV
 *   3      |   20    |     0     |    0    |   0   |    0    | Roba i usluge 20%     |     —      | VISA
 *   4      |    0    |    10     |    0    |   0   |    0    | „Roba i usluge 8%"    |     —      | NIZA
 *   5      |    8    |     0     |    0    |   0   |    0    | Poljoprivrednici 8%   |     —      | POLJO
 *   6      |   20    |     0     |    0    |   0   |    0    | Bezcarinska zona      |     —      | VANPDV
 *   15     |    5    |     0     |    0    |   0   |    0    | Poljoprivrednici 5%   | 30.09.2012 | POLJO
 *   18     |   18    |     0     |    0    |   0   |    0    | Roba i usluge 18%     | 30.09.2012 | VISA
 *
 * EFEKTIVNA STOPA JE **ZBIR 5 KOLONA**, ne kolona „Osnovna" — tako je definiše sam BigBit
 * (`_extracted/queries_full/OnLine_BigBit_APL/R_Tarife_ZbirnaStopa.sql`):
 *   `[Osnovna stopa]+[Zeleznica stopa]+[Gradska stopa]+[Ratna stopa]+[Posebna stopa] AS PDVStopa`
 * i preko nje `PDVStopaZaTarifu()` u `PDV_Modul.bas`. Stare jugoslovenske kolone poreza su
 * PRENAMENJENE (doc `BIGBIT_KONTA_I_SEME_KNJIZENJA.md:267`).
 *
 * 🔴 ZAMKA KOJA JE I NAPRAVILA KVAR — NE „POPRAVLJATI" NAZAD:
 * kolona `Opis` tarife 4 glasi **„Roba i usluge 8%"**, a numeričke kolone daju **10 %**.
 * Opis je zaostatak iz vremena kad je snižena stopa BILA 8 % (do 31.12.2013); vrednost je
 * kasnije podignuta 8→10 bez ispravke teksta. Ko čita `Opis`, upiše 8 % — što je i bilo
 * ovde. Isti zaključak daje i zakon: opšta stopa 20 %, **posebna (snižena) 10 %**, dok je
 * **8 % PDV NADOKNADA POLJOPRIVREDNICIMA** (tarifa 5, grupa POLJO) — a ne izlazna stopa.
 * To potvrđuje i VBA resolver `PDV_Modul.bas:22-32`: `F_PDV_NizaStopa` vraća 8 samo za
 * datume `< 01.01.2014`, inače 10.
 *
 * ŠTA JE KONKRETNO BILO POGREŠNO (staro → tačno):
 *   šifra 1: 20 % → **0 %**  (BEZPDV; nikad nije bila „alt kod za osnovnu")
 *   šifra 2: 10 % → **ne postoji u `R_Tarife`** (izmišljena šifra — uklonjena)
 *   šifra 4:  8 % → **10 %** (NIZA — v. zamku sa `Opis` gore)
 *   šifra 5: nije postojala (→ 0 %) → **8 %** (POLJO)
 *   šifra 6: nije postojala (→ 0 %) → **20 %**
 *   šifra 3: 20 % → 20 % (jedina koja je bila tačna uz 0)
 *
 * IZMERENA POSLEDICA NA PRODUKCIJI (`items`, 02.08.2026):
 *   `goods_tax_rate_code`:   „3" → 92.574 artikla, „4" → **1** artikal
 *   `service_tax_rate_code`: „1" → 92.575 artikala (SVI)
 * Dakle roba je praktično sva na 20 % i nije bila pogođena. Pogođena su dva tiha mesta:
 *   1. Jedini artikal sa šifrom „4" (`id=12852`, `external_item_id=35041`, `DPTR10-04612`)
 *      dobijao je 8 % umesto 10 %. U `PostingEngine.aggregateDocAmounts` je stopa 0,08
 *      padala u POLJO kofu (`W`), a **nijedna šema kontiranja ne referiše `W`** (v.
 *      `PREOSTALE_FAZE.md` S1) — izlazni PDV tog artikla bi NESTAO iz glavne knjige.
 *      Sa 10 % pada u `Q`, koje šema 33 knjiži (`O+P+Q`). (Sam artikal je računarski deo
 *      i u BigBitu je pogrešno tarifiran — zapisano u `PREOSTALE_FAZE.md` za ispravku.)
 *   2. `service_tax_rate_code="1"` je prikazivan kao 20 % umesto 0 %. Danas je to samo
 *      prikaz (`ItemLookupService.serviceVatRatePercent`; cenovnik i knjiženje uzimaju
 *      `goodsTaxRateCode` — `pricing.service.ts:272`), ali bi pogrešna vrednost postala
 *      novac čim se „Tarifa usluga" uveže u obračun.
 * Na produkciji nema nijedne fakture ni stavke (`invoices`/`invoice_items` = 0/0), pa
 * ispravka ne traži migraciju zatečenih podataka.
 *
 * ŠIFRE 15 i 18 SU NAMERNO IZOSTAVLJENE: važenje im je isteklo 30.09.2012, a ova mapa
 * NEMA datumsku dimenziju pa ne ume da ih odbije po danu. Dokument sa šifrom „18" u
 * 2026. je greška u podatku, i bolje je da glasno padne (`advance-vat` javlja
 * „Nepoznata šifra PDV stope") nego da tiho dobije 18 %. Pravo rešenje je effective-dated
 * registar — v. `PREOSTALE_FAZE.md` („`tax_rates` prazna na produkciji").
 *
 * Nepoznat kod → stopa 0 (PDV linija za taj artikal se ne knjiži) — doc 43 §5 disciplina.
 */
const D = Prisma.Decimal;
const ZERO = new D(0);

export const VAT_RATE_BY_CODE: Readonly<Record<string, Prisma.Decimal>> = {
  "0": ZERO, // VANPDV — roba od dobavljača van PDV-a
  "1": ZERO, // BEZPDV — roba i usluge bez poreza
  "3": new D("0.20"), // VISA / osnovna 20 % (od 01.10.2012) — default stavke
  "4": new D("0.10"), // NIZA / snižena 10 % (kolona „Zeleznica"; `Opis` laže da je 8 %)
  "5": new D("0.08"), // POLJO — PDV nadoknada poljoprivrednicima 8 % (od 01.10.2012)
  "6": new D("0.20"), // Bezcarinska zona (Σ kolona = 20 %; grupa VANPDV — v. pitanje niže)
};

export const RATE_VISA = new D("0.20");
export const RATE_NIZA = new D("0.10");
export const RATE_POLJO = new D("0.08");

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * IZVEDENICE MAPE — SVE ŠTO SISTEM ZNA O ŠIFRAMA STOPA IZLAZI ODAVDE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ IZMEREN KVAR KOJI JE OVO IZAZVAO (02.08.2026, sedmi krug provere)
 * ─────────────────────────────────────────────────────────────────────────────
 * Ispravka mape iznad (commit 2eb53bcd) nije stigla do DVA PREPISA koji su živeli
 * mimo nje, pa je sistem istog dana radio po TRI različite tablice stopa:
 *
 *   `sales/advance-invoice.service.ts` — `VAT_PERCENT_BY_CODE` (procenti):
 *       „1"→20, „2"→10, „4"→8, bez „5"/„6"          ← STARA, neispravljena
 *   `sales/dto/update-invoice.dto.ts`  — `KNOWN_VAT_CODES` (spisak dozvoljenih):
 *       {0,1,2,3,4}                                  ← STARA, neispravljena
 *
 * ŠTA JE TO KONKRETNO RADILO NAD ULAZOM KOJI DANAS POSTOJI NA PRODUKCIJI:
 *
 *  1. Predračun čija je jedina stavka artikal `id=12852` (`DPTR10-04612`, jedini
 *     artikal sa šifrom „4") obračunat je po ISPRAVLJENIH **10 %**, a avans po
 *     tom predračunu po STAROJ **8 %** — dva različita poreza na isti promet.
 *  2. Stavka sa šifrom „1" (BEZPDV, 0 %) je na predračunu davala 0 % PDV-a, a
 *     `splitAdvance` bi na isti bruto naplatio **20 % na oslobođen promet**.
 *  3. Spisak dozvoljenih šifara je PRIMAO „2" (koja u `R_Tarife` ne postoji): kroz
 *     `addItem`/`updateItem` je prolazila, a `VAT_RATE_BY_CODE["2"]` je `undefined`
 *     → domaća oporeziva stavka je tiho išla na **0 % PDV**. Rupa je bila NOVA:
 *     pre ispravke mape je „2" značila 10 %. Uz to je ODBIJAO „5" i „6", koje su
 *     legitimne — pa se poljoprivredna nadoknada i bezcarinska zona nisu mogle uneti.
 *
 * ZATO SE OD OVE IZMENE SPISAK I PROCENTI **IZVODE** IZ `VAT_RATE_BY_CODE`, a ne
 * prepisuju. Prepis se raziđe tiho i bez ijedne izmene u kodu koji ga koristi;
 * izvedenica se ne može raziću jer nema svoj podatak. Test koji to čuva:
 * `sales/jedna-mapa-poreskih-stopa.spec.ts`.
 */

/**
 * DOZVOLJENE ŠIFRE — IZVEDENE iz mape. Gejtuje unos (DTO prodaje, DTO robnog
 * dokumenta, šifarnik artikala): šifra koju sistem ne ume da pretvori u stopu ne
 * sme ni da uđe u bazu, jer bi je svaki potrošač posle toga video kao 0 %.
 */
export const KNOWN_VAT_CODES: ReadonlySet<string> = new Set(
  Object.keys(VAT_RATE_BY_CODE),
);

/** Šifre kao sortiran spisak za poruke o grešci („0, 1, 3, 4, 5, 6"). */
export const KNOWN_VAT_CODES_LABEL: string = [...KNOWN_VAT_CODES]
  .sort()
  .join(", ");

/**
 * Stopa kao PROCENAT (20, ne 0.20) po šifri — IZVEDENA iz iste mape.
 *
 * Postoji jer avansni račun porez DELI, ne množi: `grossToNet` (pdv/vat-bridge.util)
 * prima procenat. Do 02.08.2026. je zbog toga u modulu prodaje stajao ručni prepis
 * mape u procentima — v. kvar opisan iznad.
 */
export const VAT_PERCENT_BY_CODE: Readonly<Record<string, number>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(VAT_RATE_BY_CODE).map(([code, rate]) => [
        code,
        rate.mul(100).toNumber(),
      ]),
    ),
  );

/**
 * Jedna jedina poruka za nepoznatu šifru — spisak dozvoljenih je IZVEDEN, pa ne
 * može da zastari kad se mapa dopuni. Tip izuzetka bira pozivalac (unos → 400,
 * obračun/knjiženje → 422).
 */
export function unknownVatCodeMessage(code: string | null | undefined): string {
  return (
    `Nepoznata šifra PDV stope „${code ?? ""}" — dozvoljene su: ` +
    `${KNOWN_VAT_CODES_LABEL}.`
  );
}
