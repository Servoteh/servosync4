# Poređenje: QBigTehn vs plan-montaže — šta je komplikovanije, šta veći posao

> Izvor: read-only multi-agent analiza (3 workflow-a), 2026-07-03. Ništa u kodu nije menjano — samo analiza. Prateći izveštaji: [01-qbigtehn-architecture-analysis.md](01-qbigtehn-architecture-analysis.md), [02-qbigtehn-scope-triage.md](02-qbigtehn-scope-triage.md), [03-planmontaze-complexity-profile.md](03-planmontaze-complexity-profile.md).

## Odgovor u jednoj rečenici (dve ose)
- **Komplikovanije (teže dešifrovati):** **QBigTehn** — tuđi nedokumentovan legacy, znanje zaključano kod Negovana.
- **Veći posao (više ukupnog truda):** **plan-montaže** — ~180K linija živih feature-a + nemapabilan Supabase sloj.

## Brojke jedna do druge

| | **QBigTehn** (legacy → prevodimo) | **plan-montaže** (ServoSync 1.0) |
|---|---|---|
| Priroda posla | **Greenfield rebuild** uz reverse-eng | **Re-platform** žive aplikacije |
| Kod | 454 VBA / ~92K linija, 236 formi, 404 upita, 36 izv. = **873 artefakta** | **~180K linija** (151K JS + 29K CSS), 342 JS fajla |
| Moduli | 9 proizvodnih (scope V1) | 19 poslovnih |
| Baza | ~90 tabela + 51 SP + 63 fn + 9 view (SQL Server) | **140 tabela, 293 RLS politike, 238 SECURITY DEFINER fn**, 337 migracija |
| Bezbednost | Access ULS (skinut) → gradi se od nule | **293 RLS = jedini authz sloj** (najteži deo) |
| Runtime hard delovi | SP/UDF tela **fale iz izvoza** (`ftBOM*`, `ftMRP*`, `spPDM*`) | realtime, offline queue, pg_cron/pg_net, push, mobilna |
| Dokumentacija/testovi | rekonstruisana (QMegaTeh doc) | 168 md + **582 vitest + 29 pgTAP** |
| Čiji je | vendor (BIT CO.), nepoznat | **tvoj** |
| Ocena težine | visoka na **neizvesnosti** | **5/5** (impedance-mismatch ka NestJS/Prisma) |

## Finalni scope QBigTehn-a (posle klasifikacije 873 fajla)

| Kategorija | Fajlova | % |
|---|---|---|
| USED (uključuje infra plumbing) | 584 | 67% |
| — **realno proizvodno jezgro** (PDM+RN+TP+MRP+lokacije+core) | **~382** | **~44%** |
| — infra/config (rewrite, ne migrate) | ~162 | ~19% |
| **OUT-OF-SCOPE bloat** (POS/kafe/fiskal/knjigovodstvo + tuđi klijenti) | 226 | 26% |
| AMBIGUOUS (čeka Negovana) | 63 | 7% |

Najveći izvor bloata: **upiti — 170 od 404 (42%)** su migracije drugih vendorskih klijenata (GR, DX, VULEMARKET, JUGOLEK…). Realan migracioni payload je **~44%, ne 100%**.

## Verdikt po osama

| Osa | Pobednik | Zašto |
|---|---|---|
| Komplikovanije (teže razumeti) | **QBigTehn** | tuđi VBA, znanje kod Negovana, SP/UDF tela fale iz izvoza, multi-tenant zbrka |
| Veći posao (više truda) | **plan-montaže** | ~180K linija živih feature-a + 293 RLS + 238 RPC bez drop-in zamene |
| Veći rizik (lakše zabrljati) | **QBigTehn** | reverse-eng + Negovan usko grlo (vremenski osetljivo) |
| Predvidivije | **plan-montaže** | tvoj kod, dokumentovan, 582 testa |

**Ključna nijansa:** QBigTehn deluje ogromno (873 fajla), ali realan payload je ~382 (~44%), i dobar deo je CRUD nad podacima koji stižu kroz BigBit sync. plan-montaže **nema takav „popust"** — ~180K linija je skoro sve živo.

## Zaključak i preporuka redosleda
- **Neto veći posao:** plan-montaže (obim + nemapabilni Supabase sloj), ali niži rizik (tvoje, testirano).
- **Neto teže/rizičnije:** QBigTehn (dešifrovanje + Negovan).
- **Redosled: QBigTehn prvo** — temelj/izvor podataka, gated Negovanom (osetljivo na vreme), i uži je nego što je delovao (~44% scope). Migrirati po proizvodnom toku iz PDF-a (PDM → Nacrti → Primopredaja → RN → TP → Proizvodnja → Lokacija), infra tretirati kao *rewrite*, bloat/„NeKoristiSe" ne dirati. plan-montaže migracija je veća ali može kasnije i manje je rizična.
