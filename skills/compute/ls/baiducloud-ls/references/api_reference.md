# LS / 自定义镜像 / 快照 portal OpenAPI Reference

规范来源：portal 对外开放接口文档。共 25 个接口——LS 18 个（2.1-2.18）、自定义镜像 3 个
（3.1-3.3）、快照 4 个（4.1-4.4）。本文件的小节号与接口文档一致，便于交叉引用。

- 接口前缀：`/openapi/portal/ls/**`、`/openapi/portal/image/**`、`/openapi/portal/snapshot/**`
- 本 Skill 的脚本封装：`scripts/ls.mjs`，每个接口下方给出对应子命令

## Service Endpoint

portal OpenAPI 的域名**不随 region 变化**，但测试环境与线上环境不同，必须显式指定：

| 来源 | 优先级 | 说明 |
| --- | --- | --- |
| `--endpoint <host>` | 1 | 单次命令覆盖 |
| `BCE_LS_ENDPOINT` | 2 | 推荐按环境 export |

两者都未设置时脚本直接报错，不使用任何内置默认域名。

**域名不对用户披露**：确认环境时只说「测试环境」或「线上环境」，回答里不要出现域名、host
或完整请求 URL，`--dry-run` 输出的 `url` 也不要原样转述给用户。

## Authentication

```
Authorization: bce-auth-v1/{accessKeyId}/{timestamp}/{expirationPeriodInSeconds}/{signedHeaders}/{signature}
```

- 校验失败返回 HTTP 403，错误码 `SignatureDoesNotMatch`，message `accesskey签字校验失败`。
- **`region` 是 query 参数，必须参与签名计算**，漏掉直接 403。
- **本组接口支持 `x-bce-*` 头**：脚本会发送并签名 `x-bce-date`；使用 STS 临时凭证时再带上
  `x-bce-security-token` 并纳入签名。签名头为 host + x-bce-date + 当前请求里所有 `content-*` /
  `x-bce-*` 头：GET 通常是 `content-type;host;x-bce-date`，POST/PUT 会再加 `content-length`
  和 `x-bce-content-sha256`，有 token 时追加 `x-bce-security-token`。长期 AK/SK 或 STS 均可。
- 签名规范：https://cloud.baidu.com/doc/Reference/s/njwvz1yfu

凭证解析顺序（不支持命令行传入 AK/SK）：

| 顺序 | 来源 |
| --- | --- |
| 1 | 环境变量 `BCE_ACCESS_KEY_ID` / `BCE_SECRET_ACCESS_KEY`（+可选 `BCE_SECURITY_TOKEN`） |
| 2 | `~/.bce/config.json` 里 `--profile` 指定或 current 的 profile：AK 模式取 `access_key_id`/`secret_access_key`；OAuth 模式经 `bce auth login` 的 STS 临时凭证（含 `sessionToken`），过期自动 `bce auth refresh` 续期 |

STS 临时凭证的 `sessionToken` 会作为 `x-bce-security-token` 头发送并参与签名。

## 公共请求参数

| 参数 | 位置 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| region | query | string | 否 | `bj` | 仅支持 `bj` 北京、`gz` 广州、`su` 苏州、`hkg` 香港、`bd` 保定；其他地域返回不支持 |

**region 必须先问用户**：脚本兜底 `bj` 只是为了让请求能发出去，**不代表可以替用户假设地域**。
调用任何接口前把五个地域列给用户选，允许多选；用户选了多个就对每个 region 各调一次，
结果按 region 分组展示。写操作与计费操作的确认信息里必须带上 region。

除 `Content-Type: application/json` 外，所有 POST/PUT 接口的业务参数都放在 request body。

## 公共响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| success | boolean | 是否成功 |
| status | integer | 状态码，200 表示成功 |

- 写操作通常只返回 `success` / `status`。
- `/ls/rebuild`、`/ls/start`、`/image/delete` 在后端未返回响应体时兜底返回
  `{"success": true, "status": 200}`。

列表类接口统一返回 `page` 分页体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| orderBy | string | 排序字段 |
| order | string | `desc` / `asc` |
| pageNo | integer | 当前页码 |
| pageSize | integer | 每页条数 |
| totalCount | integer | 总条数 |
| result | array | 当页数据列表 |

**唯一例外**：LS 套餐列表（2.12）字段名为 `result`，数据在 `result.result`，不返回分页计数。

## 必填字段与来源接口对照

必填字段缺失时脚本会直接报错并给出取值来源。调用方应先查来源接口、把候选项展示给用户
选择，再重试；不要自行编造取值。

| 子命令 | 必填字段 | 取值来源 |
| --- | --- | --- |
| `create` | `--spec` | 2.12 `list-specs` |
| `create` | `--image-id` | 2.18 `list-images` 的 **`id`（长 id）**；用户明确要自定义镜像时用 3.2 `list-custom-images` 的 `id` |
| `rebuild` | `--ls-id`、`--image-id` | 2.7 `list`；2.18 `list-images` 或 3.2 `list-custom-images` 的 **`imageId`（短 id）** |
| `resize` | `--instance-id`、`--spec` | 2.7 `list` / 2.6 `describe` 的 `instanceId`；2.12 `list-specs` |
| `renew` | `--instance-id`、`--duration` | 2.7 `list` / 2.6 `describe` 的 `instanceId`；时长由用户提供，**范围 1-120 个月** |
| `rename` / `stop` / `start` / `describe` / `change-password` / `assign-tags` / `vnc` / `remote-auth` / `create-image` / `create-snapshot` | `--ls-id` | 2.7 `list` 的 `id` |
| `rollback-snapshot` | `--snapshot-id`、`--ls-id` | 4.4 `list-snapshots` 的 `snapshotId`；2.7 `list` 的 `id` |
| `delete-snapshots` | `--vm-snapshot` | 4.4 `list-snapshots` 的 `instanceUuid` + `snapshotId` |
| `delete-image` | `--image-id` | 3.2 `list-custom-images` 的 **`imageId`（短 id）** |
| `order-detail` | `--order-id` | 2.1 `create` 响应的 `orderId`，或 2.6 `describe` 的 `orderUuid` |

