import { HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  InvalidVatPeriodException,
  VatLedgerService,
} from "./vat-ledger.service";
import { VatSanityException } from "./vat-sanity";

/**
 * Spec punjenja KIF/KUF iz glavne knjige. Zaključava tri stvari koje su na
 * uvezenim BigBit podacima bile pogrešne:
 *
 *   1) TEHNIČKI NALOG ZATVARANJA (vrsta `PDV`) mora biti izuzet iz agregacije,
 *      i to PRECIZNO — uz JOIN na registar PDV konta, da stavke 2790/4790 i
 *      6799 iz istog naloga ostanu u glavnoj knjizi;
 *   2) ZNAK: izlazni PDV = potražuje − duguje, ulazni = duguje − potražuje, i
 *      negativne linije (knjižna odobrenja) se NE odbacuju;
 *   3) OSNOVICA: base = PDV/(rate/100) za SVAKO konto sa stopom — i za konta
 *      korekcije („zatvaranje/pokrivanje avansa", „interni račun"). Ranija
 *      zastavica `has_base = false` im je gutala osnovicu i naduvavala zbir
 *      knjige za stotine miliona (v. migraciju 20260727090000, uzrok C).
 *
 * Prisma je mockovana — SQL se hvata kao tekst, logika servisa je čista.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Jedan red agregacije iz GK, onako kako ga `$queryRaw` vrati. */
function aggRow(over: Record<string, unknown> = {}) {
  return {
    journal_entry_id: 100,
    document_number: "UF-1/2026",
    analytical_code: 501,
    document_date: new Date("2026-03-15T00:00:00.000Z"),
    account_code: "2700",
    direction: "input",
    rate: 20,
    vat_amount: D("2000"),
    ...over,
  };
}

/**
 * Mock Prisma: `$transaction(cb)` prosleđuje isti objekat kao `tx`.
 * `$queryRaw` razlikuje pozive po sadržaju SQL-a: agregacija GK (`ledger_entries`
 * + `vat_account_map`) vs upiti provere ispravnosti iz `vat-sanity.ts`.
 */
