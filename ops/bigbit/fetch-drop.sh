#!/usr/bin/env bash
# Preuzmi najnoviji BigBit backup sa BigBit masine u lokalni drop folder.
#
# ZASTO OVAKO (01.08.2026): zakazani zadatak na BigBit masini radi kao domenski
# nalog SERVOTEH\zoran.jarakovic i NE MOZE da se prijavi na Samba share
# \192.168.64.28\bigbit-incoming (guest ok = no, valid users = bbdrop) — pa je
# kopija tiho izostajala svaki dan, dok je ista skripta na \srv\Shares uredno
# stizala. Zato je smer okrenut: Windows pise LOKALNO (uvek uspeva), a server
# cita preko CIFS pristupa koji vec radi (kredencijali /etc/cifs-bigbit.cred).
set -Eeuo pipefail

SRC="${BB_FETCH_SRC:-/mnt/bb-drop}"
DST="${BB_DROP_DIR:-/srv/bigbit-incoming}"

log() { printf "%s  %s\n" "$(date "+%Y-%m-%d %H:%M:%S")" "$*"; }

[ -d "$SRC" ] || { log "GRESKA: $SRC nije montiran — proveri mount /mnt/bb-drop"; exit 1; }

najnoviji="$(ls -1t "$SRC"/BB_T_26_*.mdb 2>/dev/null | head -1 || true)"
[ -n "$najnoviji" ] || { log "GRESKA: u $SRC nema nijednog BB_T_26_*.mdb — backup na BigBit masini nije stigao"; exit 1; }

ime="$(basename "$najnoviji")"
# PRESKACE SE SAMO KAD JE ISTI I PO VELICINI I PO VREMENU IZMENE.
#
# Ispravka 01.08.2026: do sada se gledala samo velicina, a to je propuštalo nov
# sadrzaj u dva slucaja koja se OBA desavaju svakodnevno:
#   1. ime fajla nosi DATUM, pa dva backupa istog dana nose isto ime;
#   2. Access baza cesto ostane ISTE VELICINE iako je sadrzaj izmenjen.
# `cp -p` cuva vreme izmene izvora, a izvorni backup ga nasledjuje od zive baze —
# pa je mtime jedini signal koji se stvarno menja kad neko radi u BigBitu.
if [ -f "$DST/$ime" ]    && [ "$(stat -c%s "$DST/$ime")" = "$(stat -c%s "$najnoviji")" ]    && [ "$(stat -c%Y "$DST/$ime")" = "$(stat -c%Y "$najnoviji")" ]; then
  log "$ime vec postoji u $DST (ista velicina i vreme izmene) — ne kopiram"
  exit 0
fi

log "kopiram $ime ($(du -h "$najnoviji" | cut -f1)) ..."
cp -p "$najnoviji" "$DST/.$ime.part"
mv -f "$DST/.$ime.part" "$DST/$ime"
log "gotovo: $DST/$ime"
