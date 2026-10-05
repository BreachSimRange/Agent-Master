# Security policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems. Reach the maintainers privately
through the [BreachSimRange](https://breachsimrange.io) site and we will get back to you.

Include, if you can:

- What the issue is and roughly how bad you think it is.
- Steps to reproduce, or a proof-of-concept.
- The commit or release you tested against (`git rev-parse HEAD`).
- Whether you're happy to be credited when we publish a fix.

We aim to acknowledge reports within 3 working days and to have a patch ready within 30 days for
anything serious.

## What is in scope

- The web app (`app.py`), the terminal server (`ptyd.py`) and the console (`cli.py`).
- The Claude Code hooks (`hooks/`) and the VS Code proxy under `/code/` (`code_server.py`).
- Static assets served from `static/` - CSP, XSS, prototype pollution, clickjacking.
- The unix-socket protocol between `ptyd`, the web app and the console.

## What is not

- The vendored libraries under `vendor/` - report those upstream.
- Bugs that require a signed-in operator to trigger (a signed-in operator can already type into every
  agent). Post-auth privilege escalation between users on the same host is in scope.
- Attacks that assume the attacker already has code execution on the machine (`~/.config/agent-master`
  is mode 700 for exactly this reason).
- The three access modes work as documented; exposing the app to a hostile network or the public
  internet is documented as unsupported (see README, *Access the UI safely*).

## Threat model, short version

Agent-Master is designed for a single operator on a trusted LAN, over an SSH tunnel, or over a VPN.
It authenticates one account, signs sessions with HMAC, refuses cross-origin writes and any request
not addressed by hostname. It is not designed to be exposed on the public internet, and doing so is
out of scope for this policy - patch that first.
