# BigBit — glavna maska (navigacija) i mapa na 4.0

> Transkript **žive aplikacije** (RDP, 2026-07-08) — „Prva maska" BigBit-a (`Form_Prva maska`).
> Vendor: **Slaviša Đurić** (otud `SLAVISA`/`BIT CO.` u workgroup-u); Rev 9.6.1; baza `BB_T_26.MDB`.
> Ovo je **kompletan spisak funkcija komercijalnog ERP-a** = scope za 4.0. Svako dugme = forma čiji je
> code-behind već izvučen (`_extracted/OnLine_BigBit_VBA/`, 824 komponente). Dopunjuje
> [09-bigbit-online-domain-map.md](09-bigbit-online-domain-map.md) (analiza koda) vizuelnom/navigacionom strukturom.

## Zaglavlje
`Korisnik: Servoteh d.o.o.` · `Godina: 2026` · `OJ/OD: 0/0` · `Rev 9.6.1 (05.02.2015)` · `nenadj L 0` (nivo pristupa).

## Meni po sekcijama (svako = ekran/forma)

### RAZNO (konfiguracija / šifarnici)
Korisnici · Poreske stope · Grupe i podgrupe · Vrste dokumenata · Vrste naloga · Šeme za kontiranje ·
Cenovnik · KEPU Veleprodaja · Knjiga PK1 · KEPU Maloprodaja · Poslovi · Radni nalozi · Magacini · Kursna lista
→ **4.0:** config/masters + `tax`/`price_lists`; **KEPU** (knjiga prometa) i **Šeme za kontiranje** su regulatorne.

### IZLAZ IZ MAGACINA (analitika prodaje/izlaza)
Po artiklima · VP Analiza · po Kupcima · Odjava dobavljaču · VP Planiranje zaliha
→ **4.0:** sales/inventory izveštaji + planiranje zaliha (veza sa MRP-om iz 2.0).

### KOMITENTI (partneri)
Unos · Pregled · Vrste komitenata · Važni datumi · Unos plaćanja · Pregled plaćanja · Priprema plaćanja
· **Stare PDV knjige:** PDV Ulazne fakture · PDV Izlazne fakture
→ **4.0:** `customers` master + `payments` + istorijske PDV evidencije. (Napomena: komitenti su matični — u 2.0 read-only cache.)

### USLUGE (fakturisanje usluga)
Fakturisanje · Pregled fakture · Pregled e-Fakture
→ **4.0:** sales/billing (usluge) + **SEF** (e-Faktura, vidi [07 §8](07-bigbit-sef-efaktura.md)).

### REVERSI
Unos reversa · Pregled reversa
→ **4.0:** returns (komercijalni reversi — različito od proizvodnih reversa u 1.0).

### PDV obrazac
Unos naloga GK · POPDV
→ **4.0:** **PDV/POPDV** (regulatorno) + veza sa glavnom knjigom.

### ARTIKLI (roba)
Unos · Pregled · Lager lista · Kartice · Kartice profakture · Kartice porudžbine · Nabavka · Komisioni lager
· Komisione kartice · Komision-Zad/Odj · Ulaz/Izlaz po artiklima · Recepti za proizvodnju · Popis · Nalepnice
→ **4.0:** `items` master + zalihe/lager + **komision** (consignment) + **recepti** (BOM/proizvodnja — veza sa 2.0).

### IZVEŠTAJI / SERVIS
Unos izveštaja · Pregled izveštaja · GK izveštaj · Analiza prodaje
→ **4.0:** reporting sloj (trijaža na top ~30 kritičnih izveštaja).

### MAGACIN (robna dokumenta)
Ulaz · Izlaz · Knjiga Ulaza/Izlaza · **Knjiga e-Faktura** · **Nabavka (e-Faktura)** · Zbirovi po dok. ·
Profakture · Pregled profakture · Nivelacija zaliha · Obračun radnih naloga · Spec. radnih naloga ·
Naručivanje robe · Pregled narudžbine · Nar. robe (Prevod) · Zahtev ka dobavljaču
→ **4.0:** inventory/robna dokumenta (ulaz/izlaz, nivelacija, popis) + **procurement** (naručivanje, zahtev dobavljaču)
+ **e-Faktura knjige** (SEF inbox). „Obračun/Spec. radnih naloga" = veza sa proizvodnjom (2.0).

### PREDMETI (projekti/pisarnica)
Unos predmeta · Pregled predmeta · Kartica predmeta · Zahtevi za ponude od kupaca
→ **4.0:** `projects`/cases (matični — veza sa 2.0 `projects`); RFQ od kupaca.

### GLAVNA KNJIGA (dvojno knjigovodstvo)
Kontni plan · Unos naloga · Unos blagajne · Pregled naloga · Dnevnik · Bruto stanje · Kartica konta ·
Kartica analitike · Salda analitike · Otvorene stavke · Komitent po kontima · Unakrsni izveštaji ·
Salda po poslovima · Kartoteke-štampa · Prodavci - obračun
→ **4.0:** **finance/GL — kritični put** (kontni plan, nalozi, dnevnik, bruto bilans, otvorene stavke, saldakonti).

### Donji desni ugao
Tri ikonice (izvoz/slanje · dokument · alati/podešavanja) + veliko **„Kraj rada"** (izlaz).

## Šta ovo daje 4.0 planu
- **Potvrđen scope komercijale** (mapira se na domene iz [09](09-bigbit-online-domain-map.md) i
  [MODULI-MASTER-PLAN §4](../design/MODULI-MASTER-PLAN.md)): finance/GL, sales/fakturisanje, inventory/magacin,
  procurement, PDV/POPDV/KEPU, SEF e-Faktura, komision, predmeti.
- **Navigaciona struktura** (grupisanje menija) je koristan predložak za 4.0 UI grupisanje modula.
- **Nema POS/kase na ovoj masci** — potvrđuje da je fiskalizacija/kasa zaseban tok (van glavnog ERP menija);
  potvrditi da li se uopšte koristi (scope pitanje za 4.0).
- Svaki ekran ima izvučen code-behind → za bilo koji modul možemo tačno videti logiku dugmadi.

> **Za pun 1:1 dizajn** (kontrole/pozicije/natpisi svih 709 formi) — `SaveAsText` na RDP mašini (pravi nalog
> ima design-permisije koje lokalni `admin` nema); snippet u chat istoriji. Ovaj dokument pokriva glavni meni.
