# Dnevni BigBit izvoz — systemd tajmer

Instalirano 30.07.2026 na `ubuntusrv`, po odluci vlasnika **O-3**
(`docs/ODLUKE_SYNC_I_PRELAZ.md`): jednom dnevno u **17:30 po beogradskom**, pola sata
posle pravljenja backup fajla na BigBit računaru.

## Zašto KORISNIČKI systemd, a ne sistemski

`systemctl --user` ne traži `sudo`, a `Linger=yes` je već uključen za `admnenad`
(isti obrazac koji na ovoj mašini vrti SCADA servise), pa tajmer radi i kad niko
nije prijavljen i preživljava restart servera.

## Gde šta stoji

| | |
|---|---|
| skripta | `~/bigbit-mdb/bigbit-mdb-export.sh` |
| okruženje (sadrži URL baze, `chmod 600`) | `~/bigbit-mdb/env` |
| unit fajlovi | `~/.config/systemd/user/bigbit-mdb-export.{service,timer}` |
| kopije unit fajlova u gitu | `ops/bigbit/` (ovaj folder) |

## Komande

```bash
systemctl --user list-timers bigbit-mdb-export.timer   # kad je sledeći termin
systemctl --user start bigbit-mdb-export.service       # ručno, sad
journalctl --user -u bigbit-mdb-export.service -n 50   # šta se desilo
systemctl --user disable --now bigbit-mdb-export.timer # gašenje
```

## ⚠️ Trenutno gađa DEV bazu, ne produkciju

`BB_DATABASE_URL` u `env` pokazuje na `servosync-dev` (192.168.64.28:5437), jer
produkcija **još nema nijednu `.mdb` migraciju** — tabele `bb_mdb_drops` i
`bb_mdb_stage_*` tamo ne postoje. Posle deploy-a se menja jedan red u `env`.

## Šta je pokazalo prvo ručno pokretanje (30.07.2026)

Vredelo je pokrenuti ručno umesto čekati tajmer — pao je **dvaput**, oba puta korisno:

1. **Greška u skripti**: izvlačenje datuma iz imena fajla bilo je napisano `sed`-om
   sa povratnim referencama, a one su u generisanju izgubile obrnute kose crte i
   postale kontrolni bajtovi. Prepisano na bash `[[ =~ ]]` + `BASH_REMATCH`, što ne
   prolazi kroz još jedan sloj citiranja pa se to ne može ponoviti.
2. **Brana za lažnu svežinu** je opalila ispravno: fajl je bajt-u-bajt jednak već
   obrađenom drop-u, dakle nov datum a stari podaci. To NIJE kvar tajmera.

## Šta se očekuje sutra (31.07.2026, 17:32)

Prvi **automatski** prolaz. Tri stvari se tada proveravaju odjednom:
- da li Windows zadatak sam pravi backup i kopira ga na deljenje (do sada je bilo
  samo ručno; putanja je 30.07. prepravljena sa `X:\` na UNC, jer zakazani zadatak
  ne vidi mapirani disk);
- da li fajl legne **pre 17:30** — ako legne posle, prolaz čita jučerašnje stanje;
- da li ceo lanac prođe bez ručnog dodira.

Provera: `journalctl --user -u bigbit-mdb-export.service --since today`.
