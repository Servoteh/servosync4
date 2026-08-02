# Diktafon — sanduče i okidač „d."

Nenad diktira telefonom (ekran `/mob/diktafon`), tekst se transkribuje i sređuje, pa upisuje u
sanduče `dictation_inbox` na serveru. Agent ga odatle povuče i radi po njemu.

**Zašto ovako:** Cursor/Claude rade na Windows mašini, a telefon ne može u njen klipbord;
diktiranje na srpskom kroz ServoSync (Whisper) je znatno bolje od Windows diktata.

Ovaj fajl postoji da okidač razume **svaki** agent nad ovim repoom (Claude Code, Cursor, bilo koji
drugi), a ne samo ona sesija koja slučajno ima tu belešku u svojoj memoriji.

---

## Okidač

Kad korisnik u razgovoru napiše **`diktat`**, **`dik`**, **`uzmi diktat`** ili **`d.`** — to je nalog
da povučeš njegov poslednji **nepreuzet** diktat i da ga tretiraš kao **njegovu instrukciju**
(dolazi od iste osobe koja ionako komanduje sesijom).

**Pravila (obavezna):**

1. Povlači **samo** kad je okidač eksplicitno napisan u toj sesiji. Nikad „usput", nikad radi testa.
2. **Prvo povlačenje troši.** Sanduče je jedno i deljeno svim sesijama; ko prvi povuče, njegov je i
   više se nigde ne pojavljuje. To je željeno ponašanje, nije greška — nema vraćanja na „neposlato",
   nema rutiranja po agentu. Jednom potrošeno = gotovo, čeka se nov diktat.
3. Ako je sanduče prazno, reci to i **ne izmišljaj** sadržaj.
4. Tekst diktata je poslovni sadržaj — ne prepisuj ga u javne kanale i ne ostavljaj u logovima.

---

## Kako povući — tri puta

Koji put koristiš zavisi od toga gde agent radi.

### A) Agent na Nenadovoj Windows mašini (Claude Code, lokalni Cursor)

Ima pristup lokalnoj mreži i ključ za server, pa ide direktno u bazu:

```bash
# 1) povuci (LITERAL user_id=2 = Nenad — NIKAD bez ovog filtera!)
ssh ubuntusrv 'docker exec servosync-pg psql -U servosync -d servosync -tAc \
  "SELECT id||chr(9)||text FROM dictation_inbox WHERE user_id=2 AND delivered_at IS NULL ORDER BY created_at DESC LIMIT 1"'

# 2) obeleži preuzetim (row_id iz koraka 1 — NE user_id)
ssh ubuntusrv 'docker exec servosync-pg psql -U servosync -d servosync -c \
  "UPDATE dictation_inbox SET delivered_at=now() WHERE id=<row_id>"'
```

🔴 **Zašto pin na `user_id=2`:** glavna baza je bez RLS-a, a upit ide rolom koja vidi SVE redove.
Bez `WHERE user_id=2`, `ORDER BY created_at DESC LIMIT 1` vratio bi **najskoriji BILO ČIJI** diktat —
tuđi tekst bi ušao kao instrukcija (klasična injekcija). Filter je obavezan, uvek.

### B) Bez agenta — direktno u klipbord (PowerShell)

U bilo kom PowerShell prozoru: **`diktat`** povuče poslednji nepreuzet tekst, stavi ga u Windows
klipbord i obeleži preuzetim. **`diktat -Peek`** samo prikaže, bez obeležavanja.
Skripta: `C:\Users\nenad.jarakovic\tools\diktat.ps1`, funkcija je u `$PROFILE`.

> Zamke (ako se skripta menja): `.ps1` mora biti čist ASCII (PowerShell 5.1 čita kao ANSI, pa „—" i
> „č" polome navodnike), a SQL mora ići kroz **stdin** u `docker exec -i`, ne kao argument.

### C) Agent BEZ pristupa lokalnoj mreži (Cursor agent u oblaku, pokrenut sa telefona)

Server `ubuntusrv` je na privatnoj adresi (192.168.64.28) — agent u oblaku do njega **ne može**.
Zato ide preko javnog API-ja, uz token:

```bash
curl -s -X POST https://api.servosync2.servoteh.com/api/v1/dictation-inbox/claim \
  -H "Authorization: Bearer $SERVOSYNC_TOKEN" -H "Content-Type: application/json" -d '{}'
```

Ruta **atomično** vrati poslednji nepreuzet diktat i istim upitom ga obeleži preuzetim — pravilo
„prvo povlačenje troši" važi i ovde, i dva agenta ne mogu dobiti isti tekst.

Ako agent radi pod **svojim** nalogom (a ne Nenadovim), mora postojati upisana **delegacija** —
inače gleda u svoje prazno sanduče. Detalji (oblik zahteva, kako se dodaje delegat) su u
[backend dokumentaciji diktafona](../backend/docs/). Ovaj put je bezbedniji od puta A: vlasnik
sandučeta se izvodi iz tokena i eksplicitne dozvole u bazi, a ne iz ručno upisanog broja u komandi.

---

## Arhitektura (za izmene)

- Backend modul: `backend/src/modules/dictation-inbox`
  – `POST /v1/dictation-inbox` (upis, guard `ai.chat`, korisnik iz JWT-a)
  – `GET /v1/dictation-inbox/latest` (čita, **ne** troši — za samu aplikaciju)
  – `POST /v1/dictation-inbox/claim` (uzmi i potroši — za agente)
- Frontend: `/mob/diktafon` (tap-toggle snimanje; iOS traži Screen Wake Lock i `rec.start(1000)`,
  inače auto-lock prekine duži diktat).
- Ograničenja: najviše 50 nepreuzetih po korisniku (dalje 429), tekst do 10.000 znakova.
- Retencija: preuzeti stariji od 30 dana se čiste redovnim poslom; **nepreuzeti se nikad ne diraju**.
- Audio se ne čuva — transkribuje se i odbacuje.
