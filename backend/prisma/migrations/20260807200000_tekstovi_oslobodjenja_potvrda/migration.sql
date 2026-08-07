-- DOSLOVNI TEKSTOVI PORESKOG OSLOBOĐENJA — POTVRDA KNJIGOVOĐE 07.08.2026.
-- =============================================================================
-- Zatvara pitanje P-F iz `backend/docs/ODGOVORI_38_UTICAJ.md` §5, koje je glasilo:
-- „Za tri osnova nemamo tekst kakav treba doslovno da stoji na papiru: (a) čl. 24 st. 1
-- t. 7 — oplemenjivanje; (b) čl. 12 st. 3 sa rečima ‚mesto prometa usluge je van
-- teritorije Republike Srbije'; (c) ista rečenica bez tih reči, za uslugu izvršenu u
-- Srbiji stranom poreskom obvezniku."
--
-- Odgovor knjigovođe, doslovno:
--   „jeste, ova tri teksta treba da stoje na fakturama zavisno od toga šta se prodaje.
--    Svakako ovakve fakture se ne evidentiraju u sistemu e faktura jer se rade kao
--    izvozna dokumenta"
--
-- Dakle: tri teksta koja smo PREDLOŽILI on je prihvatio BEZ IZMENE, pa su oni od danas
-- potvrđeni i prestaju da budu naša rekonstrukcija. Tri reda šifarnika su do danas nosila
-- privremenu formulaciju sastavljenu po obrascu (v. „ČEKA POTVRDU" u
-- `20260805230000_sifarnik_osnova_oslobodjenja`) — ovde se ona zamenjuje odobrenom.
--
-- ── ZAŠTO UPDATE, A NE NOVI REDOVI ──────────────────────────────────────────
-- Sva tri osnova VEĆ POSTOJE kao redovi (`OPLEMENJIVANJE`, `USLUGA-VAN-RS`,
-- `USLUGA-STRANO-LICE`) — potvrđen je njihov TEKST, ne novi osnov. Novi `INSERT` bi
-- napravio drugi red za isti pravni osnov, a time i drugi izbor u padajućoj listi za istu
-- situaciju — tačno ono što šifarnik postoji da spreči.
--
-- ── IZMERENO NA PRODUKCIJI 07.08.2026 (samo čitanje) ────────────────────────
-- `vat_exemption_bases` ima tačno 6 redova iz semena, svi `is_active`, i nijedan nije
-- ručno menjan (svaki `paper_text` je doslovno jednak semenu). `invoices = 0` i
-- `count(vat_exemption_basis_id) = 0` → nijedan izdat dokument ne menja ni tekst ni
-- osnov; cena ove promene je nula i nikad neće biti manja.
--
-- ── IDEMPOTENTNOST I ZAŠTITA KNJIGOVOĐINOG UNOSA ────────────────────────────
-- Svaki `UPDATE` gađa i šifru I TAČAN ZATEČENI TEKST. Zato drugi prolaz ne menja ništa
-- (tekst se više ne poklapa), a ono što knjigovođa u međuvremenu sam upiše kroz šifarnik
-- OSTAJE — isti obzir koji je u prethodnoj migraciji davao `ON CONFLICT DO NOTHING`.
-- Bez ijednog PL/pgSQL bloka, iz istog razloga kao tamo (`42703` je 02.08.2026. oborio
-- sve deploy-e).

-- ── (a) ČL. 24 ST. 1 T. 7 — OPLEMENJIVANJE ──────────────────────────────────
-- Do danas: rečenica sastavljena po obrascu reda za 24.1.2, uz izričito „ČEKA POTVRDU".
UPDATE "vat_exemption_bases"
   SET "paper_text" = 'Oslobođeno PDV-a na osnovu člana 24. stav 1 tačka 7 Zakona o PDV.',
       "updated_at" = now()
 WHERE "code" = 'OPLEMENJIVANJE'
   AND "paper_text" = 'Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 7 Zakona o PDV.';

-- ── (b) ČL. 12 ST. 3 — MESTO PROMETA VAN TERITORIJE RS ──────────────────────
-- Odobrena rečenica razdvaja dopunu CRTOM umesto zagradom i piše „Zakona o PDV" umesto
-- „Zakona o PDV-u". Nije kozmetika: to je oblik koji je knjigovođa odobrio za papir.
UPDATE "vat_exemption_bases"
   SET "paper_text" = 'PDV nije obračunat u skladu sa članom 12. stav 3 Zakona o PDV — mesto prometa usluge je van teritorije Republike Srbije.',
       "updated_at" = now()
 WHERE "code" = 'USLUGA-VAN-RS'
   AND "paper_text" = 'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u (mesto prometa usluge je van teritorije Republike Srbije)';

-- ── (c) ČL. 12 ST. 3 — USLUGA U RS STRANOM PORESKOM OBVEZNIKU ───────────────
-- ISTA rečenica kao (b), samo BEZ dopune o mestu prometa — tako je i traženo pitanjem
-- P-F(c), i tako je odobreno.
UPDATE "vat_exemption_bases"
   SET "paper_text" = 'PDV nije obračunat u skladu sa članom 12. stav 3 Zakona o PDV.',
       "updated_at" = now()
 WHERE "code" = 'USLUGA-STRANO-LICE'
   AND "paper_text" = 'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u';

