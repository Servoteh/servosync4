/**
 * PRIPREMA REDA GLAVNE KNJIGE PRE UPISA — jedno mesto za obe grane knjiženja.
 * =========================================================================
 * Koriste ga:
 *   • robna grana — `PostingEngineService.postFromStockDocument` (nalog po šemi kontiranja),
 *   • ručna grana — `FakturisanjeService.postManualLedger` (račun bez robnog izlaza),
 *   • generički ručni nalog — `PostingEngineService.postManualEntry` (izvod, kompenzacija,
 *     avans, otvaranje godine).
 *
 * ZAŠTO ZAJEDNO, A NE PO GRANI: iste tri odluke (na koliko decimala, šta sa nula-redom, šta
 * ide u polja otvorene stavke) do 05.08.2026. su postojale u dva primerka i **razišle su se** —
 * ručna grana je upisivala `document_number`/`due_date`/`currency` na svaki red, robna nijedan
 * (izmereno: sve 6 vrsta, svi redovi NULL). U ovom repou se isto već desilo sa numeracijom
 * radnih naloga (duplikat bez kape → dva puta prijavljen isti broj), pa se logika drži na
 * jednom mestu i menja na jednom mestu.
 */
import { Prisma } from "@prisma/client";

/**
 * Skala novčanih kolona `ledger_entries.debit` / `credit` = `numeric(19,4)`
 * (`schema.prisma`, model `LedgerEntry`). NIJE 2 kao BigBit-ov `CCur(Round(…,2))` —
 * kolona kod nas nosi četiri decimale, pa se i zaokružuje na četiri.
 */
export const LEDGER_AMOUNT_SCALE = 4;

/**
 * Valuta dinarske stavke kad je izvor ne zna. Isti podrazumevani kao kod čitaoca
 * (`placanja/payment-preparation.service.ts`: `currency: r.currency ?? "RSD"`), da red
 * upisan bez valute i red pročitan bez valute znače isto.
 */
export const LEDGER_DEFAULT_CURRENCY = "RSD";

/**
 * Zaokruži novčani iznos na skalu kolone, istim pravilom kojim to radi Postgres
 * (`numeric` zaokružuje pola OD nule: 0,00025 → 0,0003; −0,00025 → −0,0003).
 * `ROUND_HALF_UP` u decimal.js znači upravo to (a ne „pola na gore").
 */
export function roundLedgerAmount(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(LEDGER_AMOUNT_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** Zaglavlje dokumenta iz koga se izvode polja otvorene stavke. */
export interface OpenItemSource {
  /** Broj dokumenta koji se knjiži (obavezan — po njemu se grupišu otvorene stavke). */
  documentNumber: string;
  /** Dospeće / „valuta" dokumenta; `null` kad dokument nema rok plaćanja (popis, prenos). */
  dueDate?: Date | null;
  /** Valuta dokumenta; prazno → `LEDGER_DEFAULT_CURRENCY`. */
  currency?: string | null;
}

/** Polja otvorene stavke koja idu na SVAKI red naloga. */
export interface OpenItemFields {
  documentNumber: string;
  dueDate: Date | null;
  currency: string;
}

/**
 * Polja otvorene stavke za red glavne knjige.
 *
 * ⚠️ ZAŠTO NA SVAKI RED, A NE SAMO NA SALDAKONTO KONTO: otvorene stavke se grupišu po
 * `(account_code, analytical_code, document_number)` [`saldakonti/open-items.service.ts`], a
 * Postgres NULL-ove u `GROUP BY` tretira kao JEDNAKE — red bez broja se stopi sa svakim
 * drugim redom bez broja na istom kontu i istom komitentu. Zato broj nosi svaki red, kao i u
 * BigBitu (`[Broj dokumenta]` + `[Valuta dokumenta]` na svakoj liniji naloga).
 */
export function openItemFields(source: OpenItemSource): OpenItemFields {
  return {
    documentNumber: source.documentNumber,
    dueDate: source.dueDate ?? null,
    currency: source.currency?.trim() || LEDGER_DEFAULT_CURRENCY,
  };
}

/** Minimum koji linija naloga mora da nosi da bi se pripremila za upis. */
export interface LedgerAmounts {
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

export interface FinalizedLedgerLines<T extends LedgerAmounts> {
  /** Linije ONAKVE KAKVE IDU U BAZU (zaokružene; bez nula-redova ako je tako traženo). */
  lines: T[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  /** ΣDug === ΣPot nad zaokruženim iznosima. */
  balanced: boolean;
}

/**
 * Pripremi linije za upis i izmeri ravnotežu NAD ONIM ŠTO SE STVARNO UPISUJE.
 *
 * ⚠️ IZMEREN KVAR (05.08.2026, probno knjiženje na test bazi): motor je poredio pune
 * `Decimal` vrednosti PRE inserta, a kolona `numeric(19,4)` zatim zaokruži svaku liniju
 * NEZAVISNO. Za robni dokument sa količinom 0,0005 i cenom 0,50 nalog je u memoriji
 * balansirao (ΣDug = ΣPot = 0,00055), a u bazi NIJE (ΣDug 0,0006, ΣPot 0,0007) — glavna
 * knjiga po konstrukciji ne zatvara na nulu, a kontrola ravnoteže to ne vidi. BigBit taj
 * problem nema jer zaokružuje liniju pre upisa (`CCur(Round(…,2))`).
 *
 * Zato: prvo zaokruži, pa sabiraj, pa poredi — i upiši baš te zaokružene iznose. Ako
 * zaokruživanje razbije ravnotežu (dve linije od 0,00005 na jednoj strani), nalog PADA i
 * cela transakcija se vraća; to je namera — bolje odbijeno knjiženje nego nalog koji ne
 * zatvara.
 *
 * `dropZeroRows` (legacy „2Korak"): odbaci red kome su i dug i pot nula. Radi se POSLE
 * zaokruživanja — iznos ispod pola najmanje jedinice kolone (0,00004) je u bazi nula, pa
 * takav red ne treba ni upisivati.
 */
export function finalizeLedgerLines<T extends LedgerAmounts>(
  lines: readonly T[],
  opts: { dropZeroRows: boolean },
): FinalizedLedgerLines<T> {
  const rounded = lines.map((l) => ({
    ...l,
    debit: roundLedgerAmount(l.debit),
    credit: roundLedgerAmount(l.credit),
  }));
  const kept = opts.dropZeroRows
    ? rounded.filter((l) => !(l.debit.isZero() && l.credit.isZero()))
    : rounded;

  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  for (const l of kept) {
    totalDebit = totalDebit.add(l.debit);
    totalCredit = totalCredit.add(l.credit);
  }
  return {
    lines: kept,
    totalDebit,
    totalCredit,
    balanced: totalDebit.equals(totalCredit),
  };
}
