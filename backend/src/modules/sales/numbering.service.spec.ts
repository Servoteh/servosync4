import { Prisma } from "@prisma/client";
import { DocumentNumberSequenceService } from "./numbering.service";

/**
 * Numeracija izlaznih dokumenata — format `NNN/GG` (odluka O-F1).
 *
 * Pokriveno: prvi broj u godini (`1/26`), deseti (`10/26`), bez vodećih nula,
 * prelaz godine (nov niz kreće od 1), dvocifrena godina za „okrugle" godine
 * (2005 → `/05`), NEMA prefiksa vrste dokumenta (papir = SEF = glavna knjiga),
 * i zaštita od trke (dva paralelna zahteva ne dobijaju isti broj).
 */

/** Red u `document_number_sequences`. */
interface SeqRow {
  id: number;
  documentType: string;
  year: number;
  companyId: number;
  lastNumber: number;
}

/**
 * Lažna baza sa emulacijom `SELECT … FOR UPDATE`: ključ (tip|godina|firma) drži
 * jedna transakcija do `commit()`, ostale čekaju. Time test stvarno proverava da
 * servis čita brojač POD bravom i da broj ne računa ni iz čega drugog.
 */
function makeDb(seed: SeqRow[] = []) {
  const rows: SeqRow[] = [...seed];
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const locks = new Map<string, Promise<void>>();

  const find = (documentType: string, year: number, companyId: number) =>
    rows.find(
      (r) =>
        r.documentType === documentType &&
        r.year === year &&
        r.companyId === companyId,
    );

  /** Otvori „transakciju"; `commit()` otpušta sve brave koje je uzela. */
  function tx(opts: { onCreate?: () => void } = {}) {
    const release: Array<() => void> = [];

    const client = {
      async $queryRaw(
        _strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<Array<{ id: number; last_number: number }>> {
        const [documentType, year, companyId] = values as [
          string,
          number,
          number,
        ];
        const key = `${documentType}|${year}|${companyId}`;

        // FOR UPDATE: sačekaj prethodnog držaoca, pa uzmi bravu do commit-a.
        const prev = locks.get(key) ?? Promise.resolve();
        let free!: () => void;
        const mine = new Promise<void>((r) => (free = r));
        locks.set(
          key,
          prev.then(() => mine),
        );
        await prev;
        release.push(free);

        const row = find(documentType, year, companyId);
        return row ? [{ id: row.id, last_number: row.lastNumber }] : [];
      },
      documentNumberSequence: {
        create: async ({ data }: { data: Omit<SeqRow, "id"> }) => {
          opts.onCreate?.(); // tačka za simulaciju P2002 (jedinstveni ključ)
          const row: SeqRow = { id: nextId++, ...data };
          rows.push(row);
          return row;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: number };
          data: { lastNumber: number };
        }) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.lastNumber = data.lastNumber;
          return row;
        },
      },
    };

    return {
      client: client as unknown as Prisma.TransactionClient,
      commit: () => release.forEach((f) => f()),
    };
  }

  return { rows, tx, find };
}

