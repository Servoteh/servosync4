import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { assertIban, assertSwift, normalizeBankCode } from "./bank-codes";
import type { UpdatePaymentAccountDto } from "./dto/podesavanja-payment-account.dto";

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
 * ═══ ZAŠTO SAMO IZMENA, BEZ DODAVANJA I BRISANJA RAČUNA ═══════════════════════════
 * `payment_accounts` je BigBit tabela (`UplatniRacuni` u `sync-map.generated.ts`) i BigBit
 * je vlasnik SKUPA REDOVA i njihovih ključeva. Za razliku od `customers`/`items`, ova
 * tabela NEMA rezervisan 4.0 opseg ključeva (`chk_*_native_id_range`), pa bi red napravljen
 * ovde dobio `id` iz istog prostora u kom BigBit deli svoje — a sync upsertuje PO `id`-u.
 * Sudar bi bio tih i opasan: BigBit bi prepisao broj računa i naziv banke, dok bi naš
 * IBAN ostao — jedan red sa DINARSKIM brojem računa i DEVIZNIM IBAN-om. Takav papir je
 * gori od praznog.
 *
 * Zato ovaj servis samo DOPUNJUJE zatečene redove sa četiri kolone koje sync ne poznaje.
 * `accountNumber`, `isDefault`, `sortOrder`, `countryCode` i `bankCode` su BigBit-ovi i
 * ostaju van forme — njih menja BigBit, a mi bismo ih na sledećem syncu ionako izgubili.
 * Ako devizni račun uopšte ne postoji kao red, unosi se JEDNOM ručno (SQL je u
 * `backend/docs/STAMPA_IZLAZNIH_FAKTURA.md` §8) — svesno, van aplikacije.
 *
 * ⚠️ PREŽIVLJAVANJE SYNC-a: da full refresh (`deleteMany` + `createMany`) ne bi obrisao
 * ove četiri kolone, `payment_accounts` je upisan u `NATIVE_COLUMN_TABLES`
 * (`sync/table-ownership.ts`). Bez toga bi IBAN nestajao posle svakog noćnog sync-a —
 * ista klasa kvara, samo sa zakašnjenjem.
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
  iban: 34,
  swift: 11,
  bankName: 50,
  currency: 3,
};

/** Naziv polja ONAKO KAKO PIŠE NA EKRANU (poruka o grešci mora da imenuje polje, ne kod). */
const FIELD_LABEL: Record<string, string> = {
  iban: "IBAN",
  swift: "SWIFT/BIC",
  bankName: "Naziv banke",
  bankAddress: "Adresa banke",
  currency: "Valuta računa",
};

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
   * Dopuna jednog računa. `undefined` polje se ne dira; `null`/prazan string briše
   * (papir tada taj red ne ispisuje — bolje bez reda nego red sa izmišljenim podatkom).
   */
  async update(id: number, dto: UpdatePaymentAccountDto) {
    if (!Number.isInteger(id) || id <= 0)
      throw new UnprocessableEntityException("Neispravan broj računa za plaćanje.");

    const existing = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Račun za plaćanje ${id} ne postoji.`);

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
        : dto.currency.trim().toUpperCase(),
    );

    if (Object.keys(data).length === 0)
      throw new UnprocessableEntityException("Nijedno polje nije prosleđeno.");

    // Provera TEK ako je polje uneto — prazno je validno stanje (dinarski račun nema IBAN),
    // a poluunet IBAN bi tiho otišao na ino fakturu i uplata ne bi stigla.
    if (data.iban != null) assertIban(data.iban);
    if (data.swift != null) assertSwift(data.swift);
    if (data.currency != null && !/^[A-Z]{3}$/.test(data.currency))
      throw new UnprocessableEntityException(
        "Valuta mora biti troslovna oznaka po ISO 4217 (npr. EUR, USD, RSD).",
      );

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
