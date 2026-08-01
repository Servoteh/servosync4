import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { KepuService, type KepuBookRow } from "../kepu.service";
import { KepuPdfService } from "./kepu-pdf.service";
import { fmtMoney, widthSlack } from "../../documents/doc-layout";

/**
 * KEP KNJIGA — test DONOS / ZA PRENOS prenosa zbirova.
 * =========================================================================
 * Ovo je jedina štampa u aplikaciji sa per-page carry-jem, a pdfmake ga ne ume:
 * prelom je RUČAN (jedna strana knjige = jedna tabela sa `pageBreak: "before"`).
 * Bez ovog testa regresija bi bila tiha — papir bi i dalje izgledao ispravno, a
 * prenos zbirova bi bio pogrešan, što je greška u ZAKONSKOJ evidenciji.
 *
 * Tvrdi se NAD `docDefinition`-om (kao `robno-print.service.spec`), ne nad
 * bajtovima PDF-a.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Rekurzivno kupi sav `text` iz čvora dokumenta. */
function allText(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) allText(n, acc);
    return acc;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>))
      allText(v, acc);
  }
  return acc;
}

/** Sve tabele u dokumentu (telo + širine kolona). */
function tables(
  node: unknown,
  acc: Array<{ widths: Array<string | number>; body: unknown[][] }> = [],
): Array<{ widths: Array<string | number>; body: unknown[][] }> {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) tables(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  const t = obj.table as
    | { widths?: Array<string | number>; body?: unknown[][] }
    | undefined;
  if (t?.widths && t.body && t.widths.length > 3) {
    acc.push({ widths: t.widths, body: t.body });
  }
  for (const v of Object.values(obj)) tables(v, acc);
  return acc;
}

/**
 * `n` redova knjige u julu date godine: naizmenično zaduženje/razduženje,
 * iznos raste sa rednim brojem (svaki red je prepoznatljiv u zbiru).
 */
function makeRows(n: number, year = 2026): KepuBookRow[] {
  const rows: KepuBookRow[] = [];
  let balance = D(0);
  for (let i = 1; i <= n; i += 1) {
    const value = D(100 * i);
    const isCharge = i % 3 !== 0;
    balance = isCharge ? balance.add(value) : balance.sub(value);
    rows.push({
      id: i,
      rbr: i,
      strana: Math.floor((i - 1) / 45) + 1,
      entryDate: new Date(Date.UTC(year, 6, ((i - 1) % 28) + 1)),
      documentNumber: `UFROB ${String(i).padStart(4, "0")}`,
      documentDate: new Date(Date.UTC(year, 6, ((i - 1) % 28) + 1)),
      description: "ulaz robe",
      charge: isCharge ? value : D(0),
      discharge: isCharge ? D(0) : value,
      balance,
    });
  }
  return rows;
}

/** `n` redova u zadatom mesecu date godine, počev od rednog broja `startRbr`. */
function makeMonthRows(
  n: number,
  month: number,
  startRbr: number,
  year = 2026,
): KepuBookRow[] {
  const rows: KepuBookRow[] = [];
  for (let k = 0; k < n; k += 1) {
    const i = startRbr + k;
    const value = D(100 * i);
    const isCharge = i % 3 !== 0;
    const day = (k % 27) + 1;
    rows.push({
      id: i,
      rbr: i,
      strana: Math.floor((i - 1) / 45) + 1,
      entryDate: new Date(Date.UTC(year, month - 1, day)),
      documentNumber: `UFROB ${String(i).padStart(4, "0")}`,
      documentDate: new Date(Date.UTC(year, month - 1, day)),
      description: "ulaz robe",
      charge: isCharge ? value : D(0),
      discharge: isCharge ? D(0) : value,
      balance: D(0),
    });
  }
  return rows;
}

function setup(rows: KepuBookRow[]) {
  let docDef: TDocumentDefinitions = {} as TDocumentDefinitions;
  const pdf = {
    render: jest.fn((d: TDocumentDefinitions) => {
      docDef = d;
      return Promise.resolve(Buffer.from("%PDF-proba"));
    }),
  } as unknown as PdfService;

  const prisma = {
    company: {
      findFirst: jest.fn().mockResolvedValue({
        companyName: "SERVOTEH d.o.o.",
        address: "Dobanovački put 1",
        city: "Zemun",
        taxId: "101017443",
        registrationNumber: "17400169",
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    warehouse: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: "Magacin repromaterijala" }),
    },
  } as unknown as PrismaService;

  const kepu = {
    book: jest.fn().mockResolvedValue(rows),
    // Princip vrednovanja (MP/VP) se čita iz Podešavanja pri svakoj štampi; testovi
    // rade po podrazumevanom MP, pa se ispisana napomena i iznosi ne menjaju.
    currentValuation: jest.fn().mockResolvedValue("MP"),
  } as unknown as KepuService;

  const service = new KepuPdfService(prisma, pdf, kepu);
  return { service, getDocDef: () => docDef };
}

