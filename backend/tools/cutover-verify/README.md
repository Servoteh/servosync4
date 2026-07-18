# cutover-verify — verifikacioni report za cutover (P4 spec §7.3)

Jednokratna skripta koja posle **finalnog force/full sync-a** (runbook
[17-cutover-runbook.md](../../docs/migration/17-cutover-runbook.md), korak 3) poredi tabele
QBigTehn lanca između legacy MSSQL-a i ServoSync 2.0 Postgres-a. Izlaz (Markdown) se prilaže uz
**runbook korak 4** — striktna odstupanja se rešavaju PRE nastavka cutover-a.

## Šta proverava

| Sekcija | Provera | Obara exit kod? |
|---|---|---|
| A | COUNT + MAX(id) po tabeli lanca (35 parova legacy ↔ 2.0, 1:1 id politika) | DA (osim `info` redova) |
| B | Derivirane primopredaje: `tRN.IDPrimopredaje > 0` vs `drawing_handovers.legacy_rn_id IS NOT NULL` | DA |
| C | MAX RN ordinal po predmetu (`IdentBroj` deo posle poslednjeg `/`) — RN numeracija mora nastaviti legacy niz | DA |
| D | Meki-FK orfani na 2.0 strani (batch-resolve lanac) | NE (informativno — legacy ih istorijski ima) |
| E | Broj PDF blobova (`PDM_PDFCrtezi.PDFBinary` vs `drawing_pdfs.pdf_binary`) — 2.0 mora imati ≥ (nativni upload dodaje) | DA |
| F | Statusna distribucija primopredaja 0/1/2/3 (legacy vs derivirano) | DA |

`info` redovi u sekciji A (paritet NIJE očekivan, ne obaraju exit kod):

- `drawing_import_log` — nativni 2.0 XML/PDF intake piše sopstvene redove;
- `drawing_pdfs` — nativni PDF upload (upsert po broj+revizija), composite PK pa nema MAX(id);
- `drawing_handover_pdfs` — legacy `PrimopredajaPDFCrteza` je očekivano prazna; ne-prazan izvor se
  NAMERNO ne uvozi (legacy `IDPrimopredaje` je nemapirljiv na derivirane `drawing_handovers`
  id-jeve — vidi `src/modules/sync/syncers/drawing-handover-pdf.syncer.ts`).

`drawing_handovers` se ne poredi po MAX(id): derivirani redovi nose nativni autoincrement id
(ključ je `legacy_rn_id`), zato posebna sekcija B.

Spisak tabela je izveden iz `sync-map.generated.ts` (isId kolone) + §5.3 privremenih syncera i
unakrsno proveren sa `QBIGTEHN_CHAIN_ENTITIES` u `src/modules/sync/table-ownership.ts`.

## Zavisnosti i odakle se pokreće

**Nula NOVIH zavisnosti** — skripta preko `createRequire` koristi `mssql` i `@prisma/client`
koje backend već ima. Zato se pokreće **iz backend checkout-a** posle:

```bash
npm ci
npx prisma generate
```

Mašina mora da vidi OBA servera: legacy MSSQL (vasa-SQL, `192.168.64.25:5765` — dostupan sa
ubuntusrv) i prod Postgres. Tipično: checkout na ubuntusrv (npr. Actions runner workdir) ili
`docker exec` u backend kontejner ako image sadrži `tools/` + `node_modules`.

> Direktan TDS/PG klijent bez ikakvih zavisnosti nije realan u jednom `.mjs` fajlu (TDS protokol,
> SCRAM auth) — zato je izabran put ponovnog korišćenja postojećih backend zavisnosti, a ne
> alternativa sa ručnim `sqlcmd`/`psql` SQL fajlovima (teže za uporedni report i lakše za grešku).

## Konfiguracija (env)

Ista imena kao backend (`src/modules/sync/mssql.client.ts` / `.env.example`); `.env` pored
`backend/package.json` se učitava kao fallback (ne pregazi postojeći env):

- `DATABASE_URL` — 2.0 Postgres (obavezno)
- `BIGBIT_DB_HOST`, `BIGBIT_DB_PORT`, `BIGBIT_DB_NAME`, `BIGBIT_DB_USER`, `BIGBIT_DB_PASSWORD`
- opciono: `BIGBIT_DB_ENCRYPT`, `BIGBIT_DB_TRUST_SERVER_CERT`, `BIGBIT_DB_REQUEST_TIMEOUT_MS`

Skripta izvršava ISKLJUČIVO `SELECT` na obe strane (read-only; `bridge_reader` nalog je dovoljan).

## Pokretanje

```bash
cd backend
node tools/cutover-verify/cutover-verify.mjs > cutover-report.md
echo $?   # 0 = paritet, 1 = striktna odstupanja, 2 = greška u radu
```

Report je Markdown — zalepiti ga u zapisnik runbook koraka 4.

## Exit kodovi

| Kod | Značenje |
|---|---|
| 0 | Paritet 1:1 u svim striktnim sekcijama — nastaviti na korak 5 (setval) |
| 1 | Striktna odstupanja — rešiti pa ponoviti report PRE nastavka |
| 2 | Greška u radu (konekcija, env, SQL) — report nepotpun |

## Tumačenje čestih odstupanja

- **COUNT manji u 2.0 uz `rowsSkipped` u sync logu** — §5.3 synceri preskaču redove sa
  nerazrešivim OBAVEZNIM FK (RN/radnik/RC-kod ne postoji): pogledati `bb_sync_log.metadata`
  (errors po entitetu), rešiti uzrok (najčešće redosled/kompletnost finalnog sync-a), pa force
  ponoviti entitet.
- **`work_orders` COUNT veći u 2.0** — nativni RN-ovi uneti posle finalnog sync-a (redosled
  runbook-a je prekršen) ili finalni sync nije bio force (protected skip) — proveriti
  `bb_sync_log`.
- **Sekcija C neslaganje** — RN brojač po predmetu bi se posle setval-a granao; NE nastavljati.
- **Sekcija D orfani** — istorijski legacy orfani su tolerisani (read putanje ih batch-resolve
  tolerišu); orfan nastao SAMO u 2.0 (nema ga u legacy) znači rupu u finalnom uvozu.

## Životni vek

Skripta je deo P4d cutover priprema; posle uspešnog cutover-a (runbook korak 6+) briše se zajedno
sa privremenim §5.3 syncerima i splitom sync mape (spec §7.2).
