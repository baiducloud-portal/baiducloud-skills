---
name: baiducloud-gateway
description: Pre-invocation gateway for all baiducloud-* and qianfan-* Skills. Run this BEFORE invoking any other baiducloud-* or qianfan-* Skill to check for Skill updates and emit a desensitized attribution report, then report the result once the Skill finishes. Use whenever a baiducloud-* or qianfan-* capability is about to be used.
---

# BaiduCloud Gateway

Run this Skill's `gateway.mjs` once, immediately before invoking any other
`baiducloud-*` or `qianfan-*` Skill, and once more after it finishes to report
the result. (The `qianfan-*` Skills ship with the qianfan CLI and never pass
through `baiducloud-qianfan`; for them use `--source-layer qianfan-cli` and run
the `qianfan-gate` account check first.) It does two things and never blocks the
real work (fail-open):

1. Update check: asks the generic Skills CLI whether the target Skill is
   outdated and, if so, reminds the user to reinstall.
2. Attribution report: sends one desensitized event to an independent remote
   endpoint. The request is signed with the local OAuth/STS credentials so the
   backend resolves the account id (`aid`) from the signature via IAM. The
   client never sends `aid` or any raw credential in the payload.

## Usage

```bash
# Before invoking e.g. baiducloud-cli: update check + invoke report.
# --intent / --operation describe WHAT is being done (enum / identifier only).
node scripts/gateway.mjs preflight \
  --skill baiducloud-cli --source-layer bce-cli \
  --caller-type ai_agent --caller-name comate \
  --intent query --operation bcc.ListInstances
# -> output contains attribution.event_id

# After the Skill finishes (success or failure): result report, joined by event_id
# success: carry the response's http status and request id when available
node scripts/gateway.mjs report \
  --skill baiducloud-cli --source-layer bce-cli \
  --event-id <attribution.event_id from preflight> \
  --outcome success --http-status 200 --request-id <requestId from the response>

# failure: add the category / code as well
node scripts/gateway.mjs report \
  --skill baiducloud-cli --source-layer bce-cli \
  --event-id <attribution.event_id from preflight> \
  --outcome failure --error-category permission --error-code AccessDenied \
  --http-status 403 --request-id <requestId from the error response>

# Report only / update check only
node scripts/gateway.mjs report --skill baiducloud-openapi --source-layer openapi-runtime
node scripts/gateway.mjs check-update --skill baiducloud-cli

# Inspect the signed request without sending it
node scripts/gateway.mjs report --skill baiducloud-cli --source-layer bce-cli --dry-run
```

## Reported fields

- `aid`: not sent by the client; resolved server-side via IAM from the signed
  request's STS token.
- `caller_type`: `human` when the user explicitly chose and invoked the Skill,
  otherwise `ai_agent` (default). Pass `--caller-type` or set
  `BAIDUCLOUD_SKILL_CALLER_TYPE`.
- `caller_name`: host Agent such as `claude`, `codex`, `comate`. Pass
  `--caller-name` or set `BAIDUCLOUD_SKILL_CALLER_NAME` (default `unknown`).
- `skill_name`: the Skill carrying the capability, e.g. `baiducloud-cli`.
- `source_layer`: execution layer — `bce-cli` / `openapi-runtime` /
  `qianfan-cli` (also `bcecmd`).
- `event_id`: auto-generated, format `baiducloud-skills-{uuid}`; joins the
  before-invocation and after-invocation reports.
- `event`, `intent`, `operation`, `outcome`, `error_category`, `error_code`,
  `http_status`, `request_id` (optional): power intent-distribution and
  failure-reason analysis. `http_status` (100-599) and `request_id` (the
  service-side request id) go on every result report, success or failure, so the
  backend can join the event to its own logs and, on failures, find the full
  error. `error_category` / `error_code` are failure-only. Enums or short
  identifier tokens only — **never the user's original text**, error messages,
  resource ids, IPs, or parameter values. Invalid values are dropped and listed
  by field name in `ignored_fields`.

These are structured in the JSON payload. The request `User-Agent` carries only
the product token (`BaiduCloudSkill/1.0`). See `references/attribution.md`.

## Safety and controls

- Reporting goes only to an https Baidu Cloud host (allowlisted, no bare IPs, no
  `user:pass@` userinfo); a bad endpoint is skipped, not forced. Before sending,
  the host is resolved and refused if it points at a private/reserved address.
- `BAIDUCLOUD_SKILLS_TELEMETRY_ENDPOINT` overrides the endpoint; the shipped
  default is `https://cloud.baidu.com/api/baiducloud_skill/behavior`.
- `BAIDUCLOUD_SKILL_REPORT_DISABLE=1` disables sending.
- `BAIDUCLOUD_SKILL_REPORT_DEV=1` (dev only) additionally allows an http(s)
  loopback endpoint (localhost / 127.0.0.0/8 / ::1) so you can post to the local
  `scripts/report_sink.mjs` for self-testing; it bypasses the DNS global-IP
  guard only for that loopback target. Off by default.
- Never reads, copies, or prints the OAuth credential file contents; credentials
  ride only in the standard signing headers.
- All failures (no login state, network error, missing Skills CLI) are
  fail-open and never block the downstream Skill.

To enforce "always run the gateway first", install the always-apply rule in
`references/gateway-rule.md` into your host Agent's rule directory.
