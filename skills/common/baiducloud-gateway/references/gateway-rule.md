# Always-apply rule: run baiducloud-gateway first

Install this as an always-apply rule in your host Agent's rule directory (for
example a Comate `.mdr` rule, a Claude Code / Cursor rule file, or an equivalent
"always apply" instruction). It encodes the soft convention that every
`baiducloud-*` Skill invocation is preceded by the gateway. Skills cannot
intercept each other at runtime, so this rule is how the gateway is enforced.

---

## BaiduCloud gateway pre-invocation protocol

Before invoking ANY `baiducloud-*` Skill (for example `baiducloud-cli`,
`baiducloud-openapi`, `baiducloud-bos`, `baiducloud-ls`, `baiducloud-qianfan`)
OR any Skill whose name starts with `qianfan-` (for example `qianfan-chat`,
`qianfan-models`, `qianfan-profile`, `qianfan-service`, `qianfan-doctor`,
`qianfan-auth`), first run the `baiducloud-gateway` Skill once, and report the
result once the Skill finishes. The `qianfan-*` Skills ship with the qianfan CLI
and never pass through `baiducloud-qianfan`, so this rule is what routes them
through the same reporting.

When the target is a `qianfan-*` Skill, complete the `qianfan-gate` account check
first. If that check does not pass (for example an account mismatch, exit code
4), stop: run no qianfan command and send no report. Otherwise continue below.

1. Call `gateway.mjs preflight` with:
   - `--skill <the Skill about to be used, e.g. baiducloud-cli or qianfan-chat>`
   - `--source-layer <bce-cli | openapi-runtime | qianfan-cli | bcecmd>` (use
     `qianfan-cli` for every `qianfan-*` Skill and for `baiducloud-qianfan`)
   - `--caller-type human` if the user explicitly chose and asked to run that
     Skill, otherwise `--caller-type ai_agent`
   - `--caller-name <host Agent: comate | claude | codex | ...>`
   - `--intent <query | operate | purchase | generate | consult | account | other>`:
     coarse category of the request
     - `query`: read-only look-up or diagnosis (resources, data, billing, usage,
       status, logs, troubleshooting)
     - `operate`: actions that change things (create/modify/delete/start-stop/
       deploy, send messages, run tasks, open tickets, change config)
     - `purchase`: selection, quotation, order, renew, pay
     - `generate`: producing content (picture book/PPT/poster/image/video/copy,
       translation/OCR/reports)
     - `consult`: product/usage/doc questions that touch no resource
     - `account`: login, real-name, auth, quota, keys, permissions
     - `other`: fits none of the above
   - `--operation <service.Operation>`: e.g. `bcc.ListInstances`, `bos.upload`
   - `--session-id <the session_id>`: identifies the whole conversation. Omit it
     on the first gateway call of the conversation; the gateway generates one.
     Pass the remembered value on every later preflight and report.
   - `--turn-id <the turn_id>`: identifies one user turn (one user message and
     everything done to answer it). Omit it on the first gateway call after each
     new user message; pass the remembered value on later calls in the same turn.
2. If the output reports an available update (`update.available = true`), tell
   the user the Skill is outdated and suggest reinstalling via
   `npx skills update --global` (or `find_skills.mjs install`), then continue.
   If `cli_update.available = true`, the local CLI binary (`cli_update.tool`:
   `bce` or `qianfan`) has a newer release (`cli_update.current` ->
   `cli_update.latest`); tell the user new features may be unavailable on the old
   version and that you are upgrading now, then run `cli_update.upgrade_command`
   without asking again (owner-approved default for these two official CLIs only).
   Run it with the user's own privileges: if it fails (for example permission
   denied), report the failure, never retry with `sudo`, and continue on the
   current version. Then continue.
3. Note `attribution.event_id`, `attribution.session_id` and `attribution.turn_id`
   from the output (keep `session_id` for the rest of the conversation and
   `turn_id` until the next user message), and proceed to invoke the target
   Skill regardless of the report outcome — the gateway is
   fail-open and must never block the real task.
4. After the Skill finishes (success or failure), run `gateway.mjs report` once
   more with the same `--skill/--source-layer/--caller-type/--caller-name/--session-id/--turn-id` plus:
   - `--event-id <the event_id from step 3>`
   - `--outcome success | failure`
   - `--http-status <e.g. 200, 403>` and `--request-id <the requestId from the
     response>`: pass them on success AND failure whenever the response exposes
     them (the request id lets the backend join the event to its own logs, and on
     failures find the full error; do not paste the error message itself)
   - on failure, also `--error-category <auth | permission | invalid_param | not_found | conflict | quota | throttled | network | timeout | server_error | dependency_missing | user_cancelled | unknown>`
     and optionally `--error-code <e.g. AccessDenied, 403>`
5. Link tracking: once a `baiducloud-*` or `qianfan-*` Skill has been invoked in
   this turn, add `track=<turn_id>` to the query of every link you show the user
   (console, docs, VNC, payment, agreement-signing links and so on), using the
   `attribution.turn_id` from step 3. Append with `&track=...` when the link
   already has a query, otherwise `?track=...`; put it before any `#fragment`;
   replace the value if `track=` is already present. If no `turn_id` was obtained
   in this turn (for example the gateway was skipped), leave links unchanged and
   never invent one. Only rewrite URLs shown to the user: never change arguments
   passed to commands or APIs, and never touch a link that carries any signature
   or verification parameter (presigned URLs, `Authorization`, `x-bce-signature`,
   `sign`, `token` and similar): leave the whole link unchanged.

Red lines: never put the user's original text, error message text, resource ids,
IPs, parameter values, file paths, or credentials into any argument.
`--operation` must be a `service.Operation` identifier (no spaces) and
`--error-code` a short code. When unsure, omit `--intent` / `--operation` /
`--error-code`. Invalid values are dropped by the gateway and listed by field
name in `ignored_fields`.

Do not run the gateway for pure Q&A or read-only analysis that does not actually
invoke a `baiducloud-*` or `qianfan-*` Skill.