function makePrisma(opts: {
  rows?: ReturnType<typeof aggRow>[];
  /**
   * Zbirovi knjiga koje provera pročita POSLE upisa (default: izvedeni iz rows).
   * `rateCode` je opcion — bez njega grupa ide kao „bez stope" (P5 je preskače).
   */
  bookSums?: {
    direction: string;
    n: number;
    base: Prisma.Decimal;
    vat: Prisma.Decimal;
    rateCode?: string | null;
  }[];
  /** Saldo 2790/4790 iz naloga vrste PDV; null = period bez naloga (otvoren). */
  control?: Prisma.Decimal | null;
}) {
  const rows = opts.rows ?? [aggRow()];
  const sqlSeen: string[] = [];
  const created: unknown[] = [];

  const bookSums =
    opts.bookSums ??
    (() => {
      const acc = new Map<string, { n: number; base: Prisma.Decimal; vat: Prisma.Decimal }>();
      for (const r of rows) {
        const vat = new Prisma.Decimal(r.vat_amount as Prisma.Decimal);
        if (vat.isZero()) continue;
        const base =
          r.rate == null || r.rate === 0
            ? D(0)
            : vat.div(new Prisma.Decimal(r.rate as number).div(100));
        const cur = acc.get(r.direction as string) ?? { n: 0, base: D(0), vat: D(0) };
        acc.set(r.direction as string, {
          n: cur.n + 1,
          base: cur.base.add(base),
          vat: cur.vat.add(vat),
        });
      }
      return [...acc.entries()].map(([direction, v]) => ({
        direction,
        ...v,
        rateCode: null as string | null,
      }));
    })();

  const tx = {
    vatLedgerEntry: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockImplementation(({ data }: { data: unknown[] }) => {
        created.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    $queryRaw: jest.fn().mockImplementation((q: Prisma.Sql) => {
      const text = q.strings.join("?");
      sqlSeen.push(text);
      if (text.includes("vat_account_map vam")) return Promise.resolve(rows);
      if (text.includes("FROM vat_ledger_entries")) {
        // Provera sada čita Σ po (smer, stopa, ručno/GK) — jedan prolaz iz kojeg
        // se izvode zbirovi knjiga (P1–P3), grupe po stopi (P5) i ručna odstupnica.
        return Promise.resolve(
          bookSums.map((b) => ({
            direction: b.direction,
            rate_code: b.rateCode ?? null,
            is_manual: false,
            n: BigInt(b.n),
            base: b.base,
            vat: b.vat,
          })),
        );
      }
      if (text.includes("VAT_TRANSIT") || text.includes("le.account_code IN (")) {
        // kontrolna tačka 2790/4790
        return opts.control === null
          ? Promise.resolve([{ n: BigInt(0), net: D(0) }])
          : Promise.resolve([{ n: BigInt(2), net: opts.control ?? D(0) }]);
      }
      return Promise.resolve([]); // nemapirana 27x/47x konta
    }),
  };

  const prisma = {
    ...tx,
    vatReturn: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { prisma, tx, sqlSeen, created };
}

/** Kontrola za „input − output" da provera prođe (razlika 0). */
function controlFor(rows: ReturnType<typeof aggRow>[]): Prisma.Decimal {
  let net = D(0);
  for (const r of rows) {
    const v = new Prisma.Decimal(r.vat_amount as Prisma.Decimal);
    net = r.direction === "input" ? net.add(v) : net.sub(v);
  }
  return net;
}

describe("VatLedgerService.buildKifKuf — izuzimanje tehničkog naloga", () => {
  it("SQL izuzima nalog vrste PDV, i to uz JOIN na registar PDV konta", async () => {
    const rows = [aggRow()];
    const { prisma, sqlSeen } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    await svc.buildKifKuf(2026, 3);

    const agg = sqlSeen.find((s) => s.includes("vat_account_map vam"))!;
    expect(agg).toBeDefined();
    // izuzimanje je vezano za VRSTU naloga (order_type_code), ne za bb_nalog_id
    expect(agg).toMatch(/COALESCE\(je\.order_type_code, ''\)\s*<>/);
    expect(agg).toContain("order_type_code");
    // ...i stoji UZ JOIN na registar — dakle ne izuzima nalog u celini
    expect(agg).toContain("JOIN vat_account_map vam ON vam.account = le.account_code");
    // izuzimanje NIJE po kontu: nema filtera koji bi izbacio 2790/4790/6799 —
    // stavke tehničkog naloga na tim kontima namerno ostaju u glavnoj knjizi
    // (pominju se samo u komentaru, nikad u uslovu).
    const conditions = agg
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(conditions).not.toMatch(/2790|4790|6799|5799/);
  });

  it("prosleđena vrsta naloga je konstanta 'PDV' (ne magičan string u upitu)", async () => {
    const rows = [aggRow()];
    const { prisma, tx } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    await svc.buildKifKuf(2026, 3);
    const call = (tx.$queryRaw as jest.Mock).mock.calls.find((c) =>
      (c[0] as Prisma.Sql).strings.join("?").includes("vat_account_map vam"),
    )!;
    expect((call[0] as Prisma.Sql).values).toContain("PDV");
  });
});

describe("VatLedgerService.buildKifKuf — znak i osnovica", () => {
  it("izlazni PDV je pozitivan i osnovica se izvodi iz stope (5× za 20%)", async () => {
    const rows = [
      aggRow({ direction: "output", account_code: "4701", vat_amount: D("642999.89") }),
    ];
    const { prisma, created } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 3);

    expect(res.kifCount).toBe(1);
    expect(res.outputVat.toFixed(2)).toBe("642999.89");
    expect(res.outputBase.toFixed(2)).toBe("3214999.45");
    expect((created[0] as { vatRateCode: string }).vatRateCode).toBe("20");
  });

  it("negativna linija (knjižno odobrenje) OSTAJE, sa negativnim znakom", async () => {
    const rows = [
      aggRow({ account_code: "2700", vat_amount: D("28298900.58") }),
      aggRow({
        journal_entry_id: 101,
        account_code: "27002",
        document_number: "KO-3/2026",
        vat_amount: D("-846.79"),
      }),
    ];
    const { prisma, created } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 3);

    expect(res.kufCount).toBe(2);
    expect(created).toHaveLength(2);
    expect(res.inputVat.toFixed(2)).toBe("28298053.79");
    // osnovica prati znak PDV-a (−846,79 / 0,2 = −4.233,95)
    expect(res.inputBase.toFixed(2)).toBe("141490268.95");
  });

  it('konto korekcije („zatvaranje avansa") DOBIJA osnovicu, sa negativnim znakom', async () => {
    // Stvarni podaci 03/2026: 2700 nosi +28.298.900,58, a 27200 („zatvaranje
    // avansa iz prethodnog perioda") −12.020.399,30. Ranije je 27200 nosio
    // `has_base = false` pa je skidao PDV a NIJE skidao osnovicu — knjiga je
    // ostajala naduvana za 60.101.996,50 i implicitna stopa KUF-a je pala na
    // 13,79% umesto 20%. Osnovica korekcije je stvarna, samo negativna.
    const rows = [
      aggRow({ account_code: "2700", vat_amount: D("28298900.58") }),
      aggRow({
        journal_entry_id: 101,
        account_code: "27200",
        vat_amount: D("-12020399.30"),
      }),
    ];
    const { prisma, created } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 3);

    expect(res.inputVat.toFixed(2)).toBe("16278501.28");
    // 141.494.502,90 − 60.101.996,50 = 81.392.506,40 → tačno 5× PDV (stopa 20%)
    expect(res.inputBase.toFixed(2)).toBe("81392506.40");
    expect(res.inputBase.div(res.inputVat).toFixed(4)).toBe("5.0000");
    expect((created[1] as { vatBase: Prisma.Decimal }).vatBase.toFixed(2)).toBe(
      "-60101996.50",
    );
  });

  it("P5 obara knjigu u kojoj osnovica ne odgovara stopi (reprodukovan KIF 02/2026)", async () => {
    // Zaključava da se greška „konto skida PDV a ne skida osnovicu" NE može
    // vratiti neopaženo: 308.851.171,00 osnovice uz 21.575.667,23 PDV-a je
    // implicitna stopa 6,99%, a jedine mapirane stope su 20 i 10.
    const rows = [aggRow({ direction: "output", vat_amount: D("21575667.23") })];
    const { prisma } = makePrisma({
      rows,
      bookSums: [
        {
          direction: "output",
          n: 37,
          base: D("308851171.00"),
          vat: D("21575667.23"),
          rateCode: "20",
        },
      ],
      control: D("-21575667.23"),
    });
    const svc = new VatLedgerService(prisma as never);
    await expect(svc.buildKifKuf(2026, 2)).rejects.toThrow(/stopa 20%/);
  });

  it("nulta grupa se preskače (ne pravi prazan red u knjizi)", async () => {
    const rows = [
      aggRow({ vat_amount: D(0) }),
      aggRow({ journal_entry_id: 102, vat_amount: D("100") }),
    ];
    const { prisma, created } = makePrisma({ rows, control: controlFor(rows) });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 3);
    expect(res.kufCount).toBe(1);
    expect(created).toHaveLength(1);
  });
});

