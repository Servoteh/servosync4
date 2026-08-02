# Remedijacija po BigBit studiji — integracija tri paketa (A, B, C)

**Datum:** 2026-07-26 · **Grana:** `feat/4.0-batch-c` (nad tekućim stablom)
**Izvor istine:** [BIGBIT_KONTA_I_SEME_KNJIZENJA.md](BIGBIT_KONTA_I_SEME_KNJIZENJA.md) ·
[BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md](BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md) ·
[BIGBIT_ULAZNE_FAKTURE.md](BIGBIT_ULAZNE_FAKTURE.md) · [BIGBIT_ZR_MOTOR.md](BIGBIT_ZR_MOTOR.md)

Tri agenta su radila stavke A (registri), B (konto 1329 / nivelacija) i C (avansi N:M + avans po
ugovoru); dva nezavisna pregleda po stavci dala su nalaze. Ovaj dokument beleži **šta je posle
pregleda promenjeno, šta je odbačeno i zašto, i šta OSTAJE nedovršeno.**

> ⚠️ **Incident tokom integracije (obavezno pročitati):** u 22:54:59 je *druga, paralelna sesija* nad
> istim radnim stablom vratila sve praćene fajlove na `HEAD` (`git checkout`/rewind). Time je nestao
> nekomitovan rad sva četiri agenta. Rad paketa A/B/C je **vraćen iz `~/.claude/file-history`**
> snimaka (schema.prisma, posting.service, nivelacija.service, advance-invoice.service(+spec),
> fakturisanje.service) i proveren testovima. **Nije vraćen** DTO avansa (`dto/advance-invoice.dto.ts`
> — rekonstruisan ručno prema servisu i specu) i **nije vraćen paket ZR** (v. §5). Pravilo iz memorije
> „commit samo u worktree-u / rezervacija zahteva" ovim je potvrđeno još jednom.

---

## 1. Stavka A — registri (`saldakonto_accounts`, `accounting_schemes`)

Migracija: `prisma/migrations/20260726100000_seed_saldakonto_i_seme_kontiranja/migration.sql`
(izmenjena u odnosu na verziju koju su pregledi videli — nije bila ni komitovana ni na produkciji).

### Ispravljeno (nalazi VISOK)

| # | Nalaz | Ispravka |
|---|---|---|
| A-1 | `4300`/`4302` (primljeni avansi KUPACA) seedovani kao `side='payable'` → `payment-preparation.selectDue` ih nudi kao **dospele obaveze**; kupčev avans može u nalog za prenos i e-banking | Uvedena kolona **`saldakonto_accounts.partner_scope`** (`customer` \| `supplier`). `selectDue` sada traži `side='payable' AND partnerScope='supplier'` → biraju se samo `4350`/`4360`. `NULL` scope se namerno **ne** uzima (izlaz novca ide samo po potvrđenom podatku). |
| A-2 | Šeme **30 (IFUSL)** i **31 (KNO)** knjiže kupca na `2020`, konto koji **nije** u saldakonto registru → uslužna faktura i knjižno odobrenje nevidljivi u otvorenim stavkama/aging-u/IOS-u/opomenama/limitu; odobrenje ne umanjuje dug sa `2040` | Šeme **30 i 31 se NE seeduju** (isti postupak kao za 37/38). Doc §7.2/S6 traži ispravku na `4700`/`4710` **i** `2040`/`6040` uz **potvrdu knjigovođe**, a §6.6 pokazuje da stvarni prihod od usluga ide na `6140`, ne na `6121` iz šeme 30 — izbor konta je poslovna odluka. Efekat izostavljanja danas je nula (izlazne fakture i odobrenja knjiži `sales/fakturisanje.service` sopstvenim kontima; `document_types.posting_template = 0`). |

### Ispravljeno usput (nalazi SREDNJI, isti uzrok)

- `fakturisanje.assertCreditLimit` i `kamata.service` sada filtriraju `partner_scope='customer'` —
  dati avansi dobavljačima (`1520/1521/1530`) više ne sužavaju kreditni limit kupca i ne ulaze u
  osnovicu zatezne kamate.
