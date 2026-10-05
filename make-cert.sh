#!/usr/bin/env sh
# Issue a locally trusted certificate for this machine's LAN hostname with mkcert.
# Run once on the machine that hosts Agent-Master (needs mkcert; see README "TLS with a hostname").
#   ./make-cert.sh                 # uses <hostname>.local plus the LAN IP
#   ./make-cert.sh office.home.lan  # extra names
set -eu
command -v mkcert >/dev/null 2>&1 || { echo "mkcert is not installed: sudo apt install mkcert libnss3-tools"; exit 1; }
dir="${AGENT_MASTER_CONFIG_DIR:-$HOME/.config/agent-master}"
mkdir -p "$dir"; chmod 700 "$dir"
host="$(hostname)"
ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '!/docker|br-|veth/ {split($4,a,"/"); print a[1]; exit}')"
mkcert -install >/dev/null 2>&1 || mkcert -install
names="$host.local localhost 127.0.0.1 ${ip:-} $*"
# shellcheck disable=SC2086
mkcert -cert-file "$dir/lan-cert.pem" -key-file "$dir/lan-key.pem" $names
chmod 600 "$dir/lan-key.pem" "$dir/lan-cert.pem"
root="$(mkcert -CAROOT)/rootCA.pem"
echo
echo "certificate: $dir/lan-cert.pem  (names: $names)"
echo "key:         $dir/lan-key.pem"
echo "root CA:     $root"
echo
echo "start the UI with:  ./run.sh --host 0.0.0.0 --cert $dir/lan-cert.pem --key $dir/lan-key.pem"
echo "then open           https://$host.local:3000/"
echo
echo "copy $root to every laptop/phone and import it as a trusted root (see README)."