**脚本自动填充的固定值字段**，不需要询问用户：`serviceType=LS`（renew）、`key=ls`
（order-detail）、`objType=ls`（quota，可改）、`serviceFor=LS` 与 `visitorService=LS`
（list-custom-images）。

## 短 id 与 uuid 对照

传错类型通常表现为 404 或 400：

| 标识 | 形态 | 出现在 | 脚本参数 |
| --- | --- | --- | --- |
| 实例短 id | `i-rm4VpVWH` | `lsIds` / `lsId` 字段、`ls/instance/{lsId}` 的 path、`snapshot/rollback` 的 `instanceId` | `--ls-id` |
| 实例 instanceId | 32 位十六进制 uuid | 2.9 renew、2.10 resize、4.3 batchDelete 的 `instanceId` | `--instance-id` |
| 镜像长 id | uuid，如 `a2de5608-6aa1-4cf7-bcf1-cae966cd16c9`（镜像列表的 `id`） | **2.1 create 的 `imageId`** | `--image-id` |
| 镜像短 id | `m-hZjv3yY8`（镜像列表的 `imageId`） | **2.3 rebuild 的 `imageId`、3.3 delete 的 `imageIds`** | `--image-id` |
| 快照短 id | `s-tVYWZ3y8` | 4.2 rollback 的 `snapshotId`、**4.3 batchDelete 的 `snapshotId`** | `--snapshot-id` / `--vm-snapshot` 冒号后半段 |

三处最容易错的地方：

1. `snapshot/rollback` 的 `instanceId` 传**短 id**，而 `snapshot/batchDelete` 的
   `instanceId` 传 **uuid**。
2. `snapshot/batchDelete` 的 `snapshotId` 传**快照短 id**（`snapshotId` 字段），
   **不是**快照 uuid（`id` 字段）。
3. `ls/create` 的 `imageId` 传**镜像长 id**（镜像列表的 `id`），而 `ls/rebuild` 的
   `imageId` 和 `image/delete` 的 `imageIds` 传**镜像短 id**（镜像列表的 `imageId`）。

对应关系从 2.7 `list` / 2.6 `describe` 的 `id` 与 `instanceId`，4.4
`list-snapshots` 的 `snapshotId` 与 `instanceUuid`，以及 2.18 / 3.2 镜像列表的 `id` 与
`imageId` 取得。

---

# 2. LS 类接口

## 2.1 创建 LS 服务器

```
POST /openapi/portal/ls/create?region={region}
Host: <Endpoint>
```

脚本命令：`node scripts/ls.mjs create --confirm`

| 字段 | 类型 | 必填 | 默认值 | 说明 / 约束 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| spec | string | **是** | — | 套餐（等价后端 blcSpec）。**必须来自 2.12 套餐列表**，列表里没有的不支持创建 | `--spec` |
| imageId | string | **是** | — | 镜像**长 id**（uuid），取 2.18 响应的 `id` 字段，**不是 `imageId` 短 id**。**先查 2.18**；只有用户主动说要自定义镜像才查 3.2 | `--image-id` |
| instanceName | string | 否 | `""` | 支持中英文、数字和 `-_ /.`，须以中文或字母开头，长度 1-65 | `--instance-name` |
| purchaseCount | integer | 否 | `1` | 1-50 台 | `--purchase-count` |
| autoRenewTime | boolean | 否 | `false` | 是否自动续费，用户不主动提就不改 | `--auto-renew` |
| adminPass | string | 否 | `""` | 按 LS 侧约定加密后传入。10-20 字符，须同时含大写、小写、数字、特殊符号（符号限 `()`~!@#$%^&*-_+=\|{}[]:;'<>,.?/`） | `--admin-pass` |
| billing.paymentTiming | string | 否 | `prepay` | **只有 `prepay`** | `--payment-timing` |
| billing.reservation.reservationLength | integer | 否 | `1` | 购买时长，单位月 | `--reservation-length` |

请求 json（只给了两个必填字段时脚本实际发出的内容）：

```json
{
  "spec": "ls.s1.c1m1d40b3",
  "imageId": "a2de5608-6aa1-4cf7-bcf1-cae966cd16c9",
  "instanceName": "",
  "purchaseCount": 1,
  "autoRenewTime": false,
  "adminPass": "",
  "billing": {
    "paymentTiming": "prepay",
    "reservation": { "reservationLength": 1 }
  }
}
```

响应参数：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| success | boolean | 是否成功 |
| status | integer | 状态码 |
| orderId | string | 订单号，可用于 2.15 查询订单详情 |
| lsIds | array[string] | 新建实例的短 id 列表 |

```json
{
  "success": true,
  "status": 200,
  "orderId": "d250d96de94040dabecc62c864b5227b",
  "lsIds": ["i-ZXqlvfXP"]
}
```

> 计费操作。先 `--dry-run` 预览，并向用户复述套餐、台数、时长和付费方式（带上 region，
> **不带域名**）。让用户挑镜像时展示并回填**长 id**。
>
> **下单不等于创建成功**：订单默认待支付（`NEED_PURCHASE`），必须提示用户前往
> https://console.bce.baidu.com/billing/order/list 完成支付，支付完成后实例才真正创建。

---

## 2.2 LS 重命名

```
PUT /openapi/portal/ls/rename?region={region}
```

脚本命令：`node scripts/ls.mjs rename --ls-id i-xxx --name new-name --confirm`

| 字段 | 类型 | 必填 | 说明 / 约束 |
| --- | --- | --- | --- |
| lsIds | array[string] | **是** | 实例短 id 列表 |
| name | string | **是** | 支持中英文、数字和 `-_ /.`，须以中文或字母开头，长度 1-65 |

```json
{ "lsIds": ["i-rm4VpVWH"], "name": "new-name" }
```

响应：`success`、`status`

---

## 2.3 LS 重装系统