- `open-items.agingByPartner` **bez izabranog konta** filtrira `partner_scope='customer'` — aging je
  izveštaj naplate; ranije su se potraživanje (2040) i naša obaveza (4350) prema istom partneru
  netirali u jedan iznos i bucket. Sa izabranim kontom filter se ne primenjuje (svesni izbor korisnika).

### Odbačeno / nije menjano

- **Devet saldakonto konta i `control_account` mapiranje ostaju doslovno po doc §5.1/§7.3-SK2**
  (1520→152 … 4360→436). Nalaz „avans↔faktura se ne mogu upariti jer `assertSamePartnerScope` traži
  jednak `control_account`" je **tačan, ali je posledica specifikacije**, ne omaška: menjanje
  kontrolnih konta (npr. 4300→204) je knjigovodstvena odluka. Upisano kao otvoreno pitanje (§4).
- `holds_fx_balance = false` na svih 9 (BigBit `DevSaldo=0`) — nema čitaoca u kodu, ostaje.
- Ostale 19 šema, normalizacija negativnih izraza i izostavljanje mrtvih (21/28/29/32/39) i
  jednostranih (37/38) — potvrđeno oba pregleda, ostaje kako jeste.

**Stanje registra posle seed-a (DEV):** `saldakonto_accounts` = 9 (svih 9 sa `partner_scope`),
`accounting_schemes` = 21 (19 novih + 33/36), `accounting_scheme_lines` = 78. Ponovno izvršavanje
migracije: `UPDATE 0 / INSERT 0 0 / INSERT 0 0` (idempotentno).

---

## 2. Stavka B — konto 1329 i nivelacija (NIV)

Migracija `20260726110000_ukloni_konto_1329_niv` je ostala nepromenjena (oba pregleda bez zamerke:
guard pokriva sve tri FK tabele, uključujući `saldakonto_accounts` sa `ON DELETE CASCADE`).

### Ispravljeno (regresije koje su oba pregleda prijavila)

| # | Nalaz | Ispravka |
|---|---|---|
| B-1 | NIV posle obrade više nema `journalEntryId`, a `RobnoService.lockDocument` traži baš njega → **NIV se ne može zaključati nikad**; poruka „nije proknjižen" nad dokumentom koji u UI-ju piše „Proknjižen" | `lockDocument` CAS proširen na `OR: [ journalEntryId != null, status='POSTED' ]`; poruka preformulisana u „Zaključavanje je moguće tek pošto je dokument proknjižen/obrađen (trenutni status: …)". Docstring ispravljen. |
| B-2 | Frontend: za `POSTED` NIV bez naloga `PrimaryActions` propada kroz sve grane → ekran bez ijedne akcije | `frontend/src/app/robno/[id]/page.tsx`: `isBooked` i `PrimaryActions` izvode „obrađen" iz `journalEntryId != null || status === POSTED`. |
| B-3 | Uklonjena provera „nema nivelacionih stavki" pretvorila je grešku u **tihi no-op** koji se prijavljuje kao uspeh (POSTED, 0 GK linija, 0 KEPU redova, dokument više nepromenjiv) | Provera vraćena: `postNivLeveling` broji `stock_leveling_items` i baca 422 „Nivelacija N nema nijednu stavku…" **pre** prelaza u POSTED. Provere „net = 0" i „postojanje konta 1320/1329" ostaju uklonjene (ispravno). Test u `posting.service.spec.ts` zaključava novo ponašanje. |
| B-4 | `/// ` komentar u šemi i dalje tvrdio „razlika proknjižena u GK" | `schema.prisma`: `StockLevelingItem.isPosted` = „nivelacija obrađena (NE znači knjiženje u GK)". |

### Odbačeno

- **Nalaz „gubitak idempotencione zaštite (409) za NIV" (NIZAK) nije popravljan.** Ponovljeno
  knjiženje NIV-a ne kvari podatke (`writeKepuEntries` je delete+insert po dokumentu), a posle B-3
  ponovljen poziv nad dokumentom bez stavki ionako pada. Dodavanje 409 bi otežalo re-obradu.
- Odluka „nivelacija se NE knjiži u GK" ostaje — oba pregleda su je nezavisno potvrdila i iz BigBita
  (`R_Vrste dokumenata`: NIV `Sema=0`) i računovodstveno (prilagođenje se poništava sa ulazom).

---