describe("VatLedgerService.buildKifKuf — zaštita od tihe greške", () => {
  it("stavke postoje a zbir je 0,00 → 409, punjenje se poništava (rollback)", async () => {
    const rows = [aggRow({ vat_amount: D("1") })];
    const { prisma } = makePrisma({
      rows,
      // knjiga posle upisa: 625 stavki, ukupno 0,00 — reprodukovan otkaz 03/2026
      bookSums: [{ direction: "input", n: 625, base: D(0), vat: D(0) }],
      control: D("21602291.00"),
    });
    const svc = new VatLedgerService(prisma as never);
    await expect(svc.buildKifKuf(2026, 3)).rejects.toBeInstanceOf(VatSanityException);
  });

  it("neslaganje sa BigBitom preko 2,00 RSD → 409 sa oba iznosa u poruci", async () => {
    const rows = [aggRow({ vat_amount: D("26689144.42") })];
    const { prisma } = makePrisma({ rows, control: D("21602291.00") });
    const svc = new VatLedgerService(prisma as never);
    await expect(svc.buildKifKuf(2026, 3)).rejects.toThrow(/NE slaže sa BigBitom/);
  });

  it("force = true upisuje ipak, ali problem ostaje u izveštaju", async () => {
    const rows = [aggRow({ vat_amount: D("1") })];
    const { prisma, tx } = makePrisma({
      rows,
      bookSums: [{ direction: "input", n: 625, base: D(0), vat: D(0) }],
      control: D("21602291.00"),
    });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 3, { force: true });
    expect(tx.vatLedgerEntry.createMany).toHaveBeenCalled();
    expect(res.sanity.ok).toBe(false);
    expect(res.sanity.problems.length).toBeGreaterThan(0);
  });

  it("period bez naloga zatvaranja (otvoren) prolazi uz upozorenje", async () => {
    const rows = [aggRow({ vat_amount: D("1442599.20") })];
    const { prisma } = makePrisma({ rows, control: null });
    const svc = new VatLedgerService(prisma as never);
    const res = await svc.buildKifKuf(2026, 7);
    expect(res.sanity.ok).toBe(true);
    expect(res.sanity.warnings.some((w) => /nalog zatvaranja/.test(w))).toBe(true);
  });
});

