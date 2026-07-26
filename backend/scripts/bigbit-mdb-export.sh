#!/usr/bin/env bash
# =============================================================================
# BigBit .mdb -> Postgres staging (KORAK 1 od 2 noćnog uvoza, stavka A 26.07.2026)
# -----------------------------------------------------------------------------
# ZAŠTO POSTOJI OVA SKRIPTA (a ne Node kod):
#   Backend radi u kontejneru `servosync-backend` koji NEMA pristup .mdb fajlu.
#   Provereno 26.07.2026 na ubuntusrv:
#     docker inspect servosync-backend -> Binds=[]      (nijedan bind mount)
#     docker exec  servosync-backend   -> nema /var/run/docker.sock, nema `docker`
#   Dakle Node proces ne može ni da PROČITA /srv/bigbit-incoming ni da pokrene
#   `mdbtools`. Zato izvoz radi OVA skripta NA HOSTU, a jedini dodirni kanal
#   između hosta i kontejnera je POSTGRES: skripta puni `bb_mdb_stage_*` tabele i
#   upisuje red u `bb_mdb_drops`, a backend (korak 2) čita samo bazu.
#   Prednost: nula izmena imidža, compose fajla, mrežnih prava i npm zavisnosti.
#
# KORAK 2 = scheduler posao `bigbit-mdb-sync`
#   (backend/src/modules/sync/bigbit-mdb-import.service.ts) — on preslikava
#   staging u 4.0 modele i GLASNO javlja ako je drop bajat.
#
# POKRETANJE (na ubuntusrv):
#   BB_DATABASE_URL='postgresql://user:pass@host:5432/servosync' \
#     bash /put/do/bigbit-mdb-export.sh
#   Opcije:  --force   ponovo odradi i drop koji je već LOADED
#            --dir D   drugi drop folder (default /srv/bigbit-incoming)
#
# IDEMPOTENCIJA: identitet drop-a = (ime fajla, mtime, veličina). Drugo pokretanje
# nad ISTIM fajlom bez --force ne radi ništa i izlazi sa 0. Sa --force staging se
# prvo obriše za taj drop pa ponovo napuni — nikad se ne duplira.
#
# Uputstvo (gašenje, kvarovi, ručno pokretanje): backend/docs/migration/BIGBIT_NOCNI_SYNC.md
# =============================================================================
set -Eeuo pipefail

DROP_DIR="${BB_DROP_DIR:-/srv/bigbit-incoming}"
MDB_IMAGE="${BB_MDB_IMAGE:-mdbtools:local}"
PSQL_IMAGE="${BB_PSQL_IMAGE:-postgres:18}"
WORK_ROOT="${BB_WORK_DIR:-/tmp/bigbit-mdb-export}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --dir) DROP_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "Nepoznat argument: $1" >&2; exit 2 ;;
  esac
done

