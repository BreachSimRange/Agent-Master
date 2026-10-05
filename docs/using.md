[← back to the README](../README.md)

# Using it

The web UI and the console, action by action.

| Action | How |
|---|---|
| Select a workspace | click its character or terminal tab, a ribbon character (next agent in that state), or Ctrl+K |
| Start an agent | + in the tab row: pick the folder, a label and what to start (Claude Code with an optional model and permission mode, codex, gemini, a custom command, or just a shell). It opens as a real terminal. A folder that already has Claude Code conversations opens with its latest one, history included: the "Conversation" field lists them, newest first, and can start a new one instead |
| Open a shell on the machine | `>_` next to the tabs, or Ctrl+K "New terminal" |
| Type into an agent | click in the terminal and type, exactly as in a local terminal: Shift+Tab cycles modes, Esc interrupts, arrows pick answers in permission prompts. Quick keys under it send the same keys. The optional prompt box (Settings, Appearance) adds history, templates and broadcast |
| Answer a blocked agent | the attention panel shows the permission question with Enter / y / n / Esc, or answer in the terminal |
| Move an agent into a terminal | open its card, "move to terminal": a headless agent is resumed in a real terminal with the same session and model |
| See an agent's numbers | the strip above the office shows the selected agent's model, context used, cost and lines changed; the character card has a "claude code" section (session name, version, model, context, cost, prompt cache, limits); the status bar shows your 5-hour and 7-day limits |
| Update Claude Code in an agent | when a newer Claude Code is installed, the strip says "update ready: restart"; click it (or right-click, "Restart the process"). The session is resumed on the new version |
| Stop, restart, close | right-click the character or tab: interrupt (Ctrl+C), restart the process, close (ends the process; a Claude Code session stays on disk and can be resumed by id). When the program in a terminal exits you get your shell; when the shell exits, press Enter to start it again |
| Headless agent (optional) | tick "Headless" in the dialog: the conversation view replaces the terminal, approvals are buttons |
| Edit the files | "Edit with VS Code" in the ribbon, or on the card: the workspace's folder opens in VS Code in a new tab, through the same sign-in. The agent and you edit the same files on disk; VS Code reloads a file the agent changed, and Claude Code re-reads before it edits |
| Read the whole conversation | scroll up in the terminal (older entries load as you go) or open "History" from the ⋯ menu for a page with timestamps and tool results. Claude Code with `"tui": "fullscreen"` keeps its own view, so its scrollback cannot hold the transcript: the cell shows a "history · N entries" chip that opens the same page |
| Conversation view (phones) | a Claude Code terminal can be read as a **conversation** instead of a screen: its own transcript, wrapped to the device, with a prompt box, Shift+Tab, Esc and Enter / y / n / Esc buttons when it is blocked. It is the default under 800 px and one tap away otherwise ("conversation" / "terminal" in the tab row). The choice is **per device**: a phone reads the conversation while the desktop and the console keep the real terminal of the same session, and none of them touches the others |
| Copy and paste | drag across the text: releasing the mouse copies it (a small "copied" tag appears). This works in every workspace, including Claude Code's fullscreen view. Right-click for Copy, Paste and Select all; Ctrl+Shift+C copies, Ctrl+C copies while text is selected and interrupts otherwise, Ctrl+V pastes. Text Claude Code copies itself also reaches your clipboard |
| Scroll back | the mouse wheel. In a shell it scrolls the terminal's scrollback. Claude Code with `"tui": "fullscreen"` keeps its conversation inside its own view: the wheel scrolls that view ("Jump to bottom (ctrl+End)" takes you back), never your input history |
| Paste a screenshot | Ctrl+V or drop an image into the terminal or prompt box; it is uploaded to the server and its path typed into the prompt |
| Layouts | ribbon icons: office on the right or on top, attention panel, left bar, office; "⤢ focus" (Ctrl+Shift+F) gives the terminal the window; drag the bars to resize |
| Move a character | drag it anywhere; drop on a seat to use it, on a desk to assign that desk. Right-click for costume, prompt, stop, close |
| Second viewer | any number of browsers and consoles can watch and type in the same terminal. A pty has one size, so it **follows whoever is using it**: opening a workspace in the console takes its size (the console is the app in front of you), opening it in a browser tab changes nothing until you type there, typing anywhere takes the size (and that viewer's own resizes follow), and the others show that grid their own way, with a margin when they are bigger and, per device in Settings, by scrolling at the normal text size (default) or shrinking the text when they are smaller. Typing in the console makes it the console's size; typing in the browser takes it back. "pin size" on the character card fixes a size instead |
| Log, notifications, sessions, theme | activity bar icons and Settings |

Status colours: amber working, red blocked, green done, grey idle, hollow no agent.

### From a terminal: the `agent-master` console

The same workspaces are available from any shell on the machine, locally or over SSH, with a
console: a sidebar with the workspaces ("spaces") and the agents with their
status, a tab strip, and the live terminal of the selected workspace. The web UI and the console
show the same terminals at the same time; typing in either goes to the same process.

```sh
agent-master                      # open the console
agent-master attach demo       # open it on one workspace (label, number, id or a unique prefix)
agent-master list                 # table: name, what runs, status, for how long, viewers, folder, last prompt
agent-master new ~/project        # start Claude Code there and open it (--shell, --cmd "htop", --model, --label, --resume ID)
agent-master send demo "run the tests"   # type a prompt and press Enter, without opening anything
agent-master close demo        # end the process in it (asks first; -y to skip)
agent-master attach demo --plain   # no console: this terminal becomes that terminal, Ctrl+] detaches
```

**On another computer** (your laptop), open the console on the server over SSH. Use `-t` so the
console gets a real terminal, and the full path, because a one-shot SSH command does not load the
`PATH` from your shell's login files:

```sh
ssh -t you@myhost.local '~/.local/bin/agent-master'                  # the console
ssh -t you@myhost.local '~/.local/bin/agent-master attach demo'   # straight to one workspace
```

Detach with Ctrl+B then q: the SSH session ends and every workspace keeps running on the server.
Your laptop's terminal needs 256 colours (every modern terminal has them), and a UTF-8 locale. If
you want to type just `agent-master` after `ssh`, add `export PATH="$HOME/.local/bin:$PATH"` to
`~/.zshenv` (zsh) or `~/.bashrc` (bash) on the server. The same works through the tunnel host or
VPN address you use for the web UI.

Console keys, with the prefix **Ctrl+B** (press Ctrl+B, release, then the key):

| Keys | Action |
|---|---|
| `w` or `g` | pick a workspace in the sidebar (arrows or j/k, Enter; Esc cancels) |
| `n` / `p` | next / previous workspace |
| `1` to `9` | jump to the workspace with that number (the number the sidebar, the tab row and `agent-master list` show) |
| `c` | new shell in the current workspace's folder |
| `N` | new workspace: Claude Code in a folder you type |
| `W` | rename the current workspace |
| `x` or `D` | close the current workspace (asks y/N) |
| `R` | restart the process in the current workspace |
| `b` | show or hide the sidebar |
| `[` | scroll back (arrows, PgUp/PgDn, g/G; q leaves); the mouse wheel works too |
| `h` / `l` | pan sideways through a pinned terminal that is wider than the pane (it opens on the cursor's side) |
| `?` | all keys |
| `q` or `d` | detach: the console closes, every workspace keeps running |
| `Ctrl+B` | send Ctrl+B itself to the program |

The tab strip shows the selected workspace's status and Claude Code's numbers (model, context,
cost) and says "update ready: ctrl+b R" when a newer Claude Code is installed; the sidebar shows
your usage limits above the «.

The mouse wheel scrolls back: through the console's own copy of the output, or, when the program in the
pane uses the mouse (Claude Code's fullscreen view), the wheel and clicks are passed to the program
so it scrolls its own history.

Everything else you type goes straight to the selected terminal, so Claude Code's own keys (Enter,
Esc, Shift+Tab, arrows in permission prompts) work as usual. Click a workspace in the sidebar to
switch to it. To select text with the mouse, hold Shift while dragging (the console uses the mouse
for clicks and the wheel).

The size of a terminal follows whoever types or opened it last: the console resizes the terminal to
its pane, and a browser that types into it afterwards resizes it back. Claude Code repaints on every
size change, so both always show a correct screen.
