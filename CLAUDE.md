# ServoSync 2.0 — backend (instrukcije za AI-asistiran razvoj)

NestJS 11 + Prisma 6 + PostgreSQL 16 backend. **Pre bilo kakvog posla pročitaj
[docs/BACKEND_RULES.md](docs/BACKEND_RULES.md)** — autoritativna pravila. Redosled važenja:
BACKEND_RULES.md + postojeći kod → [docs/ROADMAP.md](docs/ROADMAP.md) →
[docs/design/ARCHITECTURE.md](docs/design/ARCHITECTURE.md) (Lukin draft — vizija, mestimično prevaziđena;
odstupanja su popisana u BACKEND_RULES.md §2 — ne "ispravljaj" kod prema draftu).

## Tvrda pravila (kratka verzija)

1. **Šema:** modeli PascalCase singular / tabele snake_case plural / constraints `pk_/fk_/uq_/idx_` eksplicitno.
   Legacy tabele: legacy ključ = `id` (Int), **ne UUID**; `/// Was: <StaroIme>` komentar obavezan; izmena
   legacy tabele = ažuriraj [docs/schema-rename-map.md](docs/schema-rename-map.md).
2. **Statusi/role su String, ne Prisma enum** — dozvoljene vrednosti u `///` komentaru. Novac/količine `Decimal`, nikad Float.
3. **Migracije:** svaka izmena šeme kroz `npm run migrate:dev`; primenjene migracije se ne edituju.
4. **Sync-ovane tabele su cache** — piše ih samo sync modul. Aplikativna polja se NE dodaju u njih
   (otvorena odluka o overlay-u — BACKEND_RULES.md §11.1). U QBigTehn MSSQL se **nikada ne piše** (samo
   parametrizovani SELECT, kolone sa razmacima u `[zagradama]`).
5. **Novi syncer** = obrazac iz `src/modules/sync/syncers/customer.syncer.ts`: iscrpno mapiranje kolona,
   null-ovanje nerazrešivih FK-ova, skip-ne-abort po redu, kursor u `bb_sync_state`, registracija u
   `SyncService`, test mapiranja.
6. **Moduli:** `src/modules/<domen>/` sa controller/service/module/dto; fajlovi kebab-case; REST resursi
   plural kebab-case; response envelope `{ data, meta }` / `{ error: { code, ... } }` za domenske endpointe;
   Decimal u JSON-u kao string.
7. **500 samo za neočekivano** — poslovne greške su tipizirane exception klase sa kodom iz error kataloga.
8. **Mutirajući endpoint bez auth-a dobija `TODO(auth)` marker**; postojeći u `sync.controller.ts` se zatvara
   čim auth modul nastane.
9. **Kod/komentari/commit poruke na engleskom** (Conventional Commits, scope = modul); dokumentacija na srpskom.
10. **Nova env promenljiva = red u `.env.example`.** Nova zavisnost = samo uz izričito odobrenje korisnika.
11. **Ne implementiraj otvorene odluke** iz BACKEND_RULES.md §11 (hibrid šema, delete propagacija, MS SQL
    procedure logika...) — one čekaju potvrdu Negovana/Nese.

## Kontekst

- Ovaj repo je ServoSync **2.0**: proizvodni core (RN, TP, PDM/BOM, MRP...) prerađen iz QBigTehn legacy sistema.
- Frontend u [../frontend/](../frontend/) ima sopstvena pravila ([../frontend/CLAUDE.md](../frontend/CLAUDE.md)).
- Setup: `npm run bootstrap`; dev baza: Docker Postgres na portu 5435; prod ide na on-prem Ubuntu server.
- **Infrastruktura i pristup** (mašine, prod baza, deploy, kako se prilazi bazi):
  [docs/infra/INFRASTRUKTURA.md](docs/infra/INFRASTRUKTURA.md) — master; uz [docs/infra/INSTALACIJA-VM.md](docs/infra/INSTALACIJA-VM.md)
  i [docs/infra/SCADA-RELAY.md](docs/infra/SCADA-RELAY.md).