## 3. Stavka C — avansi (N:M primene + avans po ugovoru)

Migracija `20260726120000_avansi_nm_primene` nepromenjena; ispravke su u kodu.

### Ispravljeno (nalazi VISOK)

| # | Nalaz | Ispravka |
|---|---|---|
| C-1 | **Glavna isporuka nije bila dostupna:** `sales.controller` je destrukturirao samo `{ advanceInvoiceId }`, pa `amount` nikad nije stizao do servisa → deljenje avansa na dva računa (AVR-00013/2025 → 20.802 + 17.100) nemoguće kroz HTTP; korisnik dobija 422 koji traži radnju koju UI ne nudi | Kontroler prima i prosleđuje `amount`. Frontend: `useLinkAdvanceToFinal` šalje `amount` kad je unet, a dijalog „Veži avans na konačni račun" ima polje **„Iznos odbitka"** (prazno = ceo preostali avans) za izlazni smer. |
| C-2 | **Štampa:** PDF je ispisivao ZBIR svih primena uz broj **samo prvog** AVR-a → poreski dokument sa umanjenjem većim od referenciranog avansnog računa | `invoice-pdf.service` čita `invoice_advance_applications` i štampa **po jedan red po primeni** (broj AVR-a + iznos te primene); „Za uplatu" se računa iz zbira prikazanih redova. Rezerva za dokumente vezane pre N:M migracije (veza samo u koloni) — jedan red iz kolona. |
| C-3 | **SEF/UBL:** `PrepaidAmount` = zbir svih primena, a `cac:BillingReference` na prvi avans → nekonzistentna e-faktura | `sef.service` čita primene i šalje **listu referenci**; `ubl-builder` emituje po jedan `cac:BillingReference` za svaku (uz zadržan stari `prepaymentReference` kao rezervu). Iznos i reference se sada izvode iz ISTOG izvora. |

### Odbačeno / svesno nije rađeno u ovom prolazu

- **Zaokruženje pri deljenju avansa (SREDNJI).** Nalaz je tačan (svaka primena se nezavisno
  `grossToNet`-uje, pa poslednja primena može ostaviti ±0,01 na `4300`/`4720`), ali ispravka menja
  način izvođenja osnovice primene i traži svoj set testova; ne ulazi u integraciju bez ponovnog
  pregleda. **Ostaje otvoreno (§4).**
- **Brave pri stornu (SREDNJI).** `stornoInvoice` je namerno van jedne transakcije (dokumentovan
  trade-off Batch A/F4); dodavanje advisory brava dira ceo tok storna. **Ostaje otvoreno (§4).**
- **DB-garancija „Σ primena ≤ naplaćen avans" (SREDNJI).** Kontrola je i dalje samo aplikativna
  (transakcija + advisory brave). Uz to `uq_invoice_advance_app_active` živi samo u SQL-u — prvi
  `prisma migrate dev` nad `Invoice`/`InvoiceAdvanceApplication` će ga obrisati ako se ručno ne vrati.
  **Upisati u `docs/schema-rename-map.md` pri sledećem dodiru te šeme.**
- `pdv/advance-vat.service.linkIncomingAdvanceToFinal` nije diran (drugi pregled je pokazao da je taj
  put danas nedostižan — traži smer `in`, a linija 337 taj smer odbija).

---

## 4. Otvorena pitanja (traže odluku knjigovođe / Nese — NE implementirati unapred)

1. **Šeme 30 (IFUSL) i 31 (KNO)** — kupac `2020` i prihod `6120/6121` naspram `2040`/`6040`/`6140`
   (doc §7.2/S6, §6.6). Dok se ne potvrdi, šeme nisu seedovane.
2. **Šeme 37 (MMPM) / 38 (MMPR)** — jednostrane; protivstavka dolazi iz sentinela `Konto="MAG"` →
   `Magacini.KontoMag`, što posting engine ne podržava.
