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
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue(existingByNumber);

    const delegateName = targetDb === 'projects' ? 'project' : 'warehouse';
    const txDelegate = { deleteMany, createMany };
    const tx: Record<string, unknown> = {
      [delegateName]: txDelegate,
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };

    const prisma = {
      // owned-table protection precheck (not owned here, but keep it safe)
      [delegateName]: { count, findMany },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;

    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    const syncer = new GenericSyncer(makeMapping(targetDb), mssql, prisma);
    return { syncer, deleteMany, createMany, findMany };
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
});