: "${BB_DATABASE_URL:?BB_DATABASE_URL nije postavljen (postgresql://... ka 4.0 bazi)}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "GREŠKA: $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# MANIFEST TABELA — redosled je PRIORITET (zahtev 4): prvo ono bez čega nema
# paralelnog PDV obračuna, pa kontrolni („zlatni") uzorci.
#
# Polja: <izvorna .mdb tabela>|<ciljna staging tabela>|<slug>|<OČEKIVANO ZAGLAVLJE CSV-a>
#
# OČEKIVANO ZAGLAVLJE je BRANA: staging tabele su deklarisane u schema.prisma
# TAČNO ovim redosledom kolona, pa se `\copy` radi BEZ liste kolona
# (INSERT ... SELECT nextval(), drop_id, t.*). Ako BigBit ikad doda, ukloni ili
# premesti kolonu, poređenje zaglavlja padne i skripta stane — umesto da tiho
# upiše pomerene vrednosti u pogrešne kolone.
#
# NAMERNO NIJE OVDE: `Komitenti` i `Predmeti`. Njih već vozi ŽIVI MSSQL sync
# (CustomerSyncer + GenericSyncer nad `sync-map.generated.ts`), koji čita bazu
# UŽIVO i time je SVEŽIJI od noćnog fajla; uz to su `Predmeti` u dual-unos režimu
# (3.0 dodeljuje broj -> isti broj se prekuca u BigBit) pa bi .mdb kanal bio drugi
# pisac po istim redovima. Vidi zahtev 4 i BIGBIT_NOCNI_SYNC.md §„Šta se NE uvozi".
# -----------------------------------------------------------------------------
TABLES=(
  "T_Glavna knjiga|bb_mdb_stage_gk|gk|StavkaID|Konto|InoKonto|Analiticka sifra|Broj dokumenta|Datum dokumenta|Valuta dokumenta|Datum knjizenja|IDNaloga|Opis dokumenta|Duguje|Potrazuje|Povezan|IDDokIzRobnog|Temeljnica|DevDuguje|DevPotrazuje|DevValuta|Pozicija|IDDokMP|IDProdavnicaMP|IDPredmet|IDDokIzUsluga|PG_IDDokIzRobnog|OJ|Potpis|DatumIVreme|OD|IDRadniNalog|PNBOdobBrojGK"
  "T_Nalozi|bb_mdb_stage_nalozi|nalozi|IDFirma|IDNaloga|Broj naloga|Vrsta naloga|Datum naloga|Opis naloga|Datum knjizenja|Level|Zakljucano|Godina|Potpis|DatumIVreme|STARIID"
  "Kontni plan|bb_mdb_stage_kontni_plan|kontni_plan|Konto|Opis|Dugacki opis|Plan duguje|Plan potrazuje|Dozvoljen unos analitike|Fajl sifara|InoKonto"
  "Vrsta naloga|bb_mdb_stage_vrsta_naloga|vrsta_naloga|Vrsta naloga|Opis"
  "PSF_AnalitickaKonta_T|bb_mdb_stage_psf_konta|psf_konta|Konto|DinSaldo|DevSaldo|OTST"
  "Sema za kontiranje|bb_mdb_stage_sema|sema|IDSeme|Vrsta naloga|Opis"
  "Stavke seme za kontiranje|bb_mdb_stage_sema_stavke|sema_stavke|IDStavkeSeme|IDSeme|Konto|Opis|DefDug|DefPot|Analitika|Poreklo|KngSifra_2"
  "T_PDV_GK|bb_mdb_stage_pdv_gk|pdv_gk|ID|StavkaID|DatPorPerioda|PDVEvidencija|PDVStopa|PDVOsnovica|ObracunPDVOsnovica|PDVIznos|ObracunPDVIznos|PDVGrupa"
  "T_POPDV_GK|bb_mdb_stage_popdv_gk|popdv_gk|StavkaID|PDVOznaka|DatPorPerioda|K1Iznos|K2Iznos|K3Iznos|K4Iznos"
)

# psql u kontejneru, na host mreži, sa UTF-8 klijentom.
# .mdb je JET4 i `mdbtools` već vraća UTF-8 (srpska latinica sa dijakriticima +
# ćirilična slova u POPDV oznakama tipa '8а.2DA') — klijent MORA biti UTF8 da se
# te oznake prenesu bajt-u-bajt, jer se po njima kasnije poredi string.
psql_q() { # tihi skalarni upit
  docker run --rm -i --network host -e PGCLIENTENCODING=UTF8 "$PSQL_IMAGE" \
    psql "$BB_DATABASE_URL" -v ON_ERROR_STOP=1 -tAq -c "$1"
}
psql_file() { # skripta iz $WORK (mount na /w)
  docker run --rm -i --network host -e PGCLIENTENCODING=UTF8 -v "$WORK":/w:ro "$PSQL_IMAGE" \
    psql "$BB_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "/w/$1"
}
sql_lit() { printf "%s" "$1" | sed "s/'/''/g"; } # bezbedan SQL string literal

# ── 1) Najnoviji .mdb u drop folderu ─────────────────────────────────────────
[ -d "$DROP_DIR" ] || die "drop folder ne postoji: $DROP_DIR"
MDB="$(find "$DROP_DIR" -maxdepth 1 -type f \( -iname '*.mdb' \) -printf '%T@ %p\n' \
        | sort -rn | head -1 | cut -d' ' -f2- || true)"
[ -n "$MDB" ] || die "u $DROP_DIR nema nijednog .mdb fajla — dostava iz BigBita ne radi"

# ── 1a) FAJL MORA BITI KOMPLETAN ─────────────────────────────────────────────
# Dostava spušta 375 MB oko 02:00, skripta kreće u 02:50. Ako kopiranje još
# traje (ili je restartovano), `mdb-export` pročita KRNJ fajl: zaglavlje CSV-a
# izađe ispravno pa brana zaglavlja prođe, a izostane npr. pola dana naloga —
# i sve to bude upisano kao uredan LOADED/DONE koji se nikad ne ponavlja.
#
# Dva nezavisna dokaza kompletnosti, u tom redosledu:
#   1. sentinel `<ime>.ready` — ako dostava ume da ga napiše POSLE zatvaranja
#      fajla, to je najjači dokaz i preskače čekanje;
#   2. inače: veličina + mtime moraju biti NEPROMENJENI kroz $BB_SETTLE_SECONDS.
SETTLE="${BB_SETTLE_SECONDS:-60}"
if [ -f "$MDB.ready" ]; then
  log "sentinel $(basename "$MDB").ready postoji — fajl je kompletan"
