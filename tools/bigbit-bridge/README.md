# BigBit bridge — dnevni sync BigBit ERP → ServoSync 2.0 (PostgreSQL)

Alat koji jednom dnevno prepiše izabrane **matične** tabele iz BigBit-a (MS Access
`.mdb`) u ServoSync 2.0 PostgreSQL. Odluka (Nenad, 2026-07-11): sync radi **na
ubuntu serveru** (`ubuntusrv`, 192.168.64.28), čita `mdb-tools`-om i piše **direktno**
u lokalni PG. Detaljan plan: [`docs/migration/BB_T_26_ANALIZA_I_PLAN.md` §7.3](../../docs/migration/BB_T_26_ANALIZA_I_PLAN.md).

## Zašto ovako (i zašto BEZ lozinke)

BigBit `.mdb` je zaključan Access **ULS**-om (workgroup `BIGBIT.MDW`). Ono što je
izgledalo kao lozinka (`Slavisa` / `BIGBIT224163`) su zapravo **workgroup PID-ovi**,
ne login — pa se na njih ne oslanjamo. **`mdb-tools` čita sirovi Jet fajl i potpuno
ignoriše ULS**, tako da **ne treba ni lozinka ni PID ni workgroup fajl**. To je i
dokazani put (pilot 11.07: `R_Grupa/R_Podgrupa/R_Poreklo` → `item_groups/…`).

```
BigBit .mdb ──(CIFS mount / noćna kopija)──> ubuntusrv
   │
   ├─ docker run mdbtools  →  mdb-export tabela  →  CSV (ULS-free, UTF-8)
   └─ docker exec servosync-pg psql  →  staging temp + INSERT ON CONFLICT (UPSERT)
```

Pošto je PG **na istom hostu** (kontejner `servosync-pg`), piše se preko
`docker exec` — **ne treba izlagati 5432 na LAN niti praviti `bb_sync` rolu**.

## Ključne odluke u dizajnu

- **UPSERT, ne insert-only** — `INSERT … ON CONFLICT DO UPDATE` sa `IS DISTINCT FROM`
  gard-om (preskače no-op update-e). Insert-only je odbačen jer bi zamrznuo izmene
  (npr. preimenovan opis grupe se nikad ne bi propagirao).
- **Nikad brisanje** — redovi koji postoje u PG a nema ih više u BigBit izvoru se
  samo broje i loguju (`missing_in_source`), nikad se automatski ne brišu (§7.3).
- **Transakcija po tabeli** — pad jedne tabele ne ostavlja delimičan upis i ne
  zaustavlja ostale.
- **Allow-lista = `tables.manifest`** — deny-lista (EXCLUDE-TVRDO iz F3) se sprovodi
  time što tabela naprosto **nije** u manifestu; skripta ne `mdb-export`-uje ništa
  van njega.
- **Redosled kolona** u `sql/*.sql` staging tabeli mora da prati **storage redosled**
  BigBit tabele (`\copy` puni poziciono, po preskočenom header-u).

## Preduslovi na ubuntusrv

1. **docker** (već postoji) + korisnik u `docker` grupi (`admnenad` jeste).
2. **Kontejner `servosync-pg`** radi (već radi — prod baza).
3. **Izvorni `.mdb` dostupan lokalno** (`BB_SRC_MDB`). `BB_SRC_MDB` može biti
   **fajl** ili **drop folder** (tada se uzima najnoviji `*.mdb` iz njega). Opcije:
   - **Deljeni drop folder na OVOM serveru (preporuka)** — BigBit mašina sама
     gura izvoz na `\\192.168.64.28\bigbit-incoming`; vidi „Deljeni drop folder".
   - **CIFS mount** share-a sa BigBit mašine (192.168.64.14). Isti obrazac kao
     `pdm-bridge` (`sec=ntlmssp` je lek za `mount error(95)`; `ro,nofail,
     x-systemd.automount,_netdev`). BigBit deli `EXPORT`, `PDFImportovano`, `PDMExport`.
   > Napomena: `.mdb` je Jet — max 2 GB. `mdb-export` čita fajl read-only.

### Deljeni drop folder (SMB) — BigBit gura izvoz na server

