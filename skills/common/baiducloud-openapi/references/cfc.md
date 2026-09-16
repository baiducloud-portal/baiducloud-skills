# CFC OpenAPI reference

Use this reference for Baidu Intelligent Cloud Function Compute (CFC) and its
XFLOW workflow APIs. CFC is not currently exposed by the official `bce-cli`,
so direct API requests may use the bundled OpenAPI runtime. Prefer an official
CFC or BSAM tool when a task is specifically covered by that tool.

## Official documentation

### Common API documentation

- [API overview](https://cloud.baidu.com/doc/CFC/s/jjwvz4eov)
- [General conventions](https://cloud.baidu.com/doc/CFC/s/Yjwvz43jg)
- [Service endpoints](https://cloud.baidu.com/doc/CFC/s/rjwvz4chn)
- [Common request and response headers](https://cloud.baidu.com/doc/CFC/s/ujwvz43vt)
- [Error responses](https://cloud.baidu.com/doc/CFC/s/Djwvz4cwc)
- [Function invocation](https://cloud.baidu.com/doc/CFC/s/vjwvz4e9n)

### Function operations

- [CreateFunction](https://cloud.baidu.com/doc/CFC/s/xjwvz450q)
- [ListFunctions](https://cloud.baidu.com/doc/CFC/s/Zjwvz46l3)
- [GetFunction](https://cloud.baidu.com/doc/CFC/s/Kjwvz45ri)
- [DeleteFunction](https://cloud.baidu.com/doc/CFC/s/fjwvz472b)
- [UpdateFunctionCode](https://cloud.baidu.com/doc/CFC/s/jjwvz45ex)
- [GetFunctionConfiguration](https://cloud.baidu.com/doc/CFC/s/9jwvz466u)
- [UpdateFunctionConfiguration](https://cloud.baidu.com/doc/CFC/s/2jwvz44ns)
- [Set reserved concurrency](https://cloud.baidu.com/doc/CFC/s/ok5dlgr72)
- [Delete reserved concurrency](https://cloud.baidu.com/doc/CFC/s/3k5dlqspp)

### Version operations

- [ListVersionsByFunction](https://cloud.baidu.com/doc/CFC/s/Gjwvz4dyc)
- [PublishVersion](https://cloud.baidu.com/doc/CFC/s/4jwvz4dn3)

### Alias operations

- [ListAliases](https://cloud.baidu.com/doc/CFC/s/njwvz4bnq)
- [CreateAlias](https://cloud.baidu.com/doc/CFC/s/Pjwvz4bas)
- [GetAlias](https://cloud.baidu.com/doc/CFC/s/0jwvz4al5)
- [UpdateAlias](https://cloud.baidu.com/doc/CFC/s/2jwvz4c20)
- [DeleteAlias](https://cloud.baidu.com/doc/CFC/s/qjwvz4ax5)

### Trigger operations

- [ListTriggers](https://cloud.baidu.com/doc/CFC/s/Kjwvz499l)
- [CreateTrigger](https://cloud.baidu.com/doc/CFC/s/njwvz48yg)
- [UpdateTrigger](https://cloud.baidu.com/doc/CFC/s/zjwvz48js)
- [DeleteTrigger](https://cloud.baidu.com/doc/CFC/s/hjwvz49o0)

### XFLOW execution operations

- [StartExecution](https://cloud.baidu.com/doc/CFC/s/mkxol1jzu)
- [StopExecution](https://cloud.baidu.com/doc/CFC/s/Gkxonyrw5)
- [ListExecutions](https://cloud.baidu.com/doc/CFC/s/ykxohlarn)
- [DescribeExecution](https://cloud.baidu.com/doc/CFC/s/1kxok5ygk)
- [GetExecutionHistory](https://cloud.baidu.com/doc/CFC/s/5kxokjxdp)

### XFLOW workflow operations

- [ListFlow](https://cloud.baidu.com/doc/CFC/s/ukxodmnfs)
- [CreateFlow](https://cloud.baidu.com/doc/CFC/s/Gkxoex4r4)
- [UpdateFlow](https://cloud.baidu.com/doc/CFC/s/Lkxofvtf1)
- [DescribeFlow](https://cloud.baidu.com/doc/CFC/s/Dkxoehwd1)
- [DeleteFlow](https://cloud.baidu.com/doc/CFC/s/skxohd6vn)

### Data types

- [CFC data types](https://cloud.baidu.com/doc/CFC/s/Kjwvz47o9)

Open the exact operation page before constructing a request. Do not infer an
unverified method, path, parameter name, or body schema from another operation.

## Endpoint selection

Always use HTTPS.

| Region | CFC endpoint | XFLOW endpoint |
| --- | --- | --- |
| `bj` | `cfc.bj.baidubce.com` | `xflow.bj.baidubce.com` |
| `gz` | `cfc.gz.baidubce.com` | `xflow.gz.baidubce.com` |
| `su` | `cfc.su.baidubce.com` | `xflow.su.baidubce.com` |

Match the endpoint region to the target function or workflow and to the
selected credential profile. Stop if the region is missing or inconsistent;
do not silently default to Beijing. This table is a documented snapshot, not a
complete endpoint inventory; the official [service endpoints](https://cloud.baidu.com/doc/CFC/s/rjwvz4chn)
page is authoritative.

## Common protocol

- CFC authenticates each request through the BCE `Authorization` header.
- The runtime supplies `Host`, `x-bce-date`, Authorization, and an STS security
  token when present. Do not pass those headers manually.
- Use `Content-Type: application/json; charset=utf-8` for documented JSON
  bodies.
- For POST and PUT, the runtime computes `x-bce-content-sha256` from the exact
  body bytes and includes it in the signed headers.
- Preserve the non-secret `X-Bce-Request-Id` response header when reporting a
  result or error.
- List APIs commonly use `Marker` and `MaxItems`. Follow the returned marker
  and stop at the user-requested limit; do not fetch every page by default.

## Operation families

The documented API includes:

- function invocation;
- function creation, listing, inspection, deletion, code updates, configuration,
  and reserved concurrency;
- function versions;
- aliases;
- triggers;
- XFLOW execution and workflow management.

Common URI families include `/v1/functions`,
`/v1/functions/{FunctionName}`, `/v1/functions/{FunctionName}/versions`,
`/v1/functions/{FunctionName}/aliases`,
`/v1/functions/{FunctionName}/invocations`, and
`/v1/functions/{FunctionName}/concurrency`. These patterns are routing aids,
not substitutes for the operation page.

Percent-encode a function name or BRN as one path segment. Do not let `:`, `/`,
`$`, or other resource-name characters change the URI structure.

## Function invocation

The invocation API supports these documented query parameters:

- `InvocationType=Event` for asynchronous invocation, which returns HTTP 202;
- `InvocationType=RequestResponse` for synchronous invocation;
- `InvocationType=DryRun` to validate the invocation;
- `Qualifier` for a function version or alias;
- `LogType=Tail` for the final 4 KB of Base64-encoded logs in
  `x-bce-log-result`; use it only with `RequestResponse`.

Treat every invocation as potentially state-changing, including
`InvocationType=DryRun`, because the API uses POST and function behavior may
not be evident from the request. Show the function, qualifier, invocation type,
region, and body source before asking for confirmation.

Do not automatically decode or print `x-bce-log-result`. Decode it only when
the user asks, and keep credentials and application secrets redacted.

## Function code and large bodies

CreateFunction and UpdateFunctionCode can carry a Base64-encoded ZIP package
inside a JSON body. The official CreateFunction documentation limits the ZIP
to 50 MB compressed and 250 MB uncompressed.

- Build the JSON request in a local file and use `--body-file`.
- Do not place Base64 code content in `--body`, shell history, logs, or chat.
- Keep `--max-request` enabled and do not raise it merely to bypass the safety
  limit. Its default allows the Base64 expansion of a 50 MB ZIP plus modest
  JSON metadata. If a larger request is genuinely required, confirm the
  payload size and safety boundary before changing the limit.
- Verify function name, runtime, handler, timeout, memory, publish behavior,
  and the code package hash before confirmation.

## Destructive-operation checks

POST, PUT, PATCH, and DELETE require the runtime's explicit confirmation.
Before asking for it, present the exact endpoint, method, function or workflow,
qualifier, and expected scope.

DeleteFunction needs additional care:

- With a concrete `Qualifier`, it deletes that version; aliases pointing to the
  version can block deletion.
- Do not use an alias as the deletion qualifier.
- Do not invent or append `$LATEST`.
- Without `Qualifier`, the operation can delete the function together with all
  versions and aliases. State this expanded scope explicitly.

Apply the same exact-target confirmation to aliases, triggers, reserved
concurrency, workflow definitions, and running XFLOW executions.

## Example workflow

1. Confirm that `bce --help` still has no CFC service.
2. Open the official page for the requested operation.
3. Select `cfc.<region>.baidubce.com` or
   `xflow.<region>.baidubce.com`.
4. Construct the documented URI, query, JSON body, and content type.
5. Run the bundled runtime with `--dry-run`; use `--body-file` for code or
   other large payloads.
6. Show the redacted request, target, and impact.
7. For POST, PUT, PATCH, or DELETE, obtain explicit confirmation and rerun with
   `--confirm`.
8. Report status and `X-Bce-Request-Id`; paginate only as far as requested.