```
POST /openapi/portal/ls/rebuild?region={region}
```

脚本命令：`node scripts/ls.mjs rebuild --ls-id i-xxx --image-id m-xxx --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 / 来源 |
| --- | --- | --- | --- |
| lsIds | array[string] | **是** | 实例短 id 列表 |
| imageId | string | **是** | 镜像**短 id**（`m-` 开头），取 2.18 或 3.2 响应的 `imageId` 字段，**不是长 id** |

```json
{ "lsIds": ["i-rm4VpVWH"], "imageId": "m-hZjv3yY8" }
```

响应：`success`、`status`。后端未返回响应体时兜底返回成功。

> **危险操作**：会清空系统盘数据。必须先 `--dry-run`，展示 region、实例 id、目标镜像（**短 id**）后取得确认。

---

## 2.4 LS 关机

```
PUT /openapi/portal/ls/stop?region={region}
```

脚本命令：`node scripts/ls.mjs stop --ls-id i-xxx --confirm`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| lsIds | array[string] | **是** | 实例短 id 列表 |

```json
{ "lsIds": ["i-rm4VpVWH"] }
```

响应：`success`、`status`

---

## 2.5 LS 开机

```
PUT /openapi/portal/ls/start?region={region}
```

脚本命令：`node scripts/ls.mjs start --ls-id i-xxx --confirm`

请求参数同 2.4（`lsIds`）。响应：`success`、`status`，后端无响应体时兜底成功。

---

## 2.6 LS 详情

```
GET /openapi/portal/ls/instance/{lsId}?region={region}
```

脚本命令：`node scripts/ls.mjs describe --ls-id i-xxx`

| 字段 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| lsId | path | string | **是** | 实例**短 id** |
| region | query | string | 否 | 默认 `bj` |

```
GET /openapi/portal/ls/instance/i-rm4VpVWH?region=bj
```

响应 `result`（LsInstance）字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 短 id，如 `i-rm4VpVWH` |
| instanceId | string | 实例 uuid，2.9 renew / 2.10 resize / 4.3 batchDelete 需要它 |
| name | string | 实例名称 |
| status | string | 实例状态，如 `active` |
| spec | string | 套餐，如 `ls.m1.c1m2d100b3` |
| imageId | string | 镜像 id（后端字段 imageUuid，已归一为 imageId） |
| imageName / imageType | string | 镜像名 / 镜像类型 |
| osName / osVersion / osArch / osLang / osBuild / osType | string | 操作系统信息 |
| appType / appVersion | string | 应用镜像类型 / 版本 |
| volumeId / volumeUuid / volumeName / volumeStatus | string | 系统盘信息 |
| tags | array | 标签列表，元素含 `tagKey` / `tagValue` |
| resGroupInfos | array | 资源组列表，元素含 `groupId` / `groupName` |
| createdTime / expireTime | string | 创建时间 / 到期时间 |
| eip | string | 公网 ip |
| eipSize | integer | 带宽，Mbps |
| rootGb | integer | 系统盘大小，GB |
| memoryMb | integer | 内存，MB |
| vcpu | integer | CPU 核数 |
| chargeStatus | string | 计费状态 |
| productType | string | 付费方式，如 `prepay` |
| hasScheduleTask | boolean | 是否有定时任务 |
| orderUuid | string | 订单号 |

```json
{
  "success": true,
  "status": 200,
  "result": {
    "id": "i-rm4VpVWH",
    "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
    "name": "ls-demo",
    "status": "active",
    "spec": "ls.m1.c1m2d100b3",
    "imageId": "c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    "imageName": "CentOS 7.9",
    "imageType": "system",
    "osName": "CentOS",
    "osVersion": "7.9",
    "volumeId": "v-3kZE7x6W",
    "volumeName": "sys-volume",
    "volumeStatus": "InUse",
    "tags": [{ "tagKey": "env", "tagValue": "test" }],
    "resGroupInfos": [{ "groupId": "RESG-xxxx", "groupName": "default" }],
    "createdTime": "2026-08-01T10:00:00Z",
    "expireTime": "2026-09-01T10:00:00Z",
    "eip": "106.12.0.1",
    "eipSize": 3,
    "rootGb": 100,
    "memoryMb": 2048,
    "vcpu": 1,
    "chargeStatus": "normal",
    "productType": "prepay",
    "hasScheduleTask": false,
    "orderUuid": "d250d96de94040dabecc62c864b5227b"
  }
}
```

---

## 2.7 LS 列表

```
POST /openapi/portal/ls/list?region={region}
```

脚本命令：`node scripts/ls.mjs list --page-size 20`

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| pageNo | integer | 否 | `1` | 页码 | `--page-no` |
| pageSize | integer | 否 | `10` | 每页条数 | `--page-size` |
| order | string | 否 | `""` | `desc` / `asc` | `--order` |
| orderBy | string | 否 | `""` | 排序字段，如 `expireTime` | `--order-by` |

该接口**不支持** `keyword` / `keywordType` / `filters`，按名称找实例要在返回结果里自行匹配。

```json
{ "pageNo": 1, "pageSize": 10, "order": "", "orderBy": "" }
```

响应 `page.result` 元素结构同 2.6 的 `result`：

```json
{
  "success": true,
  "status": 200,
  "page": {
    "orderBy": "expireTime",
    "order": "desc",
    "pageNo": 1,
    "pageSize": 10,
    "totalCount": 1,
    "result": [
      {
        "id": "i-rm4VpVWH",
        "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
        "name": "ls-demo",
        "status": "active",
        "spec": "ls.m1.c1m2d100b3",
        "imageId": "c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
        "eip": "106.12.0.1",
        "expireTime": "2026-09-01T10:00:00Z",
        "productType": "prepay"
      }
    ]
  }
}
```

> **命令行登录**：用户要 SSH 登录时，ip 用 `eip`，**端口 22**，用文本告知用户即可。

---

## 2.8 LS 重置密码

```
PUT /openapi/portal/ls/changePassword?region={region}
```

脚本命令：`node scripts/ls.mjs change-password --ls-id i-xxx --password '<password>' --confirm`

| 字段 | 类型 | 必填 | 说明 / 约束 |
| --- | --- | --- | --- |
| lsIds | array[string] | **是** | 实例短 id 列表 |
| password | string | **是** | **明文**。10-20 字符，须同时含大写、小写、数字、特殊符号（符号限 `()`~!@#$%^&*-_+=\|{}[]:;'<>,.?/`） |