-- ── ISPRAVKA RANIJE POTVRĐENOG TEKSTA ZA TAČKU 5 (DOMAĆI PROMET) ────────────
-- Odgovor 10 je 05.08.2026. dat u zagradi i prepisan DOSLOVNO, uključujući i ono što je
-- ličilo na omašku: „…člana 24 stav 1 tačka 5 o PDV-u" — BEZ reči „Zakona" i bez tačke
-- iza broja člana. Tada je izričito zapisano da mi ne ispravljamo pravnu formulaciju
-- knjigovođe nego da pitamo. Sada je potvrdio pun oblik, sa „Zakona", pa se upisuje on.
--
-- ⚠️ Menja se SAMO tekst. `sef_code` (`PDV-RS-24-1-5`) i `goes_to_sef` ostaju netaknuti —
-- v. odeljak o SEF kapiji na dnu.
UPDATE "vat_exemption_bases"
   SET "paper_text" = 'Oslobođeno PDV-a na osnovu člana 24. stav 1 tačka 5 Zakona o PDV.',
       "updated_at" = now()
 WHERE "code" = 'DOMACI-OSLOBODJEN'
   AND "paper_text" = 'Napomena o poreskom oslobođenju: Oslobođeno PDV-a na osnovu člana 24 stav 1 tačka 5 o PDV-u';

-- ── ISTA REČENICA U DRUGOM ŠIFARNIKU: `service_revenue_types.paper_note` ────
-- IZMERENO 07.08.2026: vrsta usluge `USL-INO` (konto 6151, tretman `OUTSIDE_SCOPE`) nosi
-- DOSLOVNO staru varijantu rečenice (b). Ta napomena je drugi po jačini izvor teksta za
-- papir (`resolveExemption`: osnov → napomena vrste usluge → izvođenje), pa bi bez ovog
-- reda ista izvozna uslužna faktura štampala JEDNU rečenicu kad je osnov izabran, a DRUGU
-- kad nije — dve formulacije istog člana za isti posao, tj. baš klasa kvara zbog koje je
-- ceo ovaj modul i nastao.
--
-- Ovo NIJE gaženje ranije potvrde: 05.08.2026. je za `USL-INO` potvrđen ČLAN (čl. 12
-- st. 3), a tekst je bio naš prepis; danas je odobrena njegova tačna formulacija.
UPDATE "service_revenue_types"
   SET "paper_note" = 'PDV nije obračunat u skladu sa članom 12. stav 3 Zakona o PDV — mesto prometa usluge je van teritorije Republike Srbije.',
       "updated_at" = now()
 WHERE "code" = 'USL-INO'
   AND "paper_note" = 'PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u (mesto prometa usluge je van teritorije Republike Srbije)';

-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 SEF KAPIJA (`goes_to_sef`) — PROVERENO, NIJEDNA VREDNOST SE NE MENJA
-- =============================================================================
-- Rečenica „ovakve fakture se ne evidentiraju u sistemu e faktura jer se rade kao izvozna
-- dokumenta" odnosi se na „ovakve fakture" = fakture sa TA TRI teksta. Provereno je za
-- svih šest redova šifarnika da li se zatečena zastavica poklapa sa onim što je rečeno:
--
--   IZVOZ-DOBARA        false  ✔ odgovor 8, doslovno: „Takva faktura ne ide na sef."
--   SLOBODNA-ZONA       true   ✔ odgovor 8, doslovno: „Takva faktura se šalje na SEF."
--   OPLEMENJIVANJE      false  ✔ POTVRĐENO DANAS — do danas IZVEDENO, uz „ČEKA POTVRDU"
--   USLUGA-VAN-RS       false  ✔ POTVRĐENO DANAS — isto, bilo izvedeno
--   USLUGA-STRANO-LICE  false  ✔ POTVRĐENO DANAS — isto, bilo izvedeno
--   DOMACI-OSLOBODJEN   true   ⚠️ NE DIRA SE — v. dole
--
-- Dakle nijedan `UPDATE` nad `goes_to_sef` nije potreban: knjigovođa je potvrdio tačno
-- ono što je bilo izvedeno. Menja se STATUS te tri vrednosti (iz pretpostavke u odluku),
-- ne same vrednosti — zato ovde nema SQL-a, nego zaključavanje testom
-- (`vat-exemption-basis.spec.ts`).
--
-- ⚠️ ZAŠTO `DOMACI-OSLOBODJEN` OSTAJE `true` I POSLE OVE REČENICE
-- Tačka 5 stoji u DVA reda: `SLOBODNA-ZONA` (izvozni promet) i `DOMACI-OSLOBODJEN`
-- (domaći promet). Obrazloženje knjigovođe — „jer se rade kao izvozna dokumenta" — po
-- svom tekstu važi samo za promet stranom licu. Domaći oslobođen račun izdaje se domaćem
-- obvezniku i za njega je izdavanje e-fakture zakonska obaveza; oboriti ga na `false` na
-- osnovu rečenice o IZVOZNIM dokumentima značilo bi zaustaviti promet koji ide svaki dan,
-- i to tumačenjem koje knjigovođa nije izrekao. Pitanje mu se vraća.
--
-- ⚠️ `basisAllowsSef(null)` (osnov nije izabran) OSTAJE `null`, a ne dozvola. Ta grana se
-- ovom migracijom ne dira: „nije izabrano" nije tvrdnja da dokument sme na SEF.
