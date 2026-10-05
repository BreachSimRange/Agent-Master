#!/usr/bin/env sh
# Agent-Master from Abx.
#   ./run.sh                         # 127.0.0.1:3000
#   ./run.sh --tunnel-only           # SSH-tunnel mode: localhost only, refuses every other address (README, Mode B)
#   ./run.sh --host 0.0.0.0 --cert ~/.config/agent-master/lan-cert.pem --key ~/.config/agent-master/lan-key.pem   # home LAN over HTTPS (Mode A)
#   ./run.sh --reset-password        # forget the account (next visitor creates a new one)
#   ./run.sh --tls                   # HTTPS with a self-signed certificate
#   ./run.sh --port 8080
# Account, hook token and session secret live in ~/.config/agent-master/config.json (override with --config).
cd "$(dirname "$0")"
exec python3 app.py "$@"
