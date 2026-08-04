/**
 * APR eFI XML — JEDINICA OBRASCA (hiljade dinara).
 * =========================================================================
 * ZAŠTO POSTOJI OVAJ FAJL: revizija (04.08.2026) je našla da je `xmlTag` emitovao
 * `Round(amount, 0)` nad iznosima koji su u PUNIM DINARIMA, a APR eFI obrazac se
 * predaje U HILJADAMA — cela predaja APR-u je zato bila 1000× veća od stvarne.
 * Deljenje je postojalo samo u štampi (`statement-pdf.service.fmtAmount`), pa su dva
 * izlaza istog obračuna govorila različit broj; to razilaženje je i bio koren nalaza.
 *
 * Testovi zato mere dve stvari koje niko drugi ne čuva:
 *   1. da XML nosi hiljade (i da se deli PRE zaokruživanja, sa ROUND_HALF_UP),
 *   2. da XML i PDF za isti obračun daju ISTU brojku — najvredniji test u fajlu, jer
 *      su to dva odvojena `div(1000)` mesta koja bi tihi refaktor mogao da razvede.
 */

import { Prisma } from "@prisma/client";
import { AprXmlService } from "./apr-xml.service";
import { fmtAmount } from "./statement-pdf.service";
import { STATEMENT_TYPE } from "./statement-type";

/** Linija obračuna: iznosi su u DINARIMA (tako stoje u bazi), kao i u produkciji. */
function line(
  aop: string,
  dinari: string,
  prethodna = "0",
  pretprethodna = "0",
) {
  return {
    aop,
    amount: new Prisma.Decimal(dinari),
    amount2: new Prisma.Decimal(prethodna),
    amount3: new Prisma.Decimal(pretprethodna),
  };
}

/** Prisma dovoljna za `exportFiForma`: obračun sa linijama + primarna firma. */
function service(
  lines: ReturnType<typeof line>[],
  statementType: string = STATEMENT_TYPE.BALANCE_SHEET,
) {
  const prisma = {
    financialStatement: {
      // eslint-disable-next-line @typescript-eslint/require-await
      findUnique: async () => ({
        id: 1,
        statementType,
        periodYear: 2025,
        lines,
      }),
    },
    company: {
      // eslint-disable-next-line @typescript-eslint/require-await
      findFirst: async () => ({
        companyName: "Servoteh d.o.o.",
        taxId: "100000001",
        registrationNumber: "07123456",
        businessActivityCode: "2711",
      }),
    },
  };
  return new AprXmlService(prisma as never);
}

/**
 * Vrednost numeričkog polja `aop-{aop}-{kolona}` iz XML-a.
 * Vraća `null` kad je polje emitovano kao `i:nil="true"` (u hiljadama je to nula).
 */
function polje(xml: string, aop: string, kolona = 3): string | null {
  const re = new RegExp(
    `<a:Naziv>aop-${aop}-${kolona}</a:Naziv>` +
      `(?:<a:Vrednosti i:nil="true"/>|<a:Vrednosti>(-?\\d+)</a:Vrednosti>)`,
  );
  const m = re.exec(xml);
  if (!m) throw new Error(`polje aop-${aop}-${kolona} nije nađeno u XML-u`);
  return m[1] ?? null;
}

describe("APR XML — iznosi se predaju u hiljadama dinara", () => {
  it("1.234.567 din daje 1235, a nikad sirov dinarski iznos", async () => {
    const { xml } = await service([line("0001", "1234567")]).exportFiForma(1);
    expect(polje(xml, "0001")).toBe("1235");
    expect(xml).not.toContain("1234567");
  });

  it('499 din je u hiljadama nula → i:nil="true" (namerno, podaci nisu izgubljeni)', async () => {
    const { xml } = await service([line("0002", "499")]).exportFiForma(1);
    expect(polje(xml, "0002")).toBeNull();
    expect(xml).toContain('<a:Vrednosti i:nil="true"/>');
  });

  it("500 din daje 1 — dokaz da se deli PRE zaokruživanja i da je ROUND_HALF_UP", async () => {
    const { xml } = await service([line("0003", "500")]).exportFiForma(1);
    expect(polje(xml, "0003")).toBe("1");
  });

  it("1.500 din daje 2, a 1.499 daje 1 (isti prag kao štampa)", async () => {
    const { xml } = await service([
      line("0004", "1500"),
      line("0005", "1499"),
    ]).exportFiForma(1);
    expect(polje(xml, "0004")).toBe("2");
    expect(polje(xml, "0005")).toBe("1");
  });

  it("negativan iznos zaokružuje od nule (-500 din → -1)", async () => {
    const { xml } = await service([line("0006", "-500")]).exportFiForma(1);
    expect(polje(xml, "0006")).toBe("-1");
  });

  it("prethodna i pretprethodna godina (kolone 4 i 5) se svode isto kao tekuća", async () => {
    const { xml } = await service([
      line("0007", "1234567", "2500", "-1500"),
    ]).exportFiForma(1);
    expect(polje(xml, "0007", 3)).toBe("1235");
    expect(polje(xml, "0007", 4)).toBe("3"); // 2.500 din → 2,5 hilj. → 3 (HALF_UP)
    expect(polje(xml, "0007", 5)).toBe("-2"); // −1.500 din → −1,5 → −2 (od nule)
  });

  it("bilans uspeha (2 kolone) svodi na hiljade isto kao bilans stanja", async () => {
    const { xml } = await service(
      [line("1001", "868293456.78", "500")],
      STATEMENT_TYPE.INCOME_STATEMENT,
    ).exportFiForma(1);
    expect(polje(xml, "1001", 3)).toBe("868293");
    expect(polje(xml, "1001", 4)).toBe("1");
  });
});

/**
 * Iznosi na kojima se dva izlaza mogu raziću: .5 pragovi u oba smera, sub-hiljadarke
 * (koje u XML-u postaju i:nil, a u štampi „0"), veliki iznos i nula.
 */
const IZNOSI = [
  "1234567",
  "499",
  "500",
  "501",
  "999",
  "1500",
  "2500",
  "868293456.78",
  "-500",
  "-1499",
  "-1500",
  "0",
];

describe("APR XML i PDF govore isti broj", () => {
  it("za svaki iznos XML polje == fmtAmount(..., „hiljade“)", async () => {
    const lines = IZNOSI.map((v, i) => line(String(1000 + i), v));
    const { xml } = await service(lines).exportFiForma(1);

    for (const [i, v] of IZNOSI.entries()) {
      const aop = String(1000 + i);
      // i:nil u XML-u i „0" u štampi su isto: u hiljadama je vrednost nula.
      const izXml = polje(xml, aop) ?? "0";
      // Štampa grupiše hiljade tačkom (868.293) — poredi se sama brojka.
      const izPdf = fmtAmount(new Prisma.Decimal(v), "hiljade").replace(
        /\./g,
        "",
      );
      // Ključ u poruci, da pad odmah kaže KOJI iznos je razveo izlaze.
      expect(`${v} → ${izXml}`).toBe(`${v} → ${izPdf}`);
    }
  });
});
