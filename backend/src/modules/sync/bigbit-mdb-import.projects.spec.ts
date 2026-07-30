import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BigbitMdbImportService,
  PREDMET_SRC_TO_STAGE_FIELD,
  type MdbStepResult,
} from "./bigbit-mdb-import.service";
import { SYNC_MAP } from "./sync-map.generated";
import { ADDITIVE_DEDUP_FIELDS } from "./table-ownership";

/**
 * KORAK 2, matični podaci: `bb_mdb_stage_predmeti` -> `projects`.
 *
 * Fokus: ODLUKE O VLASNIŠTVU nad tabelom koju pišu DVA sistema. Sadržaj
 * preslikavanja (38 kolona) dolazi iz `sync-map.generated.ts` i dokazan je na
 * stvarnom .mdb-u; ovde se pinuje ono što bi TIHO napravilo štetu:
 *
 *  • BigBit kopija predmeta koji je 4.0 već otvorio (dual unos) — dupli predmet
 *    sa istim brojem, dok radni nalozi vise na 4.0 id-u;
 *  • BigBit red koji sedne na `id` 4.0-native predmeta — prepisane 38 kolone;
 *  • brisanje — BigBit prazni zatvorene godine, pa nestanak reda NIJE brisanje;
 *  • `DatumOtvaranja` pomeren dan unazad zbog vremenske zone;
 *  • „ažurirano" koje svake noći znači „sve", pa stvarna ispravka nestane u šumu.
 */

/** Poziv privatnog koraka bez `any` — korak je deo `runImport`-a, ne javni API. */
interface ProjectsStep {
  importProjects(dropId: number): Promise<MdbStepResult>;
}
const runProjects = (
  service: BigbitMdbImportService,
  dropId = 7,
): Promise<MdbStepResult> =>
  (service as unknown as ProjectsStep).importProjects(dropId);

const DROP = 7;

interface StageRow {
  id: number;
  dropId: number;
  [column: string]: unknown;
}

/** Staging red: sve je tekst, nepopunjene kolone su `null` (kao posle `\copy`). */
function stage(id: number, values: Record<string, string>): StageRow {
  const row: StageRow = { id, dropId: DROP };
  for (const field of Object.values(PREDMET_SRC_TO_STAGE_FIELD))
    row[field] = null;
  for (const [src, value] of Object.entries(values)) {
    const field = PREDMET_SRC_TO_STAGE_FIELD[src];
    if (!field) throw new Error(`test koristi nepoznatu BigBit kolonu: ${src}`);
    row[field] = value;
  }
  return row;
}

interface Fixture {
  stage: StageRow[];
  /** Redovi koji su VEĆ u `projects` (4.0-native ili ranije uvezeni). */
  projects: Record<string, unknown>[];
  /** Šifre komitenata koje u 4.0 postoje. */
  customers?: number[];
}

