import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { describeEmptyBody } from "./empty-body";
import { UpdateCompanyDetailsDto } from "./dto/podesavanja-company-details.dto";
import { UpdatePaymentAccountDto } from "./dto/podesavanja-payment-account.dto";

/**
 * „Nijedno polje nije prosleđeno." — greška koju je vlasnik dobio 05.08.2026, a čiji se
 * uzrok iz koda NIJE mogao videti. Ovaj spec pinuje DVE stvari:
 *
 *   1. da je izvor dijagnostike valjan — `ValidationPipe({ whitelist: true })` NE MENJA
 *      objekat koji mu je predat, pa `req.body` i posle validacije nosi ono što je
 *      klijent zaista poslao. Bez toga bi dijagnostika opisivala već očišćeno telo i
 *      ćutala o odbačenim poljima, tj. bila bi bezvredna;
 *   2. da poruka razlikuje tri različita slučaja praznog tela i da ni u jednom ne izlazi
 *      VREDNOST polja (kroz ove rute idu PIB, matični broj i IBAN).
 */
describe("prazno telo — izvor dijagnostike (ValidationPipe ne dira req.body)", () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });

  it("whitelist odbacuje nepoznato polje, ali SIROVO telo ostaje netaknuto", async () => {
    // Baš scenario iz prijave: ekran pošalje polje koje ruta ne poznaje (staro izdanje
    // u pregledaču, preimenovano polje) → servis vidi `{}` i ne zna zašto.
    const raw: Record<string, unknown> = {
      nepoznatoPolje: "vrednost",
      drugoNepoznato: 1,
    };

    const out = (await pipe.transform(raw, {
      type: "body",
      metatype: UpdateCompanyDetailsDto,
    })) as Record<string, unknown>;

    // Ono što servis dobije kroz `@Body()` — očišćeno od nepoznatih polja.
    expect(Object.prototype.hasOwnProperty.call(out, "nepoznatoPolje")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, "drugoNepoznato")).toBe(false);
    /**
     * IZMERENO 05.08.2026 i zato pinovano: `plainToInstance` napravi SVA deklarisana
     * polja DTO-a kao sopstvene ključeve sa vrednošću `undefined` (20 ključeva za
     * `UpdateCompanyDetailsDto`). Zbog toga `Object.keys(dto).length` NIJE mera „telo je
     * prazno" — servis to prepoznaje samo po tome što posle `put()` nema ni jedno polje
     * za upis. Isto objašnjava zašto se iz DTO-a ne može pročitati šta je klijent poslao.
     */
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
    // …a ono što `@Req() req.body` nosi — NEOČIŠĆENO. Ovo je jedini prozor u uzrok.
    expect(Object.keys(raw).sort()).toEqual(["drugoNepoznato", "nepoznatoPolje"]);
  });

  it("prepoznato polje prolazi kroz istu cev (dijagnostika ne laže u drugom smeru)", async () => {
    const raw: Record<string, unknown> = { iban: "RS35160005010003501186", xyz: "a" };
    const out = (await pipe.transform(raw, {
      type: "body",
      metatype: UpdatePaymentAccountDto,
    })) as Record<string, unknown>;
    // Samo `iban` nosi vrednost; ostala deklarisana polja su `undefined` (v. gore).
    expect(Object.entries(out).filter(([, v]) => v !== undefined)).toEqual([
      ["iban", "RS35160005010003501186"],
    ]);
    expect(raw).toHaveProperty("xyz");
  });
});

describe("describeEmptyBody — poruka imenuje ŠTA je stiglo", () => {
  const ZNANA = ["companyName", "iban", "swift"] as const;
  const ŠTA = "podaci firme";

  it("prazno telo: kaže da je stiglo prazno i šalje na osvežavanje ekrana", () => {
    const d = describeEmptyBody({}, ZNANA, ŠTA);
    expect(d.message).toContain("stiglo prazno");
    expect(d.message).toContain("Ctrl+F5");
    expect(d.logDetail).toBe("telo prazno: {}");
  });

  it("sva polja odbačena: NABRAJA ih (inače su nevidljiva zbog whitelist-a)", () => {
    const d = describeEmptyBody({ naziv: "x", pib: "y" }, ZNANA, ŠTA);
    expect(d.message).toContain("ne poznaje nijedno od njih");
    expect(d.message).toContain('„naziv"');
    expect(d.message).toContain('„pib"');
    expect(d.logDetail).toContain("primljeno 2 polja: naziv, pib");
    expect(d.logDetail).toContain("ODBACIO whitelist 2: naziv, pib");
  });

  it("prepoznata polja bez vrednosti: to je treći, različit slučaj", () => {
    const d = describeEmptyBody({ iban: undefined, nepoznato: 1 }, ZNANA, ŠTA);
    expect(d.message).toContain("nije nosilo vrednost");
    expect(d.message).toContain('„nepoznato"');
    expect(d.logDetail).toContain("prepoznato 1: iban");
    expect(d.logDetail).toContain("ODBACIO whitelist 1: nepoznato");
  });

  it("telo nije objekat (niz / tekst / null) — i to se vidi, ne pada na 500", () => {
    expect(describeEmptyBody(null, ZNANA, ŠTA).logDetail).toBe("telo nije objekat: null");
    expect(describeEmptyBody([1, 2], ZNANA, ŠTA).logDetail).toBe("telo nije objekat: niz");
    expect(describeEmptyBody("tekst", ZNANA, ŠTA).logDetail).toBe(
      "telo nije objekat: string",
    );
  });

  it("poziv iz koda (bez HTTP zahteva) ne izmišlja dijagnostiku", () => {
    const d = describeEmptyBody(undefined, ZNANA, ŠTA);
    expect(d.message).toBe("Nijedno polje nije prosleđeno — podaci firme nije izmenjeno.");
    expect(d.logDetail).toContain("poziv iz koda");
  });

  /**
   * BRANA NA OSETLJIVOM PODATKU: u logu i u poruci smeju da stoje NAZIVI polja, nikad
   * vrednosti. PIB, matični broj i IBAN prolaze kroz ove rute; jednom zapisani u dnevnik
   * servera ostaju tamo van svake evidencije poslovnih podataka.
   */
  it("NIKAD ne ispisuje vrednost polja — ni u poruci ni u logu", () => {
    const d = describeEmptyBody(
      { taxId: "100001111", iban: "RS35160005010003501186", tajna: "lozinka123" },
      ZNANA,
      ŠTA,
    );
    for (const tekst of [d.message, d.logDetail]) {
      expect(tekst).not.toContain("100001111");
      expect(tekst).not.toContain("RS35160005010003501186");
      expect(tekst).not.toContain("lozinka123");
    }
    // …a nazivi polja MORAJU da se vide, inače dijagnostika ne služi ničemu.
    expect(d.logDetail).toContain("taxId");
    expect(d.logDetail).toContain("tajna");
  });
});