```json
{ "lsIds": ["i-rm4VpVWH"], "password": "Passw0rd!" }
```

响应：`success`、`status`

> 与 2.1 的差异：`create` 的 `adminPass` 需要**已加密**，本接口的 `password` 是**明文**。

---

## 2.9 LS 续费

```
POST /openapi/portal/ls/renew?region={region}
```

脚本命令：`node scripts/ls.mjs renew --instance-id <uuid> --duration 1 --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- |
| items | array | **是** | 续费项列表 | 由 `--instance-id` 展开 |
| items[].config.duration | integer | **是** | 续费时长，单位月，**范围 1-120（最长 10 年）** | `--duration` |
| items[].config.instanceId | string | **是** | 实例 **instanceId**（uuid） | `--instance-id` |
| items[].config.serviceType | string | **是** | 固定 `LS` | 脚本自动填充 |

无 `paymentMethod`、无 `config.uuid`。

```json
{
  "items": [
    {
      "config": {
        "duration": 1,
        "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
        "serviceType": "LS"
      }
    }
  ]
}
```

响应：`success`、`status`

> 计费操作。`instanceId` 是 uuid，传短 id 会失败。`duration` 超出 1-120 个月时脚本直接报错，
> 需要先让用户把时长改到范围内。
>
> 同样产生待支付订单，需提示用户到 https://console.bce.baidu.com/billing/order/list 支付。

---

## 2.10 LS 配置升级

```
POST /openapi/portal/ls/resize?region={region}
```

脚本命令：`node scripts/ls.mjs resize --instance-id <uuid> --spec ls.s1.c2m8d100b8 --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 / 来源 |
| --- | --- | --- | --- |
| spec | string | **是** | 目标套餐，**必须来自 2.12 套餐列表** |
| instanceId | string | **是** | 实例 **instanceId**（uuid） |

无 `paymentMethod`。

```json
{ "spec": "ls.s1.c2m8d100b8", "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d" }
```

响应：`success`、`status`

> 计费操作，同样产生待支付订单，需提示用户到
> https://console.bce.baidu.com/billing/order/list 支付。

---

## 2.11 更新 LS 标签绑定关系

```
POST /openapi/portal/ls/tag/assign?region={region}
```

脚本命令：`node scripts/ls.mjs assign-tags --ls-id i-xxx --tag env=prod --confirm`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| lsId | string | **是** | 实例短 id |
| tags | array | **是** | 元素含 `tagKey` / `tagValue`；**传空列表表示解绑全部** |

```json
{ "lsId": "i-rm4VpVWH", "tags": [{ "tagKey": "env", "tagValue": "prod" }] }
```

响应：`success`、`status`

> 全量覆盖语义，不是增量追加。省略 `--tag` 等于解绑该实例全部标签。

---

## 2.12 LS 套餐列表

```
POST /openapi/portal/ls/spec/list?region={region}
```

脚本命令：`node scripts/ls.mjs list-specs --region bj`

无 request body，只有 query 参数 `region`。

响应参数：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| result.result | array | 套餐列表（**该接口不返回分页字段**） |

套餐（LsSpec）字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| flavorId | string | 套餐 id，如 `f-0rUZG44W` |
| status | string | 套餐状态，如 `available` |
| productType | string | 付费方式，如 `prepay`，为空表示不限 |
| subServiceType | string | 套餐类型，1-通用型 2-内存型 |
| spec | string | 套餐名，如 `ls.s1.c1m1d40b3`，**创建和升配填这个值** |
| specId | string | 套餐系列 id，如 `s1` |
| logicalZone | string | 逻辑可用区 |
| cpuCount | integer | CPU 核数 |
| memoryCapacityInGB | integer | 内存，GB |
| systemVolumeInGB | integer | 系统盘大小，GB |
| systemVolumeStorageType | string | 系统盘类型，如 `ssd` |
| bandWith | integer | 带宽，Mbps |
| packageCapacity | integer | 流量包大小 |
| priceTag | string | 计费标签，如 `default1` |

```json
{
  "success": true,
  "status": 200,
  "result": {
    "result": [
      {
        "flavorId": "f-0rUZG44W",
        "status": "available",
        "productType": "prepay",
        "subServiceType": "1",
        "spec": "ls.s1.c1m1d40b3",
        "specId": "s1",
        "logicalZone": "zoneA",
        "cpuCount": 1,
        "memoryCapacityInGB": 1,
        "systemVolumeInGB": 40,
        "systemVolumeStorageType": "ssd",
        "bandWith": 3,
        "packageCapacity": 1024,
        "priceTag": "default1"
      }
    ]
  }
}
```

---

## 2.13 LS 远程连接鉴权

```
POST /openapi/portal/ls/remoteconn/auth?region={region}
```

脚本命令：`node scripts/ls.mjs remote-auth --ls-id i-xxx --username root --password '<password>'`

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| lsIds | array[string] | **是** | — | 实例短 id 列表 | `--ls-id` |
| username | string | **是** | — | 登录用户名 | `--username` |
| password | string | **是** | — | 登录密码，明文 | `--password` |
| netConnMethod | string | 否 | `internal` | 网络连接方式 | `--net-conn-method` |

```json
{
  "lsIds": ["i-rm4VpVWH"],
  "netConnMethod": "internal",
  "username": "root",
  "password": "Passw0rd!"
}
```

响应 `result` 为数组，按请求实例逐个返回：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| instanceId | string | 实例 uuid |
| token | string | 远程连接 token |

