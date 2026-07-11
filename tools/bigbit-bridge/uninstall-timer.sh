#!/usr/bin/env bash
# Remove the BigBit bridge systemd timer/service (data in PG is left untouched).
#   ./uninstall-timer.sh              # stop + disable + remove units
#   ./uninstall-timer.sh --disable    # just stop + disable, keep unit files
set -euo pipefail
MODE="remove"; [[ "${1:-}" == "--disable" ]] && MODE="disable"

sudo systemctl disable --now bigbit-bridge.timer 2>/dev/null || true
sudo systemctl stop bigbit-bridge.service 2>/dev/null || true
if [[ "$MODE" == "remove" ]]; then
  sudo rm -f /etc/systemd/system/bigbit-bridge.timer /etc/systemd/system/bigbit-bridge.service
  sudo systemctl daemon-reload
  echo "Uklonjeni service+timer. (Podaci u PG ostaju; rollback = DELETE iz item_groups/item_subgroups/item_origins.)"
else
  echo "Timer zaustavljen i disable-ovan; unit fajlovi ostaju."
fi
