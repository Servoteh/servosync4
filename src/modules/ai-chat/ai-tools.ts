import type { ToolDef } from "../../common/ai/ai-provider.service";

/**
 * AI asistent — sistem prompt + 18 alata (port edge `ai-chat`, VERBATIM tekst iz
 * supabase/functions/ai-chat/index.ts:76-352,624-630). NETAKNUTA semantika: alati
 * zovu `ai_chat_*` RPC-ove SA identitetom korisnika (scope presuđuje baza). U
 * DELJENOJ projektnoj niti lični/HR alati su ISKLJUČENI (§2 pravilo 11).
 * (Backtick literali — da se sačuvaju svi navodnici/dijakritika 1:1 sa 1.0, §C.)
 */

export const SYSTEM_PROMPT =
  `Ti si „Servosync AI asistent" — interni pomoćnik zaposlenima firmi SERVOTEH i ` +
  `HAP FLUID (Srbija; mašinska proizvodnja, montaža, hidraulika i automatizacija). ` +
  `Kad se predstavljaš, reci da si tu za SVA pitanja o aplikaciji Servosync i o ` +
  `poslu u Servotehu i HAP Fluidu. Odgovaraj na srpskom ` +
  `jeziku, LATINICOM (osim ako korisnik izričito traži drugačije), jasno, tačno i ` +
  `prijateljski. Pomažeš u svemu: pisanje i prepravka tekstova i mejlova, prevodi, ` +
  `računanje, Excel formule, tehnička i opšta pitanja.\n\n` +
  `O aplikaciji Servosync (interni ERP/MES; desktop servosync.servoteh.com, mobilni deo na /m):\n` +
  `• Moduli: Projektovanje (plan rada projektnog biroa), Montaža (plan montaže po ` +
  `projektima + AI izveštaji montera; mobilno „Novi izveštaj" na /m/izvestaj), ` +
  `Proizvodnja (planiranje i praćenje po mašinama/RN), Lokacije delova, Reversi ` +
  `(zaduženja alata i opreme), Održavanje (mašine, vozila, objekti, IT), Sastanci ` +
  `(dnevni red, zapisnici, akcioni plan), Kadrovska (samo HR/rukovodstvo), ` +
  `Energetika/SCADA (admin), Podešavanja (admin).\n` +
  `• Moj profil: GO saldo i zahtevi za godišnji odmor, evidencija sati, opis pozicije, dokumenti.\n` +
  `• Mobilni /m: Za mene (GO, sati, odobravanja), Profil, Više (svi moduli).\n` +
  `• Polja sa 🎤 podržavaju diktiranje (izgovori „povlaka" za -, „kroz" za /), a ✨ dugme ` +
  `AI-jem doteruje izdiktiran tekst.\n\n` +
  `PODACI IZ APLIKACIJE (Faza 2): imaš ALATE — trazi_zaposlenog, go_saldo, go_pregled ` +
  `(KOMPLETAN status godišnjeg u jednom pozivu: preneto, zarađeno/pravo, iskorišćeni i ` +
  `planirani periodi, preostalo — koristi za „status/pregled godišnjeg sa danima koje sam ` +
  `koristio"), sati_mesec, ` +
  `moj_tim, odsustva_lista (konkretni dani/periodi odmora i odsustava), go_zahtevi, ` +
  `pretrazi_uputstva (baza uputstava, pravilnika i organizacije firme — OBAVEZNO za ` +
  `pitanja „kako da…", „gde je…", „koja su pravila…"; odgovaraj po koracima iz ` +
  `uputstva), dodaj_uputstvo (samo admin/HR, na izričit zahtev), ` +
  `i sql_upit (slobodan read-only SELECT, radi SAMO administratorima/HR-u). ` +
  `ODRŽAVANJE: masina_info (karton + dokumenti), masina_uputstvo (pretraga ` +
  `uputstava/dokumentacije mašine — za „kako se…", greške, podešavanja), ` +
  `kvar_istorija (slični raniji kvarovi i kako su rešeni — pozovi PRE predloga ` +
  `rešenja), prijavi_kvar (prvo prikupi podatke i pokaži rezime pa uz potvrdu ` +
  `prijavi). Kod predloga za rešavanje kvara osloni se na kvar_istorija i ` +
  `masina_uputstvo; bezbednosne radnje (isključenje, električni ormari, LOTO) ` +
  `sme samo ovlašćen tehničar — uvek to napomeni. ` +
  `Kad korisnik pita za godišnji odmor, sate iz evidencije ili svoj tim, ` +
  `POZOVI alat i brojeve navodi ISKLJUČIVO iz rezultata alata — nikad napamet. ` +
  `Za „status/pregled godišnjeg sa danima koje sam koristio" pozovi go_pregled i ` +
  `sastavi KOMPLETNU poruku ovim redom: (1) preneto iz prošle godine ako ga ima; ` +
  `(2) godišnje pravo (za novozaposlene sa srazmernim sticanjem navedi „zarađeno do ` +
  `danas"); (3) lista „Iskorišćeni dani" (od–do + broj dana iz periodi_iskorisceno); ` +
  `(4) lista „Planirani/odobreni dani" (periodi_planirano); (5) zaključi sa „Preostalo ` +
  `slobodnih dana zaključno sa DD.MM.YYYY.: X" (polje preostalo_zakljucno_sa_danas). ` +
  `Ako neka lista prazna, reci to kratko umesto praznog naslova. ` +
  `Prava proverava baza za svaki poziv: običan zaposleni vidi samo sebe, rukovodilac ` +
  `svoje zaposlene, admin/HR sve. Ako alat vrati nema_prava ili prazno — reci to ` +
  `otvoreno, bez izmišljanja. Kad korisnik pomene ime, prvo trazi_zaposlenog pa alat ` +
  `sa dobijenim employee_id; ako ima više pogodaka, pitaj koji je. Za ostale podatke ` +
  `(plate, dokumenti, zahtevi) uputi na odgovarajući ekran, a ako ne znaš gde je nešto ` +
  `u aplikaciji, reci da pita administratora (Nenad).\n\n` +
  `NAVIGACIJA (OBAVEZNO): kad korisnik pita GDE se nešto nalazi, KOJI tabovi/ekrani ` +
  `postoje ili KAKO se nešto radi u aplikaciji, PRVO pozovi pretrazi_uputstva i odgovori ` +
  `po nađenom uputstvu (navedi modul → tab → korake). NIKAD ne reci „nemam informaciju o ` +
  `lokaciji" niti upućuj na administratora pre nego što pretražiš uputstva.\n` +
  `SLIKE: ako je uz poruku priložena slika, pažljivo je analiziraj i odgovori na pitanje o ` +
  `njoj (npr. greška na ekranu mašine, električna šema, fotografija kvara, dokument).`;

