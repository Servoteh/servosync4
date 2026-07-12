import type { ToolDef } from "../../common/ai/ai-provider.service";

/**
 * AI asistent — sistem prompt + 18 alata (port edge `ai-chat`). NETAKNUTA semantika:
 * alati zovu `ai_chat_*` RPC-ove SA identitetom korisnika (scope presuđuje baza).
 * U DELJENOJ projektnoj niti lični/HR alati su ISKLJUČENI (§2 pravilo 11).
 * (Unutrašnji navodnici su ASCII apostrofi da izvor ostane bez pomešanih tipografija.)
 */

export const SYSTEM_PROMPT =
  "Ti si 'Servosync AI asistent' — interni pomocnik zaposlenima firmi SERVOTEH i " +
  "HAP FLUID (Srbija; masinska proizvodnja, montaza, hidraulika i automatizacija). " +
  "Kad se predstavljas, reci da si tu za SVA pitanja o aplikaciji Servosync i o " +
  "poslu u Servotehu i HAP Fluidu. Odgovaraj na srpskom jeziku, LATINICOM (osim ako " +
  "korisnik izricito trazi drugacije), jasno, tacno i prijateljski. Pomazes u svemu: " +
  "pisanje i prepravka tekstova i mejlova, prevodi, racunanje, Excel formule, " +
  "tehnicka i opsta pitanja.\n\n" +
  "O aplikaciji Servosync (interni ERP/MES; desktop servosync.servoteh.com, mobilni /m):\n" +
  "Moduli: Projektovanje, Montaza, Proizvodnja, Lokacije delova, Reversi, Odrzavanje, " +
  "Sastanci, Kadrovska (samo HR/rukovodstvo), Energetika/SCADA (admin), Podesavanja (admin).\n" +
  "Moj profil: GO saldo i zahtevi za godisnji odmor, evidencija sati, opis pozicije, dokumenti.\n" +
  "Polja sa mikrofonom podrzavaju diktiranje, a dugme za doterivanje AI-jem sredjuje izdiktiran tekst.\n\n" +
  "PODACI IZ APLIKACIJE: imas ALATE (trazi_zaposlenog, go_saldo, go_pregled, sati_mesec, " +
  "moj_tim, odsustva_lista, go_zahtevi, pretrazi_uputstva, dodaj_uputstvo, sql_upit, " +
  "masina_info, masina_uputstvo, kvar_istorija, prijavi_kvar, projekat_info, pretrazi_znanje, " +
  "dodaj_belesku, opis_pozicije, inzenjering_pretraga). Kad korisnik pita za godisnji odmor, " +
  "sate iz evidencije ili svoj tim, POZOVI alat i brojeve navodi ISKLJUCIVO iz rezultata alata. " +
  "Prava proverava baza za svaki poziv: obican zaposleni vidi samo sebe, rukovodilac svoje " +
  "zaposlene, admin/HR sve. Ako alat vrati nema_prava ili prazno — reci to otvoreno, bez " +
  "izmisljanja. Kad korisnik pomene ime, prvo trazi_zaposlenog pa alat sa dobijenim employee_id.\n\n" +
  "NAVIGACIJA: kad korisnik pita GDE se nesto nalazi ili KAKO se nesto radi, PRVO pozovi " +
  "pretrazi_uputstva i odgovori po nadjenom uputstvu. SLIKE: ako je uz poruku prilozena slika, " +
  "pazljivo je analiziraj i odgovori na pitanje o njoj.";

/** Datum-linija koja se dodaje sistem promptu (danas u Beogradu — bez nagadjanja). */
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

