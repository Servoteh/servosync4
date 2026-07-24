# PLAN — Talas 1C/1D/1E: dovršetak BigBit pariteta

> **Autor:** Fable (analiza + plan, 23.07.2026). **Izvršilac:** Opus, multiagent workflow-ima, po protokolu u §6.
> **Metod:** 9 verifikacionih agenata (po jedan po ERP modulu) proverilo je STVARNO stanje u kodu za
> svih 35 preostalih Talas-1 stavki iz [MASTER_PLAN_GRADNJE_4.0_ERP_JEZGRO.md](MASTER_PLAN_GRADNJE_4.0_ERP_JEZGRO.md)
> — ne po planu, nego grep/read sa file:line dokazom (196 tool-poziva). Ovaj dokument je jedini
> merodavan snimak; master plan ostaje izvor za Talas 2/3.

---

## 1. Snimak stanja (verifikovano 23.07.2026, posle PR #8)

**35 stavki: 1 DONE · 11 PARTIAL · 22 MISSING · 1 BLOCKED.**

Gotovo (Talas 1A + 1B + XL + review-fixevi — živo na produ): izvod ručni unos + knjiženje (posted),
virmani pregled/potpis/export, nabavka PO create/status/prijem/novi-zahtev, GK ručni nalog + kontni
plan, robno lager + novi-dokument, fakturisanje PDF štampa + predračun, kompenzacija panel (⚠️ ali
vidi B1), Blagajna, Kamata, vat_account_map seed, APR XML dugme.

