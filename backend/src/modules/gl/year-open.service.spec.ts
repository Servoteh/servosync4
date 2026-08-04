import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { YearOpenService } from "./year-open.service";

/**
 * PRENOS U NOVU GODINU — PROZOR OSNOVE (nalaz revizije 04.08.2026).
 * =============================================================================
 * `accountBalances` je sabirao `je.document_date < 01.01.(fromYear+1)`, dakle SVE godine od
 * početka knjiga, kumulativno. Na PRVOM prenosu je to slučajno tačno (nema starijih godina).
 * Na DRUGOM je pogrešno: PS nalog godine `fromYear` — koji je napravio prethodni prenos i
 * koji SAŽIMA saldo godine fromYear−1 — sabira se ZAJEDNO sa prometom te iste fromYear−1, pa
 * se klase 0–4 broje DVAPUT. Za klase 5/6 isti propust sabira prihod svih ranijih godina u
 * rezultat. Kvar sazreva tek na drugom prenosu, dakle prvi put boli u januaru 2028.
 *
 * `zavrsni/gkeval.service.ts:36-48` se od ISTOG kvara brani prozorom `je.year` i to
 * doslovno dokumentuje — uključujući i to da kolona MORA biti `je.year`, ne
 * `posting_date`/`document_date`.
 *
 * Tvrdnje ispod su nad SQL-om koji servis pošalje, jer `$queryRaw` dubler ne izvršava
 * `WHERE` (isti razlog i isti obrazac kao u `session-auto-close.service.spec.ts`). Bez toga
 * bi test prolazio i sa kumulativnim uslovom — upravo zato ga zatečenih 80 gl testova nije
 * uhvatilo.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Prisma dubler: hvata SQL agregata osnove i beleži da li je išta upisano. */
function makePrisma(opts: {
  /** Najranija godina u knjigama (`_min.year`); `null` = knjige prazne. */
  earliestYear: number | null;
  /** Postoji li neponišten PS nalog za `fromYear`. */
  psForFromYear?: boolean;
  /** Postoji li već PS za `toYear` (idempotencija). */
  psForToYear?: boolean;
}) {
  const sqlSeen: string[] = [];
  /**
   * Agregat osnove mora vratiti BAR JEDAN red, inače servis (ispravno) baca „nema salda
   * klasa 0–4 za prenos" pre nego što test stigne do tvrdnje. Klasa 2 (kupci) nosi saldo
   * koji ide u PS; klasa 6 (prihod) postoji da grana zatvaranja 5/6 ima šta da zatvori.
   */
  const balanceRows = [
    { accountCode: "2040", accountClass: 2, debit: D("1000"), credit: D(0) },
    { accountCode: "6010", accountClass: 6, debit: D(0), credit: D("1000") },
  ];
  const runQuery = (q: Prisma.Sql) => {
    sqlSeen.push(String(q.sql));
    return String(q.sql).includes("account_class") ? balanceRows : [];
  };
  const journalEntry = {
    findFirst: jest.fn(async (args: { where: { year?: number } }) => {
      // Ruta pita dva puta: PS za toYear (idempotencija), pa PS za fromYear (brana).
      if (args.where.year === 2027) return opts.psForToYear ? { id: 1, number: "PS-1/27" } : null;
      return opts.psForFromYear ? { id: 2, number: "PS-1/26" } : null;
    }),
    aggregate: jest.fn(async () => ({ _min: { year: opts.earliestYear } })),
  };
  return {
    sqlSeen,
    journalEntry,
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (q: Prisma.Sql) => runQuery(q)),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        journalEntry,
        account: {
          findFirst: jest.fn(async () => ({ code: "3400", accountClass: 3 })),
          findMany: jest.fn(async () => [{ code: "3400", accountClass: 3 }]),
        },
        $executeRaw: jest.fn(async () => 1),
        $queryRaw: jest.fn(async (q: Prisma.Sql) => runQuery(q)),
      }),
    ),
  };
}

function make(prisma: ReturnType<typeof makePrisma>) {
  const posting = {
    postManualEntry: jest.fn(async () => ({
      journalEntryId: 500,
      number: "ZAK-1/26",
      lineCount: 2,
    })),
  };
  const svc = new YearOpenService(prisma as never, posting as never);
  return { svc, posting };
}

