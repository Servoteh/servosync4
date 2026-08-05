import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { OpenItemsService } from "./open-items.service";

/**
 * OPEN ITEMS — devizni filter (review C2 §3). Grupa je (konto, komitent, broj
 * dokumenta), a `document_number` je NULLABLE: sve stavke partnera bez broja dokumenta
 * padaju u JEDNU grupu. Raniji filter `MAX(le.fx_currency) = :cur` je tada birao
 * leksikografski najveću valutu — EUR grupa je tiho nestajala iz bilansa, a USD je
 * pokupio i EUR devizni saldo i knjižio lažan rashod.
 *
 * SQL se ne izvršava ovde (to je posao dev-baze i probe skripte) — testovi zaključavaju
 * SASTAV upita: koji uslov ide u HAVING i kako se sabira devizni saldo, plus da put
 * BEZ deviznog filtera (aging, kartica komitenta, ostali čitaoci) ostane bit-po-bit isti.
 */

interface Capture {
  service: OpenItemsService;
  /** Poslednji SQL koji je otišao u $queryRaw, sa umetnutim parametrima. */
  sql: () => string;
  params: () => unknown[];
}

function makeService(rows: unknown[] = []): Capture {
  let lastSql: Prisma.Sql | null = null;
  const prisma = {
    $queryRaw: jest.fn((q: Prisma.Sql) => {
      lastSql = q;
      return Promise.resolve(rows);
    }),
  } as unknown as PrismaService;

  return {
    service: new OpenItemsService(prisma),
    sql: () => (lastSql as unknown as Prisma.Sql).sql,
    params: () => (lastSql as unknown as Prisma.Sql).values,
  };
}

/** SQL bez viška belina — da poređenje ne zavisi od preloma reda. */
function squash(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("OpenItemsService — devizni filter", () => {
  it("BEZ fxCurrency: upit je nepromenjen (MAX po celoj grupi, bez uslova valute)", async () => {
    const h = makeService();
    await h.service.listOpenItems();

    const sql = squash(h.sql());
    expect(sql).toContain(
      "COALESCE(SUM(le.fx_debit), 0) - COALESCE(SUM(le.fx_credit), 0) AS fx_balance",
    );
    expect(sql).toContain("MAX(le.fx_currency) AS fx_currency");
    expect(sql).not.toContain("bool_or");
  });

  it("SA fxCurrency: grupa mora da SADRŽI valutu i da NE sadrži nijednu drugu", async () => {
    const h = makeService();
    await h.service.listOpenItems(undefined, undefined, new Date(), {
      fxCurrency: "EUR",
    });

    const sql = squash(h.sql());
    // Stari (pogrešan) oblik ne sme da se vrati.
    expect(sql).not.toContain("MAX(le.fx_currency) = ");
    expect(sql).toContain("bool_or(le.fx_currency = ");
    expect(sql).toContain(
      "NOT bool_or(le.fx_currency IS NOT NULL AND le.fx_currency <> ",
    );
    expect(h.params()).toContain("EUR");
  });

  it("SA fxCurrency: devizni saldo se sabira SAMO preko redova te valute", async () => {
    const h = makeService();
    await h.service.listOpenItems(undefined, undefined, new Date(), {
      fxCurrency: "USD",
    });

    const sql = squash(h.sql());
    expect(sql).toContain("SUM(CASE WHEN le.fx_currency = ");
    expect(sql).toContain("THEN le.fx_debit END)");
    expect(sql).toContain("THEN le.fx_credit END)");
    // Nefiltrirani zbir bi pokupio i druge valute (fx 2000 iz 1000 EUR + 1000 USD).
    expect(sql).not.toContain("COALESCE(SUM(le.fx_debit), 0)");
  });

  it("listMixedFxCurrencyGroups traži grupe sa više od jedne valute", async () => {
    const h = makeService([
      {
        account_code: "2040",
        analytical_code: 100,
        document_number: null,
        balance: new Prisma.Decimal(234000),
        currencies: ["USD", "EUR"],
        ledger_entry_ids: [1, 2],
      },
    ]);

    const rows = await h.service.listMixedFxCurrencyGroups(new Date(), {
      fxCurrency: "EUR",
    });

    const sql = squash(h.sql());
    expect(sql).toContain("COUNT(DISTINCT le.fx_currency) > 1");
    // Isti presek/status uslovi kao listOpenItems — inače bi se prijavljivale
    // grupe koje uopšte nisu u obračunu.
    expect(sql).toContain("je.status IN ('POSTED', 'LOCKED')");
    expect(sql).toContain("je.posting_date <=");
    expect(sql).toContain("sa.tracks_open_items = TRUE");
    // Sužavanje na valutu obračuna.
    expect(sql).toContain("bool_or(le.fx_currency = ");

    expect(rows).toHaveLength(1);
    expect(rows[0].currencies).toEqual(["EUR", "USD"]); // sortirano
    expect(rows[0].balance.toFixed(2)).toBe("234000.00");
  });

  it("agingByPartner ostaje netaknut deviznim filterom", async () => {
    const h = makeService();
    await h.service.agingByPartner();

    const sql = squash(h.sql());
    expect(sql).not.toContain("fx_currency");
    expect(sql).toContain("bucket_0_30");
  });
});

/**
 * PRESEK NA DAN — ISTI SKUP U OBA IZVEŠTAJA (nalaz N2, 03.08.2026).
 * ============================================================================
 * `listOpenItems` je gradio `je.posting_date <= $1` I `(le.reconciled_at IS NULL OR
 * le.reconciled_at > $2)`, a `agingByPartner` samo `le.reconciled_at IS NULL`, bez
 * ijednog uslova nad `posting_date` — pa je isti kupac na isti dan imao dva različita
 * duga u dva izveštaja (kartica/IOS/opomena vs. starosna struktura/tabla naplate).
 * Ovi testovi zaključavaju da su uslovi preseka DOSLOVNO isti u oba upita.
 */
describe("OpenItemsService — presek na dan (aging = otvorene stavke)", () => {
  const AS_OF = new Date("2026-06-30T00:00:00.000Z");

  it("agingByPartner gleda posting_date i uparivanje NA DAN preseka", async () => {
    const h = makeService();
    await h.service.agingByPartner(undefined, AS_OF);

    const sql = squash(h.sql());
    expect(sql).toContain("je.posting_date <=");
    expect(sql).toContain("(le.reconciled_at IS NULL OR le.reconciled_at >");
    // Stari (asimetričan) oblik ne sme da se vrati.
    expect(sql).not.toContain("AND le.reconciled_at IS NULL AND");
  });

  it("presek ulazi kao PARAMETAR na sva tri mesta (days_overdue + dva uslova)", async () => {
    const h = makeService();
    await h.service.agingByPartner(undefined, AS_OF);

    // Ranije je `cutoff` bio parametar samo u `days_overdue` — jedna vrednost.
    expect(h.params().filter((p) => p === AS_OF)).toHaveLength(3);
  });

  it("oba upita nose ISTI par uslova preseka", async () => {
    const open = makeService();
    await open.service.listOpenItems(undefined, undefined, AS_OF);
    const openSql = squash(open.sql());

    const aging = makeService();
    await aging.service.agingByPartner(undefined, AS_OF);
    const agingSql = squash(aging.sql());

    for (const clause of [
      "je.status IN ('POSTED', 'LOCKED')",
      "je.posting_date <=",
      "(le.reconciled_at IS NULL OR le.reconciled_at >",
      "sa.tracks_open_items = TRUE",
    ]) {
      expect(openSql).toContain(clause);
      expect(agingSql).toContain(clause);
    }
  });
});