3. **`control_account` za avansna konta** — sa današnjim mapiranjem uparivanje avans↔faktura pada na
   `assertSamePartnerScope` („sve stavke moraju pripadati istom kontrolnom kontu"). Ili avansna konta
   dobijaju kontrolni konto protivstrane, ili guard dobija izuzetak za avansni par.
4. **Devizni saldakonto** (`holds_fx_balance`) — kandidati 1530/2050/4302/4360; novo, nije paritet.
5. **`document_types.posting_template`** — i dalje 0 na produkciji, pa **seedovane šeme još ništa ne
   knjiže**. Mapiranje 58 vrsta → `IDSeme` (`R_Vrste dokumenata`) je zasebna stavka; bez nje seed ne
   menja ponašanje robnog knjiženja.
6. **Kreditni limit** prelazi iz „nikad ne okida" u „aktivan guard" nad nepotpunom GK — pre puštanja
   na produkciju proveriti da FE nudi „Proknjiži uprkos limitu" ili držati `creditLimit` prazan dok
   se ne unesu i uplate.
7. **Zaokruženje kod deljenja avansa** i **brave pri stornu** (v. §3).

---

## 5. Paket ZR (završni račun) — NIJE SPREMAN

Četvrti paket (autentične AOP formule + ispravke motora) nije deo ove integracije, a njegov **izvorni
kod je uništen incidentom iz uvoda i nije bio u snimcima file-history**. U stablu su ostali samo:

- `prisma/migrations/20260726090000_seed_balance_formulas_autenticne/` (**nije primenjena na DEV**),
- `docs/migration/ZR_AOP_FORMULE_AUTENTICNE.md` i `ZR_ISPRAVKE_MOTORA.md` (tačan opis izmena po
  fajlu i liniji),
- `src/modules/zavrsni/gkeval.service.spec.ts` (**3 testa padaju** — testiraju izuzimanje `ZAK`
  naloga, čija implementacija više ne postoji).

Izmene u `balance-sheet.service.ts` (clamp ≥ 0), `control-rules.service.ts` i `gkeval.service.ts`
treba **ponovo uraditi** — `ZR_ISPRAVKE_MOTORA.md` sadrži tačne instrukcije, pa je ponavljanje jeftino.
Do tada paket ZR ne ide dalje, a migracija 090000 se ne primenjuje.

---

## 6. Verifikacija (stvarni brojevi, 2026-07-26)

| provera | rezultat |
|---|---|
| `npx tsc --noEmit` (backend) | ✅ exit 0, bez poruka |
| `npx tsc --noEmit` (frontend) | ✅ exit 0, bez poruka |
| `npx nest build` | ✅ prolazi (uz `rm -rf dist/modules/projects-write`) |
| boot smoke `node dist/main` | ✅ „Nest application successfully started" (PORT=3099, test JWT) |
| `npx jest --silent` (ceo paket) | ⚠️ **122 suite / 2315 testova: 2312 prošlo, 3 pala** — sva tri u `zavrsni/gkeval.service.spec.ts` (paket ZR, §5) |
| `npx jest src/modules/sales src/modules/gl src/modules/robno src/modules/saldakonti src/modules/placanja src/modules/kamata` | ✅ 11 suita / 177 testova |
| `npx jest --config test/jest-e2e.json --silent` | ✅ 22 suite / 4086 testova |
| migracije na DEV (`192.168.64.28:5437`) | ✅ 100000 (izmenjena, checksum `282f1baa…`), 110000, 120000 primenjene; ponovno izvršenje 100000 = 0 izmena |
| `npx prisma migrate status` | ⚠️ 22 migracije prijavljene kao „not yet applied" — **zatečena dev evidencija**: ranije su primenjivane ručno preko `psql` bez upisa u `_prisma_migrations`. Nema nijedne *failed* ni *modified* migracije. Jedina stvarno neprimenjena je `20260726090000` (paket ZR). |

---

## 7. Šta glavna petlja treba da registruje

- **Bez novih kontrolera/modula** — sve izmene su unutar postojećih (`sales`, `robno`, `gl`,
  `saldakonti`, `placanja`, `kamata`); nema nove rute ni nav stavke.
- Kolona `saldakonto_accounts.partner_scope` je **nova u šemi** → posle povlačenja izmena obavezan je
  `npx prisma generate` (na Windows-u može pasti sa `EPERM` dok drugi node procesi drže
  `query_engine-windows.dll.node`).
- Frontend: dijalog „Veži avans na konačni račun" dobio je polje **„Iznos odbitka"** (delimično
  odbijanje) — vredi pomenuti korisnicima uz puštanje.
