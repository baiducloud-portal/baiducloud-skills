---
name: baiducloud-auth
description: Use the official bce-cli IAM OAuth browser login for Baidu Intelligent Cloud authentication. Use when a user needs to sign in, configure an OAuth profile, log in from a headless environment, or troubleshoot OAuth login.
---

# BaiduCloud authentication

Use the official `bce` CLI for IAM OAuth. The core subcommands are:

```bash
# Sign in via the system browser (open the printed URL manually if needed).
bce auth login
bce auth login --profile dev        # sign in to a named profile
bce auth login --region bj          # sign in and set the default region
bce auth login --no-browser         # SSH, container, or other headless env
bce auth login --callback-timeout 600  # browser callback timeout, seconds

bce auth status                     # show login and credential status
bce auth logout                     # clear the oauth login state
bce auth refresh                    # renew temporary credentials
```

For the exact flag set of any subcommand, consult `bce auth <subcommand>
--help` rather than assuming it here.

Credentials are written to the profile selected with `--profile` (the current
profile when omitted); profile names are not fixed. An existing AK/SK profile is
not modified. A successful login switches the current profile to the OAuth
profile; use `bce configure use <name>` to switch back. `--callback-timeout`
changes the browser callback timeout; the default is 300 seconds.

The CLI owns OAuth token storage, temporary credential exchange, and renewal.
Never implement a second OAuth flow, collect passwords or MFA data, or request
OAuth tokens in chat. Never print, copy, or echo the contents of the local
OAuth state file or the tokens inside it; the read-only checker below may read
it only to derive login status.
For OAuth status or logout, continue using the corresponding official
`bce auth` subcommands.

This Skill is the single place to verify authentication readiness. The
read-only checker reports whether `bce` is installed, which OAuth profile is
selected (`--profile`, `BCE_PROFILE`, else the current profile reported by
`bce auth status`), whether that profile exists, and whether its temporary
credentials have expired:

```bash
node scripts/check_auth.mjs
node scripts/check_auth.mjs --profile dev
```

Other Skills (for example `baiducloud-cli` and `baiducloud-openapi`) route
authentication and login troubleshooting here instead of implementing their own
checks. See Troubleshooting below to resolve a missing CLI or a missing or
expired OAuth profile.

## Troubleshooting authentication

Start by reading the current state with `node scripts/check_auth.mjs`, then act
on what it reports:

- `bce` not installed → install `bce-cli` first.
- selected profile missing or not logged in → run `bce auth login` (add
  `--profile <name>` for a named profile). If the user is logged in but the
  current profile was switched to another one, pass `--profile <name>` to the
  checker and scripts instead of logging in again.
- credentials expired → run `bce auth login` again. The CLI renews temporary
  credentials automatically (`bce auth refresh`); if renewal does not produce
  valid credentials, sign in again.
- browser callback times out → raise `--callback-timeout`, or switch to
  `bce auth login --no-browser`.
- SSH, container, or other headless environment → use
  `bce auth login --no-browser` and open the printed URL on a machine with a
  browser.

## Sync the login to Qianfan

The official `qianfan` CLI can adopt a `bce` OAuth login through its internal
credential-login command. `scripts/sync_qianfan.mjs` is the only supported
bridge: it reads the STS credentials and `id_token` written by `bce auth` and
passes them to `qianfan` over stdin. It never prints credentials, and nothing
goes into argv, environment variables, or temporary files.

```bash
node scripts/sync_qianfan.mjs sync --dry-run   # validate only; reads qianfan status, no login call
node scripts/sync_qianfan.mjs sync             # login, or refresh-login if already logged in
node scripts/sync_qianfan.mjs sync --profile dev  # sync a named bce profile instead of the current one
node scripts/sync_qianfan.mjs check            # gate: same account in bce and qianfan? auto-syncs if qianfan is logged out
node scripts/sync_qianfan.mjs logout           # qianfan auth internal logout
```

`check` is the gate that must pass before any `qianfan` command (see the
`baiducloud-qianfan` Skill). It works even when the bce STS credentials have
expired. Results:

- `match` or `skipped` (bce not logged in via oauth) exit 0. `skipped` also
  happens when the current bce profile is not an OAuth profile (for example an
  AK/SK profile), because there is no `id_token` to compare; pass
  `--profile <name>` to check a specific OAuth profile.
