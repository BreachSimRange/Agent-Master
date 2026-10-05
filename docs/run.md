[← back to the README](../README.md)

# Run and configure

Every option of the web app and the terminal server, the systemd services, what happens after a reboot, and where the files live.

```sh
git clone https://github.com/<you>/agent-master.git ~/agent-master
cd ~/agent-master && pip install -r requirements.txt   # if pip refuses (PEP 668, Kali/Debian 12+): add --break-system-packages
ln -s ~/agent-master/cli.py ~/.local/bin/agent-master   # the console command (optional)
./run.sh                  # http://127.0.0.1:3000; the first visitor creates the account with the setup token from the log
```

| Option | Default | Meaning |
|---|---|---|
| `--host ADDR` | `127.0.0.1` | bind address; `::` for the LAN (IPv4 and IPv6 together: a `.local` name resolves to both), `0.0.0.0` for IPv4 only |
| `--port N` | `3000` | TCP port |
| `--socket PATH` | auto | unix socket of an optional terminal backend for the default session; named sessions are found automatically |
| `--config PATH` | `~/.config/agent-master/config.json` | account, session secret, database, hook token |
| `--tls`, `--cert FILE --key FILE`, `--tls-name NAME` | off | HTTPS: self-signed, or your own certificate |
| `--allowed-host NAME` | any | repeatable; requests by IP address are refused |
| `--tunnel-only` | off | bind 127.0.0.1 no matter what and refuse anything not addressed to localhost |
| `--behind-proxy` | off | trust `X-Forwarded-*` from a proxy on 127.0.0.1 (required behind Caddy, nginx or `tailscale serve`, so lockout and logs see real addresses) |
| `--no-auth`, `--reset-password` | | disable the sign-in; forget the account |
| `--browse-anywhere` | off | let the new-workspace folder browser leave `$HOME` |
| `--verbose` | off | log every request |

`AGENT_MASTER_HOST`, `AGENT_MASTER_PORT`, `AGENT_MASTER_CONFIG`, `AGENT_MASTER_SOCKET` and
`AGENT_MASTER_SESSION` set the defaults; `ANTHROPIC_API_KEY` switches the lounge chatter to the API.
`AGENT_MASTER_PTYD_SOCK` points the web app and the console at another terminal-server socket
(`AGENT_MASTER_CONFIG_DIR` moves the whole config folder). The terminal server itself takes
`--config-dir DIR` and `--socket PATH`.

### Start the Agent-Master services

Agent-Master is two systemd **user** services, run as your own user. **No root, no sudo.**

| Service | What it does |
|---|---|
| `agent-masterd` | the terminal server: owns every terminal and the agents in them |
| `agent-master` | the web app on port 3000: office, browser terminals, database |

Keeping them apart is the point: you can restart or update the web app at any time and every agent
keeps running. Everything lives under your home directory (`~/.config/agent-master/`: account,
session secret, the SQLite database, the terminal list, the terminal server's socket, pasted
screenshots). Nothing is system-wide.

`./install.sh` from the checkout writes these units, links the console command and starts everything. By hand, create the two units (copies live in `docs/systemd/`):

```ini
# ~/.config/systemd/user/agent-masterd.service
[Unit]
Description=Agent-Master terminal server (agent-masterd)
After=default.target

[Service]
WorkingDirectory=%h/agent-master
ExecStart=/usr/bin/python3 %h/agent-master/ptyd.py
ExecReload=/bin/kill -USR1 $MAINPID
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
KillMode=mixed

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/agent-master.service
[Unit]
Description=Agent-Master
After=default.target agent-masterd.service
Wants=agent-masterd.service

[Service]
WorkingDirectory=%h/agent-master
ExecStart=%h/agent-master/run.sh --tunnel-only
# for LAN access over HTTPS by hostname instead of the SSH tunnel, use:
# ExecStart=%h/agent-master/run.sh --host :: --cert %h/.config/agent-master/lan-cert.pem --key %h/.config/agent-master/lan-key.pem --allowed-host myhost --allowed-host myhost.local
Restart=on-failure

[Install]
WantedBy=default.target
```

Optional, VS Code in the browser (needs VS Code installed: `code` on the `PATH`; the first start downloads
the web client, about a minute):

```ini
# ~/.config/systemd/user/agent-master-code.service
[Unit]
Description=Agent-Master editor (VS Code in the browser, code serve-web)
After=default.target agent-master.service

[Service]
WorkingDirectory=%h
ExecStart=/usr/bin/code serve-web --host 127.0.0.1 --port 8043 --server-base-path /code --connection-token-file %h/.config/agent-master/code-token --accept-server-license-terms --server-data-dir %h/.config/agent-master/code-server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

It listens on localhost only; the web app proxies it under `/code/` and adds the connection token
(`~/.config/agent-master/code-token`, written by the web app on its first start), so VS Code is
never reachable on its own. `--accept-server-license-terms` accepts Microsoft's licence for the
VS Code Server, which allows this personal, own-machine use.

Then enable and start it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-masterd     # the terminal server
systemctl --user enable --now agent-master      # the web app
systemctl --user enable --now agent-master-code # optional: VS Code in the browser
loginctl enable-linger $USER                    # keep it running at boot without a login session
```

