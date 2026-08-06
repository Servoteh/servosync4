import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { BbMdbStageKomitent } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BIGBIT_MDB_SYNC_STATE_ENTITY,
  BIGBIT_MDB_SYNC_SWITCH,
  MAX_DROP_AGE_HOURS,
  switchDisabledReason,
  dropDateFromFileName,
} from "../../common/switches/bigbit-sync";
// MAPIRANJE KOMITENATA JE JEDNA ISTINA: `mapKomitentiRow` je isti mapper koji
// vozi (mrtvi) MSSQL sync — MSSQL tabela je bila preslikana kopija ISTE Access
// tabele, pa se menja SAMO izvor redova. Duplirano mapiranje bi se razišlo na
// prvoj izmeni i dve rute bi tiho pisale različit sadržaj u iste kolone.
import { mapKomitentiRow } from "./syncers/customer.syncer";
import {
  additiveDedupFieldFor,
  isNativeRow,
  NATIVE_ID_BASE,
  NATIVE_SOURCE_MARKER,
} from "./table-ownership";
import { SYNC_MAP } from "./sync-map.generated";
import type { ColumnMapping, TableMapping } from "./sync.types";

/**
 * KORAK 2 od noćnog BigBit uvoza: `bb_mdb_stage_*` -> 4.0 modeli.
 *
 * KORAK 1 (`backend/scripts/bigbit-mdb-export.sh`) radi NA HOSTU jer backend
 * kontejner ne vidi .mdb fajl (provereno 26.07.2026: `docker inspect
 * servosync-backend` -> Binds=[], nema docker socket-a, nema mdbtools-a). Host
 * napuni staging tabele i `bb_mdb_drops`; ovaj servis čita ISKLJUČIVO bazu.
 *
 * NAČELA
 *  • IDEMPOTENTNO: svaki korak je `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *    <red se STVARNO razlikuje>`. Poređenje NAMERNO ne uključuje
 *    `imported_drop_id` — on se menja sa svakim novim drop-om, pa bi ga svaka
 *    noć „razlikovala" i prepisala CELU glavnu knjigu. Tada bi brojači
 *    inserted/updated postali beskorisni („sve izmenjeno" svake noći) i STVARNA
 *    BigBitova ispravka bi se izgubila u šumu. Sada „ažurirano" znači ISKLJUČIVO
 *    da se sadržaj promenio u BigBitu.
 *  • U SERIJAMA: glavna knjiga ide keyset-om po `StavkaID` u serijama od
 *    `GK_BATCH`, svaka serija = zasebna transakcija.
 *  • OZNAKA POREKLA: svaki uvezeni red nosi `imported_drop_id` (iz kog je fajla
 *    PRVI put došao) i `bb_nalog_id`/`bb_stavka_id` (stabilan traceback ka
 *    BigBitu). `bb_stavka_id IS NULL` = red je nastao u 4.0.
 *  • NIŠTA TIHO: svaki izvorni red koji ne uđe se BROJI i imenuje (`filtered`
 *    sa razlogom, `skipped` sa razlogom). Sudar broja naloga i prazan izvoz
 *    OBARAJU posao — status DONE sme da znači samo „sve je stvarno ušlo".
 *  • NE DIRA MSSQL SYNC: `SyncService`/`SYNC_MAP` su zaseban put i rade dalje.
 *
 * MATIČNI PODACI OD 30.07.2026. IDU OVIM KANALOM (izmena prethodne odluke)
 * ────────────────────────────────────────────────────────────────────────────
 * Do 30.07. je ovde stajalo „NE DIRA `customers`/`projects` — njih vozi živi
 * MSSQL sync, koji čita bazu uživo i time je svežiji od noćnog fajla". To je
 * PRESTALO da bude tačno i mereno je istog dana:
 *
 *   BigBit (Access, živi)   → predmet 10014
 *   QBigTehn (MSSQL izvor)  → predmet 10005, poslednja izmena 22.07. 08:47
 *   ServoSync 4.0           → predmet 10005 (savršeno usklađen sa svojim izvorom)
 *
 * Prenos BigBit→QBigTehn se više ne radi (modul ugašen), pa je MSSQL izvor MRTAV
 * od 22.07. Naša karika je zdrava — ručno pokretanje sync-a 30.07. pročitalo je i
 * upisalo svih 7.617 predmeta bez ijedne greške; podataka prosto nema u izvoru.
 * „Svežiji od noćnog fajla" je zato postalo obrnuto: `.mdb` je jedini izvor koji
 * uopšte prati BigBit. Od sada `Komitenti` i `Predmeti` ulaze ovde.
 *
 * DVA PRAVILA KOJA VAŽE SAMO ZA MATIČNE PODATKE (i skupo su naučena):
 *  • NIŠTA SE NE BRIŠE. BigBit PRAZNI zatvorene godine (Access ima granicu
 *    veličine baze), pa red koji nestane iz drop-a je najčešće normalno godišnje
 *    arhiviranje, a ne brisanje. Zato je full refresh (`deleteMany`) zabranjen
 *    obrazac — radi se ISKLJUČIVO upsert, a nestajanje se MERI (v. `countVanishedMasters`).
 *  • 4.0-NATIVE RED SE NE DIRA. `customers` ima rezervisan opseg ključeva
 *    (`NATIVE_ID_BASE` = 900.000.000 + CHECK `chk_customers_native_id_range`), a
 *    `projects` paritet-guard po broju predmeta (`ADDITIVE_DEDUP_FIELDS.projects`).
 *
 * Uputstvo (ručno pokretanje, gašenje, kvarovi): docs/migration/BIGBIT_NOCNI_SYNC.md
 */

/** Serija za glavnu knjigu. 2.000 × ~15 kolona je udoban `INSERT ... SELECT`. */
const GK_BATCH = 2000;

/**
 * Posle koliko sati se `import_started_at` smatra ZAOSTALIM (proces ubijen,
 * kontejner restartovan) pa se claim sme preoteti. Mora biti IZNAD realnog
 * trajanja uvoza (danas ~5 s za 20k redova; puna istorija je red veličine minuta).
 */
const IMPORT_LOCK_STALE_HOURS = 2;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRAG: KADA JE NESTAJANJE MATIČNIH REDOVA ARHIVIRANJE, A KADA ALARM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Presuđeno 30.07.2026:
 *  • MASOVNO nestajanje (BigBit prazni zatvorenu godinu jer Access ima granicu
 *    veličine baze) je OČEKIVANO → ne zvoni.
 *  • POJEDINAČNO nestajanje usred godine (neko je obrisao komitenta/predmet
 *    rukom u Access formi) je STVARAN ALARM → zvoni.
 *
 * Prag je zato PAR (broj redova I udeo), a ne osećaj. Brojevi na kojima stoji:
 *
 *  1. VELIČINE TABELA, izmerene: `Komitenti` 6.669 redova (F1 merenje,
 *     docs/migration/BIGBIT_KOMITENTI.md §Metod), `Predmeti` 7.617 redova
 *     (ručno pokretanje sync-a 30.07.2026). Dakle ~7k po tabeli.
 *  2. GORNJI POJAS JE VEĆ ZATVOREN U KORAKU 1: `bigbit-mdb-export.sh` obara
 *     izvoz kad broj redova padne preko 20 % (1.334 / 1.523 reda), i pušta ga
 *     samo uz eksplicitno `BB_ALLOW_SHRINK=1` — a to je baš procedura za novu
 *     poslovnu godinu. Zato ovaj prag ne mora da presuđuje o padovima >20 %:
 *     njih je čovek već odobrio ili su oborili korak 1. Ostaje pojas 0–20 %.
 *  3. GODIŠNJA SERIJA: 7.617 predmeta nakupljeno kroz ~19 godina Access
 *     istorije ≈ 400 redova/god ≈ 5,3 % tabele. I slaba godina (150 redova) je
 *     ~2 %. Dakle svaka stvarna godišnja serija je REDA VELIČINE iznad 1 %.
 *  4. RUČNO BRISANJE: predmet ima `IDPredmet` kao FK u 25+ tabela
 *     (docs/migration/22-predmeti-domen-rekonstrukcija.md §2), pa se u BigBitu
 *     briše pojedinačno — realno 1–10 redova. 25 je 2,5× iznad tog maksimuma i
 *     16× ispod najmanje očekivane godišnje serije (400).
 *
 * ZAŠTO OBA USLOVA: sam udeo se lomi na maloj tabeli (kad bi `Predmeti` imali
 * 50 redova, jedan obrisan red = 2 % = „arhiviranje" — tačno tiho ćutanje koje
 * ovaj prag treba da spreči). Sam broj se lomi na velikoj (25 obrisanih redova
 * od 200.000 nije serija). Zato: ARHIVIRANJE = i dovoljno redova I dovoljan udeo.
 *
 * PREOSTALI RIZIK, pošteno: skript-greška u BigBitu koja obriše ~100 predmeta
 * usred godine (1,3 %) proći će kao „arhiviranje" i neće zvoniti. Korak 1 to ne
 * hvata (prag mu je 20 %). Svesno primljeno: presuda je da masovno nestajanje ne
 * zvoni, a brojevi ostaju u `import_row_counts` i u summary-ju.
 */
const MASTER_VANISHED_MASS_ROWS = 25;
const MASTER_VANISHED_MASS_SHARE = 0.01;

/**
 * Ljudska imena matičnih tabela za poruke. Poruka koja čoveku kaže „customers"
 * nije poruka za čoveka; tehnički naziv ide u uglaste zagrade, kao svuda u ovom
 * kanalu.
 */
const MASTER_LABELS: Record<string, string> = {
  customers: "komitenti",
  projects: "predmeti",
};

/** Serija za predmete. Mereno 30.07.2026: 7.617 predmeta = osam stranica. */
const PROJECTS_BATCH = 1000;

/** Serija za artikle — 91k redova × 67 kolona; 2000 drži memoriju ispod ~40 MB. */
const ITEMS_BATCH = 2000;

/**
 * Serija za robno ogledalo. Mereno u živom fajlu: 27.338 dokumenata, 182.539
 * robnih stavki, 22.931 trebovanje, 86.779 stavki trebovanja — dakle robno je
 * NAJVEĆI korak uvoza, veći od glavne knjige i od artikala zajedno.
 *
 * Zato robno ne ide red-po-red kao artikli (91k pojedinačnih `update`-a je danas
 * najsporiji korak), nego se cela stranica upisuje JEDNIM `INSERT ... SELECT`:
 * 2.000 redova = jedan odlazak u bazu i jedna transakcija, uz isti
 * `ON CONFLICT ... WHERE IS DISTINCT FROM` koji koriste ostali koraci.
 *
 * 🔴 STRANICA SE ŠALJE KAO `jsonb`, NE KAO PARALELNI NIZOVI (`unnest`) — i to
 * nije stil nego ispravka posle pada na DEV BAZI (05.08.2026):
 *
 *     ERROR: cannot cast type integer[] to date[]
 *
 * Prisma tip niza POGAĐA iz njegovog sadržaja. Stranica u kojoj su SVE vrednosti
 * jedne kolone prazne (npr. `DatumIsporuke` — mereno: 2 od 86.779 stavki ga
 * uopšte nemaju, ali cela stranica od 2.000 lako bude bez ijednog) stiže kao
 * `integer[]`, a `integer[]` se ne da kastovati u `date[]`. To ne bi bio tihi
 * kvar nego pad CELOG robnog uvoza, i to zavisan od SADRŽAJA stranice — dakle
 * takav da prođe kroz svaki test sa lepim podacima i sruši se u martu.
 *
 * `jsonb_to_recordset` uklanja pogađanje: tipovi kolona stoje NAPISANI u upitu,
 * `null` je `null` u svakoj koloni, a datumi/decimale se čitaju kao tekst pa
 * eksplicitno kastuju — isti razlog iz kog `bbDecimalText` ne prolazi kroz
 * JS `number`.
 */
const GOODS_BATCH = 2000;

/** Koliko preskočenih redova se IMENUJE u `notes` (ostatak se sabere u broj). */
const MAX_NAMED_SKIPS = 20;

/**
 * Skala na kojoj se DECIMAL kolone porede — mora biti TAČNO ona koju kolona u
 * bazi čuva, inače „neizmenjen" nikad ne nastupi.
 *
 * Nalaz prvog pravog poređenja sa produkcijskom slikom artikala (31.07.2026):
 * BigBit cene drži kao `Double`, pa izvoz ispiše `80.09999999999999`, a naša
 * kolona je `numeric(19,4)` i pri upisu zaokruži na `80.1000`. Poređenje sirovih
 * vrednosti bi zato **svake noći** prijavilo ~91.000 „izmenjenih" artikala i
 * uzalud ih prepisalo — a prava ispravka bi se izgubila u tom šumu.
 *
 * Podrazumevana skala je 4 (novac po BACKEND_RULES: `Decimal(19,4)`); izuzeci se
 * navode ispod. Izmereno na bazi: `items` ima 10 kolona `numeric(19,4)`,
 * `customers` 2, `projects` 5 — plus `projects.exchange_rate` koji je `(19,6)`,
 * pa bi poređenje na 4 mesta tiho progutalo izmenu kursa u 5. i 6. decimali.
 * Brana da spisak ne odluta od šeme: `bigbit-mdb-import.decimal-scale.spec.ts`.
 */
const DECIMAL_SCALE_DEFAULT = 4;
const DECIMAL_SCALE_BY_FIELD: Record<string, Record<string, number>> = {
  projects: { exchangeRate: 6 },
};

/**
 * `Predmeti` (BigBit) -> `bb_mdb_stage_predmeti`: ime IZVORNE kolone, tačno kako
 * ga zna `sync-map.generated.ts`, -> polje staging modela `BbMdbStagePredmet`.
 *
 * ŠTA OVO NIJE: nije mapiranje. Šta u koju kolonu `projects` ide i kog je tipa
 * govori ISKLJUČIVO `SYNC_MAP` (`targetDb: "projects"`, 38 kolona) — isti izvor
 * istine koji je vozio MSSQL sync, jer je MSSQL tabela bila preslikana kopija
 * ove iste Access tabele. Ovde stoji SAMO fizička veza „BigBit ime -> staging
 * kolona", koja se iz imena NE DA izvesti bez nagađanja: `IDPredmet`->`idPredmet`
 * (dvoslovni akronim se spušta), ali `RJ`->`rj` (ceo naziv je akronim),
 * `NasKontakt1`->`nasKontakt1` (cifra ostaje prilepljena) i `DatumIVreme`->
 * `datumIVreme` (jednoslovna reč u sredini ostaje veliko). Automatska konverzija
 * bi na jednom od ta četiri oblika pukla — u najboljem slučaju greškom, u
 * najgorem tihim NULL-om u koloni koju niko ne gleda.
 *
 * Potpunost pinuje test (`bigbit-mdb-import.projects.spec.ts`): svaka kolona iz
 * `SYNC_MAP` mora imati red ovde, a svaki red mora biti postojeće polje modela
 * (poređeno sa `Prisma.dmmf`). I sam uvoz pada glasno ako red nedostaje —
 * nedostajuća kolona ne sme da se pretvori u prazno polje bez ijedne poruke.
 */
export const PREDMET_SRC_TO_STAGE_FIELD: Record<string, string> = {
  IDPredmet: "idPredmet",
  BrojPredmeta: "brojPredmeta",
  Opis: "opis",
  DatumOtvaranja: "datumOtvaranja",
  IDProdavac: "idProdavac",
  IDKomitent: "idKomitent",
  NextAction: "nextAction",
  DatumZakljucenja: "datumZakljucenja",
  Memo: "memo",
  Status: "status",
  NasaRef: "nasaRef",
  NasKontakt1: "nasKontakt1",
  NasKontakt2: "nasKontakt2",
  NasTel1: "nasTel1",
  NasTel2: "nasTel2",
  VasaRef: "vasaRef",
  VasKontakt1: "vasKontakt1",
  VasKontakt2: "vasKontakt2",
  VasTel1: "vasTel1",
  VasTel2: "vasTel2",
  NabavnaVrednost: "nabavnaVrednost",
  Carina: "carina",
  Spedicija: "spedicija",
  Prevoz: "prevoz",
  Ostalo: "ostalo",
  InoDobavljac: "inoDobavljac",
  RJ: "rj",
  devvaluta: "devvaluta",
  kurs: "kurs",
  IDVrstaPosla: "idVrstaPosla",
  NazivPredmeta: "nazivPredmeta",
  RokZavrsetka: "rokZavrsetka",
  Potpis: "potpis",
  DatumIVreme: "datumIVreme",
  BrojUgovora: "brojUgovora",
  DatumUgovora: "datumUgovora",
  BrojNarudzbenice: "brojNarudzbenice",
  DatumNarudzbenice: "datumNarudzbenice",
};

/**
 * `R_Artikli` -> staging kolone (31.07.2026). Isti ugovor kao PREDMET tabela
 * iznad: `itemsMapping()` proverava da SVAKA kolona iz sync mape ima red ovde,
 * pa nova kolona u BigBitu ne može tiho da se uveze prazna.
 *
 * ⚠️ OBE „šifre" IZ MAPE ČITAJU ISTU STAGING KOLONU, ali im je uloga različita —
 * i to je jedina takva tabela u lancu:
 *
 *   • `BBSifra artikla` -> `items.external_item_id` — **KLJUČ ovog uvoza**.
 *     Tu kolonu je MSSQL transfer napravio da SAČUVA BigBit-ovu šifru, jer je
 *     sebi dodeljivao svoju. U direktnom .mdb kanalu izvorna `Sifra artikla`
 *     upravo to i jeste, pa se čita odatle.
 *   • `Sifra artikla` -> `items.id` — u mapi stoji zato što je u QBigTehn-u to
 *     bio NJEGOV broj. **Direktan kanal taj broj nema i `items.id` NIKAD ne
 *     upisuje** (`importItems` izbacuje `isId` kolonu iz upisa).
 *
 * Mereno na produkciji 31.07.2026: `id = external_item_id` za 0 od 92.511 redova.
 * Da se ključalo po `id`-u, BigBit artikal bi se upisao preko nepovezanog našeg
 * artikla sa istim brojem — 58.143 pogrešno prepisana reda.
 */
export const ARTIKAL_SRC_TO_STAGE_FIELD: Record<string, string> = {
  "Sifra artikla": "sifraArtikla",
  "Kataloski broj": "kataloskiBroj",
  "BarKod": "barKod",
  "PLU": "plu",
  "ExtSifra": "extSifra",
  "Naziv": "naziv",
  "Jedinica mere": "jedinicaMere",
  "Pakovanje": "pakovanje",
  "InoJm": "inoJm",
  "Kutija": "kutija",
  "Transportno pakovanje": "transportnoPakovanje",
  "Poreklo": "poreklo",
  "Grupa": "grupa",
  "Podgrupa": "podgrupa",
  "Tarifa robe": "tarifaRobe",
  "Tarifa usluga": "tarifaUsluga",
  "Uvek porez na robu": "uvekPorezNaRobu",
  "Uvek porez na usluge": "uvekPorezNaUsluge",
  "VP cena": "vpCena",
  "MP cena": "mpCena",
  "NabDevCena": "nabDevCena",
  "ProdDevCena": "prodDevCena",
  "Minimalna kolicina": "minimalnaKolicina",
  "ArtTaksa": "artTaksa",
  "Odlozeno": "odlozeno",
  "Neoporezivi deo": "neoporeziviDeo",
  "MaxRabatProc": "maxRabatProc",
  "Memo": "memo",
  "KngSifra": "kngSifra",
  "ArtAkciza": "artAkciza",
  "KngSifra_2": "kngSifra2",
  "ZavTrosProiz": "zavTrosProiz",
  "CarStopa": "carStopa",
  "IDRaster": "idRaster",
  "CarTarifa": "carTarifa",
  "ZemljaPorekla": "zemljaPorekla",
  "Polica": "polica",
  "INONaziv": "inoNaziv",
  "SifDob": "sifDob",
  "WebOpis": "webOpis",
  "OpisArtikla": "opisArtikla",
  "Tezina": "tezina",
  "PDFLink": "pdfLink",
  "ZaBrisanje": "zaBrisanje",
  "Aktivan": "aktivan",
  "CenaZaUpisUCen": "cenaZaUpisUCen",
  "IDMestoIzdavanja": "idMestoIzdavanja",
  "Proizvodjac": "proizvodjac",
  "HPS": "hps",
  "PotpisArt": "potpisArt",
  "DatumIVremeArt": "datumIVremeArt",
  "KolUPak": "kolUPak",
  "KLRucProc": "klRucProc",
  "OsnJM": "osnJm",
  "SlikaSimbolaLink": "slikaSimbolaLink",
  "MPKaloProc": "mpKaloProc",
  "WordLokacija": "wordLokacija",
  "VPKaloProc": "vpKaloProc",
  "NeVodiZalihe": "neVodiZalihe",
  "TezinaKg": "tezinaKg",
  "Zapremina": "zapremina",
  "Povrsina": "povrsina",
  "RSort": "rSort",
  "AkcijskiRabat": "akcijskiRabat",
  "Napomena2": "napomena2",
  "IDKvalitetArtikla": "idKvalitetArtikla",
  "Debljina": "debljina",
  "BBSifra artikla": "sifraArtikla",
};

/** Staging je SAV tekst; prazan string i beline znače „nema vrednosti". */
const stageText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  // PRELOMI REDA SE SAŽIMAJU U RAZMAK — nalaz prvog pravog uvoza, 30.07.2026.
  //
  // U BigBitu se u jednoredna polja ume upisati više redova. Nađeno u živim
  // podacima: PIB `109110666\r\n109110666` (isti broj otkucan dvaput) i mobilni
  // `064/8\r\n064 86 34 707`. Izvoz radi `mdb-export -e`, pa se svaki prelom
  // pretvori u DVA znaka (`\` + `n`) — vrednost od 9 znakova naraste na 22 i
  // prelije kolonu, a Prisma tada odbije CEO RED: komitent prosto nedostaje, uz
  // upozorenje koje ne kaže ni koja je kolona kriva.
  //
  // Zato se prelomi sažimaju umesto da se kolone šire na meru smeća: podatak
  // ostaje veran (ništa se ne odbacuje, samo se spaja u jedan red), red prolazi,
  // a pogrešan PIB i dalje pada na validaciji — što je tačno i poželjno, jer se
  // ispravlja u BigBitu, ne kod nas.
  // ⚠️ DVA OBLIKA, OBA MORAJU: izvoz se poziva sa `mdb-export -e` (C-escape), pa u
  // CSV-u NE STOJE pravi kontrolni znakovi nego DOSLOVNI niz `\` + `n`. Prva
  // verzija ove ispravke gađala je samo prave prelome i nije promenila ništa —
  // pet komitenata je i dalje otpadalo. Zato se hvata i jedno i drugo.
  const s = String(v)
    .replace(/\\[rnt]/g, " ") // doslovno `\r` `\n` `\t` iz `-e` escape-a
    .replace(/[\r\n\t]+/g, " ") // pravi kontrolni znakovi (ako izvoz ikad izgubi -e)
    .replace(/ {2,}/g, " ")
    .trim();
  return s === "" ? null : s;
};

/**
 * `YYYY-MM-DD[ HH:MM:SS]` -> `Date` u UTC ZIDNOM vremenu.
 *
 * NE koristi se `new Date(tekst)`, i to nije stilska sitnica. `mdb-export` se
 * poziva sa `-T '%Y-%m-%d %H:%M:%S' -D '%Y-%m-%d'` (v. `bigbit-mdb-export.sh`),
 * a Node ta dva oblika parsira RAZLIČITO: `"2026-06-26 00:00:00"` kao LOKALNO
 * vreme, a `"2026-06-26"` kao UTC. Na serveru u Europe/Belgrade prvi oblik bi
 * postao `2026-06-25T22:00:00Z`, a ciljne kolone su `timestamp` BEZ zone — pa bi
 * se u bazu upisao PRETHODNI DAN, i to samo za deo kolona. Datum otvaranja,
 * zaključenja i rok predmeta bi tiho otišli dan unazad. Zato se komponente čitaju
 * regularnim izrazom i sastavljaju kroz `Date.UTC` — isti efekat koji koraci
 * glavne knjige postižu sa `::timestamp AT TIME ZONE 'UTC'`.
 */
