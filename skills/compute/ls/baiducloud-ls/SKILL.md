---
name: baiducloud-ls
description: >
  Manage Baidu Intelligent Cloud LS lightweight application servers together with their
  custom images and snapshots. Use this Skill when a user needs to:
  (1) query LS instance lists, details, specs, available images, quota, orders, or system volumes;
  (2) create an LS instance, or start, stop, rebuild, rename, reset the password of, or tag an instance;
  (3) renew or resize (upgrade) an LS spec;
  (4) obtain a VNC login URL or remote-connection token, or explain command-line login;
  (5) publish a custom image from an instance, or query or delete custom images;
  (6) create snapshots, roll back a snapshot, or query or batch-delete snapshots.
  Trigger keywords: LS, lightweight application server, lightweight server, VNC login, remote
  connection, custom image, image publishing, snapshot rollback, reinstall system, renew, resize.
---

# BaiduCloud LS Lightweight Application Server

LS uses the portal-facing OpenAPI (`/openapi/portal/ls/**`, `/openapi/portal/image/**`,
`/openapi/portal/snapshot/**`) and is **not covered by the official `bce-cli`**, so this
Skill's scripts sign HTTP requests with BCE auth v1 on their own. Products already covered
by `bce-cli`, such as BCC, use `baiducloud-cli`.

## Scope and server-type confirmation

**This Skill's instance, image, snapshot, renew, and resize interfaces apply only to LS
lightweight application servers**, and cannot be used for BCC or other server types. Before
starting, determine which type of server the user means:

- If the user only says "server", "instance", "machine", "image", "snapshot", "renew", etc.
  without specifying a type → first check whether the current environment **has any other
  server-class Skill** (for example `baiducloud-cli` can operate BCC):
  - If yes → **you must first ask whether they mean an LS lightweight application server or
    a BCC / other cloud server**; do not default to LS.
  - If not, and LS is the only operable server → **do not ask for the type**, just proceed
    with LS and confirm the region and required fields per the rules below.
- If the user explicitly says LS / lightweight application server / lightweight server, or the
  current conversation is already scoped to LS resources → use this Skill directly.
- If the user explicitly says BCC or another product covered by `bce-cli` → hand it to
  `baiducloud-cli`; do not substitute this Skill's interfaces.
