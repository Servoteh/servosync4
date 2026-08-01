# Kako `.mdb` fajl stiže sa BigBit mašine na server

Stanje od **01.08.2026**, kad je lanac prvi put prošao od početka do kraja bez ručnog dodira.

## Zašto je smer okrenut

Prvobitno je BigBit mašina **gurala** fajl na `\\192.168.64.28\bigbit-incoming`. **To iz
zakazanog zadatka nikad nije radilo**, i to se ne može popraviti podešavanjem:

* taj folder je **Samba share van domena** — `guest ok = no`, `valid users = bbdrop`;
* zakazani zadatak radi kao **`SERVOTEH\zoran.jarakovic`**, nalog koji na tom serveru ne postoji;
* ručno pokretanje je radilo samo zato što prijavljena sesija već drži otvorenu vezu ka folderu.

Posledica: zadatak je **svaki dan vraćao grešku 1**, a kopija tiho nije nastajala. Dokaz sa
istog dana: HapFluid kopija na `\\srv\Shares\...` stizala je uredno (domenski server, prijava
automatska), dok Servoteh kopija na `192.168.64.28` nije stigla nijednom.

Zato **server sada sam povlači fajl**, koristeći CIFS pristup ka BigBit mašini koji već radi
mesecima za PDM (`/etc/cifs-bigbit.cred`, nalog `Bojan.PDM`). Nova lozinka nije bila potrebna.

## Lanac

```
BigBit mašina (192.168.64.14)
  17:00  zadatak „Napravi BackUpt"
         └─ 0_NapraviBackUp.bat  →  C:\BackUp_BigBit\BigBit\BB_T_26_DD-MM-GG.mdb   (lokalno)
                                 →  C:\PDMExport\BBDROP\BB_T_26_DD-MM-GG.mdb       (lokalno)
                                    ⚠️ oba upisa su LOKALNA — nema mrežne prijave, nema čega da padne

ubuntusrv
  /mnt/bb-drop  =  //192.168.64.14/PDMExport/BBDROP   (cifs, ro, fstab)
  17:30  systemd user timer → bigbit-mdb-export.service
         ├─ ExecStartPre: fetch-drop.sh    → /srv/bigbit-incoming/
         └─ ExecStart:    bigbit-mdb-export.sh → staging (17 tabela)
  03:45  scheduler posao `bigbit-mdb-sync` → uvoz u 4.0
```

## Šta se NE sme vratiti

`0_NapraviBackUp.bat` više **nema** liniju koja kopira na `\\192.168.64.28\bigbit-incoming`.
Uklonjena je 01.08.2026 i u samom fajlu stoji objašnjenje zašto. Vraćanje te linije ne donosi
ništa (server više ne čeka da mu se fajl donese), a zadatak bi ponovo počeo da javlja grešku.

Original je sačuvan kao `0_NapraviBackUp.bat.pre-servosync-2026-08-01.bak`.

## Usput popravljeno (nije bilo deo ovog posla)

Druga radnja istog zadatka, `0_NapraviBackUp_HAP.bat`, kopirala je **HapFluid bazu iz 2023** na
laptop `\\HP-ZBOOK` preko foldera `C:\1\BigBIt_HAP`. **Ni laptop ni folder više ne postoje**, pa
je i ta radnja obarala zadatak — i, važnije, **ta baza nije imala nijednu kopiju nigde**, iako
nije zamrznuta (poslednja izmena 20.05.2026).

Preusmerena je na ista mesta gde idu ostali backupi (`C:\BackUp_BigBit\BigBit_HAP23\` i
`\\srv\Shares\BigBit\backup\BigBit_HAP23\`), uz `xcopy /D` — kopira **samo kad je izvor noviji**,
pa se 147 MB ne prepisuje bez potrebe. Original je sačuvan kao `.pre-servosync-2026-08-01.bak`.

Posle toga zadatak vraća **0**.

## Zamka u `fetch-drop.sh` (ispravljena 01.08.2026)

Skripta je preskakala fajl kad se poklope **ime i veličina**. To bi svakodnevno propuštalo nov
sadržaj, jer se **oba** uslova rutinski poklapaju:

1. ime nosi **datum**, pa dva backupa istog dana nose isto ime;
2. Access baza često ostane **iste veličine** iako je sadržaj izmenjen.

Sada se poredi i **vreme izmene** — `cp -p` ga čuva, a backup ga nasleđuje od žive baze, pa je to
jedini signal koji se stvarno menja kad neko radi u BigBitu.

## Provera da lanac radi

```bash
ssh ubuntusrv 'ls -la --time-style=long-iso /mnt/bb-drop/ /srv/bigbit-incoming/'
ssh ubuntusrv 'journalctl --user -u bigbit-mdb-export.service --since today -o cat | tail -20'
ssh ubuntusrv "docker exec servosync-pg psql -U servosync -d servosync -c \
  \"select id, file_name, file_mtime, import_status from bb_mdb_drops order by id desc limit 3;\""
```

Zdrav dan: nov `file_mtime`, `stage_status=LOADED`, pa `import_status=DONE` posle 03:45.
Ako dva dana zaredom stoji isti `file_mtime` — backup na BigBit mašini nije napravio nov fajl.
