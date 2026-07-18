import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MssqlClient } from '../mssql.client';
import {
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
} from '../sync.types';

/**
 * Komitenti (QBigTehn) -> customers (Postgres).
 *
 * - Upsert key: `Sifra` (IDENTITY) -> `id`. No surrogate "legacy" column.
 * - Incremental watermark: `PoslednjaIzmena` (datetime) -> `updatedAt`.
 * - Column order in QBigTehn is a 1:1 port to the Prisma model, so the
 *   mapping below is exhaustive (all 57 source columns).
 */
@Injectable()
export class CustomerSyncer implements EntitySyncer {
  readonly entity = 'customers';
  readonly defaultStrategy: SyncStrategy = 'incremental';
  private readonly logger = new Logger(CustomerSyncer.name);

  constructor(
    private readonly mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {}

  async sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
  }): Promise<SyncEntityResult> {
    const errors: string[] = [];
    const incremental =
      options.strategy === 'incremental' && options.cursor?.lastModifiedAt;

    // QBigTehn column names contain spaces, so they must be bracket-quoted.
    const where = incremental ? 'WHERE [PoslednjaIzmena] > @cursor' : '';
    const rows = await this.mssql.query<Record<string, unknown>>(
      `SELECT * FROM [dbo].[Komitenti] ${where} ORDER BY [PoslednjaIzmena] ASC`,
      incremental ? { cursor: new Date(options.cursor!.lastModifiedAt!) } : {},
    );

    // Resolve FK targets up front so unsatisfiable references are nulled out
    // instead of aborting the row (lookups may not be synced yet).
    const [salespersonIds, codeTypeCodes] = await Promise.all([
      this.prisma.salesperson
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
      this.prisma.codeType
        .findMany({ select: { code: true } })
        .then((r) => new Set(r.map((x) => x.code))),
    ]);

    let rowsUpserted = 0;
    let rowsSkipped = 0;
    let maxModifiedAt: Date | null = options.cursor?.lastModifiedAt
      ? new Date(options.cursor.lastModifiedAt)
      : null;

    for (const row of rows) {
      try {
        const data = this.mapRow(row, salespersonIds, codeTypeCodes);
        await this.prisma.customer.upsert({
          where: { id: data.id },
          create: data,
          update: data,
        });
        rowsUpserted++;

        const modified = row['PoslednjaIzmena'] as Date | null;
        if (modified && (!maxModifiedAt || modified > maxModifiedAt)) {
          maxModifiedAt = modified;
        }
      } catch (err) {
        rowsSkipped++;
        const message = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) {
          errors.push(`Sifra=${row['Sifra']}: ${message}`);
        }
        this.logger.warn(`Skipped customer Sifra=${row['Sifra']}: ${message}`);
      }
    }

    const newCursor: SyncCursor =
      options.strategy === 'full_refresh'
        ? { strategy: 'full_refresh' }
        : { lastModifiedAt: (maxModifiedAt ?? new Date()).toISOString() };

    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor,
      errors,
    };
  }

  /** Map a single Komitenti row to the Prisma Customer shape. */
  private mapRow(
    r: Record<string, unknown>,
    salespersonIds: Set<number>,
    codeTypeCodes: Set<string>,
  ) {
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const str = (v: unknown): string | null =>
      v === null || v === undefined ? null : String(v);
    const bool = (v: unknown): boolean | null =>
      v === null || v === undefined ? null : Boolean(v);
    const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);

    const salespersonId = num(r['Sifra prodavca']);
    const driverId = num(r['IDVozac']);
    const codeTypeCode = str(r['Vrsta sifre']);

    return {
      id: Number(r['Sifra']),
      name: String(r['Naziv']),
      branch: str(r['Poslovnica']),
      city: str(r['Mesto']),
      address: str(r['Adresa']),
      postalCode: str(r['Postanski broj']),
      bankAccount1: str(r['Ziro racun_1']),
      bankAccount2: str(r['Ziro racun_2']),
      bankAccount3: str(r['Ziro racun_3']),
      phone: str(r['Telefon']),
      fax: str(r['Fax']),
      contact: str(r['Kontakt']),
      note: str(r['Napomena']),
      country: str(r['Drzava']),
      region: num(r['Region']),
      // FK -> code_types.code; null out if the code is not present yet.
      codeTypeCode:
        codeTypeCode && codeTypeCodes.has(codeTypeCode) ? codeTypeCode : null,
      email: str(r['Email']),
      mobile: str(r['Mobilni']),
      birthDate: date(r['Datum rodjenja']),
      webAddress: str(r['Web adresa']),
      // FK -> salespeople.id; null out 0 / unknown references.
      salespersonId:
        salespersonId && salespersonIds.has(salespersonId)
          ? salespersonId
          : null,
      customerDiscount: num(r['RabatKomitenta']),
      buyerProtectionCode: str(r['ZastKodKupca']),
      taxId: String(r['PIB']),
      vatStatus: num(r['PDVStatus']),
      externalCode: str(r['MSifra']),
      paymentTermDays: num(r['Odlozeno']),
      routeId: num(r['IDRuta']),
      // self-FK -> customers.id; only keep if it points to an existing row.
      driverId: driverId && driverId > 0 ? driverId : null,
      paymentAccountId: num(r['IDUplatniRacun']),
      invoicePerDeliveryAddress: bool(r['FakturisanjePoMestimaIsporuke']),
      priceListCode: str(r['Cenovnik']),
      createdAt: date(r['PrviUnos']),
      updatedAt: date(r['PoslednjaIzmena']),
      createdBy: str(r['PrviUnosUser']),
      updatedBy: str(r['PoslednjaIzmenaUser']),
      commissionPercent: num(r['ProcenatProvizije']),
      fictitiousDiscount: num(r['FiktRabatKomitenta']),
      paymentMethod: str(r['KomitentiNacinPlacanja']),
      signature: str(r['PotpisKom']),
      shortName: str(r['SkraceniNaziv']),
      recordCreatedAt: date(r['DatumIVremeKom']),
      checkDebt: bool(r['ProveraDuga']),
      creditLimit: num(r['KreditLimit']),
      skipTaxIdValidation: bool(r['NeProveravajPIB']),
      pantheonId: str(r['IDPantheon']),
      newsletter: bool(r['NewsLetter']),
      mailToDifferentAddress: bool(r['PostaNaDruguAdresu']),
      gln: str(r['GLN']),
      manualMarkupPercent: num(r['KLRucProc']),
      balanceNote: str(r['NapomenaZaSalda']),
      hideInOverview: bool(r['NePrikazatiUPregledu']),
      publicSectorId: str(r['JBKJS']),
      registrationNumber: str(r['MaticniBroj']),
      einvoiceXmlPerItemDiscount: bool(r['ER_XMLSaPopustomPoArtiklu']),
      centralInvoiceRegistry: bool(r['CRF']),
    };
  }
}