```json
{
  "success": true,
  "status": 200,
  "result": [
    {
      "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
      "token": "eyJhbGciOiJIUzI1NiJ9.token"
    }
  ]
}
```

> `token` 等同临时登录凭证。只在当次回答中给出，不要写入文件、日志或提交到仓库。

---

## 2.14 LS 配额查询

```
POST /openapi/portal/ls/quota?region={region}
```

脚本命令：`node scripts/ls.mjs quota`

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| objType | string | **是** | 脚本填 `ls` | 资源类型 | `--obj-type` |
| lsId | string | 否 | 不传 | 实例短 id | `--ls-id` |

```json
{ "lsId": "i-4kZE7x6W", "objType": "ls" }
```

响应：接口文档未给出结构，服务端原样透传后端 json。

```json
{ "success": true, "status": 200, "result": {} }
```

---

## 2.15 LS 订单详情

```
POST /openapi/portal/ls/order/detail?region={region}
```

脚本命令：`node scripts/ls.mjs order-detail --order-id <uuid>`

| 字段 | 类型 | 必填 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- |
| key | string | **是** | 商品标识，固定 `ls` | 脚本自动填充 |
| uuid | string | **是** | 订单号 | `--order-id` |

```json
{ "key": "ls", "uuid": "d250d96de94040dabecc62c864b5227b" }
```

`result` 主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| uuid | string | 订单号 |
| type | string | 订单类型，`NEW` / `RENEW` / `RESIZE` |
| accountId / userId | string | 账号 id / 用户 id |
| serviceType | string | 产品线，`LS` |
| status | string | 订单状态，如 `NEED_PURCHASE` |
| productType | string | 付费方式，如 `prepay` |
| subProductType / subOrderType / groupId / internalStatus / specificType | string/integer | 订单辅助字段 |
| price / catalogPrice / favourablePrice | number | 应付金额 / 目录价 / 优惠金额 |
| discount | integer | 折扣，100 表示无折扣 |
| createTime / updateTime / payExpireTime | string | 创建 / 更新 / 支付截止时间 |
| payChannel | string | 支付方式，如 `CASH` |
| source / campaignId | string | 订单来源 / 活动 id |
| resourceNames | array[string] | 资源名称列表 |
| discountCouponFavourablePrice | number | 折扣券优惠金额 |
| cashEquivalentCouponFavourablePrice | number | 代金券优惠金额 |
| specialRefundOrder | boolean | 是否特殊退款订单 |
| items | array | 订单项列表 |

`result.items[]` 主要字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| region | string | 地域 |
| key | string | 商品标识，如 `ls` |
| extra | string | 下单时的原始请求，json 字符串 |
| unitPrice / unitCatalogPrice / catalogPrice / price | number | 单价 / 单价目录价 / 目录价 / 总价 |
| count / alterCount / unitCount | integer | 数量 / 变配数量 / 单位数量 |
| time / timeUnit | integer/string | 购买时长 / 时长单位，如 `MONTH` |
| flavor | array | 规格项，元素含 `name` / `value` / `scale`，如 `name=lsSpec` |
| serviceType / productType / subProductType | string | 产品线 / 付费方式 / 子类型 |
| unitPriceShow | string | 单价展示文案，如 `￥42.00/个` |
| chargeType | array[string] | 计费方式，如 `["CPT2"]` |
| configuration | array[string] | 配置展示文案 |
| paymentMethod | object | 含 `discountRate`（100 无折扣）、`coupons`、`discountCoupons`、`cashEquivalentCoupons` |
| shortIds | array[string] | 变配 / 续费涉及的实例短 id |
| discountFlag / isOnceCharge | boolean | 是否有折扣 / 是否一次性收费 |
| discountWithCouponPrice / favourablePrice | number | 券后价 / 优惠金额 |
| pricingDetail | object | 价格明细，含 `cpt2Price` / `cpt1Price`、`policy`、`alterPriceList`、`detailPriceMessage` |

```json
{
  "success": true,
  "status": 200,
  "result": {
    "uuid": "d250d96de94040dabecc62c864b5227b",
    "type": "NEW",
    "serviceType": "LS",
    "status": "NEED_PURCHASE",
    "productType": "prepay",
    "price": 42.0,
    "catalogPrice": 42.0,
    "favourablePrice": 0.0,
    "discount": 100,
    "createTime": "2026-08-01T10:00:00Z",
    "payChannel": "CASH",
    "payExpireTime": "2026-08-02T10:00:00Z",
    "resourceNames": ["ls-demo"],
    "items": [
      {
        "region": "bj",
        "key": "ls",
        "count": 1,
        "time": 1,
        "timeUnit": "MONTH",
        "unitPrice": 42.0,
        "price": 42.0,
        "unitPriceShow": "￥42.00/个",
        "chargeType": ["CPT2"],
        "configuration": ["1核 1GB 40GB SSD 3Mbps"],
        "flavor": [{ "name": "lsSpec", "value": "ls.s1.c1m1d40b3", "scale": 1 }],
        "paymentMethod": { "discountRate": 100, "coupons": [] },
        "shortIds": ["i-ZXqlvfXP"]
      }
    ]
  }
}
```

---

## 2.16 LS VNC 登录地址

```
POST /openapi/portal/ls/vnc?region={region}
```

脚本命令：`node scripts/ls.mjs vnc --ls-id i-xxx`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| lsId | string | **是** | 实例短 id |

```json
{ "lsId": "i-rm4VpVWH" }
```

响应：`result` 是**登录页面地址字符串**，直接给用户打开即可。

```json
{
  "success": true,
  "status": 200,
  "result": "http://10.6.72.8/vnc_auto.html?token=c613d235-0397-47e6-85b7-cdd1b56f18fd&password=yes"
}
```

> **必须原样把整条 URL 给用户**：不要改写、截断，也不要把 `token` 或 `password` 替换成
> `<你的实例密码>` 这类占位符。返回值里的 `password=yes` 就是最终值，照抄即可，
> 用户拿到的必须是能直接点开的完整链接。
> 该 URL 内嵌 token，等同临时登录凭证，不要写入文件或提交到仓库。

