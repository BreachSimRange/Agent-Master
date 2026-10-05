#!/usr/bin/env sh
# Agent-Master: install and start the systemd user services from this checkout.
#   ./install.sh            # terminal server + web app (+ VS Code in the browser when `code` is installed)
#   ./install.sh --no-code  # skip the VS Code service
# Re-run it after moving the checkout; it rewrites the unit files (a customised ExecStart in
# agent-master.service is kept) and links the console command to ~/.local/bin/agent-master.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$HOME/.local/bin"
want_code=1; [ "${1:-}" = "--no-code" ] && want_code=0
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
python3 -c "import fastapi, uvicorn, httpx, websockets" 2>/dev/null || { echo "missing Python packages: pip install -r $here/requirements.txt"; exit 1; }
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || echo "note: claude is not on the PATH; install and sign in to Claude Code before starting agents"
for u in agent-masterd agent-master; do
  if [ -f "$units/$u.service" ] && [ "$u" = agent-master ] && grep -q "^ExecStart=.*--host" "$units/$u.service"; then
    echo "keeping your customised $u.service"
  else
    sed "s|%h/agent-master|$here|g" "$here/docs/systemd/$u.service" > "$units/$u.service"; echo "wrote $units/$u.service"
  fi
done
if [ "$want_code" = 1 ] && command -v code >/dev/null; then
  sed "s|/usr/bin/code|$(command -v code)|" "$here/docs/systemd/agent-master-code.service" > "$units/agent-master-code.service"; echo "wrote $units/agent-master-code.service"
elif [ "$want_code" = 1 ]; then
  echo "VS Code (code) not found: skipping the editor service (install VS Code and re-run to add it)"
fi
ln -sf "$here/cli.py" "$HOME/.local/bin/agent-master"; chmod +x "$here/cli.py" "$here/run.sh"
systemctl --user daemon-reload
systemctl --user enable --now agent-masterd agent-master
[ -f "$units/agent-master-code.service" ] && systemctl --user enable --now agent-master-code
loginctl enable-linger "$USER" 2>/dev/null || echo "note: 'loginctl enable-linger $USER' keeps it running at boot without a login session"
echo
echo "running: $(systemctl --user is-active agent-masterd agent-master 2>/dev/null | paste -sd' ')"
echo "open http://127.0.0.1:3000/ on this machine; the first visitor creates the account with the setup token from:"
echo "  journalctl --user -u agent-master | grep 'setup token'"
