# Contributing to Agent-Master

Thanks for wanting to help. This is a small, opinionated project - a few rules keep it that way.

## Guidelines

- **No build step.** Vanilla JavaScript in `static/`, vendored dependencies in `vendor/`, plain Python
  with FastAPI. If you find yourself reaching for a bundler, transpiler, framework or package
  manager: don't.
- **Art is drawn in code.** Office scenes and the pixel characters are `static/office.js` /
  `static/app.js` - no sprite sheets, no asset pipeline.
- **Small, focused PRs.** One feature or one fix per PR. Bundle a refactor separately.
- **Match the existing style.** No trailing semicolons on lines that don't need them, no imported
  utility libraries, no wrapper abstractions with one call site.
- **Do not add telemetry, analytics or "phone home" behaviour** of any kind. Everything Agent-Master
  learns stays on the machine.

## Before opening a PR

Run these locally:

```sh
python3 -m py_compile *.py hooks/*.py          # Python syntax
node --check static/*.js                        # JavaScript syntax
sh -n run.sh make-cert.sh install.sh            # shell syntax
python3 tests/smoke.py                          # a throwaway server: sign-in rules, account setup, a terminal round trip
```

Test against a throw-away terminal server, never your live agents:

```sh
python3 ptyd.py --config-dir /tmp/amtest --socket /tmp/amtest.sock &
AGENT_MASTER_PTYD_SOCK=/tmp/amtest.sock ./cli.py new ~ --shell --no-attach
AGENT_MASTER_PTYD_SOCK=/tmp/amtest.sock python3 app.py --port 3019 --no-auth \
    --config /tmp/amtest/config.json
```

The separate terminal server socket keeps your real terminals out of the test instance, so nothing
you type in the test can hit a real session.

## Reporting bugs

Open a GitHub issue with:

1. What you were doing.
2. What you expected.
3. What actually happened (screenshots or a paste of the terminal help).
4. `python3 --version`, distro, and the output of `agent-master list`.

Not for security issues - see **SECURITY.md** for those.

## Contributor licence

By opening a pull request you agree that your contribution is released under the same MIT licence
as the rest of the project (see `LICENSE`).