---

## 2.17 LS 系统盘列表

```
GET /openapi/portal/ls/volume/listSys?region={region}
```

脚本命令：`node scripts/ls.mjs list-system-volumes`

只有 query 参数 `region`，无 request body。响应由后端原样透传（待联调核对）。

```json
{ "success": true, "status": 200, "result": {} }
```

---

## 2.18 创建 LS 可用镜像列表

```
POST /openapi/portal/ls/image/list?region={region}
```

脚本命令：`node scripts/ls.mjs list-images`

**这是 `create` 和 `rebuild` 选镜像的默认入口**，返回公共镜像和应用镜像。
自定义镜像在 3.2。

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| imageTypes | array | 否 | `["ls_application"]` | `common` 公共镜像、`ls_application` 应用镜像 | `--image-types` |
| keywordType | string | 否 | `status` | 搜索字段 | `--keyword-type` |
| keyword | string | 否 | `active` | 搜索值 | `--keyword` |
| orderBy | string | 否 | `""` | 排序字段，如 `osVersion` | `--order-by` |
| order | string | 否 | `""` | `desc` / `asc` | `--order` |

```json
{
  "imageTypes": ["ls_application"],
  "keywordType": "status",
  "keyword": "active",
  "orderBy": "osVersion",
  "order": "desc"
}
```

`page.result[]` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 镜像 uuid（长 id），**2.1 create 填这个值** |
| imageId | string | 镜像短 id，如 `m-3999Hhiw`，**2.3 rebuild 填这个值** |
| name | string | 镜像名，如 `9.4 x86_64 (64bit) 英文版` |
| imageType | string | 镜像类型，如 `lightserver_image` |
| snapshotId | string | 来源快照 id，非快照创建的镜像为空 |
| cpu / memory | integer | CPU 核数 / 内存（MB） |
| osType | string | 操作系统类型，如 `linux` |
| appType | string | 应用类型，如 `Node.js` / `WordPress`，公共镜像为空 |
| appVersion | string | 应用版本，如 `22.11.0` |
| osVersion | string | 系统版本，如 `24.04 LTS amd64 (64bit)` |
| osName | string | 系统名，如 `Ubuntu` / `rocky linux` |
| osBuild / osLang | string | 系统构建号 / 系统语言，如 `ENG` |
| diskSize | integer | 磁盘大小，GB |
| createTime | string | 创建时间，UTC |
| status | string | 镜像状态，如 `active` |
| minMem / maxRamGb | integer | 最小内存要求 / 最大内存限制，GB |
| minCpu / minDiskGb | integer | 最小 CPU 要求 / 最小系统盘要求（GB） |
| desc / imageDescription | string | 镜像描述 |
| osArch | string | 系统架构，如 `amd64 (64bit)` |
| ephemeralSize | integer | 临时盘大小，GB |
| shareToUserNumLimit / sharedToUserNum | integer | 可共享用户数上限 / 已共享用户数 |
| fpgaType / specialVersion | string | FPGA 类型 / 特殊版本标识 |
| tags | array | 标签列表，元素含 `tagKey` / `tagValue` |
| templatePackage / supportUserData | boolean | 是否模板包 / 是否支持 userData 自定义脚本 |
| snapshots | array | 关联快照列表，结构同 4.4 的元素 |
| encryptKey | string | 加密密钥 |
| name_fri | string | 镜像友好名 |

```json
{
  "success": true,
  "status": 200,
  "page": {
    "orderBy": "osVersion",
    "order": "desc",
    "pageNo": 1,
    "pageSize": 0,
    "totalCount": 12,
    "result": [
      {
        "id": "d4a98672-2219-488a-a614-adb8d9598485",
        "imageId": "m-3999Hhiw",
        "name": "9.4 x86_64 (64bit) 英文版",
        "imageType": "lightserver_image",
        "snapshotId": "",
        "osType": "linux",
        "appType": "Node.js",
        "appVersion": "22.11.0",
        "osVersion": "9.4 x86_64 (64bit)",
        "osName": "rocky linux",
        "osBuild": "2025031700",
        "osLang": "ENG",
        "createTime": "2025-03-17T20:23:13Z",
        "status": "active",
        "minMem": 1,
        "minDiskGb": 20,
        "desc": "rockylinux-9.4-x86_64-nodejs22-20250317-192877",
        "osArch": "x86_64 (64bit)",
        "tags": [],
        "templatePackage": false,
        "supportUserData": false,
        "snapshots": null
      }
    ]
  }
}
```

> 选镜像时把 `name` + `osName` + `osVersion` + `appType`/`appVersion` 一起展示给用户，
> 并注意 `minDiskGb` / `minMem` 是否被目标套餐满足。
> 展示 id 时按目标操作二选一：给 `create` 展示 `id`（长 id），给 `rebuild` 展示
> `imageId`（短 id）。

---

# 3. 自定义镜像类接口

## 3.1 创建自定义镜像

```
POST /openapi/portal/image/create?region={region}
```

脚本命令：`node scripts/ls.mjs create-image --ls-id i-xxx --name my-image --confirm`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| lsIds | array[string] | **是** | 制作镜像的源实例短 id 列表 |
| name | string | **是** | 镜像名称 |

```json
{ "lsIds": ["i-rm4VpVWH"], "name": "my-image" }
```

响应：`success`、`status`

> **不返回镜像 id**。发布后需用 3.2 按名称查询，等 `status` 可用后才能使用：
> 用于 2.1 create 时取 `id`（长 id），用于 2.3 rebuild 时取 `imageId`（短 id）。

---

## 3.2 镜像列表（自定义镜像）

```
POST /openapi/portal/image/list?region={region}
```

