'use client';

/**
 * Kompanijske vrednosti — DOSLOVAN prenos sadržaja iz Servosync 1.0
 * (`src/ui/mojProfil/kompanijskeVrednosti.js`). Isti HTML string služi i modalu
 * (dangerouslySetInnerHTML) i print-iframe-u (PDF, pun Unicode, A4).
 *
 * Sadržaj se NE „lepša" niti skraćuje — mora ostati verna kopija 1.0.
 */

/** Polja koja uprava popunjava / verzija dokumenta (paritet 1.0 KOMP_VREDNOSTI_META). */
export const KOMP_VREDNOSTI_META = {
  verzija: 'Verzija 2026',
  mesto: 'Beograd',
  direktor: 'Nenad Jaraković, direktor',
};

/** Ack koordinate za kompanijske vrednosti (self-service potvrda upoznatosti). */
export const KOMP_VREDNOSTI_ACK = { refType: 'vrednosti', refId: 'kompanijske-vrednosti', label: 'Kompanijske vrednosti' } as const;

/** Telo dokumenta (bez <html>/<body> — ubacuje se u modal i u print iframe). DOSLOVNO iz 1.0. */
export const KOMP_VREDNOSTI_HTML = `
  <div class="kv-doc">
    <header class="kv-head">
      <h1>KOMPANIJSKE VREDNOSTI</h1>
      <p class="kv-org"><strong>Servoteh d.o.o.</strong></p>
      <p class="kv-meta">Ugrinovačka 163, 11272 Beograd · Tel: +381 11 31 41 564 · E-mail: office@servoteh.com · www.servoteh.com</p>
      <p class="kv-draft">${KOMP_VREDNOSTI_META.verzija} · ${KOMP_VREDNOSTI_META.mesto}</p>
    </header>

    <section class="kv-intro">
      <p>Poštovane kolege,</p>
      <p>U cilju boljeg poslovanja i sa željom da svako od nas neometano izvršava svoje zadatke, sastavili smo jasnu listu vrednosti kojima želimo da se rukovodi svako ko radi u Servotehu. Verujemo da će nam ovaj dokument pomoći da nemamo nedoumice oko toga šta su osnovna očekivanja i koje osnove zajedno moramo da zadovoljimo kako bismo radili i razvijali se kao poslovna zajednica.</p>
      <p>Naš cilj je prijatna radna atmosfera, timski duh, kolegijalan odnos, međusobno poštovanje, kao i poštovanje radnih obaveza i radnog prostora — i verujemo da je to cilj kome teži svako od vas.</p>
      <p><strong>Vrednosti koje slede iste su i važe za sve zaposlene, bez obzira na status, poziciju, znanje i radno iskustvo.</strong></p>
    </section>

    <h3 class="kv-part">A — Odnos prema radnom vremenu i obavezama</h3>

    <h2>1. Redovno dolazi na posao</h2>
    <p>Servoteh je sa svakim zaposlenim, prilikom potpisivanja ugovora, utvrdio minimalan broj radnih sati. Ako su izostanci pojedinca učestali, kolege ne mogu da računaju na njegov doprinos, a poslodavac ne može da se osloni da će zadaci biti ispunjeni. Redovan dolazak na posao neophodan je da bismo mogli da računamo jedni na druge i na pozitivan ishod rada.</p>

    <h2>2. Poštuje radno vreme</h2>
    <p>Početak radnog dana je polazna tačka svih dnevnih aktivnosti. Budući da smo veliki kolektiv u kome se zaposleni često oslanjaju jedni na druge, nepoštovanje radnog vremena predstavlja prepreku kako u izvršavanju zadataka, tako i u negovanju dobre atmosfere i kolegijalnosti. Zato je važno da se svako pridržava propisanog radnog vremena, a da o eventualnim promenama blagovremeno obavesti svog direktno nadređenog.</p>

    <h2>3. Poštuje radnu disciplinu</h2>
    <p>Servoteh je odlučan da svi zaposleni rade u prijatnim uslovima. Upotreba telefona dozvoljena je u svrhe komunikacije (neodložni pozivi ili poruke), ali očekujemo da niko ne zloupotrebljava mobilne telefone i druge uređaje koji ne doprinose učinku i efikasnosti. To praktično znači da korišćenje društvenih mreža i interneta koje nema za cilj posao treba rezervisati za vreme pauza. Važno nam je da svi budemo posvećeni svojim zadacima — podeljena pažnja retko daje optimalne rezultate, a ovakvo ponašanje može da omete i kolege u njihovom radu.</p>
    <p class="kv-note"><em>Ovo uključuje i izbegavanje preglasne muzike i drugih ometanja u zajedničkom radnom prostoru.</em></p>

    <h2>4. Poštuje strukturu u prioritizaciji zadataka</h2>
    <p>Zajedno radimo na tome da prioriteti u proizvodnom procesu budu jasno definisani. Uloga svakog od nas je značajna, i samo ako se svi pridržavamo prioriteta koje dobijamo od direktno nadređenih, izbeći ćemo haos u određivanju redosleda zadataka. Takva praksa pomaže nam da u svakom trenutku znamo šta radimo i kome da se obratimo za naredni zadatak.</p>

    <h2>5. Koristi propisane pauze</h2>
    <p>Servoteh je sa svakim zaposlenim, prilikom potpisivanja ugovora, utvrdio tačno trajanje pauza. Poštovanje tog vremena potrebno je da bi produktivnost svakog pojedinca, tima i sektora bila optimalna.</p>

    <h3 class="kv-part">B — Odnos prema radu i kvalitetu</h3>

    <h2>6. Posvećen je zadatku i svodi greške na minimum</h2>
    <p>Greške u radu su neizbežne, ali posvećenost, fokusiran pristup, etički odnos prema kolektivu i imovini, kao i dosledna primena stručnog znanja, svode mogućnost greške na minimum. Svako treba da posvećuje punu pažnju svojim zadacima u svim sektorima: u izradi dokumentacije, u projektovanju, u mašinskoj obradi (škart), u administraciji i drugde. Greška pojedinca ili sektora negativno utiče na efikasnost svih ostalih.</p>

    <h2>7. Poštuje inventar i radnu opremu</h2>
    <p>Sve što pripada inventaru i opremi Servoteha (mašine, alat, viljuškar i ostalo) služi svima nama. Nepropisno korišćenje ubrzava kvarove i otežava poslovanje, a može i da nanese fizičku povredu onome ko opremu koristi ili drugim kolegama. Zato opremu koristimo namenski i pažljivo.</p>

    <h2>8. Unapređuje veštine i stiče nova znanja</h2>
    <p>Veoma cenimo proaktivnost u profesionalnom i stručnom razvoju. Verujemo da je svako u Servotehu u prilici da stalno uči i napreduje. Ohrabrujemo radoznalost — ako ste početnik, slobodno pitajte. Negujemo takav pristup i kod pojedinca i kroz timski razvoj.</p>

    <h2>9. Vodi računa o bezbednosti na radu</h2>
    <p>Bezbednost je iznad svega. Svako je dužan da poštuje mere zaštite na radu, propisno koristi zaštitnu opremu i da odmah prijavi svaku nebezbednu situaciju, kvar ili povredu direktno nadređenom. Briga o sopstvenoj i tuđoj bezbednosti deo je odgovornosti svakog zaposlenog.</p>

    <h2>10. Odgovoran je prema klijentu i kvalitetu isporuke</h2>
    <p>Naš rad ima smisla kroz zadovoljstvo klijenta. Rokove i dogovoreni kvalitet shvatamo ozbiljno, jer od pouzdanosti svakog od nas zavisi reputacija cele kompanije. Kvalitet nije završna kontrola — kvalitet je odgovornost svakog koraka u procesu.</p>

    <h3 class="kv-part">C — Odnos prema kolegama</h3>

    <h2>11. Komunicira s poštovanjem</h2>
    <p>Minimum koji unosimo u radni ambijent jeste poštovanje prema kolegama. Mi smo pre i iznad svega ljudi i dostojanstvena bića — svako od nas zaslužuje poštovanje, ali ima i obavezu da poštuje druge.</p>

    <h2>12. Prenosi znanje i poslovne informacije</h2>
    <p>Znanje koje svako donosi u Servoteh i stiče radeći ovde dragoceno je celom kolektivu. Zato je važno da razmenjujemo postojeća i novostečena znanja radi unapređenja poslovanja i ispunjavanja obaveza prema klijentima. Isto važi i za relevantne informacije, kao i za sugestije nadređenima koje za cilj imaju bolje poslovanje.</p>

    <h2>13. Proaktivno pomaže novim kolegama</h2>
    <p>Novopridošle kolege ne mogu odmah imati znanje onih koji su već neko vreme u kolektivu. Brzina kojom će učiti i osamostaliti se zavisi od svih nas. Pored mentora zaduženih za obuku, ohrabrujemo svakog zaposlenog da pomogne da obuka teče što brže.</p>

    <h2>14. Neguje dobro raspoloženje</h2>
    <p>Atmosfera u kojoj radimo zavisi od nas. Ona utiče i na pristup zadacima i na učinak. Ako jedni druge obeshrabrujemo ili demotivišemo, to se negativno odražava na celokupan odnos prema radu i rezultate. Zato svako od nas doprinosi pozitivnoj i podsticajnoj atmosferi.</p>

    <h3 class="kv-part">D — Odnos prema prostoru i higijeni</h3>

    <h2>15. Vodi računa o higijeni radnog mesta</h2>
    <p>Higijena je jedan od osnovnih faktora zdravlja, a uredno radno mesto preduslov je da se zadaci izvršavaju brže, efikasnije, organizovanije i pedantnije. Održavanje sopstvenog radnog prostora deo je osnovnih obaveza svakog zaposlenog.</p>

    <h2>16. Vodi računa o higijeni zajedničkih prostorija</h2>
    <p>Kuhinja, toalet i ostale zajedničke prostorije održavamo čistim i urednim — pojedinačno i svi zajedno, na dnevnom nivou. Zadatak svakog zaposlenog je da iza sebe počisti prostor i ostavi ga u stanju u kakvom ga je zatekao.</p>

    <h2>17. Vodi računa o ličnoj higijeni</h2>
    <p>Servoteh je velika zajednica i zadatak svakog pojedinca je da se uklopi u nju poštujući praksu održavanja lične higijene. To, između ostalog, podrazumeva osnove koje svaki pojedinac može da ispoštuje: redovno tuširanje, pranje kose, pranje odeće tako da ne sadrži bajate i neprijatne mirise, kao i korišćenje sredstava protiv znojenja.</p>

    <h3 class="kv-part">Primena</h3>
    <p>Ova lista vrednosti služi svima nama kao vodič i olakšica u radu. Ujedno, ona je polazna osnova na osnovu koje se vrši <strong>evaluacija učinka i doprinosa svakog zaposlenog</strong>, bez obzira na status, poziciju, znanje i radno iskustvo.</p>

    <div class="kv-sign">
      <p>S poštovanjem,</p>
      <p><strong>Za Servoteh d.o.o.</strong></p>
      <p>${KOMP_VREDNOSTI_META.direktor}</p>
    </div>
  </div>
`;

