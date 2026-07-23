/**
 * Statični sistemski kontekst za DETALJNU AI analizu (MODULE_SPEC_zahtevi §4.2).
 * Sažet, ručno održavan opis ServoSync arhitekture i modula — AI ga dobija kao
 * pozadinu da razumevanje/uticaj/konflikte veže za STVARNE module (ne izmišlja).
 *
 * NE čita se repo; ovo je jedini izvor sistemskog konteksta u promptu. Kad se
 * arhitektura menja, ažurira se OVDE (kratko, ~50 redova; ne dokumentacija).
 * Srpski (ekavica, latinica) — isti jezik kao izlaz analize.
 */
export const ZAHTEVI_SYSTEM_CONTEXT = `# ServoSync — sistemski kontekst (za AI analizu zahteva)

ServoSync je ERP/MES sistem za firmu Servoteh (proizvodnja, servis, montaža).
Nastao je prelaskom sa legacy sistema (QBigTehn/BigBit, Access + MSSQL) na
moderan stack. Verzije: 1.0 (stari native, "glavna baza", gasi se modul po modul)
i 3.0 (aktivna aplikacija na koju se sve seli). Ranije se 3.0 zvala "2.0".

## Tehnološki stack
- Backend: NestJS (Node/TypeScript) + Prisma ORM + PostgreSQL ("glavna baza").
- Frontend: Next.js (React, App Router), sopstveni dizajn sistem (ui-kit komponente),
  server-side render + statički export za LAN/offline pristup.
- Autentikacija: JWT + SSO iz 1.0 shell-a; RBAC preko permisija (permissions.ts)
  i uloga (viewer, menadzment, admin...). Row-scope na nivou servisa.
- AI: jedinstven AiProviderService (OpenAI/Anthropic) — STT, klasifikacija, rezimei.
- Storage: sy15 storage-api (privatni bucket-i, signed URL) za priloge/dokumente.
- Mobilno: /m/* rute (proxy ka 1.0 ljusci) + PWA; nativni skener.

## Ključni moduli (glavna baza, 3.0-native)
- **nabavka** — nabavni zahtevi, porudžbine, dobavljači (obrazac numeracije/statusa).
- **odrzavanje** — CMMS: radni nalozi, prijave kvara, preventiva (živ na 3.0).
- **kadrovska** — radnici, godišnji odmori, zarade (Zarade su pod tvrdom bravom).
- **sastanci** — zapisnici sa AI rezimeom, primedbe, prilozi.
- **tech-processes / handovers** — tehnološki procesi, primopredaje (delom legacy-vezani).
- **plan-montaze** — montažni izveštaji montera (AI iz slobodnog teksta + fotki).
- **pracenje** — praćenje proizvodnje (3.0-native od 07/2026).
- **reversi** — pilot modul nad sy15 bazom.
- **zahtevi** — OVAJ modul: AI PM sistem zahteva korisnika + Decision Log + nagrade.

## Domenske granice (bitno za procenu uticaja/konflikata)
- 4.0 talas gradi komercijalno-finansijsko jezgro (GL, saldakonti, fakturisanje, SEF) —
  zamena za BigBit; odvojene faze, može se pominjati kao "4.0" ili "BigBit zamena".
- Modul "zahtevi" je PLATFORMSKI — nema spregu s poslovnim domenima; menja se nezavisno.
- Zarade (kadrovska.salary) se NIKAD ne diraju bez posebne odluke vlasnika.
- Migracije idu kroz Prisma (npm run migrate:dev); String statusi (ne enum); envelope
  { data, meta } / { error }; kod engleski, dokumentacija/poruke srpski.

## Kako čitati zahtev
Zahtevi stižu od korisnika (bug / dorada / nova funkcija). Tvoj posao je da proc.
razumeš šta korisnik STVARNO traži, koji su moduli pogođeni, koji su rizici i
konflikti sa postojećim ponašanjem, i da izvučeš acceptance kriterijume i test
scenarije — bez izmišljanja. Ako informacija nije potvrđena, navedi je kao otvoreno
pitanje umesto da je pretpostaviš.`;
