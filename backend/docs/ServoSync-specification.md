# ServoSync — BigBit → BigTehn (QMegaTeh) sync

**ServoSync** je ime softvera (proizvod). Ovaj dokument opisuje legacy sinhronizaciju (Access / postojeći ServoSync) i ciljeve za **ServoSync v2.0**.

Smer je uvek **jednosmeran**: BigBit → QMegaTeh. QMegaTeh **nikad** ne piše u BigBit.

---

## Tabele koje se sinhronizuju

| Tabela | Smer | Način | Napomena |
|--------|------|--------|----------|
| Komitenti | BigBit → QMegaTeh | INSERT samo novi | PIB placeholder `XX_<Sifra>` ako PIB prazno |
| Predmeti | BigBit → QMegaTeh | INSERT samo novi | Projekti / ugovori |
| Prodavci | BigBit → QMegaTeh | INSERT samo novi | Default password = šifra prodavca |
| R_Artikli | BigBit → QMegaTeh | INSERT samo novi | Katalog artikala |
| R_Tarife | BigBit → QMegaTeh | Read-only EXT link | PDV stope |
| R_Grupa | BigBit → QMegaTeh | Read-only EXT link | Grupe artikala |
| Magacini | BigBit → QMegaTeh | Read-only EXT link | |
| Vrste sifara | BigBit → QMegaTeh | Specijalni SQL append | |
| T_Robna dokumenta | Delimično | Mirror mehanizam | Samo za PDM / MRP potrebe |
| T_Robne stavke | Delimično | Mirror mehanizam | Samo za PDM / MRP potrebe |
| Trebovanja, ZahteviZaNabavku | Na zahtev | Read-only EXT link | Ne kopiraju se lokalno |

---

## SQL pattern (legacy) — INSERT samo novi

Isti obrazac za entitete gde važi „samo novi“:

```sql
INSERT INTO Komitenti (Sifra, Naziv, Adresa, PIB, ...)
SELECT
    EXT_Komitenti.Sifra,
    EXT_Komitenti.Naziv,
    EXT_Komitenti.Adresa,
    IIf(Nz([EXT_Komitenti].[PIB], "") = "",
        "XX_" & [EXT_Komitenti].[Sifra],
        [EXT_Komitenti].[PIB]),
    0 AS [Sifra prodavca],
    ...
FROM EXT_Komitenti
LEFT JOIN Komitenti
    ON EXT_Komitenti.Sifra = Komitenti.Sifra
WHERE Komitenti.Sifra IS NULL;
```

- `WHERE … IS NULL` = **nema update-a** postojećih redova u legacy toku.

---

## Tok pokretanja sync-a (legacy UI)

1. Korisnik klikne **„Preuzmi iz BB“** (Ribbon).
2. `RibbonModule.PreuzmiIzBigBitaRibbon()` → `RibbonModule.PreuzmiIzBB()`.
3. Redosled (pojednostavljeno):
   - `UradiImportIzTabeleUTabelu("EXT_Vrste sifara", "Vrste sifara", …)`
   - `DodajNoveProdavceIzBigBita()`
   - `DodajNoveKomitenteIzBigBita()`
   - `DodajNovePredmeteIzBigBita()`
   - `DodajNoveArtikleIzBigBita()`

---

## Poznati problemi koje ServoSync v2.0 treba da reši

| Problem | Opis |
|---------|------|
| Nema update-a | Promena adrese komitenta u BigBit-u ne stiže u QMegaTeh |
| Nema brisanja | Obrisani komitent u BigBit-u ostaje u QMegaTeh-u |
| PIB drift | Placeholder `XX_<Sifra>` — ako se PIB popuni u BigBit-u, ne propagira se |
| Šifra prodavca = 0 | Uvek se upisuje 0; mora ručno popuna |

Cilj za v2: **CDC** (ili ekvivalent), detekcija brisanja, **propagacija update-a**, jasna idempotentnost i audit.

---

## Šta je korisno u *ovoj* fazi (Postgres + Nest + Prisma)

Ovo je **nije** implementacija sync-a, već priprema šeme i arhitekture:

| Oblast | Zašto pomaže sada |
|--------|-------------------|
| **Prisma modeli** | Tabele iz tabele gore već treba da postoje u `schema.prisma` (ili da znate koja su „lokalna kopija“ vs. samo EXT pogled). |
| **Primarni ključevi / natural keys** | INSERT-only + `WHERE NOT EXISTS` zahteva stabilan način da se detektuje „isti“ red (npr. `Sifra`, `IDPredmet` — uskladiti sa stvarnim PK u PG). |
| **Poslovna pravila u migracijama** | Default password prodavca, PIB placeholder — dokumentovati kao **seed / one-shot SQL** ili kasnije kao pravilo u sync servisu, ne kao tihuu magiju u UI. |
| **Read-only EXT** | U novom sistemu to često postaje **drugi datasource** (read replica BigBit / SQL Server) ili API sloj, ne kopija tabele u PG — vredi odlučiti rano. |
| **Mirror (T_Robna dokumenta / stavke)** | Zahteva jasan **scope** (šta tačno „mirror“ znači u PG) i eventualno odvojenu šemu ili flagove da se ne meša sa glavnim knjigovodstvom. |

Šta **ne mora** sada: CDC pipeline, Bull queue, konflikt rezolucija — to je faza kada postoji stabilan API + konekcija na izvor (BigBit).

---

## Veza sa repoom `postgres/` (handoff)

- `prisma/schema.prisma` + migracije = **ciljna baza** u koju će ServoSync v2.1+ upisivati.
- `legacy/` = MSSQL → PG DDL alat i snapshot; sync logika nije tu.
- Sledeći korak posle šeme: definisati **ServoSync modul** u Nest-u (jobovi, outbox, ili integracija sa eksternim workerom) i ugovor sa BigBit izvorom (SQL Server link, replika, ili export fajlovi).

---

*Izvor: upustvo za prebacivanje softvera. Zvanično ime proizvoda: **ServoSync**.*
