import { Prisma } from "@prisma/client";
import {
  DOCUMENT_SERIES,
  DOCUMENT_SERIES_REGISTRY,
  DocumentNumberSequenceService,
  INVOICE_SEQUENCE_KEY,
  sequenceKeyFor,
  seriesByKey,
  seriesPrefixFor,
} from "./numbering.service";
import { MAX_COLLISION_SKIP } from "./document-number-conflict";

/**
 * Numeracija izlaznih dokumenata — format `NNN/GG` (odluka O-F1) i JEDAN
 * zajednički niz za sve izlazne fakture (dokaz sa donetih papira).
 *
 * Pokriveno: prvi broj u godini (`1/26`), deseti (`10/26`), bez vodećih nula,
 * prelaz godine (nov niz kreće od 1), dvocifrena godina za „okrugle" godine
 * (2005 → `/05`), NEMA prefiksa vrste dokumenta (papir = SEF = glavna knjiga),
 * zajednički niz preko vrsta faktura, sopstvena serija avansnog računa `A-1/26`
 * (O-F6) i ostalih vrsta van niza faktura — `PROF-`, `PON-`, `REV-` (O-F7) —
 * uz branu „serije su međusobno disjunktne" koja vrste nabraja IZ REGISTRA, i
 * zaštita od trke (dva paralelna zahteva ne dobijaju isti broj).
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
/** Jedna stavka „glavne knjige" u testu: broj dokumenta + konto na kom stoji. */
type BookEntry = string | { number: string; accountCode: string };

