# Batch zahteva 31.07.2026 (045–049/26 + zaostali 026/26) — plan i izveštaj isporuke

**Status: ISPORUČENO 31.07.2026** — svih 6 zahteva na produ (`main` 48fe0e57), post-deploy verify 🟢 EXIT 0,
svi zahtevi prebačeni na `READY_FOR_TEST` uz komentar podnosiocu.

Tok rada: Fable analiza/plan → 6 Opus agenata (worktree + grana + PR po zahtevu) →
adversarial review (41 agent, 33 nalaza, **28 potvrđenih** posle unakrsne verifikacije) →
4 fix agenta → primena sy15 SQL-ova → merge → deploy → verify.

## Isporučeno

| Req | Naslov | Podnosilac | PR | Suština isporuke |
|---|---|---|---|---|
| 045/26 | Odobrenje primopredaje (BUG) | Milan Stojadinović | #62 | Pravo `primopredaje.write` dodeljeno; banner kad je neko odobravač bez prava |
| 047/26 | Unos mašine sa šifrom otpisane | Zoran Jaraković | #64 | Otpis oslobađa šifru (`#ARH-datum`), restore je vraća, jasne 409 poruke |
| 048/26 | Zahtevi — filter po podnosiocu | Zoran Jaraković | #61 | Filter „Podnosilac" + imena u listi + `GET /zahtevi/podnosioci` |
| 049/26 | Export PDF-a ukupan gant | Milan Stojadinović | #63 | Jedna strana: format po sadržaju + fit-skaliranje (clamp 3000 mm) |
| 026/26 | Izmena/otkaz potvrđenog GO | Zoran Jaraković | #65 | Molba zaposlenog → HR odluka; dani se vraćaju u fond |
| 046/26 | Planiranje proizvodnje (MS Project) | Strahinja Petrović | #66 | **F0+F1**: model termina/hala + novi tab „Gant" |

## Šta je review sprečio (dva ozbiljna, zatečena problema)

1. **047 — CRITICAL, zatečeni defekt u sy15 RPC-u.** `public.maint_machine_rename` je kopirao red
   mašine **bez `asset_id`**, pa je trigger `maint_machines_ensure_asset` vezivao pogrešno sredstvo:
   otpisana mašina bi izgubila istoriju radnih naloga i dokumenata, nova mašina pod oslobođenom
   šifrom nasledila bi tuđu (arhiviranu) istoriju i ne bi se pojavljivala u pickerima naloga, a
   vraćanje iz arhive ostavljalo bi aktivno „fantomsko" sredstvo. Popravljeno u
   `backend/docs/migration/ZAHTEV_047_MASINA_RENAME_FIX.sql` (RPC nosi `asset_id`, preimenuje
   `maint_assets.asset_code`, seli `maint_machine_files`) — **primenjeno na sy15 31.07**.
   Zatečeni red `3.10#ARH-20260730` saniran ručno (data-fix sekcija skripte je pala na redosledu
   preimenovanja): mašina vraćena na izvorno sredstvo, fantom obrisan, `asset_code` poravnat.
2. **026 — HIGH, zatečena rupa u pravima.** `hr_revise_/hr_cancel_/hr_delete_vacation_request` su
   puštale **podnosioca** da jednostrano skine ili izmeni **već odobren** termin GO, bez HR odluke
   (važilo i iz 1.0). Zatvoreno na nivou baze guardom `needs_change_request`; HR i dalje sme direktno.

Ostali potvrđeni nalazi (26) ispravljeni su pre merge-a — najvažniji: gant „Sačuvaj termin" je
naduvavao planirani kraj pri svakom snimanju (kompaundovanje), validacija parcijalnog patch-a je
propuštala invertovan interval, `p_actor_email` je omogućavao lažno predstavljanje pri direktnom
pozivu sy15 RPC-a, a notifikaciona funkcija je bila izvršiva svakom prijavljenom korisniku.

## Primenjeno ručno na živim bazama (van git deploy-a)

| Kad | Gde | Šta |
|---|---|---|
| 31.07 | app baza | `user_permission_overrides`: user 29 → `primopredaje.write` + `.read` |
| 31.07 | sy15 | Otpisana mašina `3.10` → `3.10#ARH-20260730` (RPC), pa ručna sanacija sredstva |
| 31.07 | sy15 | `ZAHTEV_047_MASINA_RENAME_FIX.sql` sekcija 1 (popravljen RPC) |
| 31.07 | sy15 | `ZAHTEV_026_GO_IZMENA_OTKAZ.sql` (tabela + RLS + RPC + guardovi; backup starih definicija u `vacreq_fn_defs_backup_026`) |

## Otvoreno posle isporuke

**046 — Strahinja:**
- Šifrarnik hala je **prazan** — dugme „Hale" u Gant tabu, treba dodeliti hale mašinama.
- Potvrda da je „sklop" = predmet izveden iz RN ident broja.
- **F2 (sledeća faza):** automatski predlog mašine, zbir opterećenja po mašini/hali, automatsko
  pomeranje naslednika po uslovu + strelice između barova, kalendar smena/kapaciteta,
  sat-granularnost prevlačenja. Render je za sada ograničen na 300 redova uz poruku „suzi filter".

**026 — odluke koje čekaju:**
- Da li braniti otkazivanje termina koji je već počeo/prošao (jedan `IF` u `kadr_vacreq_change_submit`).
- `/mob/odobravanja` za HR nije dopunjen (HR odlučuje na desktopu).
- PDF rešenja se posle odobrene izmene ne regeneriše automatski.
- 1.0 FE ne poznaje `needs_change_request` → radnik tamo dobija generičku poruku (izmena bi išla u 1.0 repo).

**045:** Milan zavisi od per-user override-a (odluka vlasnika: rola `leadpm` se ne menja globalno).
Svaki novi odobravač primopredaja mora dobiti isti override — zapisano u
`backend/src/common/authz/primopredaja-approvers.ts`.

## Pouke za sledeći batch

- Prilozi zahteva se ne mogu skinuti preko javnog gateway-a (bucket `zahtevi-prilozi` je privatan,
  vraća 400). Čitaju se sa servera: `docker exec sy15-storage cat
  /var/lib/storage/stub/servosync/zahtevi-prilozi/req/<id>/<uuid>/<verzija>` — **objekat je
  direktorijum**, fajl unutra ima nasumično ime.
- Paralelne sesije: pri merge-u je pukao konflikt sa tuđim „zamena dana" paketom u istom import
  bloku `/mob/odsustva` — rezervacija zahteva (`branch_name`, `implemented_by`) i rebase na svež
  main pre push-a ostaju obavezni.
- Redosled je bitan kad isporuka nosi sy15 SQL: **prvo SQL na bazu, pa merge/deploy**. Obrnuto
  ostavlja prozor u kome nova ruta puca (kod to sada mapira u 503 sa jasnom porukom umesto 500).
