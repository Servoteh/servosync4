#!/usr/bin/env bash
# Install the BigBit bridge as a systemd system timer on ubuntusrv (daily 05:30).
# Builds the mdb-tools docker image, then registers service+timer. Needs sudo.
#
#   ./install-timer.sh            # build image + install + enable timer
#   ./install-timer.sh --time 04:00
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${BB_MDBTOOLS_IMAGE:-servosync/mdbtools:local}"
RUN_TIME="05:30"
RUN_USER="$(id -un)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time) RUN_TIME="$2"; shift 2 ;;
    *) echo "Nepoznat argument: $1"; exit 1 ;;
  esac
done

if [[ ! -f "$SCRIPT_DIR/bigbit-bridge.env" ]]; then
  echo "!! bigbit-bridge.env ne postoji - napravi ga (cp bigbit-bridge.env.example bigbit-bridge.env) pa popuni." >&2
  exit 1
fi

echo "== 1/3 build mdb-tools image ($IMAGE) =="
docker build -t "$IMAGE" -f "$SCRIPT_DIR/Dockerfile.mdbtools" "$SCRIPT_DIR"

echo "== 2/3 smoke (dry-run nad konfigurisanim izvorom) =="
BB_DRY_RUN=1 bash "$SCRIPT_DIR/bigbit-bridge.sh" || { echo "!! dry-run pao - popravi konfiguraciju pre instalacije." >&2; exit 1; }

echo "== 3/3 systemd service + timer (daily $RUN_TIME) =="
sudo tee /etc/systemd/system/bigbit-bridge.service >/dev/null <<UNIT
[Unit]
Description=ServoSync BigBit -> PG daily sync (mdb-tools)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$RUN_USER
ExecStart=/usr/bin/env bash $SCRIPT_DIR/bigbit-bridge.sh
UNIT

sudo tee /etc/systemd/system/bigbit-bridge.timer >/dev/null <<UNIT
[Unit]
Description=Run ServoSync BigBit bridge daily

[Timer]
OnCalendar=*-*-* $RUN_TIME:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now bigbit-bridge.timer
echo "OK. Sledeci termin:"; systemctl list-timers bigbit-bridge.timer --no-pager || true
echo "Rucno pokretanje: sudo systemctl start bigbit-bridge.service ; journalctl -u bigbit-bridge.service -n 50 --no-pager"
