# ServoSync AI — analiza predloga i plan izvođenja

**Datum:** 26.07.2026 · **Autor:** Fable (planiranje) / Opus (izvođenje) · **Naručilac:** Nenad
**Ulaz:** dokument „ServoSync AI Vision, Architecture & Roadmap" (Nenad, 26.07)
**Osnova:** inventura stvarnog stanja od 26.07 (7 revizija nad kodom i živim bazama; svi brojevi
ispod su izmereni, ne procenjeni)

---

## 1. Presuda u jednoj rečenici

Vizija je ispravna i vredna — ali **pola predloženih funkcija čeka podatke koji još ne postoje**,
dok druga polovina može da se gradi odmah jer je temelj (gateway, alati, prava, RLS) **već živ na
produkciji**; plan zato ne počinje izgradnjom platforme nego (1) higijenom postojećeg AI sloja,
(2) učenjem asistenta da vidi proizvodno jezgro i (3) disciplinom beleženja podataka koji će
kasnije hraniti sve ostalo.

---

## 2. Šta već imamo (izmereno 26.07)

### 2.1 AI temelj — postoji više nego što vizija pretpostavlja

| Vizija traži | Zatečeno stanje |
|---|---|
| §3.1 AI Gateway | **POSTOJI**: `AiProviderService` (582 linije, globalni modul) — svih 8 HTTP poziva ka LLM-ovima je u tom jednom fajlu; nijedan modul ne zove provajdere direktno. Multi-provider (OpenAI/Claude/Gemini/Kimi; na produ ključevi samo za prva dva). |
| §3.2 Tool Registry | **DELIMIČNO**: 20 alata (`ai-tools.ts`) sa JSON šemama + `toolsForScope`; izvršenje kroz `withUserRls` — **prava presuđuje baza, ne prompt**. Mane: definicija i izvršenje u 2 fajla bez provere poklapanja; nema read/write oznake; jedina permisija u celom toku je `ai.chat`. |
| §2.6 AI vidi samo što korisnik sme | **POSTOJI za sy15** (RLS + GUC identitet). **NE POSTOJI za glavnu bazu**: 0 RLS politika na 176 tabela — tamo je jedina odbrana HTTP guard, koji AI alati ne konsultuju. |
| §2.2 Human-in-the-loop | **DOKAZANO u praksi**: modul Zahtevi (= vizija §4.30, već živ) — AI trijaža 20 komada, ocena 0–5, 1 auto-odbijen, 15× čovek potvrdio AI ocenu; AI nikad ne gazi ljudski unos. |
| §5.4 Voice-first | **POSTOJI**: Whisper STT (9 mesta u UI), „✨ Doteraj" (10 dugmadi), diktiranje zahteva. |
| §5.5 Multimodal | **DELIMIČNO**: vision u trijaži zahteva (slike priloga) i chat-u; OCR nalepnica je lokalni tesseract (nije LLM, radi offline — ne dirati). |
| §3.5 Knowledge Layer | **DELIMIČNO, na pogrešnom mestu**: pgvector RAG živ u **legacy sy15** (173 uputstva, HNSW; 51% HR sadržaja, dokumentacije mašina 2 kom). Glavna baza: **pgvector nije ni dostupan** u stock `postgres:18` image-u; nema ni `unaccent`/`pg_trgm` — pretraga je `ILIKE`, na dijakritici promašuje do 88% („zaptivac" nađe 6, „zaptivač" 44). |
| §3.3 Event Bus | **NE POSTOJI** kao pub/sub. ALI: scheduler (Talas A) je pravi job engine (18 poslova, claim+retry, novi posao = 20–40 linija), a globalni `audit_log` (15.830 redova) je de facto event log koji niko ne čita. To dvoje je naš „event bus" za prve 2–3 faze. |
| §3.8 Prompt Registry | **NE POSTOJI**: promptovi u 7 fajlova + 2 hard-kodirana u samom gateway-u; injection ograda postoji **samo** u Zahtevima. |
| §3.9 Evaluation | **NE POSTOJI** (samo mock unit testovi). |

**Upotreba do sada** (audit_log + tabele): chat 197 poruka / 43 niti / 20 korisnika (od 05.07);
trijaža 20; refine 5; STT 3; montažni AI izveštaj **0** (izgrađen, nikad upotrebljen); detaljna
AI analiza zahteva **0**. Ukupan trošak svih LLM poziva od početka: **ispod 1 USD**.
Pouka: **problem nije tehnologija nego usvajanje i merenje** — najbolje izgrađena funkcija ima
nula korisnika, a odnos ulaz/izlaz tokena je 53:1 jer se prompt + 20 šema šalju iznova u svakom
krugu bez keširanja.

