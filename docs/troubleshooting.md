[← back to the README](../README.md)

# Troubleshooting

- Blank page or "empty response" on the LAN: use `https://`, not `http://`, with a TLS instance.
- `use the hostname, not the IP address`: the instance runs with `--allowed-host`; open it by name.
- The name does not resolve on a device: use `myhost.local` (mDNS) or the device's hosts file.
- **"Server not found" sometimes, works other times.** That is intermittent name resolution, not the
  server going down (a stopped server gives "connection refused" or a timeout, not "server not found").
  `.local` names travel over Wi-Fi multicast, which an adapter in power-save mode drops at random, so
  the name resolves on one try and fails the next. The server is fine; the query or its reply was lost.
  Fixes, most reliable first: add a hosts-file line on the client so resolution never uses multicast -
  `192.168.1.10 myhost.local` in `/etc/hosts` (macOS/Linux) or `C:\Windows\System32\drivers\etc\hosts`
  (Windows, edit as administrator); pin the server's address in your router's DHCP so that line stays
  valid; and turn off Wi-Fi power save on the server so it answers mDNS reliably -
  `sudo iw dev wlan0 set power_save off`, made permanent with
  `sudo nmcli connection modify <wifi-name> wifi.powersave 2`.
- **Windows cannot resolve `myhost.local` at all.** Windows 10 (1703+) and 11 resolve `.local`
  natively, but only on a network marked **Private** (Settings → Network → set the Wi-Fi to Private),
  and a VPN client can swallow the query. The sure fix is Apple's **Bonjour Print Services for Windows**
  (installs an mDNS responder every browser uses), or the hosts-file line above.
- Status bar says "terminal server offline": start it with `systemctl --user start agent-masterd`
  and look at `journalctl --user -u agent-masterd`.
- A Claude Code terminal asks "Do you trust the files in this folder?": that is Claude Code's own
  first-run question for a new folder; answer it in the terminal.
- `agent-master: the terminal server is not running`: `systemctl --user start agent-masterd`.
- `zsh: command not found: agent-master` over SSH: use the full path, `~/.local/bin/agent-master`
  (see the console section), or put `~/.local/bin` on the `PATH` in `~/.zshenv`.
- The console shows plain or wrong colours: the local terminal lacks 256 colours or `TERM` is wrong
  (`TERM=xterm-256color`), or you forgot `ssh -t`.
- An agent shows no model, context or cost: it was started before the status line existed, or it
  has not drawn its screen yet. Restart it once (right-click, "Restart the process").
- "update ready" stays after an update: that agent still runs the old version; restart it.
- The screen of a terminal looks cut off or too wide: a browser and a console share it and the size
  follows whoever typed last. Type a key in the one you are using; the program repaints at its size.
- A terminal says `[process exited ... press Enter to start it again]`: the program and the shell
  after it ended; Enter starts it again in the same folder.
- A reload left the terminal server stopped: read `journalctl --user -u agent-masterd`, then
  `systemctl --user restart agent-masterd`; Claude Code agents are resumed by session id.
- Card says "transcript not found": the agent is not Claude Code or its session file is not on this machine.
- A resumed workspace comes up as a fresh chat with no history: the resume could not find its transcript
  (`~/.claude/projects/<folder>/<session id>.jsonl`), so Claude Code started a new session. Agent-Master
  says so in a toast and keeps the old id: open the character card and click **previous session** to
  restart on it, or `agent-master list` marks the workspace with `*` and prints the `--resume` command.
- Locked out: `./run.sh --reset-password`. Port in use: `--port 8080`.
