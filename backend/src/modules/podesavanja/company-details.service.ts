import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { UpdateCompanyDetailsDto } from "./dto/podesavanja-company-details.dto";

/**
 * MATIČNI PODACI FIRME (`companies`) — memorandum i podaci za plaćanje koje ŠTAMPA svaki
 * obrazac u aplikaciji (zaglavlje: naziv, adresa, PIB, MB, tekući račun; ino faktura:
 * IBAN i SWIFT).
 *
 * ZAŠTO POSTOJI: do 27.07.2026. tabela `companies` NIJE IMALA NIJEDNOG PISCA u celom
 * backendu (`grep prisma.company.` → 16 pogodaka, svi `findFirst`/`findUnique` iz štampi).
 * Podaci su dolazili isključivo iz BigBit sinhronizacije, pa se IBAN i SWIFT — koje
 * `invoice-pdf.service.ts` čita za ino fakturu — nisu mogli uneti nigde.
 *
 * NAMERNO USKO: menja se SAMO ono što se štampa i što nema drugi ekran. Ne dira se
 * nijedna od ~60 BigBit zastavica ponašanja (`kepu*`, `pos*`, `galeb*`, `autoLock*`…) —
 * one imaju svoje značenje u knjigovodstvenom motoru i ne smeju da se menjaju iz forme
 * bez odluke knjigovođe.
 *
 * KOJA FIRMA: red se bira po `id` kad je prosleđen, inače primarna firma (najmanji id) —
 * ISTI izbor kao `loadIssuer` u štampama (`robno/print/robno-doc-layout.ts`), da ekran
 * i papir nikad ne gledaju u različit red.
 */

/** Polja koja ekran vidi i sme da menja — jedan izvor istine za select i za update. */
const EDITABLE_SELECT = {
  id: true,
  companyName: true,
  address: true,
  city: true,
  municipality: true,
  phone: true,
  fax: true,
  email: true,
  webAddress: true,
  taxId: true,
  registrationNumber: true,
  businessActivity: true,
  businessActivityCode: true,
  bankAccount: true,
  iban: true,
  swift: true,
  owner: true,
  invoiceIssuingPlace: true,
  footerText: true,
} as const;

/** Gornje granice iz šeme — validacija ovde daje srpsku poruku umesto sirovog 22001 iz baze. */
const MAX_LEN: Record<string, number> = {
  companyName: 150,
  address: 50,
  city: 50,
  municipality: 50,
  phone: 50,
  fax: 50,
  email: 30,
  webAddress: 50,
  taxId: 20,
  registrationNumber: 50,
  businessActivity: 255,
  businessActivityCode: 50,
  bankAccount: 50,
  iban: 34,
  swift: 11,
  owner: 50,
  invoiceIssuingPlace: 50,
  footerText: 255,
};

/**
 * Naziv polja ONAKO KAKO PIŠE NA EKRANU. Poruka o grešci je ranije ispisivala
 * identifikator iz koda („Polje „businessActivityCode" sme imati najviše 50…"),
 * pa knjigovođa nije znao koje polje da skrati — na ekranu piše „Šifra delatnosti".
 * Tekstovi su isti kao natpisi u `frontend/src/app/podesavanja/_components/firma-tab.tsx`.
 */
const FIELD_LABEL: Record<string, string> = {
  companyName: "Naziv firme",
  address: "Adresa",
  city: "Mesto",
  municipality: "Opština",
  phone: "Telefon",
  fax: "Faks",
  email: "E-pošta",
  webAddress: "Veb adresa",
  taxId: "PIB",
  registrationNumber: "Matični broj",
  businessActivity: "Delatnost",
  businessActivityCode: "Šifra delatnosti",
  bankAccount: "Tekući račun",
  iban: "IBAN",
  swift: "SWIFT/BIC",
  owner: "Odgovorno lice",
  invoiceIssuingPlace: "Mesto izdavanja računa",
  footerText: "Tekst u podnožju",
};

