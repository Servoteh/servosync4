import { Prisma } from "@prisma/client";
import {
  assertTotalsMatchItems,
  buildSalesLedgerLines,
} from "./fakturisanje.service";
import {
  isServiceDocument,
  paperNoteOf,
  type ServiceRevenueTypeRef,
  taxTreatmentOf,
} from "./service-revenue-type";
import { documentVatTotals, vatCategoryOf } from "./vat-totals";
import { exemptionCaseFor, exemptionFor } from "./vat-exemption";

/**
 * ŠIFARNIK VRSTA USLUGE — KONTO PRIHODA I PORESKI TRETMAN (05.08.2026).
 * =============================================================================
 *
 * Test-vektori NISU izmišljeni: svaki broj ispod je prepisan iz uvezene glavne knjige
 * za 2026 (`ledger_entries`, izmereno 05.08.2026). Ako neki od ovih testova padne,
 * znači da bi se sistem razišao sa onim što je knjigovođa stvarno proknjižio.
 *
 *   6140  Prihodi od prodaje usluga na domaćem tržištu    45 stavki  18.273.557,50
 *   6151  Prihodi od prodaje usluga na inostranom tržištu  2 stavke   2.490.465,79
 *   6796  Naknadno utvrđeni vanr. prih. OTPAD             10 stavki   1.222.645,05
 *   6501  Prihodi od zakupa poslovnog prostora             0 stavki           —
 *
 * NAJVAŽNIJI VEKTOR je nalog `236` (IFUSL, 18.02.2026), koji drži TRI zasebna
 * dokumenta i sam po sebi dokazuje oba pravila ovog šifarnika:
 *
 *   042/26   2040 DUG 123.552,00 / 6796 POT 123.552,00              ← otpad, BEZ PDV-a
 *   043/26   2040 DUG  53.520,00 / 4703 POT  8.920,00 / 6140 POT 44.600,00
 *   044/26   2040 DUG  76.560,00 / 4703 POT 12.760,00 / 6140 POT 63.800,00
 *
 * Prvo: kod otpada kupčev DUG je TAČNO jednak prihodu — nema nijednog reda na kontima
 * izlaznog PDV-a (izmereno nad svih 10 dokumenata sa kontom 6796: `47xx` = prazno).
 * Drugo: različite vrste stoje na RAZLIČITIM dokumentima, pa je vrsta usluge svojstvo
 * zaglavlja (izmereno: 57 od 57 dokumenata nosi tačno jedno konto prihoda).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Redovi šifarnika — seed migracije `20260805190000_sifarnik_vrsta_usluge`. */
const USL: ServiceRevenueTypeRef = {
  code: "USL",
  revenueAccountCode: "6140",
  vatTreatment: "TAXED",
  paperNote: null,
};
const USL_INO: ServiceRevenueTypeRef = {
  code: "USL-INO",
  revenueAccountCode: "6151",
  vatTreatment: "OUTSIDE_SCOPE",
  paperNote:
    "PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u " +
    "(mesto prometa usluge je van teritorije Republike Srbije)",
};
const OTPAD: ServiceRevenueTypeRef = {
  code: "OTPAD",
  revenueAccountCode: "6796",
  vatTreatment: "REVERSE_CHARGE",
  paperNote:
    "PDV nije obračunat — poreski dužnik je primalac dobara, član 10. stav 2. " +
    "tačka 1. Zakona o PDV-u",
};
const ZAKUP: ServiceRevenueTypeRef = {
  code: "ZAKUP",
  revenueAccountCode: "6501",
  vatTreatment: "TAXED",
  paperNote: null,
};

function invoice(over: Record<string, unknown> = {}) {
  return {
    documentType: "IFUSL",
    documentNumber: "042/26",
    customerId: 10,
    isExport: false,
    serviceRevenueType: null as ServiceRevenueTypeRef | null,
    ...over,
  };
}

