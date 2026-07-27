import { newPdf, safeName, PAGE_W, PAGE_H, MARGIN, CONTENT_W } from './pdf-core';
import { toLatin as lat } from './cyrillic';

// Ugovor o radu (LATINICA, Roboto/UTF-8). Port 1.0 `src/lib/contractPdf.js`:
// 20 članova (+ opcioni probni rad), dinamička numeracija, određeno/neodređeno.
// Pravni boilerplate VERBATIM iz 1.0. Bez logo-zaglavlja (kreće od pravnog osnova).
//
// Pismo: od 27.07.2026. UGOVOR se štampa latinicom (odluka vlasnika) — ostala HR
// dokumenta (rešenja, potvrde, aneksi) ostaju ćirilica. Dinamički podaci prolaze
// kroz `lat()` jer deljeni helperi (stepenSpremeCyr / trajanjeCyr / formatRsd)
// zbog tih drugih dokumenata i dalje vraćaju ćirilicu.

const LINE_H = 5.0;
const FONT_PT = 10;
const BODY_TOP = MARGIN;
const BODY_BOTTOM = PAGE_H - MARGIN;

const MESTO_RADA = 'Dobanovcima';
const MESTO_POTPISA = 'Dobanovcima';
const PROBNI_MESEC_RECI = ['', 'jedan', 'dva', 'tri', 'četiri', 'pet', 'šest'];

function probniTrajanje(n: number | undefined): string {
  const m = Math.min(6, Math.max(1, parseInt(String(n), 10) || 6));
  const unit = m === 1 ? 'mesec' : m <= 4 ? 'meseca' : 'meseci';
  return `${m} (${PROBNI_MESEC_RECI[m]}) ${unit}`;
}

export interface ContractInput {
  imePrezime: string;
  jmbg: string;
  prebivaliste: string;
  stepenSS: string;
  zanimanje: string;
  radnoMesto: string;
  brutoZarada: string;
  datumPocetka: string;
  datumPotpisa: string;
  tip: 'odredjeno' | 'neodredjeno';
  trajanje?: string; // za određeno
  probniRad?: boolean;
  probniMeseci?: number;
  maloletnik?: boolean;
  nadredjeni?: string;
  potpisPoslodavac?: string;
}

/** Blok unutar člana — pasus ili numerisana lista (član o poslovnoj tajni ima obe). */
type ArticleBlock = { kind: 'para'; text: string } | { kind: 'list'; items: string[] };

interface Article { title?: string; paras?: string[]; blocks?: ArticleBlock[] }

