import type { HelpRegistry } from '@/components/ui-kit/help-mode';
import type { HelpTourStep } from '@/components/ui-kit/help-tour';

/**
 * Uputstvo za rukovanje modulom KADROVSKA (info režim — PLAN_INFO_VODIC).
 *
 * Isti obrazac kao pilot na Zahtevima: „i" oznake uz elemente (HelpSpot) + vođena
 * tura, sve iza `Shift+?` ili dugmeta „?". Ko ne želi pomoć — ugasi je jednom i
 * ostaje ugašena (`servosync.help.enabled=false` u localStorage), na svim modulima.
 *
 * Tekstovi su iz ugla korisnika: ŠTA radi i ZAŠTO, ne kako je programirano.
 * Posebno su objašnjena tri mesta na kojima ljudi najčešće greše:
 *   1) saldo godišnjeg se računa IZ GRIDA, ne iz zahteva,
 *   2) kucanje na kapiji i grid su DVE odvojene evidencije,
 *   3) zarade i lični podaci imaju odvojena prava (HR ih namerno nema).
 * Ključevi su `kadrovska.<ekran>.<element>` i poklapaju se sa HelpSpot id-jevima.
 */
export const HELP: HelpRegistry = {
  /* ─────────────────────────────────────────────────────────── HUB / početak */
  'kadrovska.hub.grupe': {
    title: 'Pet celina modula',
    text: 'Kadrovska je podeljena na pet celina. Kliknite pločicu da otvorite celinu — unutar nje su tabovi. Vidite samo ono za šta imate prava. Kliknite „i" na svakoj pločici da vidite čemu ta celina služi.',
  },
  /* Po jedna tačka na svakoj hub pločici — to je ujedno i vođena tura, jer se
     tura izvodi nad onim što je TRENUTNO na ekranu (koraci čiji cilj nije u DOM-u
     se preskaču). Detaljna objašnjenja stoje uz same elemente unutar tabova. */
  'kadrovska.hub.pregled': {
    title: 'Pregled',
    text: 'Statistika, 11 izveštaja (bolovanja, lekarski, sertifikati, rizik, organogram…) i red čekanja HR obaveštenja. Ovde se vidi stanje, ne unosi se ništa.',
  },
  'kadrovska.hub.odmori': {
    title: 'Odmori i odsustva',
    text: 'Godišnji odmor, zahtevi i odobravanja, bolovanja i ostala odsustva. ⚠️ Najvažnije pravilo: saldo godišnjeg se računa IZ MESEČNOG GRIDA, ne iz odobrenih zahteva — dan je iskorišćen tek kad u gridu stoji „go".',
  },
  'kadrovska.hub.sati': {
    title: 'Radni sati',
    text: 'Mesečni grid (iz njega se plaća) i prisustvo sa kapije. To su DVE odvojene evidencije: kucanje ne ulazi u grid samo od sebe, nego kao predlog koji urednik potvrdi.',
  },
  'kadrovska.hub.zaposleni': {
    title: 'Zaposleni',
    text: 'Kartoni, ugovori, imenik, plan razvoja i uvođenje novih. Lični podaci (JMBG, adresa, dokumenta) su zaključani na uži krug — administrator i poslovni admin; HR ih namerno nema.',
  },
  'kadrovska.hub.zarade': {
    title: 'Zarade',
    text: 'Uslovi zarade i mesečni obračun. Vidi ih samo uzak krug ljudi. Obračun se izvodi iz grida — ako sati nisu uneti i potvrđeni, iznosi neće biti tačni.',
  },

  /* ───────────────────────────────────────────────────────────── ODMORI (GO) */
  'kadrovska.odmori.saldo': {
    title: 'Kako se računa preostali godišnji',
    text: 'Saldo se NE računa iz odobrenih zahteva, nego iz MESEČNOG GRIDA — dan je iskorišćen tek kad u gridu stoji oznaka „go". Zato odobravanje zahteva automatski upisuje dane u grid. Ako neko ručno obriše „go" iz grida, radniku se ti dani vraćaju kao neiskorišćeni.',
  },
  'kadrovska.odmori.zaradjeno': {
    title: '„Zarađeno do danas" vs ukupno pravo',
    text: 'Kolona prikazuje srazmerno zarađene dane do današnjeg datuma, ne ceo godišnji fond. Radnik zaposlen u julu nema pravo na celu godinu — sistem to računa sam.',
  },
  'kadrovska.odmori.zahtevi': {
    title: 'Odobravanje u dva koraka',
    text: 'Zahtev prvo odobrava šef (prvi nivo), pa HR ili administrator finalizuje. Zahtev koji podnese sam šef finalizuje isključivo HR/administrator. Ako traženih dana ima više nego što je na saldu, sistem to javi i ne dozvoli odobrenje.',
  },
  'kadrovska.odmori.opseg': {
    title: 'Zašto ne vidim sve zahteve',
    text: 'Šef vidi samo zahteve iz svojih pododeljenja. HR, administratori i poslovni admin vide sve. Ako očekujete zahtev koji ne vidite, verovatno je van vašeg pododeljenja.',
  },

  /* ────────────────────────────────────────────────────────────── ODSUSTVA */
  'kadrovska.odsustva.placeno': {
    title: 'Plaćeno odsustvo — osnov se BIRA, ne kuca',
    text: 'Osnov se bira iz spiska jer svaki nosi pravni osnov i propisan broj dana. Prva grupa ulazi u fond od najviše 5 radnih dana godišnje, druga je van tog fonda (npr. smrt člana uže porodice, davanje krvi). Broj dana računa sistem — bez vikenda i državnih praznika.',
  },
  'kadrovska.odsustva.nadoknada': {
    title: 'Nadoknada sati i „dan odmora"',
    text: 'Nadoknada = radnik izostane pa taj sat odradi drugi dan; obavezni su razlog i predlog kada nadoknađuje. „Dan odmora" je nešto drugo: radnik radi VIKENDOM i za to dobija +1 dan godišnjeg. Zato „dan odmora" traži datum koji je subota ili nedelja i najmanje 8 sati rada.',
  },

  /* ────────────────────────────────────────────────────────── SATI / GRID */
  'kadrovska.sati.grid': {
    title: 'Mesečni grid — izvor istine za sate',
    text: 'Grid je jedina evidencija iz koje se računa zarada i saldo godišnjeg. Ćelija prima broj sati ili oznaku odsustva (go, bo, sp…). Izmene se ne šalju odmah — skupljaju se dok ne pritisnete „Sačuvaj".',
  },
  'kadrovska.sati.kopiraj': {
    title: 'Kopiraj prethodni mesec',
    text: 'Prepisuje unose prošlog meseca na isti dan tekućeg. Dani kojih u prošlom mesecu nema se PRESKAČU — postojeći unos se ne briše. Ako radnik prošli mesec nema nijedan unos, kopiranje se odbija uz poruku.',
  },
  'kadrovska.sati.zakljucan': {
    title: 'Zaključan dan',
    text: 'Dan koji je potvrđen u „Prisustvo → Za potvrdu" je zaključan i ne može se menjati. To sprečava da neko usput promeni sate posle potvrde. Otključavaju urednik grida i administratori, i tek onda se dan menja.',
  },

  /* ──────────────────────────────────────────────────────────── PRISUSTVO */
  'kadrovska.prisustvo.dva-izvora': {
    title: 'Kapija i grid su DVE evidencije',
    text: 'Kucanje na kapiji je zapis prolaza; grid je evidencija radnih sati iz koje se plaća. Kucanje se u grid ne prepisuje samo od sebe — noću stiže kao PREDLOG, koji urednik potvrđuje. Tako radnik ne može sam da promeni osnovicu za platu.',
  },
  'kadrovska.prisustvo.kontrola': {
    title: 'Za potvrdu — dnevni posao urednika',
    text: 'Ovde se zatvara ceo tok kucanja. Prvo „Zahteva pažnju" (kapija i grid se ne slažu), pa ispravke koje su radnici prijavili uz obrazloženje, pa auto-predlozi iz kapije. Potvrda ide dan po dan i ujedno zaključava taj dan.',
  },
  'kadrovska.prisustvo.ispravka': {
    title: 'Ispravka kucanja koju je radnik prijavio',
    text: 'Radnik iz „Mog profila" prijavljuje zaboravljeno kucanje uz obrazloženje; šef o tome dobija mejl. Ispravka ulazi u evidenciju prolaza, a u grid stiže tek kao predlog. „Poništi" uklanja ispravku — sme urednik grida, šef pododeljenja i administrator.',
  },

  /* ──────────────────────────────────────────────────────────── ZAPOSLENI */
  'kadrovska.zaposleni.pii': {
    title: 'Zašto su neka polja zaključana',
    text: 'JMBG, adresa, telefon, deca, bankovne kartice i dokumenta su lični podaci — vidi ih i menja samo administrator i poslovni admin. HR ih NAMERNO nema; to je pravilo firme, ne greška u programu.',
  },
  'kadrovska.zaposleni.ugovorna-zarada': {
    title: 'Ugovorna zarada (NETO/BRUTO)',
    text: 'Unosi je poslovni admin direktno u kartonu, radi generisanja Ugovora o radu — bez otvaranja taba Zarade. Tab Zarade i mesečni obračun ostaju zaključani na uži krug ljudi.',
  },
  'kadrovska.ugovori.produzi': {
    title: 'Masovno produženje ugovora',
    text: 'Označite ugovore pa izaberite produženje za N meseci ili na tačan datum. Sistem javi koliko je promenjeno i koliko preskočeno. Ugovori na određeno bez datuma isteka ne postoje — ako ga nema, nešto nije u redu i treba ga uneti.',
  },
  'kadrovska.razvoj.360': {
    title: '360° procena',
    text: 'Zaposlenog ocenjuju on sam, kolege i rukovodilac. Niko ne ocenjuje sam sebe kao „rukovodilac". Ocenjivači popunjavaju procenu u „Mom profilu" — dobiju mejl sa linkom. Rezultati postaju vidljivi zaposlenom tek kad ih rukovodilac podeli.',
  },
  'kadrovska.onboarding.tok': {
    title: 'Uvođenje i izlazak',
    text: 'Tok se pokreće iz šablona i daje spisak zadataka sa rokovima. Zaposleni SVOJ tok može da vidi, ali zadatke čekira HR. Kod izlaska se u istom toku vidi šta radnik ima zaduženo da vrati.',
  },

  /* ─────────────────────────────────────────────────────────────── ZARADE */
  'kadrovska.zarade.tok': {
    title: 'Redosled obračuna',
    text: 'Prvo „Pripremi mesec" (napravi redove i povuče uslove zarade), pa „Obračunaj iz grida" (izračuna sate i iznose), pa provera i zaključavanje. Obračun se radi iz grida — ako sati nisu uneti, iznosi neće biti tačni.',
  },
  'kadrovska.zarade.zakljucan': {
    title: 'Zaključan obračun',
    text: 'Kad je obračun isplaćen, ne menja se — to štiti već izvršenu isplatu. Za ispravku ga administrator prvo otključava.',
  },

  /* ──────────────────────────────────────────────────────────── IZVEŠTAJI */
  'kadrovska.izvestaji.rizik': {
    title: 'Izveštaj Rizik',
    text: 'Skreće pažnju na ljude kod kojih se nakupilo bolovanje ili im ističe lekarski/ugovor. Visok rizik = preko 7 dana bolovanja u periodu, istekao lekarski ili istekao ugovor. Podrazumevano se prikazuju samo aktivni zaposleni.',
  },
  'kadrovska.izvestaji.lekarski': {
    title: 'Lekarski i sertifikati',
    text: 'Podrazumevano se prikazuju samo problematični: istekli, ističu za manje od 30 dana i oni bez evidencije. Najgori su na vrhu. Prebacite na „Svi" za pun spisak.',
  },
};

/**
 * Vođena tura — osnovni tok za nekoga ko prvi put otvara Kadrovsku.
 * Namerno kratka i po redosledu posla: gde je šta → kako se vodi vreme →
 * gde su granice prava.
 */
export const KADROVSKA_TOUR: HelpTourStep[] = [
  { spotId: 'kadrovska.hub.grupe' },
  { spotId: 'kadrovska.hub.pregled' },
  {
    spotId: 'kadrovska.hub.odmori',
    title: 'Najvažnije pravilo modula',
    text: 'Godišnji odmor se vodi kroz GRID. Zahtev je samo traženje — dan je stvarno iskorišćen tek kad u gridu stoji „go". Ako to zapamtite, saldo vam nikad neće delovati čudno.',
  },
  { spotId: 'kadrovska.hub.sati' },
  { spotId: 'kadrovska.hub.zaposleni' },
  {
    spotId: 'kadrovska.hub.zarade',
    title: 'I to je sve',
    text: 'Unutar svake celine kliknite „i" pored polja i dugmadi za detaljno objašnjenje. Pomoć se pali i gasi dugmetom „?" gore desno ili prečicom Shift+?, i vaš izbor se pamti.',
  },
];