Jednokratno, kao root na ubuntusrv:
```bash
sudo bash setup-samba-drop.sh bbdrop '<samba-lozinka>'
```
Napravi Samba share `\\192.168.64.28\bigbit-incoming` (folder `/srv/bigbit-incoming`,
`setgid`, deljena grupa `bbdrop`) — piše ga nalog `bbdrop`, čita ga korisnik koji
pokreće bridge. Zatim na BigBit mašini zakazati Windows task koji kopira izvezeni
`.mdb` u taj share, i u `bigbit-bridge.env` postaviti `BB_SRC_MDB=/srv/bigbit-incoming`.
Bridge onda svakog jutra uzme **najnoviji** `.mdb` iz foldera.

## Instalacija

```bash
cd ~/bigbit-bridge          # gde si iskopirao ovaj folder
cp bigbit-bridge.env.example bigbit-bridge.env
# uredi bigbit-bridge.env: BB_SRC_MDB, po potrebi BB_LOG_FILE
bash install-timer.sh       # build mdbtools image + dry-run + systemd timer (05:30)
```

`install-timer.sh` prvo uradi **build** `mdb-tools` docker image-a (`servosync/mdbtools:local`),
pa **dry-run** (pun tok ali `ROLLBACK`), pa registruje `bigbit-bridge.timer`.

## Pokretanje ručno

```bash
BB_DRY_RUN=1 bash bigbit-bridge.sh        # pun tok, ništa se ne upisuje
BB_ONLY=R_Grupa bash bigbit-bridge.sh     # samo jedna tabela
bash bigbit-bridge.sh                      # pravi upsert
sudo systemctl start bigbit-bridge.service # kroz systemd
journalctl -u bigbit-bridge.service -n 50 --no-pager
```

Log: `bigbit-bridge.log` (i konzola). Po tabeli: `read / inserted / updated /
unchanged / missing_in_source / trajanje`.

## Exit kodovi

| kod | značenje |
|----:|----------|
| 0 | OK |
| 1 | bar jedna tabela pala (detalji u logu) |
| 2 | BigBit izvor nečitljiv (nema `.mdb` / `mdb-export` pao) |
| 3 | konfiguracija/preduslov (docker, image, manifest, PG nalog) |
| 4 | PG kontejner nedostupan |

## Rollback

Podatke pune **samo** ove tabele odavde, pa je rollback bezbedan:
```sql
DELETE FROM item_groups; DELETE FROM item_subgroups; DELETE FROM item_origins;
```
Uklanjanje taska: `bash uninstall-timer.sh` (ostavlja podatke).

## Faze proširenja (dodavanje tabele = red u manifestu + `sql/<t>.sql`)

- **v0 (sada):** `R_Grupa`, `R_Podgrupa`, `R_Poreklo` → artikli dobijaju nazive
  grupa/podgrupa/porekla (kolone su postojale, šifarnici bili prazni — F1 rupa).
- **Faza 2 (BLOKIRANA odlukom o ID-prostoru, §7.2/§7.3):** `Komitenti`, `Predmeti`,
  `R_Artikli`, `Cenovnik`, `Magacini`, `Prodavci`.
  ⚠️ `Prodavci.[Password]` je **plain-text** — nikad ga ne prepisivati; pošto
  `mdb-export` izvozi celu tabelu, faza 2 traži projekciju (ili scrub CSV-a).
  ⚠️ Za tekstualne tabele (imena sa `,` i `"`) proveriti `mdb-export` quoting/escape
  pre uključivanja.
- **Faza 3:** ostatak KEEP-SYNC liste iz
  [`BB_T_26-analiza-F3-inventar-207-tabela.md`](../../docs/migration/BB_T_26-analiza-F3-inventar-207-tabela.md).

## Ograničenja

- **Svežina** zavisi od toga koliko često se osvežava izvorni `.mdb` (dogovoriti sa
  Negovanom). Sam sync je dnevni (timer 05:30).
- **`mdb-export` izvozi celu tabelu** — izbor/izostavljanje kolona radi se u
  `sql/*.sql` (staging uzima sve, INSERT bira). Osetljive kolone (Password) tek u
  fazi 2 uz projekciju.
- **Šema-drift:** ako se BigBit šema promeni (preimenovana/pomerena kolona),
  pozicioni `\copy` može tiho da pomeri vrednosti — zato je redosled kolona u
  `sql/*.sql` fiksiran i dokumentovan; pri dodavanju tabele proveriti storage
  redosled u `_analiza/bigbit/BB_T_26_schema.sql`.
