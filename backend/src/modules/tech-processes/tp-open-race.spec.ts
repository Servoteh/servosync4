import { Prisma } from "@prisma/client";
import { TechProcessesService } from "./tech-processes.service";

/**
 * TRKA DVA PRVA SKENA ISTE OPERACIJE — P2002 NIJE GREŠKA ZA RADNIKA.
 * =============================================================================
 * `findOrOpenRoutingTp` čita red operacije po petorci
 * (predmet, ident, varijanta, operacija, radni centar) pa ga, ako ga nema, kreira. Ključ je
 * do 04.08.2026. nosio samo `@@index` (`idx_tp_trojka_op`), NE unique — pa su dva istovremena
 * PRVA skena oba prolazila čitanje i oba upisivala red. Od tada dve prijave žive paralelno, a
 * agregati koji broje komade i odlučuju o gotovosti gledaju dva reda kao dva različita posla.
 *
 * Parcijalni unique `uq_tech_processes_open` (migracija 20260804160000) to zaustavlja u BAZI.
 * Ali brava BEZ hvatanja P2002 samo bi tihi duplikat pretvorila u glasan 500 na terminalu, pa
 * bi radnik skenirao ponovo — a to je razmena jednog kvara za drugi. `createOrReuseOpenTp`
 * zato P2002 čita kao „drugi je stigao prvi": pročita NJEGOV otvoren red i nastavi, tako da je
 * ishod za radnika isti kao da je on bio prvi.
 *
 * ZAŠTO KROZ PRIVATNI HELPER (obrazac `callGuard` iz `robno/robno.service.spec.ts`): cela
 * invarijanta je u helperu. Test kroz `scan()` vukao bi RN, routing, plan i notifikacije i
 * padao bi iz deset razloga koji sa ovim nalazom nemaju veze.
 */

const P2002 = () =>
  new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "6.19.3",
  });

/** Podaci reda operacije — isti oblik koji `findOrOpenRoutingTp` prosleđuje. */
const DATA = {
  projectId: 10,
  identNumber: "1234",
  variant: 0,
  operationNumber: 20,
  workCenterCode: "RC1",
  identMark: "0",
  pieceCount: 0,
  workerId: 5,
  workOrderId: 77,
};

/** Servis bez ijedne prave zavisnosti — helper koristi samo `tx` koji mu se preda. */
function service(): TechProcessesService {
  return new TechProcessesService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function callHelper(tx: unknown): Promise<unknown> {
  return (
    service() as unknown as {
      createOrReuseOpenTp: (tx: unknown, data: unknown) => Promise<unknown>;
    }
  ).createOrReuseOpenTp(tx, DATA);
}

describe("createOrReuseOpenTp — P2002 znači da je drugi stigao prvi, ne grešku", () => {
  it("bez trke: red se kreira i vraća, bez ijednog dodatnog čitanja", async () => {
    const tx = {
      techProcess: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findFirst: jest.fn(),
      },
    };
    await expect(callHelper(tx)).resolves.toEqual({ id: 1 });
    expect(tx.techProcess.findFirst).not.toHaveBeenCalled();
  });

  it("P2002 → pročita se TUĐI otvoren red i vrati kao svoj", async () => {
    const tx = {
      techProcess: {
        create: jest.fn().mockRejectedValue(P2002()),
        findFirst: jest.fn().mockResolvedValue({ id: 42 }),
      },
    };
    await expect(callHelper(tx)).resolves.toEqual({ id: 42 });

    const where = (
      tx.techProcess.findFirst.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;
    // Traži se ISKLJUČIVO otvoren red — zatvoren nije taj koji je bravu aktivirao,
    // a vraćanje zatvorenog reda bi pozivaocu dalo 422 „operacija je već zatvorena".
    expect(where.isProcessFinished).toEqual({ not: true });
    // I to BAŠ ta operacija, ne bilo koja otvorena na tom RN-u.
    expect(where).toMatchObject({
      projectId: DATA.projectId,
      identNumber: DATA.identNumber,
      variant: DATA.variant,
      operationNumber: DATA.operationNumber,
      workCenterCode: DATA.workCenterCode,
    });
  });

  it("P2002 a red se ne može pročitati → greška IDE DALJE (ne izmišlja se red)", async () => {
    // Ako brava puca a otvorenog reda nema, to nije trka nego nešto neočekivano —
    // tiho vraćanje praznog/novog reda bilo bi upravo obrazac zbog koga nalaz i postoji.
    const tx = {
      techProcess: {
        create: jest.fn().mockRejectedValue(P2002()),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    await expect(callHelper(tx)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("druga greška se NE proglašava trkom (veza pala ostaje pad)", async () => {
    const tx = {
      techProcess: {
        create: jest.fn().mockRejectedValue(new Error("veza pala")),
        findFirst: jest.fn(),
      },
    };
    await expect(callHelper(tx)).rejects.toThrow(/veza pala/);
    expect(tx.techProcess.findFirst).not.toHaveBeenCalled();
  });
});