脚本命令：`node scripts/ls.mjs list-custom-images`

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| pageNo | integer | 否 | `1` | 页码 | `--page-no` |
| pageSize | integer | 否 | `10` | 每页条数 | `--page-size` |
| keywordType | string | 否 | `status` | 搜索字段 | `--keyword-type` |
| keyword | string | 否 | `active` | 搜索值 | `--keyword` |
| imageTypes | array[string] | 否 | `["lsCustom"]` | 必须默认 `lsCustom` | `--image-types` |
| serviceFor | string | 否 | `LS` | 必须固定 `LS` | 脚本自动填充 |
| visitorService | string | 否 | `LS` | 必须固定 `LS` | 脚本自动填充 |
| orderBy | string | 否 | `""` | 排序字段，如 `createTime` | `--order-by` |
| order | string | 否 | `""` | `desc` / `asc` | `--order` |

```json
{
  "pageNo": 1,
  "pageSize": 10,
  "order": "",
  "orderBy": "",
  "keywordType": "status",
  "keyword": "active",
  "imageTypes": ["lsCustom"],
  "serviceFor": "LS",
  "visitorService": "LS"
}
```

`page.result[]`（ImageInfo）字段（**文档未给响应体，按 glance 镜像常规返回推断，待联调核对**）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 镜像 uuid（长 id），**2.1 create 填这个值** |
| imageId | string | 短 id，如 `m-hZjv3yY8`，**2.3 rebuild 和 3.3 delete 填这个值** |
| name | string | 镜像名称 |
| type | string | 镜像类型，自定义镜像为 `lsCustom` |
| status | string | 镜像状态 |
| osName / osVersion / osArch / osType / osBuild / osLang | string | 操作系统信息 |
| diskMinGb | integer | 最小系统盘要求，GB |
| createTime | string | 创建时间 |
| desc | string | 描述 |
| serviceFor | string | 归属服务，LS 镜像为 `LS` |

```json
{
  "success": true,
  "status": 200,
  "page": {
    "orderBy": "createTime",
    "order": "desc",
    "pageNo": 1,
    "pageSize": 10,
    "totalCount": 1,
    "result": [
      {
        "id": "c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
        "imageId": "m-hZjv3yY8",
        "name": "my-image",
        "type": "lsCustom",
        "status": "Available",
        "osName": "CentOS",
        "osVersion": "7.9",
        "osArch": "x86_64",
        "osType": "linux",
        "diskMinGb": 40,
        "createTime": "2026-08-01T10:00:00Z",
        "desc": "",
        "serviceFor": "LS"
      }
    ]
  }
}
```

---

## 3.3 删除自定义镜像

```
POST /openapi/portal/image/delete?region={region}
```

脚本命令：`node scripts/ls.mjs delete-image --image-id m-xxx --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| imageIds | array[string] | **是** | 镜像**短 id** 列表（`m-` 开头），取 3.2 响应的 `imageId` 字段，**不是长 id** |

```json
{ "imageIds": ["m-hZjv3yY8"] }
```

响应：`success`、`status`。后端未返回响应体时兜底返回成功。

> **危险操作**：不可恢复。删除前确认没有实例仍依赖该镜像重装。
> 让用户确认要删哪个镜像时展示**短 id** + `name` + `createTime`。

---

# 4. 快照类接口

## 4.1 创建快照

```
POST /openapi/portal/snapshot/create?region={region}
```

脚本命令：`node scripts/ls.mjs create-snapshot --ls-id i-xxx --name snap-20260831 --confirm`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| lsId | string | **是** | 实例短 id |
| name | string | **是** | 快照名称 |

```json
{ "lsId": "i-rm4VpVWH", "name": "snap-20260831" }
```

响应：`success`、`status`

> 与 3.1 同理，不返回快照 id，需用 4.4 按名称查询。

---

## 4.2 快照回滚

```
POST /openapi/portal/snapshot/rollback?region={region}
```

脚本命令：`node scripts/ls.mjs rollback-snapshot --snapshot-id s-xxx --ls-id i-xxx --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- |
| snapshotId | string | **是** | 快照 id（4.4 的 `snapshotId`，短 id） | `--snapshot-id` |
| instanceId | string | **是** | 实例 id，**这里传短 id** | `--ls-id` |

```json
{ "snapshotId": "s-tVYWZ3y8", "instanceId": "i-rm4VpVWH" }
```

响应：`success`、`status`

> **危险操作**：会用快照覆盖当前系统盘数据。必须先 `--dry-run` 并取得确认。
> 注意本接口 `instanceId` 是短 id，而 4.3 的 `instanceId` 是 uuid。

---

## 4.3 批量删除快照

```
POST /openapi/portal/snapshot/batchDelete?region={region}
```

脚本命令：`node scripts/ls.mjs delete-snapshots --vm-snapshot <instanceId>:<snapshotId> --confirm --dry-run`

| 字段 | 类型 | 必填 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- |
| vmSnapsots | array | **是** | 虚机快照列表 | `--vm-snapshot`（可重复） |
| 元素.instanceId | string | **是** | 实例 **instanceId**（uuid，取 4.4 的 `instanceUuid`） | 冒号前半段 |
| 元素.snapshotId | string | **是** | **快照 `snapshotId`（短 id），不是快照 `id`（uuid）** | 冒号后半段 |

```json
{
  "vmSnapsots": [
    {
      "instanceId": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
      "snapshotId": "s-fBxbcXcA"
    }
  ]
}
```

响应：`success`、`status`

> **`vmSnapsots` 的拼写错误沿用后端，不要纠正为 `vmSnapshots`**，改了会导致参数丢失。
> 本接口没有 `cdsSnapsots` 字段。
> **危险操作**：不可恢复。

---

## 4.4 快照列表

```
POST /openapi/portal/snapshot/list?region={region}
```

脚本命令：`node scripts/ls.mjs list-snapshots`

| 字段 | 类型 | 必填 | 默认值 | 说明 | 脚本参数 |
| --- | --- | --- | --- | --- | --- |
| pageNo | integer | 否 | `1` | 页码 | `--page-no` |
| pageSize | integer | 否 | `10` | 每页条数 | `--page-size` |
| order | string | 否 | `""` | `desc` / `asc` | `--order` |
| orderBy | string | 否 | `""` | 排序字段：`createTime`、`diskId`、`name` | `--order-by` |