@Injectable()
export class CompanyDetailsService {
  private readonly logger = new Logger(CompanyDetailsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Podaci firme za ekran. `id` izostavljen → primarna firma (najmanji id), kao u štampama. */
  async get(id?: number | null) {
    const company =
      id != null && id > 0
        ? await this.prisma.company.findUnique({
            where: { id },
            select: EDITABLE_SELECT,
          })
        : await this.prisma.company.findFirst({
            orderBy: { id: "asc" },
            select: EDITABLE_SELECT,
          });
    if (!company)
      throw new NotFoundException(
        "Podaci firme nisu podešeni — u tabeli firmi nema nijednog reda.",
      );
    return { data: company };
  }

  /**
   * Izmena matičnih podataka. `undefined` polje se ne dira; `null`/prazan string briše
   * (papir tada ne ispisuje taj red — bolje bez reda nego red sa izmišljenim podatkom).
   *
   * IBAN i SWIFT se čuvaju BEZ razmaka i velikim slovima: IBAN se na papiru formatira
   * u grupe od 4, a poređenje sa bankarskim izvorom mora da radi nad kanonskim oblikom.
   */
  async update(id: number | null | undefined, dto: UpdateCompanyDetailsDto) {
    const current = await this.get(id);
    const companyId = current.data.id;

    const data: Record<string, string | null> = {};
    const put = (key: keyof UpdateCompanyDetailsDto, raw?: string | null) => {
      if (raw === undefined) return;
      // Tipski čuvar: globalni `ValidationPipe` sada odbija ne-string (DTO je klasa),
      // ali servis se poziva i iz koda — bolje 422 nego 500 iz `.trim()`.
      if (raw !== null && typeof raw !== "string")
        throw new UnprocessableEntityException(
          `Polje „${FIELD_LABEL[key as string] ?? String(key)}" mora biti tekst.`,
        );
      const value = raw == null ? null : raw.trim();
      const clean = value === "" ? null : value;
      const max = MAX_LEN[key as string];
      if (clean != null && max != null && clean.length > max)
        throw new UnprocessableEntityException(
          `Polje „${FIELD_LABEL[key as string] ?? String(key)}" sme imati najviše ` +
            `${max} znakova (uneto ${clean.length}).`,
        );
      data[key as string] = clean;
    };

    put("companyName", dto.companyName);
    put("address", dto.address);
    put("city", dto.city);
    put("municipality", dto.municipality);
    put("phone", dto.phone);
    put("fax", dto.fax);
    put("email", dto.email);
    put("webAddress", dto.webAddress);
    put("taxId", dto.taxId);
    put("registrationNumber", dto.registrationNumber);
    put("businessActivity", dto.businessActivity);
    put("businessActivityCode", dto.businessActivityCode);
    put("bankAccount", dto.bankAccount);
    put("owner", dto.owner);
    put("invoiceIssuingPlace", dto.invoiceIssuingPlace);
    put("footerText", dto.footerText);
    put("iban", normalizeCode(dto.iban));
    put("swift", normalizeCode(dto.swift));

    if (dto.companyName !== undefined && data.companyName == null)
      throw new UnprocessableEntityException(
        "Naziv firme ne sme biti prazan — ispisuje se u zaglavlju svakog dokumenta.",
      );

    if (Object.keys(data).length === 0)
      throw new UnprocessableEntityException("Nijedno polje nije prosleđeno.");

    // IBAN/SWIFT se proveravaju TEK ako su uneti — prazno polje je validno stanje
    // (firma bez izvoza ih nema), a poluunet IBAN bi tiho otišao na ino fakturu.
    if (data.iban != null) assertIban(data.iban);
    if (data.swift != null) assertSwift(data.swift);

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data,
      select: EDITABLE_SELECT,
    });
    this.logger.log(
      `Izmenjeni podaci firme ${companyId} (${Object.keys(data).join(", ")}).`,
    );
    return { data: updated };
  }
}

/** IBAN/SWIFT bez razmaka i velikim slovima (kanonski oblik za poređenje i za UBL). */
function normalizeCode(
  v: string | null | undefined,
): string | null | undefined {
  if (v === undefined) return undefined;
  if (v == null) return null;
  return v.replace(/\s+/g, "").toUpperCase();
}

/**
 * IBAN — struktura po ISO 13616 (2 slova zemlje + 2 kontrolne cifre + do 30 alfanumerika)
 * i MOD-97 kontrola po ISO 7064. Ovo NIJE kozmetika: pogrešan IBAN na ino fakturi znači
 * da uplata ne stigne, a greška se otkrije tek kad kupac pozove.
 */
function assertIban(iban: string): void {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban))
    throw new UnprocessableEntityException(
      "IBAN nije ispravnog oblika (dva slova zemlje, dve kontrolne cifre, pa broj računa).",
    );
  // MOD-97: prva 4 znaka na kraj, slova → brojevi (A=10 … Z=35), ostatak deljenja mora biti 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const part = /\d/.test(ch)
      ? ch
      : String(ch.charCodeAt(0) - "A".charCodeAt(0) + 10);
    for (const d of part) remainder = (remainder * 10 + Number(d)) % 97;
  }
  if (remainder !== 1)
    throw new UnprocessableEntityException(
      "IBAN ne prolazi kontrolu ispravnosti (MOD-97) — proverite da nije pogrešno prepisan.",
    );
}

/** SWIFT/BIC po ISO 9362: 4 slova banka + 2 slova zemlja + 2 alfanum. lokacija + opciono 3 filijala. */
function assertSwift(swift: string): void {
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift))
    throw new UnprocessableEntityException(
      "SWIFT/BIC mora imati 8 ili 11 znakova (npr. DBDBRSBG ili DBDBRSBGXXX).",
    );
}
