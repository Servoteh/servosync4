import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  isNativeRow,
  NATIVE_ID_BASE,
  NATIVE_ID_MAX,
} from "../sync/table-ownership";
import { assertIban, assertSwift, normalizeBankCode } from "./bank-codes";
import { describeEmptyBody } from "./empty-body";
import type {
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from "./dto/podesavanja-payment-account.dto";

/** Entitet u `sync/table-ownership.ts` (ime tabele u bazi) — jedan izvor, bez prepisivanja. */
const ENTITY = "payment_accounts";

/**
 * DEVIZNI RAČUN FIRME (`payment_accounts`) — blok „Beneficiary Customer / Bank of
 * beneficiary" na izvoznoj fakturi.
 *
 * ZAŠTO POSTOJI: kolone `iban`, `swift`, `bank_address` i `currency` su dodate migracijom
 * `20260801100000_stampa_faktura_polja`, štampa ih od tada ČITA (`invoice-pdf.service.ts`
 * → `loadForeignAccount`) — ali ih NIJEDAN pisac nije punio. Rezultat je bio isti kvar
 * zbog kog je posao i počeo, samo pomeren za jedan korak: izvozna faktura izlazi bez
 * ijedne bankarske instrukcije, pa strani kupac nema gde da plati.
 *
 * ═══ UNOS JE OTVOREN 05.08.2026 (prijava vlasnika) ════════════════════════════════
 * Do tada je ovaj servis nudio SAMO izmenu zatečenih redova, uz obrazloženje da skup
 * redova i njihove ključeve drži BigBit. Bojazan je bila tačna, ali posledica je bio
 * ćorsokak: `payment_accounts` na produkciji ima NULA redova, BigBit `.mdb` kanal ovu
 * tabelu NE UVOZI uopšte (izmereno: nijedan pogodak na `paymentAccount` u
 * `bigbit-mdb-import.service.ts`), a izvozna faktura u stranoj valuti bez IBAN-a i
 * SWIFT-a odbija da se odštampa (brana 02.08.2026). Ekran je zato upućivao na SQL u
 * dokumentaciji — dakle na put koji vlasnik ne može da pređe.
 *
 * Rešenje NIJE nova konvencija, nego ono koje ovaj repo već koristi za native redove u
 * BigBit tabelama: REZERVISAN OPSEG KLJUČEVA. `payment_accounts` je od 05.08. u
 * `NATIVE_ID_RANGE_TABLES` (`sync/table-ownership.ts`), pa:
 *
 *   • nov red dobija `id >= NATIVE_ID_BASE` (900.000.000) — isti obrazac kao
 *     `nextNativeItemId` / `nextNativeCustomerId`, uz `pg_advisory_xact_lock`;
 *   • izvorni red koji bi upao u taj opseg syncer PRESKAČE, pa ne može da pregazi naš;
 *   • tabela je i u `NATIVE_COLUMN_TABLES`, pa syncer za nju NIKAD ne poziva `deleteMany`
 *     (upsert-grana) — native red ne može da nestane ni punim osvežavanjem.
 *
 * Sve tri tvrdnje pinuju testovi u `generic.syncer.spec.ts` i `table-ownership.spec.ts`.
 *
 * ⚠️ BEZ CHECK-a U BAZI: `chk_*_native_id_range` za `items`/`customers` je oblika
 * `source='NATIVE' ⇔ id >= 900000000`, a ova tabela nema kolonu `source` — poreklo se
 * čita isključivo iz opsega `id`-a. Izmereno na dev bazi: `id` je `integer` (int4), pa
 * 900.000.000 staje u kolonu; eksplicitan `id` NE pomera `payment_accounts_id_seq`, pa
 * native unos ne troši BigBit prostor ključeva. Postoji i self-FK
 * `fk_payment_accounts_self (id → id)` — zadovoljava ga sam ubačeni red (provereno
 * unosom u transakciji koja je vraćena).
 *
 * ŠTA OSTAJE BIGBIT-OVO: na redu KOJI JE DONEO BIGBIT menjaju se samo četiri kolone koje
 * sync ne poznaje (`iban`, `swift`, `bank_address`, `currency`); `accountNumber`,
 * `isDefault`, `sortOrder`, `countryCode` i `bankCode` bi sledeći sync vratio na staro,
 * pa forma za njih ne nudi ništa. Na 4.0-native redu `accountNumber` JE naš (BigBit ga ne
 * poznaje), pa se sme ispraviti — inače bi slovna greška u broju računa bila trajna.
 *
 * KOJA FIRMA: `companyId` se bira isto kao u `company-details.service.ts` i u štampama —
 * prosleđen `id`, inače primarna firma (najmanji id).
 */

/** Ono što ekran vidi. `bankName` je BigBit-ov, ali ga forma sme da dopuni kad je prazan. */
const ACCOUNT_SELECT = {
  id: true,
  companyId: true,
  accountNumber: true,
  bankName: true,
  isDefault: true,
  sortOrder: true,
  iban: true,
  swift: true,
  bankAddress: true,
  currency: true,
} as const;

/** Gornje granice iz šeme — srpska poruka umesto sirovog 22001 iz baze. */
const MAX_LEN: Record<string, number> = {
  accountNumber: 50,
  iban: 34,
  swift: 11,
  bankName: 50,
  currency: 3,
};

/** Naziv polja ONAKO KAKO PIŠE NA EKRANU (poruka o grešci mora da imenuje polje, ne kod). */
const FIELD_LABEL: Record<string, string> = {
  accountNumber: "Broj računa",
  iban: "IBAN",
  swift: "SWIFT/BIC",
  bankName: "Naziv banke",
  bankAddress: "Adresa banke",
  currency: "Valuta računa",
};

/** Polja koja `PUT` poznaje — spisak za dijagnostiku praznog tela (`empty-body.ts`). */
const UPDATE_FIELDS = [
  "accountNumber",
  "iban",
  "swift",
  "bankName",
  "bankAddress",
  "currency",
] as const;

/**
 * Ono što proverama treba od Prisme — isti tip za `PrismaService` i za transakcioni
 * klijent, da provera „valuta zauzeta" ne postoji u dve kopije (unos je pod bravom u
 * transakciji, izmena nije).
 */
type PaymentAccountClient = Pick<Prisma.TransactionClient, "paymentAccount">;

/** Samo cifre — poređenje broja računa bez crta i razmaka („160-...-86" ↔ „160...86"). */
function digitsOnly(v: string): string {
  return v.replace(/\D/gu, "");
}

/** Valuta u kanonskom obliku; „eur" i „EUR" NE SMEJU biti dva različita računa. */
function canonCurrency(v: string): string {
  return v.trim().toUpperCase();
}

/** ISO 4217 je troslovna oznaka — bez toga štampa ne može da izabere račun po valuti. */
function assertCurrency(v: string): void {
  if (!/^[A-Z]{3}$/.test(v))
    throw new UnprocessableEntityException(
      "Valuta mora biti troslovna oznaka po ISO 4217 (npr. EUR, USD, RSD).",
    );
}

@Injectable()
export class PaymentAccountsService {
  private readonly logger = new Logger(PaymentAccountsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Računi izabrane firme, istim redosledom kojim ih štampa bira (default → sortOrder → id). */
  async list(companyId?: number | null) {
    const id = await this.resolveCompanyId(companyId);
    const data = await this.prisma.paymentAccount.findMany({
      where: { companyId: id },
      select: ACCOUNT_SELECT,
      orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    return { data };
  }

  /**
   * NOV DEVIZNI RAČUN u rezervisanom 4.0 opsegu ključeva.
   *
   * REDOSLED JE BITAN: sve provere idu PRE unosa i sve unutar JEDNE transakcije pod
   * `pg_advisory_xact_lock`. Bez brave dva paralelna zahteva dobiju isti `id` (PK 23505),
   * a provera „za tu valutu račun već postoji" bi propustila dva EUR reda kroz prozor
   * između čitanja i upisa — a štampa bira račun PO VALUTI, pa bi papir posle ćutke
   * uzimao jedan od dva.
   */
  async create(dto: CreatePaymentAccountDto) {
    const companyId = await this.resolveCompanyId(dto.companyId ?? null);

    const accountNumber = this.requireText(dto.accountNumber, "accountNumber");
    const currency = canonCurrency(this.requireText(dto.currency, "currency"));
    const iban = normalizeBankCode(this.requireText(dto.iban, "iban"))!;
    const swift = normalizeBankCode(this.requireText(dto.swift, "swift"))!;
    const bankName = this.optionalText(dto.bankName, "bankName");
    const bankAddress = this.optionalText(dto.bankAddress, "bankAddress");

    // Ista validacija kao na izmeni — jedan izvor (`bank-codes.ts`), ne druga grana.
    assertCurrency(currency);
    assertIban(iban);
    assertSwift(swift);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payment_accounts_native_id'))`;

      await this.assertCurrencyFree(tx, companyId, currency, null);
      await this.assertAccountNumberFree(tx, accountNumber, null);

      const id = await nextNativePaymentAccountId(tx);
      return tx.paymentAccount.create({
        data: {
          id,
          companyId,
          accountNumber,
          currency,
          iban,
          swift,
          bankName,
          bankAddress,
          // Podrazumevani račun ostaje BigBit-ov dinarski: zaglavlje dokumenta ionako
          // čita `companies.bankAccount`, a `loadForeignAccount` bira po valuti, ne po
          // ovoj zastavici. Postavljati je odavde značilo bi menjati BigBit podatak.
          isDefault: false,
          sortOrder: 0,
        },
        select: ACCOUNT_SELECT,
      });
    });

    this.logger.log(
      `Unet 4.0-native devizni račun ${created.id} (firma ${companyId}, valuta ${currency}).`,
    );
    return { data: created };
  }

  /**
   * Dopuna jednog računa. `undefined` polje se ne dira; `null`/prazan string briše
   * (papir tada taj red ne ispisuje — bolje bez reda nego red sa izmišljenim podatkom).
   *
   * @param rawBody sirovo telo (`req.body`) — samo za dijagnostiku praznog tela, v.
   *   `empty-body.ts`. Ne čita se kao podatak.
   */
  async update(id: number, dto: UpdatePaymentAccountDto, rawBody?: unknown) {
    if (!Number.isInteger(id) || id <= 0)
      throw new UnprocessableEntityException("Neispravan broj računa za plaćanje.");

    const existing = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!existing)
      throw new NotFoundException(`Račun za plaćanje ${id} ne postoji.`);
    const jeNativni = isNativeRow(ENTITY, id);

    const data: Record<string, string | null> = {};
    const put = (key: string, raw?: string | null) => {
      if (raw === undefined) return;
      // Tipski čuvar: `ValidationPipe` odbija ne-string, ali servis se poziva i iz koda —
      // bolje 422 nego 500 iz `.trim()`.
      if (raw !== null && typeof raw !== "string")
        throw new UnprocessableEntityException(
          `Polje „${FIELD_LABEL[key] ?? key}" mora biti tekst.`,
        );
      const value = raw == null ? null : raw.trim();
      const clean = value === "" ? null : value;
      const max = MAX_LEN[key];
      if (clean != null && max != null && clean.length > max)
        throw new UnprocessableEntityException(
          `Polje „${FIELD_LABEL[key] ?? key}" sme imati najviše ${max} znakova ` +
            `(uneto ${clean.length}).`,
        );
      data[key] = clean;
    };

    put("iban", normalizeBankCode(dto.iban));
    put("swift", normalizeBankCode(dto.swift));
    put("bankName", dto.bankName);
    // Adresa banke je VIŠERED („…7b, 11070 New Belgrade" + „Republic of Serbia") — prelom
    // je podatak, ne formatiranje, pa se `\n` čuva; briše se samo prazan prostor sa krajeva.
    put("bankAddress", dto.bankAddress);
    // Valuta je oznaka iz ISO 4217 i po njoj štampa BIRA račun (`loadForeignAccount`), pa
    // mora biti kanonska: „eur" i „EUR" ne smeju da budu dva različita računa.
    put(
      "currency",
      dto.currency === undefined || dto.currency === null
        ? dto.currency
        : canonCurrency(dto.currency),
    );
    // BROJ RAČUNA — samo na 4.0-native redu. Na BigBit redu bi sledeći sync izmenu vratio
    // na staro, pa ekran ne sme da obeća ono što ne može da održi; odbija se GLASNO, jer
    // je tiho ignorisanje polja isti razred kvara koji je ovaj posao i otvorio.
    if (dto.accountNumber !== undefined) {
      if (!jeNativni)
        throw new UnprocessableEntityException(
          `Broj računa ${id} donosi BigBit i ne može se menjati iz aplikacije — ` +
            "sledeća sinhronizacija bi izmenu vratila na staro. Menja se u BigBit-u " +
            "(UplatniRacuni), a ovde se dopunjuju IBAN, SWIFT, banka i valuta.",
        );
      put("accountNumber", dto.accountNumber);
      if (data.accountNumber == null)
        throw new UnprocessableEntityException(
          "Broj računa ne sme biti prazan — po njemu se račun prepoznaje na izvodu.",
        );
    }

    if (Object.keys(data).length === 0) {
      const dijagnostika = describeEmptyBody(
        rawBody,
        UPDATE_FIELDS,
        "devizni račun",
      );
      this.logger.warn(
        `PUT /admin/firma/racuni/${id} bez ijednog polja za upis: ${dijagnostika.logDetail}`,
      );
      throw new UnprocessableEntityException(dijagnostika.message);
    }

    // Provera TEK ako je polje uneto — prazno je validno stanje (dinarski račun nema IBAN),
    // a poluunet IBAN bi tiho otišao na ino fakturu i uplata ne bi stigla.
    if (data.iban != null) assertIban(data.iban);
    if (data.swift != null) assertSwift(data.swift);
    if (data.currency != null) assertCurrency(data.currency);

    // DVE VALUTE ISTI RAČUN je tiha greška na papiru: `loadForeignAccount` bira račun po
    // valuti, pa bi dva EUR reda značila da faktura uzima jedan od njih bez pravila.
    if (data.currency != null)
      await this.assertCurrencyFree(
        this.prisma,
        existing.companyId,
        data.currency,
        id,
      );
    if (data.accountNumber != null)
      await this.assertAccountNumberFree(this.prisma, data.accountNumber, id);

    const updated = await this.prisma.paymentAccount.update({
      where: { id },
      data,
      select: ACCOUNT_SELECT,
    });
    this.logger.log(
      `Izmenjen devizni račun ${id} (${Object.keys(data).join(", ")}).`,
    );
    return { data: updated };
  }

  /** Obavezno tekstualno polje na unosu — 422 sa nazivom polja sa ekrana, ne sirovi 500. */
  private requireText(raw: unknown, key: string): string {
    const label = FIELD_LABEL[key] ?? key;
    if (typeof raw !== "string" || raw.trim() === "")
      throw new UnprocessableEntityException(
        `Polje „${label}" je obavezno za nov devizni račun.`,
      );
    const value = raw.trim();
    const max = MAX_LEN[key];
    if (max != null && value.length > max)
      throw new UnprocessableEntityException(
        `Polje „${label}" sme imati najviše ${max} znakova (uneto ${value.length}).`,
      );
    return value;
  }

  /** Neobavezno tekstualno polje na unosu; prazno → `null` (papir taj red ne ispisuje). */
  private optionalText(raw: unknown, key: string): string | null {
    if (raw === undefined || raw === null) return null;
    const label = FIELD_LABEL[key] ?? key;
    if (typeof raw !== "string")
      throw new UnprocessableEntityException(`Polje „${label}" mora biti tekst.`);
    const value = raw.trim();
    if (value === "") return null;
    const max = MAX_LEN[key];
    if (max != null && value.length > max)
      throw new UnprocessableEntityException(
        `Polje „${label}" sme imati najviše ${max} znakova (uneto ${value.length}).`,
      );
    return value;
  }

  /**
   * Jedna valuta = jedan račun po firmi. Poređenje je kanonsko (`upper(trim)`), jer bi
   * inače „eur" i „EUR" prošli kao dva reda, a štampa vidi istu valutu.
   */
  private async assertCurrencyFree(
    client: PaymentAccountClient,
    companyId: number,
    currency: string,
    exceptId: number | null,
  ): Promise<void> {
    const rows = await client.paymentAccount.findMany({
      where: { companyId },
      select: { id: true, currency: true, accountNumber: true },
    });
    const hit = rows.find(
      (r) =>
        r.id !== exceptId &&
        r.currency != null &&
        canonCurrency(r.currency) === currency,
    );
    if (hit)
      throw new UnprocessableEntityException(
        `Za valutu ${currency} već postoji račun (${hit.accountNumber}). Štampa bira ` +
          "račun po valuti, pa dva reda u istoj valuti znače da faktura uzima jedan od " +
          "njih bez pravila. Dopunite postojeći račun umesto unosa novog.",
      );
  }

  /**
   * Broj računa mora biti jedinstven — i to GLOBALNO, ne po firmi: uvoz bankarskog izvoda
   * (`izvodi/bank-statement.service.ts` → `resolveBankAccount`) traži konto banke po broju
   * računa nad CELOM tabelom, bez filtera po firmi i bez uređenja. Dupli broj bi ga naveo
   * na naš novi red (koji `bank_code` nema) i uvoz izvoda bi pao sa „konto banke nije
   * definisan" — kvar u sasvim drugom modulu, bez vidljive veze sa ovim ekranom.
   *
   * Poredi se SAMO PO CIFRAMA: „160-0050100035011-86" i „1600050100035011 86" su isti račun.
   */
  private async assertAccountNumberFree(
    client: PaymentAccountClient,
    accountNumber: string,
    exceptId: number | null,
  ): Promise<void> {
    const digits = digitsOnly(accountNumber);
    if (digits === "") return;
    const rows = await client.paymentAccount.findMany({
      select: { id: true, accountNumber: true },
    });
    const hit = rows.find(
      (r) => r.id !== exceptId && digitsOnly(r.accountNumber) === digits,
    );
    if (hit)
      throw new UnprocessableEntityException(
        `Račun ${accountNumber} već postoji (interni broj ${hit.id}). Dopunite postojeći ` +
          "red — dva reda sa istim brojem računa obaraju uvoz bankarskog izvoda.",
      );
  }

  /** Isti izbor firme kao `company-details.service.ts` — ekran i papir gledaju u isti red. */
  private async resolveCompanyId(companyId?: number | null): Promise<number> {
    if (companyId != null && companyId > 0) return companyId;
    const company = await this.prisma.company.findFirst({
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (!company)
      throw new NotFoundException(
        "Podaci firme nisu podešeni — u tabeli firmi nema nijednog reda.",
      );
    return company.id;
  }
}

/**
 * Sledeći `id` iz REZERVISANOG 4.0 opsega — `MAX(id) + 1` UNUTAR opsega. Zove se pod
 * `pg_advisory_xact_lock` (bez brave dve paralelne transakcije dobiju isti broj), isti
 * obrazac kao `nextNativeItemId` i `nextNativeCustomerId`.
 *
 * ZAŠTO NE `nextval`: `payment_accounts_id_seq` stoji na `last_value=1` i BigBit id-jeve
 * je dobijala eksplicitnim upisom (izmereno 05.08.2026 — eksplicitan `id` sekvencu ne
 * pomera), pa bi `nextval` vratio broj iz BigBit prostora. Računica iz opsega ne zavisi
 * od stanja sekvence, restore-a niti tuđeg `setval`-a.
 *
 * `::int` kastovi su OBAVEZNI: bez njih Prisma vezuje JS broj kao `bigint`, izraz pređe u
 * `bigint` i vrati `BigInt` — a kolona je `integer` (isto kao kod artikala i komitenata).
 */
async function nextNativePaymentAccountId(
  tx: Prisma.TransactionClient,
): Promise<number> {
  const rows = await tx.$queryRaw<{ next_id: number | bigint }[]>`
    SELECT COALESCE(MAX(id), ${NATIVE_ID_BASE - 1}::int) + 1 AS next_id
    FROM payment_accounts
    WHERE id >= ${NATIVE_ID_BASE}::int`;

  const next = Number(rows[0]?.next_id ?? NATIVE_ID_BASE);
  if (!Number.isInteger(next) || next < NATIVE_ID_BASE)
    throw new Error(`Neispravan id iz native opsega: ${String(next)}`);
  if (next > NATIVE_ID_MAX)
    throw new UnprocessableEntityException(
      "Opseg internih brojeva za račune unete u ServoSync-u je popunjen — javite administratoru.",
    );
  return next;
}
