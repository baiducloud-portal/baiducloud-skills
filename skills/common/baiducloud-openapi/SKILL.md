---
name: baiducloud-openapi
description: Use the tested Baidu Cloud OpenAPI runtime for products that are not supported by the installed bce-cli, have no applicable official execution tool, and provide official OpenAPI documentation. Trigger for CFC, 函数计算, Cloud Function Compute, function invocation, function versions or aliases, CFC triggers, XFLOW workflows, or any other documented OpenAPI-only service, including request signing, AK/SK or STS authentication, HTTPS calls, pagination, and API errors. Do not use this Skill for services supported by bce-cli, and never execute state-changing requests without explicit confirmation.
---

# BaiduCloud OpenAPI

Use this Skill only for a product that is not supported by the installed
official `bce-cli` and has no applicable official execution tool for the
requested operation. This includes products with official tools that do not
cover the requested operation, such as a product SDK or BSAM, but never a
product exposed by `bce-cli`. Products supported by `bce-cli` must continue to
use `baiducloud-cli`.

The bundled `scripts/openapi_runtime.mjs` is the only request execution path for
this Skill. It provides tested BCE v1 signing, credential loading, HTTPS
transport, response limits, and secret redaction. Do not reimplement these
functions in a product Skill or construct an Authorization header manually.

## Resolve the API first

Before executing a request:

1. Identify the product's official API documentation, API version, method,
   endpoint, URI, query parameters, headers, and JSON body.
2. Confirm that the product is not available from `bce --help` and
   `bce <service> --help`.
3. Use a Baidu Cloud endpoint over HTTPS. The runtime rejects non-Baidu hosts,
   URL user information, non-standard ports, redirects, and private/reserved
   addresses.
4. Sign in with `bce auth login` first. The runtime uses the fixed `oauth`
   profile's temporary credentials; never place credentials in URLs, request
   bodies, command arguments, logs, or chat messages.

## Product references

For CFC function management, invocation, versions, aliases, triggers, reserved
concurrency, or XFLOW workflows, read `references/cfc.md` before constructing
the request. The product reference provides endpoint selection and safety
rules; verify the exact method, URI, and schema against the linked API page
before every request.

## Credential sources

## Credential source

The runtime authenticates only through the official `bce-cli` IAM OAuth login.
It always uses the fixed `oauth` profile (`"mode": "OAuth"`) in
`~/.bce/config.json`, or a test-specific path passed with `--config-file`.

- If `bce` is not installed, the runtime stops and asks the user to install
  `bce-cli` first.
- If the `oauth` profile does not exist, the runtime stops and asks the user to
  run `bce auth login`.

Authentication readiness (bce installed, `oauth` profile present, credentials
not expired) is owned by `baiducloud-auth`. Route login and authentication
troubleshooting there; this runtime only enforces the same preconditions at
execution time so it stays self-contained when installed on its own.

For the `oauth` profile the runtime reads the temporary STS credentials that
`bce-cli` stored in `~/.bce/oauth/oauth.json` and signs the request with them.
If those temporary credentials are expired, the runtime asks `bce-cli` to renew
them (`bce auth refresh`) and re-reads the state; if renewal does not produce
valid credentials, it reports that the user must run `bce auth login` again.
The runtime never reads or writes OAuth tokens itself and does not perform the
OAuth flow.

## Safe execution

Use `--dry-run` first. GET and HEAD are read-only. POST, PUT, PATCH, and DELETE
require `--confirm` for each request. Do not add a confirmation flag on behalf
of the user.

Example:

```bash
node scripts/openapi_runtime.mjs GET \
  https://example.baidubce.com/v1/resource \
  --dry-run
```

The example host is illustrative; use the endpoint documented for the target
product and verify it is allowed by the runtime.

The runtime refuses caller-supplied runtime-managed headers (`Authorization`,
security-token, `Host`, and `x-bce-date`), credentials or signatures in query
parameters, redirects, non-HTTPS URLs, unapproved hosts, and state-changing
requests without confirmation. Dry-run reports skip DNS validation; real
requests perform it immediately before transport. URL fragments are rejected.
Use `%20` for spaces in query values; a literal `+` is sent as `%2B`.
It does not silently retry non-idempotent requests.

For a large or sensitive JSON payload, use `--body-file` instead of `--body`.
The two options are mutually exclusive. File-backed bodies are represented by
length and SHA-256 only in diagnostic output. Inline bodies larger than 1 MiB
are also summarized automatically instead of being rendered in diagnostics.
The runtime enforces `--max-request` and automatically generates the signed
`x-bce-content-sha256` header for POST and PUT requests.

## Error handling

Show only redacted errors and response data. Preserve a non-secret request ID
when the service provides one. For signature or permission failures, verify
the profile, region, endpoint, clock, API version, and documented required
headers. Do not print the Authorization value or the contents of the profile.

If the endpoint, signature rules, or product API cannot be verified from
official documentation, stop and ask for the missing official reference
instead of guessing.
