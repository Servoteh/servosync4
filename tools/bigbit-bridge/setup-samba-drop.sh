#!/usr/bin/env bash
# One-time setup of the SMB "drop" share on ubuntusrv, so the BigBit machine can
# push its .mdb export straight onto this server (a scheduled Windows copy to
# \\192.168.64.28\bigbit-incoming). The bridge then reads the newest *.mdb there.
#
# Two modes:
#   sudo bash setup-samba-drop.sh --guest            # PASSWORDLESS (guest) share
#   sudo bash setup-samba-drop.sh [smb_user] [smb_pass] [bridge_user]   # with account
set -euo pipefail

DROP=/srv/bigbit-incoming
SHARE=bigbit-incoming
GUEST=0
if [[ "${1:-}" == "--guest" ]]; then GUEST=1; shift; fi
SMB_USER="${1:-bbdrop}"
SMB_PASS="${2:-}"
BRIDGE_USER="${3:-admnenad}"   # account that runs the bridge (needs READ on the drop)

[[ $EUID -eq 0 ]] || { echo "Pokreni kao root: sudo bash setup-samba-drop.sh [--guest]" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
echo "== 1/5 install samba =="
apt-get update -qq
apt-get install -y samba

echo "== 2/5 group + smb user (writer) + bridge user (reader) =="
groupadd -f "$SMB_USER"
id -u "$SMB_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin -g "$SMB_USER" "$SMB_USER"
usermod -aG "$SMB_USER" "$BRIDGE_USER"

echo "== 3/5 drop folder $DROP =="
mkdir -p "$DROP"
if [[ $GUEST -eq 1 ]]; then
  # guest writes are forced to $SMB_USER; files world-readable so the bridge reads them
  chown "$SMB_USER:$SMB_USER" "$DROP"; chmod 0775 "$DROP"
else
  chown "$SMB_USER:$SMB_USER" "$DROP"; chmod 2770 "$DROP"   # setgid: shared group
fi
# migrate anything already dropped into the home test folder
if [[ -d "/home/$BRIDGE_USER/bigbit-incoming" ]]; then
  find "/home/$BRIDGE_USER/bigbit-incoming" -maxdepth 1 -iname '*.mdb' -exec cp -n {} "$DROP/" \; 2>/dev/null || true
  chown "$SMB_USER:$SMB_USER" "$DROP"/*.mdb 2>/dev/null || true
  chmod 0664 "$DROP"/*.mdb 2>/dev/null || true
fi

echo "== 4/5 share u /etc/samba/smb.conf =="
if ! grep -q "^\[$SHARE\]" /etc/samba/smb.conf; then
  if [[ $GUEST -eq 1 ]]; then
    # passwordless: unknown users map to guest; writes owned by $SMB_USER
    grep -q '^\s*map to guest' /etc/samba/smb.conf || sed -i '/^\[global\]/a \   map to guest = Bad User' /etc/samba/smb.conf
    cat >> /etc/samba/smb.conf <<CONF

[$SHARE]
   comment = ServoSync BigBit izvoz (drop, guest)
   path = $DROP
   browseable = yes
   read only = no
   guest ok = yes
   force user = $SMB_USER
   force group = $SMB_USER
   create mask = 0664
   directory mask = 0775
CONF
  else
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
  fi
else
  echo "   (share [$SHARE] vec postoji u smb.conf - preskacem)"
fi

echo "== 5/5 nalog/lozinka + firewall + restart =="
if [[ $GUEST -eq 1 ]]; then
  echo "   guest mod - bez samba lozinke."
elif [[ -n "$SMB_PASS" ]]; then
  printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -s -a "$SMB_USER"; smbpasswd -e "$SMB_USER"
else
  echo ">> Unesi samba lozinku za nalog '$SMB_USER' (koju ce BigBit mašina koristiti):"
  smbpasswd -a "$SMB_USER"; smbpasswd -e "$SMB_USER"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from 192.168.64.0/24 to any app Samba 2>/dev/null || ufw allow Samba 2>/dev/null || true
fi
testparm -s >/dev/null 2>&1 || { echo "!! smb.conf ima gresku (testparm) - proveri." >&2; exit 1; }
systemctl enable --now smbd
systemctl restart smbd

echo
if [[ $GUEST -eq 1 ]]; then
  echo "OK. PASSWORDLESS share:  \\\\192.168.64.28\\$SHARE   (bez lozinke - guest)"
else
  echo "OK. Share:  \\\\192.168.64.28\\$SHARE   (nalog: $SMB_USER)"
fi
echo "Na BigBit mašini: postojeci task nek kopira .mdb i u taj share (uz onaj u c:\\BackUP_BigBit\\BigBit)."
echo "Podesi u ~/bigbit-bridge/bigbit-bridge.env:  BB_SRC_MDB=$DROP"
