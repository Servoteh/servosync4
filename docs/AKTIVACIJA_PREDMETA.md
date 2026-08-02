# Aktivacija predmeta — kako radi, gde živi i šta znači „dopuniti iz BigBita"

**Datum merenja:** 30.07.2026. (svi brojevi u dokumentu izmereni su tog dana na produkciji, dva puta
nezavisno). **Povod:** vlasnik traži da razume ekran „Sistem → Podešavanja → Predmeti", jer namerava
da tabelu koja stoji ispod njega dopunjava iz BigBita.
**Vezana odluka:** O-1 u [ODLUKE_SYNC_I_PRELAZ.md](ODLUKE_SYNC_I_PRELAZ.md) — do prelaza BigBit
poseduje komitente, predmete, artikle i glavnu knjigu; 4.0 poseduje tehnologiju, kvalitet, kadrovsku.

---

## 1. Suština u pet rečenica

**Aktivacija predmeta je kuratorska odluka — „ovaj predmet pratimo" — a ne činjenica prepisana iz
poslovnog sistema.** Ona živi u glavnoj bazi (`sy15-db`), u tabeli `production.predmet_aktivacija`,
kao dve nezavisne kvačice po predmetu: `je_aktivan` (ulazi u Praćenje proizvodnje i u plan
proizvodnje) i `je_projektovanje_montaza` (ulazi u Plan montaže i Projektni biro). Tri tabele su u
igri zato što je predmet fizički zapisan na tri mesta: kao red u kešu `public.bigtehn_items_cache`
(glavna baza, „spisak predmeta koji postoje"), kao red u `projects` (prod app baza, 4.0 domen), i kao
red aktivacije (glavna baza, „šta o njima mislimo"). Kvačica se **ne može staviti bez reda u kešu** —
RPC to izričito odbija sa `nepoznat predmet` (`production.set_predmet_aktivacija`, prva provera posle
gejta), pa je keš, a ne `projects`, prava ulazna vrata. I najvažnije: keš se puni **isključivo** iz
MSSQL baze `QBigTehn` preko bridge-a, taj izvor je zamrznut od 22.07.2026., i **ne postoji nijedan
put kojim BigBit danas piše u tu tabelu**.

---

## 2. Ekran — gde je, šta se vidi, ko sme

**Put u meniju:** Sistem → Podešavanja → **Predmeti**. To nije samostalna strana nego 10. tab od 15
na `/podesavanja`; deep-link koji radi u statičkom exportu je `/podesavanja?tab=predmet`
(`frontend/src/app/podesavanja/page.tsx:56` i `:134`; `frontend/src/lib/navigation.ts:660`, T-kod
`POD-PR`). Vlasnikov opis „servosync → podešavanja → predmeti" je tačan.

**Šta se vidi — 9 kolona:** ⭐ prioritet, Šifra (`broj_predmeta`), Naziv, Komitent, Aktivan,
Projektovanje i montaža, Planeri, Poslednja izmena (mejl + vreme), Napomena
(`frontend/src/app/podesavanja/_components/predmet-aktivacija-tab.tsx:449-461`, `:498-560`).

**Šta se NE vidi — status predmeta.** Ni „U TOKU"/„GOTOVO", ni datum zaključenja, ni broj radnih
naloga. RPC ih ne selektuje (`production.list_predmet_aktivacija_admin`, SELECT lista sadrži samo
item_id, broj_predmeta, naziv_predmeta, customer_name, dve zastavice, napomenu, autora i vreme).
Praktično: 5.802 zaključena predmeta izgledaju identično kao 1.824 u toku.

**Razmera i alati za pronalaženje.** Lista dolazi kao **jedan jsonb sa svih 7.626 redova**, bez
paginacije i bez virtualizacije (RPC nema `LIMIT`; `predmet-aktivacija-tab.tsx:465` renderuje ceo
filtrirani niz). Pretraga je klijentska i gleda **samo šifru i naziv** — ne komitenta, iako je kolona
Komitent prikazana (`:141-143`). Filter ima 4 vrednosti: Svi / Samo prioritet / Aktivni / Neaktivni
(`:426-435`).

**Nema masovnog režima.** Svaka izmena kvačice je jedan `window.confirm()` i jedan POST za jedan
predmet; jedina write ruta je `POST predmet-aktivacija/:itemId`
(`podesavanja.controller.ts:553`, `predmet-aktivacija-tab.tsx:166`, `:171`, `:183-188`). Ne postoji
„obeleži sve prikazane", ni uvoz iz fajla, ni dugme „osveži keš".

**Ko sme da menja — imenom.** Jedna jedina permisija `settings.predmet_aktivacija` otvara i čitanje
i pisanje (svih 9 ruta nosi istu, `podesavanja.controller.ts:482-554`). U aplikaciji je imaju samo
role **`admin`** (kroz ALL) i **`menadzment`** (`role-permissions.ts:107`, `:695`, `:746-747`; spec
`role-permissions.pb-profil-podesavanja.spec.ts:124`). Glavna baza istu odluku proverava ponovo:
`public.can_manage_predmet_aktivacija()` = admin ∪ menadzment po mejlu iz JWT-a. Na produkciji je to
**24 naloga**: 3 admina (nenad.jarakovic, nevena.knezevic, zoran.jarakovic) i 21 menadzment — među
njima `test@servoteh.com`, dva `gmail.com` naloga i `kontrola@servoteh.com`
(`SELECT email, role FROM public.user_roles WHERE COALESCE(is_active,true) AND role IN ('admin','menadzment')`).
Planer bez menadzment role **ne može** sam da uključi svoj predmet.

---

## 3. Tri tabele u dve baze (plus dve koje se lako pomešaju)

| Tabela | Baza | Redova (30.07.) | Piše | Čita |
|---|---|---|---|---|
| `public.bigtehn_items_cache` | sy15-db (glavna) | 7.626 | **samo bridge** posao `syncItems`, UPSERT po `id`, dnevno 06:00 lokalno (`bridge/src/jobs/syncItems.js:114`) | ekran Podešavanja, Plan montaže (`plan-montaze.service.ts:233`, `:896`), Projektni biro, Lokacije |
| `production.predmet_aktivacija` | sy15-db | 7.626 (110 `je_aktivan`, 22 `je_projektovanje_montaza`) | ekran Podešavanja kroz `set_predmet_aktivacija`; + okidač na kešu za nove redove | `pb_list_projects`, `get_aktivni_predmeti`, `get_pracenje_portfolio`, `loc_order_no_in_active_proj_mont` |
| `predmet_aktivacije` (množina!) | **servosync-pg** (prod app, 4.0) | 7.602 (86 `is_active`, **0** `is_projektovanje_montaza`) | **niko** — nema ni rute ni koda (`grep 'INSERT INTO predmet_aktivacije'` → prazno) | Praćenje (`pracenje-read.service.ts:395`, `:552`) i **plan proizvodnje** (`plan-proizvodnje-read.service.ts:532`) |
| `projects` | servosync-pg | 7.626 (1.824 „U TOKU" / 5.802 „GOTOVO") | BigBit .mdb lanac (`bigbit-mdb-import.service.ts:2224`) | 4.0 moduli |
| `public.projects` | sy15-db | **23** (22 sa `bigtehn_item_id`) | okidač `tr_predmet_pb_project_sync` | `pb_list_projects()` → Plan montaže, Projektni biro |

Dve stvari iz ove tabele su ključne i lako se prećute:

1. **Ekran piše u glavnu bazu, a pogon čita app bazu.** Podešavanja → `production.predmet_aktivacija`
   (`podesavanja.service.ts:364` i `:630`); Praćenje i plan proizvodnje → `predmet_aktivacije` u
   servosync-pg. **Nijedna linija koda ne prenosi vrednost između njih i ne postoji sync posao.**
   Lanac je trajno raskinut, ne privremeno razdešen. Merena razlika: sy15 ima 110 aktivnih, app 86,
   i app skup je **strogi podskup** — nedostaju tačno **24 najnovija predmeta** (id 10461-10466,
   10468-10474, 10476-10486) koji u app bazi **nemaju nijedan red**. Oni su u glavnoj bazi upaljeni,
   a u pogonu nevidljivi. Aktivacija u app bazi se **ne može** izvesti klikom — kontroler Praćenja
   nema rutu za aktivaciju (`pracenje.controller.ts:80-304`).
2. **Identitet predmeta drži konvencija, ne baza.** Isti broj je `bigtehn_items_cache.id`,
   `predmet_aktivacija.predmet_item_id`, `projects.id` i `predmet_planeri.item_id`, a **nema nijednog
   stranog ključa** koji to garantuje (`pg_constraint` nad `predmet_aktivacija` daje samo PK i FK na
   `users`; `projects` u prod app bazi nema ni FK ni okidač — proveren `pg_trigger` direktno na toj
   bazi, prazno).

---

## 4. Lanac od klika do upisa — i brane koje mogu da odbiju

1. Korisnik otvori `/podesavanja?tab=predmet`. **Brana 1:** tab se ne renderuje bez
   `settings.predmet_aktivacija` (`page.tsx:56`).
2. Frontend povuče listu → `GET predmet-aktivacija` → `SELECT public.list_predmet_aktivacija_admin()`
   (`podesavanja.service.ts:364`). `public.*` je tanka SECURITY DEFINER omotnica nad
   `production.list_predmet_aktivacija_admin()`. **Brana 2:** u telu je `IF NOT
   can_manage_predmet_aktivacija() THEN RAISE EXCEPTION 'forbidden' ERRCODE 42501`.
3. Lista se gradi `FROM public.bigtehn_items_cache i LEFT JOIN production.predmet_aktivacija pa`, sa
   `COALESCE(pa.je_aktivan,false)`. **Posledica:** predmet bez zapisa aktivacije se vidi, ali sa
   obe kvačice prazne. Komitent je `LEFT JOIN` na `bigtehn_customers_cache` i pada na prazan string —
   danas **125 predmeta** ne mogu da razreše komitenta (6.251 komitent u kešu).
4. Klik na kvačicu → `window.confirm()` → `POST predmet-aktivacija/:itemId`. **Brana 3:** Nest guard
   `@RequirePermission(SETTINGS_PREDMET_AKTIVACIJA)` (`podesavanja.controller.ts:553`).
5. Backend zove `SELECT public.set_predmet_aktivacija(...)` named-argumentima
   (`podesavanja.service.ts:619-631`). **Brana 4:** gejt `forbidden` (42501) — isti kao gore.
   **Brana 5:** `IF NOT EXISTS (SELECT 1 FROM public.bigtehn_items_cache WHERE id = p_item_id) THEN
   RAISE EXCEPTION 'nepoznat predmet'`. Ovo je jedina zaštita integriteta — FK ne postoji.
6. Upis: `INSERT ... ON CONFLICT (predmet_item_id) DO UPDATE`. **Zamka koja se mora znati:**
   `je_aktivan = EXCLUDED.je_aktivan` **uvek prepisuje**, dok `napomena` i `je_projektovanje_montaza`
   imaju NULL = „zadrži staro" (`CASE WHEN p_... IS NULL THEN ...`). Frontend to kompenzuje ručno i
   sam to komentariše: „`aktivan` se MORA slati (RPC uvek prepisuje je_aktivan)"
   (`predmet-aktivacija-tab.tsx:193-195`, `:206-208`).
7. Autor izmene: `azurirao_user_id = auth.uid()`. **Provereno da radi** — 67 redova ima nenulti
   autora, poslednji 16.07.2026. 21:35. Revizijski trag postoji.
8. Audit: okidač `trg_audit_predmet_aktivacija` (AFTER INSERT/UPDATE/DELETE, FOR EACH ROW) →
   `audit_row_change()`. Backend to prikazuje kroz `v_settings_audit_log`
   (`podesavanja.service.ts:370`). **Jedna izmena = jedan audit red.**
9. Ako su **obe** zastavice true → okidač `tr_predmet_pb_project_sync` →
   `production.sync_pb_project_from_predmet(...)` **sam kreira red** u `sy15-db.public.projects` sa
   `status='active'` (ili prevezuje postojeći legacy projekat po normalizovanoj šifri). Kvačica
   „projektovanje i montaža" nije filter — ona **stvara projekat**.

**Poznati bug u istom ekranu (⭐ prioritet).** Backend vraća `{ data: { itemIds, max } }`
(`podesavanja.service.ts:647-653`), frontend čita `data.data.ids`
(`api/podesavanja.ts:137-140`, `predmet-aktivacija-tab.tsx:102`), a `apiFetch` ne prevodi imena
(`api/client.ts:194`). Zato je `prioIds` **uvek prazan**: ekran piše „Top prioritet: 0/15" (imenilac
15 je tačan — `predmet_plan_prioritet_settings.max_count=15`), zvezdica se ne prikazuje nigde, filter
„Samo prioritet" daje praznu listu, a **prvi klik na „+ Dodaj u prioritet" pošalje jednočlanu listu i
PUT trajno prepiše serversko stanje** (na produkciji je to jedan red: predmet 9068, slot 0). Isto
važi za „Vrati prethodnu listu" (`:307`). Isti nesklad postoji i u glavnom repou.

---

## 5. KO PUNI KEŠ — najvažnije poglavlje

**Mehanizam postoji i ima ime.** `servoteh-bridge` (systemd `--user` na ubuntusrv), posao
`syncItems`, jedini pisač u `public.bigtehn_items_cache`: `upsertChunked('bigtehn_items_cache',
payload, 'id')` (`bridge/src/jobs/syncItems.js:114`). Raspored: **dnevno 06:00 po beogradskom
(04:00 UTC)** (`config.js:85`, `TZ=Europe/Belgrade`). Radi neprekidno — `bridge_sync_log` pokazuje
14/14 uspešnih prolaza od 17.07. do 30.07.

**Izvor NIJE BigBit.** Izvor je MSSQL baza **`QBigTehn`, tabela `Predmeti`**
(`FROM Predmeti WHERE IDPredmet IS NOT NULL`; `bridge/.env: BIGTEHN_SQL_DATABASE=QBigTehn`). Nijedna
linija u `backend/src` ne piše u keš — grep daje 11 pogodaka, svi čitanja. Zato ga pretraga po repou
nikad nije našla: pisač nije u monorepou.

**⛔ Izvor je zamrznut od 22.07.2026.** Dokazi: `max(modified_at)` u kešu = 2026-07-22 08:47:03+00;
`rows_updated` stoji na 7617 od 23.07. sedam dana zaredom; najviši bridge-om donet predmet je
id 10477 / broj 10005, otvoren 21.07.; a skripta novog lanca to izričito zapisuje — „prenos iz
BigBita u QBigTehn se više ne radi, poslednji uspešan prolaz 22.07.2026 07:14… izvor mrtav osam
dana, i to niko nije video jer uvoz bajatih podataka i dalje javlja uspeh"
(`bigbit-mdb-export.sh:80-89`).

**Zeleni log je lažna uteha, i to se može dokazati strože nego datumom.** Metrika „otvorenih" u
bridge-u broji `status === 'OTVOREN'` (`syncItems.js:108`), a u podacima **ne postoji nijedan**
'OTVOREN' — samo 'U TOKU' (1.824) i 'GOTOVO' (5.802). Ta metrika je uvek nula. Dakle statusnu
semantiku niko nije verifikovao od kad je sync napisan; log meri da li je bridge **pročitao**
QBigTehn, a ne da li u njemu ima čega novog.

### Šta to znači za predmet otvoren sutra u BigBitu

**Neće stići do kvačice.** Lanac BigBit → QBigTehn → keš → aktivacija je prekinut na **prvoj karici**,
a bridge svakodnevno verno prepisuje isti zamrznut snimak. Novi lanac napravljen danas
(BigBit `.mdb` → staging → `projects`) **ne dotiče keš**: on upisuje u `projects` u servosync-pg
(`bigbit-mdb-import.service.ts:2224-2228`, „`bb_mdb_stage_predmeti` -> `projects`, ISKLJUČIVO UPSERT
po `id`"), dok kvačica traži red u `bigtehn_items_cache` u glavnoj bazi. **Most između ta dva puta u
repou ne postoji.** Uz to je i taj novi lanac trenutno u padu:
`bigbit-mdb-export.service` je `failed since 2026-07-30 20:05:12 UTC`, sa porukom „BIGBIT JE
ISPORUČIO ISTI FAJL PONOVO — bajt-u-bajt jednak već obrađenom drop-u 9". Drugi kvar na istom mestu —
izvoz na BigBit računaru ne radi. Razlika je što ovaj lanac grešku **glasno javlja**; to je jedina
odbrana koja je proradila.

**Dve dobre vesti.** (a) Ručno upisani redovi **preživljavaju** noćni prolaz — sync je čist upsert
bez ijednog `DELETE` (`db/supabase.js:40`). (b) Okidač na kešu reaguje **samo na INSERT**
(`pg_trigger.tgtype = 5`), pa je dnevni prolaz za 7.617 postojećih redova UPDATE → **kvačice se ne
gaze**, i promena statusa u izvoru ne dira `je_aktivan`. Cena istog svojstva: obrisan predmet u
izvoru zauvek ostaje u kešu, a zapis aktivacije za red koji ispadne postaje siroče koje niko ne
čisti (danas siročića nema — 7.626 = 7.626).

**Isključeni lažni tragovi.** Nijedna baza-funkcija ne piše u keš (svih 10 funkcija koje ga pominju
samo čitaju); nijedan od 8 `cron.job` poslova ne dotiče predmete; druga instanca bridge koda
(`bridge-scada`) ima sve sync poslove ugašene (`ENABLE_JOB_CATALOGS=false`). Od 23 tabele
`bigtehn_*_cache`, **samo `items` ima okidač** — obrazac „keš + auto-aktivacija" je unikat za
predmete, komitenti ga ne ponavljaju.

**Odvojen signal iste bolesti:** poslovi `production_*` (work_orders, lines, launches, approvals,
tech_routing, part_movements) vraćaju `rows_updated = 0` na svakih 15 minuta, sistematski. QBigTehn je
mrtav i za proizvodne podatke, ne samo za predmete. To zahteva zasebnu proveru.

---

## 6. Šta zastavice otvaraju i zatvaraju

Postoje **četiri** nezavisne oznake, ne dve, i dva različita prava nad njima.

### `je_aktivan` — 110 od 7.626 (101 kuratorskih + 9 današnjih od okidača)

Sama, bez druge zastavice, otvara: `production.get_aktivni_predmeti()`,
`production.get_pracenje_portfolio()` (CTE `active ... WHERE pa.je_aktivan IS TRUE` — dakle i **KPI
brojači** `ukupno_predmeta`, `problemi_total`, `prosecan_op_napredak` računaju se samo nad aktivnim
skupom), i **pravo na ↑↓ rangiranje** — `set_predmet_prioritet`/`shift_predmet_prioritet` dižu
`predmet nije u aktiviranom skupu za pracenje` (ERRCODE 23514) za neaktivan predmet.

**Neaktivnost znači više od „ne prikazuj."** Presuda M7 u
`plan-proizvodnje-read.service.ts:47` i `:532` gejtuje **sve planerske liste** na
`EXISTS (... predmet_aktivacije pa WHERE pa.project_id = wo.project_id AND pa.is_active IS TRUE)`
(zamena za sy15 whitelist `production_active_work_orders`; izuzetak je samo TP-modal sa
`includeInactivePredmet=true`). Radni nalozi neaktivnog predmeta **ne ulaze u plan, ne dodeljuju se
mašinama, ne broje se u operativnim listama**. To je isključenje iz pogona, ne kozmetika — i tamo se
danas nalazi 24 nova predmeta iz §3.

### `je_projektovanje_montaza` — 22 od 7.626

Čita se na **tačno dva mesta**, oba u preseku sa `je_aktivan` (iscrpna pretraga `pg_proc`/`pg_views`/
`pg_policies`: 19 funkcija pominje aktivaciju, samo dve čitaju drugu zastavicu):

- `public.pb_list_projects()` — `INNER JOIN`, dakle predmet bez obe upaljene zastavice **tiho
  ispada, bez greške**. Funkcija danas vraća 22 reda, i to iz `sy15-db.public.projects` (23 reda),
  ne iz keša. Potrošači: `plan-montaze.service.ts:94`, `projektni-biro.service.ts:68`.
- `public.loc_order_no_in_active_proj_mont(p_order_no)` — **savetodavna** provera pri unosu u
  Lokacijama (`locations.service.ts:775-784`, FE `api/lokacije.ts:265`). Nema nijedan poziv unutar
  baze, nijednu politiku, nijedno CHECK ograničenje — ne može odbiti upis.

Svih 22 su prepoznatljivi veliki projekti (7701 Linije za termičku obradu 2.566 RN, 9400 Košuljice
936, 8069 840, 9000 Perun 588, 8034/8035 Servotransfer prese), svi 'U TOKU'. To potvrđuje da je
oznaka ručna kuratorska odluka. **Okidač je nikad ne postavlja** — i to je jedina ispravna stvar koju
okidač radi, jer time Plan montaže i Lokacije ostaju zaštićeni od svake masovne aktivacije.

Gde korisnik vidi objašnjenje kad predmeta nema: **nigde, osim na jednom mestu.** Ručni alert posle
kreiranja projekta (`montaza/_components/meta-modals.tsx:135-145`) kaže da projekat neće biti vidljiv
dok se predmet ne aktivira za projektovanje/montažu. Svuda drugde je gubitak tih.

### ⭐ prioritet — treća oznaka, i ona je razdvojena

Živi u `production.predmet_plan_prioritet` (predmet_item_id, slot), maksimum iz
`predmet_plan_prioritet_settings.max_count` (danas **15**). `set_predmet_plan_prioritet(int[])`
proverava samo gejt, duplikate, brojnost i postojanje u kešu — **ne** proverava `je_aktivan`. Dakle
⭐ se može staviti na neaktivan predmet, dok ↑↓ prioritet to izričito zabranjuje. Ta nesimetrija je
verovatno nenamerna. Svaka izmena je pun prepis (`DELETE ... WHERE true` pa ponovni upis), uz audit
snapshot (`ppp_audit_dml`, `ppp_audit_truncate`). Jedini funkcionalni potrošač sy15 liste su
**sastanci** (`sastanci.service.ts:572-587`) — dakle menjanje ⭐ menja dnevni red sastanka. A vrednosti
se razlikuju: sy15 ima **1** red (9068), app `predmet_aktivacije.plan_priority` ima **9**, i Praćenje
čita app (`pracenje-read.service.ts:1344`, uz sopstveni TODO na `:1358`).

### ↑↓ prioritet Praćenja — četvrta oznaka, strože pravo

`production.predmet_prioritet.sort_priority` (122 reda). `set_predmet_prioritet` i
`shift_predmet_prioritet` zahtevaju `current_user_is_admin()`, **ne** `can_manage_predmet_aktivacija()`;
u 4.0 je to permisija `pracenje.prioritet` = **samo admin** (`permissions.ts:238`,
`role-permissions.ts:569-571`). Menadzment sme da aktivira predmet i da stavi ⭐, ali **ne** sme da ga
pomeri ↑↓.

---

## 7. Vlasnikova namera „dopuniti iz BigBita" — ocena

Prvo treba razdvojiti dva vrlo različita čitanja, jer menjaju ceo odgovor:

- **(A) „dopuniti keš novim predmetima iz BigBita"** — to je normalan posao sinca. Ne traži novu
  semantiku; traži da se popravi mrtav lanac (i, verovatno, da se preusmeri sa QBigTehn-a na BigBit
  staging, jer BigBit vodi: 10014 vs 10005).
- **(B) „dopuniti aktivaciju iz BigBita, tj. da BigBit određuje ko je aktivan"** — to je nova
  semantika i traži odluku. Merenja ispod govore protiv.

### BigBit ne drži ovu informaciju

Tabela `Predmeti` u BigBitu **nema kolonu `Aktivan`** ni „pratimo". `Aktivan` u BigBitu postoji, ali
na **artiklima** (`R_Artikli.Aktivan`, `CheckAktivniArtikli`) — forma Predmeti ima 31 polje i među
njima ga nema (`_extracted/QBigTehn_UI_parsed/Predmeti.md`). Reč „montaža"/„projektovanje" ne postoji
**nigde** u BigBit VBA kodu (`grep -rin "montaz\|montaž"` → bez izlaza), pa
`je_projektovanje_montaza` BigBit ne može da dopuni ni u principu.

### Tri BigBit surogata — nijedan ne pogađa 110

| Kandidat | Definicija | Daje |
|---|---|---|
| `CheckAktivni` (BigBit-ov pojam) | `DatumZakljucenja IS NULL` (`PredmetiPoDokumentima.sql:4`) | **2.540** (23×) |
| `Status = 'U TOKU'` | slobodan tekst bez šifarnika | **1.824** (16,6×) |
| `NeZavrseniPredmeti` (BigBit-ova logika) | nedovršene *značajne* operacije na RN-u | **5** (i sva 5 su već aktivna) |
| **danas** | kuratorski | **110** |

Svih 101 zatečenih aktivacija su 'U TOKU' i nezaključene — dakle **strogi podskup (5,6%)** BigBit-ovog
„nije završen".

### Odlučujuće merenje: `je_aktivan` ≠ „nije završen"

Od 1.824 predmeta 'U TOKU', **1.757 nema ni jedan radni nalog**; samo 67 ih ima. Preslikavanje
statusa dodalo bi ~1.714 **praznih** redova u Praćenje. Šteta nije računska — radni nalozi rastu
skromno 7.092 → 9.150 (1,29×) — nego korisnička: lista ide 110 → 1.824, i 20 predmeta koji nose sav
posao utopi se u šum, a rangiranje po prioritetu (122 reda) izgubi smisao.

Dva kontraprimera protiv **svake** automatike:

- Predmet **9466 / broj 8069 „linija za sužavanje"** ima `datum_zakljucenja = 2024-06-11`, a nosi
  **840 radnih naloga** i aktivan je + projektovanje/montaža. Pravilo po datumu zaključenja ubilo bi
  ga.
- Jedini stvarni propust u zatečenoj kuraciji su **2 neaktivna predmeta sa 1.950 RN**: 8693 / 7351
  „Sistem za manipulaciju indukcionog…" (1.467 RN) i 9301 / 7919 „Pomoćni alati za Perun" (483 RN).
  Ostalih 45 neaktivnih sa RN-om su sitne usluge (3-9 RN). **To se rešava sa dva klika, ne masovnim
  uvozom.**

### Kanal je i uzak i prazan

`work_type_id` je NULL za svih 7.617 sinhronizovanih redova (9 nenultih su isključivo današnji ručni
upisi), `department_code` 0/7.626, `rok_zavrsetka` **0/7.626** iako ga dva RPC-a prikazuju u Praćenju.
Sync te kolone traži (`syncItems.js:48-49`, `:54`) — dolaze prazne. Dakle „vrsta posla = MONTAŽA" kao
izvor aktivacije **danas ne postoji u podacima**. `Predmeti.NextAction` postoji i sinhronizuje se u
`projects.next_action`, ali nije u kešu i nema nijednu VBA liniju koja ga postavlja — slobodan tekst
bez discipline unosa.

### Preporuka

**BigBit ne treba da dobije vlast nad aktivacijom.** Tri poteza, po redu vrednosti:

1. **Skloniti bezuslovni `je_aktivan = true` iz okidača** `tg_predmet_aktivacija_default`. On već sada
   tiho aktivira ~26 novih predmeta mesečno (≈ +310/god), od kojih 1-2 to zaslužuju, i jedini je
   izvor 8 aktivnih GOTOVO predmeta — u 9 od 9 današnjih slučajeva to je zagađenje koje smo sami
   uneli. **Ali:** ako se okidač ukine bez zamene, novi predmeti dolaze neaktivni; a ako se keš ikad
   popuni preko `COPY`/restore koji zaobilazi okidače (`session_replication_role = replica`), 7.626
   predmeta odjednom nema zapis i Plan/Praćenje se prazne. To je nedokumentovana zavisnost koju treba
   zapisati pre nego se dira.
2. **Popraviti ekran, ne semantiku.** Filter po statusu, prikaz broja radnih naloga, paginacija,
   pretraga po komitentu. Pravi problem nije „ko poseduje istinu" nego „ekran od 7.626 redova bez
   statusa se ne može koristiti" — to je najverovatniji uzrok vlasnikove frustracije. Uz to popraviti
   `ids`/`itemIds` bug, jer on danas može trajno da obriše ⭐ listu.
3. **BigBit koristiti kao PREDLOG, nikad kao upis** — bedž „U TOKU / ima N radnih naloga" pored
   predmeta, a odluka ostaje čoveku.

### Skriveni troškovi, ako se ipak ide na automatiku

- **`set_predmet_aktivacija` uvek prepisuje `je_aktivan`.** Skript koji pošalje pogrešan ili
  izostavljen `p_aktivan` **tiho gasi** postojećih 110 aktivnih i, kroz to, 22 projektna. Nema
  greške — samo prazan Plan montaže sledećeg jutra.
- **Bridge ne može da pozove taj RPC kakav je danas.** Gejt čita `auth.jwt()->>'email'` i traži red u
  `user_roles`; bridge ima service role bez email claim-a. Ostaju tri puta: (a) servisni identitet u
  `user_roles`, (b) **nov namenski RPC** sa sopstvenim gejtom i audit poljem „izvor = bigbit",
  (c) direktan INSERT/UPDATE u tabelu — koji preskače **i** gejt **i** proveru `nepoznat predmet`.
  (c) je najlakše i najgore.
- **Audit raste po redu.** Masovna dopuna generiše jedan audit zapis po predmetu; za ~7.600 redova to
  treba raditi u serijama i prethodno proveriti rast tabele.
- **Rizik sudara ključeva.** Ako se BigBit → QBigTehn prenos ikad popravi, QBigTehn će sam dodeliti
  `IDPredmet` predmetima 10006-10014, a ručni redovi su već zauzeli id 10478-10486. Upsert po `id`
  tada prepisuje ručni predmet **drugim** predmetom, a `predmet_aktivacija` i `predmet_planeri`
  ostaju vezani za pogrešnu stvar.
- **Dopuna bez komitenata degradira ekran.** 125 predmeta već ima praznu ćeliju Komitent, a pretraga
  po komitentu ne postoji.

---

## 8. Šta je urađeno 30.07.2026. i zašto

Danas je BigBit bio na predmetu **10014**, a QBigTehn i 4.0 na **10005** — devet predmeta razlike.
Ta devetorka je **ručno** upisana kroz tri tabele, čime je zatvoren raspon 10006-10014:

| Korak | Tabela | Rezultat |
|---|---|---|
| 1 | `servosync-pg.projects` | 7.617 → **7.626** (9 novih: 5 „U TOKU", 4 „GOTOVO") |
| 2 | `sy15-db.public.bigtehn_items_cache` | 7.617 → **7.626** (id 10478-10486, `synced_at = 20:26`) |
| 3 | `production.predmet_aktivacija` | 7.617 → **7.626** — **bez ijednog našeg upisa** |

**Zašto je korak 2 bio neizbežan.** Bez reda u kešu kvačica se **ne može ni staviti**: RPC diže
`nepoznat predmet`. Upis u `projects` nije dovoljan i nikad nije bio — ta tabela nema ni jedan strani
ključ ni okidač, i ekran je ne čita. Dakle bez keša bi devet novih predmeta postojalo u 4.0 a bilo
nevidljivo i neaktivabilno u Podešavanjima.

**Šta je okidač uradio sam.** Devet zapisa aktivacije napravio je
`tr_predmet_aktivacija_after_item_cache_ins` → `tg_predmet_aktivacija_default()`, sa
`VALUES (NEW.id, true, false, NULL, now())` — bez ijednog `IF`. Dakle: **svi su automatski postali
`je_aktivan = true`** (110 = 101 + 9), a nijedan nije `je_projektovanje_montaza` (ostalo 22), pa nijedan
nije ušao u Plan montaže i nijedan nije napravio red u `sy15-db.public.projects`. `azurirao_user_id`
je NULL, pa kolona „Poslednja izmena" za njih pokazuje „—".

**Šta ostaje neurađeno posle ovoga.** (a) U app bazi `predmet_aktivacije` ta devetorka **nema red**,
kao ni 15 predmeta pre njih — ukupno 24 predmeta koja su u glavnoj bazi upaljena, a za Praćenje i za
plan proizvodnje **ne postoje**; to se ne može popraviti klikom. (b) Ti redovi su „siročići" koje
nijedan sync ne osvežava — promena naziva ili statusa u BigBitu neće doći do njih, jer ih upsert ne
dira. (c) Sutra se rupa otvara ponovo, jer nijedan od dva lanca ne radi.

Za istoriju: **7.468 predmeta** je postavljeno na `je_aktivan = false` **26.04.2026.**, sa
`azurirao_user_id IS NULL` — dakle masovnom migracijom, ne kroz ekran (ekran to i ne može, POST je po
jednom predmetu); plus 48 redova sa stvarnim autorom 26-29.04.

---

## 9. Otvorena pitanja i šta NE znamo

**Traži odluku vlasnika:**

1. **Koje je čitanje tačno — (A) dopuna keša ili (B) BigBit određuje aktivaciju?** Ovo se pita prvo,
   jer menja celu preporuku.
2. **Gde se predmet stvarno otvara — u BigBitu ili u QBigTehn-u?** Ako u BigBitu, put do kvačice se
   mora preusmeriti na BigBit staging; ako u QBigTehn-u, popravlja se samo prenos. Merenje (10014 vs
   10005) ide u prilog prvom, ali to može biti i posledica prekida.
3. **Ko je i zašto ugasio prenos BigBit → QBigTehn 22.07.2026.** — namerno (priprema gašenja) ili
   kvar? Nije nađen nijedan zapis o odluci. Od toga zavisi da li QBigTehn lanac popravljamo ili
   dokrajčujemo.
4. **Da li 24 zaostala predmeta treba da postanu vidljiva u Praćenju i planu proizvodnje?** Ako da, to
   je backfill u app bazi, ne klik.
5. **Ko je budući vlasnik aktivacije** — glavna baza ili app baza? Danas pisac postoji samo za sy15
   stranu, a čitaoci pogona samo za app stranu.
6. **Da li ⭐ sme da stoji na neaktivnom predmetu?** Dve funkcije se ne slažu; verovatno nenamerno.
7. **Da li su 8693/7351 (1.467 RN) i 9301/7919 (483 RN) namerno neaktivni** ili propust kuracije?
8. **Da li je `datum_zakljucenja = 2024-06-11` na predmetu 9466/8069 pogrešan**, ili projekat još ide?
   Odgovor odlučuje da li to polje ikad sme da nosi automatiku.

**Nije izmereno i ne treba se pozivati na to kao na znanje:**

- **MSSQL `QBigTehn.Predmeti` nije upitan ni jednom.** Tvrdnja „izvor je mrtav od 22.07." je jaka
  indicija (zamrznut `modified_at` + konstantan `rows_updated` + poruka u skripti), ali bez
  `SELECT max(IDPredmet), max(DatumIzmene) FROM Predmeti` nije merenje. Isto važi za rizik sudara
  ključeva 10478-10486.
- **Kojim sredstvom su ta 9 redova upisana u keš u 20:26** — nema audita nad kešom, `azurirao_user_id`
  je NULL (okidač), postupak nije zapisan i **nije ponovljiv**.
- **Da li bi BigBit dopuna uopšte okinula okidač** — zavisi od načina upisa (INSERT vs COPY sa
  isključenim okidačima vs UPDATE). Nema šta da se izmeri jer put ne postoji.
- **Šta frontend radi sa `result = false`** iz `loc_order_no_in_active_proj_mont` (poruka, blokada,
  boja) — `api/lokacije.ts:265`. Pošto je danas samo 22 predmeta „projektovanje + montaža", vredi
  proveriti da li ta validacija u Lokacijama lažno odbija legitimne brojeve naloga.
- **Zašto su `IDVrstaPosla` i `RJ` prazni** u QBigTehn `Predmeti`, iako forma BigBita odbija čuvanje sa
  `IDVrstaPosla = 0`? Čita li sync drugu tabelu nego forma, ili se predmeti unose zaobilazeći formu?
  Šema QBigTehn SQL Servera nije čitana.
- **Da li ikoga smeta da je `rok_zavrsetka` uvek prazan** (0/7.626) iako se prikazuje u Praćenju.
- **Da li se `napomena` u `predmet_aktivacija` uopšte koristi** — popunjenost nije merena; ako je
  popunjena, to je dodatni dokaz kuratorske namere koju automatika ne sme da pregazi.
- **Da li se `ids`/`itemIds` nesklad vidi i kod drugih potrošača ⭐ liste** (Plan montaže, PB,
  Lokacije). Ako oni čitaju DB funkciju direktno, oni **vide** predmet 9068 kao prioritetan a
  Podešavanja ga ne vide — nesaglasnost između ekrana i pogona. Nije provereno.
- **`production_*` sync poslovi vraćaju 0 redova svakih 15 minuta.** Zaslužuje zasebnu analizu — ovaj
  dokument to samo beleži.

**Zatvoreno večeras (da se ne otvara ponovo):** revizijski trag **postoji** (67 redova sa autorom,
poslednji 16.07. 21:35 — `withUserMapped` postavlja kontekst); masovno isključenje je bilo
**26.04.2026.**, migracijom; **osirotelih** zapisa aktivacije danas **nema** (7.626 = 7.626);
`servosync-pg.projects` **nema okidač** (proveren `pg_trigger` direktno na toj bazi); od 23
`bigtehn_*_cache` tabele **samo `items` ima okidač**.
