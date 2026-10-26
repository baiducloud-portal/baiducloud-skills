# Attribution report reference

The gateway sends one attribution event per Skill invocation to an independent
remote endpoint. The event is desensitized: it never contains credentials,
command arguments, file paths, or PII.

## Transport

- Method: `POST` JSON over HTTPS.
- Host: must match an allowed Baidu Cloud suffix (`baidubce.com`,
  `baidu-int.com`, `baidu.com`); bare IPs and URLs carrying userinfo
  (`user:pass@`) are rejected. A non-matching or non-https endpoint is skipped.
- Endpoint: `BAIDUCLOUD_SKILLS_TELEMETRY_ENDPOINT` overrides the default
  (`https://cloud.baidu.com/api/baiducloud_skill/behavior`).
- DNS guard: before sending, the host is resolved and the request is refused if
  it maps to a private/reserved address or does not resolve (fail-closed for the
  credential-bearing request).
- Signing: BCE auth v1, using the local `oauth` profile STS credentials from
  `~/.bce/oauth/oauth.json`. The `x-bce-security-token` header carries the STS
  session token; the backend resolves `aid` from the signature via the IAM SDK.
  If the STS token is expired or near expiry, the gateway runs `bce auth refresh`
  once and re-reads the state before signing; if it is still unusable, reporting
  is skipped (fail-open).

## User-Agent

Every report carries only the product token as its `User-Agent` request header
(it is not repeated in the payload):

```
BaiduCloudSkill/1.0
```

The attribution fields (`caller_type`, `caller_name`, `skill_name`,
`source_layer`, `event_id`, ...) are not repeated in the User-Agent; they live in
the JSON payload below.

## Payload schema

```json
{
  "caller_type": "ai_agent | human",
  "caller_name": "comate | claude | codex | ...",
  "skill_name": "baiducloud-cli",
  "source_layer": "bce-cli | openapi-runtime | qianfan-cli | bcecmd",
  "event_id": "baiducloud-skills-<uuid>",
  "reported_at": "<RFC3339 UTC>",
  "event": "invoke | result",
  "intent": "query | operate | purchase | generate | consult | account | other",
  "operation": "bcc.ListInstances",
  "outcome": "success | failure",
  "error_category": "auth | permission | invalid_param | not_found | conflict | quota | throttled | network | timeout | server_error | dependency_missing | user_cancelled | unknown",
  "error_code": "AccessDenied",
  "http_status": 403,
  "request_id": "3f1c9a52-8d4e-4b7a-9c61-0e2d5a7b8c10"
}
```

- `aid` is intentionally absent — it is derived server-side from the signed
  request, never sent by the client.
- `intent`, `operation`, `outcome`, `error_category`, `error_code` are optional
  and only present when supplied.

## Intent distribution and failure reasons

The report deliberately carries **no user original text**. Intent and failure
analysis rely on enums and short identifier tokens only:

- **Two events, one `event_id`.** `preflight`/`report` before the Skill runs sends
  `event=invoke` with `intent` and `operation`. After the Skill finishes, run
  `report --event-id <the preflight event_id> --outcome success|failure ...` to
  send `event=result`. The backend joins the two on `event_id` to get
  per-intent success rate and failure-reason breakdown.
- `intent`: coarse request category; an unknown value becomes `other` (the
  backend alerts on `other` so the vocabulary can be extended):
  - `query` — look up / diagnose, read-only and changes nothing: resources, data,
    billing, usage, status, logs, troubleshooting (`ListInstances`, billing,
    usage, view logs, doctor).
  - `operate` — execute actions that change things: create / modify / delete /
    start-stop / deploy resources, send messages, run tasks, open tickets,
    change config (`CreateInstance`, delete, deploy an endpoint, send a message,
    run a pipeline).
  - `purchase` — buy and transact: selection, quotation, order, add-on, renew,
    pay (marketplace order, OPC plan selection, renewal, payment link).
  - `generate` — content-producing work: picture book / PPT / poster / image /
    video / copywriting, plus translation / OCR / reports.
  - `consult` — product, usage and documentation questions that touch no
    resource (how a product works, doc search, explaining an error).
  - `account` — account and permissions: login, real-name, auth, quota, keys,
    permission management (login, real-name verification, check quota, create an
    AK, grant access).
  - `other` — anything that fits none of the above.
- `operation`: `<service>.<Operation>` identifier such as `bcc.ListInstances`,
  `bos.upload`, `qianfan.chat`. It must match `^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$`
  (no spaces); anything else is dropped. Never put the user's request, resource
  ids, IPs, or parameter values here.
- `outcome` + `error_category` + `error_code`: failures carry a category from
  the enum (default `unknown`) and an optional short code (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`,
  e.g. `AccessDenied`, `403`). Error messages are never reported. Error fields are
  ignored when `outcome` is `success`.
- `http_status` + `request_id` (every `result` event, success or failure): the
  HTTP status of the call (integer 100-599) and the service-side request id
  (opaque, `^[A-Za-z0-9][A-Za-z0-9-]{7,63}$`, typically the `requestId` in a BCE
  response). The request id lets the backend join the event to its own
  server-side logs — and, on failures, look up the full error detail — so the
  client never needs to send error message text. They are ignored on the
  pre-invocation `invoke` event (no `outcome` yet), and invalid values are
  dropped (field name listed in `ignored_fields`). `error_category` and
  `error_code` remain failure-only.
- Rejected inputs are listed by **field name only** in the command output as
  `ignored_fields`, never echoed.
- `caller_name`, `skill_name` and `event_id` are validated the same way
  (identifier token / `baiducloud-skills-<uuid>`); invalid values are dropped, so
  free text cannot reach the report.

## Field sources

- `caller_type`: `human` when the user explicitly selected and invoked the Skill,
  otherwise `ai_agent`. From `--caller-type` or `BAIDUCLOUD_SKILL_CALLER_TYPE`;
  invalid values fall back to `ai_agent`.
- `caller_name`: host Agent. From `--caller-name` or
  `BAIDUCLOUD_SKILL_CALLER_NAME`; default `unknown`.
- `skill_name`: from `--skill` or `BAIDUCLOUD_SKILL_SKILL_NAME`.
- `source_layer`: from `--source-layer` or `BAIDUCLOUD_SKILL_SOURCE_LAYER`.
- `event_id`: auto `baiducloud-skills-{uuid}` unless a valid `--event-id` is given.
- `intent` / `operation` / `outcome` / `error_category` / `error_code` /
  `http_status` / `request_id`: from the matching `--intent` / `--operation` /
  `--outcome` / `--error-category` / `--error-code` / `--http-status` /
  `--request-id` flags.

## Controls

- `BAIDUCLOUD_SKILL_REPORT_DISABLE=1`: assemble nothing, send nothing.
- `BAIDUCLOUD_SKILL_REPORT_TIMEOUT_MS`: max wait for the report POST (default
  2000). Reporting is best-effort; a slow/unreachable endpoint never blocks the
  downstream Skill for long.
- `BAIDUCLOUD_SKILL_REPORT_DEV=1`: dev-only opt-in that also accepts an http(s)
  loopback endpoint (localhost / 127.0.0.0/8 / ::1) and bypasses the DNS
  global-IP guard for that loopback target, so the gateway can post to a local
  `scripts/report_sink.mjs`. Off by default; never relaxes anything in normal
  (non-loopback) use.
- `--dry-run`: assemble and sign, print the request shape (header names only,
  no values) and payload, but do not send.
- All error paths are fail-open: a skipped or failed report never blocks the
  downstream Skill.