else
  sig1="$(stat -c '%s|%Y' "$MDB")"
  log "nema sentinela — proveravam da li fajl još raste (${SETTLE}s) ..."
  sleep "$SETTLE"
  sig2="$(stat -c '%s|%Y' "$MDB")"
  [ "$sig1" = "$sig2" ] || die \
    "FAJL SE JOŠ MENJA ($sig1 -> $sig2) — kopiranje iz BigBita nije završeno.
     Izvoz je prekinut da se ne bi uvezla polovična glavna knjiga. Sledeći
     termin (ili ručno pokretanje) će ga pokupiti. Trajno rešenje: neka dostava
     posle zatvaranja fajla napravi marker '$(basename "$MDB").ready'."
fi

FILE_NAME="$(basename "$MDB")"
FILE_SIZE="$(stat -c '%s' "$MDB")"
FILE_MTIME="$(date -u -d "@$(stat -c '%Y' "$MDB")" '+%Y-%m-%d %H:%M:%S+00')"
AGE_H=$(( ( $(date +%s) - $(stat -c '%Y' "$MDB") ) / 3600 ))
log "drop: $FILE_NAME  ($FILE_SIZE B, mtime $FILE_MTIME, star ${AGE_H}h)"

# ── 2) Registruj drop (identitet = ime+mtime+veličina) ───────────────────────
# Napomena: sha256 se računa kao DOKAZ SADRŽAJA, ali NIJE ključ — Access fajl nije
# bajt-stabilan pa bi ponovni izvoz istih podataka dao drugi heš.
log "sha256 ..."
FILE_SHA="$(sha256sum "$MDB" | cut -d' ' -f1)"

# LAŽNA SVEŽINA: `mtime` pomeri i običan `cp`, `rsync` bez --times ili ponovna
# isporuka ISTOG fajla — pa dvonedeljni sadržaj izgleda „star 0,2 h". Ovaj heš se
# do sada računao i nikad poredio. (Korak 2 ima istu proveru nad već UVEZENIM
# drop-ovima; ova ovde staje ranije i ne troši 18 s na izvoz.)
TWIN="$(psql_q "SELECT id || ' (' || file_name || ', ' || to_char(file_mtime, 'YYYY-MM-DD HH24:MI') || ')'
                  FROM bb_mdb_drops
                 WHERE file_sha256 = '$FILE_SHA' AND stage_status = 'LOADED'
                 ORDER BY file_mtime DESC LIMIT 1;")"
if [ -n "$TWIN" ] && [ "$FORCE" -ne 1 ]; then
  die "BIGBIT JE ISPORUČIO ISTI FAJL PONOVO — sadržaj '$FILE_NAME' je bajt-u-bajt
     jednak već obrađenom drop-u $TWIN. Datum fajla je nov, ali PODACI NISU: noćni
     izvoz na BigBit računaru verovatno ne radi i samo se prekopira stara kopija.
     Javi osobi zaduženoj za BigBit izvoz. (--force preskače ovu proveru.)"
fi

DROP_INFO="$(psql_q "
  INSERT INTO bb_mdb_drops (file_name, file_mtime, file_size, file_sha256)
  VALUES ('$(sql_lit "$FILE_NAME")', '$FILE_MTIME'::timestamptz, $FILE_SIZE, '$FILE_SHA')
  ON CONFLICT (file_name, file_mtime, file_size) DO UPDATE SET file_sha256 = EXCLUDED.file_sha256
  RETURNING id || '|' || stage_status;")"
DROP_ID="${DROP_INFO%%|*}"
STAGE_STATUS="${DROP_INFO##*|}"
log "bb_mdb_drops.id=$DROP_ID (stage_status=$STAGE_STATUS)"

if [ "$STAGE_STATUS" = "LOADED" ] && [ "$FORCE" -ne 1 ]; then
  log "već je stagovan — nema šta da se radi (koristi --force za ponovni izvoz). IZLAZ 0."
  exit 0
fi

