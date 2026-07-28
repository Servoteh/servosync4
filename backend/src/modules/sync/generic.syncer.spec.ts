import { PrismaService } from '../../prisma/prisma.service';
import { MssqlClient } from './mssql.client';
import { GenericSyncer } from './generic.syncer';
import { TableMapping } from './sync.types';
import { NATIVE_ID_BASE } from './table-ownership';

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
    if (targetDb === 'document_types') {
      return {
        source: 'R_Vrste dokumenata',
        model: 'DocumentType',
        targetDb,
        pk: { kind: 'single', field: 'id' },
        watermark: null,
        columns: [
          { src: 'ID', field: 'id', type: 'Int', nullable: false, isId: true },
          {
            src: 'Vrsta dokumenta',
            field: 'code',
            type: 'String',
            nullable: false,
            isId: false,
          },
        ],
      };
    }
    if (targetDb === 'price_list_entries') {
      return {
        source: 'Cenovnik',
        model: 'PriceListEntry',
        targetDb,
        pk: { kind: 'single', field: 'id' },
        watermark: null,
        columns: [
          { src: 'ID', field: 'id', type: 'Int', nullable: false, isId: true },
          {
            src: 'Tarifa',
            field: 'taxRateCode',
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

  const DELEGATE: Record<string, string> = {
    projects: 'project',
    items: 'item',
    document_types: 'documentType',
    price_list_entries: 'priceListEntry',
    warehouses: 'warehouse',
  };

  function setup(
    targetDb: string,
    rows: Record<string, unknown>[],
    // Postojeći redovi u 2.0 (aditivni `findMany` lookup: paritet brojeva +
    // kolizija id prostora). Ključ zavisi od tabele (projectNumber / code).
    existingRows: Record<string, unknown>[] = [],
    // Šifre tarifa koje postoje u `tax_rates` (FK pre-filter, price_list_entries).
    existingTaxRateCodes: string[] = [],
  ) {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue(existingRows);
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const taxRateFindMany = jest
      .fn()
      .mockResolvedValue(existingTaxRateCodes.map((code) => ({ code })));

    const delegateName = DELEGATE[targetDb] ?? 'warehouse';
    const txDelegate = { deleteMany, createMany };
    const tx: Record<string, unknown> = {
      [delegateName]: txDelegate,
      $executeRawUnsafe: executeRawUnsafe,
    };

    const prisma = {
      // owned-table protection precheck (not owned here, but keep it safe)
      [delegateName]: { count, findMany },
      taxRate: { findMany: taxRateFindMany },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;

    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    const syncer = new GenericSyncer(makeMapping(targetDb), mssql, prisma);
    return {
      syncer,
      deleteMany,
      createMany,
      findMany,
      executeRawUnsafe,
      taxRateFindMany,
      mssql,
    };
  }

  /** Redovi koje je `createMany` stvarno upisao (kroz sve chunk-ove). */
  function insertedIds(createMany: jest.Mock): number[] {
    const calls = createMany.mock.calls as unknown as [
      { data: { id: number }[] },
    ][];
    return calls.flatMap((c) => c[0].data).map((r) => r.id);
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

    // Jedan upit pokriva OBA guarda (26.07): isti BROJ (paritet) i isti ID
    // (kolizija id prostora sa app-owned redom).
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { projectNumber: { in: ['10001', 'P102'] } },
            { id: { in: [7620, 102] } },
          ],
        },
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

  // Review 26.07 [2]: `uq_projects_project_number` (25.07) znači da bi JEDAN
  // duplikat broja u samom BigBit izvoru oborio ceo `createMany` chunk → tok
  // predmeta pada. Dedup po izvoru se komponuje sa aditivnim skip-om.
  it('projects: duplikat broja UNUTAR izvora se preskače (uq iz 25.07 ne obara tok)', async () => {
    const { syncer, createMany } = setup('projects', [
      { IDPredmet: 101, BrojPredmeta: '10500' },
      { IDPredmet: 102, BrojPredmeta: ' 10500 ' }, // isti broj, drugi id
      { IDPredmet: 103, BrojPredmeta: '10501' },
    ]);
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(insertedIds(createMany)).toEqual([101, 103]);
    expect(result.rowsSkipped).toBe(1);
  });

  // Review 26.07 [1]: „prvi red pobeđuje" je stabilno SAMO uz ORDER BY po
  // izvornom PK — bez njega MSSQL sme da promeni redosled i sledeći sync bi
  // izabrao drugi `id` kao nosioca istog kataloškog broja.
  it('items: izvor se čita sa ORDER BY po izvornom PK (deterministički keeper)', async () => {
    const { syncer, mssql } = setup('items', [
      { IDArtikal: 1, 'Sifra artikla': 'AB-100' },
    ]);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    const sql = (mssql.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY [IDArtikal] ASC');
  });

  it('warehouses (bez SOURCE_UNIQUE_FIELDS): nema suvišnog ORDER BY', async () => {
    const { syncer, mssql } = setup('warehouses', [
      { IDPredmet: 1, BrojPredmeta: 'W1' },
    ]);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    const sql = (mssql.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).not.toContain('ORDER BY');
  });
});

/*
 * Review 26.07.2026, nalaz [0] — `document_types`. 4.0 popis je migracijom
 * 20260724160000 seed-ovao VISAR/MANJR/NIV; BigBit te šifre ne poznaje. Do sada
 * je tabela bila klasičan full refresh (`deleteMany({})`) → prvi sync (ručni ILI
 * noćni) bi ih obrisao i `createStockDocument` bi od tog trenutka bacao 422.
 */
describe('GenericSyncer — document_types (aditivno, 4.0 seed preživljava)', () => {
  const DELEGATE: Record<string, string> = {
    document_types: 'documentType',
    price_list_entries: 'priceListEntry',
  };

  function setup(
    targetDb: string,
    rows: Record<string, unknown>[],
    existingRows: Record<string, unknown>[] = [],
    existingTaxRateCodes: string[] = [],
  ) {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn().mockResolvedValue(existingRows);
    const delegateName = DELEGATE[targetDb];
    const tx: Record<string, unknown> = {
      [delegateName]: { deleteMany, createMany },
      $executeRawUnsafe: executeRawUnsafe,
    };
    const prisma = {
      [delegateName]: { count: jest.fn().mockResolvedValue(0), findMany },
      taxRate: {
        findMany: jest
          .fn()
          .mockResolvedValue(existingTaxRateCodes.map((code) => ({ code }))),
      },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;
    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    const mapping: TableMapping =
      targetDb === 'document_types'
        ? {
            source: 'R_Vrste dokumenata',
            model: 'DocumentType',
            targetDb,
            pk: { kind: 'single', field: 'id' },
            watermark: null,
            columns: [
              { src: 'ID', field: 'id', type: 'Int', nullable: false, isId: true },
              {
                src: 'Vrsta dokumenta',
                field: 'code',
                type: 'String',
                nullable: false,
                isId: false,
              },
            ],
          }
        : {
            source: 'Cenovnik',
            model: 'PriceListEntry',
            targetDb,
            pk: { kind: 'single', field: 'id' },
            watermark: null,
            columns: [
              { src: 'ID', field: 'id', type: 'Int', nullable: false, isId: true },
              {
                src: 'Tarifa',
                field: 'taxRateCode',
                type: 'String',
                nullable: false,
                isId: false,
              },
            ],
          };

    return {
      syncer: new GenericSyncer(mapping, mssql, prisma),
      deleteMany,
      createMany,
      executeRawUnsafe,
      findMany,
    };
  }

  function inserted(createMany: jest.Mock): { id: number }[] {
    const calls = createMany.mock.calls as unknown as [
      { data: { id: number }[] },
    ][];
    return calls.flatMap((c) => c[0].data);
  }

  it('briše SAMO id-jeve koje izvor vrati — 4.0 seed (VISAR) ostaje netaknut', async () => {
    const { syncer, deleteMany, createMany } = setup(
      'document_types',
      [
        { ID: 1, 'Vrsta dokumenta': 'KAL' },
        { ID: 2, 'Vrsta dokumenta': 'OTP' },
      ],
      // VISAR sedi na id 900 (van BigBit skupa) — ne sme ni da se pogleda.
      [],
    );
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
    expect(deleteMany).not.toHaveBeenCalledWith({});
    expect(inserted(createMany).map((r) => r.id)).toEqual([1, 2]);
  });

  it('KOLIZIJA ID PROSTORA: 4.0 seed na BigBit id-u se NE briše, izvorni red se preskače', async () => {
    const { syncer, deleteMany, createMany } = setup(
      'document_types',
      [
        { ID: 3, 'Vrsta dokumenta': 'KAL' },
        { ID: 4, 'Vrsta dokumenta': 'OTP' },
      ],
      // Seedovan VISAR je dobio id 3 iz PG sekvence — isti id koristi i BigBit.
      [{ id: 3, code: 'VISAR' }],
    );
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    // id 3 je IZUZET iz brisanja…
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [4] } } });
    // …i BigBit red sa tim id-em se ne upisuje (inače 23505 na PK).
    expect(inserted(createMany).map((r) => r.id)).toEqual([4]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain('kolizija id prostora');
    expect(result.errors[0]).toContain('VISAR');
  });

  it('dedup po šifri: BigBit red sa šifrom koja stoji na 4.0 redu se preskače', async () => {
    const { syncer, createMany } = setup(
      'document_types',
      [{ ID: 7, 'Vrsta dokumenta': 'NIV' }],
      // NIV već postoji kao 4.0-seed na id-u van izvornog skupa.
      [{ id: 901, code: 'NIV' }],
    );
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(inserted(createMany)).toEqual([]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain('paritet brojeva');
  });

  it('posle aditivnog prolaza podiže PG sekvencu (sledeći 4.0 unos ne pada na PK)', async () => {
    const { syncer, executeRawUnsafe } = setup('document_types', [
      { ID: 1, 'Vrsta dokumenta': 'KAL' },
    ]);
    await syncer.sync({ strategy: 'full_refresh', cursor: null });
    const sqls = executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('session_replication_role'))).toBe(true);
    const setval = sqls.find((s) => s.includes('setval'));
    expect(setval).toContain("pg_get_serial_sequence('document_types', 'id')");
    expect(setval).toContain('MAX(id)');
  });

  // Review 26.07 [3]: `tax_rates` je od 26.07 van sync mape, pa cenovnik mora sam
  // da proveri šifru tarife — FK trigeri pod `replica` režimom ne rade.
  it('price_list_entries: red sa nepostojećom šifrom tarife se PRESKAČE (FK pre-filter)', async () => {
    const { syncer, createMany } = setup(
      'price_list_entries',
      [
        { ID: 1, Tarifa: 'A' },
        { ID: 2, Tarifa: 'NEMA' },
      ],
      [],
      ['A'],
    );
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(inserted(createMany).map((r) => r.id)).toEqual([1]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain('FK pre-filter');
    expect(result.errors[0]).toContain('tax_rates');
  });
});

/**
 * REZERVISAN OPSEG KLJUČEVA — `items` i `customers` (adversarni pregled
 * 28.07.2026, nalazi [1] i [2]).
 *
 * `items` je full refresh (`watermark: null`): `deleteMany({})` + `createMany`
 * pod `session_replication_role='replica'`. Bez zaštite bi 4.0-native artikal
 * bio OBRISAN — a `price_list_entries` i `work_order_item_components` ostali
 * siročad, jer FK trigeri u `replica` režimu ćute. Isključenje iz noćnog posla
 * (`NIGHTLY_SYNC_EXCLUDED`) to NE pokriva: ručni `POST /sync/run` radi isti
 * `deleteMany`. Zaštita zato živi u syncer-u, ne u rasporedu poslova.
 */
describe('GenericSyncer — rezervisan opseg 4.0-native ključeva', () => {
  const DELEGATE: Record<string, string> = {
    items: 'item',
    customers: 'customer',
  };

  function mappingFor(targetDb: string): TableMapping {
    if (targetDb === 'customers') {
      return {
        source: 'Komitenti',
        model: 'Customer',
        targetDb,
        pk: { kind: 'single', field: 'id' },
        // Kao u `sync-map.generated.ts`: komitenti IMAJU watermark, pa je
        // podrazumevana strategija inkrementalna (upsert po `id`).
        watermark: 'updatedAt',
        columns: [
          { src: 'Sifra', field: 'id', type: 'Int', nullable: false, isId: true },
          {
            src: 'Naziv',
            field: 'name',
            type: 'String',
            nullable: false,
            isId: false,
          },
          {
            src: 'PoslednjaIzmena',
            field: 'updatedAt',
            type: 'DateTime',
            nullable: true,
            isId: false,
          },
        ],
      };
    }
    return {
      source: 'R_Artikli',
      model: 'Item',
      targetDb,
      pk: { kind: 'single', field: 'id' },
      watermark: null,
      columns: [
        {
          src: 'Sifra artikla',
          field: 'id',
          type: 'Int',
          nullable: false,
          isId: true,
        },
        {
          src: 'Kataloski broj',
          field: 'catalogNumber',
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
    /** Koliko 4.0-native redova već stoji u tabeli (`count` za `note`). */
    nativeRowCount = 0,
  ) {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const upsert = jest.fn().mockResolvedValue({});
    const count = jest.fn().mockResolvedValue(nativeRowCount);
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const delegateName = DELEGATE[targetDb];

    const tx: Record<string, unknown> = {
      [delegateName]: { deleteMany, createMany },
      $executeRawUnsafe: executeRawUnsafe,
    };
    const prisma = {
      [delegateName]: {
        count,
        findMany: jest.fn().mockResolvedValue([]),
        upsert,
      },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;
    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    return {
      syncer: new GenericSyncer(mappingFor(targetDb), mssql, prisma),
      deleteMany,
      createMany,
      upsert,
      count,
    };
  }

  function insertedHere(createMany: jest.Mock): number[] {
    const calls = createMany.mock.calls as unknown as [
      { data: { id: number }[] },
    ][];
    return calls.flatMap((c) => c[0].data).map((r) => r.id);
  }

  it('items: brisanje NE dohvata native opseg (nikad deleteMany({}))', async () => {
    const { syncer, deleteMany, createMany } = setup('items', [
      { 'Sifra artikla': 1, 'Kataloski broj': 'AB-100' },
      { 'Sifra artikla': 93_513, 'Kataloski broj': 'AB-200' },
    ]);

    await syncer.sync({ strategy: 'full_refresh', cursor: null });

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { lt: NATIVE_ID_BASE } },
    });
    expect(deleteMany).not.toHaveBeenCalledWith({});
    // BigBit prostor se i dalje osvežava u celosti.
    expect(insertedHere(createMany)).toEqual([1, 93_513]);
  });

  it('items: `force: true` ne probija zaštitu (ručni /sync/run je jednako bezbedan)', async () => {
    // `force` postoji za OWNED_PRODUCTION_TABLES i namerno NE otvara brisanje
    // native prostora — inače bi „probaj sa force" bio put do tihog gubitka.
    const { syncer, deleteMany } = setup('items', [
      { 'Sifra artikla': 5, 'Kataloski broj': 'AB-100' },
    ]);

    await syncer.sync({ strategy: 'full_refresh', cursor: null, force: true });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { lt: NATIVE_ID_BASE } },
    });
  });

  it('items: izvorni red sa id-jem iz native opsega se PRESKAČE i prijavljuje', async () => {
    // BigBit tu šifru ne sme da koristi; upis bi ili pregazio 4.0-native artikal
    // ili pao na `chk_items_native_id_range` i oborio CEO `createMany` chunk.
    const { syncer, createMany } = setup('items', [
      { 'Sifra artikla': 1, 'Kataloski broj': 'AB-100' },
      { 'Sifra artikla': NATIVE_ID_BASE + 3, 'Kataloski broj': 'AB-300' },
    ]);

    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    expect(insertedHere(createMany)).toEqual([1]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(result.errors[0]).toContain('rezervisanom 4.0 opsegu');
    expect(result.note).toContain('rezervisanog 4.0 opsega');
  });

  it('items: zaštićeni redovi se BROJE u `note` (dokaz da je zaštita radila)', async () => {
    const { syncer, count } = setup(
      'items',
      [{ 'Sifra artikla': 1, 'Kataloski broj': 'AB-100' }],
      4,
    );

    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });

    expect(count).toHaveBeenCalledWith({
      where: { id: { gte: NATIVE_ID_BASE } },
    });
    expect(result.note).toContain('Zaštićeno 4');
  });

  it('items: bez native redova nema šuma u dnevniku (`note` izostaje)', async () => {
    const { syncer } = setup('items', [
      { 'Sifra artikla': 1, 'Kataloski broj': 'AB-100' },
    ]);
    const result = await syncer.sync({ strategy: 'full_refresh', cursor: null });
    expect(result.note).toBeUndefined();
  });

  // `CustomerSyncer` je bespoke i nikad ne briše — ali `customers` IMA mapiranje
  // u `sync-map.generated.ts`. Ukloni li ga iko kao „duplikat generičkog"
  // (scenario opisan u `customers.service.ts`, uslov 2), generički syncer
  // preuzima tabelu. Zaštita zato mora da važi i na tom putu.
  it('customers (generički put): full refresh briše samo BigBit prostor', async () => {
    const { syncer, deleteMany } = setup('customers', [
      { Sifra: 1_006_067, Naziv: 'BigBit firma', PoslednjaIzmena: null },
    ]);

    await syncer.sync({ strategy: 'full_refresh', cursor: null });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { lt: NATIVE_ID_BASE } },
    });
    expect(deleteMany).not.toHaveBeenCalledWith({});
  });

  it('customers (generički put, inkrementalno): native id se ne upsert-uje', async () => {
    const { syncer, upsert } = setup('customers', [
      {
        Sifra: 500,
        Naziv: 'BigBit firma',
        PoslednjaIzmena: new Date('2026-07-28T10:00:00Z'),
      },
      {
        Sifra: NATIVE_ID_BASE + 1,
        Naziv: 'Šifra iz 4.0 opsega',
        PoslednjaIzmena: new Date('2026-07-28T11:00:00Z'),
      },
    ]);

    const result = await syncer.sync({
      strategy: 'incremental',
      cursor: { lastModifiedAt: '2026-07-01T00:00:00.000Z' },
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0][0] as { where: { id: number } }).where.id).toBe(
      500,
    );
    expect(result.rowsSkipped).toBe(1);
    // Preskočeni red ne pomera kursor — anomalija se prijavljuje ponovo.
    expect(result.newCursor?.lastModifiedAt).toBe('2026-07-28T10:00:00.000Z');
  });

  // Regresija za ostatak sinhronizacije: tabela bez rezervisanog opsega mora i
  // dalje da radi klasičan pun refresh (izvor je jedina istina).
  it('warehouses: obična tabela i dalje briše SVE', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx: Record<string, unknown> = {
      warehouse: { deleteMany, createMany },
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      warehouse: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;
    const mssql = {
      query: jest.fn().mockResolvedValue([{ ID: 1, Naziv: 'Glavni' }]),
    } as unknown as MssqlClient;
    const mapping: TableMapping = {
      source: 'Magacini',
      model: 'Warehouse',
      targetDb: 'warehouses',
      pk: { kind: 'single', field: 'id' },
      watermark: null,
      columns: [
        { src: 'ID', field: 'id', type: 'Int', nullable: false, isId: true },
        {
          src: 'Naziv',
          field: 'name',
          type: 'String',
          nullable: false,
          isId: false,
        },
      ],
    };

    await new GenericSyncer(mapping, mssql, prisma).sync({
      strategy: 'full_refresh',
      cursor: null,
    });

    expect(deleteMany).toHaveBeenCalledWith({});
  });
});
