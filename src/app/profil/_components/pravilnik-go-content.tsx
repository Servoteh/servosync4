'use client';

/**
 * Pravilnik o korišćenju godišnjeg odmora i odsustava — DOSLOVAN prenos sadržaja
 * iz Servosync 1.0 (`src/ui/mojProfil/pravilnikGO.js`). Isti HTML string služi i
 * modalu (dangerouslySetInnerHTML) i print-iframe-u (PDF, pun Unicode, A4).
 *
 * Sadržaj se NE „lepša" niti skraćuje — mora ostati verna kopija 1.0.
 */

/** Polja koja uprava popunjava pre objave (paritet 1.0 PRAVILNIK_GO_META). */
export const PRAVILNIK_GO_META = {
  broj: '__________',
  datum: '__________',
  mesto: '__________',
  direktor: '______________________',
  verzija: 'Nacrt — za pravnu proveru pre objave',
};

/** Ack koordinate (paritet 1.0: ref_type `pravilnik`, ref_id `pravilnik-go`). */
export const PRAVILNIK_GO_ACK = { refType: 'pravilnik', refId: 'pravilnik-go', label: 'Pravilnik o GO' } as const;

/** Telo pravilnika (bez <html>/<body> — ubacuje se u modal i u print iframe). DOSLOVNO iz 1.0. */
export const PRAVILNIK_GO_HTML = `
  <div class="prg-doc">
    <header class="prg-head">
      <h1>PRAVILNIK O KORIŠĆENJU GODIŠNJEG ODMORA I ODSUSTAVA</h1>
      <p class="prg-org"><strong>Servoteh d.o.o.</strong></p>
      <p class="prg-meta">Broj: ${PRAVILNIK_GO_META.broj} · Datum: ${PRAVILNIK_GO_META.datum} · Mesto: ${PRAVILNIK_GO_META.mesto}</p>
      <p class="prg-draft">${PRAVILNIK_GO_META.verzija}</p>
    </header>

    <section class="prg-summary">
      <h2>Skraćeni vodič (najvažnije)</h2>
      <ul>
        <li><strong>20 radnih dana</strong> godišnjeg odmora godišnje (bez vikenda i praznika).</li>
        <li>Zahtev se podnosi <strong>isključivo kroz „Moj profil"</strong>, po pravilu <strong>najmanje 7 radnih dana unapred</strong>.</li>
        <li>Odobravaju ga <strong>šef odeljenja + HR</strong>, ili <strong>CFO/CEO</strong>. Usmeni dogovor ne važi.</li>
        <li>Jedno neprekidno korišćenje <strong>najviše 10 radnih dana</strong> — duže samo uz odobrenje direktora.</li>
        <li>Neiskorišćeni dani se koriste <strong>do 30. juna naredne godine</strong>.</li>
        <li><strong>Neplaćeno odsustvo nije pravo</strong> — dozvoljeno samo izuzetno; umesto njega može <strong>izostanak uz nadoknadu sati</strong> (rad u drugom danu), uz odobrenje šefa + HR ili CFO/CEO.</li>
        <li>Plaćeno odsustvo: brak, rođenje deteta, smrt/bolest u porodici, slava, davanje krvi i dr. (vidi tabele).</li>
      </ul>
    </section>

    <h2>Član 1 — Predmet</h2>
    <p>Ovim pravilnikom uređuje se pravo, trajanje, raspored, postupak odobravanja i evidencija godišnjeg odmora, plaćenog odsustva, odsustva za državne i verske praznike, kao i pravila u vezi sa izostankom sa rada i nadoknadom fonda radnih sati zaposlenih u Servoteh d.o.o., u skladu sa Zakonom o radu Republike Srbije i drugim važećim propisima.</p>

    <h2>Član 2 — Primena i dostupnost</h2>
    <p>Pravilnik se primenjuje na sve zaposlene. Dostupan je svakom zaposlenom u svakom trenutku kroz internu aplikaciju, modul „Moj profil" (PDF), kao i na oglasnoj tabli poslodavca. Zaposleni su dužni da se upoznaju sa pravilnikom i da odsustva koriste isključivo u skladu sa propisanom procedurom.</p>

    <h3 class="prg-part">I — GODIŠNJI ODMOR</h3>

    <h2>Član 3 — Trajanje</h2>
    <p>Zaposleni ima pravo na godišnji odmor u trajanju od najmanje <strong>20 radnih dana</strong> u kalendarskoj godini. Dužina se može uvećati u skladu sa zakonom, ugovorom o radu ili posebnom odlukom poslodavca (radno iskustvo, uslovi rada, doprinos, stručna sprema, složenost poslova).</p>
    <p>U dane godišnjeg odmora ne uračunavaju se: državni praznici koji su neradni dani, verski praznici koje zaposleni koristi u skladu sa zakonom, subote i nedelje (odnosno neradni dani prema rasporedu), dani bolovanja i dani odsustva po drugom osnovu.</p>

    <h2>Član 4 — Sticanje prava i srazmerni deo</h2>
    <p>Zaposleni stiče pravo na korišćenje godišnjeg odmora posle <strong>mesec dana neprekidnog rada</strong>. U godini u kojoj zasniva ili u kojoj mu prestaje radni odnos, pripada mu <strong>srazmeran deo (1/12 za svaki mesec rada)</strong>. Pri obračunu, deo dana se zaokružuje u korist zaposlenog ako obavezujući propis ne nalaže drugačije.</p>

    <h2>Član 5 — Način korišćenja i ograničenje trajanja u jednom navratu</h2>
    <p>Godišnji odmor može se koristiti u celini ili u delovima. Ako se koristi u delovima, <strong>prvi deo iznosi najmanje dve radne nedelje neprekidno</strong> u toku kalendarske godine.</p>
    <p>Zbog kontinuiteta poslovanja, godišnji odmor se planira tako da <strong>jedno neprekidno korišćenje ne traje duže od 10 radnih dana</strong>. Duže od 10 radnih dana u jednom navratu moguće je samo uz <strong>izričito odobrenje direktora (CEO)</strong> ili lica koje on ovlasti. Ova odredba ne ograničava zakonsko pravo na godišnji odmor, već uređuje način planiranja i odobravanja.</p>

    <h2>Član 6 — Postupak podnošenja i odobravanja</h2>
    <p>Zahtev za godišnji odmor podnosi se <strong>isključivo kroz aplikaciju, modul „Moj profil"</strong>, po pravilu <strong>najkasnije 7 radnih dana unapred</strong> (osim u hitnim/vanrednim okolnostima).</p>
    <p>Zahtev odobravaju <strong>šef odeljenja (neposredni rukovodilac) i HR</strong>; alternativno, zahtev može odobriti <strong>CFO ili CEO</strong>. Zahtev se smatra odobrenim tek kada ga potvrde šef odeljenja i HR, odnosno kada ga odobri CFO ili CEO. Usmena saglasnost, poruka ili dogovor sa kolegom ne smatraju se odobrenim godišnjim odmorom.</p>
    <p>O odluci se zaposleni obaveštava kroz aplikaciju i/ili e-mail. Rešenje o korišćenju godišnjeg odmora dostavlja se najkasnije <strong>15 dana pre</strong> početka odmora, osim kada se odmor koristi na zahtev zaposlenog u kraćem roku. Rešenje se može dostaviti u elektronskoj formi.</p>

    <h2>Član 7 — Godišnji plan odmora</h2>
    <p>HR u saradnji sa šefovima odeljenja izrađuje okvirni plan korišćenja godišnjih odmora do kraja <strong>marta</strong> tekuće godine, vodeći računa o kontinuitetu rada, obavezama prema kupcima i funkcionalnosti svakog odeljenja. Nije dozvoljeno da celo odeljenje, smena ili ključni deo tima budu istovremeno na odmoru bez izričite saglasnosti rukovodioca i direktora/ovlašćenog člana uprave.</p>

    <h2>Član 8 — Izmena / pomeranje već odobrenog odmora</h2>
    <p>Termin već odobrenog godišnjeg odmora može se izmeniti na zahtev zaposlenog, zbog opravdanih poslovnih potreba, promene u organizaciji rada, bolesti ili drugih opravdanih okolnosti. Izmena se vrši isključivo kroz aplikaciju „Moj profil", uz saglasnost rukovodioca i HR-a (odnosno CFO/CEO).</p>

    <h2>Član 9 — Promena termina i prekid korišćenja</h2>
    <p>Poslodavac može, u skladu sa zakonom, izmeniti vreme korišćenja godišnjeg odmora ako to zahtevaju potrebe posla. Već započet odmor prekida se samo u izuzetnim slučajevima hitne i neodložne poslovne potrebe, uz pisanu odluku direktora/ovlašćenog člana uprave i prethodnu konsultaciju sa zaposlenim. Neiskorišćeni dani koriste se naknadno. Dokumentovani, nužni i razumni troškovi nastali zbog izmene ili prekida nadoknađuju se zaposlenom na osnovu posebne odluke, uz odgovarajuće dokaze.</p>

    <h2>Član 10 — Prenos neiskorišćenog odmora</h2>
    <p>Deo godišnjeg odmora neiskorišćen u tekućoj godini koristi se najkasnije <strong>do 30. juna naredne godine</strong>. Neiskorišćeni godišnji odmor ne može se zameniti novčanom naknadom, osim pri prestanku radnog odnosa, kada se isplaćuje naknada u skladu sa zakonom.</p>

    <h2>Član 11 — Naknada zarade</h2>
    <p>Za vreme godišnjeg odmora zaposleni ima pravo na naknadu zarade u visini <strong>prosečne zarade ostvarene u prethodnih 12 meseci</strong>, u skladu sa zakonom.</p>

    <h2>Član 12 — Bolovanje za vreme odmora</h2>
    <p>Ako zaposleni za vreme godišnjeg odmora postane privremeno sprečen za rad (bolovanje, uz lekarsku potvrdu), korišćenje godišnjeg odmora se <strong>prekida</strong> za dane bolovanja, a preostali dani se koriste naknadno. Zaposleni je dužan da bez odlaganja obavesti poslodavca i dostavi dokumentaciju.</p>

    <h3 class="prg-part">II — PLAĆENO ODSUSTVO</h3>

    <h2>Član 13 — Pravo na plaćeno odsustvo</h2>
    <p>Zaposleni ima pravo na plaćeno odsustvo u slučajevima propisanim Zakonom o radu, ovim pravilnikom, ugovorom o radu ili drugim opštim aktom. Plaćeno odsustvo koristi se namenski, za konkretan događaj. Zahtev se podnosi kroz „Moj profil", uz odgovarajući dokaz kada je dokaz moguće pribaviti.</p>

    <h2>Član 14 — Plaćeno odsustvo do ukupno 5 radnih dana godišnje</h2>
    <p>Zaposleni ima pravo na plaćeno odsustvo do ukupno <strong>5 radnih dana u kalendarskoj godini</strong> za sledeće slučajeve, u trajanju utvrđenom Pravilnikom o radu (čl. 35):</p>
    <table class="prg-table">
      <thead><tr><th>Osnov</th><th>Trajanje</th></tr></thead>
      <tbody>
        <tr><td>Sklapanje braka</td><td>3 radna dana</td></tr>
        <tr><td>Porođaj supruge / rođenje deteta</td><td>3 radna dana</td></tr>
        <tr><td>Teža bolest člana uže porodice</td><td>3 radna dana</td></tr>
        <tr><td>Zaštita i otklanjanje štetnih posledica elementarne nepogode u domaćinstvu</td><td>2 radna dana</td></tr>
        <tr><td>Selidba sopstvenog domaćinstva u istom naseljenom mestu</td><td>1 radni dan</td></tr>
        <tr><td>Selidba sopstvenog domaćinstva iz jednog u drugo naseljeno mesto</td><td>2 radna dana</td></tr>
        <tr><td>Polaganje stručnog ili drugog ispita</td><td>2 radna dana</td></tr>
      </tbody>
    </table>
    <p>Trajanje navedeno uz pojedini osnov je gornja granica za taj događaj. <strong>Bez obzira na broj i vrstu osnova, ukupno pravo po ovom članu iznosi najviše 5 radnih dana u kalendarskoj godini</strong> (zajednički godišnji fond). Dani se računaju u okviru tog limita, osim ako zakon za određeni osnov izričito ne propisuje drugačije.</p>

    <h2>Član 15 — Plaćeno odsustvo van limita od 5 radnih dana</h2>
    <p>Pored prava iz člana 14, zaposleni ima pravo na plaćeno odsustvo i u sledećim slučajevima, koji se <strong>ne uračunavaju</strong> u limit od 5 dana:</p>
    <table class="prg-table">
      <thead><tr><th>Osnov</th><th>Trajanje</th></tr></thead>
      <tbody>
        <tr><td>Smrt člana uže porodice</td><td>5 radnih dana</td></tr>
        <tr><td>Dobrovoljno davanje krvi</td><td>2 uzastopna dana po davanju (uključujući dan davanja)</td></tr>
      </tbody>
    </table>
    <p><strong>Član uže porodice</strong> (u smislu Pravilnika o radu, čl. 35): bračni/vanbračni drug, deca, braća i sestre, roditelji, usvojilac, usvojenik, staratelj, kao i druga lica koja žive u zajedničkom porodičnom domaćinstvu sa zaposlenim, osim ako zakon za pojedino pravo ne propisuje drugačiji krug lica.</p>

    <h2>Član 16 — Dokazi za plaćeno odsustvo</h2>
    <p>Zaposleni je dužan da, kada je to moguće, uz zahtev priloži odgovarajući dokaz (izvod iz matične knjige venčanih/rođenih/umrlih, lekarska dokumentacija, potvrda o davanju krvi, potvrda o polaganju ispita i sl.). Ako zbog hitnosti dokaz nije moguće dostaviti unapred, dostavlja se naknadno, bez odlaganja. Davanje netačnih podataka ili korišćenje odsustva suprotno nameni predstavlja povredu radne obaveze.</p>

    <h3 class="prg-part">III — DRŽAVNI I VERSKI PRAZNICI</h3>

    <h2>Član 17 — Državni i verski praznici</h2>
    <p>Zaposleni ima pravo da ne radi u dane državnih i verskih praznika koji su neradni dani, u skladu sa Zakonom o državnim i drugim praznicima u Republici Srbiji. Ti dani se <strong>ne uračunavaju</strong> u godišnji odmor.</p>
    <p>Zaposleni pravoslavne veroispovesti ima pravo da ne radi na <strong>prvi dan krsne slave</strong>. Zaposleni drugih veroispovesti ostvaruju pravo na odsustvo za svoje verske praznike u skladu sa zakonom.</p>

    <h3 class="prg-part">IV — NEPLAĆENO ODSUSTVO I NADOKNADA FONDA SATI</h3>

    <h2>Član 18 — Osnovno pravilo</h2>
    <p>Neplaćeno odsustvo <strong>nije redovno pravo zaposlenog</strong> i zaposleni ne može jednostrano odlučiti da ga koristi; poslodavac nema obavezu da ga odobri. Zahtevi iz privatnih, organizacionih ili ličnih razloga se po pravilu odbijaju, osim ako poslodavac izuzetno ne odobri drugačije. Neplaćeno odsustvo se ne može koristiti kao zamena ili produžetak godišnjeg odmora, kao pokriće za prekoračenje salda, niti kao naknadno opravdanje izostanka.</p>

    <h2>Član 19 — Izostanak uz nadoknadu fonda radnih sati</h2>
    <p>Izuzetno, kada zaposleni iz opravdanih razloga ne može da bude prisutan određenog dana ili dela dana, poslodavac može, umesto neplaćenog odsustva, odobriti <strong>izostanak uz nadoknadu fonda radnih sati</strong>. Tada se izostanak <strong>ne tretira kao odsustvo</strong>, pod uslovom da zaposleni u dogovorenom roku nadoknadi sate radom u drugom danu.</p>
    <p>Odobrava se samo ako su kumulativno ispunjeni uslovi: (1) zaposleni podnese zahtev kroz „Moj profil" pre izostanka (osim u hitnom slučaju), sa razlogom, brojem sati/dana i predlogom termina nadoknade; (2) <strong>šef odeljenja</strong> potvrdi da izostanak ne ugrožava organizaciju rada i da je nadoknada operativno moguća; (3) <strong>HR</strong> potvrdi usklađenost sa evidencijom radnog vremena. Alternativno, izostanak uz nadoknadu može odobriti <strong>CFO ili CEO</strong>. Bez ispunjenja uslova, izostanak nije odobren.</p>

    <h2>Član 20 — Pravila nadoknade sati</h2>
    <p>Nadoknada mora biti unapred definisana i odobrena kroz „Moj profil" i sadrži: dan(e) izostanka, broj sati, tačne dane i vreme nadoknade, rok nadoknade i potvrde (šef + HR, odnosno CFO/CEO). Nadoknada se organizuje uz poštovanje propisa o radnom vremenu, dnevnom i nedeljnom odmoru, prekovremenom radu i evidenciji radnog vremena. Ne sme se koristiti za prikrivanje neopravdanog izostanka, kašnjenja ili samovoljnog napuštanja radnog mesta. Ako sate ne nadoknadi u roku, poslodavac vrši odgovarajuću korekciju evidencije i zarade u skladu sa zakonom i može pokrenuti postupak odgovornosti.</p>

    <h2>Član 21 — Hitni slučajevi</h2>
    <p>U hitnim i vanrednim slučajevima, kada zaposleni nije mogao unapred da podnese zahtev, dužan je da bez odlaganja obavesti šefa odeljenja i HR, najkasnije istog dana. Zahtev kroz „Moj profil" podnosi se naknadno, najkasnije prvog narednog radnog dana, uz obrazloženje i predlog nadoknade. Naknadno odobrenje moguće je samo ako šef i HR (odnosno CFO/CEO) potvrde opravdanost. U suprotnom, izostanak se može smatrati neopravdanim.</p>

    <h2>Član 22 — Prekoračenje salda godišnjeg odmora</h2>
    <p>Zaposleni ne može koristiti godišnji odmor preko raspoloživog salda. Dani preko salda ne tretiraju se automatski kao plaćeno ili neplaćeno odsustvo — zahtev se odbija, osim ako poslodavac izuzetno ne odobri izostanak uz nadoknadu sati (čl. 19–21) ili neplaćeno odsustvo (čl. 18), koje konačno odobrava direktor/ovlašćeni član uprave.</p>

    <h2>Član 23 — Neodobren izostanak</h2>
    <p>Svaki izostanak koji nije odobren u skladu sa ovim pravilnikom smatra se neodobrenim. Neodobren izostanak, davanje netačnih podataka, zloupotreba odsustva ili samovoljno korišćenje neplaćenog odsustva predstavljaju povredu radne obaveze i mogu biti osnov za postupak odgovornosti.</p>

    <h3 class="prg-part">V — EVIDENCIJA I KONTROLA</h3>

    <h2>Član 24 — Evidencija</h2>
    <p>HR vodi elektronsku evidenciju o godišnjim odmorima, plaćenim odsustvima, praznicima, izostancima uz nadoknadu sati, rešenjima, odobrenjima, saldu i notifikacijama — kroz aplikaciju „Moj profil" i druge službene evidencije, u skladu sa zakonom.</p>

    <h2>Član 25 — Obaveze rukovodilaca</h2>
    <p>Šefovi odeljenja dužni su da blagovremeno razmatraju zahteve, proveravaju uticaj na proces rada, vode računa o funkcionalnosti odeljenja, predlažu realnu zamenu/nadoknadu i obaveste HR o nepravilnostima. Neformalno odobrenje koje nije evidentirano u aplikaciji i nije prošlo proceduru ne proizvodi dejstvo odobrenog odsustva.</p>

    <h2>Član 26 — Zloupotreba prava</h2>
    <p>Nenamensko korišćenje odsustva, netačni podaci, neistinita dokumentacija, samovoljno odsustvo ili zloupotreba nadoknade sati predstavljaju povredu radne obaveze, na koju poslodavac može odgovoriti merama u skladu sa zakonom i internim aktima.</p>

    <h3 class="prg-part">VI — ZAVRŠNE ODREDBE</h3>

    <h2>Član 27 — Odnos prema zakonu i drugim aktima</h2>
    <p>Ako je neko pravo zakonom, kolektivnim ugovorom, pravilnikom o radu ili ugovorom o radu uređeno povoljnije za zaposlenog, primenjuje se povoljnije pravo. Ako neka odredba bude u suprotnosti sa obavezujućim propisom, neposredno se primenjuje propis, a odredba se usklađuje u najkraćem razumnom roku.</p>

    <h2>Član 28 — Stupanje na snagu</h2>
    <p>Pravilnik stupa na snagu <strong>osmog dana</strong> od dana objavljivanja na oglasnoj tabli i u aplikaciji „Moj profil". Danom stupanja na snagu prestaju da važe ranije interne instrukcije i prakse koje su sa njim u suprotnosti.</p>

    <div class="prg-sign">
      <p>Direktor: ${PRAVILNIK_GO_META.direktor}</p>
    </div>
  </div>
`;

