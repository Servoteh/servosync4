# ServoSync — pokretanje sync-a na serveru

Koraci za pokretanje "sync na dugme" (QBigTehn / MSSQL → Postgres) na mašini
koja je **na firminom LAN-u** (ili preko VPN-a do njega).

> Bez pristupa `Vasa-SQL:5765` i bez prave lozinke za `bridge_reader` sync
> ne može da se poveže — to je jedini deo koji zavisi od mreže, ne od koda.

---

## 1. Preduslovi

- Node.js 20+ i npm (provereno na Node 24)
- Docker + Docker Compose (za Postgres)
- Mrežni pristup do `Vasa-SQL:5765` (proveri sa `nc -z -w5 Vasa-SQL 5765`)

## 2. Konfiguracija `.env`

`.env` se **ne nalazi na gitu** (namerno). Napravi ga iz šablona:

```bash
cp .env.example .env
```

Zatim u `.env` upiši prave vrednosti, pre svega lozinku:

```dotenv
BIGBIT_DB_HOST=Vasa-SQL
BIGBIT_DB_PORT=5765
BIGBIT_DB_NAME=QBigTehn
BIGBIT_DB_USER=bridge_reader
BIGBIT_DB_PASSWORD=<PRAVA_LOZINKA>   # <-- obavezno
```

## 3. Instalacija i baza

```bash
npm install                 # instalira zavisnosti
docker compose up -d db     # podigne Postgres (port 5435)
npx prisma generate         # generise Prisma klijent
npx prisma migrate deploy   # primeni migracije na bazu
```

## 4. Pokretanje aplikacije

```bash
npm run start:dev           # razvojni rezim (watch)
# ili za produkciju:
npm run build && npm run start:prod
```

Sve rute imaju prefiks **`/api`**. Podrazumevani port je `3000`.

## 5. Test konekcije (korak 2)

```bash
curl http://localhost:3000/api/sync/health
```

Očekivano kad je sve OK:

```json
{ "source": "up", "sqlServerVersion": "Microsoft SQL Server ...", "entities": ["customers"] }
```

Ako je `"source": "down"` → proveri mrežu do `Vasa-SQL:5765` i lozinku u `.env`.

## 6. Probni sync (korak 3)

```bash
# Pokreni sync za customers (Komitenti)
curl -X POST http://localhost:3000/api/sync/run \
  -H 'Content-Type: application/json' \
  -d '{"entities":["customers"]}'

# Proveri rezultat / stanje
curl http://localhost:3000/api/sync/state/customers
curl http://localhost:3000/api/sync/log
```

Uspešan run vraća `status: "success"` i `rowsUpserted > 0`.

---

## Endpoint pregled

| Metod | Ruta | Opis |
|-------|------|------|
| POST | `/api/sync/run` | Pokreni sync. Body (opciono): `{"entities":["customers"],"strategy":"incremental"}` |
| GET | `/api/sync/state` | Stanje svih entiteta |
| GET | `/api/sync/state/:entity` | Stanje jednog entiteta |
| GET | `/api/sync/log` | Istorija run-ova (`?limit=` opciono) |
| GET | `/api/sync/log/:id` | Detalji jednog run-a |
| GET | `/api/sync/health` | Da li je izvor (MSSQL) dostupan |

## Napomene

- **Strategije**: `incremental` (podrazumevano, koristi `PoslednjaIzmena` kao vodeni žig)
  ili `full_refresh` (povuče sve).
- Dva sync-a se ne mogu preklopiti — drugi poziv vraća `409 Conflict`.
- `POST /api/sync/run` **još nije zaštićen auth-om** (TODO). Dok se ne doda auth
  guard, ne izlagati ovaj endpoint van interne mreže.
- Trenutno je implementiran samo entitet `customers`. Novi entiteti se dodaju
  kao novi `EntitySyncer` i registruju u `SyncService`.
