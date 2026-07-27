import { PrismaService } from '../../prisma/prisma.service';
import { MssqlClient } from './mssql.client';
import { GenericSyncer } from './generic.syncer';
import { TableMapping } from './sync.types';

/**
 * Fokus: full-refresh brisanje.
 * - Obična tabela: `deleteMany({})` (obriši sve) — nepromenjeno.
 * - ADDITIVE_REFRESH_TABLES (`projects`): `deleteMany({ where: { id: { in } } })`
 *   samo za id-jeve koje izvor vrati, pa 2.0-native predmeti (id koji izvor NE
 *   vraća) preživljavaju. Odluka: `Predmeti` nema watermark kolonu, pa
 *   incremental nije opcija — menja se samo korak brisanja.
 */
describe('GenericSyncer — full-refresh brisanje', () => {
  function makeMapping(targetDb: string): TableMapping {
    if (targetDb === 'companies') {
      // Mapa zna SAMO ono što BigBit ima; `iban`/`swift` su 3.0-native i nemapirani.
      return {
        source: 'Radni fajlovi',
        model: 'Company',
        targetDb,
        pk: { kind: 'single', field: 'id' },
        watermark: null,
        columns: [
          { src: 'IDBaze', field: 'id', type: 'Int', nullable: false, isId: true },
          {
            src: 'Firma',
            field: 'companyName',
            type: 'String',
            nullable: false,
            isId: false,
          },
        ],
      };
    }
    if (targetDb === 'items') {
      return {
        source: 'R_Artikli',
        model: 'Item',
        targetDb,
        pk: { kind: 'single', field: 'id' },
        watermark: null,
        columns: [
          { src: 'IDArtikal', field: 'id', type: 'Int', nullable: false, isId: true },
          {
            src: 'Sifra artikla',
            field: 'catalogNumber',
            type: 'String',
            nullable: false,
            isId: false,
          },
        ],
      };
    }
    return {
      source: targetDb === 'projects' ? 'Predmeti' : 'Warehouses',
      model: targetDb === 'projects' ? 'Project' : 'Warehouse',
      targetDb,
      pk: { kind: 'single', field: 'id' },
      watermark: null,
      columns: [
        { src: 'IDPredmet', field: 'id', type: 'Int', nullable: false, isId: true },
        {
          src: 'BrojPredmeta',
          field: 'projectNumber',
          type: 'String',
          nullable: false,
          isId: false,
        },
      ],
    };
  }

  function setup(
    targetDb: string,
    rows: Record<string, unknown>[],
    // Postojeći redovi u 2.0 sa istim brojem (paritet-guard `findMany` lookup).
    existingByNumber: { id: number; projectNumber: string }[] = [],
  ) {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const upsert = jest.fn().mockResolvedValue({});
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue(existingByNumber);

    const delegateName =
      targetDb === 'projects'
        ? 'project'
        : targetDb === 'items'
          ? 'item'
          : targetDb === 'companies'
            ? 'company'
            : 'warehouse';
    const txDelegate = { deleteMany, createMany };
    const tx: Record<string, unknown> = {
      [delegateName]: txDelegate,
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    const prisma = {
      // owned-table protection precheck (not owned here, but keep it safe)
      [delegateName]: { count, findMany, upsert },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;

    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    const syncer = new GenericSyncer(makeMapping(targetDb), mssql, prisma);
    return { syncer, deleteMany, createMany, findMany, upsert };
  }

  it('obična tabela: briše SVE (deleteMany({}))', async () => {
    const { syncer, deleteMany, createMany } = setup('warehouses', [
      { IDPredmet: 1, BrojPredmeta: 'W1' },
    ]);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({});
    expect(createMany).toHaveBeenCalled();
  });

  it('projects (additive): briše SAMO id-jeve koje izvor vrati', async () => {
    const { syncer, deleteMany, createMany } = setup('projects', [
      { IDPredmet: 101, BrojPredmeta: 'P101' },
      { IDPredmet: 102, BrojPredmeta: 'P102' },
    ]);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [101, 102] } } });
    // native predmet (npr. id 900001) nije u `in`, pa se ne dira.
    expect(createMany).toHaveBeenCalled();
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz KRITIČNO). `companies` je mapirana sa
   * `watermark: null` → full refresh → `deleteMany({})` + `createMany(mapirane
   * kolone)`. Kolone `iban`/`swift` (unose se u Podešavanjima, štampaju na ino
   * fakturi, idu u UBL `cac:PaymentMeans`) BigBit NEMA, pa nisu u mapi — jedno
   * pokretanje sinhronizacije bi ih obrisalo TIHO, bez greške u logu, i strani
   * kupac bi dobio račun bez podataka za uplatu.
   */
  it('companies: NIKAD ne briše — upsert samo nad mapiranim kolonama (iban/swift preživljavaju)', async () => {
    const { syncer, deleteMany, createMany, upsert } = setup('companies', [
      { IDBaze: 1, Firma: 'SERVOTEH d.o.o.' },
    ]);
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    // Brisanja NEMA ni u kom obliku — to je cela poenta zaštite.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: 1 });
    // `update` sme da dira SAMO mapirane kolone; nemapirano se ne pominje, pa
    // Prisma te kolone ne dira i ručno unet IBAN ostaje u bazi.
    expect(Object.keys(arg.update).sort()).toEqual(['companyName', 'id']);
    expect(arg.update).not.toHaveProperty('iban');
    expect(arg.update).not.toHaveProperty('swift');
    expect(result.rowsUpserted).toBe(1);
  });

  it('projects (additive) sa praznim izvorom: NE briše ništa', async () => {
    const { syncer, deleteMany } = setup('projects', []);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  // Paritet brojeva (Nenad 22.07): predmet se ručno unosi u OBA sistema sa istim
  // brojem → BigBit kopija (svoj id, isti broj) se na sync-u preskače; 3.0-native
  // red je istina. Ranije ubačena kopija se briše (id je u izvornom skupu) i ne
  // reinsertuje — self-heal.
  it('projects paritet: BigBit kopija broja koji postoji na native redu se PRESKAČE uz upozorenje', async () => {
    const { syncer, deleteMany, createMany, findMany } = setup(
      'projects',
      [
        { IDPredmet: 7620, BrojPredmeta: '10001' }, // kopija native predmeta
        { IDPredmet: 102, BrojPredmeta: 'P102' }, // običan BigBit predmet
      ],
      [{ id: 10476, projectNumber: '10001' }], // 3.0-native red (id NIJE u izvoru)
    );
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectNumber: { in: ['10001', 'P102'] } },
      }),
    );
    // Brisanje i dalje pokriva OBA izvorna id-ja (self-heal ranije kopije)…
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [7620, 102] } } });
    // …ali se kopija NE reinsertuje.
    const inserted = createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { id: number }[] }).data,
    );
    expect(inserted.map((r) => r.id)).toEqual([102]);
    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain('paritet brojeva');
  });

  it('projects paritet: broj na BigBit-ovom SOPSTVENOM redu (id u izvoru) se normalno osvežava', async () => {
    const { syncer, createMany } = setup(
      'projects',
      [{ IDPredmet: 101, BrojPredmeta: 'P101' }],
      // Postojeći red istog broja je BAŠ taj BigBit red (id 101 u izvornom skupu).
      [{ id: 101, projectNumber: 'P101' }],
    );
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    const inserted = createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { id: number }[] }).data,
    );
    expect(inserted.map((r) => r.id)).toEqual([101]);
    expect(result.rowsSkipped).toBe(0);
  });

  // DB-081 (zahtev Nenada 25.07): kataloški broj mora biti jedinstven. BigBit je
  // unos duplikata zabranio, ali istorijski postoje — full-refresh bi ih preneo,
  // a tvrd UNIQUE bi oborio ceo `createMany` chunk. Zato guard PRE upisa.
  it('items: duplikat kataloškog broja iz izvora se PRESKAČE (prvi red pobeđuje)', async () => {
    const { syncer, createMany } = setup('items', [
      { IDArtikal: 1, 'Sifra artikla': 'AB-100' },
      { IDArtikal: 2, 'Sifra artikla': ' ab-100 ' }, // isti broj (case+razmaci)
      { IDArtikal: 3, 'Sifra artikla': 'AB-200' },
    ]);
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    const inserted = createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { id: number }[] }).data,
    );
    expect(inserted.map((r) => r.id)).toEqual([1, 3]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain('duplikat kataloškog broja');
  });

  it('items: prazan kataloški broj ne ulazi u proveru jedinstvenosti', async () => {
    const { syncer, createMany } = setup('items', [
      { IDArtikal: 1, 'Sifra artikla': '' },
      { IDArtikal: 2, 'Sifra artikla': '   ' },
    ]);
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    const inserted = createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { id: number }[] }).data,
    );
    expect(inserted.map((r) => r.id)).toEqual([1, 2]);
    expect(result.rowsSkipped).toBe(0);
  });
});
