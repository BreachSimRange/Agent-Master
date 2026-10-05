# Changelog

## 0.1.0 · 2026-09-30

First public version.

- Real terminals per workspace, owned by the `agent-masterd` daemon; sessions survive browser,
  web app and machine restarts and come back with `--resume`.
- The same terminal on every screen: browsers, phones and the `agent-master` console attach to one
  pty; the size follows whoever is using it.
- The whole history in the terminal: scroll up through this session and the folder's earlier
  sessions, page by page, read from Claude Code's transcripts; a page view and a conversation view.
- Pixel office: agents at desks and in the lounge, visits, lounge chatter; shells are eggs.
- VS Code in the browser through `code serve-web`, behind the app's sign-in.
- Security: signed sessions, per-address and global sign-in lockouts, setup token always required,
  origin checks, strict headers, home-folder limits; a documented access policy.