/** Datum-linija koja se dodaje sistem promptu (danas u Beogradu — bez nagađanja). */
export function todayBelgrade(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}.`;
}

/** VERBATIM index.ts:624-630 — kritično za GO periode (iskorisceno/u_toku/planirano). */
export const DATE_LINE = () =>
  `\n\nDANAŠNJI DATUM: ${todayBelgrade()} (Beograd). Kad opisuješ periode iz alata ` +
  `(odsustva_lista, go_zahtevi): NIKAD ne nazivaj period „iskorišćen" ako počinje POSLE ` +
  `današnjeg datuma — takav period je „planiran"/„zakazan", makar zahtev bio odobren. ` +
  `Oslanjaj se na polje „vremenski_status" (iskorisceno/u_toku/planirano) i na ` +
  `„ukupno_iskorisceno_po_tipu" vs „ukupno_planirano_po_tipu" iz odsustva_lista — nikad ne ` +
  `sabiraj ih zajedno kao „iskorišćeno do sada".`;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "trazi_zaposlenog",
    description: `Pronađi zaposlene po delu imena/prezimena, u okviru prava pozivaoca (običan radnik: samo on; rukovodilac: njegovi; admin/HR: svi). Vraća i „ja" (karton pozivaoca). Dijakritici i redosled ime/prezime nisu bitni.`,
    input: {
      type: "object",
      properties: {
        ime: {
          type: "string",
          description: `deo imena ili prezimena; prazno = samo moj karton`,
        },
      },
      required: [],
    },
  },
  {
    name: "go_saldo",
    description: `Saldo godišnjeg odmora za tekuću godinu: godišnje pravo, preneto, iskorišćeno, planirano ubuduće i preostalo (isti broj kao u aplikaciji). Za novozaposlene sa srazmernim sticanjem vraća i zarađeno do danas. Bez employee_id → za pozivaoca.`,
    input: {
      type: "object",
      properties: {
        employee_id: {
          type: "string",
          description: `UUID iz trazi_zaposlenog; izostavi za sebe`,
        },
      },
      required: [],
    },
  },
  {
    name: "sati_mesec",
    description: `Zbir sati iz evidencije za mesec: redovno, prekovremeno, teren, dve mašine + dani odsustva po tipu. Bez employee_id → pozivalac; bez godina/mesec → tekući mesec.`,
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
        mesec: { type: "integer", description: `1–12` },
      },
      required: [],
    },
  },
  {
    name: "moj_tim",
    description: `Lista zaposlenih koje pozivalac sme da vidi (rukovodilac: tim; admin/HR: svi; ostali: samo sebe) sa preostalim danima GO i ko je danas odsutan (šifra odsustva).`,
    input: { type: "object", properties: {}, required: [] },
  },
  {
    name: "odsustva_lista",
    description: `Periodi odsustva zaposlenog iz evidencije za godinu (od–do datumi + broj dana). Šifre: go=godišnji, bo=bolovanje, pr=praznik, sp=slobodan dan, np/nop=neplaćeno, sv=slava/verski. Bez employee_id → pozivalac; bez godine → tekuća; tip filtrira po šifri. Svaki period ima „vremenski_status" (iskorisceno/u_toku/planirano) — NIKAD ne opisuj „planirano" period kao već iskorišćen; koristi „ukupno_iskorisceno_po_tipu" za „koliko je iskoristio DO SADA" i „ukupno_planirano_po_tipu" za buduće/zakazano.`,
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
        tip: { type: "string", description: `npr. go` },
      },
      required: [],
    },
  },
  {
    name: "go_zahtevi",
    description: `Zahtevi za godišnji odmor zaposlenog (od–do, broj dana, status odobravanja, napomena). Bez employee_id → pozivalac. Svaki zahtev ima i „vremenski_status" (iskorisceno/u_toku/planirano prema današnjem datumu) — odobren zahtev sa datumom u budućnosti je „planiran", NE „iskorišćen".`,
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
        godina: { type: "integer" },
      },
      required: [],
    },
  },
  {
    name: "go_pregled",
    description: `KOMPLETAN pregled godišnjeg odmora za tekuću godinu U JEDNOM POZIVU — koristi ga za „status/pregled godišnjeg sa danima koje sam koristio". Vraća: godišnje pravo, preneto iz prošle godine, (za novozaposlene sa srazmernim sticanjem) zarađeno do danas, ukupno na raspolaganju, iskorišćeno, planirano, preostalo zaključno sa danas, te odvojene liste „periodi_iskorisceno" i „periodi_planirano" (od–do + broj dana). Bez employee_id → za pozivaoca. Ne treba dodatno zvati go_saldo/odsustva_lista.`,
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: `UUID; izostavi za sebe` },
      },
      required: [],
    },
  },
  {
    name: "projekat_info",
    description: `Presek PROJEKTA po broju (npr. 9400/7): osnovno (naziv, status, rok, PM), plan montaže (pozicije, napredak, blokade), poslednji izveštaji montera, otvorene akcije sa sastanaka, stavke projektnih sastanaka i beleške tima. Koristi za svako pitanje „šta se dešava na projektu X".`,
    input: {
      type: "object",
      properties: {
        projekat: {
          type: "string",
          description: `broj projekta, npr. 9400/7`,
        },
      },
      required: ["projekat"],
    },
  },
  {
    name: "pretrazi_znanje",
    description: `Pretraga baze znanja: beleške tima + tekst izveštaja montera, po pojmu (dijakritici nebitni). Opcioni filter po projektu. Koristi za „zašto smo odlučili…", „da li je već bilo problema sa…".`,
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: `pojam pretrage` },
        projekat: { type: "string", description: `opciono: broj projekta` },
      },
      required: ["upit"],
    },
  },
  {
    name: "dodaj_belesku",
    description: `Sačuvaj belešku/odluku u bazu znanja projekta. Koristi ISKLJUČIVO kad korisnik izričito traži da se nešto zapiše/sačuva („zapiši ovo", „sačuvaj kao odluku"). Autor se beleži automatski.`,
    input: {
      type: "object",
      properties: {
        projekat: { type: "string", description: `broj projekta, npr. 9400/7` },
        naslov: { type: "string", description: `kratak naslov beleške` },
        tekst: { type: "string", description: `sadržaj beleške` },
      },
      required: ["projekat", "tekst"],
    },
  },
  {
    name: "opis_pozicije",
    description: `Sistematizacija: opis radnog mesta (svrha, odgovornosti, ovlašćenja, KPI, kvalifikacije, kome odgovara). Bez naziva → lista SVIH pozicija sa linijom nadređenosti (za pitanja o organizaciji firme).`,
    input: {
      type: "object",
      properties: {
        pozicija: {
          type: "string",
          description: `deo naziva pozicije (npr. "monter", "vođa projekta"); prazno = lista svih`,
        },
      },
      required: [],
    },
  },
  {
    name: "pretrazi_uputstva",
    description: `Pretraga BAZE UPUTSTAVA I PRAVILA firme (kako se šta radi u aplikaciji, pravilnici, organizacija, kućna pravila) — tekstualno + semantički. OBAVEZNO pozovi za svako pitanje tipa „kako da…", „gde se nalazi…", „koja su pravila za…". Odgovaraj po koracima iz uputstva.`,
    input: {
      type: "object",
      properties: {
        upit: {
          type: "string",
          description: `pitanje ili pojam (npr. "zahtev za godišnji odmor")`,
        },
      },
      required: ["upit"],
    },
  },
  {
    name: "dodaj_uputstvo",
    description: `Sačuvaj/ažuriraj UPUTSTVO ili pravilo u bazu znanja firme (radi SAMO administratorima i HR-u; upsert po naslovu). Koristi isključivo kad korisnik izričito traži da se uputstvo sačuva.`,
    input: {
      type: "object",
      properties: {
        naslov: { type: "string" },
        sadrzaj: {
          type: "string",
          description: `koraci/tekst, srpski latinica`,
        },
        modul: {
          type: "string",
          description: `moj-profil|mobilna-app|montaza|sastanci|odrzavanje|reversi|ai-asistent|organizacija|kadrovska|opste`,
        },
        kljucne_reci: { type: "string", description: `sinonimi za pretragu` },
        vidljivost: {
          type: "string",
          description: `'svi' (default) ili 'admin_hr' (vidljivo samo administraciji/HR-u)`,
        },
      },
      required: ["naslov", "sadrzaj"],
    },
  },
  {
    name: "inzenjering_pretraga",
    description: `Baza znanja INŽENJERINGA (modul Projektovanje): pretraga zadataka inženjera (naziv/opis/problem), komentara i dnevnih radnih izveštaja. Opcioni filter po projektu. Koristi za „da li je neko već radio…", „šta je inženjering rekao o…", „na čemu radi projektni biro".`,
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: `pojam pretrage` },
        projekat: {
          type: "string",
          description: `opciono: broj projekta (npr. 9400/7)`,
        },
      },
      required: ["upit"],
    },
  },
  {
    name: "masina_info",
    description: `Karton mašine iz Održavanja (naziv, proizvođač, model, lokacija) + otvoreni kvarovi, poslednje kontrole i spisak dostupnih dokumenata (uputstva/šeme). Prima šifru (npr. 8.3) ili deo naziva.`,
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
      },
      required: ["masina"],
    },
  },
  {
    name: "kvar_istorija",
    description: `Istorija kvarova iz Održavanja — za „da li se sličan problem već dešavao": pretraga prijava (opis + REŠENJE + napomene tehničara). Opcioni filter po mašini i/ili pojmu. Koristi PRE davanja predloga za rešavanje.`,
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: `opciono: šifra/naziv mašine` },
        upit: {
          type: "string",
          description: `opciono: pojam (npr. „curi ulje", „ne pali")`,
        },
      },
      required: [],
    },
  },
  {
    name: "masina_uputstvo",
    description: `Pretraga UPUTSTAVA I DOKUMENTACIJE mašine (PDF-ovi otpremljeni u Održavanje) — semantički + tekstualno; vraća odlomke sa nazivom dokumenta i brojem strane. Koristi za „kako se…", „šta znači greška…", „gde je podešavanje…" na konkretnoj mašini.`,
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
        pitanje: { type: "string", description: `šta se traži u uputstvu` },
      },
      required: ["masina", "pitanje"],
    },
  },
  {
    name: "prijavi_kvar",
    description: `Prijavi kvar na mašini u modul Održavanje. PRE poziva prikupi kroz razgovor: mašinu, kratak naslov, opis, ozbiljnost i da li postoji bezbednosni rizik; POKAŽI korisniku rezime i sačekaj izričitu potvrdu, pa pozovi alat. Ako korisnik nema prava, alat vrati nema_prava.`,
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: `šifra ili naziv mašine` },
        naslov: { type: "string", description: `kratak opis kvara` },
        opis: {
          type: "string",
          description: `detalji: šta se dešava, kada, simptomi`,
        },
        ozbiljnost: {
          type: "string",
          description: `normal | minor | important | major | critical`,
        },
        bezbednosni_rizik: {
          type: "boolean",
          description: `true ako kvar predstavlja opasnost`,
        },
      },
      required: ["masina", "naslov"],
    },
  },
  {
    name: "sql_upit",
    description: `SAMO ZA ADMIN/HR (ostali dobiju nema_prava): slobodan READ-ONLY SQL upit nad bazom — jedan SELECT/WITH, bez tačke-zapete i komentara, max 200 redova, timeout 4s; RLS važi kao za pozivaoca. Ako ne znaš šemu, prvo upitaj information_schema.columns (table_schema=public). Na sql_greska ispravi upit i pokušaj ponovo.`,
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: `SELECT … (bez ; na kraju)` },
      },
      required: ["upit"],
    },
  },
];

/** U DELJENOJ projektnoj niti nema ličnih/HR alata (poruke vide svi!) — §2 pravilo 11. */
export const PROJECT_TOOL_NAMES = [
  "projekat_info",
  "pretrazi_znanje",
  "dodaj_belesku",
  "pretrazi_uputstva",
  "opis_pozicije",
  "inzenjering_pretraga",
];

export function toolsForScope(scope: "personal" | "project"): ToolDef[] {
  return scope === "project"
    ? TOOL_DEFS.filter((t) => PROJECT_TOOL_NAMES.includes(t.name))
    : TOOL_DEFS;
}
