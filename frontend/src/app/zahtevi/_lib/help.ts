import type { HelpRegistry } from '@/components/ui-kit/help-mode';
import type { HelpTourStep } from '@/components/ui-kit/help-tour';

/**
 * Registar tekstova pomoći (info režim) za modul Zahtevi — pilot za PLAN_INFO_VODIC.
 * Tekstovi su srpski (latinica), iz ugla korisnika (šta radi i ZAŠTO), konkretni i
 * usklađeni sa MODULE_SPEC_zahtevi (§1.2 statusi, §4 AI, §5 prilozi, §12 nagrade).
 * Ključevi su `<modul>.<ekran>.<element>` i poklapaju se sa HelpSpot id-jevima.
 */
export const HELP: HelpRegistry = {
  /* ─────────────────────────────────────────────── /zahtevi/novi (podnosilac) */
  'zahtevi.novi.naslov': {
    title: 'Naslov',
    text: 'Kratko i jasno napišite šta ne radi ili šta treba dodati — npr. „Ne mogu da odštampam nalepnicu iz Lokacija". Dok kucate, sistem odmah proverava postojeće zahteve da se isto ne prijavi dvaput.',
  },
  'zahtevi.novi.opis': {
    title: 'Opis',
    text: 'Detaljno opišite problem ili ideju. Ne morate da kucate: dugme 🎤 diktira govor u tekst, a ✨ doteruje ono što ste napisali. Diktat i doterivanje rade samo dok je zahtev nacrt (pre podnošenja).',
  },
  'zahtevi.novi.slicni': {
    title: 'Ovo možda već postoji',
    text: 'Zahtevi koji liče na vaš. Otvorite ih pre podnošenja — ako je isto već prijavljeno, dodajte komentar tamo umesto novog zahteva. Duplikat AI ocenjuje nulom, a nagradu nosi onaj ko je prvi prijavio.',
  },
  'zahtevi.novi.tip': {
    title: 'Tip',
    text: 'Da li je u pitanju greška (bag), dorada postojeće funkcije ili potpuno nova funkcija. Ako ne izaberete, AI će sam predložiti tip pri obradi — administrator to uvek može da ispravi.',
  },
  'zahtevi.novi.modul': {
    title: 'Modul',
    text: 'Deo aplikacije na koji se zahtev odnosi (npr. Nabavka, Održavanje). Pomaže da zahtev brže stigne pravom čoveku. Nije obavezno — AI predlaže ako izostavite.',
  },
  'zahtevi.novi.prioritet': {
    title: 'Prioritet (vaše mišljenje)',
    text: 'Koliko je za vas hitno. Ovo je samo vaš predlog — konačan prioritet određuje administrator posle procene.',
  },
  'zahtevi.novi.ponasanje': {
    title: 'Očekivano i trenutno ponašanje',
    text: 'Za greške: ukratko šta bi trebalo da se desi i šta se umesto toga sada dešava. Ova dva polja pomažu da se problem brzo razume i ponovi.',
  },
  'zahtevi.novi.prilozi': {
    title: 'Prilozi',
    text: 'Slikajte ekran (na telefonu se otvara kamera) ili priložite fajl — slike i PDF, do 10 priloga. Slika greške vredi više od hiljadu reči i ubrzava rešavanje.',
  },
  'zahtevi.novi.glas': {
    title: 'Glasovna poruka',
    text: 'Ako vam je lakše da ispričate nego da kucate, snimite poruku. Snimak se čuva trajno uz zahtev, a sistem sam ispiše i tekst snimka (transkript).',
  },
  'zahtevi.novi.akcije': {
    title: 'Sačuvaj nacrt ili Podnesi',
    text: '„Sačuvaj nacrt" ostavlja zahtev da ga kasnije dopunite — niko ga još ne vidi. „Podnesi" ga šalje na obradu: AI odmah klasifikuje zahtev, proveri da li slično već postoji i predloži ocenu 0–5. Ocena nosi novčanu nagradu po tarifi (1★=500 … 5★=3.000 RSD), a ocenu 0 (npr. duplikat) sistem sam odbija. Posle podnošenja ide trijaža → odluka administratora → realizacija; status pratite na svom zahtevu.',
  },

  /* ─────────────────────────────────────────── /zahtevi (lista — moji zahtevi) */
  'zahtevi.lista.nagrade': {
    title: 'Moje nagrade ovog meseca',
    text: 'Zbir potvrđenih nagrada za vaše prihvaćene zahteve u tekućem mesecu. Iznos je predlog dok ga administrator ne potvrdi; konačan obračun i isplatu radi administrator na kraju meseca.',
  },
  'zahtevi.lista.kolone': {
    title: 'Vaši zahtevi',
    text: 'Svi vaši zahtevi. „Status" pokazuje dokle je stigla obrada, „Ocena ★" je ocena 0–5 (žuta zvezda = administrator potvrdio, siva = AI predlog), a „Iznos" je nagrada kad bude potvrđena. Kliknite red za detalje.',
  },

  /* ─────────────────────────────────────────────────── /zahtevi (lista — admin) */
  'zahtevi.admin.tabovi': {
    title: 'Prikaz zahteva',
    text: '„Inbox" = zahtevi koji čekaju vašu akciju (broj u zagradi). „Svi zahtevi" = pretraga i filteri. „Nagrade" = mesečni obračun i tarifa. „Odluke" = Decision Log. „Arhiva" = zatvoreni zahtevi.',
  },
  'zahtevi.admin.inbox.kpi': {
    title: 'Šta čeka vas',
    text: 'Brojači po fazama: „Podneti" čekaju prvi pregled, „AI obrađen" čeka vašu odluku o realizaciji, „Na testiranju" čeka potvrdu. Kliknite pločicu da filtrirate listu na tu fazu.',
  },
  'zahtevi.admin.tabela': {
    title: 'Lista zahteva',
    text: 'Kolona „Podnosilac" pokazuje ko je poslao zahtev (vi vidite tuđe, korisnici samo svoje). Kliknite red da otvorite zahtev sa AI analizom i akcijama.',
  },
  'zahtevi.admin.nagrade.zakljuci': {
    title: 'Mesečni obračun',
    text: 'Izaberite mesec i vidite ko je koliko zaradio (potvrđene nagrade). „Zaključi mesec" prebacuje sve potvrđene nagrade u „Isplaćeno" — postaju nepromenjive i služe kao spisak za ručnu isplatu. Nove potvrde posle toga idu u naredni mesec.',
  },
  'zahtevi.admin.nagrade.tarifa': {
    title: 'Tarifa nagrada',
    text: 'Iznos u dinarima po oceni 1–5. Izmena kreira nov red koji važi od danas — raniji, već potvrđeni obračuni ostaju po staroj tarifi.',
  },

  /* ─────────────────────────────────────────────────────────── /zahtevi/detalj */
  'zahtevi.detalj.status': {
    title: 'Status zahteva',
    text: 'Trenutna faza: Podnet → (Odobrena AI analiza → AI obrađen) → Odobren → Planiran → U realizaciji → Spreman za test → Na testiranju → Završen. „Vraćen na dopunu" znači da čekamo vaš odgovor; „Odbijen" nosi obrazloženje; „Spojen" znači pripojen postojećem zahtevu.',
  },
  'zahtevi.detalj.tabovi': {
    title: 'Sekcije zahteva',
    text: '„Zahtev" = originalni opis i prilozi (posle podnošenja se ne menjaju; možete samo da dodate nov prilog). „AI analiza" = trijaža, procena i predlozi. „Pitanja" = prepiska sa administratorom (tu dopunjujete kad je vraćeno na dopunu). „Istorija" = svi događaji i podaci o realizaciji.',
  },
  'zahtevi.detalj.dopuna': {
    title: 'Vraćen na dopunu',
    text: 'Administrator je zahtev vratio da biste dopunili nešto. U okviru piše šta se traži (pitanja). Kliknite „Odgovori" — otvara se tab „Pitanja" gde upišete odgovor (a možete i dodati prilog u tabu „Zahtev"). Kad završite, kliknite „Ponovo podnesi" da se zahtev vrati administratoru. Dok to ne uradite, obrada stoji.',
  },
  'zahtevi.detalj.owner.akcije': {
    title: 'Vaše akcije',
    text: 'Dok je nacrt možete da menjate sadržaj, podnesete ili obrišete. Podnet ili vraćen zahtev možete da povučete (arhivira se). Original opis se posle podnošenja ne menja — dopune (odgovore i nove priloge) šaljete kroz tabove „Pitanja" i „Zahtev". Kad je zahtev „Vraćen na dopunu", posle odgovora kliknite „Ponovo podnesi" da se vrati administratoru.',
  },
  'zahtevi.detalj.admin.ocena': {
    title: 'Nagrada i ocena',
    text: 'Ovde potvrđujete ili korigujete ocenu 0–5. Novac nastaje tek vašom potvrdom: u tom trenutku se pamti iznos iz važeće tarife. „Isključi" ostavlja zahtev validnim ali bez nagrade (npr. deo redovnog zadatka). Dok mesec nije zaključen, ocenu možete da menjate.',
  },
  'zahtevi.detalj.admin.odluka': {
    title: 'Odobrenja i odluke',
    text: 'Dva odvojena odobrenja: „Odobri AI analizu" pokreće detaljnu analizu, „Odobri realizaciju" šalje zahtev u izradu. Tu su i „Vrati na dopunu", „Odbij", „Spoji" (pripoji drugom zahtevu), „U backlog", „Vrati u obradu" (za AI-odbačene), kao i prelazi kroz realizaciju do „Završeno".',
  },
  'zahtevi.detalj.realizacija': {
    title: 'Podaci o realizaciji',
    text: 'Grana, pull request, commit, verzija isporuke i izvršilac — popunjavaju se pri prelascima kroz realizaciju i služe za praćenje šta je i kada isporučeno.',
  },
};