/** CSS za prikaz u modalu i za štampu (PDF). Isti izgled na ekranu i na papiru. Paritet 1.0 KV_CSS. */
export const KOMP_VREDNOSTI_CSS = `
  .kv-doc { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1a1a1a; line-height:1.55; font-size:13.5px; }
  .kv-doc h1 { font-size:19px; margin:0 0 6px; text-align:center; letter-spacing:.4px; }
  .kv-doc h2 { font-size:14px; margin:14px 0 3px; color:#0f172a; }
  .kv-doc h3.kv-part { font-size:15px; margin:24px 0 10px; padding:6px 12px; background:#fff1ec; border-left:4px solid #e5502a; border-radius:4px; color:#9a3412; }
  .kv-doc p { margin:5px 0; text-align:justify; }
  .kv-head { text-align:center; border-bottom:2px solid #1e293b; padding-bottom:10px; margin-bottom:8px; }
  .kv-org { margin:2px 0; font-size:14px; }
  .kv-meta { margin:2px 0; font-size:11.5px; color:#475569; }
  .kv-draft { margin:4px 0 0; font-size:11px; color:#b45309; font-style:italic; }
  .kv-intro { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 16px; margin:14px 0; }
  .kv-note { color:#475569; font-size:12.5px; }
  .kv-sign { margin-top:32px; }
  .kv-sign p { margin:2px 0; text-align:left; }
`;