### 2.2 Podaci — jedno jako jezgro, ostalo skela

| Oblast | Stanje danas | Dovoljno za AI? |
|---|---|---|
| **Proizvodno jezgro** | 40.860 RN · 99.063 prijave rada · 216.000 redova rutinga (2016→danas, ~100 prijava/dan) | **DA** — najvredniji skup koji imamo |
| Plan-vs-stvarno vreme | 22.115 upotrebljivih opservacija; 20 radnih mesta sa >300 merenja; ali 47% prijava zatvoreno za <1 min (šum) | **DA za model po radnom mestu**; NE po delu |
| Ponovljivost crteža | 84% brojeva crteža javlja se jednom, ALI po obimu: 36% posla ide na crteže koji se ponavljaju; 21% naloga od 2024. ima raniji nalog istog crteža | **DA za lookup** „prošli put je isto trajalo X" |
| Nacrti | 5.739 PDF u glavnoj bazi (88% veličine baze!); **CAD vektorski sa tekst slojem** — materijal, dimenzije, komitent čitljivi poppler-om **bez OCR-a** | **DA** — najjeftinija „baza znanja" koju imamo |
| Prisustvo | 486.689 događaja sa kapije (od 2015) | DA za analitiku kapaciteta |
| Kvalitet | <320 zapisa UKUPNO (40 NM + 2 Excel fajla: 100 škart + 50 dorada); 0,12% označenih prijava | **NE** — proces evidencije ne postoji |
| Nabavka/finansije 4.0 | **0 transakcija** (samo šifarnici); ekrani gotovi i čekaju. BigBit i dalje jedini ERP: 182.535 robnih stavki, 20.357 GL stavki, 3.568 zahteva za nabavku — po godini, u Access bazama | **NE** dok se 4.0 ne napuni ili sync ne automatizuje (danas: 3 ručna povlačenja ukupno) |
| Zalihe | 36 redova (jedan ručni sinc 06.07) | NE |
| Mašinski signali | SCADA 1,57M redova ali samo kotlarnice/solar, 24 dana retencije; **nijedan signal sa proizvodne mašine** | **NE** — prediktivno održavanje nema ulaz |
| Registar mašina | 90 mašina uparenih sa radnim mestima + 1.667 redova matrice radnik×mašina (sy15) | DA kao šifarnik |

### 2.3 Okvir izvođenja (određuje veličinu plana)

- **Jedan čovek**: 899/914 commita; realno ~80–120 čovek-sati mesečno, u burst ritmu.
- **Tvrd rok drži kritični put**: cutover sa BigBit-a 31.12.2026 — AI plan ne sme da ga ugrozi;
  naprotiv, AI treba da mu pomaže (4.0 ekrani postoje, prazni su zbog podataka).
- Deploy ciklus izmena→prod = desetine minuta; svaka faza mora biti mala i reverzibilna.
- BACKEND_RULES je ugovor koji se dokazano poštuje (ceo AI sloj na golom `fetch()` jer nove
  zavisnosti traže odobrenje) — AI sloj nastavlja u istom režimu.

---

## 3. Ključne presude oblikovanja (predlog → stvarnost)

1. **Ne gradimo novi Gateway — proširujemo postojeći.** `AiProviderService` ostaje jedina tačka;
   dodaju mu se retry/fallback, keširanje prompta, merenje po pozivu i registar modela.
   (Vizija §3.1 ispunjena evolucijom, neревolucijom.)
