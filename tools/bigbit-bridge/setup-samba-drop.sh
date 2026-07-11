#!/usr/bin/env bash
# One-time setup of the SMB "drop" share on ubuntusrv, so the BigBit machine can
# push its .mdb export straight onto this server (a scheduled Windows copy to
# \\192.168.64.28\bigbit-incoming). The bridge then reads the newest *.mdb there.
# Run as root:  sudo bash setup-samba-drop.sh [smb_user] [smb_pass] [bridge_user]
set -euo pipefail

DROP=/srv/bigbit-incoming
SHARE=bigbit-incoming
SMB_USER="${1:-bbdrop}"
SMB_PASS="${2:-}"
BRIDGE_USER="${3:-admnenad}"   # account that runs the bridge (needs READ on the drop)

[[ $EUID -eq 0 ]] || { echo "Pokreni kao root: sudo bash setup-samba-drop.sh" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
echo "== 1/5 install samba =="
apt-get update -qq
apt-get install -y samba

echo "== 2/5 group + smb user (writer) + bridge user (reader) =="
groupadd -f "$SMB_USER"
id -u "$SMB_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin -g "$SMB_USER" "$SMB_USER"
usermod -aG "$SMB_USER" "$BRIDGE_USER"

echo "== 3/5 drop folder $DROP (setgid, deljena grupa) =="
mkdir -p "$DROP"
chown "$SMB_USER:$SMB_USER" "$DROP"
chmod 2770 "$DROP"
# migrate anything already dropped into the home test folder
if [[ -d "/home/$BRIDGE_USER/bigbit-incoming" ]]; then
  find "/home/$BRIDGE_USER/bigbit-incoming" -maxdepth 1 -iname '*.mdb' -exec cp -n {} "$DROP/" \; 2>/dev/null || true
  chgrp "$SMB_USER" "$DROP"/*.mdb 2>/dev/null || true
  chmod 0660 "$DROP"/*.mdb 2>/dev/null || true
fi

echo "== 4/5 share u /etc/samba/smb.conf =="
if ! grep -q "^\[$SHARE\]" /etc/samba/smb.conf; then
  cat >> /etc/samba/smb.conf <<CONF

[$SHARE]
   comment = ServoSync BigBit izvoz (drop folder)
   path = $DROP
   browseable = yes
   read only = no
   guest ok = no
   valid users = @$SMB_USER
   force group = $SMB_USER
   create mask = 0660
   force create mode = 0660
   directory mask = 2770
CONF
else
  echo "   (share [$SHARE] vec postoji u smb.conf - preskacem)"
fi

echo "== 5/5 samba lozinka + firewall + restart =="
if [[ -n "$SMB_PASS" ]]; then
  printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -s -a "$SMB_USER"
else
  echo ">> Unesi samba lozinku za nalog '$SMB_USER' (koju ce BigBit mašina koristiti):"
  smbpasswd -a "$SMB_USER"
fi
smbpasswd -e "$SMB_USER"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from 192.168.64.0/24 to any app Samba 2>/dev/null || ufw allow Samba 2>/dev/null || true
fi
systemctl enable --now smbd
systemctl restart smbd

echo
echo "OK. Share:  \\\\192.168.64.28\\$SHARE   (nalog: $SMB_USER)"
echo "Na BigBit mašini: zakazani Windows task koji kopira izvezeni .mdb u taj share."
echo "Podesi u ~/bigbit-bridge/bigbit-bridge.env:  BB_SRC_MDB=$DROP"