- Scenario-based requests (such as "spin up a machine to run a service" or "rebuild the whole
  environment") must also land on **one server type**: once LS is chosen, run every query,
  create, image, snapshot, and login step through LS interfaces; do not use LS interfaces for
  half and BCC CLI for the other half.
- **When two server types interact or work together (for example using a BCC image/snapshot on
  LS, orchestrating both types together, or migrating from BCC to LS), confirm with the user
  first**: what to do on each type, which Skill each uses, and which steps need manual bridging.
  Do not assume resources on both sides are directly reusable. When the user's request needs a
  server other than LS and there is no corresponding Skill in the environment, state plainly that
  this Skill only covers the LS part.
- LS and BCC are different resource domains: do not pass an id queried from `bce-cli` directly
  into this Skill, or vice versa. Always confirm a cross-product id exists via the target
  product's own query interface first.

## Preconditions

| Item | Resolution order | Behavior when missing |
| --- | --- | --- |
| Domain | `--endpoint` > `BCE_LS_ENDPOINT` | Error out directly, **never use any built-in default domain** |
| Credentials | `BCE_ACCESS_KEY_ID`+`BCE_SECRET_ACCESS_KEY` (+ optional `BCE_SECURITY_TOKEN`) > the profile named by `--profile` or the current profile in `~/.bce/config.json` (AK mode takes ak/sk; OAuth mode uses STS temporary credentials from `bce auth login`, including sessionToken) | Error out and explain how to configure |
| region | `--region` > `BCE_REGION` > `bj` | Script falls back to `bj`, but **you must ask the user before any call**, see the region rules below |

- **The test and production environments use different domains.** When the user has not stated
  the target environment, ask proactively; do not assume on their behalf.
- **Never disclose the endpoint domain to the user.** When asking about or restating the
  environment, say only "test environment" or "production environment"; do not write out the
  domain, host, or a full URL, and do not paste the `url` from `--dry-run` verbatim to the user.
  When you need to show request content, list only the region and business parameters.
- region supports only `bj` `gz` `su` `hkg` `bd`; other regions are returned as unsupported.
- **Passing AK/SK on the command line is not supported.** When credentials are incomplete, use
  `baiducloud-auth` to diagnose; do not rewrite the user's credential file.
- `region` is a query parameter and **participates in signature computation**.
- These interfaces **support `x-bce-*` headers**: the script sends and signs `x-bce-date`; when
  using STS temporary credentials it also adds `x-bce-security-token` and includes it in the
  signature. The signed headers are host + x-bce-date + every `content-*` / `x-bce-*` header on the
  request, so POST/PUT additionally sign `content-length` and `x-bce-content-sha256`. Long-term
  AK/SK or STS temporary credentials both work.

## Region-asking rules

**You must confirm the region before any interface call; never decide for the user by using the
default `bj`.**

- When the user has not stated a region, list the five options for them to choose from:
  `bj` Beijing, `gz` Guangzhou, `su` Suzhou, `hkg` Hong Kong, `bd` Baoding.
- **Multiple selection is allowed.** When the user picks several (or says "all regions" / "every
  region"), run the command once per region (`--region <region>`) and present results grouped by
  region; do not mix resources from different regions into one table.
- Only reuse a region directly when the user has already stated it in this conversation; still
  restate it before a cross-resource operation.
- Confirmation messages for write and billing operations must include the region, to avoid
  executing in the wrong region.
- LS resources are region-scoped: not finding an instance in `bj` does not mean it does not exist;
  first confirm the user's intended region is fully covered.

## Field-asking strategy

This is the most important behavioral convention of this Skill. Parameters fall into three classes:

**1. Required fields the user did not provide → you must ask; never fabricate.**
The script intercepts before sending the request and reports the missing fields and their value
sources, for example:

```
Error: create is missing required parameters; obtain the values first and retry:
  --spec (spec/package)
    Value source: run list-specs first to query available specs and present them for selection
  --image-id (image id)
    Value source: run list-images first to query available images; only when the user explicitly
    wants a custom image, use list-custom-images instead
```

**2. Required fields that have a source interface → query the source first, present the candidates
for selection, then ask.**
Do not directly ask "please provide the spec name", which the user cannot answer. The correct
approach is to query first, then let the user pick. Which interface to query first for each
required field, and which fields to show the user, are in
[the "Required fields and source interfaces" section of api_reference.md](references/api_reference.md);
the id forms for images/instances/snapshots are in the same file's "Short id vs uuid" section.

**3. Optional fields → do not ask.** Fill them if the user provides a value; otherwise use the
documented default. The script already writes each optional field's default into the request body,
**because the interface still requires these keys to exist** (for example, when `create` is given
only `--spec` and `--image-id`, keys like `instanceName`, `purchaseCount`, `adminPass`, and
`billing` are still sent with default values). Each field's default is in
[references/api_reference.md](references/api_reference.md).

**4. Fixed-value fields are filled by the script; never ask the user**: `serviceType=LS` (renew),
`key=ls` (order-detail), `serviceFor=LS` and `visitorService=LS` (list-custom-images), and
`objType=ls` (quota, changeable via `--obj-type`).

Use `--dry-run` to confirm whether the default values in the final body match expectations; it does
not require credentials.

## Capability list

All commands share the prefix: `node <skill_path>/scripts/ls.mjs`. The numbers below match the
section numbers in [references/api_reference.md](references/api_reference.md), where each
subcommand's full parameters, optional-field defaults, and response fields live.

**Read-only operations** (11, run directly): `list`, `describe`, `list-specs`, `list-images`,
`list-custom-images`, `list-snapshots`, `list-system-volumes`, `quota`, `order-detail`,
`vnc`, `remote-auth`.

**Write operations** (14, **all require `--confirm`**): `create`, `renew`, `resize`, `rebuild`,
`rollback-snapshot`, `delete-image`, `delete-snapshots`, `stop`, `start`, `change-password`,
`rename`, `assign-tags`, `create-image`, `create-snapshot`.

Some of these write operations charge fees or lose data (irreversibly) and must follow the
"Execution order (dangerous and billing operations)" section below. Each subcommand's interface
number, required parameters, optional-field defaults, and response fields are in
[references/api_reference.md](references/api_reference.md).

**Common switches**: `--confirm`, `--dry-run`, `--region`, `--endpoint`, `--profile`,
`--config-file` (default `~/.bce/config.json`), `--timeout` (default 30 seconds).

## Key decision rules

**Short id or uuid** (the most common source of errors): `--ls-id` uses the short id (starts with
`i-`), `--instance-id` uses the uuid (only for renew / resize), image ids come in long and short
forms, and `--vm-snapshot` uses `instanceUuid:snapshotId(short id)`. The full comparison table is
in [the "Short id vs uuid" section of api_reference.md](references/api_reference.md). Check these
three counterintuitive cases carefully:

1. `rollback-snapshot` uses the **short id** for the instance, while `delete-snapshots` uses the
   **uuid**.
2. `delete-snapshots` uses the **short id** for the snapshot (the `snapshotId` field), **not** the
   uuid (the `id` field).
3. **`create` uses the long image id** (`id`), while **`rebuild` / `delete-image` use the short id**
   (`imageId`). Both ids for the same image come from the same record; do not mix them.

**Choosing a starting point** (to avoid needless calls):

- **Confirm the region first** (see the region-asking rules), then pick the starting interface.
- The user gave an **instance name** → `list`, then match by `name` in the returned `page.result`
  to get the `id`. This interface **has no keyword parameter**; you can only filter locally, and
  may need to paginate.
- The user gave a **short id and only wants status/config** → call `describe` directly, skipping
  `list`.
- The user gave a **short id but wants renew/resize** → `describe` first to get `instanceId` (uuid),
  then execute.
- To create an instance → run `list-specs` and `list-images` first, let the user pick one of each,
  then `create`.
- To only see the cost → go from the `orderId` in the `create` response or the `orderUuid` from
  `describe` to `order-detail`.

**Renewal duration limit**: `renew --duration` accepts only **1-120 months** (10 years max); the
script intercepts out-of-range values during argument parsing. When a user says "renew 15 years" or
"buy the max" that exceeds the limit, tell them the ceiling is 120 months and let them change it
within range; do not silently truncate to 120 and place the order.

**Execution order (dangerous and billing operations)**:

1. Generate a preview with `--dry-run`;
2. Show the user: environment (say only test/production, **no domain**), region, instance id and
   name, and the key parameters (target image / snapshot / spec / duration);
3. After explicit consent, drop `--dry-run`, keep `--confirm`, and execute;
4. A write operation only returns `success` / `status`, which **does not mean the resource is
   ready**; poll with `describe` or `list-*` to confirm.
5. When a billing operation returns an `orderId`, prompt the user to complete payment on the order
   page, see "Payment after creation" below.

Applies to `create`, `renew`, `resize`, `rebuild`, `rollback-snapshot`, `delete-image`, and
`delete-snapshots`. The last four lose data or are irreversible; skipping steps 1 and 2 is
forbidden.

**Payment after creation** (the step most easily missed for `create`):

`create` returning `success` / `status` / `orderId` / `lsIds` only means **the order was placed**;
the instance **is not yet created**. The order is in a pending-payment state (`status` is
`NEED_PURCHASE` in `order-detail`), and you must prompt the user to go to the order page to complete
payment:

```text
https://console.bce.baidu.com/billing/order/list
```

**The instance is created only after payment completes.** When wrapping up, do three things:

1. Clearly tell the user the `orderId` and `lsIds`;
2. Provide the order page link above and note "creation succeeds only after payment";
3. When you need to verify the amount or status, use `order-detail --order-id <orderId>`; when you
   need to confirm the instance is ready, use `list` or `describe`.

`renew` and `resize` likewise create pending-payment orders and are handled the same way.

**Login methods** (three; pick by the user's need):

| Need | Approach |
| --- | --- |
| Command line / SSH login | Use `list` or `describe` to get `eip`, **port 22**; tell the user in text, no other interface needed |
| Web VNC login | `vnc --ls-id`; the response `result` is the login page URL, **give it to the user verbatim as one piece**, directly openable |
| Need a connection token | `remote-auth`; each item in the response `result[]` contains `instanceId` and `token` |

The URL returned by `vnc` **must be relayed verbatim**: do not rewrite, truncate, or concatenate it,
and **do not replace the `token` or `password` inside it with placeholders like
`<your instance password>`**. The `password=yes` returned by the interface is the final value; copy
it as is, for example:

```text
http://1.1.1.1/vnc_auto.html?token=04722479-0cb8-44c9-83ac-367743d51d60&password=yes
```

Give the user a complete, directly clickable link; any link that requires the user to fill in a blank
is a wrong answer.

The URL returned by `vnc` embeds a token, and the `token` from `remote-auth` is equivalent to a
temporary login credential: provide them only in the current reply; do not write them to a file,
environment variable, or commit them to a repository.

**Password handling**:

| Scenario | Parameter | Format requirement |
| --- | --- | --- |
| Create instance | `create --admin-pass` | **Encrypted** per the LS-side convention, default `""` (not set) |
| Reset password | `change-password --password` | **Plaintext**; the server RSA-encrypts and forwards it uniformly |
| Remote-connection auth | `remote-auth --password` | The instance login password in plaintext |

Password rules (`adminPass` and `password` are the same): 10-20 characters, and must **contain all
of** uppercase letters, lowercase letters, digits, and special symbols (the symbol allowlist is in
[references/api_reference.md](references/api_reference.md)). When it does not comply, ask the user to
change it; do not generate one for the user and submit it directly. None of the three should be
echoed to the conversation or logs; the script output already redacts `password` / `adminPass` /
`secret` / `accessKey` / `authorization` / `signature`.

**Image selection and publishing**:

- To choose an image for create or reinstall, query `list-images` by default (2.18, public images +
  application images). **Only query `list-custom-images` (3.2) when the user explicitly says "use my
  own image / a custom image".**
- When showing images, include `name`, `osName`/`osVersion`, `appType`/`appVersion`, and check
  whether `minDiskGb` / `minMem` is satisfied by the target spec.
- **Show the id that matches the target operation**: when choosing an image for `create`, show and
  fill back the **long id** (`id`, a uuid); when choosing one for `rebuild` or `delete-image`, show
  and fill back the **short id** (`imageId`, starts with `m-`). Do not dump both ids on the user, and
  do not use a short id to create.
- `create-image` does not return an image id: after publishing, query `list-custom-images` and wait
  until `status` is available (such as `Available`) before using it for `create` or `rebuild`. Using
  an image that is still being built will fail.

**Snapshot flow**: `create-snapshot` likewise does not return an id; query `list-snapshots`. Roll back
with `snapshotId` (short id) + the instance short id; delete with `instanceUuid` + `snapshotId`
(short id).

**Tag semantics**: `assign-tags` is a **full overwrite**. To append to existing tags, first
`describe` to read the current `tags` and pass them together; omitting `--tag` unbinds all tags.

## Common commands

```bash
# Environment setup (swap the domain for test/production; the domain is configured locally only, not shown to the user)
export BCE_LS_ENDPOINT="<portal-openapi-host>"
export BCE_ACCESS_KEY_ID="<ak>" BCE_SECRET_ACCESS_KEY="<sk>"

# Queries (confirm the region with the user first; for multiple regions run once per region)
node scripts/ls.mjs list --region bj --page-size 20 --order-by expireTime --order desc
node scripts/ls.mjs describe --ls-id i-rm4VpVWH --region bj
node scripts/ls.mjs list-specs --region bj
node scripts/ls.mjs list-images --region bj

# Billing and dangerous operations: --dry-run and restate first, then after user confirmation drop --dry-run, keep --confirm
node scripts/ls.mjs create --region bj --spec ls.s1.c1m1d40b3 \
  --image-id a2de5608-6aa1-4cf7-bcf1-cae966cd16c9 --confirm --dry-run
node scripts/ls.mjs rebuild --region bj --ls-id i-rm4VpVWH --image-id m-hZjv3yY8 --confirm --dry-run
node scripts/ls.mjs delete-snapshots --region bj \
  --vm-snapshot 9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d:s-fBxbcXcA --confirm --dry-run

# Ordinary write operations
node scripts/ls.mjs stop --region bj --ls-id i-rm4VpVWH --confirm
node scripts/ls.mjs create-snapshot --region bj --ls-id i-rm4VpVWH --name snap-20260831 --confirm
```

Examples for the remaining subcommands are on the "Script command" line of each section in
[references/api_reference.md](references/api_reference.md); when unsure about a parameter, check there
first, or run `node scripts/ls.mjs <subcommand> --help`.

## Result presentation

- **No answer should contain the endpoint domain, host, or a full request URL**; refer to the
  environment only as "test environment" / "production environment"; for multi-region queries, group
  by region and label which region each group belongs to.
- Take list results from `page.result` and show `id` (short id), `name`, `status`, `spec`, `eip`,
  and `expireTime`; for renew/resize, additionally retain `instanceId` (uuid).
- Show image results with the id matching the target operation: `create` uses the long id (`id`),
  `rebuild` / `delete-image` use the short id (`imageId`).
- **Exception**: the data for `list-specs` is in `result.result` and does not return a pagination count.
- When `totalCount` is greater than the current `pageSize`, tell the user they can paginate (`--page-no`).
- The `result` of `vnc` is a string URL, **given verbatim and complete, with no placeholders**; the
  responses of `quota` and `list-system-volumes` are passed through by the backend, **show them as
  actually returned; do not assume field names**, and state when a field is not returned.
- For SSH login, give `eip` + **port 22**.
- A write operation only returns `success` / `status`; do not fabricate "done" details; when you need
  the status, query again.
- When `create` / `renew` / `resize` returns an `orderId`, you must also give the order page link and
  explain that payment is required first; do not reply "created successfully" directly.

## Error handling

**When the response body contains a `code`, first check
[the "Error codes and troubleshooting" section of api_reference.md](references/api_reference.md)**,
give the user the Chinese-language prompt there, and take the corresponding troubleshooting action;
`ServiceInternalError` must be characterized by also reading `message`. When there is no `code`, or
the `code` is not listed, fall back to the HTTP status codes in the table below.

| Symptom | Troubleshooting order |
| --- | --- |
| Script reports "missing required parameter" | Query the source interface named by the prompt first and present the candidates for the user to choose; do not fabricate |
| Script reports a parameter out of range (such as renewal duration or purchase count) | Tell the user the allowed range (`--duration` 1-120 months, `--purchase-count` 1-50 units) and let them change it; do not truncate yourself |
| HTTP 403 `SignatureDoesNotMatch` | 1) Are the AK/SK correct and not expired; 2) Does the region participate in the signature and is its value valid; 3) Does the account have LS permission. Check with `baiducloud-auth` |
| HTTP 404 | 1) Is the endpoint the wrong environment (test vs production); 2) Is the id type wrong (short id vs uuid); 3) Is the region wrong; 4) Has the resource been deleted |
| HTTP 400 | Check the required fields and optional-field defaults; note that `vmSnapsots` keeps the backend spelling, **do not correct it** |
| Network error | Confirm `BCE_LS_ENDPOINT` is reachable and the current network can access that environment |
| Response is not valid JSON | Usually the domain points at a non-OpenAPI service (such as a console page); check the endpoint |

Troubleshooting the endpoint is a local configuration issue: **when describing it to the user, say
only "the current environment configuration may be wrong (test/production)"; do not paste the domain**.
For region-related errors, confirm the user's intended region first, rather than switching to another
region and retrying on your own.

## Reference documentation

- The full parameters, required fields and defaults, source interfaces, response fields, and command
  examples for all 25 interfaces, as well as the user-facing prompt wording, troubleshooting actions,
  and HTTP status-code fallbacks for business error codes (`OperationDenied`,
  `Instance.PermissionDeny`, `Instance.NameInvalid`, `ServiceInternalError`, etc.):
  [references/api_reference.md](references/api_reference.md)