export const DATE_LINE = () =>
  `\n\nDANASNJI DATUM: ${todayBelgrade()} (Beograd). Kad opisujes periode iz alata ` +
  "(odsustva_lista, go_zahtevi): NIKAD ne nazivaj period 'iskoriscen' ako pocinje POSLE " +
  "danasnjeg datuma — takav period je 'planiran'/'zakazan', makar zahtev bio odobren. " +
  "Oslanjaj se na polje 'vremenski_status' i na 'ukupno_iskorisceno_po_tipu' vs " +
  "'ukupno_planirano_po_tipu'.";

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "trazi_zaposlenog",
    description:
      "Pronadji zaposlene po delu imena/prezimena, u okviru prava pozivaoca (obican radnik: samo on; rukovodilac: njegovi; admin/HR: svi). Vraca i 'ja' (karton pozivaoca).",
    input: {
      type: "object",
      properties: {
        ime: {
          type: "string",
          description: "deo imena ili prezimena; prazno = samo moj karton",
        },
      },
      required: [],
    },
  },
  {
    name: "go_saldo",
    description:
      "Saldo godisnjeg odmora za tekucu godinu: godisnje pravo, preneto, iskorisceno, planirano i preostalo. Bez employee_id → za pozivaoca.",
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: "UUID; izostavi za sebe" },
      },
      required: [],
    },
  },
  {
    name: "sati_mesec",
    description:
      "Zbir sati iz evidencije za mesec: redovno, prekovremeno, teren, dve masine + dani odsustva po tipu. Bez employee_id → pozivalac; bez godina/mesec → tekuci mesec.",
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: "UUID; izostavi za sebe" },
        godina: { type: "integer" },
        mesec: { type: "integer", description: "1–12" },
      },
      required: [],
    },
  },
  {
    name: "moj_tim",
    description:
      "Lista zaposlenih koje pozivalac sme da vidi sa preostalim danima GO i ko je danas odsutan.",
    input: { type: "object", properties: {}, required: [] },
  },
  {
    name: "odsustva_lista",
    description:
      "Periodi odsustva zaposlenog za godinu (od–do + broj dana). Bez employee_id → pozivalac; bez godine → tekuca; tip filtrira po sifri. Svaki period ima 'vremenski_status'.",
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: "UUID; izostavi za sebe" },
        godina: { type: "integer" },
        tip: { type: "string", description: "npr. go" },
      },
      required: [],
    },
  },
  {
    name: "go_zahtevi",
    description:
      "Zahtevi za godisnji odmor zaposlenog (od–do, broj dana, status, napomena). Bez employee_id → pozivalac.",
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: "UUID; izostavi za sebe" },
        godina: { type: "integer" },
      },
      required: [],
    },
  },
  {
    name: "go_pregled",
    description:
      "KOMPLETAN pregled godisnjeg odmora za tekucu godinu U JEDNOM POZIVU (pravo, preneto, iskorisceno, planirano, preostalo + liste perioda). Bez employee_id → za pozivaoca.",
    input: {
      type: "object",
      properties: {
        employee_id: { type: "string", description: "UUID; izostavi za sebe" },
      },
      required: [],
    },
  },
  {
    name: "projekat_info",
    description:
      "Presek PROJEKTA po broju (npr. 9400/7): osnovno, plan montaze, izvestaji montera, otvorene akcije, stavke sastanaka, beleske tima.",
    input: {
      type: "object",
      properties: {
        projekat: { type: "string", description: "broj projekta, npr. 9400/7" },
      },
      required: ["projekat"],
    },
  },
  {
    name: "pretrazi_znanje",
    description:
      "Pretraga baze znanja: beleske tima + tekst izvestaja montera, po pojmu. Opcioni filter po projektu.",
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: "pojam pretrage" },
        projekat: { type: "string", description: "opciono: broj projekta" },
      },
      required: ["upit"],
    },
  },
  {
    name: "dodaj_belesku",
    description:
      "Sacuvaj belesku/odluku u bazu znanja projekta. Koristi ISKLJUCIVO kad korisnik izricito trazi da se nesto zapise.",
    input: {
      type: "object",
      properties: {
        projekat: { type: "string", description: "broj projekta" },
        naslov: { type: "string", description: "kratak naslov" },
        tekst: { type: "string", description: "sadrzaj" },
      },
      required: ["projekat", "tekst"],
    },
  },
  {
    name: "opis_pozicije",
    description:
      "Sistematizacija: opis radnog mesta. Bez naziva → lista SVIH pozicija sa linijom nadredjenosti.",
    input: {
      type: "object",
      properties: {
        pozicija: {
          type: "string",
          description: "deo naziva pozicije; prazno = lista svih",
        },
      },
      required: [],
    },
  },
  {
    name: "pretrazi_uputstva",
    description:
      "Pretraga BAZE UPUTSTAVA I PRAVILA firme — tekstualno + semanticki. OBAVEZNO za pitanja tipa kako da, gde se nalazi, koja su pravila.",
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: "pitanje ili pojam" },
      },
      required: ["upit"],
    },
  },
  {
    name: "dodaj_uputstvo",
    description:
      "Sacuvaj/azuriraj UPUTSTVO u bazu znanja firme (SAMO admin/HR; upsert po naslovu).",
    input: {
      type: "object",
      properties: {
        naslov: { type: "string" },
        sadrzaj: {
          type: "string",
          description: "koraci/tekst, srpski latinica",
        },
        modul: { type: "string" },
        kljucne_reci: { type: "string" },
        vidljivost: {
          type: "string",
          description: "'svi' (default) ili 'admin_hr'",
        },
      },
      required: ["naslov", "sadrzaj"],
    },
  },
  {
    name: "inzenjering_pretraga",
    description:
      "Baza znanja INZENJERINGA (Projektovanje): zadaci, komentari, dnevni izvestaji. Opcioni filter po projektu.",
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: "pojam pretrage" },
        projekat: { type: "string", description: "opciono: broj projekta" },
      },
      required: ["upit"],
    },
  },
  {
    name: "masina_info",
    description:
      "Karton masine iz Odrzavanja + otvoreni kvarovi, kontrole i spisak dokumenata. Prima sifru ili deo naziva.",
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: "sifra ili naziv masine" },
      },
      required: ["masina"],
    },
  },
  {
    name: "kvar_istorija",
    description:
      "Istorija kvarova iz Odrzavanja (opis + RESENJE + napomene). Opcioni filter po masini/pojmu. Koristi PRE predloga resenja.",
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: "opciono: sifra/naziv masine" },
        upit: { type: "string", description: "opciono: pojam" },
      },
      required: [],
    },
  },
  {
    name: "masina_uputstvo",
    description:
      "Pretraga UPUTSTAVA I DOKUMENTACIJE masine (PDF-ovi) — semanticki + tekstualno; vraca odlomke sa nazivom dokumenta i stranom.",
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: "sifra ili naziv masine" },
        pitanje: { type: "string", description: "sta se trazi u uputstvu" },
      },
      required: ["masina", "pitanje"],
    },
  },
  {
    name: "prijavi_kvar",
    description:
      "Prijavi kvar na masini u Odrzavanje. PRE poziva prikupi podatke i POKAZI rezime pa uz potvrdu prijavi.",
    input: {
      type: "object",
      properties: {
        masina: { type: "string", description: "sifra ili naziv masine" },
        naslov: { type: "string", description: "kratak opis kvara" },
        opis: { type: "string", description: "detalji" },
        ozbiljnost: {
          type: "string",
          description: "normal | minor | important | major | critical",
        },
        bezbednosni_rizik: { type: "boolean" },
      },
      required: ["masina", "naslov"],
    },
  },
  {
    name: "sql_upit",
    description:
      "SAMO ZA ADMIN/HR: slobodan READ-ONLY SQL (jedan SELECT/WITH, bez ; i komentara, max 200 redova, timeout 4s; RLS pozivaoca).",
    input: {
      type: "object",
      properties: {
        upit: { type: "string", description: "SELECT … (bez ;)" },
      },
      required: ["upit"],
    },
  },
];

/** U DELJENOJ projektnoj niti nema licnih/HR alata (poruke vide svi!) — §2 pravilo 11. */
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