function buildArticles(d: ContractInput): Article[] {
  const odredjeno = d.tip === 'odredjeno';
  const rm = lat(d.radnoMesto);

  const clan1 = odredjeno
    ? [
        `Zaposleni kod Poslodavca zasniva radni odnos na određeno vreme, sa početkom rada na dan ${d.datumPocetka} godine u trajanju od ${lat(d.trajanje || '')}, zbog povećanog obima posla.`,
        `Zaposleni je dužan da stupi na rad ${d.datumPocetka} godine.`,
      ]
    : [
        `Zaposleni kod Poslodavca zasniva radni odnos na neodređeno vreme, sa početkom rada na dan ${d.datumPocetka} godine.`,
        `Zaposleni je dužan da stupi na rad ${d.datumPocetka} godine.`,
      ];

  const clan5go = odredjeno
    ? 'Zaposleni ima pravo na korišćenje srazmernog dela godišnjeg odmora, odnosno za svaki mesec dana rada u kalendarskoj godini Zaposleni ima pravo na dvanaestinu (srazmerni deo) godišnjeg odmora, koji iznosi 20 radnih dana za period od jedne kalendarske godine.'
    : 'Zaposleni ima pravo na godišnji odmor u trajanju od 20 radnih dana za punu kalendarsku godinu, odnosno na srazmeran deo za nepotpunu godinu rada, u skladu sa Pravilnikom o radu.';

  const odgovaraLine = d.nadredjeni
    ? `Za svoj rad odgovara nadređenom po hijerarhiji, u skladu sa Pravilnikom o sistematizaciji radnih mesta: ${lat(d.nadredjeni)}.`
    : 'Za svoj rad odgovara nadređenom po hijerarhiji, u skladu sa Pravilnikom o sistematizaciji radnih mesta.';

  const probniParas = d.probniRad
    ? [
        `Ugovara se probni rad u trajanju od ${probniTrajanje(d.probniMeseci)}, počev od dana stupanja Zaposlenog na rad.`,
        'Za vreme trajanja probnog rada, svaka ugovorna strana može otkazati ovaj ugovor o radu sa otkaznim rokom koji ne može biti kraći od 5 (pet) radnih dana.',
        'Zaposlenom koji za vreme probnog rada nije pokazao odgovarajuće radne i stručne sposobnosti, prestaje radni odnos danom isteka roka određenog ovim ugovorom.',
      ]
    : null;

  const articles: Article[] = [
    { paras: clan1 },
    ...(probniParas ? [{ paras: probniParas }] : []),
    {
      paras: [
        `Zaposleni će raditi na radnom mestu ${rm}.`,
        'Zaposleni će obavljati poslove definisane za ovo radno mesto u Pravilniku o sistematizaciji radnih mesta i Pravilniku o radu Poslodavca. ' + odgovaraLine,
        'Zaposleni je saglasan da, u slučaju da se javi potreba da se određeni posao izvrši bez odlaganja, može biti premešten na druge odgovarajuće poslove.',
      ],
    },
    {
      paras: [
        `Zaposleni će obavljati poslove u ${MESTO_RADA}.`,
        'Zaposleni je saglasan da, kada to potrebe posla, odnosno procesa rada zahtevaju, privremeno obavlja poslove i na drugim mestima, uz nadoknadu odgovarajućih troškova.',
      ],
    },
    {
      paras: [
        d.maloletnik
          ? 'Radno vreme zaposlenog iznosi 7 časova dnevno, odnosno 35 časova nedeljno, s tim što zaposleni prihvata da Poslodavac može izvršiti preraspodelu radnog vremena, u skladu sa Zakonom i Pravilnikom o radu.'
          : 'Radno vreme zaposlenog iznosi 8 časova dnevno, odnosno 40 časova nedeljno, s tim što zaposleni prihvata da Poslodavac može izvršiti preraspodelu radnog vremena, u skladu sa Zakonom i Pravilnikom o radu.',
        'Poslodavac može, u skladu sa Zakonom i Pravilnikom o radu, od Zaposlenog zahtevati prekovremeni rad, kao i rad na dane vikenda, praznika i državnih praznika, kada to potrebe posla zahtevaju.',
      ],
    },
    {
      paras: [
        'Zaposleni ima pravo na odmor u toku dnevnog rada, kao i pravo na dnevni odmor i nedeljni odmor u skladu sa odredbama članova 23–26 Pravilnika o radu.',
        clan5go,
        'Za korišćenje godišnjeg odmora, Zaposleni treba da obavesti Poslodavca mesec dana unapred i da dobije pismenu saglasnost i dozvolu od Poslodavca. Poslodavac dostavlja Zaposlenom Rešenje o godišnjem odmoru najkasnije 15 dana pre početka planiranog godišnjeg odmora, osim u slučaju kada se godišnji odmor koristi na zahtev Zaposlenog, kada mu se Rešenje može dostaviti i neposredno pre korišćenja godišnjeg odmora.',
        'Zaposleni ima pravo na plaćeno i neplaćeno odsustvo, u slučajevima i na način propisan članovima 35 i 36 Pravilnika o radu i Zakonom.',
      ],
    },
    {
      paras: [
        `Za poslove za koje je zaključen ovaj Ugovor, osnovna zarada zaposlenom se utvrđuje u bruto novčanom iznosu od ${lat(d.brutoZarada)} na dan zaključenja ovog Ugovora.`,
        'Bruto iznos zarade podrazumeva zaradu, uključujući porez na zaradu i poreze i doprinose koje Poslodavac plaća na zaradu u ime Zaposlenog.',
        'Osnovna zarada Zaposlenog utvrđuje se na osnovu elemenata iz odredbe člana 42, 43 i 47 Pravilnika o radu. Osnovna zarada se može uvećati do 20% ili umanjiti do 30%, s tim što ne može biti niža od minimalne zarade, zavisno od ostvarenog radnog učinka zaposlenog, koji podrazumeva kvalitet i količinu obavljenog posla, kao i stav Zaposlenog prema radnim obavezama.',
        'Zaposleni ima pravo na uvećanu zaradu po osnovu doprinosa Zaposlenog poslovnom uspehu Poslodavca (nagrade, bonusi i sl.), u skladu sa Odlukom poslodavca za svaku pojedinačnu godinu, kao i u slučajevima iz člana 47 Pravilnika o radu.',
        'Ukoliko zbog poremećaja u poslovanju / nepovoljnog poslovanja, Poslodavac bude onemogućen da Zaposlenom isplaćuje zaradu u skladu sa Ugovorom, Poslodavac će uvesti isplaćivanje minimalne zarade. Zarada će se isplaćivati Zaposlenom do kraja meseca za prethodni mesec.',
      ],
    },
    {
      paras: [
        'Zaposleni ima pravo na naknadu zarade u iznosu svoje prosečne zarade u prethodnih 12 meseci, za vreme odsustvovanja sa rada na dan praznika koji je neradan dan, godišnjeg odmora, plaćenog odsustva, vojne vežbe i odazivanja na poziv državnog organa.',
        'Zaposleni ima pravo na naknadu zarade u toku odsustva sa rada usled privremene nesposobnosti za rad do 30 dana, kako sledi:',
        '1) najmanje u visini 65% prosečne zarade u prethodnih 12 meseci pre meseca u kojem je nastupila privremena sprečenost za rad, s tim da ne može biti niža od minimalne zarade utvrđene u skladu sa Zakonom, ako je sprečenost za rad prouzrokovana bolešću ili povredom van rada, ako Zakonom nije drukčije određeno;',
        '2) u visini 100% prosečne zarade u prethodnih 12 meseci pre meseca u kojem je nastupila privremena sprečenost za rad, s tim da ne može biti niža od minimalne zarade utvrđene u skladu sa Zakonom, ako je sprečenost za rad prouzrokovana povredom na radu ili profesionalnom bolešću, ako Zakonom nije drukčije određeno.',
        'Zaposleni ima pravo na naknadu zarade najmanje u visini 60% prosečne zarade Zaposlenog u prethodnih 12 meseci, s tim da ne može biti manja od minimalne zarade utvrđene u skladu sa ovim zakonom, za vreme prekida rada, odnosno smanjenja obima rada do kojeg je došlo bez krivice zaposlenog, najduže 45 radnih dana u kalendarskoj godini.',
        'Zaposleni ima pravo na naknadu zarade u visini od 100% prosečne zarade Zaposlenog u prethodnih 12 meseci, za vreme prekida rada do koga je došlo naredbom nadležnog državnog organa ili nadležnog organa poslodavca zbog neobezbeđivanja bezbednosti i zaštite života i zdravlja na radu, koja je uslov daljeg obavljanja rada bez ugrožavanja života i zdravlja zaposlenih i drugih lica, i u drugim slučajevima, u skladu sa zakonom.',
      ],
    },
    {
      paras: [
        'Zaposleni ima pravo na naknadu troškova, kako sledi:',
        '– za dolazak i odlazak sa rada u visini cene prevozne karte u javnom saobraćaju;',
        '– za vreme provedeno na službenom putu u zemlji;',
        '– za vreme provedeno na službenom putu u inostranstvu;',
        '– smeštaja i ishrane za rad i boravak na terenu, ako poslodavac nije zaposlenom obezbedio smeštaj i ishranu bez naknade;',
        '– za ishranu u toku rada;',
        '– za regres za korišćenje godišnjeg odmora.',
        'Troškovi iz prethodnog stava ovog člana, isplaćuje se u visini i na način utvrđen u Pravilniku o radu.',
      ],
    },
    {
      paras: [
        'Zaposleni se obavezuje da za vreme trajanja radnog odnosa na teritoriji Srbije ne može da obavlja poslove koji bi predstavljali konkurenciju Poslodavcu, delimično ili u celosti, u poslovnim oblastima Poslodavca, u svoje ime i za svoj račun, kao i u ime i za račun drugog pravnog ili fizičkog lica bez saglasnosti Poslodavca.',
      ],
    },
    {
      paras: [
        'Zaposleni je dužan da Poslodavcu naknadi štetu koju je prouzrokovao na radu ili u vezi sa radom namerno, odnosno iz krajnje nepažnje.',
        'Poslodavac je dužan da zaposlenom naknadi štetu u slučaju povrede na radu ili u vezi sa radom, u skladu sa Zakonom.',
      ],
    },
    {
      paras: [
        'Zaposleni je, u slučaju otkaza Ugovora o radu, dužan da Poslodavcu u pismenoj formi dostavi otkaz ugovora o radu 30 dana pre dana koji je naveo kao dan prestanka radnog odnosa.',
      ],
    },
    {
      paras: [
        'Poslodavac može Zaposlenom da otkaže ugovor o radu ako za to postoji opravdani razlog koji se odnosi na radnu sposobnost zaposlenog i njegovo ponašanje i to:',
        '1) ako ne ostvaruje rezultate rada ili nema potrebna znanja i sposobnosti za obavljanje poslova na kojima radi;',
        '2) ako je pravnosnažno osuđen za krivično delo na radu ili u vezi sa radom;',
        '3) ako se ne vrati na rad kod poslodavca u roku od 15 dana od dana isteka roka mirovanja radnog odnosa iz člana 79. Zakona o radu, odnosno neplaćenog odsustva iz člana 100. Zakona o radu.',
        'Poslodavac može da otkaže ugovor o radu Zaposlenom koji svojom krivicom učini povredu radne obaveze, i to:',
        '1) ako nesavesno ili nemarno izvršava radne obaveze;',
        '2) ako zloupotrebi položaj ili prekorači ovlašćenja;',
        '3) ako necelishodno i neodgovorno koristi sredstva rada;',
        '4) ako ne koristi ili nenamenski koristi obezbeđena sredstva ili opremu za ličnu zaštitu na radu;',
        '5) ako učini drugu povredu radne obaveze utvrđenu Pravilnikom o radu.',
        'Poslodavac može da otkaže ugovor o radu Zaposlenom koji ne poštuje radnu disciplinu, i to:',
        '1) ako neopravdano odbije da obavlja poslove i izvršava naloge poslodavca u skladu sa zakonom;',
        '2) ako ne dostavi potvrdu o privremenoj sprečenosti za rad u smislu člana 103. ovog zakona;',
        '3) ako zloupotrebi pravo na odsustvo zbog privremene sprečenosti za rad;',
        '4) zbog dolaska na rad pod dejstvom alkohola ili drugih opojnih sredstava, odnosno upotrebe alkohola ili drugih opojnih sredstava u toku radnog vremena, koje ima ili može da ima uticaj na obavljanje posla;',
        '5) ako njegovo ponašanje predstavlja radnju izvršenja krivičnog dela učinjenog na radu i u vezi sa radom, nezavisno od toga da li je protiv zaposlenog pokrenut krivični postupak za krivično delo;',
        '6) ako je dao netačne podatke koji su bili odlučujući za zasnivanje radnog odnosa;',
        '7) ako zaposleni koji radi na poslovima sa povećanim rizikom, na kojima je kao poseban uslov za rad utvrđena posebna zdravstvena sposobnost, odbije da bude podvrgnut oceni zdravstvene sposobnosti;',
        '8) ako ne poštuje radnu disciplinu propisanu Pravilnikom o radu, odnosno ako je njegovo ponašanje takvo da ne može da nastavi rad kod poslodavca.',
        'Zaposlenom može da prestane radni odnos ako za to postoji opravdan razlog koji se odnosi na potrebe Poslodavca i to:',
        '1) ako usled tehnoloških, ekonomskih ili organizacionih promena prestane potreba za obavljanjem određenog posla ili dođe do smanjenja obima posla;',
        '2) ako odbije zaključenje aneksa ugovora u smislu odredbi člana 171. stav 1. tač. 1-5) Zakona o radu.',
        'U slučaju otkaza ugovora o radu zbog neostvarivanja potrebnih rezultata rada, odnosno nesposobnosti zaposlenog, zaposleni je dužan da ostane na radu 30 dana, počev od narednog dana od dana dostavljanja rešenja o otkazu ugovora o radu.',
      ],
    },
    {
      // Poslovna tajna i poverljivi podaci — nov tekst (odluka vlasnika 27.07.2026,
      // zamenio raniji član sa listom od 12 stavki i „celokupnom štetom").
      blocks: [
        { kind: 'para', text: 'Zaposleni je dužan da za vreme trajanja radnog odnosa, kao i nakon njegovog prestanka, čuva poslovnu tajnu i poverljive podatke Poslodavca i njegovih naručilaca, poslovnih partnera, kupaca i dobavljača, do kojih je došao tokom rada ili u vezi sa radom.' },
        { kind: 'para', text: 'Poslovnom tajnom i poverljivim podacima naročito se smatraju:' },
        {
          kind: 'list',
          items: [
            'tehnička, tehnološka, projektna i proizvodna dokumentacija;',
            'projekti, nacrti, skice, proračuni, 2D i 3D modeli, radionička dokumentacija, hidraulične, pneumatske i električne šeme;',
            'programi, izvorni kodovi, parametri, softverska rešenja, tehničke specifikacije i uputstva;',
            'tehnološki postupci, proizvodne metode, konstruktivna rešenja, uzorci, modeli, prototipovi, pronalasci i know-how;',
            'specifikacije materijala, spiskovi delova, podaci o nabavci, dobavljačima, cenama, ponudama i kalkulacijama;',
            'podaci o kupcima, naručiocima, ugovorima, uslovima poslovanja, rokovima, planovima i dinamici realizacije projekata;',
            'podaci o finansijskom poslovanju, potraživanjima, obavezama, zaradama, poslovnim planovima i strategiji Poslodavca;',
            'svi drugi podaci koji nisu javno dostupni, imaju poslovnu vrednost i čije bi neovlašćeno otkrivanje, korišćenje, umnožavanje ili dostavljanje trećem licu moglo da nanese štetu Poslodavcu ili njegovim poslovnim partnerima.',
          ],
        },
        { kind: 'para', text: 'Zaposleni ne sme, bez prethodne pisane saglasnosti Poslodavca, podatke i dokumentaciju iz prethodnog stava:' },
        {
          kind: 'list',
          items: [
            'kopirati, fotografisati, umnožavati ili iznositi iz poslovnih prostorija ili informacionih sistema Poslodavca;',
            'slati na privatne adrese elektronske pošte, privatne naloge, uređaje, internet-servise ili druga mesta koja Poslodavac nije odobrio;',
            'saopštavati, predavati, ustupati, objavljivati ili na drugi način činiti dostupnim neovlašćenim licima;',
            'koristiti za sopstvene potrebe, za potrebe drugog poslodavca ili trećeg lica;',
            'koristiti u druge svrhe osim radi izvršavanja radnih obaveza kod Poslodavca.',
          ],
        },
        { kind: 'para', text: 'Zaposleni je dužan da bez odlaganja obavesti Poslodavca o svakom gubitku, neovlašćenom pristupu, dostavljanju, kopiranju ili drugoj zloupotrebi poslovne dokumentacije i poverljivih podataka za koju sazna.' },
        { kind: 'para', text: 'Po prestanku radnog odnosa ili na zahtev Poslodavca, Zaposleni je dužan da odmah vrati svu dokumentaciju, opremu, nosače podataka, kopije, beleške, pristupne podatke i drugi materijal koji pripada Poslodavcu, kao i da izbriše poverljive podatke sa privatnih uređaja i naloga, ukoliko su se na njima našli uz odobrenje Poslodavca.' },
        { kind: 'para', text: 'Obaveza čuvanja poslovne tajne traje i nakon prestanka radnog odnosa, sve dok konkretni podaci imaju svojstvo poslovne tajne, odnosno dok na zakonit način ne postanu javno dostupni.' },
        { kind: 'para', text: 'Povreda obaveze čuvanja poslovne tajne i poverljivih podataka može predstavljati povredu radne obaveze i osnov za otkaz ugovora o radu, uz sprovođenje postupka i pod uslovima propisanim Zakonom o radu i opštim aktima Poslodavca.' },
        { kind: 'para', text: 'Zaposleni je odgovoran za štetu koju je na radu ili u vezi sa radom, namerno ili krajnjom nepažnjom, prouzrokovao Poslodavcu neovlašćenim pribavljanjem, korišćenjem, umnožavanjem, otkrivanjem ili činjenjem dostupnim poslovne tajne i poverljivih podataka.' },
        { kind: 'para', text: 'U slučaju takve povrede, Zaposleni je dužan da Poslodavcu naknadi stvarno nastalu i dokazanu štetu, uključujući običnu štetu, izmaklu korist, opravdane troškove utvrđivanja i otklanjanja posledica povrede, kao i iznose koje je Poslodavac po tom osnovu bio dužan da naknadi naručiocu, kupcu ili drugom trećem licu, ukoliko su ispunjeni zakonski uslovi za odgovornost Zaposlenog.' },
        { kind: 'para', text: 'Postojanje odgovornosti Zaposlenog, okolnosti pod kojima je šteta nastala, njena visina i način naknade utvrđuju se u skladu sa Zakonom o radu, opštim aktima Poslodavca i sporazumom ugovornih strana, a ukoliko sporazum nije postignut, pred nadležnim sudom.' },
        { kind: 'para', text: 'Prava na pronalascima, autorskim delima, programima, tehničkim rešenjima i drugim rezultatima intelektualnog rada koje Zaposleni stvori u izvršavanju svojih radnih obaveza, po nalogu Poslodavca ili pretežnim korišćenjem sredstava, dokumentacije i poverljivih podataka Poslodavca, uređuju se u skladu sa zakonom i drugim propisima kojima se uređuju prava intelektualne svojine.' },
      ],
    },
    { paras: ['Poslodavac je dužan da Zaposlenom organizuje rad na način koji obezbeđuje bezbednost i zdravlje na radu, u skladu sa Zakonom i drugim propisima.'] },
    { paras: ['Poslodavac je obavezan da redovno podnosi potrebne prijave za obavezno socijalno osiguranje i da na vreme plaća doprinose u skladu sa Zakonom.'] },
    { paras: ['Na sva prava, obaveze i odgovornosti Zaposlenog i Poslodavca koja nisu uređena ovim Ugovorom, primenjuju se odredbe Zakona.'] },
    { paras: ['Ovaj ugovor može da otkaže svaka od ugovornih strana, pod uslovima i u slučajevima utvrđenim Zakonom i Ugovorom.'] },
    {
      paras: [
        'Zaposleni je dužan da radne obaveze izvršava savesno i u predviđenim rokovima i da poštuje radnu disciplinu kod poslodavca.',
        'Zaposleni odgovara za povrede radnih obaveza i nepoštovanje radne discipline utvrđene Zakonom i Pravilnikom o radu i ovim Ugovorom.',
      ],
    },
    { paras: ['Na sva prava, obaveze i odgovornosti koje nisu uređene ovim ugovorom primenjuju se odgovarajuće odredbe Pravilnika o radu i Zakona.'] },
    { paras: ['Ovaj Ugovor sačinjen je u 3 (tri) istovetna primerka, od kojih 2 (dva) zadržava Poslodavac, a 1 (jedan) Zaposleni.'] },
  ];

  return articles.map((art, i) => ({ ...art, title: `Član ${i + 1}.` }));
}

