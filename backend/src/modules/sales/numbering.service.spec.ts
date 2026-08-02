import { Prisma } from "@prisma/client";
import {
  DOCUMENT_SERIES,
  DocumentNumberSequenceService,
  INVOICE_SEQUENCE_KEY,
  sequenceKeyFor,
} from "./numbering.service";

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
function makeDb(seed: SeqRow[] = []) {
  const rows: SeqRow[] = [...seed];
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const locks = new Map<string, Promise<void>>();

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

  return { rows, tx, find };
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
     * „NEPOZNATA_VRSTA" pokriva i suprotan propust — vrstu koju niko nije upisao u
     * registar. Ona po konstrukciji dobija prefiks iz sopstvene šifre, pa ni ona ne
     * može da se poklopi sa fakturom.
     */
    it("BRANA: serije su međusobno disjunktne za SVAKI redni broj (spisak iz registra)", async () => {
      const vrste = [...DOCUMENT_SERIES.keys(), "NEPOZNATA_VRSTA"];
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

    it("NEUPISANA vrsta ne može da se sudari sa fakturom (prefiks iz šifre vrste)", async () => {
      // Brana od zaborava: vrsta koju niko nije upisao u registar NE pada na goli
      // `N/GG` (što bi je tiho spojilo sa fakturom u otvorenim stavkama), nego dobija
      // prefiks iz sopstvene šifre i svoj brojač. Cena je kozmetička — broj na papiru
      // izgleda `XYZ-1/26` dok se vrsta ne upiše kako treba.
      const db = makeDb();
      await expect(once(db, "IFR", 2026)).resolves.toBe("1/26");
      await expect(once(db, "XYZ", 2026)).resolves.toBe("XYZ-1/26");
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
});
