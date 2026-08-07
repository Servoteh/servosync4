/**
 * OPIS REDA NALOGA — jedno pravilo za obe grane knjiženja.
 * =============================================================================
 * POVOD (knjigovođa, 06.08.2026, doslovno): „u opis sami ručno upisujemo obično broj RN
 * za koji je izlazna faktura vezana". Do 07.08.2026. je opis dolazio ISKLJUČIVO iz šeme
 * kontiranja, a tamo je na produkciji 76 od 78 linija prazno (jedina popunjena među
 * upaljenim vrstama je `IFGP`/`2040` = doslovno `"0"`).
 *
 * ⚠️ ŠTA JE MERENJE OBORILO: „broj RN" iz zahteva NIJE ident radnog naloga. Nad uvezenom
 * BigBit knjigom 2026 (`IFR`/`IFGP`/`IZVRO`/`IZVGP`, 118 različitih opisa) poklapanje sa
 * `work_orders.ident_number` je **0/118**, a sa `projects.project_number` **106/118**.
 * Zato je predmet jedini broj koji ovde sme da uđe, i to samo kad ga dokument stvarno nosi.
 *
 * Testovi ovde su nad ČISTOM funkcijom (bez baze) — obe grane knjiženja je zovu, pa jedan
 * skup tvrdnji drži oba puta.
 */
import {
  clipLedgerDescription,
  LEDGER_DESCRIPTION_MAX,
  ledgerDescription,
} from "./ledger-line";

describe("ledgerDescription — opis reda naloga", () => {
  it("vrsta + broj + naziv komitenta (izlazna faktura bez predmeta)", () => {
    expect(
      ledgerDescription({
        documentTypeCode: "IFR",
        documentNumber: "243/26",
        partnerName: "FMB d.o.o.",
      }),
    ).toBe("IFR 243/26 · FMB d.o.o.");
  });

  it("predmet ulazi u opis kad ga dokument nosi — obrazac koji je BigBit kucao rukom", () => {
    expect(
      ledgerDescription({
        documentTypeCode: "IFR",
        documentNumber: "243/26",
        projectNumber: "9997",
        partnerName: "FMB d.o.o.",
      }),
    ).toBe("IFR 243/26 · predmet 9997 · FMB d.o.o.");
  });

  it("bez komitenta i bez predmeta (popis) opis NIJE prazan", () => {
    expect(
      ledgerDescription({ documentTypeCode: "VISAR", documentNumber: "12/26" }),
    ).toBe("VISAR 12/26");
  });

  it("prazan/space-only podatak se ne pretvara u razdvajač koji visi", () => {
    expect(
      ledgerDescription({
        documentTypeCode: "IFGP",
        documentNumber: "5/26",
        projectNumber: "   ",
        partnerName: "",
      }),
    ).toBe("IFGP 5/26");
  });

  it("beline oko podataka se skidaju (BigBit ume da isporuči broj sa razmacima)", () => {
    expect(
      ledgerDescription({
        documentTypeCode: " IFR ",
        documentNumber: " 243/26 ",
        projectNumber: " 9997 ",
        partnerName: "  FMB d.o.o.  ",
      }),
    ).toBe("IFR 243/26 · predmet 9997 · FMB d.o.o.");
  });

  it("🔴 opis nikad ne prelazi 255 znakova — kolona je VarChar(255)", () => {
    // Naziv komitenta je i sam VarChar(255): bez sečenja bi upis pao na 22001 i oborio
    // CELU transakciju knjiženja (dokument ostaje nezaključan, bez ijedne poruke o uzroku).
    const opis = ledgerDescription({
      documentTypeCode: "IFR",
      documentNumber: "243/26",
      projectNumber: "9997",
      partnerName: "K".repeat(255),
    });

    expect(opis.length).toBe(LEDGER_DESCRIPTION_MAX);
    expect(opis.endsWith("…")).toBe(true);
    // Glava opisa (vrsta, broj, predmet) preživljava sečenje — gubi se samo naziv.
    expect(opis.startsWith("IFR 243/26 · predmet 9997 · ")).toBe(true);
  });
});

describe("clipLedgerDescription — brana nad kolonom", () => {
  it("kraći tekst prolazi nepromenjen", () => {
    expect(clipLedgerDescription("IFR 243/26")).toBe("IFR 243/26");
  });

  it("tekst tačno na granici se ne dira", () => {
    const naGranici = "A".repeat(LEDGER_DESCRIPTION_MAX);
    expect(clipLedgerDescription(naGranici)).toBe(naGranici);
  });

  it("🔴 storno prefiks ne sme da prebaci kolonu", () => {
    // `GlWriteService.reverse` piše `STORNO: ${opis}`. Sa punim opisom od 255 znakova to je
    // 263 → upis pada, a storno je jedini način da se pogrešan nalog povuče.
    const pun = "X".repeat(LEDGER_DESCRIPTION_MAX);
    expect(clipLedgerDescription(`STORNO: ${pun}`).length).toBe(
      LEDGER_DESCRIPTION_MAX,
    );
  });
});