export async function generateContractPdf(d: ContractInput): Promise<{ blob: Blob; fileName: string }> {
  const { doc } = await newPdf('portrait');
  let y = BODY_TOP;
  const ime = lat(d.imePrezime);

  const pageBreak = (need: number) => {
    if (y + need > BODY_BOTTOM) { doc.addPage(); y = BODY_TOP; }
  };
  const para = (text: string, opts: { bold?: boolean; align?: 'left' | 'center' | 'justify'; size?: number; gap?: number; indent?: number } = {}) => {
    const { bold = false, align = 'justify', size = FONT_PT, gap = 1.6, indent = 0 } = opts;
    doc.setFont('Roboto', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(20, 20, 20);
    const w = CONTENT_W - indent;
    const lines = doc.splitTextToSize(String(text), w) as string[];
    lines.forEach((line, i) => {
      pageBreak(LINE_H + 1);
      const isLast = i === lines.length - 1;
      if (align === 'center') doc.text(line, PAGE_W / 2, y, { align: 'center' });
      else if (align === 'justify' && !isLast && lines.length > 1) doc.text(line, MARGIN + indent, y, { align: 'justify', maxWidth: w });
      else doc.text(line, MARGIN + indent, y);
      y += LINE_H;
    });
    y += gap;
  };

  para('U skladu sa odredbama člana 30 Zakona o radu (Službeni glasnik RS br. 24/05, 61/05, 54/09, 32/13 i 75/14, 13/2017 – odluka US, 113/2017 i 95/2018 – autentično tumačenje), ugovorne strane, i to:');
  para('1. Društvo za projektovanje, proizvodnju, trgovinu i usluge „SERVOTEH" doo Dobanovci, ul. Ugrinovačka br. 163 (dalje: Poslodavac), i');
  para(`2. ${ime}, JMBG ${d.jmbg}, sa prebivalištem-boravištem na dan zaključenja ovog ugovora u ${lat(d.prebivaliste)}, sa ${lat(d.stepenSS)} stručne spreme, po zanimanju ${lat(d.zanimanje)} (dalje: Zaposleni),`);
  para('zaključuju sledeći:', { align: 'center', gap: 2 });
  para('UGOVOR O RADU', { bold: true, align: 'center', size: 13, gap: 3 });

  for (const art of buildArticles(d)) {
    pageBreak(LINE_H * 3);
    if (art.title) para(art.title, { bold: true, align: 'center', gap: 1.2 });
    (art.paras || []).forEach((p) => para(p));
    (art.blocks || []).forEach((b) => {
      if (b.kind === 'para') para(b.text);
      else {
        b.items.forEach((item, i) => para(`${i + 1}. ${item}`, { indent: 6, gap: 0.6 }));
        y += 1;
      }
    });
  }

  y += 2;
  pageBreak(34);
  para(`U ${MESTO_POTPISA}, dana ${d.datumPotpisa} godine,`, { gap: 8 });
  const colL = MARGIN + CONTENT_W * 0.18;
  const colR = MARGIN + CONTENT_W * 0.82;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(FONT_PT);
  doc.text('Zaposleni,', colL, y, { align: 'center' });
  doc.text('Za Poslodavca,', colR, y, { align: 'center' });
  y += 14;
  doc.setDrawColor(40, 40, 40);
  doc.line(colL - 24, y, colL + 24, y);
  doc.line(colR - 24, y, colR + 24, y);
  y += 5;
  doc.text(ime, colL, y, { align: 'center' });
  doc.text(lat(d.potpisPoslodavac) || 'Nenad Jaraković', colR, y, { align: 'center' });

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(`Ugovor o radu — ${ime}`, MARGIN, PAGE_H - 8);
    doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }

  return { blob: doc.output('blob'), fileName: `Ugovor_o_radu_${safeName(d.imePrezime)}.pdf` };
}