/** Red tabele koji sadrži zadati natpis (DONOS / ZA PRENOS). */
function findRow(body: unknown[][], label: string): unknown[] | undefined {
  return body.find((row) =>
    row.some(
      (cell) =>
        typeof cell === "object" &&
        cell != null &&
        String((cell as { text?: unknown }).text ?? "") === label,
    ),
  );
}

function cellText(row: unknown[], index: number): string {
  const cell = row[index] as { text?: unknown } | undefined;
  return String(cell?.text ?? "");
}

const DONOS = "D O N O S :";
const ZA_PRENOS = "Z A   P R E N O S :";

describe("KepuPdfService — knjiga evidencije prometa (KEP)", () => {
  it("strana knjige nosi najviše 45 redova i lomi se na novu stranu papira", async () => {
    const rows = makeRows(100);
    const { service, getDocDef } = setup(rows);
    await service.buildKepuPdf({ year: 2026 });

    const t = tables(getDocDef().content);
    expect(t).toHaveLength(3); // 100 redova = 3 strane knjige (45 + 45 + 10)

    // Telo = zaglavlje + DONOS + redovi + ZA PRENOS.
    expect(t[0].body).toHaveLength(1 + 1 + 45 + 1);
    expect(t[1].body).toHaveLength(1 + 1 + 45 + 1);
    expect(t[2].body).toHaveLength(1 + 1 + 10 + 1);
  });

  it("ZA PRENOS jedne strane je DONOS sledeće (prenos zbirova ne curi)", async () => {
    const rows = makeRows(100);
    const { service, getDocDef } = setup(rows);
    await service.buildKepuPdf({ year: 2026 });

    const t = tables(getDocDef().content);
    for (let i = 0; i + 1 < t.length; i += 1) {
      const carryOut = findRow(t[i].body, ZA_PRENOS);
      const carryIn = findRow(t[i + 1].body, DONOS);
      expect(carryOut).toBeDefined();
      expect(carryIn).toBeDefined();
      // Kolone: 0 R.br, 1 datum, 2 opis, 3 zaduženje, 4 razduženje.
      expect(cellText(carryIn!, 3)).toBe(cellText(carryOut!, 3));
      expect(cellText(carryIn!, 4)).toBe(cellText(carryOut!, 4));
    }
  });

  it("prva strana počinje od nule, poslednji ZA PRENOS = Σ cele knjige", async () => {
    const rows = makeRows(100);
    const { service, getDocDef } = setup(rows);
    await service.buildKepuPdf({ year: 2026 });

    const t = tables(getDocDef().content);
    const first = findRow(t[0].body, DONOS)!;
    expect(cellText(first, 3)).toBe(fmtMoney(0));
    expect(cellText(first, 4)).toBe(fmtMoney(0));

    let charge = new Prisma.Decimal(0);
    let discharge = new Prisma.Decimal(0);
    for (const r of rows) {
      charge = charge.add(r.charge);
      discharge = discharge.add(r.discharge);
    }
    const last = findRow(t[t.length - 1].body, ZA_PRENOS)!;
    expect(cellText(last, 3)).toBe(fmtMoney(charge));
    expect(cellText(last, 4)).toBe(fmtMoney(discharge));
  });

  it("štampa jednog meseca iz sredine godine NASLEĐUJE donos (ne počinje od nule)", async () => {
    // Ceo julski blok postoji u knjizi, ali se štampa samo avgust — donos
    // avgusta mora biti zbir svega pre njega, inače knjiga laže o prenosu.
    const year = 2026;
    const july = makeRows(50, year); // rbr 1..50, jul
    const august: KepuBookRow[] = [];
    let balance = july[july.length - 1].balance;
    for (let i = 51; i <= 60; i += 1) {
      const value = D(100 * i);
      balance = balance.add(value);
      august.push({
        id: i,
        rbr: i,
        strana: Math.floor((i - 1) / 45) + 1,
        entryDate: new Date(Date.UTC(year, 7, i - 50)),
        documentNumber: `UFROB ${i}`,
        documentDate: new Date(Date.UTC(year, 7, i - 50)),
        description: "ulaz robe",
        charge: value,
        discharge: D(0),
        balance,
      });
    }
    const { service, getDocDef } = setup([...july, ...august]);
    await service.buildKepuPdf({ year, month: 8 });

    const t = tables(getDocDef().content);
    // Avgustovski redovi (rbr 51..60) svi padaju na 2. stranu knjige.
    expect(t).toHaveLength(1);
    const donos = findRow(t[0].body, DONOS)!;
    // Donos 2. strane = zbir redova 1..45 (kraj 1. strane), NE nula i NE zbir 1..50.
    let charge = new Prisma.Decimal(0);
    let discharge = new Prisma.Decimal(0);
    for (const r of july.slice(0, 45)) {
      charge = charge.add(r.charge);
      discharge = discharge.add(r.discharge);
    }
    expect(cellText(donos, 3)).toBe(fmtMoney(charge));
    expect(cellText(donos, 4)).toBe(fmtMoney(discharge));
    expect(cellText(donos, 3)).not.toBe(fmtMoney(0));
  });

  /**
   * REGRESIJA 27.07.2026 — ovo je bag zbog kog je isporuka pala reviziju.
   * ZA PRENOS se računao kao `donos + Σ ODŠTAMPANIH redova`, a DONOS sledeće
   * strane kao kumulativa godine. Kad prva strana knjige NIJE odštampana cela
   * (a pri štampi jednog meseca skoro nikad nije), zbirovi se raziđu i papir sam
   * sebi protivreči na dve uzastopne strane ZAKONSKE knjige.
   *
   * Stari test to nije hvatao jer je štampao CELU godinu (sve strane pune), a
   * mesečni test je davao samo JEDNU tabelu pa se prelaz strana nikad ne izvrši.
   */
  it("REGRESIJA: lanac DONOS/ZA PRENOS drži i kad strana knjige NIJE odštampana cela", async () => {
    const year = 2031;
    // 10 redova u junu (rbr 1..10) + 140 u julu (rbr 11..150) = 4 strane knjige.
    // Prva strana knjige (rbr 1..45) se štampa DELIMIČNO — samo rbr 11..45.
    const june = makeMonthRows(10, 6, 1, year);
    const july = makeMonthRows(140, 7, 11, year);
    const { service, getDocDef } = setup([...june, ...july]);
    await service.buildKepuPdf({ year, month: 7 });

    const t = tables(getDocDef().content);
    expect(t.length).toBeGreaterThanOrEqual(2); // prelaz strana se MORA izvršiti

    for (let i = 0; i + 1 < t.length; i += 1) {
      const carryOut = findRow(t[i].body, ZA_PRENOS);
      const carryIn = findRow(t[i + 1].body, DONOS);
      expect(carryOut).toBeDefined();
      expect(carryIn).toBeDefined();
      expect(cellText(carryIn!, 3)).toBe(cellText(carryOut!, 3));
      expect(cellText(carryIn!, 4)).toBe(cellText(carryOut!, 4));
    }

    // Poslednji ZA PRENOS = Σ CELE godine (i junski redovi koji se ne štampaju).
    let charge = new Prisma.Decimal(0);
    let discharge = new Prisma.Decimal(0);
    for (const r of [...june, ...july]) {
      charge = charge.add(r.charge);
      discharge = discharge.add(r.discharge);
    }
    const last = findRow(t[t.length - 1].body, ZA_PRENOS)!;
    expect(cellText(last, 3)).toBe(fmtMoney(charge));
    expect(cellText(last, 4)).toBe(fmtMoney(discharge));

    // Delimično odštampana strana MORA da nosi objašnjenje, inače razlika
    // (ZA PRENOS − DONOS) veća od zbira vidljivih redova nema opravdanje.
    expect(allText(getDocDef().content).join(" ")).toContain(
      "ova strana knjige ima 45 redova, od kojih je 35 u izabranom periodu",
    );
  });

  it("period bez prometa se štampa sa napomenom, ne puca i nema praznu mrežu", async () => {
    const { service, getDocDef } = setup([]);
    const res = await service.buildKepuPdf({
      year: 2026,
      month: 3,
      warehouseId: 7,
    });
    expect(res.fileName).toBe("KEP-knjiga-2026-03-mag7.pdf");
    const text = allText(getDocDef().content).join("");
    expect(text).toContain("ZA IZABRANI PERIOD NEMA EVIDENTIRANOG PROMETA");
    expect(tables(getDocDef().content)).toHaveLength(0);
  });

  it("obrazac ima PET kolona po čl. 15 (BigBit šesta kolona se ne štampa)", async () => {
    const { service, getDocDef } = setup(makeRows(3));
    await service.buildKepuPdf({ year: 2026, warehouseId: 7 });

    const t = tables(getDocDef().content)[0];
    expect(t.widths).toHaveLength(5);
    expect(t.body[0]).toHaveLength(5);
    // Šesta kolona pred-2015 obrasca ne sme da se vrati ni kao prazna.
    expect(allText(getDocDef().content).join(" ")).not.toContain(
      "Iznos uplate\nna račun",
    );
  });

  it("kolona 3 ne duplira broj isprave i nosi njen DATUM (čl. 15)", async () => {
    const { service, getDocDef } = setup([
      {
        id: 1,
        rbr: 1,
        strana: 1,
        entryDate: new Date(Date.UTC(2026, 6, 5)),
        documentNumber: "0001/2026",
        documentDate: new Date(Date.UTC(2026, 6, 2)),
        description: "UFROB 0001/2026",
        charge: D(1000),
        discharge: D(0),
        balance: D(1000),
      },
    ]);
    await service.buildKepuPdf({ year: 2026, warehouseId: 7 });

    const body = tables(getDocDef().content)[0].body;
    const desc = cellText(body[2], 2);
    expect(desc).toBe("UFROB 0001/2026 od 02.07.2026.");
    // Ranije se dobijalo „0001/2026 — UFROB 0001/2026".
    expect(desc.startsWith("0001/2026 —")).toBe(false);
  });

  it("bez izabranog magacina NIJE obrazac KEP (čl. 3) — bez oznake i bez potpisa", async () => {
    const { service, getDocDef } = setup(makeRows(3));
    const res = await service.buildKepuPdf({ year: 2026 });
    const text = allText(getDocDef().content).join(" ");

    expect(res.fileName).toBe("PREGLED-prometa-2026.pdf");
    expect(text).toContain("INTERNI PREGLED PROMETA");
    expect(text).toContain("NIJE OBRAZAC KEP");
    expect(text).not.toContain("Obrazac KEP");
    // Potpisno mesto odgovornog lica postoji SAMO na zakonskom obrascu.
    expect(text).not.toContain("Odgovorno lice");
  });

  it("sa izabranim magacinom JESTE obrazac KEP — oznaka, prodajno mesto i potpis", async () => {
    const { service, getDocDef } = setup(makeRows(3));
    const res = await service.buildKepuPdf({ year: 2026, warehouseId: 7 });
    const text = allText(getDocDef().content).join(" ");

    expect(res.fileName).toBe("KEP-knjiga-2026-mag7.pdf");
    expect(text).toContain("KNJIGA EVIDENCIJE PROMETA");
    expect(text).toContain("Obrazac KEP");
    expect(text).toContain("Odgovorno lice");
    expect(text).not.toContain("NIJE OBRAZAC KEP");
  });

  it("zaglavlje obveznika se ponavlja iznad SVAKE strane knjige", async () => {
    const { service, getDocDef } = setup(makeRows(100));
    await service.buildKepuPdf({ year: 2026, warehouseId: 7 });

    // 3 strane knjige → 3 banera sa nazivom obveznika i PIB-om.
    const banners = allText(getDocDef().content).filter((s) =>
      s.includes("SERVOTEH d.o.o. · PIB 101017443"),
    );
    expect(banners).toHaveLength(3);
  });

  it("tabela ne prelije stranu (fiksne širine + padding staju u A4 uspravno)", async () => {
    const { service, getDocDef } = setup(makeRows(50));
    await service.buildKepuPdf({ year: 2026 });
    for (const t of tables(getDocDef().content)) {
      // Padding ove mreže je 3 pt po ivici (6 po koloni), „*" traži bar 120 pt
      // za opis knjiženja.
      expect(widthSlack(t.widths, false, 6, 120)).toBeGreaterThanOrEqual(0);
    }
  });

  it("odbija nevalidan period umesto da tiho odštampa pogrešnu godinu", async () => {
    const { service } = setup(makeRows(3));
    await expect(service.buildKepuPdf({ year: 1899 })).rejects.toThrow(
      /Nevalidna godina/,
    );
    await expect(
      service.buildKepuPdf({ year: 2026, month: 13 }),
    ).rejects.toThrow(/Nevalidan mesec/);
  });
});
