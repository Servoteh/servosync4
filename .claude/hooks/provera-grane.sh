#!/usr/bin/env bash
# PROVERA ZAOSTATKA GRANE ZA `main` (Claude Code SessionStart hook)
#
# ── ZAŠTO POSTOJI ────────────────────────────────────────────────────────────
# PRAVILO (Nenad, 04.08.2026): „kad pišem o izmenama, uvek su izmene nečega što je
# već na main-u". Zahtev se dakle odnosi na ono što ljudi koriste, a ne na stanje
# grane u kojoj se sesija zatekne. Ako je grana daleko iza, zaključak „ovoga nema
# u repou" je LAŽAN.
#
# Šta je koštalo: 04.08.2026. je na grani 285 commitova / 39 migracija iza main-a
# napravljen paralelan modul „Artikli", iako main već ima `masters/items.*` i
# `frontend/src/app/artikli/*`. Uz njega i migracija koja bi na produkciji oborila
# unos artikala (pomerala je `items_id_seq` ispod granice iz `chk_items_native_id_range`).
#
# ── PONAŠANJE ────────────────────────────────────────────────────────────────
# Ćuti kad je sve u redu. Nikad ne obara sesiju: svaki korak sme da padne (nema
# mreže, nije git repo, drugi remote) i skript i dalje izlazi sa 0.

set -uo pipefail

KOREN="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$KOREN" 2>/dev/null || exit 0

# Osveži main; bez mreže se radi sa zatečenim origin/main (bolje išta nego ništa).
timeout 25 git fetch origin main --quiet >/dev/null 2>&1 || true

GRANA="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

# Brojevi se čiste kroz `tr -dc '0-9'`. `|| echo 0` uz komandu koja i sama nešto
# ispiše daje dvored ("0\n0"), pa `[ ... -lt ... ]` puca sa „integer expected"
# (uhvaćeno pri testiranju 04.08.2026 — ista klasa greške kao `grep -q` + pipefail).
IZA="$(git rev-list --count HEAD..origin/main 2>/dev/null | tr -dc '0-9')"
[ -z "$IZA" ] && IZA=0

# Migracije koje main ima a grana nema — najskuplja vrsta zaostatka: šema na
# produkciji je otišla dalje nego što ova grana zna, pa se nova migracija piše na
# osnovu stanja koje više ne postoji.
# `migration_lock.toml` se filtrira sa OBE strane — inače ga `comm` prijavi kao
# „fali" i hook lažno uzbunjuje na svakoj sesiji.
MIG_FALI=0
MIG_DIR="backend/prisma/migrations"
if [ -d "$MIG_DIR" ]; then
  MIG_FALI="$(
    comm -13 \
      <(ls "$MIG_DIR" 2>/dev/null | grep -v migration_lock | sort) \
      <(git ls-tree --name-only "origin/main" "$MIG_DIR/" 2>/dev/null \
          | xargs -n1 basename 2>/dev/null | grep -v migration_lock | sort) \
      2>/dev/null | sed '/^$/d' | wc -l | tr -dc '0-9'
  )"
  [ -z "$MIG_FALI" ] && MIG_FALI=0
fi

# Ispod ovog praga je normalan rad u toku dana i ne javlja se ništa.
PRAG_COMMITOVA=20

if [ "$IZA" -lt "$PRAG_COMMITOVA" ] && [ "$MIG_FALI" -eq 0 ]; then
  exit 0
fi

PORUKA="Grana '$GRANA' je $IZA commitova iza origin/main"
[ "$MIG_FALI" -gt 0 ] && PORUKA="$PORUKA, i fali joj $MIG_FALI migracija koje main ima"
PORUKA="$PORUKA. Izmene se odnose na ono sto je na main-u."

KONTEKST="ZAOSTALA GRANA: '$GRANA' je $IZA commitova iza origin/main"
[ "$MIG_FALI" -gt 0 ] && KONTEKST="$KONTEKST i nema $MIG_FALI migracija koje main ima"
KONTEKST="$KONTEKST. PRAVILO (Nenad): zahtev za izmenu se UVEK odnosi na ono sto je na main-u. Pre rada proveri kako ta stvar izgleda tamo: 'git ls-tree -r --name-only origin/main -- <domen>' i 'git show origin/main:<putanja>'. Odsustvo u radnoj kopiji NIJE dokaz da ne postoji. Za nov rad otvori svezu granu od origin/main u zasebnom worktree-u. Za bilo sta sto dira bazu izmeri produkciju pre pisanja migracije."

# JSON bez zavisnosti od jq (poruke su naše — bez navodnika i novih redova).
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
  "$PORUKA" "$KONTEKST"
exit 0
