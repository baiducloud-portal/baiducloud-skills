# Always-apply rule: check the Qianfan account before any qianfan command

Install this as an always-apply rule in your host Agent's rule directory (for
example a Comate `.mdr` rule, a Claude Code / Cursor rule file, or an equivalent
"always apply" instruction). The `qianfan-*` Skills bundled with the qianfan CLI
do not know about `bce-cli`, so using them directly skips the account check in
`baiducloud-qianfan`. This rule closes that gap: every Qianfan entry point goes
through the same gate.

It is a soft convention enforced by the host Agent, not a hard block.

---

## Qianfan account gate

Before running ANY `qianfan` CLI command, or using ANY Skill whose name starts
with `qianfan-` (for example `qianfan-chat`, `qianfan-models`, `qianfan-profile`,
`qianfan-service`, `qianfan-doctor`) or `baiducloud-qianfan`, first run the
`baiducloud-auth` account check once per task:

```bash
node <baiducloud-auth skill dir>/scripts/sync_qianfan.mjs check
```

Act on the result. Decide by the exit code; `auto_synced: true` only means the
local `bce auth login` was adopted automatically and can appear together with
exit 0 or exit 3.

- Exit 0 (`match`, `skipped`): continue with the qianfan command.
- Exit 0 with `auto_synced: true`: Qianfan was not logged in, so the local
  `bce auth login` was adopted automatically. Do not ask for confirmation; tell
  the user it happened, then continue.
- Exit 3 (`AGREEMENT_NOT_SIGNED`): the login was saved, but the user must open the
  printed URL and sign the Qianfan agreement. Continue once they have.
- Exit 4 (`ACCOUNT_MISMATCH`): STOP. Do not run any `qianfan` command. Tell the
  user the Qianfan and bce accounts differ (ids are masked), and ask them to log
  out first (`node <baiducloud-auth skill dir>/scripts/sync_qianfan.mjs logout`
  for Qianfan, `bce auth logout` for bce), then run `bce auth login` as the
  intended account. Never log out or switch accounts on the user's behalf.
- Expired or about-to-expire bce credentials: the script renews them itself with
  `bce auth refresh` before syncing (`bce_refreshed: true`); nothing to do. Only
  if that refresh fails (exit 1, hint to run `bce auth login`), ask the user to
  log in again, then run the check again.
- Any other failure: report it, and continue only if the user agrees.

If, while working, a `qianfan` command or any `qianfan-*` Skill reports that the
login expired (output contains "登录已过期", `login expired`, or the error code
`CREDENTIAL_NOT_FOUND`), do not ask: run `sync_qianfan.mjs sync` right away. It
renews the bce credentials with `bce auth refresh` when they are about to expire,
then renews the Qianfan login from bce. After it succeeds, retry the command that
failed exactly once; if it still fails, report that instead of retrying again.
Exit 4 from `sync` is handled as an account mismatch (see above). `check` also
does this proactively when it sees that the Qianfan login has expired.

Run the check again after any bce or Qianfan login, logout, or account switch.
After a successful `bce auth login` or `bce auth refresh`, run
`sync_qianfan.mjs sync` right away without asking.

Red lines: never print, copy, or log credentials, `id_token` values, or the
contents of `~/.bce/oauth` or `~/.qianfan`. Account ids appear masked in the
script output; keep them masked.

Do not run the check for pure Q&A that does not execute any `qianfan` command.