/**
 * NEVALIDAN PERIOD MORA BITI OBJAŠNJEN KORISNIKU (defekt 04.08.2026).
 * `AllExceptionsFilter` propušta samo `HttpException`, pa je `InvalidVatPeriodException`
 * — dok je nasleđivala goli `Error` — izlazila kao 500 „Neočekivana greška na serveru":
 * na pogrešno unetu godinu se nije moglo videti ŠTA je pogrešno. 422, ne 400: godina i
 * mesec SU brojevi, van opsega je poslovni horizont (2000–2100 / 1..12), a isti guard
 * brani i interne tokove u kojima period ne dolazi iz tela zahteva.
 *
 * Bez ispravke ovaj blok pada na `toBeInstanceOf(HttpException)`.
 */
describe("VatLedgerService — nevalidan period je 422, ne 500", () => {
  const caught = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error("Očekivana greška nije bačena.");
  };

  it("buildKifKuf(1999, 3) → 422 sa periodom u poruci i u `details`", async () => {
    // Prisma nije potrebna: `assertPeriod` je prva naredba metode.
    const svc = new VatLedgerService({} as never);
    const e = await caught(() => svc.buildKifKuf(1999, 3));

    expect(e).toBeInstanceOf(InvalidVatPeriodException);
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((e as Error).message).toBe(
      "Nevalidan PDV period: godina=1999, mesec=3.",
    );
    expect((e as HttpException).getResponse()).toEqual({
      message: "Nevalidan PDV period: godina=1999, mesec=3.",
      code: "PDV_INVALID_PERIOD",
      details: { year: 1999, month: 3 },
    });
  });

  it("buildKifKuf(2026, 13) → 422 (mesec van 1..12)", async () => {
    const svc = new VatLedgerService({} as never);
    const e = await caught(() => svc.buildKifKuf(2026, 13));
    expect((e as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((e as Error).message).toBe(
      "Nevalidan PDV period: godina=2026, mesec=13.",
    );
  });
});