2. **Sekcija 9 vizije („počni beležiti podatke odmah") nije sporedna — ona je paralelna pruga
   celog plana.** Bez nje faze D–H vizije ostaju zauvek na papiru.
3. **Scheduler + audit_log su naš event bus** dok stvarna potreba ne dokaže suprotno. Pub/sub
   infrastruktura sada bi bila arhitektura bez potrošača.
4. **Prvi ML use-case nije LLM.** Procena vremena po radnom mestu je statistika nad 22k
   opservacija + lookup ponovljenih crteža — jeftinije, objašnjivije i tačnije od modela.
5. **Autonomija ide redom iz vizije §7** i trenutno smo na nivou 0–2 (pretraga/analiza/preporuka)
   sa jednim dokazanim nivoom 3 (trijaža zahteva). Nivo 4+ tek kad Action Center postoji.
6. **RAG jezgra ide u glavnu bazu, ne u sy15** (sy15 se gasi). To traži zamenu Postgres image-a
   (pgvector) — odluka sa downtime-om, planira se, ne improvizuje. Do tada: `unaccent` + `pg_trgm`
   + FTS su dostupni ODMAH bez restarta i rešavaju 80% dnevne muke sa pretragom.

---

## 4. Rangiranje 14 kandidata iz vizije (§14)

| # | Kandidat | Vrednost | Podaci danas | Presuda |
|---|---|---|---|---|
| 1 | AI pretraga svih podataka i dokumenata | visoka | jezgro DA, dokumenti DA (tekst sloj) | **TALAS 1–2** |
| 3 | Slični crteži + istorija | visoka | 21–36% ponovljivost, title block čitljiv | **TALAS 2** |
| 8 | Dnevni brief (direktor/PM) | visoka | živi podaci dovoljni, ne traži istoriju | **TALAS 3** |
| 10 | Product/Owner Inbox | — | **VEĆ ŽIVO** (modul Zahtevi) | gotovo; dopune po potrebi |
| 9 | Diktiranje ponuda/zapisnika/dopisa | srednja–visoka | STT+refine postoje; šabloni firme delimično | **TALAS 4** |
| 5 | Procena vremena operacija | visoka | 22.115 opservacija po radnom mestu | **TALAS 5** (statistika, ne LLM) |
| 6–7 | Nabavka: milestones, kašnjenja, upozorenja | visoka | **0 transakcija u 4.0** | čim 4.0 dobije podatke — ekrani spremni; AI sloj se doda za dane |
| 2 | Predlog pripremka iz lagera | visoka | lager = 36 redova | ČEKA lager podatke |
| 4 | Draft tehnološkog postupka | srednja | one-off pogon (84% unikat); istorija po radnom mestu može da pomogne | ČEKA Talas 5 kao osnovu; ne obećavati „AI piše tehnologiju" |

Ostalo iz vizije (DFM/DFA, cena koštanja, prediktivno održavanje, vision kontrola, digital twin,
knowledge graph, cyber analitika, energija): **NE SADA** — svaki ima naveden uslov u §7.

---

## 5. Plan talasa

> Svaki talas je samostalno isporučiv, ima meru uspeha i rollback (feature flag ili izostanak
> deploy-a). „Fable planira / Opus izvodi" — po talasu jedan ili dva agent-paketa sa
> adversarijalnim review-om pre push-a, po ustaljenom protokolu.

### TALAS AI-0 — Higijena i merenje postojećeg sloja *(malo, odmah; preduslov za sve)*

1. **Tiho sečenje odgovora — ispravka odmah**: `MAX_OUTPUT_TOKENS=1200` + adaptivno razmišljanje
   na claude-sonnet-5 = stvaran rizik da model „potroši" budžet na razmišljanje i odgovor bude
   odsečen. (Nalaz potvrđen kroz zvaničnu dokumentaciju.)
2. **Prompt caching** (`cache_control` na system prompt + šeme alata): odnos 53:1 pada višestruko;
   brže i jeftinije bez ikakve promene ponašanja.
3. **Retry + fallback u gateway-u**: 429/5xx → ponovi jednom → padni na rezervni model; danas
   jedan 429 od provajdera = 502 korisniku.
4. **`ai_usage_log` tabela u gateway-u**: svaki poziv (ko, modul, model, tokeni, trajanje, ishod,
   procena cene) — pokriva i STT/refine/trijažu koje danas niko ne broji. Limit prelazi sa
   „50 poruka" na token-budžet po korisniku/danu; STT i refine dobijaju svoj.
5. **Injection ograda generalizovana** iz Zahteva u zajednički helper (ai-chat prima tuđi tekst u
   deljenim nitima; uputstva/beleške su kanal uskladištene injekcije).
6. Sitno: `GET /ai/engines` (UI nudi samo konfigurisano — Gemini/Kimi dugmad danas garantovano
   vraćaju 503); haiku `thinking:adaptive` latentni 502; oba prompta iseljena iz gateway-a.
7. **Registar modela**: jedna tabela `ai_model_policy` (zadatak → model + effort + limit) umesto
   4 postojeća nepovezana mehanizma; Podešavanja ekran već postoji — proširuje se.

*Mera uspeha:* 0 tihih sečenja; ulazni tokeni po poruci −60%+; svaki AI poziv vidljiv u logu.

### TALAS AI-1 — Asistent koji vidi proizvodnju *(najveći skok vrednosti)*

Asistentova slepa mrlja: **svih 20 alata čita samo sy15** — o radnim nalozima, nacrtima,
artiklima i tehnologiji (glavna baza) ne zna ništa.

1. `CREATE EXTENSION unaccent, pg_trgm` na glavnoj bazi (stock image, bez restarta) + trigram
   indeksi na nazive artikala/nacrta/naloga → pretraga radi i bez kvačica i prestaje da bude
   Seq Scan (mereno 230 ms → očekivano <10 ms).
2. **Novi alati nad glavnom bazom** (read-only, kroz postojeće servise + PermissionsGuard
   semantiku — alat izvršava upit U IME korisnika i proverava permisiju modula, ne samo `ai.chat`):
   `nadji_radni_nalog`, `istorija_crteza` (prošli nalozi istog crteža + stvarna vremena —
   pokriva 21–36% posla!), `nadji_artikal`, `stanje_predmeta`, `tehnoloski_postupak_naloga`,
   `prisustvo_danas`.
3. **Konsolidacija tool registry-ja**: jedna definicija po alatu (ime + šema + handler +
   read/write + potrebna permisija); `toolsForScope` filtrira po permisijama KORISNIKA;
   nepoklapanje imena pada na testu, ne u runtime-u.
4. Svaki poziv alata u `audit_log` (danas se ne beleži).

*Mera uspeha:* asistent tačno odgovara na „gde je RN 9400-…", „koliko je puta rađen ovaj crtež i
koliko je trajalo"; broj chat poruka/nedelji raste (danas ~50/ned).

### TALAS AI-2 — Znanje: nacrti i dokumenti *(vizija §3.5 svedena na stvarno)*

1. **Title block ekstrakcija**: poppler (već na serveru) izvuče tekst sloj svih 5.739 nacrta u
   kolone (materijal, komitent, dimenzije, napomene) + FTS indeks. Bez OCR-a, bez LLM-a —
   jednokratan posao + hook na upload novog nacrta.
2. Alat `pretrazi_nacrte` („svi nacrti iz C45 za komitenta X preko 500 mm") + ekran pretrage.
3. **Odluka o pgvector-u glavne baze** (image swap = kratak downtime): kada prođe, embeduju se
   nacrti + uputstva + zapisnici + Decision Log (~0,10 USD tokena, ~1,5 GB prostora) i RAG se
   seli iz sy15. Do tada FTS nosi teret.
4. CIFS izvori (176 GB PDF + 112 GB XML) — samo popis i uzorkovanje u ovom talasu, ne
   indeksiranje.

*Mera uspeha:* tehnolog nalazi „sličan nacrt" za <30 s umesto listanja foldera.

### TALAS AI-3 — Briefovi: proaktivni AI bez čekanja istorije *(vizija §4.22)*

Sve iz živih tabela, deterministika + LLM sažetak, kroz postojeći scheduler + mail/zvonce:

1. **Dnevni brief direktoru** (07:00): kašnjenja RN vs rok, blokirani nalozi, zahtevi koji čekaju
   odluku, sastanci danas, kritična odsustva — rangirano, sa linkovima; LLM samo formuliše,
   brojevi su iz upita (bez halucinacija: svaka stavka nosi izvor).
2. **Nedeljni pregled po predmetu** za menadžment (postojeći sedmični mehanizam se proširuje).
3. Feature flag po korisniku; merenje otvaranja.

*Mera uspeha:* Nenad/menadžment čitaju brief umesto da sami sklapaju sliku; ≥1 akcija nedeljno
pokrenuta iz brief-a.

### TALAS AI-4 — Draft akcije *(nivo 3 autonomije; vizija §4.9/4.18/4.19)*

1. Zapisnik sastanka → **predlog zadataka** sa vlasnicima (akcioni plan modul postoji; AI samo
   popunjava draft koji čovek potvrđuje).
2. **Dopisi i mejlovi iz šablona firme** (refine + extractWithTool postoje): dopis, odluka,
   odgovor dobavljaču — uvek draft, uvek označen kao AI-generisan, verzija + autor.
3. **AI Action Center v1** = postojeće zvonce + nova tabla „AI predlozi" (prihvati/odbij/razlog)
   — od prvog dana beleži feedback (vizija §2.7) da bi kasniji nivoi autonomije imali osnovu.

### TALAS AI-5 — Procena vremena po radnom mestu *(prvi „pravi" model)*

1. Statistički model (medijana/kvantili po radnom mestu × tip operacije, filtriran od šuma
   <1 min) + lookup istorije istog crteža; interval, ne tačka.
2. Prikaz u tehnologiji i planiranju: „slični poslovi na ovom radnom mestu: 2,1–3,4 h/kom
   (n=412)" sa linkom na dokaze. Bez automatske izmene normativa — samo predlog (§2.2).

### PRUGA P — Podaci (teče kroz sve talase; vizija §9)

| Izvor | Akcija | Kada |
|---|---|---|
| Kvalitet | Excel škart/dorada (150 redova) → modul; obavezan razlog + operacija + mašina | organizaciona odluka + mali FE |
| BigBit sync | 3 ručna povlačenja → **noćni automatski** kroz scheduler | odmah (20–40 linija) |
| Nabavka 4.0 | početi unos (ekrani gotovi!); od prvog dana: milestone datumi plan/stvarno | Nenadova operativna odluka |
| Prijave rada | razlog zastoja/kašnjenja uz prijavu (danas ne postoji polje) | uz prvi sledeći FE rad na pogonu |
| Tehnologija | verzija + razlog izmene + stvarna mašina (vizija §9) | uz Talas 5 |

---

## 6. Šta se svesno NE radi sada (i tačan uslov da se otvori)

| Funkcija iz vizije | Uslov otvaranja |
|---|---|
| Predlog tehnologije / DFM / DFA (§4.3–4.4) | Talas 5 živ ≥3 meseca + tehnolozi potvrde korisnost istorijskih prikaza |
| Cena koštanja (§4.6) i profitabilnost (§4.21) | 4.0 finansije imaju ≥1 kvartal stvarnih transakcija |
| Nabavka AI (§4.7–4.8) | ≥50 stvarnih nabavki u 4.0 sa milestone datumima |
| Prediktivno održavanje (§4.15) | postoji bar jedan signal sa proizvodnih mašina (danas: nijedan) |
| AI vision kontrola (§4.14) | kvalitet modul živ + fotografije se sistematski prikupljaju |
| Knowledge graph (§3.6), Digital Twin (§H) | posle RAG-a jezgra + 2 kvartala punih podataka |
| Autonomni agenti (§6, nivo 5–6) | Action Center meri ≥70% prihvaćenih predloga na nivou 3 |
| Pub/sub event bus (§3.3) | ≥3 stvarna potrošača koje scheduler+audit_log ne pokrivaju |

---

## 7. Bezbednost (vizija §10, svedeno na obaveze po talasu)

- AI-0: injection ograda svuda; token limiti; usage log. **Tajne**: ključevi u čistom env-u u 2
  kontejnera — rotacija + jedna tačka (posebna stavka za Nenada, nezavisna od AI plana).
- AI-1: alat = permisija modula korisnika (ne samo `ai.chat`); svaki poziv alata u audit_log;
  write-alati traže eksplicitno odobrenje u UI (nema ih pre Talasa 4).
- AI-3/4: svaka AI stavka nosi izvor (link na zapis); draft je uvek označen kao AI-generisan;
  zabranjene radnje iz vizije §10 (slanje ponude, odobrenje uplate…) ostaju zabranjene i posle.
- Kill-switch: `AI_ENABLED` po modulu + po korisniku (feature flag), od Talasa AI-0.

---

## 8. Odluke — PRESUĐENO 26.07.2026 (Nenad)

1. **GO za plan; redosled AI-0 → AI-1 → AI-3** (higijena → asistent nad jezgrom → brief). ✅
2. **pgvector image swap glavne baze: princip ODOBREN**; tačan termin downtime-a potvrđuje se
   posebno kad dođe Talas AI-2 tačka 3. ✅
3. **Kvalitet kao proces: DA** — škart/dorada se sele iz Excela u modul; pogon dobija obavezu
   unosa (razlog + operacija + mašina). Sledi kratka specifikacija toka unosa (Fable) pre izrade. ✅
4. **BigBit noćni sync: UKLJUČITI ODMAH** (scheduler posao; paritet-guard ostaje). ✅
5. **Token budžeti**: važi predlog — 200k ulaznih tokena/korisnik/dan za chat, STT 30 min/dan,
   admin bez limita (prećutno prihvaćeno; koriguje se u Podešavanjima kad AI-0 isporuči registar).

---

## 9. Veza sa postojećim obavezama

Ovaj plan **ne dira** kritični put cutover-a 31.12.2026 (paritet 1.0→3.0, punjenje 4.0). Talasi
AI-0…AI-2 su mali paketi koji staju u postojeći ritam „zahtev po zahtev"; Pruga P direktno
POMAŽE cutover-u (BigBit sync, nabavka unos). Ako ikad dođe do sukoba prioriteta — cutover
pobeđuje, AI talas čeka.