/**
 * Vođena tura — PODNOSILAC (svi): tok podnošenja novog zahteva na /zahtevi/novi.
 * Korak „slični" postoji samo kad ima poklapanja (inače se preskače).
 */
export const NOVI_TOUR: HelpTourStep[] = [
  { spotId: 'zahtevi.novi.naslov' },
  { spotId: 'zahtevi.novi.opis' },
  { spotId: 'zahtevi.novi.slicni' },
  { spotId: 'zahtevi.novi.prilozi' },
  { spotId: 'zahtevi.novi.glas' },
  {
    spotId: 'zahtevi.novi.akcije',
    title: 'Šta sledi posle podnošenja',
    text: 'Kad podnesete: AI klasifikuje zahtev, proveri duplikate i predloži ocenu 0–5 (nagrada po tarifi 1★=500 … 5★=3.000 RSD; 0 = automatsko odbijanje). Zatim ide trijaža → odluka administratora → realizacija, a status pratite na svom zahtevu.',
  },
];

/**
 * Vođena tura — ADMIN (vidljiva samo uz zahtevi.admin): inbox → detalj → nagrade.
 * Ista lista se pušta na listi i na detalju; koraci čiji cilj nije na tekućoj strani
 * (ili tabu) se preskaču — pa se tura prirodno „deli" po ekranu.
 */
export const ADMIN_TOUR: HelpTourStep[] = [
  { spotId: 'zahtevi.admin.tabovi' },
  { spotId: 'zahtevi.admin.inbox.kpi' },
  { spotId: 'zahtevi.admin.tabela' },
  { spotId: 'zahtevi.admin.nagrade.zakljuci' },
  { spotId: 'zahtevi.detalj.status' },
  { spotId: 'zahtevi.detalj.admin.ocena' },
  { spotId: 'zahtevi.detalj.admin.odluka' },
];
