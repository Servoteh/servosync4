# Rad operatera — svakodnevno korišćenje (Unitronics)

Uputstvo za svakodnevni rad preko **SCADA web aplikacije**. Sve izmene (setpoint, režim,
ručne komande) menjaju **pravi PLC uživo** — aplikacija zato traži **potvrdu** pre svakog upisa.

## Pristup aplikaciji

- **Na VM-u / lokalno:** `http://localhost:3000`
- **Spolja (preko interneta):** `https://kotlarnica.<domen>` `[POTVRDITI domen]` — traži prijavu
  (Cloudflare Access, e-mailom). Dozvoljeni nalozi se dodaju u Cloudflare dashboard.

Početni ekran je **Pregled (Overview)**; detaljni sinoptik kotlarnice je na `/kotlarnica`.

## Šta vidiš na ekranu

- **Sinoptik** postrojenja sa zonama: za svaku zonu trenutna temperatura i zadata (setpoint).
- **Kaloriferi K1–K5 / pumpe P1–P4** sa statusom **RADI / STOJI** (animacija).
- **Režim** GREJANJE/HLAĐENJE i AUTO/RUČNO (čita se uživo iz PLC-a).
- **Raspored** (radni dani / vikend, satnice i aktivni dani).
- **Trendovi** poslednja 24 h (temperature i setpoint).
- **Alarmi** (i Telegram obaveštenja ako je podešeno).

Indikator gore pokazuje da li je PLC **online**. Ako piše „SIMULACIJA", aplikacija ne priča
sa pravim PLC-om (to je razvojni režim — ne sme na produkciji).

---

## Tipične radnje

### 1) Promena zadate temperature (setpoint)
1. Nađi zonu (npr. CNC radionica).
2. Unesi novu vrednost u polje setpoint (°C).
3. Potvrdi → aplikacija upisuje u odgovarajući `MI` registar (npr. `MI35` za CNC).

> Vrednost se interno množi sa 10 (PLC čuva ×10). Ti unosiš normalne °C (npr. `21.5`).

### 2) Prebacivanje AUTO ↔ RUČNO
1. Nađi prekidač režima (AUTO/RUČNO) → upisuje `MB14`.
2. U **RUČNO** režimu uređaji se ne pale sami po temperaturi — koristi ručne komande.
3. **Po završetku vrati na AUTO**, inače grejanje ostaje pod ručnom kontrolom.

### 3) Ručno paljenje/gašenje kalorifera ili pumpe
1. Prebaci na **RUČNO** (po potrebi).
2. Klikni toggle za uređaj (K1–K5 → `MB8–12`, P1–P4 → `MB16–19`).
3. Proveri da se status promenio na **RADI** i da uređaj fizički radi.

> Ako klikneš komandu a uređaj ne reaguje: proveri **fizički prekidač u ormaru**
> (ulazi `I7–I14`) i glavni ON/OFF (`I15`). Lokalni prekidač može da „pregazi" SCADA komandu.

### 4) Promena režima GREJANJE/HLAĐENJE
1. Nađi prekidač GREJANJE/HLAĐENJE → `MB26`.
2. Potvrdi. Koristi se sezonski (zima/leto). `[POTVRDITI smer bita]`

### 5) Podešavanje rasporeda
1. Postavi satnice **uključenja/isključenja** za PON–PET i SUB–NED.
2. Označi **aktivne dane** (`MI50–56`).
3. Unos vremena je `HH:MM`; aplikacija sama konvertuje u BCD za PLC.

### 6) Reset greške frekventnog regulatora (VFD)
1. Kad je VFD u grešci (`I2 FREKVENTNI_RUN` = 0 a treba da radi, ili alarm).
2. Klikni **Reset greške frekventnog** → kratak impuls na `O18` (sam se vrati na 0).
3. Ako se greška vraća → kvar je fizički, vidi [alarmi-i-kvarovi.md](alarmi-i-kvarovi.md).

---

## Dobra praksa

- **Ne ostavljaj sistem u RUČNO** posle intervencije — vrati na AUTO.
- Posle promene setpointa sačekaj koji minut i proveri da regulacija reaguje (trend).
- Ako nešto „ne štima", prvo pogledaj da li je PLC **online** i da li je režim AUTO.
- Veće izmene (raspored, setpointi za celu sezonu) radi planski i zabeleži šta si menjao.

> ⚠️ Svaki upis ide na živi PLC. Ako nisi siguran šta neki registar radi — **ne diraj**,
> nego pogledaj [mapa-registara.md](mapa-registara.md) ili pitaj inženjera.