const stageDate = (v: unknown): Date | null => {
  const s = stageText(v);
  if (!s) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Celobrojna vrednost iz teksta; `null` kad je prazno ili nije broj. */
const stageInt = (v: unknown): number | null => {
  const s = stageText(v);
  if (!s) return null;
  const num = Number(s);
  return Number.isFinite(num) ? Math.trunc(num) : null;
};

/** `0` u BigBitu znači „nije popunjeno" na svakoj šifri-referenci (komitent, predmet, magacin). */
const stageRef = (v: unknown): number | null => {
  const id = stageInt(v);
  return id === null || id === 0 ? null : id;
};

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  ROBNO OGLEDALO — LAGER („drugi pregled artikala") I KARTICE ARTIKLA      ║
// ║                                                                          ║
// ║  Preslikavanje `T_Robna dokumenta` / `T_Robne stavke` / `T_Trebovanja`    ║
// ║  (+ stavke) u `*_mirror` tabele. Sve odluke ispod su MERENE nad živim     ║
// ║  BigBit fajlom `BB_T_26_11-07-26.mdb` (27.338 dokumenata / 182.539        ║
// ║  stavki / 22.931 trebovanje), 05.08.2026. Brojevi stoje uz svako pravilo  ║
// ║  jer se bez njih pravilo za godinu dana pročita kao proizvoljno.          ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/**
 * Access `Boolean` kroz `mdb-export` izlazi kao TEKST — a `Boolean("0")` je u
 * JS-u `true`. Isti spisak vrednosti koji koristi `mapStagedProject`, izdvojen
 * jer robno o njemu zavisi na tri mesta (`Ulaz`, `Rezervisi`, `Zakljucano`) i
 * jer je `Ulaz` jedina stvar koja odlučuje da li roba ULAZI ili IZLAZI.
 */
export const bbBool = (v: unknown): boolean => {
  const s = stageText(v);
  return s === null
    ? false
    : ["1", "-1", "true", "yes", "da"].includes(s.toLowerCase());
};

/**
 * Broj iz staging teksta — kao TEKST, ne kao JS `number`.
 *
 * ZAŠTO NE `Number()`: količine idu u `numeric(18,4)` i sabiraju se u lager.
 * BigBit ih drži kao `Double` i izvozi ispiše `5.0049999999999`; kad bi se
 * vrednost provukla kroz JS `number` pa nazad u tekst, u zbir od 182.500 stavki
 * ušla bi binarna greška koju Postgres ne bi napravio. Ovako Postgres parsira
 * izvorni zapis i sam ga zaokruži na skalu kolone.
 *
 * Neupotrebljiv zapis daje `null` (kolona ostaje prazna), NIKAD pad reda.
 */
export const bbDecimalText = (v: unknown): string | null => {
  const s = stageText(v);
  if (s === null) return null;
  const cleaned = s.replace(",", ".").replace(/[^0-9.eE+-]/g, "");
  if (cleaned === "" || !Number.isFinite(Number(cleaned))) return null;
  return cleaned;
};

/**
 * SMER PROMETA: jedna BigBit količina -> `quantity_in` / `quantity_out`.
 *
 * 🔴 ZNAK SE NE DIRA — ni `ABS`, ni „spusti na nulu". Mereno: 87 stavki ima
 * NEGATIVNU `Kolicina`, i to nije smeće nego način na koji BigBit knjiži
 * međumagacinski prenos. Doslovan snimak jednog prenosa iz fajla:
 *
 *     MMPM  Ulaz=True  magacin 2  SUM(Kolicina) = +5,005
 *     MMPR  Ulaz=True  magacin 1  SUM(Kolicina) = −5,005
 *
 * Dakle OBA dokumenta su „ulaz", a odlazak iz magacina 1 je zapisan negativnom
 * količinom. Sa `ABS()` bi tih 5,005 bilo DODATO i magacinu 1 i magacinu 2 —
 * roba bi se umnožila prenosom, i to tiho, jer bi svaki pojedinačni red
 * izgledao savršeno normalno. `SUM(in) − SUM(out)` sa očuvanim znakom daje
 * tačan rezultat u oba smera.
 */
export const splitGoodsQuantity = (
  kolicina: unknown,
  isInflow: boolean,
): { quantityIn: string; quantityOut: string } => {
  const q = bbDecimalText(kolicina) ?? "0";
  return isInflow
    ? { quantityIn: q, quantityOut: "0" }
    : { quantityIn: "0", quantityOut: q };
};

/**
 * Vrednost onako kako se PRIKAZUJE u poruci o odbijenom redu. Staging je sav
 * tekst, ali je tip `unknown`, pa golo `String(v)` na objektu ispiše
 * „[object Object]" — poruka koja ne kaže ništa je gora od poruke koje nema.
 */
const shown = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : "";

/** `YYYY-MM-DD` za `::date[]` — bez zone, jer je kolona `date`. */
const bbDateText = (v: unknown): string | null => {
  const d = stageDate(v);
  return d === null ? null : d.toISOString().slice(0, 10);
};

const cut = (s: string | null, max: number): string | null =>
  s === null ? null : s.slice(0, max);

/** Naš artikal iza BigBit šifre. */
export interface BbItemRef {
  /** `items.id` — 4.0 ključ, ono što ide u `*_mirror.item_id`. */
  id: number;
  catalogNumber: string | null;
}

/**
 * BigBit `Sifra artikla` -> naš artikal.
 *
 * 🔴 VREDNOST `null` ZNAČI „ŠIFRU DRŽI VIŠE NAŠIH ARTIKALA" — tada se ne pogađa
 * koji je pravi, nego se stavka preskače i imenuje. Isti stav ima `importItems`
 * („ne pogađam koji je pravi; razreši dubl kod nas"); dva različita stava o
 * istoj duploj šifri bi značila da lager i šifarnik pokazuju različit artikal.
 */
export type BbItemIndex = Map<number, BbItemRef | null>;

export type MapReject = {
  ok: false;
  /** `FILTER` = red nije ni ušao u obradu; `SKIP` = obrađen pa odbijen. */
  kind: "FILTER" | "SKIP";
  reason: string;
};
export type MapResult<T> = { ok: true; value: T } | MapReject;

export interface MappedGoodsDocument {
  id: number;
  documentType: string;
  documentNumber: string | null;
  documentDate: string;
  postingDate: string | null;
  isInflow: boolean;
  isReservation: boolean;
  level: number;
  warehouseId: number | null;
  customerId: number | null;
  projectId: number | null;
  isLocked: boolean;
  year: number | null;
  /** `Vrsta dokumenta` je bila duža od kolone (5) — imenuje se, ne ćuti se. */
  typeTruncated: boolean;
}

/**
 * `T_Robna dokumenta` (staging red) -> `goods_documents_mirror`.
 *
 * ŠTA NOSI ZNAČENJE (mereno u fajlu 11.07.2026):
 *  • `Level` — 0 nosi 1.528 dokumenata TEKUĆE godine (stanje se računa SAMO nad
 *    njima), 250 nosi 25.810 radnih dokumenata (ponude, predračuni, otpremnice,
 *    rezervacije) koji se vide na kartici ali NE ulaze u stanje.
 *  • `Rezervisi` — 1.576 dokumenata. NE poklapa se sa vrstom dokumenta: pored
 *    REZM (1.071) i REZR (487) rezervišu i OTP (9), PON (6) i PROF (3). Ko bi
 *    rezervacije prepoznavao po vrsti, promašio bi 18 dokumenata; zato se prenosi
 *    ZASTAVICA, a ekran čita nju.
 *  • `Ulaz` — smer. U Level 0: 1.312 ulaznih, 216 izlaznih; ceo Level 250 je
 *    izlazni.
 */
export const mapGoodsDocumentRow = (
  row: Record<string, unknown>,
): MapResult<MappedGoodsDocument> => {
  const id = stageInt(row.id_dok);
  if (id === null || id <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: IDDok="${shown(row.id_dok)}" nije upotrebljiv broj`,
    };
  const documentDate = bbDateText(row.datum_dokumenta);
  if (documentDate === null)
    return {
      ok: false,
      kind: "FILTER",
      reason:
        `odbačeno: IDDok=${id} nema upotrebljiv „Datum dokumenta" ` +
        `("${shown(row.datum_dokumenta)}") — kolona je NOT NULL`,
    };
  const rawType = stageText(row.vrsta_dokumenta) ?? "";
  return {
    ok: true,
    value: {
      id,
      documentType: rawType.slice(0, 5),
      typeTruncated: rawType.length > 5,
      documentNumber: cut(stageText(row.broj_dokumenta), 50),
      documentDate,
      postingDate: bbDateText(row.datum_knjizenja),
      isInflow: bbBool(row.ulaz),
      isReservation: bbBool(row.rezervisi),
      isLocked: bbBool(row.zakljucano),
      level: stageInt(row.level) ?? 0,
      warehouseId: stageRef(row.id_magacin_dok),
      customerId: stageRef(row.sifra_komitenta),
      projectId: stageRef(row.id_predmet),
      year: stageInt(row.godina),
    },
  };
};

export interface MappedGoodsItem {
  id: number;
  documentId: number;
  itemId: number;
  catalogNumber: string | null;
  warehouseId: number;
  quantity: string | null;
  quantityIn: string;
  quantityOut: string;
  kgQuantity: string | null;
  purchasePriceNet: string | null;
  actualWholesalePrice: string | null;
  actualRetailPrice: string | null;
  discountPercent: string | null;
  itemDescription: string | null;
}

/**
 * `T_Robne stavke` (staging red) -> `goods_document_items_mirror`.
 *
 * 🔴 MAGACIN SE UZIMA SA STAVKE (`IDMagacin`), NIKAD SA ZAGLAVLJA. Mereno:
 * u Level 0 se ta dva danas poklapaju u svih 18.865 stavki — pa bi provera „radi
 * isto" prošla — ali u Level 250 se RAZLIKUJU u 523 stavke. A Level 250 je baš
 * ono što daje kolonu REZERVISANO, dakle 523 rezervacije bi bile pripisane
 * pogrešnom magacinu, i to samo na jednoj od tri kolone ekrana.
 *
 * 🔴 `itemId` JE NAŠ `items.id`, NE BigBit šifra. BigBit šifra je
 * `items.external_item_id` i sa `items.id` se ne poklapa NIGDE (izmereno
 * 31.07.2026: 0 od 92.511 redova) — ključ po `id`-u bi lager tiho vezao za
 * 58.143 nepovezana artikla. Prevođenje radi `BbItemIndex`; šifra bez para se
 * PRESKAČE i imenuje (ne obara uvoz), jer stavka koja pokazuje na artikal kog
 * nemamo nema šta da prikaže ni na jednom ekranu. Sledeća noć je vraća čim
 * `importItems` donese taj artikal.
 */
export const mapGoodsItemRow = (
  row: Record<string, unknown>,
  /** `IDDok` -> `Ulaz` iz ISTOG drop-a; smer nosi zaglavlje, ne stavka. */
  directions: Map<number, boolean>,
  items: BbItemIndex,
): MapResult<MappedGoodsItem> => {
  const id = stageInt(row.id_stavke);
  if (id === null || id <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: IDStavke="${shown(row.id_stavke)}" nije upotrebljiv broj`,
    };
  const documentId = stageInt(row.id_dok);
  if (documentId === null || documentId <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: stavka ${id} nema upotrebljiv IDDok ("${shown(row.id_dok)}")`,
    };
  const code = stageInt(row.sifra_artikla);
  if (code === null || code <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: stavka ${id} ima „Sifra artikla"="${shown(row.sifra_artikla)}"`,
    };
  const isInflow = directions.get(documentId);
  if (isInflow === undefined)
    return {
      ok: false,
      kind: "SKIP",
      reason: `preskočeno: stavka ${id} pokazuje na dokument ${documentId} kog u ovom fajlu nema`,
    };
  if (!items.has(code))
    return {
      ok: false,
      kind: "SKIP",
      reason: `preskočeno: stavka ${id} nosi BigBit šifru artikla ${code} koju 4.0 ne poznaje`,
    };
  const item = items.get(code) ?? null;
  if (item === null)
    return {
      ok: false,
      kind: "SKIP",
      reason:
        `preskočeno: BigBit šifru ${code} (stavka ${id}) drži VIŠE naših artikala — ` +
        "ne pogađam koji je pravi; razreši dubl kod nas",
    };
  const warehouseId = stageInt(row.id_magacin);
  const { quantityIn, quantityOut } = splitGoodsQuantity(
    row.kolicina,
    isInflow,
  );
  return {
    ok: true,
    value: {
      id,
      documentId,
      itemId: item.id,
      catalogNumber: cut(item.catalogNumber, 100),
      // Magacin 0 ne postoji u BigBitu (mereno: 0 od 182.539 stavki), a kolona je
      // NOT NULL — pa je 0 bezbedan pad koji se vidi na ekranu kao „bez magacina",
      // umesto reda koji propada na upisu.
      warehouseId: warehouseId ?? 0,
      quantity: bbDecimalText(row.kolicina),
      quantityIn,
      quantityOut,
      kgQuantity: bbDecimalText(row.kg_kolicina),
      purchasePriceNet: bbDecimalText(row.nabavna_cena_neto),
      actualWholesalePrice: bbDecimalText(row.stvarna_vp_cena),
      actualRetailPrice: bbDecimalText(row.stvarna_mp_cena),
      discountPercent: bbDecimalText(row.rabat_proc),
      itemDescription: cut(stageText(row.opis_stavke), 255),
    },
  };
};

export interface MappedRequisition {
  id: number;
  orderNumber: string | null;
  orderDate: string | null;
  supplierId: number | null;
  projectId: number | null;
  note: string | null;
  level: number;
  isOrdered: boolean;
  year: number | null;
}

/** `T_Trebovanja` -> `purchase_orders_mirror` (kartica „narudžbine"). */
export const mapRequisitionRow = (
  row: Record<string, unknown>,
): MapResult<MappedRequisition> => {
  const id = stageInt(row.id_treb);
  if (id === null || id <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: IDTreb="${shown(row.id_treb)}" nije upotrebljiv broj`,
    };
  return {
    ok: true,
    value: {
      id,
      orderNumber: cut(stageText(row.broj_trebovanja), 50),
      // Datum je ovde NULLABLE (za razliku od robnog dokumenta), pa nečitljiv
      // datum NE obara narudžbenicu — broj i dobavljač su i sami upotrebljivi.
      orderDate: bbDateText(row.datum_trebovanja),
      supplierId: stageRef(row.sifra_komitenta),
      projectId: stageRef(row.id_predmet),
      note: stageText(row.napomena),
      level: stageInt(row.level) ?? 0,
      isOrdered: bbBool(row.poruceno),
      year: stageInt(row.godina),
    },
  };
};

export interface MappedRequisitionItem {
  id: number;
  orderId: number;
  itemId: number;
  orderedQuantity: string | null;
  receivedQuantity: string | null;
  unitPrice: string | null;
  discountPercent: string | null;
  description: string | null;
  expectedDeliveryDate: string | null;
  deliveryDate: string | null;
  isDelivered: boolean;
}

/** `T_Trebovanja stavke` -> `purchase_order_items_mirror`. */
export const mapRequisitionItemRow = (
  row: Record<string, unknown>,
  /** `IDTreb`-ovi koji su STVARNO ušli u ogledalo (FK je `Cascade`, ali postoji). */
  knownOrders: Set<number>,
  items: BbItemIndex,
): MapResult<MappedRequisitionItem> => {
  const id = stageInt(row.id_stavke);
  if (id === null || id <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: IDStavke="${shown(row.id_stavke)}" nije upotrebljiv broj`,
    };
  const orderId = stageInt(row.id_treb);
  if (orderId === null || orderId <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: stavka ${id} nema upotrebljiv IDTreb ("${shown(row.id_treb)}")`,
    };
  const code = stageInt(row.sifra_artikla);
  if (code === null || code <= 0)
    return {
      ok: false,
      kind: "FILTER",
      reason: `odbačeno: stavka ${id} ima „Sifra artikla"="${shown(row.sifra_artikla)}"`,
    };
  if (!knownOrders.has(orderId))
    return {
      ok: false,
      kind: "SKIP",
      reason: `preskočeno: stavka ${id} pokazuje na trebovanje ${orderId} kog u ogledalu nema`,
    };
  if (!items.has(code))
    return {
      ok: false,
      kind: "SKIP",
      reason: `preskočeno: stavka ${id} nosi BigBit šifru artikla ${code} koju 4.0 ne poznaje`,
    };
  const item = items.get(code) ?? null;
  if (item === null)
    return {
      ok: false,
      kind: "SKIP",
      reason: `preskočeno: BigBit šifru ${code} (stavka ${id}) drži VIŠE naših artikala`,
    };
  return {
    ok: true,
    value: {
      id,
      orderId,
      itemId: item.id,
      orderedQuantity: bbDecimalText(row.treb_kol),
      receivedQuantity: bbDecimalText(row.isporucena_kolicina),
      unitPrice: bbDecimalText(row.cena),
      discountPercent: bbDecimalText(row.rabat_proc),
      description: cut(stageText(row.opis), 255),
      expectedDeliveryDate: bbDateText(row.ocekivani_datum_isporuke),
      deliveryDate: bbDateText(row.datum_isporuke),
      isDelivered: bbBool(row.isporuceno),
    },
  };
};

export interface MdbStepResult {
  entity: string;
  /** Redova u staging tabeli za ovaj drop (pre ijednog filtera). */
  staged: number;
  /** Novi redovi. */
  inserted: number;
  /** Postojeći redovi kojima se sadržaj STVARNO promenio u BigBitu. */
  updated: number;
  /** Postojeći redovi identični izvoru — Postgres nije pisao ništa. */
  unchanged: number;
  /** Redovi iz izvora koje smo namerno preskočili (uz razlog u `notes`). */
  skipped: number;
  /**
   * Redovi koje je filter izbacio PRE obrade (prazan datum, nenumerički ključ,
   * duplikat ključa). Ranije su tiho nestajali iz svih brojača — red koga izvor
   * ima, a 4.0 nema, ne sme da izgleda kao „nepromenjen".
   */
  filtered: number;
  /**
   * BRANA ZAKLJUČANIH NALOGA (stavka D, nalaz V6). Izmena iz BigBita koja bi
   * pogodila nalog u statusu `LOCKED` — dakle zaključan period, već predatu PDV
   * prijavu, već izračunat bilans. Uvoz je NE primenjuje, nego je upisuje u
   * `bb_import_rejected_changes` (staro → novo) i čeka ljudsku odluku.
   * Odvojeno od `skipped` NAMERNO: `skipped` (sudar broja naloga) obara ceo
   * uvoz, a odbijena izmena zaključanog naloga je normalno, očekivano stanje.
   */
  blockedLocked: number;
  durationMs: number;
  notes: string[];
}

/**
 * Presuda o nestalim MATIČNIM redovima (`customers`, `projects`).
 *
 * Merenje je namerno DRUGAČIJE od knjigovodstvenog (`MdbImportResult.vanished`):
 * tamo se 4.0 tabela poredi sa TEKUĆIM staging-om, ovde se staging PRETHODNOG
 * drop-a poredi sa staging-om tekućeg. Dva razloga, oba obavezujuća:
 *
 *  1. NEMA OZNAKE POREKLA NA MATIČNIM REDOVIMA. `projects` nema
 *     `imported_drop_id`, pa se „3.0-native predmet" (id koji izvor nikad nije
 *     poslao) i „BigBit predmet koji je nestao" u tabeli ne mogu razlikovati —
 *     poređenje 4.0↔staging bi svih ~1.000 nasleđenih native redova svake noći
 *     prijavljivalo kao nestale. Staging↔staging je čist BigBit sa OBE strane.
 *  2. RAZLIKA, NE STANJE. Obrisan komitent je EVENT: pojavi se u razlici tačno
 *     ONE noći kad je obrisan, a sutra ga nema ni u jednom od dva drop-a. Zato
 *     alarm zvoni jednom i sam se gasi — alarm koji se ne može ugasiti se
 *     ignoriše, pa bi s njim propao i pravi (isto načelo kao u `runWatchdog`).
 */
export interface MdbVanishedMaster {
  /** 4.0 tabela na koju se odnosi (`customers` | `projects`). */
  entity: string;
  /** Drop sa kojim je poređeno (`null` = nema sa čim, v. `verdict`). */
  baselineDropId: number | null;
  /** Koliko je redova nosio taj prethodni drop. */
  baselineRows: number;
  /** Koliko ih ovaj drop VIŠE NE NOSI. */
  vanished: number;
  /** `vanished / baselineRows`, zaokruženo na 4 decimale. */
  share: number;
  /**
   * `NEMA` — ništa nije nestalo.
   * `ARHIVIRANJE` — masovno (BigBit prazni zatvorenu godinu) → ne zvoni.
   * `ALARM` — pojedinačno usred godine → obara uvoz da bi nadzornik zvonio.
   * `BEZ_POREDJENJA` — prvi drop sa matičnim podacima ili je staging
   *   prethodnog drop-a već očišćen retention-om; NE tumači se kao „sve u redu".
   */
  verdict: "NEMA" | "ARHIVIRANJE" | "ALARM" | "BEZ_POREDJENJA";
  /** Do 10 primera (šifra + naziv / broj predmeta) za poruku čoveku. */
  examples: string | null;
}

export interface MdbImportResult {
  dropId: number | null;
  fileName: string | null;
  fileMtime: Date | null;
  fileSizeBytes: string | null;
  dropAgeHours: number | null;
  status: "DONE" | "SKIPPED" | "DISABLED" | "BUSY";
  steps: MdbStepResult[];
  /** Uvezeni redovi kojih u ovom drop-u VIŠE NEMA (obrisani/prekontirani u BigBitu). */
  vanished: { journalEntries: number; ledgerEntries: number };
  /**
   * Matični podaci — nestajanje mereno DROP-NA-DROP i presuđeno
   * (arhiviranje vs alarm). Zaseban ključ, a ne polje u `vanished`, jer je i
   * merenje zaseban pojam (v. `MdbVanishedMaster`).
   */
  vanishedMasters: MdbVanishedMaster[];
  durationMs: number;
  summary: string;
}

/** Baca se kad kanal dostave ne radi — posao MORA da padne glasno, ne da prođe tiho. */
export class BigbitMdbDropStaleError extends Error {}

/** Baca se kad izvorni dokument NIJE mogao da uđe (sudar broja naloga). */
export class BigbitMdbConflictError extends Error {}

/**
 * Baca se kad su matični redovi nestali POJEDINAČNO (dakle ne godišnjim
 * arhiviranjem). Pad je JEDINI kanal koji sam dolazi do čoveka: run postaje
 * `FAILED` → `bigbitStatus()` diže `danger` upozorenje `UVOZ_PAO` → jutarnji
 * `bigbit-sync-watchdog` gura zvonce adminima. Broj u summary-ju to ne ume
 * (nalaz S7: nadzornik čita samo status i grešku, ne tekst summary-ja).
 */
export class BigbitMdbVanishedMasterError extends Error {}

interface CountRow {
  staged: bigint | number;
  inserted: bigint | number;
  updated: bigint | number;
  skipped: bigint | number;
  fetched: bigint | number;
  /** Odbijene izmene nad ZAKLJUČANIM nalozima (stavka D); nema ga u koracima bez brane. */
  blocked_locked?: bigint | number;
  /** Koliko je odbijenih izmena PRVI put upisano u dnevnik u ovom prolazu. */
  logged_now?: bigint | number;
}

interface CountOnlyRow {
  c: bigint | number;
}

/** Brojači jedne serije grupnog upsert-a (robno ogledalo). */
interface UpsertCountRow {
  inserted: bigint | number;
  updated: bigint | number;
  /** Redovi koje je `JOIN` na roditelja izbacio pre upisa (nema ga svaki korak). */
  lost?: bigint | number;
}

/**
 * Staging redovi robnog ogledala — čitaju se sirovim SQL-om, po IMENIMA KOLONA
 * IZ BAZE (a ne kroz generisani Prisma klijent), da uvoz može da se isporuči i
 * pre nego što migracija ogledala legne (v. `mirrorNotReady`).
 */
interface StageGoodsDocRow {
  id: number;
  id_dok: string | null;
  ulaz: string | null;
  broj_dokumenta: string | null;
  vrsta_dokumenta: string | null;
  sifra_komitenta: string | null;
  datum_dokumenta: string | null;
  datum_knjizenja: string | null;
  id_magacin_dok: string | null;
  level: string | null;
  id_predmet: string | null;
  zakljucano: string | null;
  rezervisi: string | null;
  godina: string | null;
}

interface StageGoodsItemRow {
  id: number;
  id_stavke: string | null;
  id_dok: string | null;
  sifra_artikla: string | null;
  kolicina: string | null;
  kg_kolicina: string | null;
  nabavna_cena_neto: string | null;
  stvarna_vp_cena: string | null;
  stvarna_mp_cena: string | null;
  rabat_proc: string | null;
  id_magacin: string | null;
  opis_stavke: string | null;
}

interface StageRequisitionRow {
  id: number;
  id_treb: string | null;
  broj_trebovanja: string | null;
  datum_trebovanja: string | null;
  sifra_komitenta: string | null;
  id_predmet: string | null;
  napomena: string | null;
  level: string | null;
  poruceno: string | null;
  godina: string | null;
}

interface StageRequisitionItemRow {
  id: number;
  id_stavke: string | null;
  id_treb: string | null;
  sifra_artikla: string | null;
  treb_kol: string | null;
  isporucena_kolicina: string | null;
  cena: string | null;
  opis: string | null;
  ocekivani_datum_isporuke: string | null;
  datum_isporuke: string | null;
  isporuceno: string | null;
  rabat_proc: string | null;
}

/**
 * Imenovanje preskočenih redova: prvih `MAX_NAMED_SKIPS` se ispiše doslovno,
 * ostatak se sabere u jedan red. Isti obrazac koji `importItems` ima u sebi —
 * izdvojen jer ga robno ogledalo koristi na četiri mesta, a poenta je uvek ista:
 * red koji nije ušao mora da ima IME, a ne samo broj.
 */
class Named {
  private readonly named: string[] = [];
  private extra = 0;

  add(msg: string): void {
    if (this.named.length < MAX_NAMED_SKIPS) this.named.push(msg);
    else this.extra++;
  }

  into(notes: string[]): void {
    notes.push(...this.named);
    if (this.extra > 0)
      notes.push(
        `…i još ${this.extra} sličnih redova (imenovano je prvih ${MAX_NAMED_SKIPS}; ` +
          "puna slika je u bb_mdb_drops.import_row_counts)",
      );
  }
}

interface VanishedMasterRow {
  baseline_drop: number | null;
  baseline_rows: bigint | number;
  vanished: bigint | number;
  examples: string | null;
}

interface LedgerPageRow {
  page_rows: bigint | number;
  eligible: bigint | number;
  inserted: bigint | number;
  updated: bigint | number;
  blocked_locked: bigint | number;
  logged_now: bigint | number;
  max_key: bigint | number;
}

const n = (v: bigint | number | null | undefined): number => Number(v ?? 0);

@Injectable()
export class BigbitMdbImportService {
  private readonly logger = new Logger(BigbitMdbImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uvezi najnoviji stagovan drop.
   *
   * @param opts.dropId    konkretan drop (default: najnoviji sa `stage_status='LOADED'`)
   * @param opts.force     uvezi i drop koji je već `import_status='DONE'`
   * @param opts.skipFreshnessCheck  SAMO za ručno vraćanje istorije; noćni posao ga NIKAD ne šalje
   * @param opts.maxAgeHours override praga svežine (ručno pokretanje)
   * @param opts.acceptVanishedMasters  RUČNO potvrđivanje pojedinačno nestalih matičnih
   *   redova: uvoz ih i dalje BROJI i piše u `import_row_counts`, ali ne obara run.
   *   Isti obrazac kao `BB_ALLOW_SHRINK=1` u koraku 1 — čovek je pogledao brojeve i
   *   rekao „znam, tako treba". Noćni posao ga NIKAD ne šalje; bez ovoga bi drop sa
   *   priznatim brisanjem zaglavio u `FAILED` i nikad ne bi dobio `imported_at`.
   */
  async runImport(
    opts: {
      dropId?: number;
      force?: boolean;
      skipFreshnessCheck?: boolean;
      maxAgeHours?: number;
      acceptVanishedMasters?: boolean;
    } = {},
  ): Promise<MdbImportResult> {
    const startedAt = Date.now();
    const empty = {
      dropId: null,
      fileName: null,
      fileMtime: null,
      fileSizeBytes: null,
      dropAgeHours: null,
      steps: [],
      vanished: { journalEntries: 0, ledgerEntries: 0 },
      vanishedMasters: [],
    };

    // ── PREKIDAČ ────────────────────────────────────────────────────────────
    // Provera je i u scheduler-u (jedna kapija za sve poslove), ali stoji i ovde
    // NAMERNO: ovo je metoda koja stvarno piše u glavnu knjigu i nijedan budući
    // ulaz (test, skripta, novi kontroler) ne sme da je zaobiđe.
    if (!(await this.isEnabled())) {
      return {
        ...empty,
        status: "DISABLED",
        durationMs: Date.now() - startedAt,
        summary: `${switchDisabledReason(BIGBIT_MDB_SYNC_SWITCH)} Ništa nije uvezeno.`,
      };
    }

    const drop = await this.prisma.bbMdbDrop.findFirst({
      where: opts.dropId ? { id: opts.dropId } : { stageStatus: "LOADED" },
      orderBy: opts.dropId ? undefined : { fileMtime: "desc" },
    });

    // ── SVEŽINA (zahtev 2): tišina je najgori ishod ────────────────────────
    if (!drop) {
      throw new BigbitMdbDropStaleError(
        "Podaci iz BigBita nisu stigli — nema nijednog učitanog fajla. Uvoz je zaustavljen " +
          "da 4.0 ne bi računao PDV nad starim podacima. Problem je u dostavi iz BigBita, ne u 4.0. " +
          "[tehnički: `bb_mdb_drops` nema red sa stage_status='LOADED'; proveri systemd timer " +
          "`bigbit-mdb-export.timer` na ubuntusrv i folder /srv/bigbit-incoming/ — " +
          "docs/migration/BIGBIT_NOCNI_SYNC.md §Kad padne]",
      );
    }
    if (drop.stageStatus !== "LOADED") {
      throw new BigbitMdbDropStaleError(
        `Priprema podataka iz BigBita nije uspela — fajl "${drop.fileName}" nije učitan. ` +
          `Javite osobi zaduženoj za BigBit izvoz. ` +
          `[tehnički: stage_status=${drop.stageStatus}; greška koraka 1: ${drop.stageError ?? "(nije zabeležena)"}]`,
      );
    }

    // SVEŽINA SE MERI PO DATUMU IZ IMENA FAJLA, NE PO `mtime`-u (ispravka 30.07.2026).
    //
    // Dostava pravi JEDAN backup dnevno i datum stavlja U IME: `BB_T_26_30-07-26.mdb`.
    // To je najpošteniji signal koji imamo, i jedini koji meri ono što nas zanima —
    // „da li je dostava radila danas".
    //
    // `mtime` to NE meri: kopiranje ga nasleđuje od izvorne baze, pa on govori kad
    // je BigBit poslednji put nešto upisao. Izmereno na živom fajlu: ime nosi 30.07,
    // `mtime` 16:03, a na server je legao u 21:38. Da smo ostali na `mtime`-u, prvi
    // ponedeljak posle mirnog vikenda odbio bi savršeno svežu dostavu kao „staru tri
    // dana" — i to bez ijednog stvarnog kvara, svake nedelje.
    //
    // Rezerva je `ctime` (vreme dolaska na disk), pa `mtime` — u tom redosledu, da
    // fajl neobičnog imena ne prođe bez ijedne provere.
    const nameDate = dropDateFromFileName(drop.fileName);
    const freshnessBasis = nameDate ?? drop.stagedAt ?? drop.fileMtime;
    const basisLabel = nameDate
      ? "datum iz imena fajla"
      : drop.stagedAt
        ? "vreme dolaska na server"
        : "mtime (rezerva)";
    const ageHours = (Date.now() - freshnessBasis.getTime()) / (1000 * 60 * 60);
    const maxAge = opts.maxAgeHours ?? MAX_DROP_AGE_HOURS;
    if (!opts.skipFreshnessCheck && ageHours > maxAge) {
      throw new BigbitMdbDropStaleError(
        `Podaci iz BigBita nisu stigli od ${freshnessBasis.toISOString().slice(0, 16).replace("T", " ")} ` +
          `(fajl "${drop.fileName}" je star ${ageHours.toFixed(1)} h po ${basisLabel}, ` +
          `dozvoljeno je ${maxAge} h). ` +
          "Uvoz je zaustavljen da se PDV ne bi računao nad starim podacima. " +
          "Noćni izvoz iz BigBita ne radi — javite osobi zaduženoj za BigBit; kvar NIJE u 4.0. " +
          "[tehnički: docs/migration/BIGBIT_NOCNI_SYNC.md §Kad padne]",
      );
    }

    // LAŽNA SVEŽINA: `mtime` se pomeri i pukim `cp`-jem ili ponovnom isporukom
    // ISTOG fajla, pa bi dvonedeljni sadržaj izgledao „star 0,2 h" — tačno kvar
    // od koga brana svežine brani, samo maskiran. sha256 je do sada bio samo
    // upisan i nikad poređen.
    if (!opts.skipFreshnessCheck && drop.fileSha256) {
      const twin = await this.prisma.bbMdbDrop.findFirst({
        where: {
          id: { not: drop.id },
          fileSha256: drop.fileSha256,
          importStatus: "DONE",
        },
        orderBy: { importedAt: "desc" },
      });
      if (twin) {
        throw new BigbitMdbDropStaleError(
          `BigBit je ponovo isporučio ISTI fajl — sadržaj "${drop.fileName}" je bajt-u-bajt jednak ` +
            `fajlu "${twin.fileName}" koji je već uvezen ${twin.importedAt?.toISOString() ?? "?"}. ` +
            "Datum fajla je nov, ali podaci nisu — noćni izvoz iz BigBita verovatno ne radi, samo " +
            "prekopira staru kopiju. Javite osobi zaduženoj za BigBit. " +
            `[tehnički: sha256 ${drop.fileSha256.slice(0, 12)}… identičan drop-u ${twin.id}]`,
        );
      }
    }

    const common = {
      dropId: drop.id,
      fileName: drop.fileName,
      fileMtime: drop.fileMtime,
      fileSizeBytes: drop.fileSize.toString(),
      dropAgeHours: Number(ageHours.toFixed(1)),
    };

    if (drop.importStatus === "DONE" && !opts.force) {
      return {
        ...common,
        status: "SKIPPED",
        steps: [],
        vanished: { journalEntries: 0, ledgerEntries: 0 },
        vanishedMasters: [],
        durationMs: Date.now() - startedAt,
        summary:
          `drop ${drop.id} (${drop.fileName}) je već uvezen ` +
          `${drop.importedAt?.toISOString() ?? "?"} — ništa novo. ` +
          "Novi drop stiže sledećom noćnom dostavom.",
      };
    }

    // ── MUTEX (atomski CAS) ─────────────────────────────────────────────────
    // Scheduler-ov guard hvata samo RUNNING mlađi od 10 min; uvoz pune glavne
    // knjige to prelazi, pa su dva uvoza mogla da pišu jedan preko drugog.
    if (!(await this.claimDrop(drop.id))) {
      return {
        ...common,
        status: "BUSY",
        steps: [],
        vanished: { journalEntries: 0, ledgerEntries: 0 },
        vanishedMasters: [],
        durationMs: Date.now() - startedAt,
        summary:
          `uvoz drop-a ${drop.id} (${drop.fileName}) je VEĆ U TOKU (pokrenut ` +
          `${drop.importStartedAt?.toISOString() ?? "?"}) — ovo pokretanje ništa nije radilo. ` +
          "Sačekajte da se prvi završi.",
      };
    }

    const steps: MdbStepResult[] = [];
    let vanished = { journalEntries: 0, ledgerEntries: 0 };
    let vanishedMasters: MdbVanishedMaster[] = [];
    try {
      // ── PRAZAN IZVOZ NIJE USPEH ──────────────────────────────────────────
      // Polovično prekopiran 375 MB Access fajl daje ISPRAVNO zaglavlje i manje
      // redova; bez ove brane drop bi prošao kao DONE i nikad se ne bi ponovio.
      await this.assertStagingNotEmpty(drop.id);

      // ═══ MATIČNI PODACI IDU PRVI ═══════════════════════════════════════
      // Redosled UNUTAR matičnih je iznuđen: `Predmeti.IDKomitent` pokazuje na
      // `customers.id`, pa komitent mora da postoji pre predmeta — inače korak
      // predmeta mora da preskoči red bez para (isti obrazac kao
      // `importSaldakontoAccounts`, koji preskače konto kog nema u kontnom planu).
      //
      // A ZAŠTO PRE KNJIGOVODSTVA, a ne posle (odluka, ne navika):
      //  1. GK STAVKA POKAZUJE NA PREDMET, nikad obrnuto:
      //     `ledger_entries.source_project_id` se puni iz `IDPredmet`, a
      //     `source_work_order_id` iz `IDRadniNalog`. To su MEKE reference (nema
      //     FK — provereno u schema.prisma: `ledger_entries` ima FK samo na
      //     `journal_entries`, `accounts` i `bb_mdb_drops`), pa obrnut redosled ne
      //     bi pao — tiho bi ostavio prozor u kome je stavka glavne knjige u bazi,
      //     a predmet na koji pokazuje nije, i svaki ekran koji ih spaja u tom
      //     prozoru prikazuje prazno. Tiho je gore od glasno.
      //  2. NIJEDAN MATIČNI KORAK NE ZAVISI OD KNJIGOVODSTVA. `customers` i
      //     `projects` ne referišu ni `accounts`, ni `order_types`, ni naloge —
      //     dakle obrnut redosled ne kupuje NIŠTA, a rizik iz (1) nosi.
      //  3. JEFTINO PADA PRVO. Matični koraci su ~6,7k + ~7,6k redova upsert-a,
      //     glavna knjiga je 20k+ u serijama. Ako matični korak padne (sudar
      //     broja predmeta, komitent bez para), padne pre nego što se potroši
      //     najteži deo posla.
      steps.push(await this.importCustomers(drop.id));
      steps.push(await this.importProjects(drop.id));

      // Redosled je OBAVEZAN (zahtev 4 + FK lanac):
      //   accounts -> order_types -> saldakonto -> journal_entries -> ledger_entries
      steps.push(await this.importAccounts(drop.id));
      steps.push(await this.importOrderTypes(drop.id));
      // ŠIFARNICI ARTIKALA (O-4, 30.07.2026) — redosled je OBAVEZAN jer se vezuju
      // jedno na drugo: grupa -> podgrupa (`GrupaVeza`) -> poreklo (`PodgrupaVeza`).
      // Obrnut redosled bi svaku vezu nulirao pri prvom prolazu i popravio je tek
      // sledeće noći — dakle šifarnik bi jedan dan bio bez hijerarhije.
      steps.push(await this.importItemGroups(drop.id));
      steps.push(await this.importItemSubgroups(drop.id));
      steps.push(await this.importItemOrigins(drop.id));
      steps.push(await this.importWarehouses(drop.id));
      // Artikli POSLE svojih šifarnika (grupa/podgrupa/poreklo/magacin su im
      // roditelji po smislu, iako FK u 4.0 nisu tvrdi) — tako artikal nikad ne
      // pokazuje na grupu koja ove noći još nije ušla.
      steps.push(await this.importItems(drop.id));
      steps.push(await this.importSaldakontoAccounts(drop.id));
      steps.push(await this.importJournalEntries(drop.id));
      steps.push(await this.importLedgerEntries(drop.id));
      // ZAKLJUČAVANJE IDE POSLEDNJE (ispravka posle drugog kruga pregleda 28.07.):
      // dok se BigBit-ova zastavica primenjivala u koraku zaglavlja, korak stavki je
      // isti nalog zaticao kao LOCKED i odbijao iznose IZ ISTOG FAJLA koji ga je
      // zaključao — zaglavlje preuzeto, iznosi stari. Sada stavke prvo uđu.
      steps.push(await this.applyBigbitLocks(drop.id));

      // ═══ ROBNO OGLEDALO IDE POSLEDNJE ═══════════════════════════════════
      // Redosled UNUTAR robnog je iznuđen FK-ovima: zaglavlje pre svojih stavki
      // (stavka bez dokumenta obori CELU seriju od 2.000 redova).
      //
      // A ZAŠTO POSLE KNJIGOVODSTVA (odluka, ne navika):
      //  1. ROBNO NE ULAZI U PDV NI U BILANS — to je ogledalo za ekran (lager,
      //     kartica artikla). Njegov pad ne sme da odloži glavnu knjigu, koja
      //     nosi poresku prijavu. Obrnut redosled bi svaki kvar u 182.500 robnih
      //     stavki pretvorio u izostalu PDV osnovicu.
      //  2. ZAVISI OD ARTIKALA, a `importItems` je već prošao: stavka se veže za
      //     `items.id` preko BigBit šifre, pa svaki artikal koji je stigao OVE
      //     noći odmah ume da primi svoje robno kretanje.
      //  3. NAJTEŽI KORAK IDE POSLEDNJI — robno je veće od glavne knjige i
      //     artikala zajedno (182.539 + 86.779 stavki).
      steps.push(await this.importGoodsDocuments(drop.id));
      steps.push(await this.importGoodsDocumentItems(drop.id));
      steps.push(await this.importPurchaseOrders(drop.id));
      steps.push(await this.importPurchaseOrderItems(drop.id));

      // ── NESTALO IZ BIGBITA ───────────────────────────────────────────────
      // Uvoz je čist upsert i NIKAD ne briše, pa nalog obrisan/prekontiran u
      // BigBitu zauvek ostaje u 4.0 i tiho diže PDV osnovicu. Ne brišemo
      // automatski (to je knjigovodstvena odluka) — ali se GLASNO broji.
      vanished = await this.countVanished(drop.id);

      // ── NESTALO IZ MATIČNIH: ARHIVIRANJE ĆUTI, POJEDINAČNO ZVONI ─────────
      vanishedMasters = await this.countVanishedMasters(drop.id);

      // ── DRUGI SMER: ŠTA IZVOR NOSI A KOD NAS GA NEMA (O-2, 30.07.2026) ───
      // Ovo NE obara uvoz — red koji fali se dopuni sledećim prolazom čim se
      // ukloni uzrok. Ali se GLASNO imenuje, jer je pravi kvar i jer se kroz
      // brojače jednog prolaza ne vidi: red otpao pre tri noći od tada ne pravi
      // nikakvu razliku, izvor ga nosi a kod nas ga nema, i to se ćutke ponavlja.
      for (const m of await this.countMissingFromOurSide(drop.id)) {
        const step = steps.find((s) => s.entity === m.entity);
        if (m.missing > 0) {
          const poruka =
            `${m.missing} od ${m.inSource} redova iz BigBita NIJE u 4.0 — ` +
            `izvor ih nosi, kod nas ih nema. Primeri: ${m.examples.join(", ") || "(nema)"}. ` +
            "Nije nastalo brisanjem (uvoz nikad ne briše) nego odbijanjem pri upisu — " +
            "vidi upozorenja ovog prolaza.";
          step?.notes.push(poruka);
          this.logger.warn(`NEDOSTAJE U 4.0 (${m.entity}): ${poruka}`);
        }
        if (m.nativeOnly > 0)
          step?.notes.push(
            `${m.nativeOnly} red(ova) u 4.0 nema parnjaka u BigBitu — to su redovi ` +
              "nastali u 4.0 (bivši dvojni unos). Očekivano, ne traži radnju.",
          );
      }

      // ── SUDAR BROJA NALOGA = KVAR, NE FUSNOTA ────────────────────────────
      // Preskočen nalog povuče i sve svoje GK stavke (JOIN po bb_nalog_id), pa
      // ceo dokument sa svojom PDV osnovicom nikad ne uđe. Ranije je to bio broj
      // u jednoj log liniji uz status DONE.
      const je = steps.find((s) => s.entity === "journal_entries");
      if (je && je.skipped > 0) {
        throw new BigbitMdbConflictError(
          `${je.skipped} BigBit nalog(a) NIJE moglo da uđe u 4.0 jer isti broj naloga ` +
            `(firma, vrsta, godina, broj) već drži nalog nastao u 4.0. Sa svakim takvim nalogom ` +
            "otpadaju i sve njegove stavke glavne knjige, pa poređenje PDV obračuna promašuje " +
            `baš tu razliku. Sudari: ${je.notes.filter((x) => x.startsWith("sudar:")).join(" | ") || "(vidi bb_mdb_drops.import_row_counts)"}. ` +
            "Rešenje: u 4.0 ne knjižiti u vrste naloga i godine koje vodi BigBit, ili preknjižiti " +
            "sporni 4.0 nalog na slobodan broj. [tehnički: uq_journal_entries_number]",
        );
      }

      // ── SUDAR BROJA PREDMETA = IMENOVANA GREŠKA, ALI NE OBARA UVOZ ───────
      // Predmeti se u prelaznom režimu otvaraju RUČNO U OBA sistema (4.0 dodeli
      // broj → isti broj se prekuca u BigBit), pa BigBit kopija stiže sa SVOJIM
      // `IDPredmet`-om ali ISTIM `BrojPredmeta`. `uq_projects_project_number` je
      // tvrd (parcijalni unique iz 20260725200000), pa slep insert ne bi napravio
      // dupli predmet — oborio bi CEO uvoz na unique violation. Zato korak
      // predmeta takvu kopiju PRESKAČE i broji u `skipped`.
      //
      // ZAŠTO OVDE NEMA `throw` (svesna razlika prema sudaru broja NALOGA):
      // takvih redova u bazi VEĆ IMA — nasleđene „senke predmeta" (3.0-native
      // predmeti nastali pre paritet-guarda; BIGBIT_NOCNI_SYNC.md §11.8). Uslov
      // je trajan i nerešiv jednom noćnom odlukom, pa bi `throw` obarao uvoz
      // SVAKE noći od prvog dana — a alarm koji se ne može ugasiti se ignoriše i
      // sa njim propadne i pravi (isto načelo kao u nadzorniku). Sudar naloga
      // obara run jer promašuje PDV osnovicu; dupli predmet ne ulazi u PDV.
      // Zato: glasno u summary, u `import_row_counts` i u log — ne u pad.
      const proj = steps.find((s) => s.entity === "projects");
      if (proj && proj.skipped > 0) {
        this.logger.warn(
          `SUDAR BROJA PREDMETA: ${proj.skipped} BigBit predmet(a) nije ušlo — isti broj već drži ` +
            "predmet nastao u 4.0. Predmeti se otvaraju ručno u oba sistema; postupak za operatera: " +
            "docs/migration/BIGBIT_NOCNI_SYNC.md §9.",
        );
      }

      // ── POJEDINAČNO NESTALI MATIČNI RED = ALARM KOJI MORA DA ZVONI ───────
      // Pad je JEDINI kanal koji sam dolazi do čoveka (run FAILED → `UVOZ_PAO` →
      // jutarnje zvonce). Nadzornik čita STATUS i GREŠKU, nikad tekst summary-ja
      // — zato broj u summary-ju do sada nije video niko (nalaz S7).
      //
      // ALARM SE SAM GASI: merenje je razlika drop-na-drop, pa je obrisan
      // komitent odsutan i iz SUTRAŠNJEG i iz prekosutrašnjeg drop-a → sutra
      // verdikt više nije ALARM i uvoz je opet DONE. Nema stanja koje zvoni
      // zauvek; ako čovek hoće da ISTI drop propusti, postoji `acceptVanishedMasters`.
      const alarms = vanishedMasters.filter((v) => v.verdict === "ALARM");
      if (alarms.length && !opts.acceptVanishedMasters) {
        throw new BigbitMdbVanishedMasterError(
          "Iz BigBita su NESTALI matični podaci, i to POJEDINAČNO — dakle nije godišnje " +
            "arhiviranje zatvorene godine, nego je neko obrisao redove. " +
            alarms
              .map(
                (v) =>
                  `${MASTER_LABELS[v.entity] ?? v.entity}: ${v.vanished} od ${v.baselineRows} ` +
                  `(${(v.share * 100).toFixed(2)} %)${v.examples ? ` — ${v.examples}` : ""}`,
              )
              .join("; ") +
            ". Uvoz JE upisao sve što je u fajlu (ništa se ne briše), ali je run označen kao " +
            "neuspešan da bi ova poruka došla do čoveka. Proverite u BigBitu da li je brisanje " +
            "namerno: obrisan komitent/predmet u 4.0 OSTAJE (na njemu vise fakture, radni nalozi " +
            "i knjiženja), pa se dva sistema od te tačke razilaze. " +
            `[tehnički: poređenje drop-na-drop, prag ARHIVIRANJA je ${MASTER_VANISHED_MASS_ROWS} redova I ` +
            `${(MASTER_VANISHED_MASS_SHARE * 100).toFixed(0)} % tabele; da se drop svesno propusti — ` +
            "runImport({ acceptVanishedMasters: true }); docs/migration/BIGBIT_NOCNI_SYNC.md §9]",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.bbMdbDrop.update({
        where: { id: drop.id },
        data: {
          importStatus: "FAILED",
          importStartedAt: null,
          importError: message.slice(0, 4000),
          // ISTI OBLIK KAO NA USPEHU (`{ steps, vanished, vanishedMasters }`), a ne
          // goli niz koraka: alarm o nestalim matičnim redovima OBARA run, pa bi se
          // baš u tom slučaju izgubili brojevi zbog kojih je i pao — a čovek koji
          // ujutru dobije zvonce prvo otvara ovaj JSON.
          importRowCounts: {
            steps,
            vanished,
            vanishedMasters,
          } as unknown as Prisma.InputJsonValue,
          importDurationMs: Date.now() - startedAt,
        },
      });
      await this.recordFailure(drop, message);
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    await this.prisma.bbMdbDrop.update({
      where: { id: drop.id },
      data: {
        importStatus: "DONE",
        importStartedAt: null,
        importedAt: new Date(),
        importDurationMs: durationMs,
        importRowCounts: {
          steps,
          vanished,
          vanishedMasters,
        } as unknown as Prisma.InputJsonValue,
        importError: null,
      },
    });

    const summary = this.describe(
      drop.fileName,
      ageHours,
      steps,
      vanished,
      vanishedMasters,
      durationMs,
    );
    // HEARTBEAT za ekran Podešavanja → Integracije. Bez ovog reda kartica doveka
    // piše „Još nije bilo uvoza" i kad uvoz uredno radi svake noći.
    await this.recordSuccess(drop, steps, summary);

    return {
      ...common,
      status: "DONE",
      steps,
      vanished,
      vanishedMasters,
      durationMs,
      summary,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PREKIDAČ / MUTEX / HEARTBEAT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Prekidač iz Podešavanja. NEMA reda = UKLJUČENO (OFF-prekidač; odsustvo reda
   * ne sme tiho da ugasi noćni uvoz). Greška u čitanju se LOGUJE i takođe pušta
   * posao dalje — nedostupnost prekidača ne sme da bude razlog izostanka uvoza.
   */
  private async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.appSwitch.findUnique({
        where: { key: BIGBIT_MDB_SYNC_SWITCH },
      });
      return row ? row.enabled : true;
    } catch (e) {
      // Ranije je ovo bio nemi `catch { return true }` — gutao je i preimenovanu
      // kolonu, i uskraćen GRANT, i prekid konekcije. Prekidač koji ne radi mora
      // bar da ostavi trag.
      this.logger.error(
        `Prekidač „${BIGBIT_MDB_SYNC_SWITCH}" se ne može pročitati (uvoz se NASTAVLJA): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return true;
    }
  }

  /** Atomski claim drop-a. `false` = drugi uvoz ga već drži. */
  private async claimDrop(dropId: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE bb_mdb_drops
         SET import_started_at = now()
       WHERE id = ${dropId}
         AND (import_started_at IS NULL
              -- ::int je OBAVEZAN: Prisma parametar stiže kao bigint, a
              -- make_interval(hours => bigint) ne postoji (42883).
              OR import_started_at < now() - make_interval(hours => ${IMPORT_LOCK_STALE_HOURS}::int))
      RETURNING id`;
    return rows.length > 0;
  }

  /** `bb_sync_state` heartbeat posle uspešnog uvoza (ugovor sa ekranom, stavka B). */
  private async recordSuccess(
    drop: { fileName: string; fileMtime: Date },
    steps: MdbStepResult[],
    summary: string,
  ): Promise<void> {
    const rowsImported = steps.reduce((a, s) => a + s.inserted + s.updated, 0);
    const cursor = {
      sourceFile: drop.fileName,
      // ISO sa zonom; ekran iz ovoga računa STAROST IZVORNOG FAJLA — jedina
      // zaštita od „uvoz uredno radi svake noći nad bajatim fajlom".
      sourceFileModifiedAt: drop.fileMtime.toISOString(),
      rowsImported,
      lastSummary: summary.slice(0, 500),
    };
    // Namerno kroz Prisma (`new Date()`), NIKAD kroz SQL `now()`: kolona je
    // legacy `Timestamp(6)` BEZ zone, pa bi `now()` na serveru u Europe/Belgrade
    // upisao vrednost 2 h u budućnosti i pragovi zastarelosti bi kasnili.
    await this.prisma.bbSyncState
      .upsert({
        where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
        create: {
          entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
          cursor,
          lastSuccessAt: new Date(),
          lastAttemptAt: new Date(),
          lastErrorMessage: null,
        },
        update: {
          cursor,
          lastSuccessAt: new Date(),
          lastAttemptAt: new Date(),
          lastErrorMessage: null,
        },
      })
      .catch((e: unknown) => {
        // Heartbeat je prikaz, ne podatak — njegov pad ne sme da poništi uvoz.
        this.logger.error(
          `bb_sync_state heartbeat nije upisan: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  /** Trag o padu — da ekran ume da kaže i „poslednji pokušaj je pao, evo zašto". */
  private async recordFailure(
    drop: { fileName: string; fileMtime: Date },
    message: string,
  ): Promise<void> {
    await this.prisma.bbSyncState
      .upsert({
        where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
        create: {
          entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
          cursor: {
            sourceFile: drop.fileName,
            sourceFileModifiedAt: drop.fileMtime.toISOString(),
          },
          lastAttemptAt: new Date(),
          lastErrorMessage: message.slice(0, 2000),
        },
        update: {
          lastAttemptAt: new Date(),
          lastErrorMessage: message.slice(0, 2000),
        },
      })
      .catch(() => undefined);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BRANE I KONTROLE
  // ───────────────────────────────────────────────────────────────────────────

  /** Prazan/polovičan izvoz mora da PADNE, ne da se upiše kao uspeh sa nula redova. */
  private async assertStagingNotEmpty(dropId: number): Promise<void> {
    const [gk, nalozi, konta] = await Promise.all([
      this.prisma.bbMdbStageGk.count({ where: { dropId } }),
      this.prisma.bbMdbStageNalog.count({ where: { dropId } }),
      this.prisma.bbMdbStageAccount.count({ where: { dropId } }),
    ]);
    if (!(gk > 0 && nalozi > 0 && konta > 0))
      throw new BigbitMdbDropStaleError(
        "Fajl iz BigBita je prazan ili nepotpun — nema šta da se uveze " +
          `(glavna knjiga ${gk} redova, nalozi ${nalozi}, kontni plan ${konta}). ` +
          "Najčešći uzrok: kopiranje .mdb fajla nije bilo završeno kad je izvoz krenuo. " +
          "Uvoz je zaustavljen; sledeća noćna dostava se pokušava normalno. " +
          "Ako se ponovi, javite osobi zaduženoj za BigBit izvoz.",
      );

    // ── BAJAT DROP NAD MATIČNIM PODACIMA ────────────────────────────────────
    // Ovo NIJE ista provera kao gore. Gornja štiti od praznog fajla; ovde je fajl
    // pun (glavna knjiga uredno stigla), ali su MATIČNE tabele u njemu nula —
    // izvoz je izgubio dve tabele (preimenovana tabela u BigBitu, ispao red iz
    // manifesta `TABLES` u koraku 1, `mdb-export` pao samo za njih). Bez ove
    // brane uvoz bi prošao kao DONE sa „customers +0/~0/=0" i šifarnik u 4.0 bi
    // ostao na jučerašnjem stanju — tiho, dok ne zafali komitent na fakturi.
    //
    // USLOV JE „A RANIJE IH JE NOSIO": drop-ovi napravljeni pre 30.07.2026.
    // legitimno ne nose matične tabele (korak 1 ih tada nije izvozio), pa bi
    // bezuslovna provera oborila svaki ručni uvoz istorije. Poredi se sa
    // STROGO STARIJIM drop-om (`file_mtime <`), da ponovni uvoz starog fajla ne
    // pada zbog novijih drop-ova.
    const [m] = await this.prisma.$queryRaw<
      {
        kom_now: bigint | number;
        pre_now: bigint | number;
        had_kom: boolean;
        had_pre: boolean;
      }[]
    >`
      SELECT
        (SELECT count(*) FROM bb_mdb_stage_komitenti WHERE drop_id = ${dropId}) AS kom_now,
        (SELECT count(*) FROM bb_mdb_stage_predmeti  WHERE drop_id = ${dropId}) AS pre_now,
        EXISTS (SELECT 1 FROM bb_mdb_stage_komitenti k
                  JOIN bb_mdb_drops d ON d.id = k.drop_id
                 WHERE k.drop_id <> ${dropId}
                   AND d.file_mtime < (SELECT file_mtime FROM bb_mdb_drops WHERE id = ${dropId})) AS had_kom,
        EXISTS (SELECT 1 FROM bb_mdb_stage_predmeti p
                  JOIN bb_mdb_drops d ON d.id = p.drop_id
                 WHERE p.drop_id <> ${dropId}
                   AND d.file_mtime < (SELECT file_mtime FROM bb_mdb_drops WHERE id = ${dropId})) AS had_pre`;
    const komNow = n(m?.kom_now);
    const preNow = n(m?.pre_now);
    const hadBefore = Boolean(m?.had_kom) || Boolean(m?.had_pre);
    if (komNow === 0 && preNow === 0 && hadBefore) {
      throw new BigbitMdbDropStaleError(
        "Fajl iz BigBita je stigao BEZ ŠIFARNIKA — ni jedan komitent ni jedan predmet, " +
          "a prethodni fajl ih je nosio. Uvoz je zaustavljen: da je prošao, komitenti i " +
          "predmeti u 4.0 ostali bi na jučerašnjem stanju, bez ijedne poruke, i to bi se " +
          "otkrilo tek kad zafali kupac na fakturi. Javite osobi zaduženoj za BigBit izvoz. " +
          "[tehnički: bb_mdb_stage_komitenti i bb_mdb_stage_predmeti imaju 0 redova za ovaj " +
          "drop; proveri manifest TABLES u bigbit-mdb-export.sh i da li su tabele " +
          "„Komitenti”/„Predmeti” preimenovane u BigBitu — docs/migration/BIGBIT_NOCNI_SYNC.md §5.6]",
      );
    }
    // JEDNA PRAZNA (a druga puna) je isto kvar, ali ne isti: tada je pao izvoz
    // TAČNO JEDNE tabele, pa se to imenuje i ne meša sa „fajl bez šifarnika".
    if ((komNow === 0) !== (preNow === 0) && hadBefore) {
      throw new BigbitMdbDropStaleError(
        `Iz BigBita je stigla samo jedna od dve matične tabele (komitenti ${komNow} redova, ` +
          `predmeti ${preNow}). Uvoz je zaustavljen jer predmet bez svog komitenta ne može da ` +
          "uđe, a nepun šifarnik je gori od nikakvog. Javite osobi zaduženoj za BigBit izvoz. " +
          "[tehnički: korak 1 je verovatno pao na jednoj tabeli — vidi bb_mdb_drops.stage_row_counts]",
      );
    }
  }

  /**
   * Koliko RANIJE uvezenih redova ovaj drop VIŠE NE SADRŽI.
   *
   * Napomena o dosegu: poređenje ima smisla samo dok drop nosi CELU istoriju koju
   * je 4.0 uvezao (danas jeste — `T_Glavna knjiga` ide u celini). Ako se ikad
   * pređe na isporuku po periodu, ovaj brojač treba suziti na taj period.
   */
  private async countVanished(
    dropId: number,
  ): Promise<{ journalEntries: number; ledgerEntries: number }> {
    const [je] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      WITH seen AS (
        SELECT id_naloga::int AS id FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId} AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
      )
      SELECT count(*) AS c FROM journal_entries j
      WHERE j.bb_nalog_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.id = j.bb_nalog_id)`;
    const [le] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      WITH seen AS (
        SELECT stavka_id::int AS id FROM bb_mdb_stage_gk
        WHERE drop_id = ${dropId} AND btrim(coalesce(stavka_id, '')) ~ '^[0-9]+$'
      )
      SELECT count(*) AS c FROM ledger_entries l
      WHERE l.bb_stavka_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.id = l.bb_stavka_id)`;
    return { journalEntries: n(je?.c), ledgerEntries: n(le?.c) };
  }

  /**
   * NESTALO IZ MATIČNIH TABELA — mereno DROP-NA-DROP i PRESUĐENO.
   *
   * Zašto se ne poredi sa 4.0 tabelom (kao `countVanished` za knjigovodstvo) i
   * zašto se razlika sama gasi — v. `MdbVanishedMaster`. Zašto je prag ovakav i
   * na kojim brojevima stoji — v. `MASTER_VANISHED_MASS_ROWS`.
   *
   * Ako prethodnog drop-a NEMA (prvi drop sa matičnim tabelama, ili je staging
   * starijih drop-ova već očistio noćni `retention-cleanup` — drži poslednjih 7),
   * verdikt je `BEZ_POREDJENJA`. To NIJE „sve u redu" i tako se i prikazuje:
   * ćutanje bi ovde značilo da posle svakog čišćenja staging-a jedna noć nema
   * nadzor nad šifarnikom, a nikad se ne bi videlo koja.
   */
  /**
   * DRUGI SMER: šta izvor NOSI a kod nas GA NEMA (odluka vlasnika O-2, 30.07.2026:
   * „porediti da se slučajno nešto ne nestane iz ServoSync-a").
   *
   * `countVanishedMasters` meri nestajanje IZ BIGBITA (jučerašnji drop vs današnji).
   * Ovo meri obrnuto i to je drugi kvar: red koji BigBit ima, a uvoz ga NIJE upisao.
   *
   * ZAŠTO NE STIŽE DA SE VIDI KROZ BROJAČE: `staged` vs `inserted+updated+unchanged`
   * hvata razliku samo unutar JEDNOG prolaza. Red koji je otpao pre tri noći (npr.
   * na predugačkoj vrednosti, kako se i desilo 30.07 sa 12 komitenata) posle toga
   * više ne pravi nikakvu razliku u brojačima: izvor ga nosi, kod nas ga nema, i
   * svaki sledeći prolaz to ćutke ponavlja. Zato se poređenje radi nad STANJEM, ne
   * nad prolazom.
   *
   * OVO NIJE ISTO ŠTO I 4.0-NATIVE RED. Red nastao u 4.0 (rezervisan opseg ključeva,
   * odnosno bivši dvojni unos predmeta) po definiciji nema parnjaka u BigBitu i tu
   * NIJE greška — zato se broji ODVOJENO i ne zvoni.
   */
  private async countMissingFromOurSide(
    dropId: number,
  ): Promise<{ entity: string; inSource: number; missing: number; nativeOnly: number; examples: string[] }[]> {
    const [kom] = await this.prisma.$queryRaw<
      { in_source: bigint; missing: bigint; native_only: bigint; examples: string[] }[]
    >`
      SELECT
        (SELECT count(*) FROM bb_mdb_stage_komitenti WHERE drop_id = ${dropId}) AS in_source,
        (SELECT count(*) FROM bb_mdb_stage_komitenti s
          WHERE s.drop_id = ${dropId}
            AND btrim(coalesce(s.sifra, '')) ~ '^[0-9]+$'
            AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = btrim(s.sifra)::int)) AS missing,
        (SELECT count(*) FROM customers c WHERE c.id >= ${NATIVE_ID_BASE}) AS native_only,
        (SELECT coalesce(array_agg(x.sifra ORDER BY x.sifra), '{}')
           FROM (SELECT btrim(s.sifra) AS sifra FROM bb_mdb_stage_komitenti s
                  WHERE s.drop_id = ${dropId}
                    AND btrim(coalesce(s.sifra, '')) ~ '^[0-9]+$'
                    AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = btrim(s.sifra)::int)
                  LIMIT 10) x) AS examples`;

    const [pred] = await this.prisma.$queryRaw<
      { in_source: bigint; missing: bigint; native_only: bigint; examples: string[] }[]
    >`
      SELECT
        (SELECT count(*) FROM bb_mdb_stage_predmeti WHERE drop_id = ${dropId}) AS in_source,
        (SELECT count(*) FROM bb_mdb_stage_predmeti s
          WHERE s.drop_id = ${dropId}
            AND btrim(coalesce(s.id_predmet, '')) ~ '^[0-9]+$'
            AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = btrim(s.id_predmet)::int)
            -- Predmet PRESKOČEN paritet-guardom nije „nestao": njegov broj drži
            -- 4.0-native red, što je poznat i imenovan slučaj iz dvojnog unosa.
            AND NOT EXISTS (SELECT 1 FROM projects p2
                             WHERE p2.project_number = btrim(s.broj_predmeta))) AS missing,
        (SELECT count(*) FROM projects p WHERE p.id >= ${NATIVE_ID_BASE}) AS native_only,
        (SELECT coalesce(array_agg(x.br ORDER BY x.br), '{}')
           FROM (SELECT btrim(s.broj_predmeta) AS br FROM bb_mdb_stage_predmeti s
                  WHERE s.drop_id = ${dropId}
                    AND btrim(coalesce(s.id_predmet, '')) ~ '^[0-9]+$'
                    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = btrim(s.id_predmet)::int)
                    AND NOT EXISTS (SELECT 1 FROM projects p2
                                     WHERE p2.project_number = btrim(s.broj_predmeta))
                  LIMIT 10) x) AS examples`;

    return [
      {
        entity: "customers",
        inSource: n(kom?.in_source),
        missing: n(kom?.missing),
        nativeOnly: n(kom?.native_only),
        examples: kom?.examples ?? [],
      },
      {
        entity: "projects",
        inSource: n(pred?.in_source),
        missing: n(pred?.missing),
        nativeOnly: n(pred?.native_only),
        examples: pred?.examples ?? [],
      },
    ];
  }

  private async countVanishedMasters(
    dropId: number,
  ): Promise<MdbVanishedMaster[]> {
    return [
      await this.countVanishedMaster(dropId, "customers"),
      await this.countVanishedMaster(dropId, "projects"),
    ];
  }

  private async countVanishedMaster(
    dropId: number,
    entity: "customers" | "projects",
  ): Promise<MdbVanishedMaster> {
    // BAZNI DROP = poslednji STROGO STARIJI drop koji je NOSIO ovu tabelu.
    // Redosled ide po `file_mtime` (poslovno vreme snimka), a ne po `id`
    // (redosled ubacivanja): ručna dostava starijeg fajla dobija veći `id`, pa bi
    // po id-u „prethodni" bio noviji snimak i razlika bi izašla naopako.
    //
    // NEMA `id::int` kastova jer se ključevi porede KAO TEKST, trimovano: to je
    // isti ključ na obe strane (isti izvoz, ista kolona), pa kast ništa ne kupuje
    // a nenumerička šifra (koje u `Sifra` istorijski ima) ne sme da obori upit.
    const rows =
      entity === "customers"
        ? await this.prisma.$queryRaw<VanishedMasterRow[]>`
            WITH base AS (
              SELECT k.drop_id, d.file_mtime
              FROM bb_mdb_stage_komitenti k
              JOIN bb_mdb_drops d ON d.id = k.drop_id
              WHERE k.drop_id <> ${dropId}
                AND d.file_mtime < (SELECT file_mtime FROM bb_mdb_drops WHERE id = ${dropId})
              GROUP BY k.drop_id, d.file_mtime
              ORDER BY d.file_mtime DESC
              LIMIT 1
            ),
            gone AS (
              SELECT DISTINCT btrim(k.sifra) AS key,
                     btrim(k.sifra) || ' ' || left(coalesce(btrim(k.naziv), ''), 30) AS label
              FROM bb_mdb_stage_komitenti k
              WHERE k.drop_id = (SELECT drop_id FROM base)
                AND nullif(btrim(coalesce(k.sifra, '')), '') IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM bb_mdb_stage_komitenti c
                  WHERE c.drop_id = ${dropId}
                    AND btrim(coalesce(c.sifra, '')) = btrim(k.sifra))
            )
            SELECT (SELECT drop_id FROM base) AS baseline_drop,
                   (SELECT count(*) FROM bb_mdb_stage_komitenti WHERE drop_id = (SELECT drop_id FROM base)) AS baseline_rows,
                   (SELECT count(*) FROM gone) AS vanished,
                   (SELECT string_agg(label, ', ' ORDER BY key)
                      FROM (SELECT key, label FROM gone ORDER BY key LIMIT 10) x) AS examples`
        : await this.prisma.$queryRaw<VanishedMasterRow[]>`
            WITH base AS (
              SELECT p.drop_id, d.file_mtime
              FROM bb_mdb_stage_predmeti p
              JOIN bb_mdb_drops d ON d.id = p.drop_id
              WHERE p.drop_id <> ${dropId}
                AND d.file_mtime < (SELECT file_mtime FROM bb_mdb_drops WHERE id = ${dropId})
              GROUP BY p.drop_id, d.file_mtime
              ORDER BY d.file_mtime DESC
              LIMIT 1
            ),
            gone AS (
              SELECT DISTINCT btrim(p.id_predmet) AS key,
                     coalesce(nullif(btrim(coalesce(p.broj_predmeta, '')), ''), 'IDPredmet ' || btrim(p.id_predmet)) AS label
              FROM bb_mdb_stage_predmeti p
              WHERE p.drop_id = (SELECT drop_id FROM base)
                AND nullif(btrim(coalesce(p.id_predmet, '')), '') IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM bb_mdb_stage_predmeti c
                  WHERE c.drop_id = ${dropId}
                    AND btrim(coalesce(c.id_predmet, '')) = btrim(p.id_predmet))
            )
            SELECT (SELECT drop_id FROM base) AS baseline_drop,
                   (SELECT count(*) FROM bb_mdb_stage_predmeti WHERE drop_id = (SELECT drop_id FROM base)) AS baseline_rows,
                   (SELECT count(*) FROM gone) AS vanished,
                   (SELECT string_agg(label, ', ' ORDER BY key)
                      FROM (SELECT key, label FROM gone ORDER BY key LIMIT 10) x) AS examples`;

    const row = rows[0];
    const baselineDropId = row?.baseline_drop == null ? null : n(row.baseline_drop);
    const baselineRows = n(row?.baseline_rows);
    const vanished = n(row?.vanished);
    const share = baselineRows > 0 ? vanished / baselineRows : 0;
    return {
      entity,
      baselineDropId,
      baselineRows,
      vanished,
      share: Number(share.toFixed(4)),
      verdict: this.judgeVanished(baselineDropId, baselineRows, vanished, share),
      examples: vanished > 0 ? (row?.examples ?? null) : null,
    };
  }

  /**
   * Presuda: masovno = godišnje arhiviranje (ćuti), pojedinačno = alarm (zvoni).
   * Oba uslova su obavezna i to je namerno — obrazloženje sa brojevima stoji nad
   * `MASTER_VANISHED_MASS_ROWS`.
   */
  private judgeVanished(
    baselineDropId: number | null,
    baselineRows: number,
    vanished: number,
    share: number,
  ): MdbVanishedMaster["verdict"] {
    if (baselineDropId === null || baselineRows === 0) return "BEZ_POREDJENJA";
    if (vanished === 0) return "NEMA";
    return vanished >= MASTER_VANISHED_MASS_ROWS &&
      share >= MASTER_VANISHED_MASS_SHARE
      ? "ARHIVIRANJE"
      : "ALARM";
  }

  /**
   * Jedna log linija koju čita i scheduler (`scheduled_job_runs.summary`) i ekran
   * (`bb_sync_state.cursor.lastSummary`, ODSEČENA NA 500 ZNAKOVA).
   *
   * ZATO UPOZORENJA IDU NA POČETAK, pre brojača po koracima: sa 8 koraka brojači
   * pojedu ~300 znakova, pa je „⚠ nestalo iz BigBita" na kraju niza umelo da
   * padne izvan reza i da na ekranu ne postoji. Identitet fajla ostaje prvi (bez
   * njega se ne zna o kom snimku je reč).
   */
  private describe(
    fileName: string,
    ageHours: number,
    steps: MdbStepResult[],
    vanished: { journalEntries: number; ledgerEntries: number },
    vanishedMasters: MdbVanishedMaster[],
    durationMs: number,
  ): string {
    const parts = steps.map(
      (s) =>
        `${s.entity} +${s.inserted}/~${s.updated}/=${s.unchanged}` +
        (s.skipped ? `/preskočeno ${s.skipped}` : "") +
        (s.filtered ? `/odbačeno ${s.filtered}` : "") +
        (s.blockedLocked ? `/zaključano ${s.blockedLocked}` : ""),
    );
    const alerts: string[] = [];

    // Sudar broja predmeta ne obara uvoz (nasleđene senke predmeta bi ga obarale
    // svake noći), ali mora da se VIDI i da kaže šta je posledica.
    const projSkipped =
      steps.find((s) => s.entity === "projects")?.skipped ?? 0;
    if (projSkipped > 0)
      alerts.push(
        `⚠ SUDAR BROJA PREDMETA: ${projSkipped} BigBit predmet(a) nije ušlo (isti broj već drži ` +
          "predmet nastao u 4.0) — ta dva sistema se na tim predmetima razilaze",
      );

    for (const v of vanishedMasters) {
      const label = MASTER_LABELS[v.entity] ?? v.entity;
      if (v.verdict === "ALARM")
        alerts.push(
          `⚠ ALARM: ${label} — ${v.vanished} red(ova) NESTALO iz BigBita usred godine ` +
            `(${(v.share * 100).toFixed(2)} % od ${v.baselineRows}; drop ${v.baselineDropId})` +
            (v.examples ? `: ${v.examples}` : ""),
        );
      else if (v.verdict === "ARHIVIRANJE")
        // Bez ⚠ i bez pada: presuda je da masovno nestajanje o promeni godine
        // NIJE alarm. Broj i dalje stoji u liniji — ćuti se zvonce, ne merenje.
        alerts.push(
          `${label}: ${v.vanished} red(ova) više nema u BigBitu ` +
            `(${(v.share * 100).toFixed(1)} % — masovno, čita se kao godišnje arhiviranje zatvorene godine)`,
        );
      else if (v.verdict === "BEZ_POREDJENJA")
        alerts.push(
          `${label}: nema prethodnog snimka za poređenje (nestajanje NIJE proveravano)`,
        );
    }

    const locked = steps.reduce((a, s) => a + s.blockedLocked, 0);
    if (locked)
      alerts.push(
        `⚠ ${locked} izmena iz BigBita nad ZAKLJUČANIM nalozima NIJE preuzeta — čeka odluku ` +
          "(bb_import_rejected_changes)",
      );
    if (vanished.journalEntries + vanished.ledgerEntries > 0)
      alerts.push(
        `⚠ nestalo iz BigBita: ${vanished.journalEntries} nalog(a) / ${vanished.ledgerEntries} stavki (ostaju u 4.0 — proveri)`,
      );

    return (
      `${fileName} (star ${ageHours.toFixed(1)} h) za ${(durationMs / 1000).toFixed(1)} s — ` +
      (alerts.length ? `${alerts.join(" | ")} — ` : "") +
      parts.join("; ") +
      " [novi/izmenjeni/nepromenjeni]"
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // KORACI
  // ───────────────────────────────────────────────────────────────────────────

  // MATIČNI PODACI (30.07.2026): `importCustomers` i `importProjects` su niže u
  // fajlu, uz ostale korake. Idu ISTIM kanalom kao knjigovodstvo otkad je prenos
  // BigBit→QBigTehn prestao da se radi (mereno 30.07: BigBit na predmetu 10014,
  // QBigTehn i 4.0 na 10005 — naš sync ispravan, izvor mrtav osam dana).
  /** `Kontni plan` -> `accounts`. FK meta za `ledger_entries.account_code`. */
  private async importAccounts(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(konto))
          btrim(konto)                                    AS code,
          left(coalesce(btrim(opis), ''), 255)            AS name,
          nullif(btrim(coalesce(dugacki_opis, '')), '')   AS long_description,
          -- accountClass = prva cifra. Nenumeričke šifre POSTOJE ('02101-1',
          -- '02206C') ali sve počinju cifrom; ako se to ikad promeni, klasa 0 je
          -- bezbedan pad (kolona je NOT NULL, red ne sme da propadne).
          CASE WHEN btrim(konto) ~ '^[0-9]' THEN left(btrim(konto), 1)::int ELSE 0 END AS account_class,
          (btrim(coalesce(dozvoljen_unos_analitike, '0')) = '1') AS allows_analytics,
          left(nullif(btrim(coalesce(fajl_sifara, '')), ''), 64) AS codebook_file,
          left(nullif(btrim(coalesce(ino_konto, '')), ''), 10)   AS foreign_account
        FROM bb_mdb_stage_kontni_plan
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(konto, '')), '') IS NOT NULL
          -- IDENTITETSKE KOLONE SE NE SKRAĆUJU: 'accounts.code' je VARCHAR(10) i
          -- 'left()' bi tiho spojio dva različita konta u jedan red. Predugačak
          -- konto se ODBACUJE i broji u 'filtered'.
          AND length(btrim(konto)) <= 10
        ORDER BY btrim(konto)
      ),
      ins AS (
        INSERT INTO accounts (code, name, long_description, account_class,
                              allows_analytics, codebook_file, foreign_account,
                              imported_drop_id, created_at, updated_at)
        SELECT code, name, long_description, account_class,
               allows_analytics, codebook_file, foreign_account,
               ${dropId}, now(), now()
        FROM src
        ON CONFLICT (code) DO UPDATE SET
          name             = EXCLUDED.name,
          long_description = EXCLUDED.long_description,
          account_class    = EXCLUDED.account_class,
          allows_analytics = EXCLUDED.allows_analytics,
          codebook_file    = EXCLUDED.codebook_file,
          foreign_account  = EXCLUDED.foreign_account,
          updated_at       = now()
        -- 'imported_drop_id' NIJE u poređenju (menja se svake noći i prepisao bi
        -- sve). Zadržava vrednost PRVOG drop-a koji je red doneo.
        WHERE (accounts.name, accounts.long_description, accounts.account_class,
               accounts.allows_analytics, accounts.codebook_file,
               accounts.foreign_account)
          IS DISTINCT FROM
              (EXCLUDED.name, EXCLUDED.long_description, EXCLUDED.account_class,
               EXCLUDED.allows_analytics, EXCLUDED.codebook_file,
               EXCLUDED.foreign_account)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_kontni_plan WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("accounts", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} red(ova) kontnog plana odbačeno — prazan konto, duplikat konta ili konto duži od 10 znakova`,
      );
    return step;
  }

  /** `Vrsta naloga` -> `order_types`. Meta za `journal_entries.order_type_code`. */
  private async importOrderTypes(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(vrsta_naloga))
          btrim(vrsta_naloga)                                  AS code,
          left(nullif(btrim(coalesce(opis, '')), ''), 50)       AS description
        FROM bb_mdb_stage_vrsta_naloga
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(vrsta_naloga, '')), '') IS NOT NULL
          -- Isti razlog kao kod konta: 'left(...,5)' bi TIHO spojio dve različite
          -- vrste naloga u jednu šifru, a time i njihove brojevne nizove — što
          -- vodi pravo u sudar broja naloga. Vrednost je već na granici (5/5).
          AND length(btrim(vrsta_naloga)) <= 5
        ORDER BY btrim(vrsta_naloga)
      ),
      ins AS (
        INSERT INTO order_types (code, description, imported_drop_id)
        SELECT code, description, ${dropId} FROM src
        ON CONFLICT (code) DO UPDATE SET
          description = EXCLUDED.description
        WHERE (order_types.description) IS DISTINCT FROM (EXCLUDED.description)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_vrsta_naloga WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("order_types", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} vrsta naloga odbačena — prazna, duplikat ili šifra duža od 5 znakova`,
      );
    return step;
  }

  // ╔═══════════════════════════════════════════════════════════════════════════╗
  // ║  ŠIFARNICI ARTIKALA I MAGACINI (odluka vlasnika O-4, 30.07.2026)          ║
  // ║                                                                            ║
  // ║  ZAŠTO SU BILI PRVI NA REDU: tabele su bile PRAZNE, a provera grupe i      ║
  // ║  podgrupe artikla radi po pravilu „prazan šifarnik se preskače" — dakle    ║
  // ║  nije proveravala ništa, a izgledala je kao da radi. To je gore od         ║
  // ║  nedostatka provere, jer se na nju računa.                                  ║
  // ║                                                                            ║
  // ║  ZAŠTO SU BILE PRAZNE: 4.0 za njih ima tri syncera (`syncers/item-group`,  ║
  // ║  `item-subgroup`, `item-origin`) koji čitaju kroz `MssqlClient`, dakle iz  ║
  // ║  QBigTehna — a on je mrtav od 22.07.2026. Bili su MRTVI ROĐENI:            ║
  // ║  registrovani u `SyncService`, naizgled živi, nesposobni da donesu red.     ║
  // ╚═══════════════════════════════════════════════════════════════════════════╝

  /** `R_Grupa` -> `item_groups`. Roditelj podgrupa, pa ide prvi. */
  private async importItemGroups(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(grupa))
          btrim(grupa)                                    AS code,
          left(coalesce(nullif(btrim(coalesce(opis, '')), ''), btrim(grupa)), 50) AS description
        FROM bb_mdb_stage_grupe
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(grupa, '')), '') IS NOT NULL
          -- Šifra se NE skraćuje: "left(...,10)" bi tiho spojio dve različite
          -- grupe u jednu i time prevezao artikle na pogrešnu. Izmereno: najduža
          -- je tačno 10, dakle na granici — zato se predugačka ODBACUJE i broji.
          AND length(btrim(grupa)) <= 10
        ORDER BY btrim(grupa)
      ),
      ins AS (
        INSERT INTO item_groups (code, description)
        SELECT code, description FROM src
        ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description
        WHERE (item_groups.description) IS DISTINCT FROM (EXCLUDED.description)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_grupe WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("item_groups", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} grupa odbačena — prazna, duplikat ili šifra duža od 10 znakova`,
      );
    return step;
  }

  /** `R_Podgrupa` -> `item_subgroups`. Posle grupa (`GrupaVeza` -> `item_groups.code`). */
  private async importItemSubgroups(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(podgrupa))
          btrim(podgrupa)                                 AS code,
          left(coalesce(nullif(btrim(coalesce(opis, '')), ''), btrim(podgrupa)), 50) AS description,
          -- Veza na grupu se NULIRA ako te grupe nema — podgrupa i dalje ulazi.
          -- Odbaciti je zbog pokvarene veze značilo bi izgubiti podatak koji
          -- postoji, a veza se popravi sledećim prolazom kad grupa stigne.
          nullif(btrim(coalesce(grupa_veza, '')), '')      AS parent_group
        FROM bb_mdb_stage_podgrupe
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(podgrupa, '')), '') IS NOT NULL
          AND length(btrim(podgrupa)) <= 10
        ORDER BY btrim(podgrupa)
      ),
      ins AS (
        INSERT INTO item_subgroups (code, description, parent_group)
        SELECT s.code, s.description,
               CASE WHEN g.code IS NULL THEN NULL ELSE s.parent_group END
        FROM src s
        LEFT JOIN item_groups g ON g.code = s.parent_group
        ON CONFLICT (code) DO UPDATE SET
          description  = EXCLUDED.description,
          parent_group = EXCLUDED.parent_group
        WHERE (item_subgroups.description, item_subgroups.parent_group)
              IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.parent_group)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_podgrupe WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("item_subgroups", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} podgrupa odbačena — prazna, duplikat ili šifra duža od 10 znakova`,
      );
    return step;
  }

  /** `R_Poreklo` -> `item_origins`. Posle podgrupa (`PodgrupaVeza`). */
  private async importItemOrigins(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(poreklo))
          btrim(poreklo)                                  AS code,
          left(coalesce(nullif(btrim(coalesce(opis, '')), ''), btrim(poreklo)), 50) AS description,
          nullif(btrim(coalesce(podgrupa_veza, '')), '')   AS subgroup_code,
          -- Procenat popusta: nečitljiva vrednost daje NULL, nikad grešku koja bi
          -- oborila ceo red. Zarez se prima kao decimalni znak (Access ume oboje).
          NULLIF(regexp_replace(replace(coalesce(popust_proc, ''), ',', '.'),
                                '[^0-9.\\-]', '', 'g'), '')::numeric AS discount_percent
        FROM bb_mdb_stage_poreklo
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(poreklo, '')), '') IS NOT NULL
          -- Kolona je VarChar(5) i izvor je tačno na granici (5/5).
          AND length(btrim(poreklo)) <= 5
        ORDER BY btrim(poreklo)
      ),
      ins AS (
        INSERT INTO item_origins (code, description, subgroup_code, discount_percent)
        SELECT s.code, s.description,
               CASE WHEN sg.code IS NULL THEN NULL ELSE s.subgroup_code END,
               COALESCE(s.discount_percent, 0)
        FROM src s
        LEFT JOIN item_subgroups sg ON sg.code = s.subgroup_code
        ON CONFLICT (code) DO UPDATE SET
          description      = EXCLUDED.description,
          subgroup_code    = EXCLUDED.subgroup_code,
          discount_percent = EXCLUDED.discount_percent
        WHERE (item_origins.description, item_origins.subgroup_code, item_origins.discount_percent)
              IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.subgroup_code, EXCLUDED.discount_percent)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_poreklo WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("item_origins", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} porekla odbačeno — prazno, duplikat ili šifra duža od 5 znakova`,
      );
    return step;
  }

  /**
   * `Magacini` -> `warehouses`.
   *
   * ⚠️ `IDMagacin` JE naš `warehouses.id` (kao i kod komitenata: BigBit šifra je
   * primarni ključ). Zato se NIKAD ne dira red iznad rezervisanog opsega ključeva
   * — magacin nastao u 4.0 nije BigBit-ov i sync ga ne sme prepisati.
   *
   * `PotpisSlika` se NE preslikava: staging je prima da brana zaglavlja prođe, ali
   * to je slika i nema šta da traži u `signature_image_path`, koji nosi PUTANJU.
   */
  private async importWarehouses(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(id_magacin)::int)
          btrim(id_magacin)::int                          AS id,
          left(coalesce(nullif(btrim(coalesce(magacin, '')), ''), 'Magacin ' || btrim(id_magacin)), 50) AS name,
          left(nullif(btrim(coalesce(ulica_i_broj, '')), ''), 50) AS street,
          left(nullif(btrim(coalesce(mesto, '')), ''), 30)        AS city,
          -- Access Boolean kroz mdb-export izlazi kao TEKST '0'/'1'; "Boolean('0')"
          -- u JS-u je "true", pa se poređenje radi u SQL-u, eksplicitno.
          (btrim(coalesce(prosecne_cene, '0')) IN ('1', 'True', 'true', '-1')) AS average_prices,
          left(nullif(btrim(coalesce(vrsta_mag, '')), ''), 5)     AS warehouse_type,
          left(nullif(btrim(coalesce(konto_mag, '')), ''), 10)    AS account,
          left(nullif(btrim(coalesce(ime_magacionera, '')), ''), 30) AS manager_name,
          left(nullif(btrim(coalesce(br_lk_magacionera, '')), ''), 20) AS manager_id_number,
          COALESCE(nullif(btrim(coalesce(id_firma, '')), '')::int, 0) AS company_id
        FROM bb_mdb_stage_magacini
        WHERE drop_id = ${dropId}
          AND btrim(coalesce(id_magacin, '')) ~ '^[0-9]+$'
        ORDER BY btrim(id_magacin)::int
      ),
      ins AS (
        INSERT INTO warehouses (id, company_id, name, street, city, average_prices,
                                warehouse_type, account, manager_name, manager_id_number)
        SELECT id, company_id, name, street, city, average_prices,
               warehouse_type, account, manager_name, manager_id_number
        FROM src
        -- ZAŠTITA 4.0-NATIVE REDA: rezervisan opseg ključeva se NE dira.
        WHERE id < ${NATIVE_ID_BASE}
        ON CONFLICT (id) DO UPDATE SET
          company_id        = EXCLUDED.company_id,
          name              = EXCLUDED.name,
          street            = EXCLUDED.street,
          city              = EXCLUDED.city,
          average_prices    = EXCLUDED.average_prices,
          warehouse_type    = EXCLUDED.warehouse_type,
          account           = EXCLUDED.account,
          manager_name      = EXCLUDED.manager_name,
          manager_id_number = EXCLUDED.manager_id_number
        WHERE (warehouses.name, warehouses.street, warehouses.city, warehouses.average_prices,
               warehouses.warehouse_type, warehouses.account, warehouses.manager_name,
               warehouses.manager_id_number)
              IS DISTINCT FROM
              (EXCLUDED.name, EXCLUDED.street, EXCLUDED.city, EXCLUDED.average_prices,
               EXCLUDED.warehouse_type, EXCLUDED.account, EXCLUDED.manager_name,
               EXCLUDED.manager_id_number)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_magacini WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src WHERE id >= ${NATIVE_ID_BASE}) AS fetched`;
    const step = this.toStep("warehouses", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} magacin(a) odbačeno — prazna ili nenumerička šifra`,
      );
    return step;
  }

  /**
   * `PSF_AnalitickaKonta_T` -> `saldakonto_accounts`.
   *
   * OPREZ: ovu tabelu je već ručno seed-ovala migracija
   * 20260726100000_seed_saldakonto_i_seme_kontiranja, i tamo su `side`,
   * `partner_scope` i `control_account` DONETE ODLUKE koje BigBit uopšte ne zna
   * (npr. primljeni avansi 4300/4302 su `payable` ali KUPČEVI). Zato uvoz na
   * postojećem redu dira SAMO tri zastavice koje BigBit stvarno nosi.
   */
  private async importSaldakontoAccounts(
    dropId: number,
  ): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [
      "na postojećim redovima menja samo DinSaldo/DevSaldo/OTST — side, partner_scope i control_account su 4.0 odluke i ne prepisuju se",
    ];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(s.konto))
          btrim(s.konto)                                AS account,
          CASE WHEN left(btrim(s.konto), 1) = '4' THEN 'payable' ELSE 'receivable' END AS side,
          left(btrim(s.konto), 3)                       AS control_account,
          (btrim(coalesce(s.otst, '0')) = '1')          AS tracks_open_items,
          (btrim(coalesce(s.din_saldo, '0')) = '1')     AS holds_din_balance,
          (btrim(coalesce(s.dev_saldo, '0')) = '1')     AS holds_fx_balance
        FROM bb_mdb_stage_psf_konta s
        JOIN accounts a ON a.code = btrim(s.konto)
        WHERE s.drop_id = ${dropId}
        ORDER BY btrim(s.konto)
      ),
      ins AS (
        INSERT INTO saldakonto_accounts (account, side, control_account,
                                         tracks_open_items, holds_din_balance,
                                         holds_fx_balance, imported_drop_id)
        SELECT account, side, control_account, tracks_open_items,
               holds_din_balance, holds_fx_balance, ${dropId}
        FROM src
        ON CONFLICT (account) DO UPDATE SET
          tracks_open_items = EXCLUDED.tracks_open_items,
          holds_din_balance = EXCLUDED.holds_din_balance,
          holds_fx_balance  = EXCLUDED.holds_fx_balance
        WHERE (saldakonto_accounts.tracks_open_items, saldakonto_accounts.holds_din_balance,
               saldakonto_accounts.holds_fx_balance)
          IS DISTINCT FROM
              (EXCLUDED.tracks_open_items, EXCLUDED.holds_din_balance,
               EXCLUDED.holds_fx_balance)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_psf_konta WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             (SELECT count(*) FROM bb_mdb_stage_psf_konta p
                WHERE p.drop_id = ${dropId}
                  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.code = btrim(p.konto)))::bigint AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("saldakonto_accounts", row, t0, notes, true);
    if (step.skipped > 0)
      step.notes.push(
        `${step.skipped} saldakonto konto(a) nema svoj red u kontnom planu — preskočeno (FK fk_saldakonto_account)`,
      );
    return step;
  }

  /**
   * `T_Nalozi` -> `journal_entries` (zaglavlja). Ključ idempotencije = `bb_nalog_id`.
   *
   * STATUS: sve uvezeno je već proknjiženo u BigBitu, pa ulazi kao `POSTED`;
   * `Zakljucano=1` -> `LOCKED`. Nikad `DRAFT` — uvezen nalog se u 4.0 ne edituje.
   *
   * NEBALANSIRANI NALOZI (13 od 1.126 u snimku 11.07., ukupna razlika 0,10 RSD —
   * sve zaokruženja): uvoz ide SIROVIM SQL-om, ne kroz servis knjiženja, pa se
   * `LedgerNotBalancedException` uopšte ne okida. To je namerno — cilj je VERNA
   * KOPIJA BigBita radi poređenja, a ne prekontiranje istorije.
   */
  private async importJournalEntries(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (id_naloga::int)
          id_naloga::int                                        AS bb_nalog_id,
          btrim(coalesce(broj_naloga, ''))                      AS number,
          btrim(coalesce(vrsta_naloga, ''))                     AS order_type_code,
          coalesce(nullif(btrim(coalesce(godina, '')), '')::int, 0) AS year,
          coalesce(nullif(btrim(coalesce(id_firma, '')), '')::int, 0) AS company_id,
          (nullif(btrim(coalesce(datum_naloga, '')), '')::timestamp AT TIME ZONE 'UTC')    AS document_date,
          (nullif(btrim(coalesce(datum_knjizenja, '')), '')::timestamp AT TIME ZONE 'UTC') AS posting_date,
          CASE WHEN btrim(coalesce(zakljucano, '0')) = '1' THEN 'LOCKED' ELSE 'POSTED' END AS status,
          left(nullif(btrim(coalesce(opis_naloga, '')), ''), 255) AS description,
          left(nullif(btrim(coalesce(potpis, '')), ''), 50)       AS signature
        FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId}
          AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
          AND nullif(btrim(coalesce(datum_naloga, '')), '') IS NOT NULL
          AND nullif(btrim(coalesce(datum_knjizenja, '')), '') IS NOT NULL
          -- identitetske kolone se NE skraćuju (vidi importAccounts)
          AND length(btrim(coalesce(broj_naloga, ''))) <= 10
          AND length(btrim(coalesce(vrsta_naloga, ''))) <= 5
        ORDER BY id_naloga::int
      ),
      -- SUDAR UNUTAR ISTOG UVOZA: dva različita IDNaloga koja se svedu na isti
      -- (firma, vrsta, godina, broj) bi oborila ceo INSERT na unique indeksu
      -- ('ON CONFLICT (bb_nalog_id)' ga ne hvata) i uvoz bi padao SVAKE noći.
      -- Zato višak izlazi u 'dupe' i broji se kao sudar, umesto da ruši posao.
      ranked AS (
        SELECT s.*, row_number() OVER (
                 PARTITION BY company_id, order_type_code, year, number
                 ORDER BY bb_nalog_id) AS rn
        FROM src s
      ),
      -- PARITET-BRANA: broj koji već drži 4.0-native (ili drugi BigBit) nalog.
      blocked AS (
        SELECT r.bb_nalog_id
        FROM ranked r
        JOIN journal_entries j
          ON j.company_id = r.company_id AND j.order_type_code = r.order_type_code
         AND j.year = r.year AND j.number = r.number
        WHERE j.bb_nalog_id IS DISTINCT FROM r.bb_nalog_id
        UNION
        SELECT bb_nalog_id FROM ranked WHERE rn > 1
      ),
      -- BRANA ZAKLJUČANIH (stavka D, nalaz V6): nalog koji je u 4.0 LOCKED nosi
      -- zaključan period — na njemu stoje predata PDV prijava i izračunat bilans.
      -- Uvoz ga NE prepisuje; razlika se zapisuje i čeka ljudsku odluku.
      --
      -- ⚠️ STATUS SE NAMERNO NE POREDI (ispravka posle drugog kruga pregleda 28.07.):
      -- 4.0 ima SOPSTVENO zaključavanje perioda (gl-write.lockOlderThan, dugme
      -- „Zaključaj starije") koje uvezene naloge prevodi POSTED→LOCKED, dok BigBit za
      -- iste naloge i dalje šalje Zakljucano=0. Dok je status bio deo poređenja, ta
      -- razlika je bila TRAJNA: svaki takav nalog se SVAKE noći brojao kao „odbijena
      -- izmena" (mereno: 3/3, tj. 100% naloga u zaključanom periodu) i TRAJNO ispadao
      -- iz upsert-a, a dnevnik se punio redovima koje niko ne može da reši. Stvarna
      -- izmena bi se u toj buci izgubila. Status se ovde i ne sme preuzeti: 4.0
      -- zaključavanje je jače i BigBit ga ne sme skinuti (vidi CASE u DO UPDATE).
      locked AS (
        SELECT r.bb_nalog_id, j.id AS target_id,
               to_jsonb(j) - 'created_at' - 'updated_at' AS old_value,
               to_jsonb(r) - 'rn'                        AS new_value
        FROM ranked r
        JOIN journal_entries j ON j.bb_nalog_id = r.bb_nalog_id
        WHERE upper(j.status) = 'LOCKED'
          AND (j.number, j.order_type_code, j.year, j.company_id, j.document_date,
               j.posting_date, j.description, j.signature)
            IS DISTINCT FROM
              (r.number, r.order_type_code, r.year, r.company_id, r.document_date,
               r.posting_date, r.description, r.signature)
      ),
      -- Dnevnik odbijenih izmena. NOT EXISTS drži TAČNO JEDAN nerešen red po
      -- nalogu — inače bi svaka noć dodavala novi duplikat istog problema.
      logged AS (
        INSERT INTO bb_import_rejected_changes
          (drop_id, entity, bb_nalog_id, target_id, reason, old_value, new_value)
        SELECT ${dropId}, 'journal_entries', l.bb_nalog_id, l.target_id,
               'LOCKED_ENTRY', l.old_value, l.new_value
        FROM locked l
        WHERE NOT EXISTS (
          SELECT 1 FROM bb_import_rejected_changes x
           WHERE x.resolved_at IS NULL
             AND x.reason = 'LOCKED_ENTRY'
             AND x.entity = 'journal_entries'
             AND x.bb_nalog_id = l.bb_nalog_id)
        RETURNING 1
      ),
      ins AS (
        INSERT INTO journal_entries (bb_nalog_id, number, order_type_code, year, company_id,
                                     document_date, posting_date, status, description,
                                     signature, imported_drop_id, created_at, updated_at)
        SELECT bb_nalog_id, number, order_type_code, year, company_id,
               document_date, posting_date, status, description,
               signature, ${dropId}, now(), now()
        FROM ranked
        WHERE bb_nalog_id NOT IN (SELECT bb_nalog_id FROM blocked)
          AND bb_nalog_id NOT IN (SELECT bb_nalog_id FROM locked)
        ON CONFLICT (bb_nalog_id) DO UPDATE SET
          number           = EXCLUDED.number,
          order_type_code  = EXCLUDED.order_type_code,
          year             = EXCLUDED.year,
          company_id       = EXCLUDED.company_id,
          document_date    = EXCLUDED.document_date,
          posting_date     = EXCLUDED.posting_date,
          -- STATUS SE OVDE NE MENJA. Dva razloga, oba mereno:
          --  1) BigBit ne sme da SKINE 4.0 zaključavanje (lockOlderThan) — inače bi
          --     noćni uvoz tiho otključavao periode za koje je predata PDV prijava;
          --  2) ni da ga POSTAVI u ovom koraku: korak stavki ide POSLE ovog i status
          --     bi zatekao kao LOCKED, pa bi odbio iznose IZ ISTOG FAJLA koji je taj
          --     nalog i zaključao (mereno: zaglavlje preuzeto, iznos ostao stari).
          -- Zaključavanje po BigBit-ovoj zastavici radi poseban korak NA KRAJU uvoza
          -- (applyBigbitLocks), kad su stavke već unutra.
          status           = journal_entries.status,
          description      = EXCLUDED.description,
          signature        = EXCLUDED.signature,
          updated_at       = now()
        WHERE (journal_entries.number, journal_entries.order_type_code, journal_entries.year,
               journal_entries.company_id, journal_entries.document_date,
               journal_entries.posting_date,
               journal_entries.description, journal_entries.signature)
          IS DISTINCT FROM
              (EXCLUDED.number, EXCLUDED.order_type_code, EXCLUDED.year,
               EXCLUDED.company_id, EXCLUDED.document_date,
               EXCLUDED.posting_date,
               EXCLUDED.description, EXCLUDED.signature)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_nalozi WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             (SELECT count(*) FROM blocked)                  AS skipped,
             (SELECT count(*) FROM locked)                   AS blocked_locked,
             (SELECT count(*) FROM logged)                   AS logged_now,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("journal_entries", row, t0, notes);
    if (step.blockedLocked > 0)
      step.notes.push(
        `${step.blockedLocked} nalog(a) je izmenjen u BigBitu, ali je u 4.0 ZAKLJUČAN — izmena NIJE ` +
          `preuzeta (na zaključanom periodu stoje predata PDV prijava i izračunat bilans). ` +
          `Novo zapisano za odluku: ${n(row?.logged_now)}. Pregled i odjava: tabela ` +
          "bb_import_rejected_changes (reason='LOCKED_ENTRY', resolved_at IS NULL).",
      );

    if (step.filtered > 0) {
      // Razlog se traži SAMO kad nešto stvarno otpadne (retko) — nije na vrelom putu.
      const [why] = await this.prisma.$queryRaw<
        { no_id: bigint; no_date: bigint; too_long: bigint; dupe_id: bigint }[]
      >`
        SELECT
          count(*) FILTER (WHERE btrim(coalesce(id_naloga, '')) !~ '^[0-9]+$') AS no_id,
          count(*) FILTER (WHERE nullif(btrim(coalesce(datum_naloga, '')), '') IS NULL
                              OR nullif(btrim(coalesce(datum_knjizenja, '')), '') IS NULL) AS no_date,
          count(*) FILTER (WHERE length(btrim(coalesce(broj_naloga, ''))) > 10
                              OR length(btrim(coalesce(vrsta_naloga, ''))) > 5) AS too_long,
          (count(*) FILTER (WHERE btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$')
             - count(DISTINCT id_naloga::int) FILTER (WHERE btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$')) AS dupe_id
        FROM bb_mdb_stage_nalozi WHERE drop_id = ${dropId}`;
      step.notes.push(
        `${step.filtered} nalog(a) ODBAČENO iz izvora — bez IDNaloga: ${n(why?.no_id)}, ` +
          `bez datuma naloga/knjiženja: ${n(why?.no_date)}, predugačak broj/vrsta: ${n(why?.too_long)}, ` +
          `duplikat IDNaloga: ${n(why?.dupe_id)}. Ti dokumenti NISU u 4.0 i njihove GK stavke otpadaju.`,
      );
    }

    if (step.skipped > 0) {
      const examples = await this.prisma.$queryRaw<
        { number: string; order_type_code: string; year: number }[]
      >`
        SELECT DISTINCT btrim(coalesce(s.broj_naloga, '')) AS number,
               btrim(coalesce(s.vrsta_naloga, '')) AS order_type_code,
               coalesce(nullif(btrim(coalesce(s.godina, '')), '')::int, 0) AS year
        FROM bb_mdb_stage_nalozi s
        JOIN journal_entries j
          ON j.company_id = coalesce(nullif(btrim(coalesce(s.id_firma, '')), '')::int, 0)
         AND j.order_type_code = btrim(coalesce(s.vrsta_naloga, ''))
         AND j.year = coalesce(nullif(btrim(coalesce(s.godina, '')), '')::int, 0)
         AND j.number = btrim(coalesce(s.broj_naloga, ''))
        WHERE s.drop_id = ${dropId}
          AND j.bb_nalog_id IS DISTINCT FROM nullif(btrim(coalesce(s.id_naloga, '')), '')::int
        LIMIT 10`;
      for (const e of examples)
        step.notes.push(
          `sudar: ${e.order_type_code}/${e.year}/${e.number} — broj već drži drugi nalog u 4.0`,
        );
    }
    return step;
  }

  /**
   * `T_Glavna knjiga` -> `ledger_entries`, U SERIJAMA (zahtev 3).
   *
   * Keyset po `StavkaID` (monoton u izvoru) — svaka serija je zaseban `INSERT`
   * i time zasebna transakcija. `OFFSET` se namerno NE koristi.
   */
  private async importLedgerEntries(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let blockedLocked = 0; // odbijene izmene nad zaključanim nalozima (stavka D)
    let loggedNow = 0; // koliko ih je PRVI put ušlo u dnevnik odluka
    let processed = 0; // redovi koji su uopšte ušli u obradu (numerički stavka_id)
    let lastKey = 0;
    let batches = 0;

    for (;;) {
      const [row] = await this.prisma.$queryRaw<LedgerPageRow[]>`
        WITH page AS (
          SELECT *
          FROM bb_mdb_stage_gk
          WHERE drop_id = ${dropId}
            AND btrim(coalesce(stavka_id, '')) ~ '^[0-9]+$'
            AND stavka_id::int > ${lastKey}
          ORDER BY stavka_id::int
          LIMIT ${GK_BATCH}
        ),
        src AS (
          SELECT
            p.stavka_id::int                                   AS bb_stavka_id,
            j.id                                               AS journal_entry_id,
            btrim(p.konto)                                     AS account_code,
            nullif(coalesce(nullif(btrim(coalesce(p.analiticka_sifra, '')), ''), '0')::int, 0) AS analytical_code,
            coalesce(nullif(btrim(coalesce(p.duguje, '')), ''), '0')::numeric(19,4)    AS debit,
            coalesce(nullif(btrim(coalesce(p.potrazuje, '')), ''), '0')::numeric(19,4) AS credit,
            -- DEVIZE: DevDuguje/DevPotrazuje u većini redova samo PRESLIKAVAJU
            -- dinarski iznos (DevValuta = RSD). Puniti FX iz njih bez filtera po
            -- valuti daje besmislen devizni saldo — zato NULL kad je RSD.
            CASE WHEN cur.code <> 'RSD'
                 THEN coalesce(nullif(btrim(coalesce(p.dev_duguje, '')), ''), '0')::numeric(19,4) END    AS fx_debit,
            CASE WHEN cur.code <> 'RSD'
                 THEN coalesce(nullif(btrim(coalesce(p.dev_potrazuje, '')), ''), '0')::numeric(19,4) END AS fx_credit,
            CASE WHEN cur.code <> 'RSD' THEN cur.code END      AS fx_currency,
            cur.code                                           AS currency,
            left(nullif(btrim(coalesce(p.opis_dokumenta, '')), ''), 255) AS description,
            -- Pozicija NIJE mesto troška ('0'/'drugi'/'fiskalni' = poreklo
            -- ulaznog dokumenta za PDV/KEPU), pa ide u document_origin;
            -- cost_center ostaje NULL na uvezenim redovima.
            left(nullif(btrim(coalesce(p.pozicija, '')), ''), 20)  AS document_origin,
            left(nullif(btrim(coalesce(p.broj_dokumenta, '')), ''), 30) AS document_number,
            (nullif(btrim(coalesce(p.valuta_dokumenta, '')), '')::timestamp AT TIME ZONE 'UTC') AS due_date,
            nullif(coalesce(nullif(btrim(coalesce(p.id_dok_iz_robnog, '')), ''), '0')::int, 0)  AS source_goods_doc_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_dok_iz_usluga, '')), ''), '0')::int, 0)  AS source_service_doc_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_predmet, '')), ''), '0')::int, 0)        AS source_project_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_radni_nalog, '')), ''), '0')::int, 0)    AS source_work_order_id
          FROM page p
          -- NORMALIZACIJA VALUTE: izvor ima 9 varijanti (RSD/DIN/Din/rsd/eur/EUR/usd/USD/CNY).
          CROSS JOIN LATERAL (
            SELECT CASE
                     WHEN upper(btrim(coalesce(p.dev_valuta, ''))) IN ('', 'DIN', 'RSD') THEN 'RSD'
                     WHEN length(upper(btrim(p.dev_valuta))) = 3 THEN upper(btrim(p.dev_valuta))
                     ELSE 'RSD'
                   END AS code
          ) cur
          -- Tvrdi FK-ovi: bez naloga ili bez konta red NE MOŽE da uđe.
          JOIN journal_entries j ON j.bb_nalog_id = nullif(btrim(coalesce(p.id_naloga, '')), '')::int
          JOIN accounts a        ON a.code = btrim(p.konto)
        ),
        -- BRANA ZAKLJUČANIH (stavka D, nalaz V6): stavka čiji je nalog u 4.0
        -- LOCKED se ne dira — ni izmena postojeće, ni unos nove. Blokira se SAMO
        -- ako bi stvarno nešto promenila; identičan red prolazi kao i do sada,
        -- inače bi svaka noć prijavljivala hiljade „odbijenih" nepromenjenih redova.
        --
        -- PRVI UVOZ SAMOG NALOGA JE IZUZETAK, i to nije sitnica: BigBit svoje
        -- zaključane naloge donosi kao Zakljucano=1 → 4.0 ih upisuje kao LOCKED.
        -- Bez izuzetka bi zaključan nalog dobio zaglavlje BEZ IJEDNE STAVKE (u
        -- snimku 11.07. to je 10 naloga / 46 stavki), glavna knjiga ne bi zatvarala,
        -- a dnevnik odbijenih bi se napunio „izmenama" koje niko nije napravio.
        -- Zato: nalog koji je u knjigu ušao BAŠ OVIM drop-om (imported_drop_id =
        -- dropId; upsert zaglavlja tu kolonu NE prepisuje) sme da dobije svoje stavke.
        --
        -- DRUGI IZUZETAK — POPRAVKA PREKINUTOG UVOZA (nalaz drugog kruga pregleda):
        -- uvoz stavki je STRANIČEN (svaka stranica zaseban commit), pa pad usred
        -- koraka ostavlja zaključan nalog sa DELOM stavki. Sledeći fajl je drugi
        -- drop, izuzetak iznad više ne važi, i te stavke ne bi ušle NIKAD — nalog
        -- trajno ne zatvara, a uvoz vraća DONE. Zato: NEDOSTAJUĆA stavka (le.id IS
        -- NULL) sme da uđe na nalog koji trenutno NE ZBRAJA U NULU (ili nema nijednu
        -- stavku) — takav nalog je pokvaren i BigBit je izvor istine. Nalog koji
        -- zatvara ostaje netaknut, pa dopisivanje nove stavke na ispravan zaključan
        -- nalog i dalje pada u dnevnik.
        locked AS (
          SELECT s.bb_stavka_id, j.bb_nalog_id, le.id AS target_id,
                 to_jsonb(le) - 'created_at' AS old_value,
                 to_jsonb(s)                 AS new_value
          FROM src s
          JOIN journal_entries j ON j.id = s.journal_entry_id AND upper(j.status) = 'LOCKED'
          LEFT JOIN ledger_entries le ON le.bb_stavka_id = s.bb_stavka_id
          WHERE (le.id IS NULL
                 AND j.imported_drop_id IS DISTINCT FROM ${dropId}
                 AND NOT EXISTS (
                   SELECT 1
                   FROM ledger_entries x
                   WHERE x.journal_entry_id = j.id
                   HAVING coalesce(sum(x.debit), 0) <> coalesce(sum(x.credit), 0)
                          OR count(*) = 0))
             OR (le.id IS NOT NULL
             AND (le.journal_entry_id, le.account_code, le.analytical_code, le.debit, le.credit,
                 le.fx_debit, le.fx_credit, le.fx_currency, le.currency, le.description,
                 le.document_origin, le.document_number, le.due_date, le.source_goods_doc_id,
                 le.source_service_doc_id, le.source_project_id, le.source_work_order_id)
               IS DISTINCT FROM
                (s.journal_entry_id, s.account_code, s.analytical_code, s.debit, s.credit,
                 s.fx_debit, s.fx_credit, s.fx_currency, s.currency, s.description,
                 s.document_origin, s.document_number, s.due_date, s.source_goods_doc_id,
                 s.source_service_doc_id, s.source_project_id, s.source_work_order_id))
        ),
        logged AS (
          INSERT INTO bb_import_rejected_changes
            (drop_id, entity, bb_nalog_id, bb_stavka_id, target_id, reason, old_value, new_value)
          SELECT ${dropId}, 'ledger_entries', l.bb_nalog_id, l.bb_stavka_id, l.target_id,
                 'LOCKED_ENTRY', l.old_value, l.new_value
          FROM locked l
          WHERE NOT EXISTS (
            SELECT 1 FROM bb_import_rejected_changes x
             WHERE x.resolved_at IS NULL
               AND x.reason = 'LOCKED_ENTRY'
               AND x.entity = 'ledger_entries'
               AND x.bb_stavka_id = l.bb_stavka_id)
          RETURNING 1
        ),
        ins AS (
          INSERT INTO ledger_entries (bb_stavka_id, journal_entry_id, account_code, analytical_code,
                                      debit, credit, fx_debit, fx_credit, fx_currency, currency,
                                      description, document_origin, document_number, due_date,
                                      source_goods_doc_id, source_service_doc_id,
                                      source_project_id, source_work_order_id,
                                      imported_drop_id, created_at)
          SELECT bb_stavka_id, journal_entry_id, account_code, analytical_code,
                 debit, credit, fx_debit, fx_credit, fx_currency, currency,
                 description, document_origin, document_number, due_date,
                 source_goods_doc_id, source_service_doc_id,
                 source_project_id, source_work_order_id,
                 ${dropId}, now()
          FROM src
          WHERE bb_stavka_id NOT IN (SELECT bb_stavka_id FROM locked)
          ON CONFLICT (bb_stavka_id) DO UPDATE SET
            journal_entry_id      = EXCLUDED.journal_entry_id,
            account_code          = EXCLUDED.account_code,
            analytical_code       = EXCLUDED.analytical_code,
            debit                 = EXCLUDED.debit,
            credit                = EXCLUDED.credit,
            fx_debit              = EXCLUDED.fx_debit,
            fx_credit             = EXCLUDED.fx_credit,
            fx_currency           = EXCLUDED.fx_currency,
            currency              = EXCLUDED.currency,
            description           = EXCLUDED.description,
            document_origin       = EXCLUDED.document_origin,
            document_number       = EXCLUDED.document_number,
            due_date              = EXCLUDED.due_date,
            source_goods_doc_id   = EXCLUDED.source_goods_doc_id,
            source_service_doc_id = EXCLUDED.source_service_doc_id,
            source_project_id     = EXCLUDED.source_project_id,
            source_work_order_id  = EXCLUDED.source_work_order_id
          -- BEZ 'imported_drop_id' u poređenju: inače bi svaka noć „razlikovala"
          -- svih 20k+ redova i prepisala celu glavnu knjigu sa 6 indeksa.
          WHERE (ledger_entries.journal_entry_id, ledger_entries.account_code,
                 ledger_entries.analytical_code, ledger_entries.debit, ledger_entries.credit,
                 ledger_entries.fx_debit, ledger_entries.fx_credit, ledger_entries.fx_currency,
                 ledger_entries.currency, ledger_entries.description,
                 ledger_entries.document_origin, ledger_entries.document_number,
                 ledger_entries.due_date, ledger_entries.source_goods_doc_id,
                 ledger_entries.source_service_doc_id, ledger_entries.source_project_id,
                 ledger_entries.source_work_order_id)
            IS DISTINCT FROM
                (EXCLUDED.journal_entry_id, EXCLUDED.account_code,
                 EXCLUDED.analytical_code, EXCLUDED.debit, EXCLUDED.credit,
                 EXCLUDED.fx_debit, EXCLUDED.fx_credit, EXCLUDED.fx_currency,
                 EXCLUDED.currency, EXCLUDED.description,
                 EXCLUDED.document_origin, EXCLUDED.document_number,
                 EXCLUDED.due_date, EXCLUDED.source_goods_doc_id,
                 EXCLUDED.source_service_doc_id, EXCLUDED.source_project_id,
                 EXCLUDED.source_work_order_id)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM page)                     AS page_rows,
               (SELECT count(*) FROM src)                      AS eligible,
               (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
               (SELECT count(*) FROM locked)                   AS blocked_locked,
               (SELECT count(*) FROM logged)                   AS logged_now,
               (SELECT coalesce(max(stavka_id::int), 0) FROM page) AS max_key`;

      const pageRows = n(row?.page_rows);
      const pageMax = n(row?.max_key);
      if (pageRows === 0 || pageMax <= lastKey) break;

      inserted += n(row?.inserted);
      updated += n(row?.updated);
      blockedLocked += n(row?.blocked_locked);
      loggedNow += n(row?.logged_now);
      skipped += pageRows - n(row?.eligible);
      processed += pageRows;
      lastKey = pageMax;
      batches++;
      if (batches > 10_000) {
        notes.push("prekinuto na 10.000 serija — proveri izvor");
        break;
      }
    }

    const staged = await this.prisma.bbMdbStageGk.count({ where: { dropId } });
    const step: MdbStepResult = {
      entity: "ledger_entries",
      staged,
      inserted,
      updated,
      // `unchanged` se računa nad OBRAĐENIM redovima, ne nad celim staging-om —
      // inače bi redovi koje filter nikad nije ni video ispali „nepromenjeni".
      unchanged: Math.max(
        0,
        processed - inserted - updated - skipped - blockedLocked,
      ),
      skipped,
      filtered: Math.max(0, staged - processed),
      blockedLocked,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GK_BATCH} redova`);
    if (blockedLocked > 0)
      step.notes.push(
        `${blockedLocked} stavki glavne knjige pripada nalogu koji je u 4.0 ZAKLJUČAN — izmena iz ` +
          `BigBita NIJE preuzeta (zaključan period nosi predatu PDV prijavu i izračunat bilans). ` +
          `Novo zapisano za odluku: ${loggedNow}. Pregled i odjava: tabela ` +
          "bb_import_rejected_changes (reason='LOCKED_ENTRY', resolved_at IS NULL).",
      );
    if (skipped > 0)
      step.notes.push(
        `${skipped} stavki preskočeno — nema nalog (bb_nalog_id) ili konto u kontnom planu`,
      );
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} stavki ODBAČENO — StavkaID nije broj; te stavke NISU u 4.0`,
      );
    return step;
  }

  /**
   * ZAKLJUČAVANJE PO BIGBIT-OVOJ ZASTAVICI — POSLEDNJI korak uvoza.
   *
   * Zašto zaseban korak, a ne kolona u upsert-u zaglavlja (ispravka posle drugog
   * kruga nezavisnog pregleda, 28.07.2026): koraci uvoza idu redom
   * `journal_entries` → `ledger_entries`, svaki u svojoj transakciji. Dok se
   * `Zakljucano=1` primenjivao u prvom koraku, drugi korak je isti nalog zaticao kao
   * `LOCKED` i brana zaključanih je odbijala IZNOSE IZ ISTOG FAJLA koji je taj nalog
   * i zaključao. Ishod je bio najgori mogući: NOVO zaglavlje + STARI iznosi, uz zapis
   * u dnevniku o „odbijenoj izmeni" za sasvim običnu knjigovodstvenu radnju (ispravi
   * pa zaključi mesec). Mereno: BigBit šalje 777, u 4.0 ostaje 700.
   *
   * SMER JE JEDNOSMERAN: samo POSTED → LOCKED. Otključavanje se NE preuzima —
   * 4.0 ima sopstveno zaključavanje perioda (`lockOlderThan`) koje nosi predatu PDV
   * prijavu i izračunat bilans, i BigBit ga ne sme skinuti.
   */
  private async applyBigbitLocks(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (id_naloga::int) id_naloga::int AS bb_nalog_id
        FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId}
          AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
          AND btrim(coalesce(zakljucano, '0')) = '1'
        ORDER BY id_naloga::int
      ),
      upd AS (
        UPDATE journal_entries j
           SET status = 'LOCKED', updated_at = now()
          FROM src s
         WHERE j.bb_nalog_id = s.bb_nalog_id
           AND upper(j.status) = 'POSTED'
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM src) AS staged,
             0                          AS inserted,
             (SELECT count(*) FROM upd) AS updated,
             0                          AS skipped,
             (SELECT count(*) FROM src) AS fetched`;
    const step = this.toStep("journal_entries_lock", row, t0, []);
    if (step.updated > 0)
      step.notes.push(
        `${step.updated} nalog(a) zaključano po BigBit-ovoj zastavici (Zakljucano=1), ` +
          "posle unosa stavki. Otključavanje se NE preuzima iz BigBita.",
      );
    return step;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PREDMETI (`Predmeti` -> `projects`)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `bb_mdb_stage_predmeti` -> `projects`. ISKLJUČIVO UPSERT po `id` (=`IDPredmet`).
   *
   * ZAŠTO OVAJ KORAK NIJE JEDAN SQL KAO OSTALI: ostali koraci pišu u tabele u
   * kojima je BigBit jedini pisac, pa je `INSERT ... ON CONFLICT` dovoljan. Ovde
   * su DVA pisca nad istom tabelom — BigBit i 4.0 — i svaki izvorni red mora da
   * prođe kroz tri odluke o vlasništvu PRE upisa (vidi brane niže). Te odluke se
   * donose istim mehanizmom koji već vozi MSSQL grana (`GenericSyncer`, aditivna
   * putanja), pa se ovde PONAVLJA ta logika, a ne izmišlja druga.
   *
   * MAPIRANJE SE OVDE NE PIŠE: kolone, ciljna polja i tipovi dolaze iz
   * `SYNC_MAP` (`targetDb: "projects"`) — iz iste mape koja je vozila MSSQL sync,
   * jer je MSSQL tabela bila preslikana kopija ove iste Access tabele. Menja se
   * SAMO izvor redova (`bb_mdb_stage_predmeti` umesto `dbo.Predmeti`).
   *
   * NIŠTA SE NE BRIŠE. `projects` nema rezervisan opseg ključeva (4.0-native
   * predmet dobija `id` iz iste PG sekvence kao BigBit), pa je svako brisanje po
   * izvornom skupu — obrazac koji `GenericSyncer` koristi — ovde nepotrebno
   * opasno. Red koji nestane iz drop-a ostaje u 4.0; nestajanje MERI zaseban
   * korak, ne ovaj.
   *
   * TRI BRANE VLASNIŠTVA, u ovom redosledu (sve tri PRESKAČU red i IMENUJU ga):
   *
   *  1. `id` ZAUZET 4.0-NATIVE PREDMETOM. Predmet koji u 4.0 već sedi na
   *     `IDPredmet`-u, a čiji broj se NE POJAVLJUJE nigde u ovom drop-u, nije
   *     BigBit red — BigBit taj broj ne poznaje. Slep upsert bi mu prepisao svih
   *     38 kolona tuđim predmetom. (Isto prepoznavanje kao `squatterIds` u
   *     `GenericSyncer`.) Svesna posledica, prepisana odande: ako BigBit
   *     PREIMENUJE broj postojećeg predmeta, ovde se to vidi kao kolizija i
   *     PRIJAVI, umesto da tiho prepiše red koji je možda 4.0-native.
   *
   *  2. PARITET BROJA PREDMETA — glavna brana ovog koraka. U prelaznom režimu
   *     predmet se otvara RUČNO U OBA sistema: 4.0 dodeli broj, pa se ISTI broj
   *     prekuca u BigBit. BigBit kopija zato stiže sa SVOJIM `IDPredmet`-om ali
   *     ISTIM `BrojPredmeta`. Kako radni nalozi, aktivacije i lokacije pokazuju na
   *     4.0-native `id`, slep insert bi napravio DVA predmeta sa istim brojem —
   *     jedan „pravi" i jedan prazan blizanac. Takav red se PRESKAČE, a u `notes`
   *     ide broj predmeta i OBA id-ja, da se sudar može rešiti u BigBitu.
   *     Ključ brane nije zakucan ovde nego se čita iz
   *     `ADDITIVE_DEDUP_FIELDS.projects` — jedno mesto za obe grane sync-a.
   *
   *  3. DUPLIKAT BROJA U SAMOM IZVORU. Dva različita `IDPredmet`-a sa istim
   *     `BrojPredmeta` — na produkciji stoji parcijalni `uq_projects_project_number`
   *     (migracija 20260725200000, `WHERE btrim(project_number) <> ''`), pa bi
   *     drugi red pao na 23505. Zadržava se PRVI, ostali se preskaču i imenuju.
   *
   * `IDKomitent` KOJI NE POSTOJI SE NULIRA, PREDMET SE NE ODBIJA (zahtev 5):
   * predmet bez kupca je i dalje predmet, a predmet koga nema je izgubljen podatak.
   * ⚠️ `projects.customer_id` je u bazi `integer NOT NULL` BEZ default-a (provereno
   * na dev bazi 30.07.2026), pa „nuliranje" fizički ne može da bude SQL `NULL` —
   * upisuje se `0`, zatečena sentinela „nema veze" u ovoj istoj tabeli
   * (`salesperson_id`, `work_type_id`, `foreign_supplier_id` svi imaju `DEFAULT 0`).
   * Broj takvih predmeta ide u `notes`.
   */
  private async importProjects(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const mapping = this.projectsMapping();
    /** Polje po kome se pravi paritet — iz registra, ne zakucano ovde. */
    const dedupField = additiveDedupFieldFor("projects") ?? "projectNumber";

    const staged = await this.prisma.bbMdbStagePredmet.count({
      where: { dropId },
    });

    // „Izvor ga poznaje" se mora znati za CEO drop, ne za stranicu: predmet koji
    // drži sporni broj može biti BigBit red iz sasvim druge stranice. Zato se
    // ključevi i brojevi celog drop-a čitaju unaprijed (7.617 redova = par stotina
    // kilobajta), pa su obe brane vlasništva odluke nad PUNIM skupom.
    const { ids: sourceIds, numbers: sourceNumbers } =
      await this.stagedProjectKeys(dropId);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let filtered = 0;
    let nulledCustomers = 0;
    let missingNumbers = 0;
    let unparsedDates = 0;
    /** Broj predmeta -> `IDPredmet` koji ga je u OVOM prolazu već zauzeo. */
    const acceptedNumbers = new Map<string, number>();
    const seenSourceIds = new Set<number>();
    const named: string[] = [];
    let extraNamed = 0;
    const name = (msg: string): void => {
      if (named.length < MAX_NAMED_SKIPS) named.push(msg);
      else extraNamed++;
    };

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.bbMdbStagePredmet.findMany({
        where: { dropId, id: { gt: lastKey } },
        orderBy: { id: "asc" },
        take: PROJECTS_BATCH,
      });
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      // Bez ovoga bi zaustavljena sekvenca (ili mock koji vraća istu stranicu)
      // vrtela beskonačnu petlju umesto da posao padne.
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto (proveri bb_mdb_stage_predmeti)`,
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      // ── 1) TIPIZACIJA: staging je sav tekst, mapa kaže u što ─────────────
      const candidates: {
        sourceId: number;
        number: string;
        data: Record<string, unknown>;
      }[] = [];
      for (const raw of page) {
        const row = raw as unknown as Record<string, unknown>;
        const sourceId = stageInt(row[PREDMET_SRC_TO_STAGE_FIELD.IDPredmet]);
        // Bez upotrebljivog `IDPredmet`-a nema ni ključa idempotencije — red se
        // ODBACUJE (`filtered`), kao nenumerički `IDNaloga` u koraku naloga.
        if (sourceId === null || sourceId <= 0) {
          filtered++;
          name(
            `odbačeno: IDPredmet="${String(row[PREDMET_SRC_TO_STAGE_FIELD.IDPredmet] ?? "")}" nije upotrebljiv broj`,
          );
          continue;
        }
        if (seenSourceIds.has(sourceId)) {
          filtered++;
          name(`odbačeno: IDPredmet=${sourceId} se u drop-u ponavlja`);
          continue;
        }
        seenSourceIds.add(sourceId);

        const mapped = this.mapStagedProject(row, mapping.columns);
        unparsedDates += mapped.unparsedDates;
        candidates.push({
          sourceId,
          number: String(mapped.data[dedupField] ?? "").trim(),
          data: mapped.data,
        });
      }
      if (candidates.length === 0) continue;

      // ── 2) TRI POGLEDA U BAZU, po jedan upit ────────────────────────────
      const ids = candidates.map((c) => c.sourceId);
      const numbers = [
        ...new Set(candidates.map((c) => c.number).filter((v) => v !== "")),
      ];
      const customerIds = [
        ...new Set(
          candidates
            .map((c) => Number(c.data.customerId ?? 0))
            .filter((v) => v > 0),
        ),
      ];
      const [existingById, holdersByNumber, knownCustomers] = await Promise.all([
        this.prisma.project.findMany({ where: { id: { in: ids } } }),
        numbers.length
          ? this.prisma.project.findMany({
              where: { [dedupField]: { in: numbers } },
              select: { id: true, [dedupField]: true },
            })
          : Promise.resolve([] as { id: number }[]),
        customerIds.length
          ? this.prisma.customer.findMany({
              where: { id: { in: customerIds } },
              select: { id: true },
            })
          : Promise.resolve([] as { id: number }[]),
      ]);
      const existing = new Map(
        (existingById as { id: number }[]).map((r) => [r.id, r]),
      );
      /** Broj predmeta -> id-jevi predmeta koji ga TRENUTNO drže u 4.0. */
      const holders = new Map<string, number[]>();
      for (const h of holdersByNumber as Record<string, unknown>[]) {
        const key = String(h[dedupField] ?? "").trim();
        const list = holders.get(key);
        if (list) list.push(Number(h.id));
        else holders.set(key, [Number(h.id)]);
      }
      const customersPresent = new Set(
        (knownCustomers as { id: number }[]).map((r) => r.id),
      );

      for (const c of candidates) {
        const current = existing.get(c.sourceId) as
          | Record<string, unknown>
          | undefined;

        // ── BRANA 1: `id` zauzet 4.0-native predmetom ────────────────────
        // Rezervisan opseg ključeva se pita kroz `isNativeRow` — jedino mesto
        // gde se poreklo po id-u presuđuje. Danas `projects` nije u
        // `NATIVE_ID_RANGE_TABLES` pa vraća `false`; ako tabela ikad dobije
        // rezervisan opseg, brana se aktivira sama, bez izmene ovde.
        if (isNativeRow("projects", c.sourceId)) {
          skipped++;
          name(
            `preskočeno: IDPredmet=${c.sourceId} je u rezervisanom 4.0 opsegu ključeva — BigBit tu šifru ne sme da koristi`,
          );
          continue;
        }
        if (current) {
          const currentNumber = String(current[dedupField] ?? "").trim();
          if (currentNumber !== "" && !sourceNumbers.has(currentNumber)) {
            skipped++;
            name(
              `preskočeno: id=${c.sourceId} u 4.0 drži predmet ${dedupField}="${currentNumber}" koji BigBit ne poznaje — ` +
                `4.0-native red NIJE prepisan (BigBit je poslao ${dedupField}="${c.number}")`,
            );
            continue;
          }
        }

        // ── BRANA 2: PARITET BROJA PREDMETA ─────────────────────────────
        // Broj koji već stoji na predmetu sa DRUGIM id-em, a taj id izvor NE
        // vraća → to je 4.0-native predmet (ili siroče iz starijeg režima), na
        // koji su vezani radni nalozi i aktivacije. BigBit kopija ne ulazi.
        if (c.number !== "") {
          const foreign = (holders.get(c.number) ?? []).filter(
            (id) => id !== c.sourceId && !sourceIds.has(id),
          );
          if (foreign.length > 0) {
            skipped++;
            name(
              `paritet: broj predmeta "${c.number}" već stoji na 4.0-native predmetu id=${foreign.join("/")} — ` +
                `BigBit kopija (IDPredmet=${c.sourceId}) PRESKOČENA; reši sudar u BigBitu`,
            );
            continue;
          }
          // ── BRANA 3: duplikat broja u samom izvoru ────────────────────
          const firstOwner = acceptedNumbers.get(c.number);
          if (firstOwner !== undefined && firstOwner !== c.sourceId) {
            skipped++;
            name(
              `duplikat u izvoru: broj predmeta "${c.number}" je u ovom drop-u već donet sa IDPredmet=${firstOwner} — ` +
                `IDPredmet=${c.sourceId} PRESKOČEN (očisti duplikat u BigBitu)`,
            );
            continue;
          }
        } else {
          missingNumbers++;
        }

        // ── FK KOMITENTA: nuliraj, ne odbijaj ───────────────────────────
        const customerId = Number(c.data.customerId ?? 0);
        if (customerId > 0 && !customersPresent.has(customerId)) {
          c.data.customerId = 0;
          nulledCustomers++;
          name(
            `komitent: IDPredmet=${c.sourceId} (broj "${c.number}") pokazuje na komitenta ${customerId} koga u 4.0 nema — veza NULIRANA (0), predmet uvezen`,
          );
        }

        // ── UPSERT, i to samo kad se sadržaj STVARNO razlikuje ───────────
        // Isto načelo kao u ostalim koracima: „ažurirano" mora da znači da se
        // nešto promenilo u BigBitu. Bez ovog poređenja bi svaka noć prijavila
        // 7.617 „izmenjenih" predmeta i stvarna ispravka bi se izgubila u šumu.
        if (current && this.sameProjectRow(current, c.data, mapping.columns, "projects")) {
          unchanged++;
          if (c.number !== "") acceptedNumbers.set(c.number, c.sourceId);
          continue;
        }
        const update = { ...c.data };
        delete update.id;
        try {
          await this.prisma.project.upsert({
            where: { id: c.sourceId },
            create: c.data as never,
            update: update as never,
          });
          if (current) updated++;
          else inserted++;
          if (c.number !== "") acceptedNumbers.set(c.number, c.sourceId);
        } catch (err) {
          skipped++;
          const message = err instanceof Error ? err.message : String(err);
          name(
            `preskočeno: IDPredmet=${c.sourceId} (broj "${c.number}") — ${message}`,
          );
          this.logger.warn(
            `Predmet IDPredmet=${c.sourceId} nije uvezen: ${message}`,
          );
        }
      }
    }

    // SEKVENCA MORA DA PREĐE UVEZENE KLJUČEVE (isti nalaz kao review 26.07 [0] za
    // aditivnu granu MSSQL sync-a): `projects` NEMA rezervisan opseg, pa 4.0-native
    // predmet uzima `id` iz iste sekvence. Upsert sa eksplicitnim `id`-em sekvencu ne
    // pomera, pa bi prvi sledeći „Novi predmet" u 4.0 dobio broj koji BigBit već
    // koristi → 23505 na `pk_projects`, i to na ekranu korisnika.
    if (inserted > 0) await this.bumpProjectsSequence();

    if (nulledCustomers > 0)
      notes.push(
        `${nulledCustomers} predmet(a) pokazuje na komitenta koga u 4.0 nema — veza je NULIRANA (customer_id=0, ` +
          "kolona je NOT NULL bez default-a pa SQL NULL nije moguć), predmeti su uvezeni. " +
          "Najčešći uzrok: uvoz komitenata je pao ili je komitent obrisan u BigBitu.",
      );
    if (missingNumbers > 0)
      notes.push(
        `${missingNumbers} predmet(a) je došao BEZ broja predmeta — uvezen je sa praznim brojem (ništa se ne odbacuje), ` +
          "ali paritet-brana za njega ne može da radi. Proveri te redove u BigBitu.",
      );
    if (unparsedDates > 0)
      notes.push(
        `${unparsedDates} datumsko polje nije bilo u obliku YYYY-MM-DD i upisano je kao prazno — ` +
          "proveri `mdb-export -T/-D` u koraku 1 (bigbit-mdb-export.sh).",
      );
    if (named.length > 0) notes.push(...named);
    if (extraNamed > 0)
      notes.push(
        `…i još ${extraNamed} sličnih redova (imenovano je prvih ${MAX_NAMED_SKIPS}; puna slika je u bb_mdb_drops.import_row_counts)`,
      );
    notes.push(`${batches} serija po ${PROJECTS_BATCH} redova`);

    const step: MdbStepResult = {
      entity: "projects",
      staged,
      inserted,
      updated,
      unchanged,
      skipped,
      filtered,
      // Predmeti nemaju pojam zaključanog perioda — brana zaključanih naloga se
      // na njih ne primenjuje (nema PDV prijave koja stoji na predmetu).
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    // SAMOKONTROLA BROJAČA: ugovor `MdbStepResult` je da se svih šest bucket-a
    // zbraja u `staged`. Ako se ikad raziđu, red je negde nestao iz svih brojača
    // — tačno onaj tihi kvar zbog koga su brojači i uvedeni.
    const counted =
      inserted + updated + unchanged + skipped + filtered + step.blockedLocked;
    if (counted !== staged)
      notes.push(
        `⚠️ brojači se ne zbrajaju: staged=${staged}, sabrano=${counted} — ` +
          `${Math.abs(staged - counted)} red(ova) nije ni u jednom brojaču (prijavi kao kvar uvoza)`,
      );
    return step;
  }

  /**
   * Mapiranje `Predmeti` -> `projects` iz `SYNC_MAP`, sa proverama koje moraju da
   * padnu GLASNO. Mapa je generisana iz šeme i može da se promeni bez ovog fajla:
   * nova kolona bez reda u `PREDMET_SRC_TO_STAGE_FIELD` bi se tiho upisala kao
   * prazna, a promenjen PK bi obesmislio ključ idempotencije.
   */
  /**
   * `R_Artikli` -> `items` (31.07.2026) — poslednji veliki šifarnik bez živog
   * kanala: MSSQL put (full refresh sa `deleteMany`, obrazac koji je pregled
   * zabranio) mrtav je od 22.07, pa artikli na produ stoje od tada.
   *
   * ⚠️ KLJUČ NIJE `items.id` NEGO `items.external_item_id`. Ovo je jedina tabela
   * u lancu gde se to razlikuje, i razlika je merena na produkciji 31.07.2026:
   *
   *   • `id = external_item_id` za **0 od 92.511** redova — dakle ni za jedan;
   *   • prod `id=2` nosi `external_item_id=17048` („Razvodni blok, 4-položajni,
   *     CD01"), a BigBit artikal 17048 je BAŠ taj — šifara 2..6 u BigBitu nema.
   *
   * Razlog: prenos BigBit→QBigTehn je artiklima dodeljivao SVOJU šifru, a
   * BigBit-ovu čuvao u koloni `BBSifra artikla` (odatle i `externalItemId` u
   * mapiranju). Komitenti i predmeti taj remap NEMAJU — kod njih je `Sifra`
   * odnosno `IDPredmet` ujedno i naš ključ.
   *
   * Da je ovaj korak radio po `id`-u, BigBit artikal 17048 bi bio upisan preko
   * NEPOVEZANOG artikla `id=17048`. Mereno pogrešnim ključem: 33.008 „novih" i
   * 34.368 „nestalih"; ispravnim: **91.092 poklapanja, 59 zaista novih, 2 koja
   * BigBit više ne šalje**. Razlika između ispravke i razorene baze.
   *
   * NAČELA (ista kao komitenti/predmeti):
   *  1. UPSERT, NIKAD BRISANJE — artikal ugašen u BigBitu ostaje ovde (deca u
   *     cenovnicima i sastavnicama); nestajanje se MERI, ne izvršava.
   *  2. `items.id` SE NIKAD NE MENJA I NIKAD NE DOLAZI IZ IZVORA — na njega
   *     pokazuju stavke dokumenata, cenovnici i sastavnice. Postojeći red se
   *     ažurira po svom `id`-u; nov artikal dobija sledeći slobodan broj ISPOD
   *     native opsega (isti obrazac kao `nextNativeItemId`, samo drugi opseg —
   *     sekvenca `items_id_seq` stoji na 1 jer je nikad niko nije koristio).
   *  3. NATIVE ARTIKAL SE NE PREPISUJE — ako BigBit šifru drži red iz 4.0
   *     opsega (≥ 900M), preskače se i imenuje.
   *  4. PARITET KATALOŠKOG BROJA — broj koji drži red koji izvor ne poznaje ne
   *     dobija BigBit dubl; poruka razlikuje 4.0-native držaoca od reda koji je
   *     u BigBitu obrisan a kod nas namerno ostaje.
   *  5. „ažurirano" znači da se u BigBitu STVARNO nešto promenilo (poređenje po
   *     koloni) — inače bi svaka noć javila 91.000 „izmenjenih".
   *
   * DUPLI KATALOŠKI BROJEVI UNUTAR IZVORA SE NE PRESKAČU: BigBit ih ima (2.061
   * grupa, mereno 31.07) i to je NJEGOVO stanje koje se preslikava; produkcija
   * ih već ima 2.166 grupa i brana `guard_catalog_unique` ih namerno trpi na
   * ažuriranju koje ne dira sam broj. Presudu donosi ta brana, a njen pad se
   * hvata po redu pa se vidi TAČNO koji artikal nije ušao i zašto.
   *
   * `source` NIJE u mapi → na update se NE dira (native marker preživljava);
   * na insert važi DB default 'BIGBIT'.
   */
  private async importItems(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const mapping = this.itemsMapping();
    // `Sifra artikla` je u mapiranju vezana za `items.id` (to je bio QBigTehn-ov
    // broj). Na direktnom kanalu taj broj NE postoji, pa se kolona `id` NIKAD ne
    // upisuje — ključ je `externalItemId`, koji u istoj mapi dolazi iz
    // `BBSifra artikla`, a čita se iz iste staging kolone.
    const columns = mapping.columns.filter((c) => !c.isId);
    // Paritet se meri po kataloškom broju. `ADDITIVE_DEDUP_FIELDS` artikle NE
    // deklariše (ta tabela vozi `GenericSyncer` i njegov additive refresh, kroz
    // koji artikli ne idu), pa je ovo odluka .mdb kanala: katbroj je broj koji
    // ljudi kucaju i nad kojim produkcija već ima branu `guard_catalog_unique`.
    // Čita se ipak kroz `additiveDedupFieldFor`, da deklaracija ostane jedno
    // mesto ako artikli ikad uđu i u taj put.
    const dedupField = additiveDedupFieldFor("items") ?? "catalogNumber";

    const staged = await this.prisma.bbMdbStageArtikal.count({
      where: { dropId },
    });

    // Sve BigBit šifre iz drop-a unapred (91k × int ≈ par MB) — paritet-brana
    // mora da zna da li izvor uopšte poznaje red koji drži sporni katbroj.
    const sourceExts = new Set<number>();
    {
      let k = 0;
      for (;;) {
        const keyPage = await this.prisma.bbMdbStageArtikal.findMany({
          where: { dropId, id: { gt: k } },
          orderBy: { id: "asc" },
          take: 10_000,
          select: { id: true, sifraArtikla: true },
        });
        if (keyPage.length === 0) break;
        k = keyPage[keyPage.length - 1].id;
        for (const r of keyPage) {
          const v = stageInt(r.sifraArtikla);
          if (v !== null && v > 0) sourceExts.add(v);
        }
      }
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let filtered = 0;
    let unparsedDates = 0;
    const seenExts = new Set<number>();
    const named: string[] = [];
    let extraNamed = 0;
    const name = (msg: string): void => {
      if (named.length < MAX_NAMED_SKIPS) named.push(msg);
      else extraNamed++;
    };

    // Brojevi za NOVE artikle se dele iz jednog izvora, redom (vidi
    // `nextBigbitItemId` — opseg ispod 900M je jednopisan).
    let nextNewId = await this.nextBigbitItemId();

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.bbMdbStageArtikal.findMany({
        where: { dropId, id: { gt: lastKey } },
        orderBy: { id: "asc" },
        take: ITEMS_BATCH,
      });
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto (proveri bb_mdb_stage_artikli)`,
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      const candidates: {
        ext: number;
        catalog: string;
        data: Record<string, unknown>;
      }[] = [];
      for (const raw of page) {
        const row = raw as unknown as Record<string, unknown>;
        const rawSifra = row[ARTIKAL_SRC_TO_STAGE_FIELD["Sifra artikla"]];
        const ext = stageInt(rawSifra);
        if (ext === null || ext <= 0) {
          filtered++;
          name(
            `odbačeno: Sifra artikla="${String(rawSifra ?? "")}" nije upotrebljiv broj`,
          );
          continue;
        }
        if (seenExts.has(ext)) {
          filtered++;
          name(`odbačeno: Sifra artikla=${ext} se u drop-u ponavlja`);
          continue;
        }
        seenExts.add(ext);

        const mapped = this.mapStagedProject(
          row,
          columns,
          ARTIKAL_SRC_TO_STAGE_FIELD,
        );
        unparsedDates += mapped.unparsedDates;
        candidates.push({
          ext,
          catalog: String(mapped.data[dedupField] ?? "").trim(),
          data: mapped.data,
        });
      }
      if (candidates.length === 0) continue;

      const exts = candidates.map((c) => c.ext);
      const catalogs = [
        ...new Set(candidates.map((c) => c.catalog).filter((v) => v !== "")),
      ];
      const [existingRows, holderRows] = await Promise.all([
        this.prisma.item.findMany({ where: { externalItemId: { in: exts } } }),
        catalogs.length
          ? this.prisma.item.findMany({
              where: { [dedupField]: { in: catalogs } },
              select: { id: true, externalItemId: true, [dedupField]: true },
            })
          : Promise.resolve([] as { id: number; externalItemId: number }[]),
      ]);
      // Po šifri MOŽE doći više redova (na produkciji postoji 1 takva grupa) —
      // tada se ne pogađa koji je „pravi", nego se red imenuje i preskače.
      const byExt = new Map<number, { id: number }[]>();
      for (const r of existingRows as { id: number; externalItemId: number }[]) {
        const list = byExt.get(r.externalItemId);
        if (list) list.push(r);
        else byExt.set(r.externalItemId, [r]);
      }
      const holders = new Map<string, { id: number; ext: number }[]>();
      for (const h of holderRows as Record<string, unknown>[]) {
        const key = String(h[dedupField] ?? "").trim();
        const entry = { id: Number(h.id), ext: Number(h.externalItemId) };
        const list = holders.get(key);
        if (list) list.push(entry);
        else holders.set(key, [entry]);
      }

      for (const c of candidates) {
        const matches = byExt.get(c.ext) ?? [];
        if (matches.length > 1) {
          skipped++;
          name(
            `preskočeno: Sifra artikla=${c.ext} pokazuje na ${matches.length} naša artikla ` +
              `(id=${matches.map((m) => m.id).join("/")}) — ne pogađam koji je pravi; razreši dubl kod nas`,
          );
          continue;
        }
        const current = (matches[0] ?? null) as Record<string, unknown> | null;

        if (current && isNativeRow("items", Number(current.id))) {
          skipped++;
          name(
            `preskočeno: BigBit šifru ${c.ext} drži artikal id=${String(current.id)} iz 4.0 opsega — ` +
              "native artikal se ne prepisuje sinhronizacijom",
          );
          continue;
        }

        // PARITET SE MERI SAMO KAD BI DUBL ZAISTA NASTAO — dakle na ubacivanju,
        // ili na izmeni koja MENJA sam kataloški broj. Ispravka posle probe na
        // dev-u sa produkcijskom slikom (31.07.2026): brana je bila stroža od
        // baze i preskakala 12 artikala koji kod nas VEĆ POSTOJE sa istim tim
        // brojem (npr. BigBit 34811 = naš id=12640, katbroj R900407394), samo
        // zato što isti broj deli i neki naš artikal bez BigBit porekla. Ti
        // artikli nikad ne bi primili nijednu izmenu iz BigBita. Produkciona
        // brana `guard_catalog_unique` upravo takav upis DOZVOLJAVA (postojeći
        // duplikati se smeju održavati; čiste se u BigBitu), pa se sada
        // ponašamo isto.
        const menjaKatbroj =
          !current ||
          String(current[dedupField] ?? "").trim() !== c.catalog;
        if (c.catalog !== "" && menjaKatbroj) {
          const foreign = (holders.get(c.catalog) ?? []).filter(
            (h) =>
              h.id !== Number(current?.id ?? -1) && !sourceExts.has(h.ext),
          );
          if (foreign.length > 0) {
            const nativeHolders = foreign.filter((h) =>
              isNativeRow("items", h.id),
            );
            skipped++;
            name(
              nativeHolders.length > 0
                ? `paritet: kataloški broj "${c.catalog}" drži 4.0-native artikal id=${nativeHolders
                    .map((h) => h.id)
                    .join("/")} — BigBit artikal ${c.ext} PRESKOČEN; reši sudar u BigBitu`
                : `paritet: kataloški broj "${c.catalog}" drži artikal id=${foreign
                    .map((h) => h.id)
                    .join("/")} koji BigBit više ne šalje (obrisan tamo, ovde namerno ostaje) — ` +
                    `BigBit artikal ${c.ext} PRESKOČEN`,
            );
            continue;
          }
        }

        if (current && this.sameProjectRow(current, c.data, columns, "items")) {
          unchanged++;
          continue;
        }
        try {
          if (current) {
            await this.prisma.item.update({
              where: { id: Number(current.id) },
              data: c.data as never,
            });
            updated++;
          } else {
            await this.prisma.item.create({
              data: { ...c.data, id: nextNewId } as never,
            });
            nextNewId++;
            inserted++;
          }
        } catch (err) {
          skipped++;
          const message = err instanceof Error ? err.message : String(err);
          name(
            `preskočeno: Sifra artikla=${c.ext} (katbroj "${c.catalog}") — ${message.slice(0, 160)}`,
          );
          this.logger.warn(
            `Artikal Sifra=${c.ext} nije uvezen: ${message.slice(0, 300)}`,
          );
        }
      }
    }

    if (unparsedDates > 0)
      notes.push(
        `${unparsedDates} datumsko polje nije bilo u obliku YYYY-MM-DD i upisano je kao prazno — ` +
          "proveri `mdb-export -T/-D` u koraku 1 (bigbit-mdb-export.sh).",
      );
    // PRVI PROLAZ PREPIŠE SKORO SVE — i to nije kvar, pa mora da se objasni na
    // mestu gde se broj čita. Postojeći redovi na produkciji dolaze iz MSSQL puta
    // koji je imao svoju predstavu podataka; izmereno poređenjem sa produkcijskom
    // slikom 31.07.2026, razlike su bile u tri klase:
    //   • prazan string u bazi vs „nema vrednosti" iz .mdb-a (isto po značenju),
    //   • ZNAKOVI koje je MSSQL put pokvario, a .mdb donosi ispravne
    //     (`O4-O5` -> `Ø4-Ø5`, `m2` -> `m²`, `G1/2  ` -> `G1/2''`),
    //   • prave izmene iz BigBita koje append-only prenos nikad nije proneo.
    // Dokazano na tri uzorka po 300 redova: posle JEDNOG upisa ponovno poređenje
    // javlja 0 razlika, dakle sledeće noći mere samo stvarne izmene.
    if (staged > 0 && updated > staged / 2)
      notes.push(
        `ažurirano je ${updated} od ${staged} artikala — ako je ovo PRVI prolaz .mdb kanala, ` +
          "tako i treba: redovi se prevode iz predstave starog MSSQL puta (prazan string, " +
          "pokvareni znakovi Ø/²/'') i primaju izmene koje append-only prenos nikad nije proneo. " +
          "Sledeći prolaz mora javiti mali broj — ako i on javi „skoro sve”, prijavi kao kvar poređenja.",
      );
    if (named.length > 0) notes.push(...named);
    if (extraNamed > 0)
      notes.push(
        `…i još ${extraNamed} sličnih redova (imenovano je prvih ${MAX_NAMED_SKIPS}; puna slika je u bb_mdb_drops.import_row_counts)`,
      );
    notes.push(`${batches} serija po ${ITEMS_BATCH} redova`);

    const step: MdbStepResult = {
      entity: "items",
      staged,
      inserted,
      updated,
      unchanged,
      skipped,
      filtered,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    const counted =
      inserted + updated + unchanged + skipped + filtered + step.blockedLocked;
    if (counted !== staged)
      notes.push(
        `⚠️ brojači se ne zbrajaju: staged=${staged}, sabrano=${counted} — ` +
          `${Math.abs(staged - counted)} red(ova) nije ni u jednom brojaču (prijavi kao kvar uvoza)`,
      );
    return step;
  }

  /**
   * Prvi slobodan `items.id` ISPOD native opsega — polazna tačka za artikle koji
   * su novi u BigBitu (mereno 31.07.2026: njih 59).
   *
   * Ne koristi `items_id_seq`: ona na produkciji stoji na **1**, jer je nikad
   * niko nije koristio — QBigTehn je upisivao eksplicitne brojeve. Prvi
   * `nextval` bi pao na već zauzetom ključu.
   *
   * Broj se uzima JEDNOM po prolazu i dalje se uvećava u memoriji; brava nije
   * potrebna jer je opseg ispod 900M jednopisan: uvoz drži mutex nad drop-om
   * (`claimDrop`), a artikli uneti u 4.0 dobijaju broj iz native opsega
   * (`nextNativeItemId`, ≥ 900M) pa u ovaj opseg ne mogu da upadnu.
   */
  private async nextBigbitItemId(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ next_id: number | bigint }[]>`
      SELECT COALESCE(MAX(id), 0) + 1 AS next_id
        FROM items
       WHERE id < ${NATIVE_ID_BASE}::int`;
    const next = Number(rows[0]?.next_id ?? 1);
    if (!Number.isInteger(next) || next < 1 || next >= NATIVE_ID_BASE)
      throw new Error(
        `Nema slobodnog broja za nov artikal ispod native opsega (dobijeno: ${String(next)})`,
      );
    return next;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ROBNO OGLEDALO — DOKUMENTI, STAVKE, TREBOVANJA
  //
  // IDEMPOTENTNOST (isti obrazac kao ceo ovaj kanal, bez ijednog izuzetka):
  //   • ključ je BIGBIT-ov (`IDDok`, `IDStavke`, `IDTreb`) i ide u `id` ogledala,
  //     pa ponovni uvoz istog drop-a MORA da sudari isti red;
  //   • `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE <red se STVARNO razlikuje>`
  //     — drugi prolaz nad istim fajlom ne piše ništa i sve javlja kao „nepromenjeno";
  //   • `imported_drop_id` NIJE u poređenju (menja se svake noći i sam bi
  //     „razlikovao" svih 182.500 stavki), kao ni `updated_at`;
  //   • NEMA `deleteMany` — „ništa se ne briše" važi i ovde (BigBit prazni
  //     zatvorene godine, pa nestanak reda nije brisanje).
  //
  // ⚠️ POSLEDICA KOJU MORA DA ZNA EKRAN, NE UVOZ: pošto se ništa ne briše, posle
  // prve smene poslovne godine ogledalo drži Level 0 dokumente DVE godine, a
  // svaka godina već sadrži svoj „Donos po popisu" — prost zbir bi udvostručio
  // stanje. Mereno u ovom fajlu: Level 0 postoji ISKLJUČIVO za `Godina = 2026`
  // (1.528 dokumenata), dok Level 250 nosi rep od 2017. naovamo. Zato lager upit
  // MORA da seče po godini (`year`, ili `document_date >= 01.01.tekuće`) — a
  // uvoz to MERI i imenuje čim se pojavi druga godina (v. `notes` u koraku).
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `T_Robna dokumenta` -> `goods_documents_mirror`.
   *
   * Zaglavlje ide PRE stavki: stavka ima tvrd FK na dokument
   * (`fk_goods_document_items_mirror_document`), pa bi obrnut redosled oborio
   * CELU seriju od 2.000 stavki zbog jednog dokumenta koji još nije stigao.
   */
  private async importGoodsDocuments(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const notReady = await this.mirrorNotReady(
      "goods_documents_mirror",
      [
        "level",
        "is_inflow",
        "is_reservation",
        "document_number",
        "customer_id",
      ],
      "bb_mdb_stage_robna_dokumenta",
      t0,
    );
    if (notReady) return notReady;

    const [stagedRow] = await this.prisma.$queryRaw<CountOnlyRow[]>`
      SELECT count(*) AS c FROM bb_mdb_stage_robna_dokumenta WHERE drop_id = ${dropId}`;
    const staged = n(stagedRow?.c);
    let inserted = 0;
    let updated = 0;
    let filtered = 0;
    let truncatedTypes = 0;
    const seen = new Set<number>();
    const named = new Named();

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<StageGoodsDocRow[]>`
        SELECT id, id_dok, ulaz, broj_dokumenta, vrsta_dokumenta, sifra_komitenta,
               datum_dokumenta, datum_knjizenja, id_magacin_dok, level,
               id_predmet, zakljucano, rezervisi, godina
          FROM bb_mdb_stage_robna_dokumenta
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id
         LIMIT ${GOODS_BATCH}`;
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto ` +
            "(proveri bb_mdb_stage_robna_dokumenta)",
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      const rows: MappedGoodsDocument[] = [];
      for (const raw of page) {
        const m = mapGoodsDocumentRow(
          raw as unknown as Record<string, unknown>,
        );
        if (!m.ok) {
          filtered++;
          named.add(m.reason);
          continue;
        }
        // Duplikat IDDok-a u istom drop-u bi oborio celu seriju („ON CONFLICT DO
        // UPDATE cannot affect row a second time"), pa se drugi pojavak odbacuje
        // i broji. Mereno: danas ih nema nijedan — brana je za bajat izvoz.
        if (seen.has(m.value.id)) {
          filtered++;
          named.add(`odbačeno: IDDok=${m.value.id} se u drop-u ponavlja`);
          continue;
        }
        seen.add(m.value.id);
        if (m.value.typeTruncated) truncatedTypes++;
        rows.push(m.value);
      }
      if (rows.length === 0) continue;

      // KLJUČEVI SU IMENA KOLONA (snake_case) — `jsonb_to_recordset` spaja po
      // imenu, a nenavedeni identifikatori u `AS t(...)` su mala slova.
      const payload = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          document_type: r.documentType,
          document_number: r.documentNumber,
          document_date: r.documentDate,
          posting_date: r.postingDate,
          is_inflow: r.isInflow,
          is_reservation: r.isReservation,
          is_locked: r.isLocked,
          level: r.level,
          warehouse_id: r.warehouseId,
          customer_id: r.customerId,
          project_id: r.projectId,
          year: r.year,
        })),
      );
      const [row] = await this.prisma.$queryRaw<UpsertCountRow[]>`
        WITH src AS (
          SELECT id, document_type, document_number,
                 document_date::date AS document_date,
                 posting_date::date  AS posting_date,
                 is_inflow, is_reservation, is_locked, level,
                 warehouse_id, customer_id, project_id, year
          FROM jsonb_to_recordset(${payload}::jsonb) AS t(
            id int, document_type text, document_number text,
            document_date text, posting_date text,
            is_inflow boolean, is_reservation boolean, is_locked boolean,
            level int, warehouse_id int, customer_id int, project_id int, year int)
        ),
        ins AS (
          INSERT INTO goods_documents_mirror
            (id, document_type, document_number, document_date, posting_date,
             is_inflow, is_reservation, is_locked, level, warehouse_id,
             customer_id, project_id, year, imported_drop_id)
          SELECT id, document_type, document_number, document_date, posting_date,
                 is_inflow, is_reservation, is_locked, level, warehouse_id,
                 customer_id, project_id, year, ${dropId}
          FROM src
          ON CONFLICT (id) DO UPDATE SET
            document_type   = EXCLUDED.document_type,
            document_number = EXCLUDED.document_number,
            document_date   = EXCLUDED.document_date,
            posting_date    = EXCLUDED.posting_date,
            is_inflow       = EXCLUDED.is_inflow,
            is_reservation  = EXCLUDED.is_reservation,
            is_locked       = EXCLUDED.is_locked,
            level           = EXCLUDED.level,
            warehouse_id    = EXCLUDED.warehouse_id,
            customer_id     = EXCLUDED.customer_id,
            project_id      = EXCLUDED.project_id,
            year            = EXCLUDED.year
          WHERE (goods_documents_mirror.document_type, goods_documents_mirror.document_number,
                 goods_documents_mirror.document_date, goods_documents_mirror.posting_date,
                 goods_documents_mirror.is_inflow, goods_documents_mirror.is_reservation,
                 goods_documents_mirror.is_locked, goods_documents_mirror.level,
                 goods_documents_mirror.warehouse_id, goods_documents_mirror.customer_id,
                 goods_documents_mirror.project_id, goods_documents_mirror.year)
            IS DISTINCT FROM
                (EXCLUDED.document_type, EXCLUDED.document_number,
                 EXCLUDED.document_date, EXCLUDED.posting_date,
                 EXCLUDED.is_inflow, EXCLUDED.is_reservation,
                 EXCLUDED.is_locked, EXCLUDED.level,
                 EXCLUDED.warehouse_id, EXCLUDED.customer_id,
                 EXCLUDED.project_id, EXCLUDED.year)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated`;
      inserted += n(row?.inserted);
      updated += n(row?.updated);
    }

    const step: MdbStepResult = {
      entity: "goods_documents_mirror",
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, staged - inserted - updated - filtered),
      skipped: 0,
      filtered,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GOODS_BATCH} redova`);
    if (truncatedTypes > 0)
      step.notes.push(
        `${truncatedTypes} dokument(a) ima „Vrsta dokumenta" dužu od 5 znakova i skraćena je — ` +
          "u BigBitu je ta kolona Text(5) (mereno: najduža je tačno 5), pa ovo znači da se " +
          "izvor promenio. Proveri pre nego što ekran počne da filtrira po vrsti.",
      );
    named.into(step.notes);
    await this.warnOnMultiYearStock(step);
    await this.warnOnEmptyStaging(
      step,
      staged,
      "goods_documents_mirror",
      async () => {
        const [m] = await this.prisma.$queryRaw<CountOnlyRow[]>`
          SELECT count(*) AS c FROM goods_documents_mirror`;
        return n(m?.c);
      },
    );
    return step;
  }

  /**
   * `T_Robne stavke` -> `goods_document_items_mirror`. NOSILAC LAGERA.
   *
   * Dve stvari koje ovaj korak radi u memoriji, i zašto baš tako:
   *  • SMER (`IDDok` -> `Ulaz`) se učita jednom za ceo drop (27.338 redova) —
   *    smer je na ZAGLAVLJU, a stavke se obrađuju po stranicama, pa bi bez mape
   *    svaka stranica morala nazad u bazu po isto.
   *  • ŠIFRA -> ARTIKAL (`items.external_item_id` -> `items.id`) isto jednom
   *    (~92k redova). `items.external_item_id` NEMA indeks, pa bi JOIN po
   *    stranici značio ~92 puna prolaza kroz tabelu artikala.
   */
  private async importGoodsDocumentItems(
    dropId: number,
  ): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const notReady = await this.mirrorNotReady(
      "goods_document_items_mirror",
      ["quantity_in", "quantity_out", "warehouse_id", "quantity"],
      "bb_mdb_stage_robne_stavke",
      t0,
      "goods_document_items_mirror",
    );
    if (notReady) return notReady;

    const [stagedRow] = await this.prisma.$queryRaw<CountOnlyRow[]>`
      SELECT count(*) AS c FROM bb_mdb_stage_robne_stavke WHERE drop_id = ${dropId}`;
    const staged = n(stagedRow?.c);
    const directions = await this.loadGoodsDirections(dropId);
    const items = await this.loadBbItemIndex();
    let inserted = 0;
    let updated = 0;
    let filtered = 0;
    let skipped = 0;
    const seen = new Set<number>();
    const named = new Named();

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<StageGoodsItemRow[]>`
        SELECT id, id_stavke, id_dok, sifra_artikla, kolicina, kg_kolicina,
               nabavna_cena_neto, stvarna_vp_cena, stvarna_mp_cena, rabat_proc,
               id_magacin, opis_stavke
          FROM bb_mdb_stage_robne_stavke
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id
         LIMIT ${GOODS_BATCH}`;
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto ` +
            "(proveri bb_mdb_stage_robne_stavke)",
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      const rows: MappedGoodsItem[] = [];
      for (const raw of page) {
        const m = mapGoodsItemRow(
          raw as unknown as Record<string, unknown>,
          directions,
          items,
        );
        if (!m.ok) {
          if (m.kind === "FILTER") filtered++;
          else skipped++;
          named.add(m.reason);
          continue;
        }
        if (seen.has(m.value.id)) {
          filtered++;
          named.add(`odbačeno: IDStavke=${m.value.id} se u drop-u ponavlja`);
          continue;
        }
        seen.add(m.value.id);
        rows.push(m.value);
      }
      if (rows.length === 0) continue;

      const payload = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          document_id: r.documentId,
          item_id: r.itemId,
          catalog_number: r.catalogNumber,
          warehouse_id: r.warehouseId,
          quantity: r.quantity,
          quantity_in: r.quantityIn,
          quantity_out: r.quantityOut,
          kg_quantity: r.kgQuantity,
          purchase_price_net: r.purchasePriceNet,
          actual_wholesale_price: r.actualWholesalePrice,
          actual_retail_price: r.actualRetailPrice,
          discount_percent: r.discountPercent,
          item_description: r.itemDescription,
        })),
      );
      // Stavka čiji dokument nije ušao u ogledalo (npr. zaglavlje odbačeno zbog
      // datuma) oborila bi CELU seriju na FK-u, pa je `JOIN` filter, ne ukras.
      const [row] = await this.prisma.$queryRaw<UpsertCountRow[]>`
        WITH src AS (
          SELECT id, document_id, item_id, catalog_number, warehouse_id,
                 quantity::numeric               AS quantity,
                 quantity_in::numeric            AS quantity_in,
                 quantity_out::numeric           AS quantity_out,
                 kg_quantity::numeric            AS kg_quantity,
                 purchase_price_net::numeric     AS purchase_price_net,
                 actual_wholesale_price::numeric AS actual_wholesale_price,
                 actual_retail_price::numeric    AS actual_retail_price,
                 discount_percent::numeric       AS discount_percent,
                 item_description
          FROM jsonb_to_recordset(${payload}::jsonb) AS t(
            id int, document_id int, item_id int, catalog_number text,
            warehouse_id int, quantity text, quantity_in text, quantity_out text,
            kg_quantity text, purchase_price_net text, actual_wholesale_price text,
            actual_retail_price text, discount_percent text, item_description text)
        ),
        eligible AS (
          SELECT s.* FROM src s
          JOIN goods_documents_mirror d ON d.id = s.document_id
        ),
        ins AS (
          INSERT INTO goods_document_items_mirror
            (id, document_id, item_id, catalog_number, warehouse_id, quantity,
             quantity_in, quantity_out, kg_quantity, purchase_price_net,
             actual_wholesale_price, actual_retail_price, discount_percent,
             item_description, updated_at)
          SELECT id, document_id, item_id, catalog_number, warehouse_id, quantity,
                 quantity_in, quantity_out, kg_quantity, purchase_price_net,
                 actual_wholesale_price, actual_retail_price, discount_percent,
                 item_description, now()
          FROM eligible
          ON CONFLICT (id) DO UPDATE SET
            document_id            = EXCLUDED.document_id,
            item_id                = EXCLUDED.item_id,
            catalog_number         = EXCLUDED.catalog_number,
            warehouse_id           = EXCLUDED.warehouse_id,
            quantity               = EXCLUDED.quantity,
            quantity_in            = EXCLUDED.quantity_in,
            quantity_out           = EXCLUDED.quantity_out,
            kg_quantity            = EXCLUDED.kg_quantity,
            purchase_price_net     = EXCLUDED.purchase_price_net,
            actual_wholesale_price = EXCLUDED.actual_wholesale_price,
            actual_retail_price    = EXCLUDED.actual_retail_price,
            discount_percent       = EXCLUDED.discount_percent,
            item_description       = EXCLUDED.item_description,
            updated_at             = now()
          -- updated_at NIJE u poređenju: ono se menja pri svakom upisu i samo
          -- bi „razlikovalo" svih 182.500 stavki svake noći.
          WHERE (goods_document_items_mirror.document_id, goods_document_items_mirror.item_id,
                 goods_document_items_mirror.catalog_number, goods_document_items_mirror.warehouse_id,
                 goods_document_items_mirror.quantity, goods_document_items_mirror.quantity_in,
                 goods_document_items_mirror.quantity_out, goods_document_items_mirror.kg_quantity,
                 goods_document_items_mirror.purchase_price_net,
                 goods_document_items_mirror.actual_wholesale_price,
                 goods_document_items_mirror.actual_retail_price,
                 goods_document_items_mirror.discount_percent,
                 goods_document_items_mirror.item_description)
            IS DISTINCT FROM
                (EXCLUDED.document_id, EXCLUDED.item_id,
                 EXCLUDED.catalog_number, EXCLUDED.warehouse_id,
                 EXCLUDED.quantity, EXCLUDED.quantity_in,
                 EXCLUDED.quantity_out, EXCLUDED.kg_quantity,
                 EXCLUDED.purchase_price_net,
                 EXCLUDED.actual_wholesale_price,
                 EXCLUDED.actual_retail_price,
                 EXCLUDED.discount_percent,
                 EXCLUDED.item_description)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
               (SELECT count(*) FROM src) - (SELECT count(*) FROM eligible) AS lost`;
      inserted += n(row?.inserted);
      updated += n(row?.updated);
      const lost = n(row?.lost);
      if (lost > 0) {
        skipped += lost;
        named.add(
          `preskočeno: ${lost} stavk(i) u ovoj seriji pokazuje na dokument koji NIJE u ogledalu ` +
            "(zaglavlje odbačeno u prethodnom koraku)",
        );
      }
    }

    const step: MdbStepResult = {
      entity: "goods_document_items_mirror",
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, staged - inserted - updated - filtered - skipped),
      skipped,
      filtered,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GOODS_BATCH} redova`);
    if (skipped > 0)
      step.notes.push(
        `${skipped} robnih stavki NIJE u ogledalu — artikal sa tom BigBit šifrom ne postoji u 4.0 ` +
          "(ili je šifra dupla, ili dokument nije ušao). Te količine ne ulaze u lager: red koji " +
          "pokazuje na artikal kog nemamo ne može se ni prikazati. Ispravlja se samo od sebe " +
          "sledeće noći, čim uvoz artikala donese tu šifru.",
      );
    named.into(step.notes);
    await this.warnOnEmptyStaging(
      step,
      staged,
      "goods_document_items_mirror",
      async () => {
        const [m] = await this.prisma.$queryRaw<CountOnlyRow[]>`
          SELECT count(*) AS c FROM goods_document_items_mirror`;
        return n(m?.c);
      },
    );
    return step;
  }

  /** `T_Trebovanja` -> `purchase_orders_mirror` (kartica artikla: „narudžbine"). */
  private async importPurchaseOrders(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const notReady = await this.mirrorNotReady(
      "purchase_orders_mirror",
      ["order_number", "order_date", "supplier_id", "level", "is_ordered"],
      "bb_mdb_stage_trebovanja",
      t0,
    );
    if (notReady) return notReady;

    const [stagedRow] = await this.prisma.$queryRaw<CountOnlyRow[]>`
      SELECT count(*) AS c FROM bb_mdb_stage_trebovanja WHERE drop_id = ${dropId}`;
    const staged = n(stagedRow?.c);
    let inserted = 0;
    let updated = 0;
    let filtered = 0;
    const seen = new Set<number>();
    const named = new Named();

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<StageRequisitionRow[]>`
        SELECT id, id_treb, broj_trebovanja, datum_trebovanja, sifra_komitenta,
               id_predmet, napomena, level, poruceno, godina
          FROM bb_mdb_stage_trebovanja
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id
         LIMIT ${GOODS_BATCH}`;
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto ` +
            "(proveri bb_mdb_stage_trebovanja)",
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      const rows: MappedRequisition[] = [];
      for (const raw of page) {
        const m = mapRequisitionRow(raw as unknown as Record<string, unknown>);
        if (!m.ok) {
          filtered++;
          named.add(m.reason);
          continue;
        }
        if (seen.has(m.value.id)) {
          filtered++;
          named.add(`odbačeno: IDTreb=${m.value.id} se u drop-u ponavlja`);
          continue;
        }
        seen.add(m.value.id);
        rows.push(m.value);
      }
      if (rows.length === 0) continue;

      const payload = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          order_number: r.orderNumber,
          order_date: r.orderDate,
          supplier_id: r.supplierId,
          project_id: r.projectId,
          note: r.note,
          level: r.level,
          is_ordered: r.isOrdered,
          year: r.year,
        })),
      );
      const [row] = await this.prisma.$queryRaw<UpsertCountRow[]>`
        WITH src AS (
          SELECT id, order_number, order_date::date AS order_date,
                 supplier_id, project_id, note, level, is_ordered, year
          FROM jsonb_to_recordset(${payload}::jsonb) AS t(
            id int, order_number text, order_date text, supplier_id int,
            project_id int, note text, level int, is_ordered boolean, year int)
        ),
        ins AS (
          INSERT INTO purchase_orders_mirror
            (id, order_number, order_date, supplier_id, project_id, note,
             level, is_ordered, year, imported_drop_id)
          SELECT id, order_number, order_date, supplier_id, project_id, note,
                 level, is_ordered, year, ${dropId}
          FROM src
          ON CONFLICT (id) DO UPDATE SET
            order_number = EXCLUDED.order_number,
            order_date   = EXCLUDED.order_date,
            supplier_id  = EXCLUDED.supplier_id,
            project_id   = EXCLUDED.project_id,
            note         = EXCLUDED.note,
            level        = EXCLUDED.level,
            is_ordered   = EXCLUDED.is_ordered,
            year         = EXCLUDED.year
          WHERE (purchase_orders_mirror.order_number, purchase_orders_mirror.order_date,
                 purchase_orders_mirror.supplier_id, purchase_orders_mirror.project_id,
                 purchase_orders_mirror.note, purchase_orders_mirror.level,
                 purchase_orders_mirror.is_ordered, purchase_orders_mirror.year)
            IS DISTINCT FROM
                (EXCLUDED.order_number, EXCLUDED.order_date,
                 EXCLUDED.supplier_id, EXCLUDED.project_id,
                 EXCLUDED.note, EXCLUDED.level,
                 EXCLUDED.is_ordered, EXCLUDED.year)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated`;
      inserted += n(row?.inserted);
      updated += n(row?.updated);
    }

    const step: MdbStepResult = {
      entity: "purchase_orders_mirror",
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, staged - inserted - updated - filtered),
      skipped: 0,
      filtered,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GOODS_BATCH} redova`);
    named.into(step.notes);
    await this.warnOnEmptyStaging(
      step,
      staged,
      "purchase_orders_mirror",
      async () => {
        const [m] = await this.prisma.$queryRaw<CountOnlyRow[]>`
          SELECT count(*) AS c FROM purchase_orders_mirror`;
        return n(m?.c);
      },
    );
    return step;
  }

  /** `T_Trebovanja stavke` -> `purchase_order_items_mirror`. */
  private async importPurchaseOrderItems(
    dropId: number,
  ): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const notReady = await this.mirrorNotReady(
      "purchase_order_items_mirror",
      ["order_id", "item_id", "ordered_quantity", "received_quantity"],
      "bb_mdb_stage_trebovanja_stavke",
      t0,
    );
    if (notReady) return notReady;

    const [stagedRow] = await this.prisma.$queryRaw<CountOnlyRow[]>`
      SELECT count(*) AS c FROM bb_mdb_stage_trebovanja_stavke WHERE drop_id = ${dropId}`;
    const staged = n(stagedRow?.c);
    const knownOrders = await this.loadRequisitionIds(dropId);
    const items = await this.loadBbItemIndex();
    let inserted = 0;
    let updated = 0;
    let filtered = 0;
    let skipped = 0;
    const seen = new Set<number>();
    const named = new Named();

    let lastKey = 0;
    let batches = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<StageRequisitionItemRow[]>`
        SELECT id, id_stavke, id_treb, sifra_artikla, treb_kol, isporucena_kolicina,
               cena, opis, ocekivani_datum_isporuke, datum_isporuke, isporuceno,
               rabat_proc
          FROM bb_mdb_stage_trebovanja_stavke
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id
         LIMIT ${GOODS_BATCH}`;
      if (page.length === 0) break;
      const pageMax = page[page.length - 1].id;
      if (pageMax <= lastKey) {
        notes.push(
          `keyset ne napreduje na staging id=${lastKey} — stranicanje prekinuto ` +
            "(proveri bb_mdb_stage_trebovanja_stavke)",
        );
        break;
      }
      lastKey = pageMax;
      batches++;

      const rows: MappedRequisitionItem[] = [];
      for (const raw of page) {
        const m = mapRequisitionItemRow(
          raw as unknown as Record<string, unknown>,
          knownOrders,
          items,
        );
        if (!m.ok) {
          if (m.kind === "FILTER") filtered++;
          else skipped++;
          named.add(m.reason);
          continue;
        }
        if (seen.has(m.value.id)) {
          filtered++;
          named.add(`odbačeno: IDStavke=${m.value.id} se u drop-u ponavlja`);
          continue;
        }
        seen.add(m.value.id);
        rows.push(m.value);
      }
      if (rows.length === 0) continue;

      const payload = JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          order_id: r.orderId,
          item_id: r.itemId,
          ordered_quantity: r.orderedQuantity,
          received_quantity: r.receivedQuantity,
          unit_price: r.unitPrice,
          discount_percent: r.discountPercent,
          description: r.description,
          expected_delivery_date: r.expectedDeliveryDate,
          actual_delivery_date: r.deliveryDate,
          is_delivered: r.isDelivered,
        })),
      );
      const [row] = await this.prisma.$queryRaw<UpsertCountRow[]>`
        WITH src AS (
          SELECT id, order_id, item_id,
                 ordered_quantity::numeric  AS ordered_quantity,
                 received_quantity::numeric AS received_quantity,
                 unit_price::numeric        AS unit_price,
                 discount_percent::numeric  AS discount_percent,
                 description,
                 expected_delivery_date::date AS expected_delivery_date,
                 actual_delivery_date::date          AS actual_delivery_date,
                 is_delivered
          FROM jsonb_to_recordset(${payload}::jsonb) AS t(
            id int, order_id int, item_id int, ordered_quantity text,
            received_quantity text, unit_price text, discount_percent text,
            description text, expected_delivery_date text, actual_delivery_date text,
            is_delivered boolean)
        ),
        eligible AS (
          SELECT s.* FROM src s
          JOIN purchase_orders_mirror o ON o.id = s.order_id
        ),
        ins AS (
          INSERT INTO purchase_order_items_mirror
            (id, order_id, item_id, ordered_quantity, received_quantity,
             unit_price, discount_percent, description, expected_delivery_date,
             actual_delivery_date, is_delivered, updated_at)
          SELECT id, order_id, item_id, ordered_quantity, received_quantity,
                 unit_price, discount_percent, description, expected_delivery_date,
                 actual_delivery_date, is_delivered, now()
          FROM eligible
          ON CONFLICT (id) DO UPDATE SET
            order_id               = EXCLUDED.order_id,
            item_id                = EXCLUDED.item_id,
            ordered_quantity       = EXCLUDED.ordered_quantity,
            received_quantity      = EXCLUDED.received_quantity,
            unit_price             = EXCLUDED.unit_price,
            discount_percent       = EXCLUDED.discount_percent,
            description            = EXCLUDED.description,
            expected_delivery_date = EXCLUDED.expected_delivery_date,
            actual_delivery_date          = EXCLUDED.actual_delivery_date,
            is_delivered           = EXCLUDED.is_delivered,
            updated_at             = now()
          WHERE (purchase_order_items_mirror.order_id, purchase_order_items_mirror.item_id,
                 purchase_order_items_mirror.ordered_quantity,
                 purchase_order_items_mirror.received_quantity,
                 purchase_order_items_mirror.unit_price,
                 purchase_order_items_mirror.discount_percent,
                 purchase_order_items_mirror.description,
                 purchase_order_items_mirror.expected_delivery_date,
                 purchase_order_items_mirror.actual_delivery_date,
                 purchase_order_items_mirror.is_delivered)
            IS DISTINCT FROM
                (EXCLUDED.order_id, EXCLUDED.item_id,
                 EXCLUDED.ordered_quantity,
                 EXCLUDED.received_quantity,
                 EXCLUDED.unit_price,
                 EXCLUDED.discount_percent,
                 EXCLUDED.description,
                 EXCLUDED.expected_delivery_date,
                 EXCLUDED.actual_delivery_date,
                 EXCLUDED.is_delivered)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
               (SELECT count(*) FROM src) - (SELECT count(*) FROM eligible) AS lost`;
      inserted += n(row?.inserted);
      updated += n(row?.updated);
      skipped += n(row?.lost);
    }

    const step: MdbStepResult = {
      entity: "purchase_order_items_mirror",
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, staged - inserted - updated - filtered - skipped),
      skipped,
      filtered,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GOODS_BATCH} redova`);
    if (skipped > 0)
      step.notes.push(
        `${skipped} stavki narudžbenica nije ušlo — nepoznata BigBit šifra artikla, dupla šifra ` +
          "ili trebovanje koje nije u ogledalu.",
      );
    named.into(step.notes);
    await this.warnOnEmptyStaging(
      step,
      staged,
      "purchase_order_items_mirror",
      async () => {
        const [m] = await this.prisma.$queryRaw<CountOnlyRow[]>`
          SELECT count(*) AS c FROM purchase_order_items_mirror`;
        return n(m?.c);
      },
    );
    return step;
  }

  // ── POMOĆNO ZA ROBNO OGLEDALO ──────────────────────────────────────────────

  /**
   * BRANA PROTIV RAZILAŽENJA SA MIGRACIJOM: robno ogledalo i njegove staging
   * tabele dolaze migracijom koja se piše ODVOJENO od ovog koda. Dok ona ne
   * legne na server, ovi koraci bi pucali na „relation does not exist" — i time
   * OBORILI CEO NOĆNI UVOZ, uključujući glavnu knjigu koja sa robnim nema veze.
   *
   * Zato korak koji nema svoju tabelu (ili joj fali kolona) ne puca nego se
   * PRESKAČE, sa porukom koja imenuje šta tačno nedostaje. To je jedini slučaj
   * u ovom fajlu gde „ne mogu da radim" nije kvar — jer je stanje prelazno i
   * samo od sebe prestaje čim migracija prođe.
   */
  private async mirrorNotReady(
    table: string,
    columns: string[],
    stageTable: string,
    t0: number,
    entity?: string,
  ): Promise<MdbStepResult | null> {
    const missing: string[] = [];
    for (const [name, cols] of [
      [table, columns],
      [stageTable, ["drop_id"]],
    ] as [string, string[]][]) {
      const present = await this.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${name}`;
      if (present.length === 0) {
        missing.push(`tabela ${name} ne postoji`);
        continue;
      }
      const have = new Set(present.map((r) => r.column_name));
      for (const c of cols) if (!have.has(c)) missing.push(`${name}.${c}`);
    }
    if (missing.length === 0) return null;
    const note =
      `PRESKOČENO — robno ogledalo još nije migrirano: ${missing.join(", ")}. ` +
      "Ovo NIJE kvar uvoza: korak čeka migraciju (goods_documents_mirror / " +
      "purchase_orders_mirror + bb_mdb_stage_robna_* tabele). Ostatak uvoza je prošao normalno.";
    this.logger.warn(`${entity ?? table}: ${note}`);
    return {
      entity: entity ?? table,
      staged: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      filtered: 0,
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes: [note],
    };
  }

  /**
   * `IDDok` -> `Ulaz` za ceo drop. Smer je na ZAGLAVLJU (BigBit drži jednu
   * količinu po stavci), pa stavke bez ove mape ne bi znale svoj smer.
   */
  private async loadGoodsDirections(
    dropId: number,
  ): Promise<Map<number, boolean>> {
    const map = new Map<number, boolean>();
    let lastKey = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<
        { id: number; id_dok: string | null; ulaz: string | null }[]
      >`
        SELECT id, id_dok, ulaz FROM bb_mdb_stage_robna_dokumenta
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id LIMIT 10000`;
      if (page.length === 0) break;
      lastKey = page[page.length - 1].id;
      for (const r of page) {
        const id = stageInt(r.id_dok);
        // Isti parser (`bbBool`) koji puni `is_inflow` u ogledalu — dva čitanja
        // iste zastavice ne smeju da imaju dve definicije istine.
        if (id !== null && id > 0) map.set(id, bbBool(r.ulaz));
      }
    }
    return map;
  }

  /** `IDTreb`-ovi iz drop-a — stavka bez svog trebovanja ne sme u FK. */
  private async loadRequisitionIds(dropId: number): Promise<Set<number>> {
    const ids = new Set<number>();
    let lastKey = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<
        { id: number; id_treb: string | null }[]
      >`
        SELECT id, id_treb FROM bb_mdb_stage_trebovanja
         WHERE drop_id = ${dropId} AND id > ${lastKey}
         ORDER BY id LIMIT 10000`;
      if (page.length === 0) break;
      lastKey = page[page.length - 1].id;
      for (const r of page) {
        const id = stageInt(r.id_treb);
        if (id !== null && id > 0) ids.add(id);
      }
    }
    return ids;
  }

  /**
   * BigBit šifra artikla -> naš `items.id` (+ kataloški broj za prikaz).
   *
   * Učitava se JEDNOM po koraku, iz istog razloga iz kog `importItems` unapred
   * skuplja `sourceExts`: `items.external_item_id` nema indeks, pa bi JOIN po
   * stranici značio ~92 puna prolaza kroz 92.511 artikala.
   */
  private async loadBbItemIndex(): Promise<BbItemIndex> {
    const index: BbItemIndex = new Map();
    let lastKey = 0;
    for (;;) {
      const page = await this.prisma.$queryRaw<
        {
          id: number;
          external_item_id: number;
          catalog_number: string | null;
        }[]
      >`
        SELECT id, external_item_id, catalog_number FROM items
         WHERE external_item_id > 0 AND id > ${lastKey}
         ORDER BY id LIMIT 10000`;
      if (page.length === 0) break;
      lastKey = page[page.length - 1].id;
      for (const r of page) {
        const code = Number(r.external_item_id);
        // Dupla šifra -> `null` = „ne pogađam koji je pravi" (v. `BbItemIndex`).
        if (index.has(code)) index.set(code, null);
        else index.set(code, { id: r.id, catalogNumber: r.catalog_number });
      }
    }
    return index;
  }

  /**
   * SMENA POSLOVNE GODINE — jedini način na koji lager ume da POGREŠI tiho.
   *
   * Uvoz ništa ne briše, pa posle 01.01. ogledalo drži Level 0 dokumente i stare
   * i nove godine; obe godine nose svoj „Donos po popisu", pa bi prost zbir
   * udvostručio stanje. Ovo se ne rešava brisanjem (to je knjigovodstvena
   * odluka) nego SEČENJEM po godini u upitu ekrana — a ovde se MERI i imenuje,
   * da se ne otkrije tek kad neko primeti duplo stanje.
   */
  private async warnOnMultiYearStock(step: MdbStepResult): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      { year: number | null; c: bigint | number }[]
    >`
      SELECT year, count(*) AS c FROM goods_documents_mirror
       WHERE level = 0 GROUP BY year ORDER BY year`;
    if (rows.length <= 1) return;
    const opis = rows
      .map((r) => `${r.year ?? "(bez godine)"}: ${n(r.c)}`)
      .join(", ");
    const poruka =
      `⚠️ Ogledalo drži knjižene (Level 0) robne dokumente iz VIŠE godina — ${opis}. ` +
      "Svaka poslovna godina u BigBitu počinje sopstvenim „Donosom po popisu”, pa zbir " +
      "PREKO godina duplira stanje. Lager upit MORA da seče po godini (year ili " +
      "document_date). Uvoz ovde namerno ništa ne briše.";
    step.notes.push(poruka);
    this.logger.warn(poruka);
  }

  /**
   * Robno nestalo iz izvoza: fajl je stigao (ostali koraci rade), ali BAŠ ove
   * tabele nose nula redova, a ogledalo ih od ranije ima. Ne obara uvoz —
   * robno ne ulazi u PDV ni u bilans, pa ne sme da zaustavi knjigovodstvo — ali
   * se imenuje, jer bi inače lager doveka pokazivao jučerašnje stanje.
   */
  private async warnOnEmptyStaging(
    step: MdbStepResult,
    staged: number,
    table: string,
    /** Broj redova koje ogledalo VEĆ drži — čita se samo kad izvor pošalje nulu. */
    countExisting: () => Promise<number>,
  ): Promise<void> {
    if (staged > 0) return;
    const existing = await countExisting();
    if (existing === 0) return;
    const poruka =
      `⚠️ Iz BigBita nije stigao NIJEDAN red za ${table}, a ogledalo ih drži ${existing} ` +
      "od ranije. Lager i kartice artikla od sada pokazuju JUČERAŠNJE stanje. " +
      "Proveri manifest TABLES u bigbit-mdb-export.sh (T_Robna dokumenta / T_Robne stavke / " +
      "T_Trebovanja) i da li su tabele preimenovane u BigBitu.";
    step.notes.push(poruka);
    this.logger.warn(poruka);
  }

  /** Mapiranje `R_Artikli` -> `items` iz `SYNC_MAP` — iste glasne provere kao predmeti. */
  private itemsMapping(): TableMapping {
    const mapping = SYNC_MAP.find((m) => m.targetDb === "items");
    if (!mapping)
      throw new Error(
        "sync-map.generated.ts nema mapiranje za `items` — uvoz artikala ne može da zna " +
          "u koje kolone piše. Proveri generator mape (targetDb: 'items').",
      );
    // Ključ je `externalItemId` (BigBit šifra), NE `id` — vidi obrazloženje nad
    // `importItems`. Ako ta kolona ikad nestane iz mape, uvoz bi počeo da piše
    // po `id`-u i prepisivao nepovezane artikle, pa to mora da padne glasno.
    if (!mapping.columns.some((c) => c.field === "externalItemId"))
      throw new Error(
        "Mapiranje `items` više nema kolonu `externalItemId` (BigBit šifra iz " +
          "`BBSifra artikla`). Uvoz artikala se KLJUČA po njoj, jer `items.id` na produkciji " +
          "nosi staru QBigTehn numeraciju (mereno: 0 od 92.511 redova ima id = external_item_id).",
      );
    const missing = mapping.columns
      .filter((c) => !ARTIKAL_SRC_TO_STAGE_FIELD[c.src])
      .map((c) => c.src);
    if (missing.length)
      throw new Error(
        `Kolone ${missing.join(", ")} postoje u mapiranju \`items\`, ali nemaju staging kolonu ` +
          "u ARTIKAL_SRC_TO_STAGE_FIELD. Dopuni tu tabelu (i zaglavlje `R_Artikli` u " +
          "bigbit-mdb-export.sh + model BbMdbStageArtikal) — inače bi se te kolone tiho uvezle prazne.",
      );
    return mapping;
  }

  /**
   * Mapiranje `Predmeti` -> `projects` iz `SYNC_MAP`, sa proverama koje moraju da
   * padnu GLASNO. Mapa je generisana iz šeme i može da se promeni bez ovog fajla:
   * nova kolona bez reda u `PREDMET_SRC_TO_STAGE_FIELD` bi se tiho upisala kao
   * prazna, a promenjen PK bi obesmislio ključ idempotencije.
   */
  private projectsMapping(): TableMapping {
    const mapping = SYNC_MAP.find((m) => m.targetDb === "projects");
    if (!mapping)
      throw new Error(
        "sync-map.generated.ts nema mapiranje za `projects` — uvoz predmeta ne može da zna " +
          "u koje kolone piše. Proveri generator mape (targetDb: 'projects').",
      );
    if (
      !mapping.pk ||
      mapping.pk.kind !== "single" ||
      mapping.pk.field !== "id"
    )
      throw new Error(
        "Uvoz predmeta radi upsert po jednostavnom `id` ključu, a mapiranje `projects` " +
          "više nema takav primarni ključ — ključ idempotencije bi tiho otkazao.",
      );
    const missing = mapping.columns
      .filter((c) => !PREDMET_SRC_TO_STAGE_FIELD[c.src])
      .map((c) => c.src);
    if (missing.length)
      throw new Error(
        `Kolone ${missing.join(", ")} postoje u mapiranju \`projects\`, ali nemaju staging kolonu ` +
          "u PREDMET_SRC_TO_STAGE_FIELD. Dopuni tu tabelu (i zaglavlje `Predmeti` u " +
          "bigbit-mdb-export.sh + model BbMdbStagePredmet) — inače bi se te kolone tiho uvezle prazne.",
      );
    return mapping;
  }

  /**
   * Ključevi i brojevi CELOG drop-a — ulaz za obe brane vlasništva.
   * `ids` = „izvor poznaje taj id", `numbers` = „izvor poznaje taj broj".
   */
  private async stagedProjectKeys(
    dropId: number,
  ): Promise<{ ids: Set<number>; numbers: Set<string> }> {
    const rows = await this.prisma.bbMdbStagePredmet.findMany({
      where: { dropId },
      select: { idPredmet: true, brojPredmeta: true },
    });
    const ids = new Set<number>();
    const numbers = new Set<string>();
    for (const r of rows) {
      const id = stageInt(r.idPredmet);
      if (id !== null && id > 0) ids.add(id);
      const number = stageText(r.brojPredmeta);
      if (number !== null) numbers.add(number);
    }
    return { ids, numbers };
  }

  /**
   * Jedan staging red -> `projects` oblik, po `SYNC_MAP`. Sve dolazi kao tekst, pa
   * je tipizacija ovde jedina.
   *
   * NOT NULL kolone (`project_number`, `salesperson_id`, `customer_id`) ne smeju da
   * ostanu prazne — prazan tekst postaje `''` / `0`, jer bi `NULL` oborio red, a
   * red koga BigBit ima a 4.0 nema je gubitak podatka. Sve takve zamene se BROJE
   * i prijavljuju u `notes`, nikad tiho.
   */
  private mapStagedProject(
    row: Record<string, unknown>,
    columns: ColumnMapping[],
    // Generalizovano 31.07.2026: isti pretvarač služi i predmete i artikle —
    // dva pretvarača bi bila dve istine o istim tipovima.
    srcToStage: Record<string, string> = PREDMET_SRC_TO_STAGE_FIELD,
  ): { data: Record<string, unknown>; unparsedDates: number } {
    const data: Record<string, unknown> = {};
    let unparsedDates = 0;
    for (const col of columns) {
      const raw = row[srcToStage[col.src]];
      const text = stageText(raw);
      let value: unknown;
      switch (col.type) {
        case "Int":
          value = stageInt(raw);
          break;
        case "Float":
          value = text === null || !Number.isFinite(Number(text))
            ? null
            : Number(text);
          break;
        case "Decimal":
          value = this.toDecimal(text);
          break;
        case "DateTime":
          value = stageDate(raw);
          if (value === null && text !== null) unparsedDates++;
          break;
        case "Boolean":
          value =
            text === null
              ? null
              : ["1", "true", "yes", "da", "-1"].includes(text.toLowerCase());
          break;
        default:
          value = text;
      }
      if (value === null && !col.nullable)
        value = col.type === "String" ? "" : 0;
      data[col.field] = value;
    }
    return { data, unparsedDates };
  }

  /** `Decimal` iz teksta; neupotrebljiva vrednost je `null`, ne pad reda. */
  private toDecimal(text: string | null): Prisma.Decimal | null {
    if (text === null) return null;
    try {
      const d = new Prisma.Decimal(text);
      return d.isNaN() ? null : d;
    } catch {
      return null;
    }
  }

  /**
   * Da li je uvezeni red IDENTIČAN onome što BigBit sada nosi — po MAPIRANIM
   * kolonama, po tipu iz mape. `Decimal` se poredi vrednosno (`100` i `100.0000`
   * su ista suma), `DateTime` po trenutku; string-poređenje bi ta dva slučaja
   * prijavilo kao izmenu i uvoz bi svake noći prepisivao celu tabelu.
   */
  private sameProjectRow(
    current: Record<string, unknown>,
    next: Record<string, unknown>,
    columns: ColumnMapping[],
    table: string,
  ): boolean {
    for (const col of columns) {
      if (col.field === "id") continue;
      const a = current[col.field] ?? null;
      const b = next[col.field] ?? null;
      if (a === null || b === null) {
        if (a !== b) return false;
        continue;
      }
      switch (col.type) {
        case "DateTime": {
          const ta = a instanceof Date ? a.getTime() : NaN;
          const tb = b instanceof Date ? b.getTime() : NaN;
          if (!(ta === tb)) return false;
          break;
        }
        case "Decimal": {
          const da = this.toDecimal(String(a));
          const db = this.toDecimal(String(b));
          if (da === null || db === null) return false;
          // Poredi se na skali koju kolona ČUVA — BigBit-ov `Double` ispisan kao
          // `80.09999999999999` i naših `80.1000` su ista suma (v. DECIMAL_SCALE_*).
          const scale =
            DECIMAL_SCALE_BY_FIELD[table]?.[col.field] ?? DECIMAL_SCALE_DEFAULT;
          if (
            !da.toDecimalPlaces(scale).equals(db.toDecimalPlaces(scale))
          )
            return false;
          break;
        }
        case "Int":
        case "Float":
          if (Number(a) !== Number(b)) return false;
          break;
        case "Boolean":
          if (Boolean(a) !== Boolean(b)) return false;
          break;
        default:
          if (String(a) !== String(b)) return false;
      }
    }
    return true;
  }

  /**
   * Podigni `projects_id_seq` iznad najvišeg uvezenog `id`-a — ali NIKAD unazad.
   *
   * Razlika prema `GenericSyncer.bumpIdSequence`, koji radi `setval(..., MAX(id))`
   * bezuslovno: tamo brisanju prethodi pun izvorni skup, a ovde se ništa ne briše i
   * 4.0 je u međuvremenu mogao da izda (pa i obriše) svoj predmet — bezuslovan
   * `setval` bi tada sekvencu VRATIO i sledeći ručni unos bi pao na `pk_projects`.
   * Zato se piše samo kad je `MAX(id)` iznad trenutne vrednosti sekvence.
   * `pg_sequence_last_value` vraća `NULL` za nekorišćenu sekvencu (otud COALESCE),
   * a `pg_get_serial_sequence` `NULL` ako kolona nije serial (otud WHERE).
   */
  private async bumpProjectsSequence(): Promise<void> {
    try {
      await this.prisma.$queryRaw`
        WITH s AS (SELECT pg_get_serial_sequence('projects', 'id') AS seq),
             m AS (SELECT coalesce(max(id), 0) AS mx FROM projects)
        SELECT setval(s.seq, m.mx, true) AS moved
        FROM s, m
        WHERE s.seq IS NOT NULL
          AND m.mx > coalesce(pg_sequence_last_value(s.seq::regclass), 0)`;
    } catch (e) {
      // Sekvenca je zaštita od BUDUĆEG ručnog unosa, ne uslov uvoza — njen pad ne
      // sme da poništi 7.617 uvezenih predmeta. Ali mora da ostavi trag.
      this.logger.error(
        `projects_id_seq nije podignuta posle uvoza predmeta (sledeći ručni unos predmeta može da padne na pk_projects): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * Brojači jednog koraka, tako da UVEK važi
   * `staged = inserted + updated + unchanged + skipped + filtered + blockedLocked`.
   *
   * `fetched` = redovi koji su ušli u upsert pokušaj (`src`). Dva koraka imaju
   * različit odnos `skipped` prema `src`, pa se to mora reći eksplicitno —
   * inače isti red uđe u dva brojača (ili nestane iz svih, što je i bio kvar):
   *  • `skippedOutsideSrc = false` (nalozi): sudari su PODSKUP `src`.
   *  • `skippedOutsideSrc = true`  (saldakonto): odbačeni nikad nisu ni ušli u `src`.
   */
  private toStep(
    entity: string,
    row: CountRow | undefined,
    t0: number,
    notes: string[],
    skippedOutsideSrc = false,
  ): MdbStepResult {
    const staged = n(row?.staged);
    const inserted = n(row?.inserted);
    const updated = n(row?.updated);
    const skipped = n(row?.skipped);
    const fetched = n(row?.fetched);
    // Odbijena izmena zaključanog naloga MORA da se odbije i od `unchanged` —
    // inače bi red koji se u BigBitu stvarno promenio izlazio kao „nepromenjen",
    // tj. tačno ona tišina zbog koje je brana i uvedena.
    const blockedLocked = n(row?.blocked_locked);
    const unchanged = skippedOutsideSrc
      ? fetched - inserted - updated - blockedLocked
      : fetched - inserted - updated - skipped - blockedLocked;
    const filtered = skippedOutsideSrc
      ? staged - fetched - skipped
      : staged - fetched;
    return {
      entity,
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, unchanged),
      skipped,
      filtered: Math.max(0, filtered),
      blockedLocked,
      durationMs: Date.now() - t0,
      notes,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MATIČNI PODACI — KOMITENTI (30.07.2026)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `Komitenti` (staging) -> `customers`. ISKLJUČIVO UPSERT po `Sifra` (= `id`).
   *
   * ZAŠTO OVAJ KORAK POSTOJI: komitenti su do 22.07.2026 stizali kroz MSSQL kopiju
   * (`CustomerSyncer`), a prenos BigBit -> QBigTehn se više ne radi — izvor je MRTAV.
   * Naša karika je zdrava (ručno pokretanje 30.07.: 7.617 predmeta pročitano i
   * upisano, 0 grešaka), samo podataka u izvoru nema. Zato matični podaci od sada
   * idu ISTIM kanalom kao knjigovodstvo: iz kopije BigBit baze.
   *
   * ČETIRI PRAVILA KOJA OVAJ KORAK POŠTUJE:
   *
   *  1. NIŠTA SE NE BRIŠE — nema `deleteMany` ni „obriši pa vrati" obrasca (kao
   *     `items` full refresh). BigBit PRAZNI zatvorene godine (Access ima granicu
   *     veličine baze), pa red koji nestane iz drop-a je najčešće godišnje
   *     arhiviranje, a ne obrisan komitent.
   *  2. 4.0-NATIVE RED SE NE DIRA — provera je dvostruka i ista kao u
   *     `CustomerSyncer`: rezervisan opseg ključeva (`isNativeRow`) I marker
   *     porekla iz šeme (`source='NATIVE'`). Preskočen red se BROJI i IMENUJE u
   *     `notes` (ne tiho — `notes` je jedino što stiže do čoveka).
   *  3. MAPIRANJE JE JEDNA ISTINA — `mapKomitentiRow` (v. import na vrhu). Ovaj
   *     korak samo TIPIZIRA sirov staging tekst u ono što mapper očekuje.
   *  4. NEPOSTOJEĆA VEZA SE NULIRA, RED SE NE ODBIJA — prodavac, vrsta šifre i
   *     vozač; komitent bez para u šifarniku je i dalje komitent.
   *
   * ⚠️ NIJE UVEZANO U `runImport`. Korak stoji sam i poziva se namerno (ručno
   * pokretanje / poseban posao), jer `runImport` danas obara ceo uvoz na sudaru
   * broja naloga i zaključava red koraka po FK lancu knjigovodstva — uvezivanje
   * matičnih podataka u taj lanac je zasebna odluka (i zaseban prolaz kroz
   * `assertStagingNotEmpty`, koji za komitente još ne zna).
   *
   * ⚠️ 17 KOLONA IZVOR DANAS NE ŠALJE — v. `KOMITENTI_FIELDS_NOT_IN_MDB`. To NIJE
   * kozmetika: bez tog izuzetka bi prvi noćni prolaz obrisao `MaticniBroj`,
   * `JBKJS`, `GLN` i `CRF` svakom komitentu, tj. podatke od kojih zavisi SEF.
   */
  async importCustomers(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const staged = await this.prisma.bbMdbStageKomitent.count({
      where: { dropId },
    });

    // Ciljevi stranih ključeva + popis 4.0-native komitenata: jednim upitom PRE
    // prolaza (native redova je malo), isto kao `CustomerSyncer`.
    const [salespersonIds, codeTypeCodes, nativeIds] = await Promise.all([
      this.prisma.salesperson
        .findMany({ select: { id: true } })
        .then((r) => new Set(r.map((x) => x.id))),
      this.prisma.codeType
        .findMany({ select: { code: true } })
        .then((r) => new Set(r.map((x) => x.code))),
      this.prisma.customer
        .findMany({
          where: { source: NATIVE_SOURCE_MARKER },
          select: { id: true },
        })
        .then((r) => new Set(r.map((x) => x.id))),
    ]);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skippedNative = 0;
    let skippedError = 0;
    let filteredNoKey = 0;
    let filteredDupe = 0;
    let nulledSalesperson = 0;
    let nulledCodeType = 0;
    let nulledDriver = 0;
    const nativeExamples: number[] = [];
    const errorExamples: string[] = [];
    /** `Sifra` je IDENTITY — duplikat unutar jednog drop-a je anomalija. */
    const seen = new Set<number>();
    let lastStageId = 0;
    let batches = 0;

    for (;;) {
      // Keyset po staging PK — `skip`/`OFFSET` se namerno ne koristi (isti razlog
      // kao u `importLedgerEntries`), a cela tabela se nikad ne drži u memoriji.
      const page = await this.prisma.bbMdbStageKomitent.findMany({
        where: { dropId, id: { gt: lastStageId } },
        orderBy: { id: "asc" },
        take: CUSTOMERS_BATCH,
      });
      if (page.length === 0) break;
      lastStageId = page[page.length - 1].id;
      batches++;

      // ── 1) FILTER + ZAŠTITA POREKLA (pre ijednog upisa) ──────────────────
      const rows: { row: BbMdbStageKomitent; sifra: number }[] = [];
      for (const row of page) {
        const sifraText = (row.sifra ?? "").trim();
        if (!/^\d+$/.test(sifraText) || Number(sifraText) === 0) {
          filteredNoKey++;
          continue;
        }
        const sifra = Number(sifraText);
        if (seen.has(sifra)) {
          filteredDupe++;
          continue;
        }
        seen.add(sifra);

        const nativeById = isNativeRow("customers", sifra);
        const nativeByMarker = nativeIds.has(sifra);
        if (nativeById || nativeByMarker) {
          skippedNative++;
          if (nativeExamples.length < 20) nativeExamples.push(sifra);
          this.logger.warn(
            `Preskočen komitent Sifra=${sifra}: ` +
              (nativeById
                ? `id je u rezervisanom 4.0 opsegu (≥ ${NATIVE_ID_BASE})`
                : `red u 4.0 nosi marker porekla source='${NATIVE_SOURCE_MARKER}'`) +
              " (zaštita 4.0-native reda)",
          );
          continue;
        }
        rows.push({ row, sifra });
      }
      if (rows.length === 0) continue;

      // ── 2) MAPIRANJE (jedna istina) ──────────────────────────────────────
      const mapped = rows.map(({ row, sifra }) => ({
        sifra,
        // Sirove vrednosti se pamte SAMO da bi se nulirana veza mogla PRIJAVITI:
        // mapper nuluje tiho, a tišina je ovde zabranjena.
        rawSalesperson: stageNum(row.sifraProdavca),
        rawCodeType: stageText(row.vrstaSifre),
        data: komitentPayload(row, salespersonIds, codeTypeCodes),
      }));

      // ── 3) VEZE I POREĐENJE — dva upita po SERIJI, ne po redu ────────────
      // `customers.driver_id` ima TVRD self-FK (`fk_customers_driver`), a mapper
      // proverava samo `> 0`. Vozač koji još nije uvezen bi oborio red, pa se
      // veza nuluje; kad vozač uđe (isti ili sledeći prolaz), sledeći upsert je
      // sam uspostavi — zato se ovde ništa ne gubi trajno.
      const driverIds = [
        ...new Set(
          mapped
            .map((m) => m.data.driverId)
            .filter((x): x is number => typeof x === "number"),
        ),
      ];
      const driverExists = new Set<number>();
      if (driverIds.length > 0)
        for (const r of await this.prisma.customer.findMany({
          where: { id: { in: driverIds } },
          select: { id: true },
        }))
          driverExists.add(r.id);

      // Postojeći redovi se čitaju da bi „ažurirano" značilo ISKLJUČIVO da se
      // sadržaj promenio u BigBitu (isto načelo kao `IS DISTINCT FROM` u SQL
      // koracima) — inače bi svaka noć prepisala celu maticu i stvarna izmena
      // bi se izgubila u šumu.
      const before = new Map<number, Record<string, unknown>>();
      for (const r of await this.prisma.customer.findMany({
        where: { id: { in: mapped.map((m) => m.sifra) } },
      }))
        before.set(r.id, r as unknown as Record<string, unknown>);

      // ── 4) UPSERT ────────────────────────────────────────────────────────
      for (const m of mapped) {
        const data = m.data;
        if (
          m.rawSalesperson !== null &&
          m.rawSalesperson > 0 &&
          data.salespersonId === null
        )
          nulledSalesperson++;
        if (m.rawCodeType !== null && data.codeTypeCode === null)
          nulledCodeType++;
        if (
          typeof data.driverId === "number" &&
          !driverExists.has(data.driverId)
        ) {
          data.driverId = null;
          nulledDriver++;
        }

        const existing = before.get(m.sifra);
        try {
          if (existing && sameCustomerContent(existing, data)) {
            unchanged++;
            continue;
          }
          // UPSERT, a ne create/update po pročitanom stanju: između čitanja i
          // upisa red može da nastane (drugi prolaz, ručni unos), pa `create`
          // ne sme da bude uslovljen keširanim „nema ga".
          await this.prisma.customer.upsert({
            where: { id: m.sifra },
            create: data,
            update: data,
          });
          if (existing) updated++;
          else inserted++;
        } catch (err) {
          skippedError++;
          const message = err instanceof Error ? err.message : String(err);
          if (errorExamples.length < 10)
            errorExamples.push(`Sifra=${m.sifra}: ${message.slice(0, 200)}`);
          this.logger.warn(`Komitent Sifra=${m.sifra} nije upisan: ${message}`);
        }
      }

      if (batches > 10_000) {
        notes.push("prekinuto na 10.000 serija — proveri izvor");
        break;
      }
    }

    const skipped = skippedNative + skippedError;
    const filtered = filteredNoKey + filteredDupe;

    notes.push(
      `${KOMITENTI_FIELDS_NOT_IN_MDB.size} kolona koje .mdb izvoz NE donosi nije dirano ` +
        `(${[...KOMITENTI_FIELDS_NOT_IN_MDB].slice(0, 4).join(", ")}…) — ` +
        "postojeće vrednosti u 4.0 ostaju netaknute",
    );
    if (staged === 0)
      notes.push(
        "⚠️ u ovom drop-u NEMA nijednog komitenta — proveri manifest u " +
          "scripts/bigbit-mdb-export.sh i stage_error za tabelu `Komitenti`",
      );
    if (skippedNative > 0)
      notes.push(
        `⚠️ ${skippedNative} BigBit red(ova) PRESKOČENO — šifra pripada 4.0-native komitentu ` +
          `(rezervisan opseg ≥ ${NATIVE_ID_BASE} ili marker source='${NATIVE_SOURCE_MARKER}'). ` +
          `Native red NIJE prepisan; proveri šifre u BigBitu: ${nativeExamples.join(", ")}` +
          (skippedNative > nativeExamples.length ? ", …" : ""),
      );
    if (skippedError > 0)
      notes.push(
        `⚠️ ${skippedError} red(ova) NIJE upisano: ${errorExamples.join(" | ")}`,
      );
    if (filteredNoKey > 0)
      notes.push(
        `${filteredNoKey} red(ova) ODBAČENO — Sifra nije broj ili je 0; ti komitenti NISU u 4.0`,
      );
    if (filteredDupe > 0)
      notes.push(
        `${filteredDupe} red(ova) ODBAČENO — duplikat Sifre u istom drop-u ` +
          "(Sifra je IDENTITY u BigBitu, pa je ovo znak pokvarenog izvoza)",
      );
    if (nulledSalesperson > 0)
      notes.push(
        `${nulledSalesperson} red(ova): „Sifra prodavca" nema par u salespeople → NULL (red je ušao)`,
      );
    if (nulledCodeType > 0)
      notes.push(
        `${nulledCodeType} red(ova): „Vrsta sifre" nema par u code_types → NULL (red je ušao)`,
      );
    if (nulledDriver > 0)
      notes.push(
        `${nulledDriver} red(ova): „IDVozac" još ne postoji u customers → NULL ` +
          "(tvrd FK fk_customers_driver); veza se sama uspostavi u sledećem prolazu",
      );
    notes.push(
      `„IDUplatniRacun" ide kakav je — customers.payment_account_id NEMA FK (meka referenca); ` +
        "PIB: prazan je LEGITIMAN (ino kupci ga ne moraju imati), tax_id je NOT NULL pa prazno " +
        "ulazi kao '' — nikakva provera koje BigBit nema se NE uvodi",
    );

    const step: MdbStepResult = {
      entity: "customers",
      staged,
      inserted,
      updated,
      unchanged,
      skipped,
      filtered,
      // Brana zaključanih ne postoji za matične podatke: komitent ne pripada
      // knjigovodstvenom periodu, pa nema šta da bude „u zaključanom nalogu".
      blockedLocked: 0,
      durationMs: Date.now() - t0,
      notes,
    };
    // BROJAČI MORAJU DA SE ZBRAJAJU (isto načelo kao `toStep`): red koga izvor
    // ima, a 4.0 nema, ne sme da ispadne iz svih brojača i time da izgleda kao
    // „nepromenjen". Ako se ikad ne zbroje, to je kvar OVOG koraka i kaže se.
    const sum = inserted + updated + unchanged + skipped + filtered;
    if (sum !== staged)
      step.notes.push(
        `⚠️ brojači se ne zbrajaju: staged ${staged} ≠ ${sum} ` +
          "(novi+izmenjeni+nepromenjeni+preskočeni+odbačeni) — neki red je ispao iz svih " +
          "brojača; kvar je u ovom koraku, ne u izvoru",
      );
    return step;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// KOMITENTI: TIPIZACIJA STAGING TEKSTA + IZUZETE KOLONE
// ═════════════════════════════════════════════════════════════════════════════
// Stoji ISPOD klase namerno (a ne uz `GK_BATCH` na vrhu) da bi ceo dodatak za
// komitente bio jedan blok koji se čita — i menja — na jednom mestu.

/** Serija za komitente: 500 × ~40 kolona po prolazu. */
const CUSTOMERS_BATCH = 500;

/**
 * POLJA KOJA MAPPER PUNI, A BIGBIT `.mdb` IZVOZ IH NE DONOSI — i zato se NIKAD
 * ne upisuju iz ovog kanala.
 *
 * BigBitova `Komitenti` ima 57 kolona (DDL: `_legacy/_analiza/bigbit/BB_T_26_schema.sql`
 * red 2426–2485; popis i mapiranje: docs/migration/BIGBIT_KOMITENTI.md §1), a
 * manifest izvoza (`scripts/bigbit-mdb-export.sh`) danas prenosi PRVIH 40 —
 * staje na `PotpisKom`. Staging model `BbMdbStageKomitent` je deklarisan po tom
 * manifestu, pa 17 poslednjih kolona u bazi 4.0 uopšte ne stiže.
 *
 * ⚠️ ZAŠTO JE OVO BRANA, A NE FUSNOTA: mapper za kolonu koje u redu nema vraća
 * `null` (`str`/`num`/`bool` gledaju `undefined`). Slep upsert bi svake noći
 * upisao te nule i time OBRISAO `MaticniBroj`, `JBKJS`, `GLN`, `CRF`,
 * `KreditLimit`… — dakle podatke od kojih zavise SEF, e-faktura i kontrola duga.
 * Bez greške i bez traga u logu, tačno onaj tihi gubitak zbog koga postoji i
 * `NATIVE_COLUMN_TABLES` u `table-ownership.ts`.
 *
 * KAD MANIFEST DOBIJE TE KOLONE (i schema.prisma + migracija uz njega): izbaci
 * odgovarajuće polje odavde i dopuni projekciju u `komitentPayload`. Broj članova
 * pinuje spec, pa promena mora biti namerna.
 *
 * `KoristiPNBZadModel` (57. kolona) nije u ovom setu jer ga ni mapper ne čita —
 * `Customer.usesPaymentReferenceModel` ostaje na default-u sve dok se ne mapira.
 */
export const KOMITENTI_FIELDS_NOT_IN_MDB: ReadonlySet<string> = new Set([
  "shortName", // SkraceniNaziv
  "recordCreatedAt", // DatumIVremeKom
  "checkDebt", // ProveraDuga
  "creditLimit", // KreditLimit
  "skipTaxIdValidation", // NeProveravajPIB
  "pantheonId", // IDPantheon
  "newsletter", // NewsLetter
  "mailToDifferentAddress", // PostaNaDruguAdresu
  "gln", // GLN
  "manualMarkupPercent", // KLRucProc
  "balanceNote", // NapomenaZaSalda
  "hideInOverview", // NePrikazatiUPregledu
  "publicSectorId", // JBKJS
  "registrationNumber", // MaticniBroj
  "einvoiceXmlPerItemDiscount", // ER_XMLSaPopustomPoArtiklu
  "centralInvoiceRegistry", // CRF
]);

/**
 * Staging tekst -> broj. Nečitljiva vrednost daje `null` (veza/količina se
 * NULIRA), nikad `NaN` — `NaN` bi oborio ceo red na upisu.
 */
const stageNum = (v: string | null): number | null => {
  const s = stageText(v);
  if (s === null) return null;
  const x = Number(s.includes(".") ? s : s.replace(",", "."));
  return Number.isFinite(x) ? x : null;
};

/**
 * Staging tekst -> boolean. ⚠️ OVO JE OBAVEZNO: Access `Boolean` kroz
 * `mdb-export` izlazi kao TEKST `'0'`/`'1'`, a mapper radi `Boolean(v)` —
 * `Boolean('0')` je `true`, pa bi svaki komitent dobio uključene zastavice
 * (npr. „fakturisanje po mestima isporuke").
 */
const stageBool = (v: string | null): boolean | null => {
  const s = stageText(v)?.toLowerCase();
  if (s === null || s === undefined) return null;
  if (s === "1" || s === "-1" || s === "true" || s === "yes" || s === "da")
    return true;
  if (s === "0" || s === "false" || s === "no" || s === "ne") return false;
  return null;
};

/**
 * Staging tekst -> ISO instant sa `Z`.
 *
 * Korak 1 poziva `mdb-export -T '%Y-%m-%d %H:%M:%S' -D '%Y-%m-%d'`, dakle datum
 * BEZ zone. Tekst se tumači kao UTC — ISTA konvencija kao `::timestamp AT TIME
 * ZONE 'UTC'` u knjigovodstvenim koracima, pa se zapisani zid-sat ne pomera.
 * Da se prosledi sirov tekst, `new Date('2026-07-26 08:47:00')` bi ga pročitao
 * kao LOKALNO vreme i upisao 2 h pomereno u `Timestamp(6)` bez zone.
 * Neprepoznat format daje `null` (kolona ostaje prazna) — nikad `Invalid Date`,
 * koji obara upis celog reda.
 */
const stageDateIso = (v: string | null): string | null => {
  const s = stageText(v);
  if (s === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    s,
  );
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}.000Z`;
};

/**
 * Staging red -> `customers` upis, kroz POSTOJEĆI mapper.
 *
 * Ključevi objekta su BIGBIT imena kolona jer mapper čita njih (`Sifra`,
 * `Ziro racun_1`, `Sifra prodavca`…) — MSSQL tabela je bila preslikana kopija
 * ISTE Access tabele. Ovde se dešava samo tipizacija (tekst -> broj/boolean/ISO
 * datum) i izbacivanje kolona kojih u izvoru nema.
 */
function komitentPayload(
  row: BbMdbStageKomitent,
  salespersonIds: Set<number>,
  codeTypeCodes: Set<string>,
): Prisma.CustomerUncheckedCreateInput {
  const bb: Record<string, unknown> = {
    Sifra: Number((row.sifra ?? "").trim()),
    // `customers.name` je NOT NULL; mapper radi `String(r['Naziv'])`, pa bi
    // `null` upisao literal 'null'. Prazan naziv ulazi kao '' — red se NE
    // odbacuje (BigBit ga ima, znači postoji).
    Naziv: stageText(row.naziv) ?? "",
    Poslovnica: stageText(row.poslovnica),
    Mesto: stageText(row.mesto),
    Adresa: stageText(row.adresa),
    "Postanski broj": stageText(row.postanskiBroj),
    "Ziro racun_1": stageText(row.ziroRacun1),
    "Ziro racun_2": stageText(row.ziroRacun2),
    "Ziro racun_3": stageText(row.ziroRacun3),
    Telefon: stageText(row.telefon),
    Fax: stageText(row.fax),
    Kontakt: stageText(row.kontakt),
    Napomena: stageText(row.napomena),
    Drzava: stageText(row.drzava),
    Region: stageNum(row.region),
    "Vrsta sifre": stageText(row.vrstaSifre),
    Email: stageText(row.email),
    Mobilni: stageText(row.mobilni),
    "Datum rodjenja": stageDateIso(row.datumRodjenja),
    "Web adresa": stageText(row.webAdresa),
    "Sifra prodavca": stageNum(row.sifraProdavca),
    RabatKomitenta: stageNum(row.rabatKomitenta),
    ZastKodKupca: stageText(row.zastKodKupca),
    // PIB: PRAZAN JE LEGITIMAN (ino kupci ga ne moraju imati; u BigBitu je
    // kolona NULL-abilna, a validacija je u VBA formi, ne u bazi). `tax_id` je
    // NOT NULL, pa prazno ide kao ''. Nikakva NOVA provera se ne uvodi.
    PIB: stageText(row.pib) ?? "",
    PDVStatus: stageNum(row.pdvStatus),
    MSifra: stageText(row.msifra),
    Odlozeno: stageNum(row.odlozeno),
    IDRuta: stageNum(row.idRuta),
    IDVozac: stageNum(row.idVozac),
    IDUplatniRacun: stageNum(row.idUplatniRacun),
    FakturisanjePoMestimaIsporuke: stageBool(row.fakturisanjePoMestimaIsporuke),
    Cenovnik: stageText(row.cenovnik),
    PrviUnos: stageDateIso(row.prviUnos),
    PoslednjaIzmena: stageDateIso(row.poslednjaIzmena),
    PrviUnosUser: stageText(row.prviUnosUser),
    PoslednjaIzmenaUser: stageText(row.poslednjaIzmenaUser),
    ProcenatProvizije: stageNum(row.procenatProvizije),
    FiktRabatKomitenta: stageNum(row.fiktRabatKomitenta),
    KomitentiNacinPlacanja: stageText(row.komitentiNacinPlacanja),
    PotpisKom: stageText(row.potpisKom),
  };

  const data = mapKomitentiRow(bb, salespersonIds, codeTypeCodes);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data))
    if (!KOMITENTI_FIELDS_NOT_IN_MDB.has(key)) out[key] = value;
  return out as Prisma.CustomerUncheckedCreateInput;
}

/**
 * Da li postojeći `customers` red već nosi TAČNO ovaj sadržaj.
 *
 * Poredi se SAMO ono što upis nosi — kolone koje izvor ne šalje (v.
 * `KOMITENTI_FIELDS_NOT_IN_MDB`), `source`, `bb_sifra` i
 * `uses_payment_reference_model` nisu u upisu i ne ulaze u poređenje.
 */
function sameCustomerContent(
  before: Record<string, unknown>,
  data: Prisma.CustomerUncheckedCreateInput,
): boolean {
  const norm = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Prisma.Decimal) return v.toString();
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
      return String(v);
    return JSON.stringify(v) ?? null;
  };
  for (const [key, value] of Object.entries(data)) {
    if (key === "id") continue;
    if (norm(before[key]) !== norm(value)) return false;
  }
  return true;
}