describe("DocumentNumberSequenceService — format NNN/GG (O-F1)", () => {
  const service = new DocumentNumberSequenceService();

  /** Jedan poziv u sopstvenoj „transakciji" (odmah commit). */
  async function once(
    db: ReturnType<typeof makeDb>,
    documentType: string,
    year: number,
    companyId = 0,
  ) {
    const t = db.tx();
    try {
      return await service.next(t.client, documentType, year, companyId);
    } finally {
      t.commit();
    }
  }

  it("prvi broj u godini je 1/26 (nema reda sekvence → kreće od 1)", async () => {
    const db = makeDb();
    await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
    expect(db.find("IFR", 2026, 0)?.lastNumber).toBe(1);
  });

  it("deseti broj je 10/26 — bez vodećih nula i bez prefiksa vrste", async () => {
    const db = makeDb();
    const issued: string[] = [];
    for (let i = 0; i < 10; i++) issued.push(await once(db, "IFR", 2026));

    expect(issued[0]).toBe("1/26");
    expect(issued[8]).toBe("9/26");
    expect(issued[9]).toBe("10/26");
    // Stari oblik `IFR0043/2026` se više ne sme pojaviti ni u jednom izdatom broju.
    for (const n of issued) expect(n).toMatch(/^\d+\/\d{2}$/);
  });

  it("prelaz godine: nov niz kreće od 1 (657/26 → 1/27)", async () => {
    const db = makeDb([
      { id: 1, documentType: "IFR", year: 2026, companyId: 0, lastNumber: 656 },
    ]);

    await expect(once(db, "IFR", 2026)).resolves.toBe("657/26");
    await expect(once(db, "IFR", 2027)).resolves.toBe("1/27");
    // Stara godina ostaje netaknuta (brojač se ne resetuje unazad).
    expect(db.find("IFR", 2026, 0)?.lastNumber).toBe(657);
  });

  it("brojač je po VRSTI dokumenta — IFR i IFUSL teku nezavisno", async () => {
    const db = makeDb([
      { id: 1, documentType: "IFR", year: 2026, companyId: 0, lastNumber: 40 },
    ]);

    await expect(once(db, "IFR", 2026)).resolves.toBe("41/26");
    await expect(once(db, "IFUSL", 2026)).resolves.toBe("1/26");
  });

  it("godina je uvek dvocifrena: 2005 → /05", async () => {
    const db = makeDb();
    await expect(once(db, "IFR", 2005)).resolves.toBe("1/05");
  });

  it("prefiks vrste dokumenta se NE čita (papir, SEF i knjiga nose isti broj)", async () => {
    // Lažni klijent NEMA `documentType` delegat: da servis još gleda
    // `DocumentType.documentNumberPrefix`, ovaj poziv bi pukao.
    const db = makeDb();
    await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
  });

  it("nastavlja na zatečeni brojač (stari IFR0043/2026 → sledeći je 44/26, ne 1/26)", async () => {
    // Zatečeni dokumenti u starom obliku se NE migriraju; sekvenca se ne resetuje,
    // pa se redni broj 43 ne troši drugi put ni suštinski, ne samo kao string.
    const db = makeDb([
      { id: 1, documentType: "IFR", year: 2026, companyId: 0, lastNumber: 43 },
    ]);
    await expect(once(db, "IFR", 2026)).resolves.toBe("44/26");
  });

  describe("trka (dva paralelna zahteva)", () => {
    it("postojeća sekvenca: brave serijalizuju → 2/26 i 3/26, nikad isti broj", async () => {
      const db = makeDb([
        { id: 1, documentType: "IFR", year: 2026, companyId: 0, lastNumber: 1 },
      ]);

      const a = db.tx();
      const b = db.tx();
      const pa = service.next(a.client, "IFR", 2026, 0);
      const pb = service.next(b.client, "IFR", 2026, 0);

      // A commit-uje tek pošto je uzeo broj; B do tada čeka na bravi reda.
      const first = await pa;
      a.commit();
      const second = await pb;
      b.commit();

      expect([first, second].sort()).toEqual(["2/26", "3/26"]);
      expect(first).not.toBe(second);
      expect(db.find("IFR", 2026, 0)?.lastNumber).toBe(3);
    });

    it("prva sekvenca u godini: jedinstveni ključ obara gubitnika (P2002 → rollback)", async () => {
      // Kad reda još nema, FOR UPDATE nema šta da zaključa — zaštita je jedinstveni
      // indeks uq_document_number_sequences_key: drugi commit dobija P2002, cela
      // transakcija knjiženja se poništava i broj 1/26 ostaje samo jednom dokumentu.
      const db = makeDb();
      const t = db.tx({
        onCreate: () => {
          throw new Prisma.PrismaClientKnownRequestError("dup", {
            code: "P2002",
            clientVersion: "6.19.3",
          });
        },
      });

      await expect(
        service.next(t.client, "IFR", 2026, 0),
      ).rejects.toMatchObject({ code: "P2002" });
      t.commit();
    });
  });
});