该接口**不支持** `keyword` / `keywordType` / `filters`。

```json
{ "pageNo": 1, "pageSize": 10, "order": "", "orderBy": "" }
```

`page.result[]`（SnapshotInfo）字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 快照 uuid |
| snapshotId | string | 短 id，如 `s-tVYWZ3y8`，**4.2 回滚和 4.3 删除都填这个值** |
| name | string | 快照名称 |
| size | string | 容量，单位 GB |
| createTime | string | 创建时间 |
| status | string | 快照状态，如 `active` |
| includeEphemeral | boolean | 是否包含临时盘 |
| createMethod | string | 创建方式，如 `MANUAL` |
| type | string | 快照类型，如 `system` |
| instanceId | string | 实例短 id |
| instanceUuid | string | 实例 uuid，**4.3 删除填这个值** |
| instanceName / instanceStatus | string | 实例名 / 实例状态 |
| volumeId / diskId / diskName / diskStatus | string | 磁盘信息（`diskId` 为磁盘 uuid） |

```json
{
  "success": true,
  "status": 200,
  "page": {
    "orderBy": "createTime",
    "order": "desc",
    "pageNo": 1,
    "pageSize": 10,
    "totalCount": 1,
    "result": [
      {
        "id": "7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4",
        "snapshotId": "s-tVYWZ3y8",
        "name": "snap-20260831",
        "size": "40",
        "createTime": "2026-08-31T10:00:00Z",
        "status": "active",
        "includeEphemeral": false,
        "createMethod": "MANUAL",
        "type": "system",
        "instanceId": "i-rm4VpVWH",
        "instanceUuid": "9a0d4e6c1b2f4a0e8c3d5b7f9e1a2c4d",
        "instanceName": "ls-demo",
        "instanceStatus": "active",
        "volumeId": "v-3kZE7x6W",
        "diskId": "4c5d6e7f8091a2b3c4d5e6f708192a3b",
        "diskName": "sys-volume",
        "diskStatus": "InUse"
      }
    ]
  }
}
```

---

# 附录

## 响应结构待核对的接口

以下接口后端原样透传或字段为推断，不要假设结构：

| 接口 | 小节 | 状态 |
| --- | --- | --- |
| `ls/quota` | 2.14 | 文档未给响应结构 |
| `ls/volume/listSys` | 2.17 | 文档未给响应结构 |
| `image/list` | 3.2 | 字段按 glance 镜像常规返回推断 |

## 错误码与排查

接口 status 返回非 2xx 时，先看响应体里的 `code`（有时叫 `errorCode`）：命中下面「业务错误码」
就按对应话术和排查动作处理；没有 `code` 或未收录时，再按末尾「HTTP 状态码兜底」处理。
本节给出**面向最终用户的话术**和**排查动作**。

通用约束：

- 提示里**不要出现 endpoint 域名、host 或完整请求 URL**，环境只说「测试环境」「线上环境」。
- 不要把原始英文报文整段丢给用户，用下表的中文提示转述；需要时可附上 `code` 本身。
- 拿不准就先用只读接口（`describe` / `list` / `list-images` / `list-snapshots`）核对现状，
  不要凭猜测重试写操作。

### 业务错误码

| code | 含义 | 给用户的提示 | 排查动作 |
| --- | --- | --- | --- |
| `OperationDenied` | 实例上有未结束的操作，状态互斥 | LS 轻量应用服务器可能正在被操作中（关机 / 开机 / 续费 / 升级等），请检查后再试 | 用 `describe --ls-id` 看 `status`；等当前操作结束再重试，**不要连续重试写操作** |
| `Instance.PermissionDeny` | 请求里的资源查不到或不归当前账号 | LS 轻量应用服务器的某些资源可能不存在，请确认资源是否存在 | 核对 region 是否选对、id 类型是否正确（实例短 id vs uuid、镜像长 id vs 短 id）；用 `list` / `list-images` / `list-snapshots` 确认资源还在 |
| `Instance.NameInvalid` | 实例名或镜像名不合规 | LS 轻量应用服务器实例名称不符合预期，可能过短或者过长，请检查后重试 | 名称支持中英文、数字和 `-_ /.`，须以中文或字母开头，长度 1-65；让用户改名后重试 |
| `ServiceInternalError` | 服务端异常，**必须看 `message` 再判断** | 见下方 message 分支 | 先读 `message`，命中下表就按对应提示处理；没命中就告知用户服务端暂时异常、稍后重试，并保留 `code` 与 `message` 供排查 |

#### `ServiceInternalError` 的 message 分支

| message | 给用户的提示 | 排查动作 |
| --- | --- | --- |
| `Invalid Parameter Exception` | LS 轻量应用服务器请求的某些参数不对，请重试 | 逐项核对必填字段与可选字段默认值：`spec` 是否来自 `list-specs`、镜像 id 长短是否匹配操作、`duration` 是否在 1-120、`region` 是否合法、`name` 是否过长。改对参数再重试，别原样重发 |

遇到本节没有的 `code`：向用户说明失败原因未知、给出 `code` 和已核对过的参数，
并说明下一步要查什么，**不要编造原因，也不要反复重试写操作**。

### HTTP 状态码兜底

没有业务 `code`、或 `code` 未收录时，按 HTTP 状态码判断：

| HTTP | 错误码 | 排查方向 |
| --- | --- | --- |
| 400 | — | 必填字段缺失、可选字段默认值未带、json 结构错误、region 非法 |
| 403 | `SignatureDoesNotMatch` | AK/SK 错误或过期；STS 临时凭证过期或 `x-bce-security-token` 与签名不一致；签名漏了 `region` query 参数或 `x-bce-date`；账号无 LS 权限 |
| 404 | — | endpoint 选错环境（测试 / 线上）；id 类型传错（实例短 id vs uuid、镜像长 id vs 短 id）；region 选错，资源在别的地域；资源已删除 |