function makePrisma(f: Fixture) {
  const projects = [...f.projects];
  const upsert = jest.fn(
    (args: {
      where: { id: number };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const at = projects.findIndex((p) => p.id === args.where.id);
      if (at >= 0) projects[at] = { ...projects[at], ...args.update };
      else projects.push({ ...args.create });
      return Promise.resolve(projects[at >= 0 ? at : projects.length - 1]);
    },
  );
  const deleteMany = jest.fn(() => Promise.resolve({ count: 0 }));
  const queryRaw = jest.fn(() => Promise.resolve([] as unknown[]));

  const stageFindMany = jest.fn(
    (args: {
      where?: { id?: { gt?: number } };
      select?: Record<string, boolean>;
      take?: number;
    }) => {
      // Predučitavanje ključeva celog drop-a (`select`) vs. stranicanje keyset-om.
      if (args.select)
        return Promise.resolve(
          f.stage.map((r) => ({
            idPredmet: r.idPredmet,
            brojPredmeta: r.brojPredmeta,
          })),
        );
      const gt = args.where?.id?.gt ?? 0;
      const page = f.stage
        .filter((r) => r.id > gt)
        .sort((a, b) => a.id - b.id)
        .slice(0, args.take ?? f.stage.length);
      return Promise.resolve(page);
    },
  );

  const projectFindMany = jest.fn(
    (args: { where: Record<string, { in?: unknown[] }> }) => {
      if (args.where.id?.in) {
        const ids = args.where.id.in as number[];
        return Promise.resolve(projects.filter((p) => ids.includes(p.id as number)));
      }
      const numbers = (args.where.projectNumber?.in ?? []) as string[];
      return Promise.resolve(
        projects
          .filter((p) => numbers.includes(p.projectNumber as string))
          .map((p) => ({ id: p.id, projectNumber: p.projectNumber })),
      );
    },
  );

  const prisma = {
    bbMdbStagePredmet: {
      count: jest.fn(() => Promise.resolve(f.stage.length)),
      findMany: stageFindMany,
    },
    project: { findMany: projectFindMany, upsert, deleteMany },
    customer: {
      findMany: jest.fn((args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          (f.customers ?? [])
            .filter((id) => args.where.id.in.includes(id))
            .map((id) => ({ id })),
        ),
      ),
    },
    $queryRaw: queryRaw,
  };

  return {
    prisma: prisma as unknown as PrismaService,
    projects,
    upsert,
    deleteMany,
    queryRaw,
  };
}

function makeService(f: Fixture) {
  const mock = makePrisma(f);
  return { ...mock, service: new BigbitMdbImportService(mock.prisma) };
}

/** Kolone `projects` iz generisane mape — jedini izvor istine o mapiranju. */
const projectColumns = () => {
  const mapping = SYNC_MAP.find((m) => m.targetDb === "projects");
  if (!mapping) throw new Error("SYNC_MAP nema `projects`");
  return mapping.columns;
};

describe("BigbitMdbImportService.importProjects", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // ── MOST DO STAGING-A: potpun i tačan, inače se kolone tiho uvezu prazne ──

  it("pokriva SVAKU kolonu iz SYNC_MAP mapiranja `projects`", () => {
    const missing = projectColumns()
      .map((c) => c.src)
      .filter((src) => !PREDMET_SRC_TO_STAGE_FIELD[src]);
    expect(missing).toEqual([]);
  });

  it("svaka staging kolona iz mosta STVARNO postoji na modelu BbMdbStagePredmet", () => {
    const model = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === "BbMdbStagePredmet",
    );
    expect(model).toBeDefined();
    const fields = new Set(model?.fields.map((x) => x.name));
    const unknown = Object.values(PREDMET_SRC_TO_STAGE_FIELD).filter(
      (field) => !fields.has(field),
    );
    expect(unknown).toEqual([]);
  });

  it("ključ paritet-brane se čita iz ADDITIVE_DEDUP_FIELDS, ne iz drugog spiska", () => {
    // Dve grane sync-a (MSSQL `GenericSyncer` i ovaj uvoz) moraju da brane ISTO
    // polje; da se raziđu, jedna bi propuštala dupli broj predmeta.
    expect(ADDITIVE_DEDUP_FIELDS.projects).toBe("projectNumber");
    expect(
      projectColumns().some((c) => c.field === ADDITIVE_DEDUP_FIELDS.projects),
    ).toBe(true);
  });

  // ── PARITET BROJA PREDMETA (glavna brana) ──────────────────────────────────

  it("PRESKAČE BigBit kopiju čiji broj već stoji na 4.0-native predmetu i imenuje broj + OBA id-ja", async () => {
    const { service, upsert } = makeService({
      // 4.0-native predmet 90001 sa brojem 10014 — izvor taj id NE vraća.
      projects: [{ id: 90001, projectNumber: "10014", customerId: 5 }],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014", Opis: "kopija" }),
      ],
    });

    const step = await runProjects(service);

    expect(upsert).not.toHaveBeenCalled();
    expect(step.skipped).toBe(1);
    expect(step.inserted).toBe(0);
    const note = step.notes.find((x) => x.startsWith("paritet:"));
    // Poruka mora da nosi SVA TRI podatka bez kojih se sudar ne može rešiti.
    expect(note).toContain("10014");
    expect(note).toContain("90001");
    expect(note).toContain("8123");
  });

  it("NE preskače kad isti broj drži predmet koji izvor TAKOĐE vraća (isti BigBit red)", async () => {
    // Ranije uvezen BigBit predmet: id je u izvornom skupu → to nije 4.0-native.
    const { service, upsert } = makeService({
      projects: [
        { id: 8123, projectNumber: "10014", customerId: 5, description: "staro" },
      ],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014", Opis: "novo" }),
      ],
    });

    const step = await runProjects(service);

    expect(step.skipped).toBe(0);
    expect(step.updated).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // ── 4.0-NATIVE RED NA BIGBIT ID-u ──────────────────────────────────────────

  it("NE prepisuje 4.0-native predmet koji sedi na BigBit id-u (broj koji izvor ne poznaje)", async () => {
    const { service, upsert, projects } = makeService({
      // Predmet 8123 u 4.0 nosi broj 99999 — tog broja u drop-u NEMA nigde,
      // dakle to nije BigBit red i njegovih 38 kolona se ne smeju prepisati.
      projects: [
        { id: 8123, projectNumber: "99999", customerId: 5, description: "4.0" },
      ],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014", Opis: "BigBit" }),
      ],
    });

    const step = await runProjects(service);

    expect(upsert).not.toHaveBeenCalled();
    expect(projects[0].description).toBe("4.0");
    expect(step.skipped).toBe(1);
    expect(step.notes.join(" ")).toContain("NIJE prepisan");
  });

  // ── KOMITENT: NULIRAJ, NE ODBIJAJ ──────────────────────────────────────────

  it("nulira nepostojećeg komitenta, a predmet UVEZE i prijavi u notes", async () => {
    const { service, upsert } = makeService({
      projects: [],
      customers: [4711],
      stage: [
        stage(1, {
          IDPredmet: "8123",
          BrojPredmeta: "10014",
          IDKomitent: "999999",
        }),
        stage(2, {
          IDPredmet: "8124",
          BrojPredmeta: "10015",
          IDKomitent: "4711",
        }),
      ],
    });

    const step = await runProjects(service);

    expect(step.inserted).toBe(2);
    expect(step.skipped).toBe(0);
    const created = upsert.mock.calls.map((c) => c[0].create);
    // `projects.customer_id` je NOT NULL bez default-a → „nuliranje" je 0.
    expect(created[0].customerId).toBe(0);
    expect(created[1].customerId).toBe(4711);
    expect(step.notes.join(" ")).toContain("NULIRANA");
  });

  // ── IDEMPOTENCIJA I NIŠTA-SE-NE-BRIŠE ─────────────────────────────────────

  it("drugi prolaz nad istim drop-om ne piše ništa — sve je `unchanged`", async () => {
    const rows = [
      stage(1, {
        IDPredmet: "8123",
        BrojPredmeta: "10014",
        Opis: "Servotransfer",
        IDKomitent: "4711",
        DatumOtvaranja: "2026-06-26",
        NabavnaVrednost: "1250.5000",
        kurs: "117.204600",
      }),
    ];
    const first = makeService({ projects: [], customers: [4711], stage: rows });
    const step1 = await runProjects(first.service);
    expect(step1.inserted).toBe(1);

    // Isti fajl, isti sadržaj: sve što je prvi prolaz upisao vraćamo kao zatečeno.
    const second = makeService({
      projects: first.projects,
      customers: [4711],
      stage: rows,
    });
    const step2 = await runProjects(second.service);

    expect(second.upsert).not.toHaveBeenCalled();
    expect(step2).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      skipped: 0,
      filtered: 0,
    });
  });

  it("prijavi `updated` SAMO kad se sadržaj stvarno promenio u BigBitu", async () => {
    const before = makeService({
      projects: [],
      customers: [4711],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014", Opis: "staro" }),
      ],
    });
    await runProjects(before.service);

    const after = makeService({
      projects: before.projects,
      customers: [4711],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014", Opis: "NOVO" }),
      ],
    });
    const step = await runProjects(after.service);

    expect(step.updated).toBe(1);
    expect(step.unchanged).toBe(0);
    expect(after.upsert.mock.calls[0][0].update.id).toBeUndefined();
  });

  it("NIKAD ne briše — ni jedan `deleteMany` nad `projects`", async () => {
    const { service, deleteMany } = makeService({
      // Predmet 7000 postoji u 4.0, a ovaj drop ga NE nosi (BigBit je ispraznio
      // zatvorenu godinu). Ne sme da nestane.
      projects: [{ id: 7000, projectNumber: "9001", customerId: 1 }],
      stage: [stage(1, { IDPredmet: "8123", BrojPredmeta: "10014" })],
    });

    await runProjects(service);

    expect(deleteMany).not.toHaveBeenCalled();
  });

  // ── DUPLIKAT BROJA U SAMOM IZVORU ─────────────────────────────────────────

  it("zadržava PRVI red po broju predmeta, duplikat iz izvora preskače i imenuje", async () => {
    const { service, upsert } = makeService({
      projects: [],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014" }),
        stage(2, { IDPredmet: "8124", BrojPredmeta: "10014" }),
      ],
    });

    const step = await runProjects(service);

    expect(step.inserted).toBe(1);
    expect(step.skipped).toBe(1);
    expect(upsert.mock.calls[0][0].where.id).toBe(8123);
    expect(step.notes.join(" ")).toContain("duplikat u izvoru");
  });

  it("odbacuje red bez upotrebljivog IDPredmet-a i duplikat IDPredmet-a (filtered)", async () => {
    const { service } = makeService({
      projects: [],
      stage: [
        stage(1, { IDPredmet: "", BrojPredmeta: "10014" }),
        stage(2, { IDPredmet: "n/a", BrojPredmeta: "10015" }),
        stage(3, { IDPredmet: "8123", BrojPredmeta: "10016" }),
        stage(4, { IDPredmet: "8123", BrojPredmeta: "10017" }),
      ],
    });

    const step = await runProjects(service);

    expect(step.filtered).toBe(3);
    expect(step.inserted).toBe(1);
  });

  // ── TIPIZACIJA: staging je tekst, a vremenska zona je zamka ───────────────

  it("čita datum kao UTC zidno vreme — bez pomeranja dana (kolona je timestamp bez zone)", async () => {
    const { service, upsert } = makeService({
      projects: [],
      stage: [
        stage(1, {
          IDPredmet: "8123",
          BrojPredmeta: "10014",
          DatumOtvaranja: "2026-06-26",
          RokZavrsetka: "2026-07-01 14:30:00",
        }),
      ],
    });

    await runProjects(service);

    const created = upsert.mock.calls[0][0].create;
    expect((created.openedAt as Date).toISOString()).toBe(
      "2026-06-26T00:00:00.000Z",
    );
    expect((created.deadline as Date).toISOString()).toBe(
      "2026-07-01T14:30:00.000Z",
    );
  });

  it("novac ide kao Decimal (nikad Float) i preživi poređenje 100 vs 100.0000", async () => {
    const { service, upsert } = makeService({
      projects: [],
      stage: [
        stage(1, {
          IDPredmet: "8123",
          BrojPredmeta: "10014",
          NabavnaVrednost: "1250.5",
        }),
      ],
    });
    await runProjects(service);
    const created = upsert.mock.calls[0][0].create;
    expect(created.procurementValue).toBeInstanceOf(Prisma.Decimal);

    // Baza vraća `numeric(19,4)` kao `100.0000`; string-poređenje bi to svake
    // noći prijavilo kao izmenu i prepisalo celu tabelu.
    const again = makeService({
      projects: [
        {
          id: 8123,
          projectNumber: "10014",
          customerId: 0,
          salespersonId: 0,
          procurementValue: new Prisma.Decimal("1250.5000"),
        },
      ],
      stage: [
        stage(1, {
          IDPredmet: "8123",
          BrojPredmeta: "10014",
          NabavnaVrednost: "1250.5",
        }),
      ],
    });
    const step = await runProjects(again.service);
    expect(step.unchanged).toBe(1);
    expect(again.upsert).not.toHaveBeenCalled();
  });

  // ── BROJAČI I SEKVENCA ────────────────────────────────────────────────────

  it("brojači se UVEK zbrajaju u `staged` (nijedan red ne nestane iz svih)", async () => {
    const { service } = makeService({
      projects: [{ id: 90001, projectNumber: "10014", customerId: 1 }],
      customers: [4711],
      stage: [
        stage(1, { IDPredmet: "", BrojPredmeta: "x" }), // filtered
        stage(2, { IDPredmet: "8123", BrojPredmeta: "10014" }), // paritet -> skipped
        stage(3, { IDPredmet: "8124", BrojPredmeta: "10015" }), // inserted
        stage(4, { IDPredmet: "8125", BrojPredmeta: "10015" }), // duplikat -> skipped
      ],
    });

    const step = await runProjects(service);

    expect(step.staged).toBe(4);
    expect(
      step.inserted +
        step.updated +
        step.unchanged +
        step.skipped +
        step.filtered +
        step.blockedLocked,
    ).toBe(step.staged);
    expect(step.notes.join(" ")).not.toContain("brojači se ne zbrajaju");
  });

  it("podiže `projects_id_seq` posle unosa (inače prvi ručni „Novi predmet” pada na pk_projects)", async () => {
    const { service, queryRaw } = makeService({
      projects: [],
      stage: [stage(1, { IDPredmet: "8123", BrojPredmeta: "10014" })],
    });
    await runProjects(service);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // `mock.calls` je tipiziran kao prazna torka (mock nema deklarisane argumente),
    // pa indeksiranje traži skidanje tipa — sadržaj je Prisma template niz.
    const sql = (
      queryRaw.mock.calls[0] as unknown as [string[]]
    )[0].join(" ");
    expect(sql).toContain("setval");
    expect(sql).toContain("pg_sequence_last_value");
  });

  it("ne dira sekvencu kad nije bilo ni jednog novog predmeta", async () => {
    const { service, queryRaw } = makeService({
      projects: [{ id: 90001, projectNumber: "10014", customerId: 1 }],
      stage: [stage(1, { IDPredmet: "8123", BrojPredmeta: "10014" })],
    });
    await runProjects(service);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("pad upsert-a preskoči SAMO taj predmet i imenuje ga (ostali ulaze)", async () => {
    const { service, upsert } = makeService({
      projects: [],
      stage: [
        stage(1, { IDPredmet: "8123", BrojPredmeta: "10014" }),
        stage(2, { IDPredmet: "8124", BrojPredmeta: "10015" }),
      ],
    });
    upsert.mockImplementationOnce(() =>
      Promise.reject(new Error("value too long for type character varying(20)")),
    );

    const step = await runProjects(service);

    expect(step.inserted).toBe(1);
    expect(step.skipped).toBe(1);
    expect(step.notes.join(" ")).toContain("value too long");
  });
});