Manage it with:

```sh
systemctl --user status agent-master agent-masterd   # are they running
systemctl --user restart agent-master                # after changing the web app; agents keep running
systemctl --user reload agent-masterd                # after changing ptyd.py; agents keep running
systemctl --user restart agent-masterd               # full restart; agents are resumed by session id
journalctl --user -u agent-master -u agent-masterd -f
systemctl --user stop agent-master agent-masterd
```

`reload` swaps in new terminal-server code without touching any terminal: the server runs its new
code in the same process and keeps every terminal open, so agents and shells carry on, even in the
middle of a turn. A full `restart` (or a reboot) ends the processes in the terminals: Claude Code
terminals come back resumed with the same conversation, plain shells come back as fresh shells in
the same folder, and a turn that was running is cut off.

What to run after a change:

| You changed | Run | Agents | Browsers and consoles |
|---|---|---|---|
| `static/` (JavaScript, CSS, HTML) | nothing | untouched | reload the page |
| web app Python (`app.py`, `hub.py`, `terms.py`, `store.py`, ...) | `systemctl --user restart agent-master` | keep running | reconnect by themselves |
| `ptyd.py` | `systemctl --user reload agent-masterd` | keep running, even mid-turn | reattach within a second or two |
| `hooks/term-status.py` | nothing: Claude Code runs the script fresh on every event | untouched | nothing |
| `cli.py` | nothing: the next `agent-master` uses it | untouched | open the console again |
| a unit file | `systemctl --user daemon-reload`, then restart that service | see the rows above | see the rows above |
| Claude Code was updated | restart each agent once ("update ready" in the UI, Ctrl+B R in the console) | resumed on the new version | nothing |

Check that everything is up:

```sh
systemctl --user is-active agent-master agent-masterd   # active, active
agent-master list                                       # every workspace with its status
```

| Detail | Value |
|---|---|
| Runs as | your user (systemd `--user`); never root |
| Port | 3000 for the web app (change with `--port`); the terminal server has no port, only a private unix socket |
| Data | `~/.config/agent-master/`, mode 700 (see [Files and data](run.md#files-and-data)) |
| Starts at boot | yes, once `loginctl enable-linger $USER` is set |
| Depends on | Claude Code installed and signed in as the same user |
| Logs | `journalctl --user -u agent-master -u agent-masterd` |

The only steps that ever need root are optional one-time setup (installing `avahi`/`mkcert` for LAN
HTTPS, or editing `sshd` for the tunnel); the service itself does not.

### After a reboot

Nothing to do. Both services start themselves (thanks to `enable-linger`). The terminal server
starts every terminal again, Claude Code ones with `--resume <session id>`, so the agents are there
with their conversations when you open the page. Requirements: Claude Code installed and signed in
for the service's user (`claude` on the `PATH`, or `~/.local/bin/claude`); the agents inherit its
login, settings and hooks.

### Files and data

Everything lives in `~/.config/agent-master/` (mode 700; the files that matter are mode 600):

| File | What it holds |
|---|---|
| `config.json` | account (password hash), session secret, hook token |
| `events.db` | SQLite: event log, status history, preferences, headless conversations and imported history |
| `terminals.json` | the terminal server's workspaces: label, folder, what runs, Claude session id, last stats |
| `claude-hooks.json` | the hooks, status line and `"tui": "default"` the terminal server gives each Claude Code it starts (rewritten at every start) |
| `code-token`, `code-server/`, `code-defaults.json` | the connection token the web app adds to every request it proxies to VS Code, VS Code's own server data (extensions), and optional extra configuration defaults for the workbench |
| `ptyd.sock` | the terminal server's socket; only your user can open it |
| `paste/` | screenshots pasted into the UI (the newest 100, at most 3 days old) |
| `lan-cert.pem`, `lan-key.pem` | the HTTPS certificate, when you made one |
| `reload.json`, `reload-*.buf` | present for a moment during a reload, then removed |

To back up, stop both services and copy the folder. The conversations themselves are Claude Code's
transcripts in `~/.claude/projects/`; Agent-Master only keeps the session ids, so a restored
`terminals.json` resumes every agent where it was.

### Move headless agents into terminals

Agents created earlier in headless mode keep working, but a real terminal is the default now. To
move one, open its character card and click "move to terminal": the headless process is stopped and
the same Claude Code session is resumed in a terminal, with the model it was using.