describe("YearOpenService — osnova je PROZOR po godini, ne kumulativ", () => {
  it("agregat osnove filtrira `je.year`, a NE `je.document_date <`", async () => {
    const prisma = makePrisma({ earliestYear: 2026, psForFromYear: true });
    const { svc } = make(prisma);

    await svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1);

    const base = prisma.sqlSeen.filter((s) => s.includes("account_class"));
    expect(base.length).toBeGreaterThan(0);
    for (const sql of base) {
      // Ovo je tvrdnja koja pada na zatečenom kodu — tamo je stajalo `document_date <`.
      expect(sql).toMatch(/je\.year\s*=/);
      expect(sql).not.toMatch(/je\.document_date\s*</);
    }
  });

  it("dryRun vraća izveštaj razlike i NE upisuje nijedan nalog", async () => {
    const prisma = makePrisma({ earliestYear: 2025, psForFromYear: true });
    const { svc, posting } = make(prisma);

    const res = (await svc.createYearOpen(
      { fromYear: 2026, toYear: 2027, dryRun: true },
      1,
    )) as { data: { dryRun: true; rows: unknown[] } };

    expect(res.data.dryRun).toBe(true);
    expect(Array.isArray(res.data.rows)).toBe(true);
    // Ništa se ne knjiži — to je cela poenta izveštaja.
    expect(posting.postManualEntry).not.toHaveBeenCalled();
    // Izveštaj MORA da pusti i staru (kumulativnu) osnovu, inače nema šta da poredi.
    expect(prisma.sqlSeen.some((s) => s.includes("je.document_date <"))).toBe(true);
  });

  /**
   * Telo ove rute NIJE validirano (`YearOpenDto` je interfejs → `ValidationPipe` ga
   * preskače). Da je provera bila `dryRun === true`, klijent koji pošalje STRING `"true"`
   * dobio bi PRAVI prenos umesto izveštaja — upis u knjige na osnovu neprepoznate
   * vrednosti. Pravilo je zato obrnuto: knjiži se samo kad je `dryRun` odsutan ili
   * izričito neistina.
   */
  it.each(["true", "1", "da", true])(
    "dryRun = %p (i kao string) NE knjiži ništa",
    async (value) => {
      const prisma = makePrisma({ earliestYear: 2026, psForFromYear: true });
      const { svc, posting } = make(prisma);

      await svc.createYearOpen(
        { fromYear: 2026, toYear: 2027, dryRun: value as never },
        1,
      );
      expect(posting.postManualEntry).not.toHaveBeenCalled();
    },
  );

  it.each(["false", "", undefined])(
    "dryRun = %p znači PRAVI prenos (izveštaj se ne traži)",
    async (value) => {
      const prisma = makePrisma({ earliestYear: 2026, psForFromYear: true });
      const { svc, posting } = make(prisma);

      await svc.createYearOpen(
        { fromYear: 2026, toYear: 2027, dryRun: value as never },
        1,
      );
      expect(posting.postManualEntry).toHaveBeenCalled();
    },
  );

  it("knjige imaju ranije godine a fromYear nema PS → 409, ništa se ne knjiži", async () => {
    // Ovo je brana koju PROZOR uvodi: bez PS naloga za fromYear prozor izostavlja zatečeni
    // saldo i početno stanje bi izašlo PREMALO — tiho manje PS je kvar gori od dvostrukog
    // brojanja koje se ispravlja.
    const prisma = makePrisma({ earliestYear: 2024, psForFromYear: false });
    const { svc, posting } = make(prisma);

    await expect(
      svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1),
    ).rejects.toThrow(/nema.*PS|početno stanje/i);

    expect(posting.postManualEntry).not.toHaveBeenCalled();
  });

  it("prvi prenos (knjige počinju u fromYear) prolazi bez PS naloga", async () => {
    const prisma = makePrisma({ earliestYear: 2026, psForFromYear: false });
    const { svc } = make(prisma);

    await expect(
      svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1),
    ).resolves.toBeDefined();
  });

  it("prazne knjige (nema nijednog naloga) ne obaraju prenos", async () => {
    const prisma = makePrisma({ earliestYear: null, psForFromYear: false });
    const { svc } = make(prisma);

    await expect(
      svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1),
    ).resolves.toBeDefined();
  });

  it("postojeći PS za toYear i dalje daje 409 (idempotencija nije oslabljena)", async () => {
    const prisma = makePrisma({ earliestYear: 2026, psForToYear: true });
    const { svc } = make(prisma);

    await expect(
      svc.createYearOpen({ fromYear: 2026, toYear: 2027 }, 1),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("`D` helper je u upotrebi (Decimal, nikad Float) — sanity za buduće dopune", () => {
    expect(D("1.0001").toFixed(4)).toBe("1.0001");
  });
});