| # | Modul | Stavka | Status | Effort | Suština nalaza |
|---|---|---|---|---|---|
| 9 | GK | Auto-nalozi draft→posted→locked | PARTIAL | S | BE kompletan (rute post/lock, gl.controller.ts:67-77); FE hookovi usePost/useLockJournalEntry MRTVI — nema dugmadi, računovođa ne može da promoviše draft |
| 46 | GK | Storno nalog | PARTIAL | S | BE pun (reverse ruta, reversesEntryId se piše, gl-write.service.ts:122); FE useReverseJournalEntry mrtav — nema dugmeta |
| 18 | Nabavka | Accept quote | MISSING | M | Nema rute ni servisa; isAccepted/offeredLeadTimeDays samo mrtve FE type deklaracije (api/nabavka.ts:126-127) |
| 19 | Nabavka | RFQ lista/detalj | MISSING | M | Nema GET za SupplierRfq (poslati upiti se ne vide); @Get('rfqs') u projects-write je DRUGI entitet (CustomerRfq) |
| 20 | Nabavka | RFQ mejl PDF prilog | PARTIAL | S | Mejl dobavljaču ŽIV (SendRfqDialog); fali samo attachments u mail.send pozivu (nabavka.service.ts:173-177; MailService podržava attachments) |
| 21 | Robno | Guard negativnog stanja pri izlazu | MISSING | M | stateAsOf postoji ali se zove samo iz UL nivelacije; createStockDocument za IZ/MANJAK ne proverava stanje |
| 22 | Robno | NIV knjiženje u GK | PARTIAL | M | ⚠️ DEFEKT: postFromStockDocument čita SAMO stock_document_items; NIV iz nivelacije ima samo stockLevelingItems → **nula-nalog**; NIV ostaje CALCULATED zauvek |
| 23 | Robno | PDV u kalkulaciji | MISSING | S | taxRateOf = stub `return ZERO` (calculation.service.ts:228-231) → KalkMP (MP cene) bez PDV-a |
| 24 | Robno | Popis/inventura | MISSING | XL | Samo šema (InventoryCount, VISAK/MANJAK kind); nema servisa, rute, predpunjenja, FE |
| 25 | Robno | KEPU punjenje | MISSING | L | Niko ne piše kepu_book_entries (recap čita praznu tabelu); komentari tvrde „punjenje radi robno" — ne radi |
| 26 | Robno | Spec testovi | MISSING | M | 0 spec fajlova za kalkulaciju/costing/nivelaciju — finansijske formule netestirane |
| 28 | Saldakonti | Kompenzacija knjiženje | PARTIAL | M | ⚠️ DEFEKT u isporučenom: FE filtrira `l.ledgerEntryId != null` a open-items NIKAD ne vraća id-eve → inputLines prazan → **create se nikad ne okine** (compensation-panel.tsx:102-108); BE motor gotov (postManualEntry+POSTED) |
| 29 | Saldakonti | „Upari" dugme | PARTIAL | M | BE reconcile pun (saldakonti.controller.ts:72-92); FE onClick = prazan no-op (page.tsx:361-364); koren isti kao #28: open-items pogled ne izlaže ledgerEntry id-eve |
| 30 | Saldakonti | pain.001 ISO 20022 | MISSING | L | Samo FX TXT (svesna odluka doc 21); nigde pain.001/camt — **odluka O1** |
| 49 | Saldakonti | IOS/NIOS obrazac PDF | MISSING | L | Ne postoji nigde; zakonska godišnja obaveza |
| 31 | Izvodi | Parsiranje poziva na broj | PARTIAL | M | TR-normalizacija auto-match ŽIVA; ali matchOpenItem = egzaktno poređenje — nema FX_OdrediBrojDokumenta (strip modela/kontrolnog broja); Model(167,2) se ne čita iz TXT |
| 32 | Izvodi | Ručno per-stavka uparivanje | PARTIAL | S | BE ruta lines/:lineId/link ŽIVA; FE hook useLinkStatementLine definisan ali MRTAV — nema „Poveži" dugmeta ni picker-a otvorenih stavki |
| 33 | Izvodi | Devizni izvod + ExchangeRate model | MISSING | L | Nema modela kursne liste; parser RSD-only; BankStatementLine nema FX polja — **odluka O2** |
| 35 | Plaćanja | DobarTR + PNB guard | MISSING | S | isValidAccountNumber (mod97.util.ts:97-108) mrtav kod — niko ga ne zove; TR se upisuje neproveren |
| 36 | PDV | PP-PDV štampa + KIF/KUF/POPDV spec | MISSING | L | 0 print ruta u pdv.controller; regulatorni bloker za predaju |
| 37 | PDV | Poreske stope CRUD + resolver | MISSING | M | TaxRate model sa validFrom/validTo POSTOJI u šemi, ali 0 CRUD/lookups/resolvera; GL koristi hardkod VAT_RATE_BY_CODE |
| 38 | PDV | KEPU FE | PARTIAL | M* | GET /pdv/kepu recap ŽIV; FE grep „kepu" = 0 pogodaka (nema taba/hooka). *FE deo M; punjenje je #25 |
| 39 | PDV | Period-lock | MISSING | M | buildKifKuf = deleteMany+reknjiži bez brave → predat PP-PDV se tiho pregazi; status POSTED se nigde ne postavlja |
| 40 | PDV | Ručni KIF/KUF unos/edit | MISSING | M | Jedina piši-ruta je bulk build iz GK; nema per-stavka CRUD ni FE dijaloga |
| 41 | Fakturisanje | UBL BrojNarudžbenice | MISSING | M | Nema cac:OrderReference; Invoice nema PO polje u šemi — SEF odbija javni sektor |
| 42 | Fakturisanje | SEF ulazne fakture | MISSING | XL | Ne postoji koncept (samo SefOutbox); zakonski rok 15 dana — **odluka O3** |
| 43 | Fakturisanje | Zaključavanje dokumenta | PARTIAL | M | GL lock ruta postoji (FE mrtav); Invoice nema isLocked; ⚠️ postInvoice pravi GL nalog **status 'draft'** (fakturisanje.service.ts:421) → nevidljiv saldakontima (ista klasa buga kao izvod pre PR #8) |
| 44 | Fakturisanje | Auto-robno GL (šeme 33/36) | DONE* | S | Motor + ruta + FE „Knjiži" živi; *⚠️ šeme 33/36 žive samo u `_nacrt` seed-u bez registrovanog runnera — proveriti da li ih DB stvarno ima |
| 45 | Fakturisanje | PDF prilog uz SEF | PARTIAL | M | UBL builder podržava (EmbeddedDocumentBinaryObject); enqueue ne prosleđuje pdfBase64; ⚠️ **useEnqueue FE-mrtav — „Pošalji na SEF" dugme uopšte ne postoji** |
| 16 | Završni | Prave ZR_AOP_Modla formule | BLOCKED | L | Vendorska .mdb (kod Slaviše); ⚠️ čak ni rekonstrukcioni seed NIJE povezan ni u jedan runner — tabela formula prazna |
| 50 | Završni | Finalize/predaja | MISSING | M | Guard protiv regenerisanja FINALIZED postoji, ali NIŠTA ne postavlja FINALIZED (nema rute) — mrtav status |
| 51 | Završni | Konvergencija A-referenci | MISSING | M | ⚠️ DEFEKT: single-pass po ordinalu; forward-ref → 0 → **UKUPNA AKTIVA (AOP 0001 = A0002+A0044) izračuna se kao 0** |
| 52 | Završni | Iznos_2/Iznos_3 (PG/PS) | MISSING | L | Jedna amount kolona; AB/AC tokeni parsiraju se ali uvek 0; APR XML emituje istu vrednost u sve kolone |
| 53 | Završni | Kontrolna pravila (aktiva=pasiva) | MISSING | L | Nema motora pravila ni ZR_AOP_Pravila modela |
| 54 | Završni | Zaglavlje firme | MISSING | M | APR XML bez PIB/matični/veličina — nepotpun za predaju |

## 2. Novootkriveni defekti u VEĆ isporučenom kodu (prioritet iznad svega)

Verifikacija je, pored plan-rupa, našla defekte u kodu koji je već na produ. Tabele su prazne pa
šteta još nije nastala — ali ovo ide PRVO, pre novih funkcija:

- **B1 — Kompenzacija je nefunkcionalna end-to-end:** panel isporučen u Talasu 1B nikad ne pozove
  create (filter na `ledgerEntryId` koji open-items ne vraća). Koren: izvedeni open-items pogled ne
  izlaže ledgerEntry id-eve — isti koren blokira i „Upari" (#29). Jedan fix otključava OBA.
- **B2 — NIV nalog knjiži nulu:** posting engine ne čita stockLevelingItems → nivelaciona razlika
  nikad ne stigne u GK (lager i GK se razilaze čim krene promet).
- **B3 — Bilans: UKUPNA AKTIVA = 0:** single-pass eval sa forward referencama; i rekonstrukcioni
  seed formula uopšte nije primenjen (tabela prazna).
- **B4 — SEF slanje nedostupno iz UI:** `useEnqueue` mrtav — nijedno dugme „Pošalji na SEF" ne
  postoji; ceo SEF izlazni tok je faktički isključen.
- **B5 — Faktura GL nalog ostaje `draft`:** ista klasa buga koju je PR #8 zatvorio za izvod —
  proknjižena faktura je nevidljiva saldakontima/kartici dok neko ručno ne promoviše nalog (a FE
  dugme za to ne postoji — #9).
- **B6 — Šeme 33/36 možda nisu u bazi:** seed je `_nacrt` bez runnera — „Knjiži" na robnom
  dokumentu će pasti na produ ako šema ne postoji. Proveriti dev i prod.

## 3. Plan talasa (za Opus multiagent izvršenje)

### 🔴 Talas 1C — Defekti + druga generacija „mrtvih FE" (13 stavki, mahom S/M — jedna sesija)

Najbolji odnos vrednost/trošak: 6 defekata iz §2 + 7 quick-win stavki gde je backend gotov.

| ID | Stavka | Ref | Effort | Definicija gotovog |
|---|---|---|---|---|
| C1 | GK dugmad Proknjiži/Zaključaj/Storno na detalju naloga (+lista badge) | #9,#46 | S | draft nalog se kroz UI promoviše u posted→locked; storno pravi kontra-nalog |
| C2 | „Pošalji na SEF" dugme (useEnqueue wiring + status prikaz) | B4,#45-deo | S | faktura iz UI ulazi u SefOutbox |
| C3 | Open-items vraća `ledgerEntryIds` po redu → kompenzacija create radi | B1,#28 | M | predlog→izmena→„Proknjiži" završi POSTED; GL nalog vidljiv |
| C4 | „Upari"/reconcile + „Razveži" dugmad (koren deli C3) | #29 | S | ručno uparivanje otvorenih stavki radi iz UI |
| C5 | Izvod „Poveži" po stavci: picker otvorenih stavki + useLinkStatementLine | #32 | S | nestandardna stavka se ručno veže za dokument |
| C6 | DobarTR validacija u create+export + PNB guard | #35 | S | nalog sa neispravnim TR/PNB se odbija sa porukom |
| C7 | RFQ mejl dobija PDF prilog (InvoicePdf obrazac ili HTML→PDF) | #20 | S | dobavljač dobija PDF upit |
| C8 | taxRateOf čita tax_rates (fallback VAT_RATE_BY_CODE) | #23 | S | KalkMP sadrži PDV; centralizovana stopa |
| C9 | NIV: postFromStockDocument čita stockLevelingItems; NIV→posted tok | B2,#22 | M | nivelaciona razlika stigne u GK; smoke: UL 10×100 pa UL 10×120 → NIV nalog ≠ 0 |
| C10 | ZR: iterativna konvergencija (do stabilnosti, max 7) + wire seed formula | B3,#51,#16-deo | M | UKUPNA AKTIVA ≠ 0 na test podacima; seed primenjen na dev+prod |
| C11 | Guard negativnog stanja pri IZ/MANJAK (stateAsOf poziv + poruka) | #21 | M | izlaz preko raspoloživog stanja → 422 sa stanjem |
| C12 | postInvoice: GL nalog `posted` (politika PR #8) | B5,#43-deo | S | proknjižena faktura odmah u saldakontima; **odluka O4 potvrđena=default** |
| C13 | Šeme 33/36 seed runner + provera dev/prod | B6,#44 | S | `SELECT` potvrdi šeme u obe baze |

### 🟡 Talas 1D — Regulatorno jezgro (9 blokova, M/L — dve sesije)

Bez ovoga 4.0 ne sme na poresku predaju; radi se POSLE 1C (1C mu je preduslov na više mesta).

| ID | Stavka | Ref | Effort |
|---|---|---|---|
| D1 | Poreske stope CRUD + datumski resolver (jedan izvor: kalkulacija+GL+PDV) | #37 | M |
| D2 | PP-PDV obrazac + KIF/KUF/POPDV specifikacije (PDF štampa) | #36 | L |
| D3 | Period-lock PDV (POSTED status + guard na rebuild) | #39 | M |
| D4 | Ručni unos/edit KIF/KUF stavki (source: manual vs gl-derived) | #40 | M |
| D5 | KEPU punjenje iz robno toka + numeracija rbr + FE tab | #25,#38 | L |
| D6 | UBL OrderReference (Invoice.poNumber polje + FE + UBL emit) | #41 | M |
| D7 | SEF PDF prilog (enqueue → InvoicePdfService → pdfAttachmentBase64) | #45 | M |
| D8 | Invoice isLocked + zaključavanje posle SEF prihvatanja | #43 | M |
| D9 | ZR paket: finalize ruta+dugme · zaglavlje firme (PIB/matični/veličina) · kontrolna pravila (aktiva=pasiva) · Iznos_2/3 kolone | #50,#54,#53,#52 | L |

### 🟢 Talas 1E — Veliki blokovi (L/XL — po jedna sesija svaki, redosled po zakonskim rokovima)

| ID | Stavka | Ref | Effort | Napomena |
|---|---|---|---|---|
| E1 | SEF ulazne fakture (inbox model, accept/reject, rok-15-dana alarm) | #42 | XL | **odluka O3** — ako se danas radi kroz SEF portal, može posle cutover-a |
| E2 | Popis/inventura (predpunjenje iz stateAsOf → unos → razlika → VISAK/MANJAK + knjiženje) | #24 | XL | mora pre prvog 31.12. na 4.0 |
| E3 | IOS/NIOS obrazac (PDF + mail) | #49 | L | zakonska godišnja obaveza |
| E4 | Poziv na broj parsiranje (FX_OdrediBrojDokumenta port: model+kontrolni broj+ekstrakcija BrDok) | #31 | M | diže auto-match sa egzaktnog na BigBit nivo |
| E5 | Nabavka: accept quote + RFQ lista/detalj | #18,#19 | M+M | zatvara RFQ→ponuda→PO lanac |
| E6 | Devizni izvod + ExchangeRate/KursnaLista model (deljeni FX servis) | #33 | L | **odluka O2** |
| E7 | pain.001 ISO 20022 XML izvoz | #30 | L | **odluka O1** — samo ako banka traži XML |
| E8 | Spec testovi robno (kalkulacija/costing/nivelacija/popis) | #26 | M | delom se puni kroz C9/C11/E2 verifikacije |

Posle 1C–1E → Talas 2 (SREDNJI/NIZAK) pa Talas 3 (Pantheon/SAP), po master planu.

## 4. Otvorene odluke (potvrda Nenad/Neso — NE blokiraju 1C)

- **O1 (pain.001): ✅ PRESUĐENO 24.07 (Nenad)** — FX TXT ostaje kao u BigBit-u; pain.001 XML se NE radi → **E7 OTPADA**.
- **O2 (devizni izvod): ✅ PRESUĐENO 24.07 (Nenad)** — ~100 deviznih izvoda godišnje (≈2 nedeljno) → **E6 SE RADI pre cutover-a** (ExchangeRate/KursnaLista model + devizni parser + FX knjiženje).
- **O3 (SEF ulazne): ✅ PRESUĐENO 24.07 (Nenad)** — ulazne se danas rade **KROZ BIGBIT** (portal samo
  kao rezervna opcija); BigBit poredi da li faktura VEĆ POSTOJI u sync-u, bez obzira da li ju je neko
  drugi potvrdio → **E1 SEF ulazne JE cutover-bloker** (XL: inbox sync sa SEF-a + dedup protiv
  postojećih + accept/reject sa rokom 15 dana). Planirati kao poseban talas.
- **O4 (faktura GL politika):** predlog = auto-`posted` pri postInvoice (kao izvod, PR #8 filozofija);
  alternativa = ostaje draft a računovođa promoviše kroz C1 dugmad. **Default za C12: auto-posted.**

## 5. Šta NIJE u planu (svesno)

- Prave ZR_AOP_Modla formule (#16) — ostaje BLOCKED na Slavišinoj .mdb; C10 primenjuje
  rekonstrukciju uz jasnu oznaku „NE za predaju dok se ne verifikuje 1:1".
- Talas 2/3 stavke — master plan §3 ostaje izvor; ne mešati u 1C–1E sesije.

## 6. Protokol izvršenja za Opus (multiagent)

Po batch-u (1C, pa D1–D9 u dve grupe, pa E-stavke pojedinačno):

1. **Implement:** stavke grupisati po modulu (deljeni fajlovi: navigation.ts, permissions.ts,
   schema.prisma — te izmene radi glavna petlja, ne paralelni agenti). Nezavisni moduli mogu
   paralelno (worktree izolacija ako mutiraju u isto vreme); unutar modula sekvencijalno.
2. **Migracije:** na dev preko docker psql šablona (nikad `migrate dev`); nove migracije aditivne.
3. **Verify workflow:** tsc 0 + nest build + boot 0 DI + e2e pun + **po stavci ciljani smoke na dev
   bazi sa stvarnim podacima** (npr. C9: NIV nalog ≠ 0; C10: aktiva ≠ 0; C3: kompenzacija POSTED).
   Definicije gotovog iz §3 tabela su smoke-kriterijumi.
4. **Adversarial review workflow pre merge-a** (obrazac iz PR #8: nezavisni skeptici po nalazu,
   default-refuted) — obavezno za sve što piše u GL/saldo/PDV.
5. **PR → CI zelen → merge → deploy → `post-deploy-verify` 🟢 EXIT 0** ([[deploy-protokol-obavezan]]);
   ako ima migracija: `prisma migrate status` na produ + provera objekta.
6. **FE pravila:** static export — nove `[id]` rute NE (koristiti `?id=N` obrazac); bez pravih
   navodnika u JSX stringovima; Button nema `size` prop.
7. Memorija: posle svakog batch-a ažurirati `talas1-paritet-napredak`.