/** Konto → (dug, pot) iz naloga — jedan pogled za sve tvrdnje ispod. */
function byAccount(lines: ReturnType<typeof buildSalesLedgerLines>) {
  const map = new Map<string, { debit: string; credit: string }>();
  for (const l of lines) {
    map.set(l.accountCode, {
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("taxTreatmentOf — vrsta dokumenta i šifarnik idu ZAJEDNO", () => {
  it("uslužni račun sa vrstom OTPAD → REVERSE_CHARGE", () => {
    expect(
      taxTreatmentOf({ documentType: "IFUSL", serviceRevenueType: OTPAD }),
    ).toBe("REVERSE_CHARGE");
  });

  it("uslužni račun bez izabrane vrste → TAXED (zatečeno ponašanje)", () => {
    expect(
      taxTreatmentOf({ documentType: "IFUSL", serviceRevenueType: null }),
    ).toBe("TAXED");
  });

  /**
   * ⚠️ NAJVAŽNIJA BRANA OVOG MODULA. Vrsta usluge se sme uneti i na predračun, a
   * predračun se prepisuje u SEDAM ciljnih vrsta od kojih su samo dve uslužne. Bez
   * ovog uslova bi `PROF` sa vrstom „otpad", prepisan u `IFR`, dao robnu fakturu bez
   * PDV-a a sa prihodom na robnom kontu `6040` — kombinacija koja ne postoji ni u
   * jednom propisu, a nalog bi svejedno balansirao pa je nijedna kontrola ne bi videla.
   */
  it("ROBNA faktura ne uzima poreski tretman ni kad vrsta usluge stoji u zaglavlju", () => {
    expect(
      taxTreatmentOf({ documentType: "IFR", serviceRevenueType: OTPAD }),
    ).toBe("TAXED");
  });

  it("nepoznat tretman iz baze se ODBIJA, ne svodi tiho na TAXED", () => {
    expect(() =>
      taxTreatmentOf({
        documentType: "IFUSL",
        serviceRevenueType: { ...OTPAD, vatTreatment: "reverse-charge" },
      }),
    ).toThrow(/nepoznat poreski tretman/i);
  });

  it("isServiceDocument prepoznaje obe uslužne vrste, normalizovano", () => {
    expect(isServiceDocument("ifusl")).toBe(true);
    expect(isServiceDocument(" IZVUS ")).toBe(true);
    expect(isServiceDocument("IFR")).toBe(false);
    expect(isServiceDocument(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("buildSalesLedgerLines — konto prihoda dolazi iz šifarnika", () => {
  /**
   * Dokument `042/26` iz naloga 236, doslovno: 2040 DUG 123.552,00 / 6796 POT
   * 123.552,00 i NIJEDAN red izlaznog PDV-a. Stavka namerno nosi domaću poresku šifru
   * „3" (20 %) — baš tako je i u bazi, jer cenovnik o vrsti usluge ne zna ništa.
   * Do 05.08.2026. je ovaj nalog izlazio kao 2040 DUG 148.262,40 / 6140 POT 123.552,00
   * / 4703 POT 24.710,40: tuđe konto prihoda I porez koji po zakonu obračunava kupac.
   */
  it("OTPAD: prihod na 6796, kupac duguje osnovicu, BEZ ijednog reda PDV-a", () => {
    const lines = buildSalesLedgerLines(
      invoice({ serviceRevenueType: OTPAD }),
      [{ vatRateCode: "3", vatBase: D("123552.00") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6796"]);
    const acc = byAccount(lines);
    expect(acc.get("2040")?.debit).toBe("123552.00");
    expect(acc.get("6796")?.credit).toBe("123552.00");
    // Nijedno konto izlaznog PDV-a — poreski dužnik je primalac (čl. 10 st. 2 t. 1).
    expect(lines.some((l) => l.accountCode.startsWith("47"))).toBe(false);
  });

  /**
   * Dokument `043/26` iz istog naloga: 2040 DUG 53.520,00 / 4703 POT 8.920,00 /
   * 6140 POT 44.600,00. Ovo je vektor koji dokazuje da se ništa nije pokvarilo —
   * domaća usluga i dalje ide potpuno isto.
   */
  it("USL: prihod 6140 + PDV 4703 — nepromenjeno u odnosu na zatečeno", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentNumber: "043/26", serviceRevenueType: USL }),
      [{ vatRateCode: "3", vatBase: D("44600.00") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140", "4703"]);
    const acc = byAccount(lines);
    expect(acc.get("2040")?.debit).toBe("53520.00");
    expect(acc.get("6140")?.credit).toBe("44600.00");
    expect(acc.get("4703")?.credit).toBe("8920.00");
  });

  /**
   * Zakup: konto 6501 postoji u kontnom planu i zove se baš „Prihodi od zakupa
   * poslovnog prostora", ali u 2026. nema promet (izmereno 0 stavki). Vrsta postoji na
   * papiru `IFUSL 653/25` — „Zakup poslovnog prostora za Decembar 2025", 16.000,00 +
   * 20 % = 19.200,00. Vlasnik je uz 6501 rekao „to može posle da se promeni", pa je
   * konto podatak u šifarniku, a ne konstanta u kodu.
   */
  it("ZAKUP: prihod 6501 uz PDV na 4703 (papir IFUSL 653/25)", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentNumber: "653/25", serviceRevenueType: ZAKUP }),
      [{ vatRateCode: "3", vatBase: D("16000.00") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6501", "4703"]);
    const acc = byAccount(lines);
    expect(acc.get("2040")?.debit).toBe("19200.00");
    expect(acc.get("6501")?.credit).toBe("16000.00");
    expect(acc.get("4703")?.credit).toBe("3200.00");
  });

  /**
   * Usluga stranom kupcu na DOMAĆEM uslužnom računu (`IFUSL`, `isExport = false`):
   * PDV se ne obračunava zato što mesto prometa nije u Srbiji (čl. 12 st. 3), a ne
   * zato što je dokument izvozni. Kupac je i dalje na kontu `2040`, ne `2050` — i to
   * je razlika koju stari kod nije mogao da izrazi.
   */
  it("USL-INO: prihod 6151, bez PDV-a, kupac i dalje na 2040", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentNumber: "016/26", serviceRevenueType: USL_INO }),
      [{ vatRateCode: "3", vatBase: D("1254309.49") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6151"]);
    const acc = byAccount(lines);
    expect(acc.get("2040")?.debit).toBe("1254309.49");
    expect(acc.get("6151")?.credit).toBe("1254309.49");
  });

  it("IZVUS + USL-INO: izvozni uslužni račun ide na kupca 2050, prihod 6151", () => {
    const lines = buildSalesLedgerLines(
      invoice({
        documentType: "IZVUS",
        documentNumber: "060/26",
        isExport: true,
        serviceRevenueType: USL_INO,
      }),
      [{ vatRateCode: "3", vatBase: D("1236156.30") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2050", "6151"]);
    expect(byAccount(lines).get("6151")?.credit).toBe("1236156.30");
  });

  it("uslužni račun BEZ izabrane vrste ostaje na 6140 (45 od 57 izmerenih stavki)", () => {
    const lines = buildSalesLedgerLines(invoice(), [
      { vatRateCode: "3", vatBase: D("44600.00") },
    ]);
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140", "4703"]);
  });

  it("ROBNA faktura sa greškom unetom vrstom usluge i dalje ide na 6040 sa PDV-om", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentType: "IFR", serviceRevenueType: OTPAD }),
      [{ vatRateCode: "3", vatBase: D("100000.00") }],
    );

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6040", "4702"]);
    expect(byAccount(lines).get("4702")?.credit).toBe("20000.00");
  });

  it("nalog balansira i kod otpada (ΣDUG = ΣPOT)", () => {
    const lines = buildSalesLedgerLines(
      invoice({ serviceRevenueType: OTPAD }),
      [
        { vatRateCode: "3", vatBase: D("85734.00") },
        { vatRateCode: "4", vatBase: D("72661.05") },
      ],
    );
    const debit = lines.reduce((s, l) => s.add(l.debit), D(0));
    const credit = lines.reduce((s, l) => s.add(l.credit), D(0));
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
    expect(debit.toFixed(2)).toBe("158395.05");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("documentVatTotals — tretman obara stopu i menja KATEGORIJU", () => {
  const items = [{ vatRateCode: "3", vatBase: D("123552.00") }];

  it("REVERSE_CHARGE: 0 % poreza, kategorija AE (ne E)", () => {
    const totals = documentVatTotals(items, {
      taxTreatment: "REVERSE_CHARGE",
    });
    expect(totals.vatTotal.toFixed(2)).toBe("0.00");
    expect(totals.grossTotal.toFixed(2)).toBe("123552.00");
    expect(totals.groups).toHaveLength(1);
    expect(totals.groups[0].category).toBe("AE");
    expect(totals.groups[0].ratePercent.toFixed(2)).toBe("0.00");
  });

  it("OUTSIDE_SCOPE: 0 % poreza, kategorija O", () => {
    const totals = documentVatTotals(items, { taxTreatment: "OUTSIDE_SCOPE" });
    expect(totals.vatTotal.toFixed(2)).toBe("0.00");
    expect(totals.groups[0].category).toBe("O");
  });

  it("TAXED (podrazumevano) i dalje obračunava 20 %", () => {
    const totals = documentVatTotals(items);
    expect(totals.vatTotal.toFixed(2)).toBe("24710.40");
    expect(totals.groups[0].category).toBe("S");
  });

  /**
   * Kategorija `E` znači „promet OSLOBOĐEN PDV-a", a `AE` „promet je oporeziv, ali ga
   * oporezuje kupac". To su dve različite pravne tvrdnje na poreskom dokumentu — kupac
   * koji dobije `E` nema iz čega da zna da poresku obavezu ima on.
   */
  it("vatCategoryOf: reverse charge daje AE, a ne E", () => {
    expect(vatCategoryOf(D(0), false, "REVERSE_CHARGE")).toBe("AE");
    expect(vatCategoryOf(D(0), false, "OUTSIDE_SCOPE")).toBe("O");
    expect(vatCategoryOf(D(0), false, "TAXED")).toBe("E");
  });

  it("IZVOZ je jači od tretmana: kategorija ostaje Z (čl. 24)", () => {
    expect(vatCategoryOf(D(0), true, "REVERSE_CHARGE")).toBe("Z");
    expect(vatCategoryOf(D(0), true, "OUTSIDE_SCOPE")).toBe("Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("assertTotalsMatchItems — zaglavlje bez poreza je TAČNO kod otpada", () => {
  /**
   * Bez tretmana u ovoj brani bi račun za otpad bio NEKNJIŽIV: `recalcTotals` upiše
   * `vatTotal = 0` (jer zna za vrstu usluge), a brana bi iz istih stavki izvela
   * 24.710,40 i odbila knjiženje sa porukom da se zaglavlje i stavke ne slažu.
   */
  it("OTPAD: zaglavlje 123.552,00 bez poreza prolazi", () => {
    expect(() =>
      assertTotalsMatchItems({
        documentType: "IFUSL",
        documentNumber: "042/26",
        isExport: false,
        netTotal: D("123552.00"),
        vatTotal: D("0.00"),
        grossTotal: D("123552.00"),
        serviceRevenueType: OTPAD,
        items: [{ vatRateCode: "3", vatBase: D("123552.00") }],
      }),
    ).not.toThrow();
  });

  it("OTPAD sa zatečenim porezom u zaglavlju se ODBIJA", () => {
    expect(() =>
      assertTotalsMatchItems({
        documentType: "IFUSL",
        documentNumber: "042/26",
        isExport: false,
        netTotal: D("123552.00"),
        vatTotal: D("24710.40"),
        grossTotal: D("148262.40"),
        serviceRevenueType: OTPAD,
        items: [{ vatRateCode: "3", vatBase: D("123552.00") }],
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("vat-exemption — poreska napomena prati TRETMAN, ne nulu u zaglavlju", () => {
  /**
   * Faktura za otpad i faktura oslobođena po nekom drugom osnovu imaju isti `vatTotal`
   * (nula), a na papiru moraju da nose različitu — i pravno različitu — rečenicu.
   * Dok je jedini ulaz bio `vatTotalIsZero`, obe su izlazile kao „domestic-exempt".
   */
  it("REVERSE_CHARGE → slučaj `domestic-reverse-charge`, ne `domestic-exempt`", () => {
    expect(
      exemptionCaseFor({
        isExport: false,
        isService: true,
        vatTotalIsZero: true,
        taxTreatment: "REVERSE_CHARGE",
      }),
    ).toBe("domestic-reverse-charge");
  });

  it("OUTSIDE_SCOPE → slučaj `outside-scope-service` i kad je dokument izvozni", () => {
    expect(
      exemptionCaseFor({
        isExport: true,
        isService: true,
        vatTotalIsZero: true,
        taxTreatment: "OUTSIDE_SCOPE",
      }),
    ).toBe("outside-scope-service");
  });

  it("bez tretmana ponašanje ostaje zatečeno", () => {
    expect(
      exemptionCaseFor({
        isExport: false,
        isService: true,
        vatTotalIsZero: true,
      }),
    ).toBe("domestic-exempt");
    expect(
      exemptionCaseFor({
        isExport: true,
        isService: true,
        vatTotalIsZero: true,
      }),
    ).toBe("export-service");
  });

  it("oba nova slučaja imaju osnov i za papir i za SEF (BR-E-10 traži razlog)", () => {
    const rc = exemptionFor("domestic-reverse-charge");
    expect(rc?.paperText).toMatch(/poreski dužnik je primalac/i);
    expect(rc?.sefReason).toBeTruthy();

    const os = exemptionFor("outside-scope-service");
    expect(os?.paperText).toMatch(/članom 12\. stav 3/i);
    expect(os?.sefReason).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("paperNoteOf — napomena sa vrste usluge", () => {
  it("uslužni račun uzima napomenu iz šifarnika", () => {
    expect(
      paperNoteOf({ documentType: "IFUSL", serviceRevenueType: OTPAD }),
    ).toBe(OTPAD.paperNote);
  });

  it("vrsta bez napomene (USL, ZAKUP) → null, pa obrazac pada na zatečeni tekst", () => {
    expect(paperNoteOf({ documentType: "IFUSL", serviceRevenueType: USL })).toBe(
      null,
    );
  });

  it("prazna napomena se svodi na null — nikad prazan red na poreskom dokumentu", () => {
    expect(
      paperNoteOf({
        documentType: "IFUSL",
        serviceRevenueType: { ...OTPAD, paperNote: "   " },
      }),
    ).toBe(null);
  });

  it("robna faktura ne uzima napomenu ni kad vrsta stoji u zaglavlju", () => {
    expect(
      paperNoteOf({ documentType: "IFR", serviceRevenueType: OTPAD }),
    ).toBe(null);
  });
});
