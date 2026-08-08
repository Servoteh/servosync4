import { Prisma } from "@prisma/client";

/**
 * Deljeni SQL izrazi modula Plan proizvodnje — JEDAN izvor za read i write sloj.
 *
 * Postoji zbog 075/26 (kaskadno pomeranje lanca): pravilo preskoka u kaskadi mora da
 * sudi ISTOM gotovošću kojom read sloj crta kvačicu i oznaku škarta na gantu. Bez
 * zajedničke konstante bi se dve grane iste formule razišle prvom sledećom izmenom
 * pravila — klasa greške koja se u ovom repou već desila dvaput (numeracija RN-a).
 */

/**
 * 069/26 — GOTOVOST POZICIJE U PLANU (Strahinja, odluka Nenad 05.08.2026).
 *
 * Kanon kvaliteta delova (ogledalo `PART_QUALITY`, tech-processes.service.ts §1):
 * **0=dobar, 1=dorada, 2=škart** — u SQL-u ostaju doslovni brojevi, kao svuda u
 * `plan-proizvodnje-read.service.ts` (g4 lateral, `bigtehn_rework_scrap_cache`).
 *
 * Zatečeno pravilo je bilo `COALESCE(planned_done, bool_or(is_process_finished))` —
 * dakle „gotovo" čim je RADNIK NEGDE pritisnuo „Kraj rada", bez obzira na količinu.
 * To je nasleđe starog značenja te zastavice („gotov sam za danas"), zbog kog je
 * 05.08. sanirana istorija kioska. Novo pravilo:
 *
 *   gotovo = ručna presuda planera  ILI  DOBRIH komada ≥ plan
 *
 * Dva bitna detalja, oba mereno na produkciji 05.08.2026:
 *
 * 1. **Broje se SAMO DOBRI komadi** — `quality_type_id = 0`, doslovno kao praćenje
 *    (`QUALITY_GOOD`) i tech-processes (`PART_QUALITY.GOOD`). NAMERNO nije napisano kao
 *    „sve što nije 1/2": tako bi buduća 4. vrsta kvaliteta u planu prošla kao DOBRA, a u
 *    druga dva modula ne bi — plan bi tiho zatvarao ono što oni drže otvorenim. Škart je
 *    otpad, a dorada NIJE još ispravan deo — kad se dorada ispravi, vraća se SVEŽIM
 *    dobrim kucanjem koje se tek onda broji. Plan je bio jedini modul koji je odstupao,
 *    pa se time tri modula poravnavaju, ne razilaze.
 *    Posledica: operacija sa nenadoknađenim škartom SAMA OD SEBE ne dobije kvačicu —
 *    tako je Strahinjin zahtev („umesto štiklirano da je gotovo, da piše škart")
 *    ispunjen pravilom, bez ijednog dodatnog stanja u bazi.
 *
 * 2. **Zastavica ostaje SAMO gde količina nije merljiva.** Izmereno: `komada_total` nije
 *    prazan/0 ni na jednoj od 51.321 operacije kroz predmet-gate, pa ta polovina grane
 *    danas nikad ne okine; živi deo su mašine `without_process` (1.390 operacija, opšti
 *    nalozi na kojima se komadi ne kucaju — samo 34 ima ijednu prijavu, nijedna škart).
 *    Grana danas ne spašava NIJEDNU poziciju od gubitka kvačice; stoji zato što bi bez
 *    nje operacija na kojoj se komadi nikad ne kucaju postala trajno nezatvoriva
 *    automatikom. Cena: za tih 1.390 kvačica i dalje dolazi iz stare zastavice, a oznaka
 *    škarta na njima ne može da se upali — svesno, jer tamo nema merila.
 *
 * Izmereno pred izmenu (51.321 operacija kroz predmet-gate): kvačicu GUBI 1.525
 * pozicija (od toga 362 bez ijednog otkucanog komada, 451 na već zatvorenom RN-u,
 * 79 sa škartom), a DOBIJA je **0** — dakle ne postoji slučaj u kom je količina
 * kompletirana a plan to nije pokupio; promena je isključivo „prestani da lažeš".
 * Na gantu (32 planirane pozicije) menja se **1 red**. Lista „Po mašini" se NE dira:
 * ona filtrira po SIROVOJ zastavici (`OPEN_OPS` → `is_done_in_bigtehn`), pa promena
 * pravila ne može ništa da vrati u listu niti da izbaci iz nje.
 *
 * ⚠️ Izraz referiše aliase `base` i `tr` — SVAKI upit koji ga koristi mora svoje
 * podupite da aliasira tako (`effectiveOpsInner` u read sloju, `collectChain` u write
 * sloju). Potrošači: read (kvačica + oznaka škarta) i write (pravilo preskoka u kaskadi
 * 075/26). JEDAN izvor — bez ovoga se kvačica na gantu i pravilo preskoka raziđu prvom
 * sledećom izmenom pravila.
 *
 * ⚠️ NE praviti od ovoga funkciju `isCompletedEffectiveSql(baseAlias, trAlias)`:
 * parametrizacija znači prekucavanje šablona nad upitom koji vraća gant za 51.321
 * poziciju, a dobija se samo sloboda da se aliasi zovu drugačije.
 *
 * FE ogledalo (optimistički update posle klika planera): `autoDone()` u
 * `frontend/src/api/plan-proizvodnje.ts`.
 */
// 078/26: ručni override završenosti dolazi iz TERMINA (`tp`), ne više sa overlay-a —
// v. lateral „najraniji nezavršen termin" u `effectiveOpsInner`. Ostatak izraza
// (kucanja, plan, ne-mašinske operacije) je NETAKNUT.
export const IS_COMPLETED_EFFECTIVE = Prisma.sql`COALESCE(tp.planned_done, base.ov_planned_done,
        CASE WHEN base.komada_total IS NOT NULL AND base.komada_total > 0
                  AND base.is_non_machining IS NOT TRUE
             THEN COALESCE(tr.good_done, 0) >= base.komada_total
             ELSE COALESCE(tr.is_done, false) END)`;
