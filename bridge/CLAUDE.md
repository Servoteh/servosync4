# Bridge (BigTehn sync + SCADA relej) — pravila

Node servis (ESM) sa dva posla:

1. **BigTehn → sy15** — read-only sinhronizacija kataloga i proizvodnje iz `QBigTehn`
   (SQL Server `Vasa-SQL:5765`, nalog `bridge_reader`, driver `mssql`/tedious).
2. **SCADA relej** — čita lokalni API gateway-a ([../scada/](../scada/)) i puni
   `scada_snapshots` (5 s), `scada_history` (60 s) i `scada_alarms` u sy15, a u suprotnom
   smeru izvršava `scada_commands` uz allowlist, opsege i rate-limit.

**Bridge NIKAD ne priča direktno sa uređajima** — sve ide kroz gateway, da drajveri i
validacija ostanu na jednom mestu. Zato bridge nema ni jedan PLC/Modbus kod.

## Gde radi (provereno 30.07.2026)

Sve na **ubuntusrv**, kao `systemd --user` jedinice (`Linger=yes`, dižu se posle reboota):

| Jedinica | Folder | Šta radi |
|---|---|---|
| `servoteh-bridge-scada.service` | `/home/admnenad/bridge-scada` | samo SCADA relej (`SCADA_ENABLED=true`, `ENABLE_JOB_*=false`) |
| `servoteh-bridge.service` | `/home/admnenad/servoteh-bridge` | BigTehn + Katze sync |

Dve odvojene instance istog koda, razdvojene `.env`-om — jedna ne sme da čeka drugu.
Isporuka je ručna: `scp` u odgovarajući folder pa `systemctl --user restart <jedinica>`.
`node` nije u PATH-u za neinteraktivni SSH → `/home/admnenad/.nvm/versions/node/v22.23.1/bin/node`.

⚠️ **Isporuka sa Windows mašine šalje CRLF.** U git-u je LF i na serveru je LF, ali Windows
checkout ima CRLF (autocrlf), pa `scp` iz radnog stabla unosi CR na server. Node to ne
smeta, ali `cmp`/`diff` posle toga prijavljuju razliku na svakom fajlu i provera „da li
server odgovara git-u" postaje beskorisna. Zato:

```bash
tr -d '\r' < src/scada/normalize.js | ssh ubuntusrv 'cat > /home/admnenad/bridge-scada/src/scada/normalize.js'
# ili posle scp-a:  ssh ubuntusrv "tr -d '\r' < F > F.tmp && mv F.tmp F"
# provera pravih razlika:  diff --strip-trailing-cr server_fajl repo_fajl
```

⚠️ Windows bridge VM (192.168.64.24) je **napušten**; tamošnji servisi su `Stopped / Disabled`
i takvi ostaju. [docs/INSTALACIJA-VM.md](docs/INSTALACIJA-VM.md) opisuje **to staro** stanje —
drži se kao istorijat, ne kao uputstvo.

## Alarmi — pazi šta uključuješ

`src/scada/normalize.js` pretvara payload svakog sistema u redove `scada_alarms`. Odatle
ide i dojava, pa je prag za „šta je alarm" ovde stvar higijene, ne kozmetike:

- Kod mora biti **jedinstven po uređaju** (`NOCOMM_RS485:INV2`), da diff-sync može da ga
  ugasi pojedinačno kad se uređaj vrati.
- Mereno 30.07.2026: zaštitne sklopke kotlarnice 2 podižu se **~68 puta dnevno po kodu**
  (po 1839 puta od 02.07). Zato mejl-dojava u gateway-u ide kroz uzak spisak dozvoljenih
  kodova, a ne kroz „sve iz `scada_alarms`". Ako dodaješ nov alarm, prvo izmeri koliko
  puta se podiže u 24 h.

## Tajne i baza

`.env` nije u git-u (ignorisan). Sadrži BigTehn SQL kredencijale i `SUPABASE_SERVICE_ROLE_KEY`
(service role — zaobilazi RLS, nikad ga ne izlagati klijentu). Relej piše u **self-hosted**
sy15 (`SUPABASE_URL=http://localhost:8080`); Supabase cloud je ugašen i stari URL
(`fniruhsuotwsrjsbhrxd…`) je mrtav — na njemu je servis 11.07.2026. pao ~30.000 puta
zaredom sa `Invalid schema: public`.

`bridge/**` **ne okida** nijedan workflow — deploy je ručan, gore opisan.
