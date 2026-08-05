import { Prisma } from "@prisma/client";
import { parseReference, SERIES_PREFIXES } from "./reference-parser.util";
import {
  DOCUMENT_SERIES,
  DocumentNumberSequenceService,
  seriesPrefixFor,
} from "../sales/numbering.service";

/**
 * FX_OdrediBrojDokumenta port — kandidati broja dokumenta iz poziva na broj.
 * Invarijanta koju svi slučajevi drže: prvi kandidat je UVEK sirov trim (egzaktan
 * pogodak ne sme da regresira). Ostali kandidati su BigBit-nivo fuzzy varijante.
 */
describe("reference-parser.util — parseReference", () => {
  it("sirov trim je uvek PRVI kandidat (egzaktan match očuvan)", () => {
    expect(parseReference("12345").candidates[0]).toBe("12345");
    expect(parseReference("  123-456  ").candidates[0]).toBe("123-456");
  });

  it("čist broj bez separatora → jedan kandidat (sirov)", () => {
    expect(parseReference("12345").candidates).toEqual(["12345"]);
  });

  it("model 97 INLINE (PNB počinje 97+KK) skida 97+kontrolni prefiks (4 znaka)", () => {
    const { candidates } = parseReference("9732001234");
    expect(candidates[0]).toBe("9732001234"); // egzaktan ostaje prvi
    expect(candidates).toContain("001234"); // skinut 97 + kontrolni broj
    expect(candidates).toContain("1234"); // + bez vodećih nula
  });

  it("model 97 RAZDVOJEN (FX kolona Model=97, PNB nosi KK+osnovu) → skinut 2-cifreni KK", () => {
    const { candidates } = parseReference("32001234", "97");
    expect(candidates[0]).toBe("32001234");
    expect(candidates).toContain("001234");
    expect(candidates).toContain("1234");
  });

  it("model 99 (bez kontrole) → NE skida ništa", () => {
    expect(parseReference("1234", "99").candidates).toEqual(["1234"]);
  });

  it("segmentacija po crticama → svaki segment + kombinacije susednih", () => {
    const { candidates } = parseReference("123-456");
    expect(candidates).toContain("123");
    expect(candidates).toContain("456");
    expect(candidates).toContain("123456"); // spojena susedna
  });

  it("FX separatori zagrade i obrnuta kosa crta → izolovan broj dokumenta", () => {
    // (1234)\5678 — legacy „(brojDok)\" obrazac
    const { candidates } = parseReference("(1234)\\5678");
    expect(candidates).toContain("1234");
    expect(candidates).toContain("5678");
  });

  it("kose crte → segmenti", () => {
    const { candidates } = parseReference("123/456");
    expect(candidates).toContain("123");
    expect(candidates).toContain("456");
  });

  it("varijante bez vodećih nula", () => {
    const { candidates } = parseReference("00123");
    expect(candidates[0]).toBe("00123");
    expect(candidates).toContain("123");
  });

  it("broj/godina (kosa crta) → goli broj kao kandidat", () => {
    const { candidates } = parseReference("123/2026");
    expect(candidates[0]).toBe("123/2026");
    expect(candidates).toContain("123");
  });

  it("broj-godina (crtica) → normalizovan broj/godina i goli broj", () => {
    const { candidates } = parseReference("123-2026");
    expect(candidates[0]).toBe("123-2026");
    expect(candidates).toContain("123/2026");
    expect(candidates).toContain("123");
  });

  it("broj-DVOCIFRENA godina (novi format O-F1) → normalizovan broj/GG", () => {
    // Uplata na naš račun `657/25`: kupac u PNB kuca „657-25" ili „657/25".
    const { candidates } = parseReference("657-25");
    expect(candidates[0]).toBe("657-25");
    expect(candidates).toContain("657/25");
    expect(candidates).toContain("657");
  });

  it("četvorocifrena godina daje i skraćeni oblik broja (123/2026 → 123/26)", () => {
    // Kupac kuca punu godinu, a naš dokument je u obliku `123/26` — mora se naći.
    const { candidates } = parseReference("123-2026");
    expect(candidates).toContain("123/2026");
    expect(candidates).toContain("123/26");
    expect(candidates[0]).toBe("123-2026"); // egzaktan ostaje prvi
  });

  it("model 97 + broj/GG → skinut kontrolni broj pa rekonstruisan broj/GG", () => {
    const { candidates } = parseReference("97 12 657 25");
    expect(candidates[0]).toBe("97 12 657 25");
    expect(candidates).toContain("657/25");
  });

  it("kombinacije susednih segmenata (3 segmenta)", () => {
    const { candidates } = parseReference("12 34 56");
    expect(candidates).toContain("1234"); // susedni 12+34
    expect(candidates).toContain("3456"); // susedni 34+56
    expect(candidates).toContain("123456"); // sva tri
  });

  it("prazan / null / samo razmaci → nema kandidata", () => {
    expect(parseReference("").candidates).toEqual([]);
    expect(parseReference(null).candidates).toEqual([]);
    expect(parseReference(undefined).candidates).toEqual([]);
    expect(parseReference("     ").candidates).toEqual([]);
  });

  it("predugačak PNB bez separatora → nijedan kandidat (documentNumber je VarChar(30))", () => {
    expect(parseReference("1".repeat(45)).candidates).toEqual([]);
  });

  it("bez duplikata i uz očuvan prioritet (prvi = sirov)", () => {
    const { candidates } = parseReference("123-456");
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe("123-456");
  });

  /**
   * PNB KOJI JE DATUM — česta pojava kad platilac nema broj fakture pri ruci.
   * Kvar: od `12-08-26` parser je pravio „broj/godina" `08/26`, pa i `8/26` bez
   * vodeće nule — a to je od odluke O-F1 oblik NAŠIH brojeva, pa je uplata sletala
   * na tuđu fakturu 8/26. Ranije nemoguće: broj je nosio slovni prefiks.
   */
  describe("poziv na broj koji je DATUM ne sme da dâ broj fakture", () => {
    it("SCENARIO 12-08-26 → nema ni 08/26 ni 8/26 (samo sirov trim)", () => {
      const { candidates } = parseReference("12-08-26");

      expect(candidates).toEqual(["12-08-26"]); // egzaktan ostaje, izvedenih nema
      expect(candidates).not.toContain("8/26");
      expect(candidates).not.toContain("08/26");
      // Ni goli komadi datuma ne smeju da postanu kandidati.
      expect(candidates).not.toContain("08");
      expect(candidates).not.toContain("8");
      expect(candidates).not.toContain("26");
    });

    it("ostali zapisi datuma: tačke, kosa crta, puna godina, ISO", () => {
      for (const raw of [
        "12.08.26",
        "12/08/26",
        "12-08-2026",
        "12.8.2026",
        "2026-08-12",
        "31.12.2025",
      ]) {
        expect(parseReference(raw).candidates).toEqual([raw]);
      }
    });

    it("model ispred datuma (97 12-08-26) → i dalje bez izmišljenog 08/26", () => {
      const { candidates } = parseReference("97 12-08-26");
      expect(candidates[0]).toBe("97 12-08-26");
      expect(candidates).not.toContain("08/26");
      expect(candidates).not.toContain("8/26");
    });

    it("nemoguć datum NIJE datum (32-13-26 je i dalje običan PNB)", () => {
      const { candidates } = parseReference("32-13-26");
      expect(candidates).toContain("13/26"); // dan 32 / mesec 13 ne postoje
    });
  });

  describe("legitimni pozivi na broj se NE kvare datumskim pravilom", () => {
    it("657-25 i 657/25 i dalje daju 657/25", () => {
      expect(parseReference("657-25").candidates).toContain("657/25");
      expect(parseReference("657/25").candidates[0]).toBe("657/25");
      expect(parseReference("657/25").candidates).toContain("657");
    });

    it("model 97 + broj + godina (97 657 25) → 657/25", () => {
      const { candidates } = parseReference("97 657 25");
      expect(candidates[0]).toBe("97 657 25");
      expect(candidates).toContain("657/25");
    });

    it("model 97 razdvojen (Model=97, PNB 657-25) → 657/25", () => {
      const { candidates } = parseReference("657-25", "97");
      expect(candidates).toContain("657/25");
    });

    it("četvorocifreni PNB + godina (9712 657-25) nije datum", () => {
      const { candidates } = parseReference("9712 657-25");
      expect(candidates).toContain("657/25");
    });

    it("dan/mesec bez vodeće nule uz dvocifrenu godinu ostaje broj (11 5 26)", () => {
      // Realno je to model 11 + broj 5 + godina 26, ne 11. maj 2026 — datum ljudi
      // kucaju dopunjen (`11-05-26`). Pravilo je namerno usko.
      const { candidates } = parseReference("11 5 26");
      expect(candidates).toContain("5/26");
    });

    it("broj/puna godina (123-2026) i dalje daje 123/2026 i 123/26", () => {
      const { candidates } = parseReference("123-2026");
      expect(candidates).toContain("123/2026");
      expect(candidates).toContain("123/26");
    });
  });

  /**
   * PREFIKS SERIJE (`A-`, odluka O-F6) NE SME DA ISCURI.
   * ─────────────────────────────────────────────────────────────────────────────
   * Prefiks postoji zato što avansni račun i faktura završavaju na istom kupčevom
   * kontu, a otvorene stavke se grupišu samo po BROJU (`ledger_entries` nema vrstu).
   * Parser ga je na kraju skidao: `A-7/26` → i kandidat `7/26`, dakle broj KONAČNE
   * FAKTURE. Dok je avansna stavka otvorena, egzaktan kandidat je prvi i sve radi;
   * čim se avans zatvori, uplata pozvana na avans sedne na fakturu.
   */
  describe("poziv na broj sa prefiksom serije ne sme da dâ broj bez prefiksa", () => {
    it("SCENARIO A-7/26 → svi kandidati nose `A-`, nijedan nije goli 7/26", () => {
      const { candidates } = parseReference("A-7/26");

      expect(candidates[0]).toBe("A-7/26"); // egzaktan ostaje prvi
      expect(candidates).toEqual(["A-7/26", "A-7", "A-726", "A-26"]);
      // Broj konačne fakture i njegovi komadi ne smeju da postoje kao kandidati.
      expect(candidates).not.toContain("7/26");
      expect(candidates).not.toContain("7");
      expect(candidates).not.toContain("726");
      expect(candidates).not.toContain("26");
      // Ni goli prefiks (poklopio bi se sa bilo čim što tako počinje).
      expect(candidates).not.toContain("A");
    });

    it("PNB bez crtice ili sa razmakom i dalje pogađa upisani broj `A-7/26`", () => {
      // Numeracija upisuje `A-7/26`; kupac kuca kako mu dođe, pa se prefiks vraća u
      // KANONSKOM obliku. Bez ovoga bi legitimna avansna uplata izgubila i egzaktan pogodak.
      for (const raw of ["A7/26", "A 7/26", "a-7/26", "A/7/26"]) {
        const { candidates } = parseReference(raw);
        expect(candidates[0]).toBe(raw.trim());
        expect(candidates).toContain("A-7/26");
        expect(candidates).not.toContain("7/26");
      }
    });

    it("prefiks + puna godina (A-7/2026) daje i skraćeni oblik, sve sa prefiksom", () => {
      const { candidates } = parseReference("A-7/2026");
      expect(candidates).toContain("A-7/2026");
      expect(candidates).toContain("A-7/26");
      expect(candidates).not.toContain("7/2026");
      expect(candidates).not.toContain("7/26");
    });

    it("datumska brana važi i unutar serije (A-12-08-26 ne daje A-8/26 ni 8/26)", () => {
      const { candidates } = parseReference("A-12-08-26");
      expect(candidates).toEqual(["A-12-08-26"]);
      expect(candidates).not.toContain("A-8/26");
      expect(candidates).not.toContain("8/26");
    });

    it("slovo bez broja iza sebe NIJE serija (A, ABC123 se ne kljukaju prefiksom)", () => {
      expect(parseReference("ABC123").candidates).toEqual(["ABC123"]);
      expect(parseReference("A").candidates).toEqual(["A"]);
    });

    it("numerički PNB nije dotaknut pravilom (657-25, 97 657 25, 12-08-26)", () => {
      expect(parseReference("657-25").candidates).toContain("657/25");
      expect(parseReference("97 657 25").candidates).toContain("657/25");
      expect(parseReference("12-08-26").candidates).toEqual(["12-08-26"]);
      expect(parseReference("7/26").candidates).toContain("7/26");
    });

    /**
     * MODEL ISPRED SERIJE — ista rupa, jedan zapis dalje (treći krug pregleda 02.08.2026).
     * Brana je gledala samo POČETAK sirovog PNB-a, pa je bilo dovoljno da platilac ispred
     * serije otkuca model ili kontrolni broj da bi `7/26` (broj KONAČNE fakture) opet
     * iscurio. Izmereno na starom kodu: `97 A-7/26` → […,"7","726","26","7/26"].
     */
    it("SCENARIO 97 A-7/26 (model ispred serije) → nijedan kandidat bez `A-`", () => {
      const { candidates } = parseReference("97 A-7/26");

      expect(candidates[0]).toBe("97 A-7/26"); // egzaktan ostaje prvi
      expect(candidates).toEqual([
        "97 A-7/26",
        "A-7/26",
        "A-7",
        "A-726",
        "A-26",
      ]);
      expect(candidates).not.toContain("7/26");
      expect(candidates).not.toContain("7");
      expect(candidates).not.toContain("726");
      expect(candidates).not.toContain("26");
    });

    it("model + kontrolni broj ispred serije, u sva tri zapisa", () => {
      // Slepljeno („97124"), razdvojeno („97 12") i bez razmaka do serije — sve tri
      // varijante stižu iz banke, i nijedna ne sme da probije branu.
      for (const raw of [
        "97124 A-7/26",
        "97 12 A-7/26",
        "97A-7/26",
        "9712-A-7/26",
      ]) {
        const { candidates } = parseReference(raw);
        expect(candidates[0]).toBe(raw);
        expect(candidates).toContain("A-7/26");
        expect(candidates).not.toContain("7/26");
        expect(candidates).not.toContain("726");
      }
    });

    it("datumska brana važi i kad model gura seriju (97 A-12-08-26)", () => {
      const { candidates } = parseReference("97 A-12-08-26");
      expect(candidates).toEqual(["97 A-12-08-26", "A-12-08-26"]);
      expect(candidates).not.toContain("8/26");
      expect(candidates).not.toContain("A-8/26");
    });

    it("slovo koje NIJE serija ostaje netaknuto i iza modela (97 B-7/26 → 7/26)", () => {
      // Brana važi samo za serije iz numeracije; svako drugo slovo je i dalje običan
      // separator-šum, pa se `7/26` legitimno rekonstruiše.
      expect(parseReference("B-7/26").candidates).toContain("7/26");
      expect(parseReference("97 B-7/26").candidates).toContain("7/26");
    });

    it("svesno odstupanje ostaje: `A 657/25` ne daje goli broj fakture", () => {
      // Slovo „A" kao šum ispred broja fakture i dalje odvodi uparivanje na fallback
      // po iznosu — pošten promašaj je jeftiniji od zatvaranja pogrešne stavke.
      const { candidates } = parseReference("A 657/25");
      expect(candidates[0]).toBe("A 657/25");
      expect(candidates).toContain("A-657/25");
      expect(candidates).not.toContain("657/25");
    });

    it("čisto numerički PNB sa modelom nije dotaknut (97 657 25 i dalje daje 657/25)", () => {
      // Glava se odbacuje SAMO kad iza nje stoji oznaka serije; bez slova se ne menja ništa.
      expect(parseReference("97 657 25").candidates).toContain("657/25");
      expect(parseReference("9712 657-25").candidates).toContain("657/25");
      expect(parseReference("123-2026").candidates).toContain("123/2026");
      expect(parseReference("12-08-26").candidates).toEqual(["12-08-26"]);
    });

    it("prefiks serije je isti kao u numeraciji (jedna istina za AVR)", () => {
      // Kad bi se razišli, parser bi opet propuštao goli broj — i to tiho.
      expect(SERIES_PREFIXES).toContain(seriesPrefixFor("AVR"));
      expect(seriesPrefixFor("IFR")).toBe(""); // faktura nema seriju
    });
  });

  /**
   * OZNAKA SERIJE SE PREPOZNAJE PO ZNAČENJU, NE PO OBLIKU ŠUMA (nalaz N10, 02.08.2026).
   * ───────────────────────────────────────────────────────────────────────────────
   * Prethodna brana je tražila oznaku serije SAMO na dva mesta: na početku PNB-a i
   * odmah iza numeričke glave. Sve ostalo je propadalo u korak „broj/godina" i davalo
   * goli `N/GG` — broj KONAČNE FAKTURE istog kupca.
   *
   * IZMERENO na starom kodu (`parseReference(...).candidates`):
   *   `AVANS 1/26`              → […, "1/26", "1"]   ❌
   *   `AVR 1/26`                → […, "1/26", "1"]   ❌
   *   `A. 1/26`                 → […, "1/26", "1"]   ❌  (tačka nije separator, ali „A." nije ni serija)
   *   `A) 1/26`                 → […, "1/26", "1"]   ❌
   *   `po avansu A-1/26`        → […, "1/26", "1"]   ❌
   *
   * Posledica je ista kao u nalazu iz kog je O-F6 nastala: uplata pozvana na avansni
   * račun `A-1/26` sleti na otvorenu stavku fakture `1/26` i zatvori tuđu obavezu
   * (`bank-statement.service.matchOpenItem` bira PRVI kandidat koji ima pogodak).
   */
  describe("oznaka serije se prepoznaje po ZNAČENJU, ne po obliku šuma (N10)", () => {
    /**
     * [sirov PNB, goli broj koji NE SME da izađe, kanonski broj koji MORA da izađe]
     *
     * ⚠️ Svi primeri staju u 20 znakova — koliko nosi FX kolona `PozivNaBroj(169,20)`.
     * Raniji red „uplata po avansu A-1/26" (24 znaka) je bio obmanjujuć: takav PNB do
     * nas ne može ni da stigne kroz `bank-statement-parser.service.ts` (v. nalaz S7).
     */
    const REDOVI: Array<[string, string, string]> = [
      ["A-1/26", "1/26", "A-1/26"],
      ["97 A-7/26", "7/26", "A-7/26"],
      ["AVANS 1/26", "1/26", "A-1/26"],
      ["AVR 1/26", "1/26", "A-1/26"],
      ["A. 1/26", "1/26", "A-1/26"],
      ["A) 1/26", "1/26", "A-1/26"],
      ["po avansu A-1/26", "1/26", "A-1/26"],
    ];

    it.each(REDOVI)(
      "PNB %s ne daje goli %s, nego kanonski %s",
      (raw, goli, kanonski) => {
        const { candidates } = parseReference(raw);

        expect(candidates[0]).toBe(raw); // egzaktan pogodak ostaje prvi
        expect(candidates).toContain(kanonski);
        expect(candidates).not.toContain(goli);
        // Nijedan kandidat ne sme da bude bez prefiksa serije — ni komad broja
        // (`1`, `126`, `26`), jer i on može da bude broj tuđe fakture.
        for (const c of candidates.slice(1))
          expect(c.startsWith("A-")).toBe(true);
      },
    );

    /**
     * OBRNUTI SMER: `AVANS 1/26` (reč bez crtice) NAMERNO proizvodi `A-1/26`.
     *
     * ZAŠTO DA: naš avansni račun je u knjizi upisan tačno kao `A-1/26` (O-F6), a
     * kupac prepisuje ono što vidi na papiru ili opiše svojim rečima. Kandidat sa
     * prefiksom može da pogodi ISKLJUČIVO stavku iz avansne serije — nijedan drugi
     * dokument u glavnoj knjizi ne počinje sa `A-`. Dakle dodavanje kandidata ne
     * može da zatvori pogrešnu stavku; može samo da zatvori PRAVU.
     *
     * Rizik je asimetričan i zato je izbor lak: ako je kupac rečju „avans" mislio na
     * nešto drugo, uparivanje po broju promaši i uplata padne na fallback po iznosu
     * (pošten promašaj). Da smo umesto toga pustili goli `1/26`, promašaj bi bio
     * TIH i skup — zatvorena tuđa faktura, pogrešan saldo, kamata i IOS.
     */
    it("reč `AVANS`/`AVR` bez crtice i dalje pogađa upisani broj `A-1/26`", () => {
      for (const raw of [
        "AVANS 1/26",
        "avans 1/26",
        "AVR 1/26",
        "Avansu 1/26",
      ]) {
        expect(parseReference(raw).candidates).toContain("A-1/26");
      }
    });

    /**
     * OZNAKA VEZUJE BROJ KOJI JOJ NEPOSREDNO SLEDI — i to je cela brana od lažnog
     * pogotka. „Avans PO FAKTURI 1/26" znači avansna uplata na fakturu broj 1/26:
     * broj tu pripada FAKTURI, pa goli `1/26` mora da ostane kandidat. Da smo pravilo
     * napisali kao „reč avans bilo gde u PNB-u", ovaj legitiman PNB bi izgubio jedini
     * tačan kandidat i uplata bi pala na fallback po iznosu.
     */
    it("oznaka vezuje SLEDEĆI broj — `avans po fakturi 1/26` i dalje daje 1/26", () => {
      expect(parseReference("AVANS PO FAKTURI 1/26").candidates).toContain(
        "1/26",
      );
      expect(
        parseReference("avansno placanje po fakturi 657/25").candidates,
      ).toContain("657/25");
    });

    /**
     * SLOVO USRED REČI NIJE OZNAKA SERIJE. Bez ovog uslova bi `faktura 657/25` bilo
     * pročitano kao serija (poslednje „a" u „faktura" + razmak + cifra), pa bi broj
     * fakture nestao iz kandidata — kvar gori od onog koji se popravlja.
     */
    it("slovo unutar reči nije serija (faktura/računa + broj ostaju netaknuti)", () => {
      expect(parseReference("faktura 657/25").candidates).toContain("657/25");
      expect(parseReference("po racuna 657/25").candidates).toContain("657/25");
      expect(parseReference("PREMA 12/26").candidates).toContain("12/26");
    });

    /**
     * OSTALE SERIJE (O-F7): predračun, ponuda i revers od 02.08.2026. takođe nose
     * prefiks, pa i njihov PNB mora da prestane da proizvodi goli broj fakture.
     * Predračun je najčešći slučaj u praksi — po njemu kupac plaća unapred, a u
     * glavnoj knjizi predračuna NEMA, pa je goli `12/26` mogao da pogodi samo jedno:
     * tuđu fakturu.
     */
    it.each([
      ["PROF-12/26", "12/26", "PROF-12/26"],
      ["PREDRACUN 12/26", "12/26", "PROF-12/26"],
      ["po predracunu PROF-12/26", "12/26", "PROF-12/26"],
      ["PON-5/26", "5/26", "PON-5/26"],
      ["PONUDA 5/26", "5/26", "PON-5/26"],
      ["REV-8/26", "8/26", "REV-8/26"],
      ["REVERS 8/26", "8/26", "REV-8/26"],
    ])("PNB %s ne daje goli %s, nego kanonski %s", (raw, goli, kanonski) => {
      const { candidates } = parseReference(raw);
      expect(candidates[0]).toBe(raw);
      expect(candidates).toContain(kanonski);
      expect(candidates).not.toContain(goli);
    });

    /**
     * Reči koje samo POČINJU isto kao oznaka serije nisu oznaka — inače bi „ponovo",
     * „revizija" i slično gutali broj fakture. Zato su alijasi vezani za značenje
     * (`PONUDA*`, `REVERS*`), a ne za prva tri slova.
     */
    it("reč sličnog početka nije serija (ponovo/revizija/profit + broj)", () => {
      expect(parseReference("PONOVO 12/26").candidates).toContain("12/26");
      expect(parseReference("REVIZIJA 12/26").candidates).toContain("12/26");
      expect(parseReference("PROFIT 12/26").candidates).toContain("12/26");
    });

    /**
     * IZVOR ISTINE: svaki prefiks koji numeracija ume da UPIŠE, parser mora da UME DA
     * PROČITA. Test nabraja prefikse iz registra u `numbering.service.ts`, pa nova
     * serija dodata tamo obara ovaj test dok se ne doda i ovde — bez toga bi njen PNB
     * tiho proizvodio goli broj fakture, tačno kao u nalazu N10.
     */
    it("parser poznaje SVE prefikse iz registra numeracije", () => {
      const izNumeracije = [...DOCUMENT_SERIES.values()].filter(
        (p) => p !== "",
      );
      expect(izNumeracije.length).toBeGreaterThan(0);
      for (const prefix of izNumeracije) {
        expect(SERIES_PREFIXES).toContain(prefix);
      }
    });
  });

  /**
   * 🔴 ZATEČENI BIGBIT BROJ NE SME DA POGODI NAŠ NOV DOKUMENT (nalaz V1, 02.08.2026).
   * ═══════════════════════════════════════════════════════════════════════════════
   * BigBit i 4.0 rade PARALELNO do cutovera (april 2027): kupci u istom periodu plaćaju
   * i stare BigBit dokumente, a produkcijski `ledger_entries` ih već nosi (~22.000
   * redova). Parser je stari broj NORMALIZOVAO u naš — skidanjem vodećih nula i
   * skraćivanjem četvorocifrene godine dobijao je tačno oblik koji izdaje O-F1.
   *
   * Brojevi su STVARNI, iz `migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:113-129,180-186`.
   * IZMERENO na kodu pre ove izmene — svaki levi PNB je davao desni kandidat:
   *
   *     `0012-26` (BigBit AVR 2026)   → `12/26`       = NAŠA faktura
   *     `AVR-00001/2026`              → `A-1/26`      = NAŠ avans
   *     `AR-00001/2025` (GK zapis)    → `1/25`        = NAŠA faktura
   *     `PRO-00002/2025`              → `2/25`        = NAŠA faktura
   *     `IFG-00025/2025`              → `25/25`       = NAŠA faktura
   *     `PON-00285/2026`              → `PON-285/26`  = NAŠA ponuda
   *
   * Tvrdnja iz `numbering.service.ts` da se stari i novi broj „nikad ne mogu sudariti"
   * važila je samo za jedinstveni indeks nad `invoices` — uparivanje ne poredi ceo
   * string nego kandidate, i tu je sudar bio svakodnevno moguć.
   */
  describe("stari (BigBit) broj se NE normalizuje u naš novi broj (V1)", () => {
    /** [stvaran BigBit PNB, naš broj koji je pogađao] */
    const STARI: Array<[string, string]> = [
      ["0012-26", "12/26"],
      ["0016-26", "16/26"],
      ["0017-26", "17/26"],
      ["AVR-00001/2026", "A-1/26"],
      ["AR-00001/2025", "1/25"],
      ["PRO-00002/2025", "2/25"],
      ["IFG-00025/2025", "25/25"],
      ["PON-00285/2026", "PON-285/26"],
    ];

    it.each(STARI)("PNB %s više ne daje naš broj %s", (raw, nas) => {
      const { candidates } = parseReference(raw);
      expect(candidates[0]).toBe(raw); // egzaktan pogodak na STARI dokument ostaje prvi
      expect(candidates).not.toContain(nas);
    });

    it("egzaktan pogodak na stari dokument je očuvan u svim zapisima", () => {
      // Ako stari broj u glavnoj knjizi stoji baš tako kako ga je kupac otkucao,
      // uparivanje i dalje radi — brana gasi samo IZVEDENE oblike.
      for (const [raw] of STARI) {
        expect(parseReference(raw).candidates[0]).toBe(raw);
      }
    });

    /**
     * ⚠️ PREKROJENO (nalaz V-B, šesti krug). Raniji oblik ovog testa je tražio da SVAKI
     * izveden kandidat nosi staru šifru (`AR-`, `PRO-`, `IFG-`) — što je merilo MEHANIKU
     * (generičku granu), a ne posledicu. Ta grana je uklonjena jer je jela 29 legitimnih
     * oblika PNB-a; brana koja stvarno štiti glavnu knjigu je da nijedan izveden kandidat
     * ne sme da bude u obliku NAŠEG broja `N/GG`. Nju obezbeđuje zero-padding u svakom
     * BigBit auto-broju + `OUR_NUMBER_RE`, i baš to se ovde meri.
     *
     * IZMERENO posle uklanjanja: `AR-00001/2025` → […,"00001/2025","00001/25","1/2025"] —
     * dakle `1/25` NE postoji; isto `PRO-00002/2025` (nema `2/25`), `IFG-00025/2025`
     * (nema `25/25`), `IFU-00012/2026` (nema `12/26`), `IZV-00060/2026` (nema `60/26`).
     */
    it.each([
      "AR-00001/2025",
      "PRO-00002/2025",
      "IFG-00025/2025",
      "IFU-00012/2026",
      "IZV-00060/2026",
      "AVR-00001/2026",
      "PON-00285/2026",
      "0012-26",
    ])("PNB %s ne daje NIJEDAN kandidat u obliku našeg broja `N/GG`", (raw) => {
      // Oblik NAŠEG broja je `[1-9]\d*/GG` — bez vodeće nule (O-F1). Zero-padovan
      // kandidat (`0012/26`) nije naš broj: kao STRING se ne poklapa ni sa jednim
      // dokumentom koji numeracija izda, pa nije opasan.
      for (const c of parseReference(raw).candidates.slice(1)) {
        expect(c).not.toMatch(/^[1-9]\d*\/\d{2}$/);
      }
    });

    it("vodeće nule iz BANKE i dalje daju goli broj (nije naš oblik `N/GG`)", () => {
      // Brana gađa samo prelaz „stari broj → naš broj". Zero-pad koji dolazi iz polja
      // banke (`00123`, model 97 + kontrolni broj) mora da radi kao i pre — inače bi
      // se izgubio legitiman pogodak.
      expect(parseReference("00123").candidates).toContain("123");
      expect(parseReference("9732001234").candidates).toContain("1234");
      expect(parseReference("32001234", "97").candidates).toContain("1234");
    });

    it("naš broj bez nula i dalje prolazi (657-25 → 657/25)", () => {
      expect(parseReference("657-25").candidates).toContain("657/25");
      expect(parseReference("123-2026").candidates).toContain("123/26");
    });
  });

  /**
   * REČ-OZNAKA MORA DA PREŽIVI „BR" I ĆIRILICU (nalaz V2, 02.08.2026).
   * ───────────────────────────────────────────────────────────────────────────────
   * Razdelnik između oznake i broja primao je samo NE-slovne znakove, pa je oznaka
   * padala čim se ubaci najčešći srpski oblik („br"/„broj"), čim se dokument imenuje
   * punim imenom („avansni račun"), čim se predračun nazove „proformom" ili čim se PNB
   * otkuca ćirilicom. IZMERENO — svi su davali GOLI broj, dakle broj tuđe fakture.
   */
  describe("reč-oznaka preživljava BR, puno ime i ćirilicu (V2)", () => {
    it.each([
      ["AVANS BR 1/26", "1/26", "A-1/26"],
      ["AVANS BROJ 1/26", "1/26", "A-1/26"],
      ["AVANSNI RACUN 1/26", "1/26", "A-1/26"],
      ["AVANSNI RAČUN 1/26", "1/26", "A-1/26"],
      ["PREDRACUN BR. 12/26", "12/26", "PROF-12/26"],
      ["PROFORMA 12/26", "12/26", "PROF-12/26"],
      ["PROFORMA BR 12/26", "12/26", "PROF-12/26"],
      ["PONUDA BR. 5/26", "5/26", "PON-5/26"],
      ["REVERS BR 8/26", "8/26", "REV-8/26"],
      ["АВАНС 1/26", "1/26", "A-1/26"],
      ["АВАНС БР 1/26", "1/26", "A-1/26"],
      ["ПРЕДРАЧУН 12/26", "12/26", "PROF-12/26"],
      ["ПОНУДА 5/26", "5/26", "PON-5/26"],
      ["РЕВЕРС 8/26", "8/26", "REV-8/26"],
    ])("PNB %s ne daje goli %s, nego kanonski %s", (raw, goli, kanonski) => {
      const { candidates } = parseReference(raw);
      expect(candidates[0]).toBe(raw);
      expect(candidates).toContain(kanonski);
      expect(candidates).not.toContain(goli);
    });

    it("sama reč BR ne pretvara tuđu reč u oznaku (PROFIT/PONOVO + BR)", () => {
      // Popuna „br" sme da stoji samo IZA prave oznake; sama po sebi ne sme ništa da
      // veže, inače bi svaka reč ispred „br" postala serija.
      expect(parseReference("PROFIT BR 12/26").candidates).toContain("12/26");
      expect(parseReference("PONOVO BR 12/26").candidates).toContain("12/26");
      expect(parseReference("BR 12/26").candidates).toContain("12/26");
    });

    it("avansni račun DA, ali avans PO FAKTURI i dalje pušta broj fakture", () => {
      // „Avansni račun 1/26" je IME dokumenta; „avans po fakturi 1/26" imenuje FAKTURU
      // na koju se avansno plaća — tu broj mora da ostane go.
      expect(parseReference("AVANS PO FAKTURI 1/26").candidates).toContain(
        "1/26",
      );
    });
  });

  /**
   * 🔴 „GENERIČKA ŠIFRA VRSTE" JE UKLONJENA — JELA JE TAČNE POGOTKE (nalaz V-B, šesti krug).
   * ═══════════════════════════════════════════════════════════════════════════════
   * Nalaz V3 je uveo pravilo „svaka 2–5 slova + `-` + cifra je serija", uz DENYLIST od
   * dvadesetak reči koje to nisu (`BR`, `RACUN`, `FAKT`, `PO`…). Pravilo je bilo suprotno
   * doktrini iz `SERIES_ALIASES` („reči su NABROJANE… lažna oznaka bi pojela broj
   * fakture"), a denylist se ne može dopuniti do kraja — skup reči koje ljudi kucaju
   * ispred broja je otvoren.
   *
   * IZMERENO: 29 oblika je GUBILO tačan broj `657/25` (stari kod ih je imao):
   *     `IFR-` (naša sopstvena šifra vrste!) · `RAC-` · `RAČ-` · `FAK-` · `FA-` · `ФАК-` ·
   *     `IF-` · `UF-` · `REF-` · `POZ-` · `RB-` · `DOK-` · `ID-` · `NO-` · `TR-` · `OP-` ·
   *     `SEF-` · `PP-` · `ZR-` · `PDV-` · `POR-` · `JN-` · `NAL-` · `UG-` · `UGOV-` ·
   *     `NAR-` · `OTP-` · `OTPR-` · `KOMP-`
   * Posledica nije bila pogrešan pogodak nego IZGUBLJEN TAČAN — uparivanje pada na
   * uparivanje po iznosu (`bank-statement.service.ts` → `findFirst` po jednakom iznosu),
   * koje stavku zatvara bez ijedne informacije o broju. To NIJE pošten promašaj.
   *
   * ZAŠTO SE SMELO UKLONITI — grana je bila suvišna za oba svoja cilja:
   *   1) BigBit auto-broj je uvek ZERO-PADOVAN, pa ga hvata brana vodećih nula (v. V1);
   *   2) numeracija više ne izmišlja prefiks za neupisanu vrstu (`seriesPrefixFor` → 422).
   */
  describe("nema generičke šifre vrste — tačan broj preživi šum (V-B)", () => {
    /** 29 izmerenih oblika: šifra/skraćenica ispred NAŠEG broja ne sme da ga pojede. */
    it.each([
      "IFR-657/25",
      "RAC-657/25",
      "RAČ-657/25",
      "FAK-657/25",
      "FA-657/25",
      "ФАК-657/25",
      "IF-657/25",
      "UF-657/25",
      "REF-657/25",
      "POZ-657/25",
      "RB-657/25",
      "DOK-657/25",
      "ID-657/25",
      "NO-657/25",
      "TR-657/25",
      "OP-657/25",
      "SEF-657/25",
      "PP-657/25",
      "ZR-657/25",
      "PDV-657/25",
      "POR-657/25",
      "JN-657/25",
      "NAL-657/25",
      "UG-657/25",
      "UGOV-657/25",
      "NAR-657/25",
      "OTP-657/25",
      "OTPR-657/25",
      "KOMP-657/25",
    ])("PNB %s i dalje daje tačan broj 657/25", (raw) => {
      const { candidates } = parseReference(raw);
      expect(candidates[0]).toBe(raw); // egzaktan ostaje prvi
      expect(candidates).toContain("657/25");
    });

    it("kratke reči uz crticu NISU šifra vrste (račun/br/po + broj ostaju)", () => {
      expect(parseReference("RACUN-657/25").candidates).toContain("657/25");
      expect(parseReference("racun-657/25").candidates).toContain("657/25");
      expect(parseReference("BR-657/25").candidates).toContain("657/25");
      expect(parseReference("PO-657/25").candidates).toContain("657/25");
    });

    it("duga reč nije šifra vrste", () => {
      expect(parseReference("FAKTURA-657/25").candidates).toContain("657/25");
      expect(parseReference("UPLATA-657/25").candidates).toContain("657/25");
    });

    it("jedno slovo uz crticu i dalje nije serija (B-7/26 → 7/26)", () => {
      expect(parseReference("B-7/26").candidates).toContain("7/26");
      expect(parseReference("97 B-7/26").candidates).toContain("7/26");
    });

    /**
     * REGISTROVANE SERIJE SU IZUZETAK I DALJE — `AVR-`/`PON-` se čitaju kao serija, jer ih
     * numeracija stvarno izdaje. Uklonjena je samo grana za šifre KOJE NISU U REGISTRU.
     */
    it("registrovane serije se i dalje čitaju iz šifre (AVR-/PON-)", () => {
      expect(parseReference("AVR-1/26").candidates).toContain("A-1/26");
      expect(parseReference("AVR-1/26").candidates).not.toContain("1/26");
      expect(parseReference("PON-5/26").candidates).not.toContain("5/26");
    });

    /**
     * BRANA KOJA ZATVARA KRUG: registar numeracije je JEDAN izvor za oba sloja.
     * Svaki broj koji `DocumentNumberSequenceService.next` ume da IZDA mora da se kroz
     * parser vrati kao SVOJ kandidat i NIKAD kao goli `N/GG`. Nova serija dodata samo u
     * numeraciju (bez reč-alijasa i bez prefiksa koji parser čita) obara ovaj test.
     *
     * ⚠️ Drugi krak istog invarianta je da numeracija NE UME da izda prefiks van registra
     * (nalaz V-B) — bez toga bi `XYZ-7/26` opet davao goli `7/26`. Zato test proverava i
     * da neupisana vrsta uopšte ne dobija broj.
     */
    it("BRANA: svaki IZDAT broj se kroz parser vraća bez golog `N/GG`", async () => {
      const service = new DocumentNumberSequenceService();
      const nizFaktura = new Set<string>();
      for (const [tip, prefix] of DOCUMENT_SERIES) {
        if (prefix === "") nizFaktura.add(tip);
      }

      for (const tip of DOCUMENT_SERIES.keys()) {
        const broj = await service.next(fakeTx(6), tip, 2026, 0);
        const { candidates } = parseReference(broj);

        expect(candidates[0]).toBe(broj); // egzaktan pogodak uvek prvi
        if (nizFaktura.has(tip)) {
          expect(broj).toBe("7/26"); // faktura JE goli broj — to je O-F1
          continue;
        }
        // Vrsta van niza faktura: broj mora da preživi parser sa svojim prefiksom, a
        // goli oblik ne sme da postoji ni kao kandidat.
        expect(candidates).toContain(broj);
        expect(candidates).not.toContain("7/26");
        for (const c of candidates.slice(1)) {
          expect(c).not.toMatch(/^\d+\/\d{2}$/);
        }
      }

      // Drugi krak: prefiks koji parser ne poznaje se NE MOŽE ni izdati.
      await expect(
        service.next(fakeTx(6), "XYZ", 2026, 0),
      ).rejects.toThrow(/registru numeracije/);
    });
  });

  /**
   * 🔴 PROCENAT/RATA SE PRESKAČU — OZNAKA SE NE UBIJA (nalaz V-A, šesti krug 02.08.2026).
   * ═══════════════════════════════════════════════════════════════════════════════
   * Nalaz S5 je tačno video da oznaka ne sme da veže procenat ni redni broj rate, ali je
   * lek bio pogrešan: umesto da šum PRESKOČI, gasio je oznaku u celini. Marker se tada
   * uopšte nije pojavio, PNB je išao normalnim putem i GOLI `N/GG` je izlazio napolje.
   *
   * IZMERENO (izvršavanjem parsera nad istim ulazima kroz obe verzije) — levo kod sa
   * `cbf44ed1`, desno kod pre njega:
   *
   *     `PREDRACUN 50% 12/26` → […,"12","1226","26","12/26"]  ❌   pre: nijedan goli
   *     `AVANS 50% 1/26`      → […,"1","126","26","1/26"]     ❌   pre: nijedan goli
   *     `PONUDA 50% 5/26`     → […,"5","526","26","5/26"]     ❌   pre: nijedan goli
   *     `AVANS 1.RATA 1/26`   → […,"1","126","26","1/26"]     ❌   pre: nijedan goli
   *
   * `PREDRACUN 50% 12/26` je najprirodniji zapis 50% avansne uplate po predračunu.
   * Predračuna u glavnoj knjizi NEMA, pa je goli `12/26` mogao da pogodi samo jedno:
   * FAKTURU `12/26` — tiho zatvorena tuđa obaveza.
   *
   * Stari test je bio SLEP: proveravao je samo `toContain("657/25")`, a nijedan nije
   * tražio `not.toContain` golog broja kad taj broj pripada SERIJI. Ta brana je ovde.
   */
  describe("procenat/rata se PRESKAČU, oznaka ostaje (V-A)", () => {
    /** [sirov PNB, goli broj koji NE SME da izađe, kanonski broj koji MORA da izađe] */
    it.each([
      ["PREDRACUN 50% 12/26", "12/26", "PROF-12/26"],
      ["AVANS 50% 1/26", "1/26", "A-1/26"],
      ["PONUDA 50% 5/26", "5/26", "PON-5/26"],
      ["AVANS 1.RATA 1/26", "1/26", "A-1/26"],
      ["AVANS 1. RATA 1/26", "1/26", "A-1/26"],
      ["PROF 50% 12/26", "12/26", "PROF-12/26"],
      ["AVR 50% 1/26", "1/26", "A-1/26"],
      ["A 50% 1/26", "1/26", "A-1/26"],
      ["AVANS 40 % 1/26", "1/26", "A-1/26"],
      ["REVERS 50% 8/26", "8/26", "REV-8/26"],
      ["PREDRACUN 100% 12/26", "12/26", "PROF-12/26"],
      // Decimalni procenat i drugi padež reči „rata" — isti obrazac, isti ishod.
      ["AVANS 12,5% 1/26", "1/26", "A-1/26"],
      ["AVANS 2. RATE 1/26", "1/26", "A-1/26"],
    ])("PNB %s ne daje goli %s, nego kanonski %s", (raw, goli, kanonski) => {
      const { candidates } = parseReference(raw);
      expect(candidates[0]).toBe(raw); // egzaktan pogodak ostaje prvi
      expect(candidates).toContain(kanonski);
      expect(candidates).not.toContain(goli);
      // Nijedan izveden kandidat ne sme da bude u obliku NAŠEG golog broja.
      for (const c of candidates.slice(1)) expect(c).not.toMatch(/^\d+\/\d{2}$/);
    });

    /**
     * VLASNIŠTVO BROJA MENJA SAMO REČ KOJA IMENUJE DRUGI DOKUMENT. „Avans 50% PO FAKTURI
     * 657/25" znači avansna uplata NA FAKTURU 657/25 — tu broj pripada fakturi i goli
     * `657/25` mora da preživi. Bez te reči broj pripada avansu (v. tabela iznad).
     */
    it.each([
      ["AVANS 30% PO FAKTURI 657/25", "657/25"],
      ["AVANS 50% PO FAKTURI 657/25", "657/25"],
      ["AVANS PO FAKTURI 1/26", "1/26"],
      ["avans po fakturi 1/26", "1/26"],
      ["avansno placanje po fakturi 657/25", "657/25"],
    ])("PNB %s i dalje daje GOLI %s (broj pripada fakturi)", (raw, goli) => {
      expect(parseReference(raw).candidates).toContain(goli);
    });

    /**
     * KONTROLNA GRUPA: oblici koji ni pre nisu curili moraju tako i ostati. Ovde procenat
     * stoji IZA broja ili ISPRED oznake, a `2/2` je „rata 2 od 2" — ni jedan od njih se ne
     * preskače, i ne mora: korak „broj/godina" ionako izvuče pravi par.
     */
    it.each([
      "AVANS 1/26 50%",
      "50% AVANS 1/26",
      "AVANS 1 RATA 1/26",
      "AVANS 2/2 1/26",
    ])("PNB %s i dalje daje A-1/26 bez golog broja", (raw) => {
      const { candidates } = parseReference(raw);
      expect(candidates).toContain("A-1/26");
      expect(candidates).not.toContain("1/26");
    });

    it("ćirilica i mala slova prolaze isto (šum se ne veže za pismo)", () => {
      // Ćirilični PNB je u srpskoj praksi jednako čest; `SERIES_NOISE` zato zna i „РАТА".
      expect(parseReference("АВАНС 50% 1/26").candidates).toContain("A-1/26");
      expect(parseReference("АВАНС 1.РАТА 1/26").candidates).toContain("A-1/26");
      expect(parseReference("ПРЕДРАЧУН 50% 12/26").candidates).toContain(
        "PROF-12/26",
      );
      expect(parseReference("avans 1.rata 1/26").candidates).toContain("A-1/26");
    });

    it("dva dokumenta u istom PNB-u: šum ne meša odsečke", () => {
      const { candidates } = parseReference("A-1/26 PREDRACUN 50% 12/26");
      expect(candidates).toContain("A-1/26");
      expect(candidates).toContain("PROF-12/26");
      expect(candidates).not.toContain("12/26");
    });

    it("procenat bez broja iza sebe ne postaje broj dokumenta", () => {
      // Bez `BIND_AHEAD` bi backtracking vezao samu cifru procenta i dao `A-50%`.
      const { candidates } = parseReference("AVANS 50%");
      expect(candidates).not.toContain("A-50%");
      expect(candidates).not.toContain("A-50");
    });

    it("prava oznaka + pravi broj se ne kvari ovim pravilom", () => {
      expect(parseReference("AVANS 1/26").candidates).toContain("A-1/26");
      expect(parseReference("A. 1/26").candidates).toContain("A-1/26");
      expect(parseReference("AVANS BR 1/26").candidates).toContain("A-1/26");
      expect(parseReference("AVANS 50% BR 1/26").candidates).toContain("A-1/26");
    });

    it("PNB sa DVA dokumenta daje OBA broja (svaka oznaka drži svoj odsečak)", () => {
      // Ranije je prva oznaka gutala ceo ostatak: `PROF-1/26 PROF-2/26` je davao
      // besmislen `PROF-PROF-2/26` i nijedan stvaran broj.
      const { candidates } = parseReference("PROF-1/26 PROF-2/26");
      expect(candidates).toContain("PROF-1/26");
      expect(candidates).toContain("PROF-2/26");
      expect(candidates).not.toContain("PROF-PROF-2/26");
    });

    it("dve različite serije u istom PNB-u dobijaju svaka svoj prefiks", () => {
      const { candidates } = parseReference("A-1/26 PROF-2/26");
      expect(candidates).toContain("A-1/26");
      expect(candidates).toContain("PROF-2/26");
      expect(candidates).not.toContain("1/26");
      expect(candidates).not.toContain("2/26");
    });

    it("avans + broj fakture u istom PNB-u: bar tačan avans preživi", () => {
      // ⚠️ Delimično rešeno — v. PREOSTALE_FAZE.md „🔶 OTVORENO": goli `657/25` i dalje
      // ne izlazi, jer sve iza oznake pripada njoj. Ranije se gubio i `A-1/26`.
      const { candidates } = parseReference("A-1/26 i 657/25");
      expect(candidates).toContain("A-1/26");
    });
  });

  /**
   * SLOVO IZMEĐU CIFARA NIJE OZNAKA SERIJE (nalaz N2, 02.08.2026).
   * Cifra ispred oznake je dozvoljena zbog modela/kontrolnog broja (`97A-7/26`), ali
   * bez razdelnika to nije serija nego deo šifre/šuma. IZMERENO na starom kodu:
   * `123A456` → samo `A-456` (broj `123` je nestao), `00A12345` → samo `A-12345`.
   */
  describe("slovo usred cifara nije serija (N2)", () => {
    it("123A456 i 00A12345 ne daju avansne kandidate", () => {
      expect(parseReference("123A456").candidates).not.toContain("A-456");
      expect(parseReference("00A12345").candidates).not.toContain("A-12345");
    });

    it("model/kontrolni broj ISPRED serije i dalje radi (razdelnik postoji)", () => {
      expect(parseReference("97A-7/26").candidates).toContain("A-7/26");
      expect(parseReference("9712-A-7/26").candidates).toContain("A-7/26");
      expect(parseReference("A7/26").candidates).toContain("A-7/26");
    });
  });
});

/**
 * Minimalna „transakcija" za `DocumentNumberSequenceService.next` — brojač zatečen na
 * `lastNumber`, pa je sledeći broj uvek `lastNumber + 1`. Bez baze: testira se samo
 * OBLIK izdatog broja, koji je jedino što parser vidi.
 */
function fakeTx(lastNumber: number): Prisma.TransactionClient {
  return {
    $queryRaw: async () => [{ id: 1, last_number: lastNumber }],
    // Brana O-F11 (05.08.2026): numeracija pre izdavanja pita glavnu knjigu da li broj
    // već postoji. Ovde je knjiga PRAZNA — ovaj test meri odnos numeracije i parsera
    // poziva na broj, pa nijedan broj ne sme da bude preskočen (inače bi očekivano
    // `7/26` postalo `8/26` i test bi merio nešto treće).
    ledgerEntry: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    documentNumberSequence: {
      create: async () => ({}),
      update: async () => ({}),
    },
  } as unknown as Prisma.TransactionClient;
}