/** CSS za prikaz u modalu i za štampu (PDF). Isti izgled na ekranu i na papiru. Paritet 1.0 PRG_CSS. */
export const PRAVILNIK_GO_CSS = `
  .prg-doc { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1a1a1a; line-height:1.5; font-size:13.5px; }
  .prg-doc h1 { font-size:18px; margin:0 0 6px; text-align:center; letter-spacing:.2px; }
  .prg-doc h2 { font-size:14px; margin:18px 0 4px; color:#0f172a; }
  .prg-doc h3.prg-part { font-size:15px; margin:24px 0 8px; padding:6px 10px; background:#eff6ff; border-left:4px solid #2563eb; border-radius:4px; color:#1e3a8a; }
  .prg-doc p { margin:6px 0; text-align:justify; }
  .prg-head { text-align:center; border-bottom:2px solid #1e293b; padding-bottom:10px; margin-bottom:8px; }
  .prg-org { margin:2px 0; font-size:14px; }
  .prg-meta { margin:2px 0; font-size:12px; color:#475569; }
  .prg-draft { margin:4px 0 0; font-size:11px; color:#b45309; font-style:italic; }
  .prg-summary { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 16px; margin:14px 0; }
  .prg-summary h2 { margin-top:0; }
  .prg-summary ul { margin:6px 0; padding-left:20px; }
  .prg-summary li { margin:4px 0; }
  .prg-table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12.5px; }
  .prg-table th, .prg-table td { border:1px solid #cbd5e1; padding:6px 10px; text-align:left; vertical-align:top; }
  .prg-table th { background:#f1f5f9; }
  .prg-table td:last-child { white-space:nowrap; }
  .prg-sign { margin-top:32px; }
`;
