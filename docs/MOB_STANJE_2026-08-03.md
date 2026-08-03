# Mobilna 3.0 — presek stanja 03.08.2026

Nasleđuje [MOB_STANJE_2026-07-26.md](MOB_STANJE_2026-07-26.md). Od tog preseka promenilo se
praktično sve: iPhone paritet, Android paritet, PWA na obe platforme, PDF na telefonu i
sloj priloga (front + backend).

**Osnovno pravilo nije se promenilo:** 1.0 na `/m` je i dalje živa pogonska aplikacija i
ništa je ne sme poremetiti. Provereno posle **svakog** deploy-a u ovom talasu.

---

## 1. Šta je pušteno 02–03.08.

| PR | Šta | Provereno |
|---|---|---|
| #79 | Android: skener, ljuska, PWA pod `/mob` | prod 200; 1.0 netaknuta |
| #80 | Offline rezerva servisnog radnika (3 buga) | `v2` na produ |
| #81 | PDF na telefonu + fotografije se ne gube tiho | `/mob/odsustva` 1220 → **747 KiB** |
| #82 | Backend: jedno mesto istine za formate priloga | deploy 🟢 + `post-deploy-verify` EXIT 0 |

Ranije u talasu (01–02.08): iPhone paritet (`1205604d`), PWA za iPhone (`1397d405`).

---

## 2. Android — šta je bilo pokvareno i zašto

Provera u 4 ugla pokazala je da je **iPhone paket oborio Android**. Jezgro skena je bilo
netaknuto; lomilo se sve oko njega:

- **Nišan je padao ispod donjeg panela** na 360–412dp (svaki Samsung u pogonu), a panel je
  gutao dodir za izoštravanje. Najgore u „neprekidnom" režimu na policama.
- **Telefon u pejzažu ima 800 CSS px** → ulazio je u „desktop" režim: „Dodaj na policu"
  padalo sa 56 na 36 px, nestajala zaštita polja od uveličavanja. Isto pravilo je naduvavalo
  ~120 gustih dugmadi po desktop tabelama.
- **Sporedna dugmad bez ikakvog odziva na pritisak** (na dodiru `hover:` nikad ne okine, a
  tap-highlight je bio ugašen globalno) → dupli tap → dupla stavka u magacinu.
- **Bluetooth/žični čitač je bio mrtav** u svim skener ljuskama na Androidu.
- **`/mob/reversi`** je jedini tražio Google-ov ugrađeni čitač, van puta kojim ide 1.0.

Zatečeno, ne iz ovog paketa, ali najozbiljnije: **„Osveži app" je brisao 1.0-inu ljusku
s telefona.** Sada preskače sve 1.0-ino i briše samo 3.0-ino, po spisku.

---

## 3. Fotografije — tiho gubljenje dokaza (zatvoreno)

Lanac koji je gubio fotografije sa montaže:

1. HEIC (podrazumevani format iPhone-a i Samsung/Pixel „High efficiency") u pregledaču
   dekodira **samo Safari** → smanjivanje slike padne.
2. Front je na pad slao **original**.
3. Backend ga odbija; ali validacija je išla nad **svim** fajlovima pa upis u **jednoj
   transakciji** → jedan takav fajl obori celu otpremu.
4. Radnik dobije „deo fotografija nije otpremljen", **a prijava je već snimljena bez ijedne
   slike.**

Zašto se nije primetilo: iOS „Galerija" sam pretvara u JPEG, pa je taj put uglavnom prolazio.
Curilo je kroz iOS „Files", **Android sa „High efficiency"** i prekopirane fajlove.

**Sada:** slika koja se ne može pretvoriti **odbija se pre slanja, uz uputstvo**; original
nikad ne odlazi tiho. Backend format utvrđuje **iz sadržaja** (ne iz onoga što klijent
prijavi) i takav ga zapisuje. Poruka imenuje sve sporne fajlove odjednom.

**Provereno na produkciji, obe baze, ~10 tabela priloga: 0 HEIC zapisa.** Nema šta da se
spašava unazad.

Usput popravljeno: **Plan montaže je svakoj fotografiji upisivao „JPEG" napamet** (i PNG-u);
**fotografija vozila** se propuštala samo po tvrdnji klijenta.

---

## 4. Šta traži probu na uređaju (ne može se proveriti iz koda)

**Samsung / Android:**
1. **Reversi → „Brzi povraćaj (skener)"** — gust barkod iz ruke. Skinut je Google-ov čitač,
   sada ide isti put kao police. Ako promašuje: postoji prekidač za povratak, ali je za sada
   dostupan samo kroz alatke za programere — javi pa ga iznesem u ekran.
2. **Police i „neprekidno" skeniranje** — da nišan stoji iznad panela i da dodir izoštrava
   preko celog kadra.
3. **Bluetooth/žični čitač** dok je skener otvoren, u sve četiri ljuske.
4. **Telefon okrenut bočno i tablet** — da dugmad ostanu krupna.
5. **1.0 bez mreže posle „Resetuj aplikaciju"** u 3.0 — otvoriti `/m`, resetovati 3.0,
   proveriti da 1.0 i dalje radi offline.
6. **„Instaliraj aplikaciju"** u Chrome-u — ikona, ime, svoj prozor bez adresne trake.

**iPhone:**
7. **PDF iz instalirane aplikacije** (rešenje o odsustvu, karnet, evidencija GO) — mora se
   otvoriti sistemski list „Sačuvaj u Fajlove / Pošalji".
8. **Prilog iz „Files" sa pravim `.heic`** — mora doći poruka, ne tiha otprema.
9. **Portret fotografija** u pregledu priloga — da nije okrenuta.

**Oba:**
10. **`/mob/izvestaj` → „Slikaj"** — kamere ranije uopšte nije imao.
11. **Ćirilica u karnetu** sa telefona — da nema kvadratića.

---

## 5. Čeka odluku

- **Dugme za naknadno dodavanje fotografija na kartici incidenta.** Prijava kvara se posle
  snimanja zatvara; server dozvoljava naknadno prilaganje, ali u aplikaciji nema odakle.
  Mali posao, ali menja tok.
- **WEBP je otpao** uz HEIC (u bazi ga nema nijednog, aplikacija ga i tako pretvara u JPEG).
  Ako neko šalje direktno u tom formatu — javi, vraća se.
- **Prekidač za čitač barkoda** u ekran (danas samo kroz alatke za programere).

## 6. Ostaje kao dug

- Polja (`Input`/`Select`/`Textarea`/`ComboBox`/`SearchBox`) imaju istu `sm:` bolest kao
  dugme — pod `/mob` ih pokriva `.mob-scope`, ali **van `/mob`** (desktop ekrani na tabletu)
  padaju ispod 16px i telefon ih uveličava.
- Sticky zaglavlja u ~20 `/mob` ekrana nemaju `env(safe-area-inset-top)`.
- Prilozi opštih dokumenata (`odrzavanje.uploadMachineFile`, kadrovska, projektni biro)
  namerno nisu sužavani — docx/xlsx tamo može biti legitiman; to je poslovna odluka.
- Audio u Zahtevima i dalje ide po deklarisanom tipu (diktat-tok se nije dirao).
- 3.0 APK (Faza 3) — nije započet.