function makeDb(seed: SeqRow[] = [], bookNumbers: BookEntry[] = []) {
  const rows: SeqRow[] = [...seed];
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const locks = new Map<string, Promise<void>>();
  /**
   * „Glavna knjiga" — ono što `ledger_entries` već sadrži.
   * Postoji zbog brane O-F11: numeracija od 05.08.2026 pita knjigu pre nego što izda
   * broj, pa lažni klijent mora da ume da odgovori. Prazan skup = knjiga bez ijednog
   * broja, tj. ponašanje pre brane (zato svi stariji testovi ostaju netaknuti).
   *
   * Podrazumevani konto je `2040` (kupci u zemlji) jer tu stoje NAŠI izlazni dokumenti;
   * test koji hoće dobavljačev broj navodi svoj konto (npr. `435`).
   */
  const book = bookNumbers.map((b) =>
    typeof b === "string" ? { number: b, accountCode: "2040" } : b,
  );
  const bookHas = (n: string, accountPrefix?: string) =>
    book.some(
      (e) =>
        e.number === n &&
        (accountPrefix === undefined ||
          e.accountCode.startsWith(accountPrefix)),
    );

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
      // Brana O-F11: „da li ovaj broj već postoji u knjizi?" — tačno poklapanje
      // stringa (indeks `idx_ledger_entries_document_number`), pa je i lažna
      // implementacija obično traženje po skupu.
      ledgerEntry: {
        findFirst: ({
          where,
        }: {
          where: {
            documentNumber: string;
            accountCode?: { startsWith: string };
          };
        }) =>
          Promise.resolve(
            bookHas(where.documentNumber, where.accountCode?.startsWith)
              ? { id: 1 }
              : null,
          ),
        findMany: ({
          where,
        }: {
          where: {
            documentNumber: { in: string[] };
            accountCode?: { startsWith: string };
          };
        }) =>
          Promise.resolve(
            where.documentNumber.in
              .filter((n) => bookHas(n, where.accountCode?.startsWith))
              .map((documentNumber) => ({ documentNumber })),
          ),
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

  return { rows, tx, find, book };
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
    expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(1);
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
      {
        id: 1,
        documentType: INVOICE_SEQUENCE_KEY,
        year: 2026,
        companyId: 0,
        lastNumber: 656,
      },
    ]);

    await expect(once(db, "IFR", 2026)).resolves.toBe("657/26");
    await expect(once(db, "IFR", 2027)).resolves.toBe("1/27");
    // Stara godina ostaje netaknuta (brojač se ne resetuje unazad).
    expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(657);
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

  it("nastavlja na zatečeni brojač (43 → sledeći je 44/26, ne 1/26)", async () => {
    // Zatečeni dokumenti se NE migriraju; sekvenca se ne resetuje, pa se redni broj
    // 43 ne troši drugi put ni suštinski, ne samo kao string.
    const db = makeDb([
      {
        id: 1,
        documentType: INVOICE_SEQUENCE_KEY,
        year: 2026,
        companyId: 0,
        lastNumber: 43,
      },
    ]);
    await expect(once(db, "IFR", 2026)).resolves.toBe("44/26");
  });

  describe("jedan zajednički niz za izlazne fakture (dokaz sa papira)", () => {
    it("dve RAZLIČITE vrste uzastopno: 1/26 pa 2/26 (nikad 1/26 i 1/26)", async () => {
      const db = makeDb();

      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "IFUSL", 2026)).resolves.toBe("2/26");

      // Jedan jedini red sekvence — ne po red za svaku vrstu.
      expect(db.rows).toHaveLength(1);
      expect(db.rows[0].documentType).toBe(INVOICE_SEQUENCE_KEY);
      expect(db.rows[0].lastNumber).toBe(2);
    });

    it("papir 22–25.12.2025: IFGP 650 → IFUSL 653 → IFR 657 (isprepleteno po datumu)", async () => {
      // Doneti papiri nose tri RAZLIČITE vrste sa brojevima koji rastu hronološki.
      // Sa brojačem po vrsti ovakav niz je nemoguć — zato je ovaj test brana.
      const db = makeDb([
        {
          id: 1,
          documentType: INVOICE_SEQUENCE_KEY,
          year: 2025,
          companyId: 0,
          lastNumber: 649,
        },
      ]);

      await expect(once(db, "IFGP", 2025)).resolves.toBe("650/25");
      await expect(once(db, "IFUSL", 2025)).resolves.toBe("651/25");
      await expect(once(db, "IFR", 2025)).resolves.toBe("652/25");
    });

    it("ino parnjaci (IZVRO/IZVGP/IZVUS) su u ISTOM nizu kao domaće fakture", async () => {
      const db = makeDb();

      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "IZVRO", 2026)).resolves.toBe("2/26");
      await expect(once(db, "IZVGP", 2026)).resolves.toBe("3/26");
      await expect(once(db, "IZVUS", 2026)).resolves.toBe("4/26");
      expect(db.rows).toHaveLength(1);
    });

    it("AVR i PROF NISU u nizu faktura — zadržavaju svoj brojač po vrsti (O-F7)", async () => {
      // Za avans i predračun nemamo papir koji pokazuje šta BigBit radi, pa se ne
      // uvlače u zajednički niz (avansi imaju i zaseban zakonski niz).
      //
      // ⚠️ ISPRAVLJENO ZBOG O-F6: raniji oblik ovog testa tražio je da AVR dâ goli
      // `1/26`. Ta tvrdnja je napisana PRE odluke O-F6 i bila je tačna samo dok se
      // nije videlo šta goli broj radi nizvodno — zato je zamenjena, nije „popravljena
      // da prođe". Avansni račun od O-F6 nosi SOPSTVENU SERIJU `A-1/26`:
      //   • dobavljačevi avansi se ručno kucaju u ISTU tabelu `invoices` sa istom
      //     vrstom `AVR` i istim oblikom broja → `1/26` je bio siguran 409;
      //   • dugovna strana avansa ide na ISTI kupčev konto kao faktura, a otvorene
      //     stavke/kamata grupišu po broju bez vrste → AVR `7/26` i IFR `7/26` bi se
      //     spojili u jedan dug od 24.000 sa ranijim dospećem.
      const db = makeDb();

      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "IFGP", 2026)).resolves.toBe("2/26");
      // Avans i predračun kreću od svoje jedinice, nezavisno od faktura, i OBA nose
      // prefiks serije. ⚠️ ISPRAVLJENO ZBOG O-F7: raniji oblik ovog testa tražio je da
      // PROF dâ goli `1/26` — jer je „predračun se ne knjiži" bilo pročitano kao „ne
      // može da se sudari". Može, i to na najgorem mestu: predračun `1/26` i faktura
      // `1/26` postoje ISTOVREMENO kod istog kupca, kupac plaća PO PREDRAČUNU i u
      // poziv na broj kuca `1/26`, a u glavnoj knjizi taj string nosi FAKTURA.
      await expect(once(db, "AVR", 2026)).resolves.toBe("A-1/26");
      await expect(once(db, "PROF", 2026)).resolves.toBe("PROF-1/26");

      expect(db.rows.map((r) => r.documentType).sort()).toEqual([
        INVOICE_SEQUENCE_KEY,
        "AVR",
        "PROF",
      ]);
    });
  });

  describe("avansni račun ima svoju seriju (O-F6)", () => {
    it("brojač JE razdvojen: avans ne troši broj fakture i obrnuto", async () => {
      const db = makeDb();

      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "AVR", 2026)).resolves.toBe("A-1/26");
      await expect(once(db, "IFUSL", 2026)).resolves.toBe("2/26");
      await expect(once(db, "AVR", 2026)).resolves.toBe("A-2/26");

      // Dva reda sekvence: zajednički niz faktura i sopstveni niz avansa.
      expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(2);
      expect(db.find("AVR", 2026, 0)?.lastNumber).toBe(2);
    });

    it("SCENARIO: isti redni broj u istoj godini daje RAZLIČITE stringove", async () => {
      // Kvar iz kog je odluka došla: kupac ima nenaplaćen avans i fakturu sa istim
      // rednim brojem 7. Sa golim brojem oba dokumenta su `7/26`, pa ih otvorene
      // stavke i kamata (grupa = konto + komitent + BROJ) spajaju u jednu stavku od
      // 24.000 sa dospećem avansa. Prefiks serije to čini nemogućim.
      const db = makeDb([
        {
          id: 1,
          documentType: INVOICE_SEQUENCE_KEY,
          year: 2026,
          companyId: 0,
          lastNumber: 6,
        },
        { id: 2, documentType: "AVR", year: 2026, companyId: 0, lastNumber: 6 },
      ]);

      const faktura = await once(db, "IFR", 2026);
      const avans = await once(db, "AVR", 2026);

      expect(faktura).toBe("7/26");
      expect(avans).toBe("A-7/26");
      expect(faktura).not.toBe(avans);
    });

    it("prefiks ne kvari format ostatka broja (bez vodećih nula, dvocifrena godina)", async () => {
      const db = makeDb([
        { id: 1, documentType: "AVR", year: 2026, companyId: 0, lastNumber: 9 },
      ]);
      await expect(once(db, "AVR", 2026)).resolves.toBe("A-10/26");
      await expect(once(db, "AVR", 2005)).resolves.toBe("A-1/05");
    });

    /**
     * BRANA: serije su međusobno disjunktne za SVAKI redni broj.
     * ───────────────────────────────────────────────────────────────────────────
     * Jedina odbrana od spajanja dva dokumenta u jednu otvorenu stavku je to da se
     * stringovi brojeva ne mogu preklopiti — glavna knjiga NEMA kolonu vrste
     * dokumenta, pa je broj sve što grupni ključ ima.
     *
     * ⚠️ PREKROJENO (nalaz N11, 02.08.2026): raniji oblik ovog testa nabrajao je TVRD
     * SPISAK od sedam vrsta, iako mu je komentar obećavao da će „nova vrsta oboriti
     * test". Nije mogao: PROF, PON i REV su tada već postojali, davali goli `N/GG`
     * kao i faktura, i test ih nije ni video. Spisak se zato NABRAJA IZ REGISTRA
     * (`DOCUMENT_SERIES`) — vrsta dodata tamo automatski ulazi u ovu branu, a vrsta
     * dodata sa prefiksom koji već neko koristi je obara.
     *
     * ⚠️ SPISAK JE SAMO REGISTAR (nalaz V-B, šesti krug 02.08.2026). Ranije je uz njega
     * išla i neupisana vrsta „XYZ", jer je fallback za nju izmišljao prefiks iz šifre.
     * Fallbacka više nema — neupisana vrsta ne dobija broj nego 422 (v. testove ispod),
     * pa je registar ceo skup brojeva koje sistem ume da izda.
     */
    it("BRANA: serije su međusobno disjunktne za SVAKI redni broj (spisak iz registra)", async () => {
      const vrste = [...DOCUMENT_SERIES.keys()];
      const nizFaktura = (tip: string) =>
        sequenceKeyFor(tip) === INVOICE_SEQUENCE_KEY;

      for (const seq of [1, 7, 43, 657]) {
        /** broj → vrste koje su ga izdale sa istim rednim brojem */
        const viđeni = new Map<string, string[]>();

        for (const tip of vrste) {
          const db = makeDb([
            {
              id: 1,
              documentType: sequenceKeyFor(tip),
              year: 2026,
              companyId: 0,
              lastNumber: seq - 1,
            },
          ]);
          const broj = await once(db, tip, 2026);
          viđeni.set(broj, [...(viđeni.get(broj) ?? []), tip]);
        }

        for (const [broj, tipovi] of viđeni) {
          // Isti string smeju da dele SAMO vrste iz zajedničkog niza faktura — tamo
          // ga brojač po konstrukciji nikad ne izda dvaput (testovi iznad). Poruka
          // nosi i broj i vrste, da se pri padu odmah vidi KO se sa kim sudario.
          expect({
            broj,
            tipovi,
            dozvoljeno: tipovi.length === 1 || tipovi.every(nizFaktura),
          }).toMatchObject({ dozvoljeno: true });
        }

        // Onoliko različitih stringova koliko ima sopstvenih serija, plus jedan
        // zajednički za ceo niz faktura.
        const sopstvene = vrste.filter((t) => !nizFaktura(t));
        expect(viđeni.size).toBe(1 + sopstvene.length);
      }
    });

    it("BRANA: dve vrste ne smeju da dele isti prefiks serije", () => {
      // Sudar prefiksa je isti kvar kao sudar brojeva, samo unesen jednim redom u
      // registru (npr. `["REV", "A-"]`). Test iznad bi ga uhvatio tek ako obe vrste
      // stignu do istog rednog broja; ovaj ga hvata odmah i imenom.
      const sopstveni = [...DOCUMENT_SERIES.values()].filter((p) => p !== "");
      expect(new Set(sopstveni).size).toBe(sopstveni.length);
    });
  });

  /**
   * O-F7 — SVAKA VRSTA VAN NIZA FAKTURA NOSI SVOJ PREFIKS.
   * ─────────────────────────────────────────────────────────────────────────────
   * Nalaz N11 (02.08.2026): O-F6 je razdvojila samo avans, a PROF/PON/REV su ostali
   * na golom `N/GG` — istom obliku kao faktura. Razdvojen brojač tu ne pomaže: dva
   * nezavisna niza oba kreću od 1 i oba daju `1/26`.
   *
   * IZMERENO na starom kodu: `next(tx, "PROF", 2026, 0)` → `1/26`, isto što daje i
   * `next(tx, "IFR", 2026, 0)`. Predračun i faktura postoje ISTOVREMENO kod istog
   * kupca, a kupac po predračunu i plaća — poziv na broj `1/26` je onda gađao
   * fakturu. `REV` je uz to level-0 vrsta koju `carry-over.service.ts` sme da
   * napravi, a `postInvoice` nema filtar vrste, pa proknjižen revers upisuje svoj
   * `N/GG` u `ledger_entries`, gde se stavke grupišu SAMO po broju.
   */
  describe("svaka serija van niza faktura ima svoj prefiks (O-F7)", () => {
    it("PROF, PON i REV nose prefiks svoje serije", async () => {
      const db = makeDb();
      await expect(once(db, "PROF", 2026)).resolves.toBe("PROF-1/26");
      await expect(once(db, "PON", 2026)).resolves.toBe("PON-1/26");
      await expect(once(db, "REV", 2026)).resolves.toBe("REV-1/26");
    });

    it("prefiks ne dira ostatak formata (bez vodećih nula, dvocifrena godina)", async () => {
      const db = makeDb([
        {
          id: 1,
          documentType: "PROF",
          year: 2026,
          companyId: 0,
          lastNumber: 9,
        },
      ]);
      await expect(once(db, "PROF", 2026)).resolves.toBe("PROF-10/26");
      await expect(once(db, "PON", 2005)).resolves.toBe("PON-1/05");
    });

    it("SCENARIO: predračun i faktura sa istim rednim brojem su različiti stringovi", async () => {
      // Kupac drži predračun broj 12 i fakturu broj 12 iste godine. Dok su oba `12/26`,
      // uplata po predračunu zatvara fakturu — a predračuna u glavnoj knjizi nema, pa
      // nema ni čemu drugom da sleti.
      const db = makeDb([
        {
          id: 1,
          documentType: INVOICE_SEQUENCE_KEY,
          year: 2026,
          companyId: 0,
          lastNumber: 11,
        },
        {
          id: 2,
          documentType: "PROF",
          year: 2026,
          companyId: 0,
          lastNumber: 11,
        },
      ]);

      const faktura = await once(db, "IFR", 2026);
      const predracun = await once(db, "PROF", 2026);

      expect(faktura).toBe("12/26");
      expect(predracun).toBe("PROF-12/26");
      expect(faktura).not.toBe(predracun);
    });

    it("NEUPISANA vrsta ne dobija broj — 422, ne izmišljen prefiks (V-B)", async () => {
      // Brana od zaborava: vrsta koju niko nije upisao u registar NE pada na goli
      // `N/GG` (što bi je tiho spojilo sa fakturom u otvorenim stavkama), ali od nalaza
      // V-B ne dobija ni izmišljen prefiks `XYZ-`. Razlog je na drugom kraju: da bi
      // parser poziva na broj umeo da pročita bilo koji izmišljen prefiks, morao je da
      // drži pravilo „svaka šifra uz crticu je serija", a ono je merenjem pojelo 29
      // legitimnih oblika PNB-a (`IFR-657/25`, `RAC-657/25`, `PDV-`, `NAL-`…).
      const db = makeDb();
      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "XYZ", 2026)).rejects.toThrow(
        /registru numeracije/,
      );
      // Odbijanje puca PRE upisa — nijedan red sekvence ne ostaje za odbijenu vrstu.
      expect(db.rows.filter((r) => r.documentType === "XYZ")).toHaveLength(0);
    });
  });

  /**
   * 🔴 NEUPISANA VRSTA SE ODBIJA — PREFIKS SE NE IZMIŠLJA (nalaz V-B, šesti krug 02.08.2026).
   * ─────────────────────────────────────────────────────────────────────────────
   * Put dosad: prefiks za neupisanu vrstu je prvo bio gol `${documentType}-` bez ijedne
   * provere (pa je `seriesPrefixFor("A")` davao prefiks avansa uz DRUGI brojač — dva
   * nezavisna niza koja oba upisuju `A-1/26`), zatim ga je nalaz V4 sveo na „nedvosmislenu
   * šifru od 2–5 slova". Šesti krug je pokazao da i taj ostatak plaća previše, i to na
   * DRUGOM kraju sistema: da bi parser poziva na broj umeo da pročita bilo koji izmišljen
   * prefiks, morao je da drži pravilo „svaka 2–5 slova + `-` + cifra je serija". To je
   * merenjem pojelo 29 legitimnih oblika PNB-a — `IFR-657/25` (naša sopstvena šifra vrste),
   * `RAC-657/25`, `FAK-`, `PDV-`, `POZ-`, `NAL-`, `UG-`, `NAR-`, `OTP-`… — kojima je tačan
   * broj fakture NESTAJAO iz kandidata, pa je uparivanje padalo na uparivanje po iznosu.
   *
   * ODLUKA: registar (`DOCUMENT_SERIES`) je jedini izvor prefiksa na obe strane. Numeracija
   * ume da izda samo ono što parser ume da pročita. Vrsta van registra puca GLASNO pri
   * izdavanju broja, sa porukom koja kaže šta da se uradi.
   *
   * IZMERENO da to ne dira nijedan živi tok: `createProforma` prima samo `PON`/`PROF`,
   * `carry-over.service.ts` samo `IFR`/`IFGP`/`IFUSL`/`IZVRO`/`IZVGP`/`IZVUS`/`REV`, a
   * `advance-invoice.service.ts` isključivo `AVR` — sve su u registru.
   */
  describe("neupisana vrsta se odbija, prefiks se ne izmišlja (V-B)", () => {
    it("šifra van registra više NE dobija prefiks — ni nedvosmislena", () => {
      // Ranije: `XYZ-`, `OTP-`. Sada 422 — jer parser te prefikse ne poznaje, pa bi
      // uplata pozvana na takav broj ostala bez ijednog kandidata sa serijom.
      expect(() => seriesPrefixFor("XYZ")).toThrow(/registru numeracije/);
      expect(() => seriesPrefixFor("OTP")).toThrow(/registru numeracije/);
    });

    it("šifra koja se poklapa sa registrovanom serijom se ODBIJA", () => {
      // `A` bi dalo prefiks avansa uz drugi brojač → dva `A-1/26`.
      expect(() => seriesPrefixFor("A")).toThrow();
      // `AVR2`/`PON2` parser čita kao `AVR`/`PON` + broj → pogodak u tuđi dokument.
      expect(() => seriesPrefixFor("AVR2")).toThrow();
      expect(() => seriesPrefixFor("PON2")).toThrow();
      expect(() => seriesPrefixFor("PROFX")).toThrow();
    });

    it("neispravan oblik šifre se ODBIJA (isto kao pre — menja se samo poruka)", () => {
      expect(() => seriesPrefixFor("NEPOZNATA_VRSTA")).toThrow();
      expect(() => seriesPrefixFor("IZLAZNA1")).toThrow();
      expect(() => seriesPrefixFor("")).toThrow();
      // Nalaz N-A: cifra u šifri je i pre i posle izmene 422. `TREB1` postoji u seed-u
      // `accounting_schemes.order_type`, pa je ovo stvaran, a ne izmišljen ulaz.
      expect(() => seriesPrefixFor("TREB1")).toThrow();
    });

    /**
     * NALAZ N-A: mala slova su bila TIHA RUPA. `seriesPrefixFor("avr")` je bacao 422
     * (šifra se normalizovala pa sudarala sa `AVR`), ali `seriesPrefixFor("ifr")` je
     * vraćao `"IFR-"` uz `sequenceKeyFor("ifr") = "ifr"` — DRUGI brojač koji izdaje
     * `IFR-1/26` dok `IFR` izdaje goli `1/26`. Sada je `DOCUMENT_SERIES.get` jedini put,
     * pa registar razlikuje velika i mala slova na jednom jedinom mestu.
     */
    it("mala slova nisu druga serija — nema tihog drugog brojača (N-A)", () => {
      expect(() => seriesPrefixFor("ifr")).toThrow();
      expect(() => seriesPrefixFor("avr")).toThrow();
      expect(seriesPrefixFor("IFR")).toBe("");
      expect(seriesPrefixFor("AVR")).toBe("A-");
    });

    it("odbijanje puca pri IZDAVANJU broja, ne tiho (rollback transakcije)", async () => {
      const db = makeDb();
      await expect(once(db, "AVR2", 2026)).rejects.toThrow();
      // Nijedan red sekvence nije ostao za odbijenu vrstu.
      expect(db.rows).toHaveLength(0);
    });

    /**
     * BRANA KOJA ZATVARA KRUG: prefiks koji numeracija ume da UPIŠE mora biti prefiks
     * koji parser ume da PROČITA. Pošto fallbacka nema, to znači: skup izdatih prefiksa
     * je tačno registar. Test drži tu jednakost — vrsta van registra ne sme da dobije broj.
     */
    it("BRANA: skup prefiksa koje numeracija izdaje = registar, ništa više", () => {
      for (const [tip, prefix] of DOCUMENT_SERIES) {
        expect(seriesPrefixFor(tip)).toBe(prefix);
      }
      for (const izmisljena of ["XYZ", "OTP", "KOMP", "IFR2", "NOVA"]) {
        expect(DOCUMENT_SERIES.has(izmisljena)).toBe(false);
        expect(() => seriesPrefixFor(izmisljena)).toThrow();
      }
    });
  });

  describe("trka (dva paralelna zahteva)", () => {
    it("DVE RAZLIČITE vrste paralelno: brava je ista → 2/26 i 3/26, nikad isti broj", async () => {
      // Ključ testa: IFR i IFUSL sada dele red sekvence, pa ih FOR UPDATE
      // serijalizuje međusobno. Sa brojačem po vrsti oba bi dobila isti broj.
      const db = makeDb([
        {
          id: 1,
          documentType: INVOICE_SEQUENCE_KEY,
          year: 2026,
          companyId: 0,
          lastNumber: 1,
        },
      ]);

      const a = db.tx();
      const b = db.tx();
      const pa = service.next(a.client, "IFR", 2026, 0);
      const pb = service.next(b.client, "IFUSL", 2026, 0);

      // A commit-uje tek pošto je uzeo broj; B do tada čeka na bravi reda.
      const first = await pa;
      a.commit();
      const second = await pb;
      b.commit();

      expect([first, second].sort()).toEqual(["2/26", "3/26"]);
      expect(first).not.toBe(second);
      expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(3);
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

  /**
   * BRANA O-F11: IZDAT BROJ NE SME VEĆ POSTOJATI U KNJIZI.
   * ═══════════════════════════════════════════════════════════════════════════
   * Povod je preuzimanje 01.04.2027 — USRED godine. Izmereno nad uvezenom knjigom
   * 2026: BigBit je već izdao izlazne fakture u TAČNO našem obliku `N/GG` bez vodeće
   * nule (IFR 95 brojeva `100/26`–`261/26`, IFUSL 32, IFGP 21). Da 4.0 krene od 1,
   * izdavao bi brojeve koje BigBit u istoj godini već ima — a otvorene stavke se
   * grupišu po `(konto, komitent, broj)` BEZ vrste dokumenta, pa bi se dve različite
   * obaveze tiho spojile u jednu.
   */
  describe("brana: broj koji je već u knjizi se ne izdaje ponovo (O-F11)", () => {
    it("zauzet kandidat se PRESKAČE — knjiga ima 1/26, izdaje se 2/26", async () => {
      const db = makeDb([], ["1/26"]);
      await expect(once(db, "IFR", 2026)).resolves.toBe("2/26");
      // Brojač MORA da zapamti preskočenu vrednost; da upiše 1, sledeći poziv bi
      // ponovo naleteo na isti zauzet broj — i tako svaki put.
      expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(2);
    });

    it("preskače VIŠE uzastopnih zauzetih (1,2,3 u knjizi → 4/26)", async () => {
      const db = makeDb([], ["1/26", "2/26", "3/26"]);
      await expect(once(db, "IFR", 2026)).resolves.toBe("4/26");
      expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(4);
    });

    it("preskače i kad brojač već postoji (zatečen 43, knjiga ima 44/26 → 45/26)", async () => {
      const db = makeDb(
        [
          {
            id: 1,
            documentType: INVOICE_SEQUENCE_KEY,
            year: 2026,
            companyId: 0,
            lastNumber: 43,
          },
        ],
        ["44/26"],
      );
      await expect(once(db, "IFR", 2026)).resolves.toBe("45/26");
    });

    it("SERIJE SU NEZAVISNE: `A-1/26` u knjizi ne blokira fakturu `1/26`", async () => {
      // Cela odbrana od spajanja stavki počiva na tome da su serije disjunktne kao
      // STRINGOVI (O-F6/O-F7). Da brana gleda goli redni broj umesto celog broja
      // dokumenta, avansni račun bi trošio brojeve izlaznih faktura.
      const db = makeDb([], ["A-1/26", "PROF-1/26", "PON-1/26", "REV-1/26"]);
      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
    });

    it("🔴 DOBAVLJAČEV broj na ulaznoj fakturi NE zauzima naš broj", async () => {
      // IZMERENO NA PRODUKCIJI 05.08.2026: `ledger_entries.document_number` drži i
      // DOBAVLJAČEVE brojeve sa ulaznih faktura. Brojevi oblika `N/26` bez prefiksa:
      //   konto 435 (dobavljači)         581 stavki, najveći 14.630
      //   konto 270 (PDV u ulaznim f.)   252 stavki, najveći 138.030
      //   konto 204 (KUPCI)              411 stavki, najveći      261  ← naš niz
      // Da brana meri celu knjigu, `1/26` bi bio „zauzet" dobavljačevim dokumentom i
      // numeracija bi preskakala brojeve koji su za naš niz sasvim slobodni — a ekran
      // bi tražio startni broj 138.030 i odbijao tačnu vrednost 261.
      //
      // Sudar je nemoguć jer se otvorene stavke grupišu po (KONTO, komitent, broj):
      // dobavljačev dokument stoji na 43x uz dobavljača, naš na 204x uz kupca.
      const db = makeDb(
        [],
        [
          { number: "1/26", accountCode: "4350" }, // obaveza prema dobavljaču
          { number: "2/26", accountCode: "2700" }, // PDV u primljenoj fakturi
          { number: "3/26", accountCode: "1320" }, // roba u magacinu
        ],
      );
      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
    });

    it("naš broj na KUPČEVOM kontu i dalje zauzima (2050 izvoz, 2023 ostali kupci)", async () => {
      // Cela klasa 20 je „Potraživanja od kupaca" — izvozna faktura ide na 2050, a
      // deo zatečenih dokumenata na 2023. Brana ne sme da gleda samo 2040.
      const db = makeDb([], [{ number: "1/26", accountCode: "2050" }]);
      await expect(once(db, "IFR", 2026)).resolves.toBe("2/26");

      const db2 = makeDb([], [{ number: "1/26", accountCode: "2023" }]);
      await expect(once(db2, "IFR", 2026)).resolves.toBe("2/26");
    });

    it("GODINA JE DEO POKLAPANJA: `1/25` u knjizi ne blokira `1/26`", async () => {
      const db = makeDb([], ["1/25"]);
      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
    });

    it("avans preskače u SVOJOJ seriji (`A-1/26` zauzet → `A-2/26`)", async () => {
      const db = makeDb([], ["A-1/26"]);
      await expect(once(db, "AVR", 2026)).resolves.toBe("A-2/26");
    });

    it("BigBit scenario: podešen startni broj 261 → 262/26, BEZ ijednog preskoka", async () => {
      // Ovo je ishod zbog kog ekran „Brojači dokumenata" i postoji: kad je startni broj
      // upisan, brana nema šta da radi i niz teče bez rupa.
      const book = Array.from({ length: 162 }, (_, i) => `${100 + i}/26`); // 100/26 … 261/26
      const db = makeDb(
        [
          {
            id: 1,
            documentType: INVOICE_SEQUENCE_KEY,
            year: 2026,
            companyId: 0,
            lastNumber: 261,
          },
        ],
        book,
      );
      await expect(once(db, "IFR", 2026)).resolves.toBe("262/26");
      expect(db.find(INVOICE_SEQUENCE_KEY, 2026, 0)?.lastNumber).toBe(262);
    });

    it("preko granice preskoka STAJE GLASNO i uputi na Podešavanja (422)", async () => {
      // Zaostatak veći od `MAX_COLLISION_SKIP` nije slučajan sudar nego nepodešen
      // brojač; tiho preskakanje bi „popravilo" podešavanje koje čovek treba da potvrdi.
      const book = Array.from(
        { length: MAX_COLLISION_SKIP + 1 },
        (_, i) => `${i + 1}/26`,
      );
      const db = makeDb([], book);
      await expect(once(db, "IFR", 2026)).rejects.toMatchObject({
        status: 422,
      });
      await expect(once(db, "IFR", 2026)).rejects.toThrow(/Brojači dokumenata/);
    });

    it("tačno na granici preskoka još uspeva (50 zauzetih → 51/26)", async () => {
      const book = Array.from(
        { length: MAX_COLLISION_SKIP },
        (_, i) => `${i + 1}/26`,
      );
      const db = makeDb([], book);
      await expect(once(db, "IFR", 2026)).resolves.toBe(
        `${MAX_COLLISION_SKIP + 1}/26`,
      );
    });
  });

  /**
   * REGISTAR SERIJA ZA EKRAN — izveden iz `DOCUMENT_SERIES`, ne prekucan.
   * Ekran „Brojači dokumenata" prikazuje serije IZ KODA, jer je
   * `document_number_sequences` na produkciji imala 0 redova — spisak građen iz baze
   * bi dao praznu stranu baš tamo gde se startni broj upisuje.
   */
  describe("registar serija za ekran brojača", () => {
    it("svaka serija iz registra numeracije ima naziv za čoveka", () => {
      // Bez ovoga bi nova serija na ekranu izašla kao gola šifra (`@FAKTURA`) ili ne bi
      // izašla uopšte — pa bi joj startni broj ostao nepodesiv.
      for (const s of DOCUMENT_SERIES_REGISTRY) {
        expect(s.label).toBeTruthy();
        expect(s.label).not.toBe(s.key);
      }
    });

    it("registar pokriva TAČNO ključeve brojača iz `DOCUMENT_SERIES`", () => {
      const izKoda = new Set(
        [...DOCUMENT_SERIES.keys()].map((t) => sequenceKeyFor(t)),
      );
      const izRegistra = new Set(DOCUMENT_SERIES_REGISTRY.map((s) => s.key));
      expect([...izRegistra].sort()).toEqual([...izKoda].sort());
    });

    it("izlazne fakture su JEDNA serija sa šest vrsta, bez prefiksa", () => {
      const fakture = seriesByKey(INVOICE_SEQUENCE_KEY);
      expect(fakture?.prefix).toBe("");
      expect(fakture?.documentTypes.sort()).toEqual(
        ["IFGP", "IFR", "IFUSL", "IZVGP", "IZVRO", "IZVUS"].sort(),
      );
    });

    it("prefiks u registru je isti onaj koji numeracija stvarno izdaje", () => {
      // Dva izvora prefiksa bi značila da ekran pokazuje `PROF-12/26`, a izda se nešto
      // drugo — a ekran postoji baš da bi se sledeći broj video unapred.
      for (const s of DOCUMENT_SERIES_REGISTRY) {
        for (const t of s.documentTypes) {
          expect(seriesPrefixFor(t)).toBe(s.prefix);
        }
      }
    });

    it("nepoznata serija se ne izmišlja", () => {
      expect(seriesByKey("NEMA-ME")).toBeUndefined();
    });
  });
});