- Qianfan not logged in while bce is: `check` runs `sync` (login) automatically,
  with no confirmation, and reports `auto_synced: true`. Pass `--no-auto-sync` to
  keep `check` strictly read-only. If the bce credentials are expired or within
  2 minutes of expiry, the sync first renews them with `bce auth refresh`
  automatically (see below).
- `mismatch` exits 4 and must stop the task.

Direct use of the `qianfan-*` Skills bundled with the qianfan CLI bypasses
`baiducloud-qianfan`, so it skips this gate. To cover those entry points too,
install `references/qianfan-gate-rule.md` as an always-apply rule in the host
Agent (see the install guide, step 2.2) by running `node scripts/install_rule.mjs`
from this Skill's directory. It writes the rule to every detected host (Comate,
Claude Code, Codex) without asking for confirmation and is idempotent; use
`--project <dir>` for the Cursor project rule, `--host` to pick hosts, `--dry-run`
to preview, `--uninstall` to remove. It is a soft convention, not a hard block.

Add `--debug` (or set `SYNC_QIANFAN_DEBUG=1`) to print step-by-step diagnostics
to stderr. Debug lines show paths, field presence, timestamps, the qianfan
commands run with their arguments, a masked view of the stdin payload (AccessKey
masked, other secrets shown only by length), the `id_token` header (`alg`, `kid`)
and non-secret claims (`iss`, `aud`, `iat`, `exp`), and exit codes. Credential
values are never logged.

Workflow:

- After a successful `bce auth login` or `bce auth refresh`, run `sync` right
  away without asking (login, or refresh-login if Qianfan is already logged in),
  then tell the user it was synced. The built-in account check still protects
  against a different Qianfan account: on `ACCOUNT_MISMATCH` (exit 4) stop and
  follow the logout guidance below. Use `--dry-run` only for diagnosis.
- Likewise, when Qianfan is not logged in, `check` syncs the bce login
  automatically without asking.
- After `bce auth logout`, ask whether to also run `logout` for Qianfan. Do not
  log Qianfan out on the user's behalf.
- Auto-refresh: when the bce STS credentials are expired or within 2 minutes of
  expiry, `sync` first runs `bce auth refresh` itself, re-reads the renewed
  credentials, and reports `bce_refreshed: true`. No confirmation is needed. If
  the refresh fails (for example the bce refresh token expired), it stops before
  touching Qianfan and asks the user to run `bce auth login`. Pass
  `--no-auto-refresh` to disable this; `--dry-run` only reports
  `bce_refresh_needed` and never runs `bce`.
- Qianfan holds no refresh token for a synced login, so it cannot renew itself.
  It treats the login as expired 2 minutes before the STS expiration. `check`
  reads `login_expires_at` from `qianfan auth status` and, once the login is
  expired or within 2 minutes of it (and the account matches), renews it from bce
  automatically (`auto_synced: true`, with `bce_refreshed: true` if bce had to be
  refreshed first). If a `qianfan` command still reports "登录已过期" /
  `login expired` / `CREDENTIAL_NOT_FOUND` mid-task, run `sync` without asking and
  retry the failed command once. `--no-auto-sync` turns the proactive renewal off.
- Exit code 3 (`AGREEMENT_NOT_SIGNED`) means the login was saved but the account
  has not signed the Qianfan agreement. Show the user the printed URL; no
  re-login is needed after signing.
- Before every `sync` (and in `check`), the script runs `qianfan auth status --format json` and
  compares qianfan's account with the `principal_id` of the bce `id_token`. If
  they differ it stops with `ACCOUNT_MISMATCH` and exit code 4 (account ids shown
  masked) before any login call. Tell the user to log out first (`node scripts/sync_qianfan.mjs
  logout` for Qianfan, `bce auth logout` for bce), then run `bce auth login` as
  the intended account and sync again. Never log out on the user's behalf.
- `AUTH_FAILED` on refresh can also mean `id_token` verification failed on the
  Qianfan side (for example an unknown signing key `kid`); run with `--debug` to
  see the token header and issuer before suspecting the account.
- `QIANFAN_CLI_BIN` overrides the `qianfan` executable path. If it is missing or
  too old to support the internal command, follow the `baiducloud-qianfan`
  Skill to install or upgrade the official CLI.

## Authentication vs authorization

The steps above only fix *authentication* (who you are). They do not fix
*authorization* (what you may do). Permission-denied, IP-allowlist, or policy
errors (for example `AccessDenied`) are not solved by signing in again, so do
not loop on `bce auth login`. Preserve only the non-secret error message and
request ID and escalate to the cloud account administrator or support to adjust
the account's IAM policy or allowlist.