# ── 3) Izvoz tabela iz .mdb-a ────────────────────────────────────────────────
WORK="$WORK_ROOT/$DROP_ID"
rm -rf "$WORK"; mkdir -p "$WORK"; chmod 755 "$WORK_ROOT" "$WORK"
# Radni CSV-ovi se brišu po završetku. BB_KEEP_WORK=1 ih ostavlja — koristi kad
# treba da se vidi ŠTA je tačno mdbtools izvezao (npr. posle pada `\copy`-ja).
[ "${BB_KEEP_WORK:-0}" = "1" ] || trap 'rm -rf "$WORK"' EXIT

T0=$(date +%s%3N)
COUNTS_JSON=""
LOAD_SQL="$WORK/load.sql"
: > "$LOAD_SQL"
{
  echo "BEGIN;"
  echo "UPDATE bb_mdb_drops SET stage_status='PENDING', stage_error=NULL WHERE id=$DROP_ID;"
} >> "$LOAD_SQL"

for spec in "${TABLES[@]}"; do
  IFS='|' read -r src stage slug rest <<< "$spec"
  expected="${spec#*|*|*|}"   # sve posle sluga = očekivano zaglavlje
  csv="$WORK/$slug.csv"

  # -d '|'  razdvajač: difolt zarez PUCA — `Broj dokumenta` sadrži zarez
  #         ('105CHGR26003000Q,BI0').
  # -e      C-escape za \r\n\t: memo polja (Opis naloga, Dugacki opis) nose prelome
  #         reda; bez ovoga JEDAN slog zauzme više linija i brojanje redova laže.
  # -T/-D   difolt je AMERIČKI '%m/%d/%y' sa DVOCIFRENOM godinom ('01/03/26') —
  #         bez ovoga se datumi tiho pogrešno tumače (studija je već naletela na '07/09/42').
  docker run --rm -v "$DROP_DIR":/d:ro "$MDB_IMAGE" \
    mdb-export -d '|' -e -T '%Y-%m-%d %H:%M:%S' -D '%Y-%m-%d' "/d/$FILE_NAME" "$src" > "$csv" \
    || die "mdb-export pao za tabelu '$src'"

  header="$(head -1 "$csv")"
  [ "$header" = "$expected" ] || die \
    "ZAGLAVLJE SE PROMENILO za '$src'.
       očekivano: $expected
       dobijeno : $header
     Staging kolone u schema.prisma su deklarisane u očekivanom redosledu i \`\\copy\`
     ide bez liste kolona — nastavak bi upisao pomerene vrednosti. Uskladi
     schema.prisma + manifest u ovoj skripti pa ponovi."

  # Broj redova = PARSIRANE linije - zaglavlje. Nikad `mdb-count` (greši za -9 na
  # T_Glavna knjiga i T_PDV_GK); `wc -l` je ovde tačan JER `-e` uklanja prelome iz memo polja.
  rows=$(( $(wc -l < "$csv") - 1 ))
  [ "$rows" -ge 0 ] || rows=0

  # ── RAZUMNOST BROJA REDOVA ─────────────────────────────────────────────────
  # Glavna knjiga i nalozi tokom godine SAMO RASTU. Pad u odnosu na prethodni
  # uspešan drop znači krnj izvoz (ili pogrešan fajl) — a to je kvar koji bez
  # ove provere prolazi kao uspeh, jer je zaglavlje ispravno.
  prev="$(psql_q "SELECT coalesce((stage_row_counts->>'$(sql_lit "$src")')::int, -1)
                    FROM bb_mdb_drops
                   WHERE stage_status='LOADED' AND id <> $DROP_ID
                   ORDER BY file_mtime DESC LIMIT 1;")"
  prev="${prev:--1}"
  if [ "$prev" -gt 0 ] && [ "${BB_ALLOW_SHRINK:-0}" != "1" ]; then
    floor=$(( prev * 80 / 100 ))
    if [ "$rows" -lt "$floor" ]; then
      psql_q "UPDATE bb_mdb_drops SET stage_status='FAILED',
                stage_error='$(sql_lit "$src: $rows redova, prethodni drop $prev — pad preko 20%")'
               WHERE id=$DROP_ID;" >/dev/null || true
      die "PAD BROJA REDOVA za '$src': sada $rows, prethodni drop $prev (dozvoljeno >= $floor).
     Glavna knjiga tokom godine samo raste, pa je ovo skoro sigurno NEPOTPUN izvoz
     (polovično prekopiran .mdb ili pogrešan fajl). Izvoz je prekinut — ništa nije
     upisano. Ako je pad LEGITIMAN (npr. nova poslovna godina, arhiviranje), pokreni
     ponovo sa BB_ALLOW_SHRINK=1."
    fi
  fi

  log "  $src -> $stage : $rows redova (prethodni drop: $prev)"
  COUNTS_JSON="$COUNTS_JSON$(printf '%s"%s":%d' "${COUNTS_JSON:+,}" "$src" "$rows")"

  # `LIKE ... EXCLUDING ALL` + DROP id/drop_id daje temp tabelu čije kolone su
  # TAČNO izvorne kolone u izvornom redosledu — pa `\copy` ne treba listu kolona,
  # a INSERT ubacuje id iz sekvence i konstantan drop_id ispred `t.*`.
  cat >> "$LOAD_SQL" <<SQL
CREATE TEMP TABLE t_$slug (LIKE $stage EXCLUDING ALL);
ALTER TABLE t_$slug DROP COLUMN id, DROP COLUMN drop_id;
\\copy t_$slug FROM '/w/$slug.csv' WITH (FORMAT csv, HEADER true, DELIMITER '|')
DELETE FROM $stage WHERE drop_id = $DROP_ID;
INSERT INTO $stage
  SELECT nextval(pg_get_serial_sequence('$stage','id')), $DROP_ID, t.* FROM t_$slug t;
DROP TABLE t_$slug;
SQL
done

chmod 644 "$WORK"/*.csv "$LOAD_SQL"

# ── 4) Učitavanje u staging — JEDNA transakcija po drop-u ────────────────────
# Ceo staging se menja atomično: ili je drop LOADED sa svih 9 tabela, ili je
# ostalo staro stanje. Korak 2 (uvoz u 4.0 modele) NAMERNO ide u serijama, to je
# odvojena priča — vidi bigbit-mdb-import.service.ts.
cat >> "$LOAD_SQL" <<SQL
UPDATE bb_mdb_drops SET
  stage_status='LOADED', staged_at=now(),
  stage_row_counts='{$COUNTS_JSON}'::jsonb,
  stage_duration_ms=NULL, stage_error=NULL,
  import_status='PENDING', imported_at=NULL, import_error=NULL
WHERE id=$DROP_ID;
COMMIT;
SQL

log "učitavam u staging ..."
if ! psql_file "load.sql"; then
  psql_q "UPDATE bb_mdb_drops SET stage_status='FAILED',
            stage_error='psql \\copy pao — vidi izlaz skripte' WHERE id=$DROP_ID;" >/dev/null || true
  die "učitavanje u staging PALO (transakcija povučena, staro stanje netaknuto)"
fi

MS=$(( $(date +%s%3N) - T0 ))
psql_q "UPDATE bb_mdb_drops SET stage_duration_ms=$MS WHERE id=$DROP_ID;" >/dev/null

# ── 5) Retencija diska ───────────────────────────────────────────────────────
# 375 MB po noći na ISTOJ particiji (/dev/sda2) na kojoj su Postgres i svi
# kontejneri = ~137 GB godišnje. Pun disk ne obara samo uvoz nego CEO 4.0
# (Postgres prestaje da prihvata upise). Brišu se SAMO .mdb fajlovi stariji od
# $BB_KEEP_DAYS koji NISU tekući drop; `bb_mdb_drops` (zapisnik) ostaje netaknut.
KEEP_DAYS="${BB_KEEP_DAYS:-7}"
OLD="$(find "$DROP_DIR" -maxdepth 1 -type f -iname '*.mdb' -mtime "+$KEEP_DAYS" ! -samefile "$MDB" -print 2>/dev/null | wc -l)"
if [ "$OLD" -gt 0 ]; then
  find "$DROP_DIR" -maxdepth 1 -type f -iname '*.mdb' -mtime "+$KEEP_DAYS" ! -samefile "$MDB" -delete
  find "$DROP_DIR" -maxdepth 1 -type f -iname '*.mdb.ready' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true
  log "retencija: obrisano $OLD .mdb fajl(ova) starijih od ${KEEP_DAYS} dana"
fi
df -Pk "$DROP_DIR" | awk 'NR==2 {printf "slobodno na %s: %d GB (%s zauzeto)\n", $6, $4/1048576, $5}'

log "GOTOVO — drop $DROP_ID stagovan za ${MS} ms. Korak 2 = scheduler posao 'bigbit-mdb-sync'."
