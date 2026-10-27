#!/usr/bin/env node
// Call the Baidu Intelligent Cloud portal OpenAPI for LS, custom images, and snapshots.
//
// The portal OpenAPI (`/openapi/portal/ls/**`, `/openapi/portal/image/**`,
// `/openapi/portal/snapshot/**`) is not exposed by the official bce-cli, so this
// script signs requests locally with BCE auth v1.
//
// Credential resolution mirrors the official bce-cli / baiducloud-openapi runtime:
//   1. --profile          -> that named profile in ~/.bce/config.json
//   2. BCE_ACCESS_KEY_ID / BCE_SECRET_ACCESS_KEY (+ optional BCE_SECURITY_TOKEN / BCE_REGION)
//   3. the current profile in ~/.bce/config.json (AK mode, or OAuth/STS via ~/.bce/oauth)
// STS (temporary) credentials carry a session token, sent as `x-bce-security-token`
// and included in the signature — the LS portal accepts x-bce-* headers.
//
// Endpoint resolution order:  --endpoint > BCE_LS_ENDPOINT > default (cloud.baidu.com)
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = path.join(os.homedir(), ".bce", "config.json");
const DEFAULT_OAUTH_DIR = path.join(os.homedir(), ".bce", "oauth");
const DEFAULT_ENDPOINT = "cloud.baidu.com";
const OAUTH_RENEW_MARGIN = 60; // seconds
const SIGN_EXPIRATION = 1800; // seconds

const REGIONS = ["bj", "gz", "su", "hkg", "bd"];

const ERROR_HINTS = {
  400: "请求参数错误。请核对必填字段、可选字段的默认值和 json 结构。",
  403: "签名或权限校验失败。请检查 AK/SK 是否正确、是否过期，"
    + "以及该账号是否有 LS 相关权限；错误码 SignatureDoesNotMatch 表示签名不匹配。",
  404: "资源不存在。请检查实例 id、镜像 id、快照 id 和 endpoint 路径。",
};

const READ_ONLY = new Set([
  "list", "describe", "list-specs", "list-images", "list-custom-images",
  "list-snapshots", "list-system-volumes", "quota", "order-detail", "vnc",
  "remote-auth",
]);

// operation -> [[dest, flag, 中文名, 取值来源指引]]
// 缺失时脚本按这里的指引报错，调用方据此先查来源接口再追问用户。
const REQUIRED_FIELDS = {
  "create": [
    ["spec", "--spec", "套餐", "先运行 list-specs 查询可用套餐，把结果展示给用户选择"],
    ["image_id", "--image-id", "镜像 id",
      "先运行 list-images 查询可用镜像；仅当用户明确要用自定义镜像时改用 list-custom-images"],
  ],
  "rename": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["name", "--name", "新名称", "由用户提供；支持中英文、数字和 -_ /. ，须以中文或字母开头，长度 1-65"],
  ],
  "rebuild": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["image_id", "--image-id", "镜像 id",
      "先运行 list-images 或 list-custom-images 查询镜像，把结果展示给用户选择"],
  ],
  "stop": [["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"]],
  "start": [["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"]],
  "describe": [["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"]],
  "change-password": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["password", "--password", "新密码（明文）",
      "由用户提供；10-20 个字符，必须同时包含大写字母、小写字母、数字和特殊符号"],
  ],
  "renew": [
    ["instance_id", "--instance-id", "实例 instanceId",
      "先运行 list 或 describe，取响应中的 instanceId 字段"],
    ["duration", "--duration", "续费时长（月）", "由用户提供，范围 1-120 个月"],
  ],
  "resize": [
    ["instance_id", "--instance-id", "实例 instanceId",
      "先运行 list 或 describe，取响应中的 instanceId 字段"],
    ["spec", "--spec", "目标套餐", "先运行 list-specs 查询可用套餐，把结果展示给用户选择"],
  ],
  "assign-tags": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
  ],
  "remote-auth": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["username", "--username", "登录用户名", "由用户提供，Linux 通常是 root"],
    ["password", "--password", "登录密码（明文）", "由用户提供"],
  ],
  "order-detail": [
    ["order_id", "--order-id", "订单号",
      "取 create 响应的 orderId，或 describe 响应的 orderUuid"],
  ],
  "vnc": [["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"]],
  "create-image": [
    ["ls_id", "--ls-id", "源实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["name", "--name", "镜像名称", "由用户提供"],
  ],
  "delete-image": [
    ["image_id", "--image-id", "自定义镜像 id",
      "先运行 list-custom-images 查询自定义镜像，把结果展示给用户选择"],
  ],
  "create-snapshot": [
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
    ["name", "--name", "快照名称", "由用户提供"],
  ],
  "rollback-snapshot": [
    ["snapshot_id", "--snapshot-id", "快照 snapshotId（短 id）",
      "先运行 list-snapshots，取响应中的 snapshotId 字段"],
    ["ls_id", "--ls-id", "实例短 id", "先运行 list 查询实例，把结果展示给用户选择"],
  ],
  "delete-snapshots": [
    ["vm_snapshot", "--vm-snapshot", "instanceId:snapshotId 组合",
      "先运行 list-snapshots，instanceId 取 instanceUuid，snapshotId 取 snapshotId（短 id）"],
  ],
};

class LsApiError extends Error {}
class LsArgumentError extends Error {}

// --- redaction (object + string aware, mirrors baiducloud-openapi runtime) ---

const SENSITIVE_NAMES = new Set([
  "access_key_id", "access_key", "secret_access_key", "secret_key",
  "client_secret", "password", "admin_pass", "security_token", "session_token",
  "token", "secret", "authorization", "signature", "x_bce_security_token",
  "x_bce_session_token",
]);
const SENSITIVE_NAMES_COMPACT = new Set(
  [...SENSITIVE_NAMES].map((item) => item.replace(/_/g, "")),
);

function sensitiveName(name) {
  const normalized = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const compact = normalized.replace(/_/g, "");
  if (compact.startsWith("x") && SENSITIVE_NAMES_COMPACT.has(compact.slice(1))) {
    return true;
  }
  return (
    SENSITIVE_NAMES.has(normalized)
    || SENSITIVE_NAMES_COMPACT.has(compact)
    || (normalized.startsWith("x_") && SENSITIVE_NAMES.has(normalized.slice(2)))
  );
}

function redactString(value) {
  let result = value;
  result = result.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1<redacted>");
  result = result.replace(/bce-auth-v1\/[^\s,;]+/gi, "<redacted>");
  result = result.replace(/(x-bce-security-token\s*[:=]\s*)([^\s,;]+)/gi, "$1<redacted>");
  result = result.replace(
    /(access[_-]?key[_-]?id|secret[_-]?access[_-]?key|admin[_-]?pass|security[_-]?token|session[_-]?token|token|secret|signature)\s*([:=])\s*(["']?[^"'\s,;&}]+["']?)/gi,
    "$1$2<redacted>",
  );
  return result;
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // Redact sensitive keys, but keep empty values visible so a dry-run still
      // shows which optional defaults (e.g. an unset adminPass) were sent.
      out[key] = sensitiveName(key) && item !== "" && item != null ? "<redacted>" : redact(item);
    }
    return out;
  }
  if (typeof value !== "string") {
    return value;
  }
  const stripped = value.trim();
  if (stripped.startsWith("{") || stripped.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      return JSON.stringify(redact(parsed));
    }
  }
  return redactString(value);
}

// --- percent encoding / canonicalization (mirrors baiducloud-openapi runtime) ---

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function percentEncode(value, keepPercent = false) {
  const bytes = Buffer.from(String(value), "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (UNRESERVED.test(ch) || (keepPercent && ch === "%")) {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function quote(value) {
  return percentEncode(value, false);
}

function percentDecode(text, strict) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(ch, "utf8")) {
        bytes.push(b);
      }
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: strict });
  return decoder.decode(new Uint8Array(bytes));
}

function canonicalUri(pathValue) {
  let value = pathValue || "/";
  if (!value.startsWith("/")) {
    value = "/" + value;
  }
  return value
    .split("/")
    .map((segment) =>
      quote(segment).replace(/%25([0-9a-fA-F]{2})/g, (_, hex) => "%" + hex.toUpperCase()))
    .join("/");
}

function queryPairs(query) {
  if (!query) {
    return [];
  }
  const pairs = [];
  for (const item of query.split("&")) {
    if (!item) {
      continue;
    }
    const idx = item.indexOf("=");
    const key = idx === -1 ? item : item.slice(0, idx);
    const value = idx === -1 ? "" : item.slice(idx + 1);
    try {
      pairs.push([percentDecode(key, true), percentDecode(value, true)]);
    } catch {
      throw new LsApiError("query 必须是合法的 UTF-8 百分号编码");
    }
  }
  return pairs;
}

function canonicalQuery(query) {
  return queryPairs(query)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .sort()
    .join("&");
}

function canonicalHeaders(headers, signedHeaders) {
  const values = {};
  for (const [key, value] of Object.entries(headers)) {
    values[String(key).toLowerCase()] = String(value).trim();
  }
  const names = signedHeaders.map((name) => String(name).toLowerCase()).sort();
  const lines = [];
  for (const name of names) {
    if (!(name in values)) {
      throw new LsApiError("待签名头缺失：" + name);
    }
    lines.push(`${quote(name)}:${quote(values[name])}`);
  }
  return lines.join("\n");
}

function defaultSignedHeaders(headers) {
  // Sign host + x-bce-date plus every x-bce-* / content-* header present,
  // matching the portal's generic bce-auth-v1 validator.
  const names = new Set(["host", "x-bce-date"]);
  for (const name of Object.keys(headers)) {
    const lowered = String(name).toLowerCase();
    if (lowered.startsWith("x-bce-") || lowered.startsWith("content-")) {
      names.add(lowered);
    }
  }
  return [...names].sort();
}

function urlsplit(url) {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
  const scheme = (m && m[1]) || "";
  const netloc = (m && m[2]) || "";
  const pathPart = (m && m[3]) || "";
  const query = m && m[4] !== undefined ? m[4] : "";
  return { scheme, netloc, path: pathPart, query };
}

function hmacHex(key, message) {
  return crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(message, "utf8").digest("hex");
}

function isoTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function buildAuthorization(method, url, headers, secretAccessKey, accessKeyId, timestamp,
  { expiration = SIGN_EXPIRATION, signedHeaders = null } = {}) {
  const parsed = urlsplit(url);
  const requestHeaders = { ...headers };
  if (!("host" in requestHeaders) && !("Host" in requestHeaders)) {
    requestHeaders.host = parsed.netloc;
  }
  if (!Object.keys(requestHeaders).some((k) => k.toLowerCase() === "x-bce-date")) {
    requestHeaders["x-bce-date"] = timestamp;
  }
  const signed = signedHeaders === null ? defaultSignedHeaders(requestHeaders) : [...signedHeaders];
  const signedNames = signed.map((name) => String(name).toLowerCase()).sort().join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.path),
    canonicalQuery(parsed.query),
    canonicalHeaders(requestHeaders, signed),
  ].join("\n");
  const prefix = `bce-auth-v1/${accessKeyId}/${timestamp}/${expiration}`;
  const signingKey = hmacHex(secretAccessKey, prefix);
  const signature = hmacHex(signingKey, canonicalRequest);
  return `${prefix}/${signedNames}/${signature}`;
}

// --- credential resolution (mirrors baiducloud-openapi runtime) ---

class Credentials {
  constructor(accessKeyId, secretAccessKey, securityToken = null, region = null, profile = null) {
    if (!accessKeyId || !secretAccessKey) {
      throw new LsApiError(
        "未找到 AK/SK。请通过以下方式之一提供（不支持命令行传入密钥）：\n"
        + "  1. 环境变量：export BCE_ACCESS_KEY_ID=xxx BCE_SECRET_ACCESS_KEY=xxx"
        + "（STS 临时凭证再加 BCE_SECURITY_TOKEN）\n"
        + "  2. bce-cli 配置文件 ~/.bce/config.json 的 profile；OAuth/STS 登录用 'bce auth login'",
      );
    }
    this.access_key_id = accessKeyId;
    this.secret_access_key = secretAccessKey;
    this.security_token = securityToken;
    this.region = region;
    this.profile = profile;
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expandUser(value) {
  if (value === "~" || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function profileFromConfig(configPath, profileName = null) {
  let data;
  try {
    data = readJsonFile(configPath);
  } catch {
    throw new LsApiError(
      `无法读取 bce 凭证配置 ${configPath}。请设置环境变量 BCE_ACCESS_KEY_ID / `
      + "BCE_SECRET_ACCESS_KEY，或用 'bce auth login' 登录后重试。",
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new LsApiError("bce 凭证配置必须是一个对象");
  }
  const profiles = data.profiles;
  if (!Array.isArray(profiles)) {
    throw new LsApiError("bce 凭证配置里没有 profiles");
  }
  const selected = profileName || data.current || "default";
  for (const profile of profiles) {
    if (profile && typeof profile === "object" && profile.name === selected) {
      return [profile, selected];
    }
  }
  throw new LsApiError(`未找到名为 '${selected}' 的 bce profile`);
}

function parseIso8601(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const text = value.trim();
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(hasTz ? text : text + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function oauthStatePath(name, oauthDir = null) {
  const directory = oauthDir ? expandUser(String(oauthDir)) : DEFAULT_OAUTH_DIR;
  return path.join(directory, `${name}.json`);
}

function readOauthSts(statePath) {
  let data;
  try {
    data = readJsonFile(statePath);
  } catch (exc) {
    if (exc && exc.code === "ENOENT") {
      throw new LsApiError("未找到 OAuth 登录状态；请运行 'bce auth login'");
    }
    throw new LsApiError("无法读取 OAuth 登录状态");
  }
  if (data === null || typeof data !== "object" || typeof data.sts !== "object" || data.sts === null) {
    throw new LsApiError("OAuth 登录状态里没有 STS 临时凭证");
  }
  return data.sts;
}

function defaultOauthRenew(name, environ = process.env) {
  const binary = environ.BCE_CLI_BIN || "bce";
  const result = spawnSync(binary, ["auth", "refresh"], { timeout: 30000 });
  if (result.error) {
    throw new LsApiError("无法运行 bce 续期 OAuth 凭证；请运行 'bce auth login'");
  }
}

function oauthCredentials(name, region, { oauthDir = null, now = null, oauthRenew = undefined } = {}) {
  const currentNow = now || new Date();
  const renew = oauthRenew === undefined ? defaultOauthRenew : oauthRenew;
  let renewed = false;
  for (;;) {
    const sts = readOauthSts(oauthStatePath(name, oauthDir));
    const expiration = parseIso8601(sts.expiration);
    const expired = expiration === null
      || expiration.getTime() <= currentNow.getTime() + OAUTH_RENEW_MARGIN * 1000;
    if (expired && !renewed && renew !== null) {
      renew(name);
      renewed = true;
      continue;
    }
    if (expired) {
      throw new LsApiError("OAuth 凭证已过期；请重新运行 'bce auth login'");
    }
    return new Credentials(
      nonempty(sts.accessKeyId),
      nonempty(sts.secretAccessKey),
      nonempty(sts.sessionToken),
      region,
      name,
    );
  }
}

function credentialsFromProfile(profileData, selected, opts = {}) {
  if (String(profileData.mode ?? "").trim().toLowerCase() === "oauth") {
    return oauthCredentials(selected, nonempty(profileData.region), opts);
  }
  return new Credentials(
    nonempty(profileData.access_key_id),
    nonempty(profileData.secret_access_key),
    nonempty(profileData.security_token),
    nonempty(profileData.region),
    selected,
  );
}

function loadCredentials({ profile = null, configFile = null, environ = process.env,
  oauthDir = null, now = null, oauthRenew = undefined } = {}) {
  const opts = { oauthDir, now, oauthRenew };
  const configPath = configFile ? expandUser(String(configFile)) : DEFAULT_CONFIG;
  if (profile) {
    const [profileData, selected] = profileFromConfig(configPath, profile);
    return credentialsFromProfile(profileData, selected, opts);
  }
  const env = {
    access_key_id: nonempty(environ.BCE_ACCESS_KEY_ID),
    secret_access_key: nonempty(environ.BCE_SECRET_ACCESS_KEY),
    security_token: nonempty(environ.BCE_SECURITY_TOKEN),
    region: nonempty(environ.BCE_REGION),
  };
  const envHasAny = Object.values(env).some(Boolean);
  const envHasPair = Boolean(env.access_key_id) && Boolean(env.secret_access_key);
  if (envHasAny && !envHasPair) {
    throw new LsApiError("BCE_ACCESS_KEY_ID 和 BCE_SECRET_ACCESS_KEY 必须成对提供");
  }
  if (envHasPair) {
    return new Credentials(env.access_key_id, env.secret_access_key, env.security_token, env.region, null);
  }
  const [profileData, selected] = profileFromConfig(configPath, null);
  return credentialsFromProfile(profileData, selected, opts);
}

// --- LS request field policy ---

function checkRequired(args) {
  const missing = [];
  for (const [dest, flag, label, source] of REQUIRED_FIELDS[args.operation] || []) {
    const value = args[dest];
    if (value == null || (Array.isArray(value) && value.length === 0) || value === "") {
      missing.push(`  ${flag}（${label}）\n    取值来源：${source}`);
    }
  }
  if (missing.length) {
    throw new LsApiError(
      `${args.operation} 缺少必填参数，请先取得取值再重试：\n${missing.join("\n")}`,
    );
  }
}

function resolveEndpoint(args) {
  const endpoint = args.endpoint || process.env.BCE_LS_ENDPOINT || DEFAULT_ENDPOINT;
  let value = endpoint;
  const idx = value.indexOf("//");
  if (idx !== -1) {
    value = value.slice(idx + 2);
  }
  return value.split("/")[0];
}

function httpRequest(url, method, headers, payload, timeout) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", (err) => reject(err));
    request.setTimeout(timeout * 1000, () => {
      request.destroy(new Error("请求超时"));
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

const internals = { httpRequest, loadCredentials };

async function call(args, method, urlPath, body) {
  // Send one signed portal OpenAPI request, or preview it when --dry-run is set.
  const endpoint = resolveEndpoint(args);
  const url = `https://${endpoint}${urlPath}?region=${quote(String(args.region))}`;
  if (args.dry_run) {
    return {
      dryRun: true,
      method,
      url,
      body: body != null ? JSON.parse(redact(JSON.stringify(body))) : null,
    };
  }
  const creds = internals.loadCredentials({
    profile: args.profile,
    configFile: args.config_file,
    environ: process.env,
  });
  const timestamp = isoTimestamp(new Date());
  const payload = body != null ? Buffer.from(JSON.stringify(body), "utf8") : null;
  const headers = {
    Host: endpoint,
    "Content-Type": "application/json; charset=utf-8",
    "x-bce-date": timestamp,
  };
  if (creds.security_token) {
    headers["x-bce-security-token"] = creds.security_token;
  }
  if (payload) {
    headers["Content-Length"] = String(payload.length);
  }
  if (method === "POST" || method === "PUT") {
    headers["x-bce-content-sha256"] = crypto.createHash("sha256")
      .update(payload || Buffer.alloc(0)).digest("hex");
  }
  headers.Authorization = buildAuthorization(
    method, url, headers, creds.secret_access_key, creds.access_key_id, timestamp,
  );
  let response;
  try {
    response = await internals.httpRequest(url, method, headers, payload, args.timeout);
  } catch (err) {
    throw new LsApiError(`网络错误：${err.message}。请检查 endpoint ${endpoint} 是否可达。`);
  }
  if (response.status >= 400) {
    const detail = redact(response.body);
    const hint = ERROR_HINTS[response.status] || "";
    const suffix = hint ? `\n提示：${hint}` : "";
    throw new LsApiError(`HTTP ${response.status}: ${detail}${suffix}`);
  }
  if (!response.body.trim()) {
    return { success: true, status: 200 };
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new LsApiError(`响应不是合法 JSON：${redact(response.body.slice(0, 500))}`);
  }
}

function parseTags(values) {
  const tags = [];
  for (const value of values) {
    const idx = value.indexOf("=");
    const key = idx === -1 ? value : value.slice(0, idx);
    if (idx === -1 || !key) {
      throw new LsApiError(`标签格式应为 key=value：${value}`);
    }
    tags.push({ tagKey: key, tagValue: value.slice(idx + 1) });
  }
  return tags;
}

function parseSnapshotPairs(values) {
  const pairs = [];
  for (const value of values) {
    const idx = value.indexOf(":");
    const instanceId = idx === -1 ? "" : value.slice(0, idx);
    const snapshotId = idx === -1 ? "" : value.slice(idx + 1);
    if (idx === -1 || !instanceId || !snapshotId) {
      throw new LsApiError(
        `快照格式应为 instanceId:snapshotId：${value}`
        + "（instanceId 取 list-snapshots 的 instanceUuid，snapshotId 取短 id）",
      );
    }
    pairs.push({ instanceId, snapshotId });
  }
  return pairs;
}

function pageBody(args, extra) {
  const body = {
    pageNo: args.page_no,
    pageSize: args.page_size,
    order: args.order,
    orderBy: args.order_by,
  };
  return extra ? { ...body, ...extra } : body;
}

function build(args) {
  // Map one subcommand to [method, path, body] with all documented defaults filled.
  const operation = args.operation;
  switch (operation) {
    case "create":
      return ["POST", "/openapi/portal/ls/create", {
        spec: args.spec,
        imageId: args.image_id,
        instanceName: args.instance_name,
        purchaseCount: args.purchase_count,
        autoRenewTime: args.auto_renew,
        adminPass: args.admin_pass,
        billing: {
          paymentTiming: args.payment_timing,
          reservation: { reservationLength: args.reservation_length },
        },
      }];
    case "rename":
      return ["PUT", "/openapi/portal/ls/rename", { lsIds: args.ls_id, name: args.name }];
    case "rebuild":
      return ["POST", "/openapi/portal/ls/rebuild", { lsIds: args.ls_id, imageId: args.image_id }];
    case "stop":
      return ["PUT", "/openapi/portal/ls/stop", { lsIds: args.ls_id }];
    case "start":
      return ["PUT", "/openapi/portal/ls/start", { lsIds: args.ls_id }];
    case "describe":
      return ["GET", `/openapi/portal/ls/instance/${quote(args.ls_id)}`, null];
    case "list":
      return ["POST", "/openapi/portal/ls/list", pageBody(args)];
    case "change-password":
      return ["PUT", "/openapi/portal/ls/changePassword", {
        lsIds: args.ls_id,
        password: args.password,
      }];
    case "renew":
      return ["POST", "/openapi/portal/ls/renew", {
        items: args.instance_id.map((instanceId) => ({
          config: { duration: args.duration, instanceId, serviceType: "LS" },
        })),
      }];
    case "resize":
      return ["POST", "/openapi/portal/ls/resize", { spec: args.spec, instanceId: args.instance_id }];
    case "assign-tags":
      return ["POST", "/openapi/portal/ls/tag/assign", {
        lsId: args.ls_id,
        tags: parseTags(args.tag),
      }];
    case "list-specs":
      return ["POST", "/openapi/portal/ls/spec/list", null];
    case "remote-auth":
      return ["POST", "/openapi/portal/ls/remoteconn/auth", {
        lsIds: args.ls_id,
        netConnMethod: args.net_conn_method,
        username: args.username,
        password: args.password,
      }];
    case "quota": {
      const body = { objType: args.obj_type };
      if (args.ls_id) {
        body.lsId = args.ls_id;
      }
      return ["POST", "/openapi/portal/ls/quota", body];
    }
    case "order-detail":
      return ["POST", "/openapi/portal/ls/order/detail", { key: "ls", uuid: args.order_id }];
    case "vnc":
      return ["POST", "/openapi/portal/ls/vnc", { lsId: args.ls_id }];
    case "list-system-volumes":
      return ["GET", "/openapi/portal/ls/volume/listSys", null];
    case "list-images":
      return ["POST", "/openapi/portal/ls/image/list", {
        imageTypes: args.image_types,
        keywordType: args.keyword_type,
        keyword: args.keyword,
        orderBy: args.order_by,
        order: args.order,
      }];
    case "create-image":
      return ["POST", "/openapi/portal/image/create", { lsIds: args.ls_id, name: args.name }];
    case "list-custom-images":
      return ["POST", "/openapi/portal/image/list", pageBody(args, {
        keywordType: args.keyword_type,
        keyword: args.keyword,
        imageTypes: args.image_types,
        serviceFor: "LS",
        visitorService: "LS",
      })];
    case "delete-image":
      return ["POST", "/openapi/portal/image/delete", { imageIds: args.image_id }];
    case "create-snapshot":
      return ["POST", "/openapi/portal/snapshot/create", { lsId: args.ls_id, name: args.name }];
    case "rollback-snapshot":
      return ["POST", "/openapi/portal/snapshot/rollback", {
        snapshotId: args.snapshot_id,
        instanceId: args.ls_id,
      }];
    case "delete-snapshots":
      return ["POST", "/openapi/portal/snapshot/batchDelete", {
        vmSnapsots: parseSnapshotPairs(args.vm_snapshot),
      }];
    case "list-snapshots":
      return ["POST", "/openapi/portal/snapshot/list", pageBody(args)];
    default:
      throw new LsApiError(`未支持的操作：${operation}`);
  }
}

function integer(label) {
  return (value) => {
    const number = Number(value);
    if (!Number.isInteger(number)) {
      throw new LsArgumentError(`${label}必须是整数`);
    }
    return number;
  };
}

function integerRange(min, max, label) {
  return (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new LsArgumentError(`${label}必须在 ${min}-${max} 之间`);
    }
    return number;
  };
}

function commonOptions() {
  return [
    { flag: "--region", dest: "region", kind: "value", default: process.env.BCE_REGION || "bj", choices: REGIONS },
    { flag: "--endpoint", dest: "endpoint", kind: "value", default: null },
    { flag: "--config-file", dest: "config_file", kind: "value", default: null },
    { flag: "--profile", dest: "profile", kind: "value", default: null },
    { flag: "--timeout", dest: "timeout", kind: "value", default: 30, parse: integer("超时时间") },
    { flag: "--confirm", dest: "confirm", kind: "flag", default: false },
    { flag: "--dry-run", dest: "dry_run", kind: "flag", default: false },
  ];
}

function paging() {
  return [
    { flag: "--page-no", dest: "page_no", kind: "value", default: 1, parse: integer("页码") },
    { flag: "--page-size", dest: "page_size", kind: "value", default: 10, parse: integer("每页数量") },
    { flag: "--order", dest: "order", kind: "value", default: "", choices: ["", "desc", "asc"] },
    { flag: "--order-by", dest: "order_by", kind: "value", default: "" },
  ];
}

const OPERATIONS = {
  "create": [
    { flag: "--spec", dest: "spec", kind: "value", default: null },
    { flag: "--image-id", dest: "image_id", kind: "value", default: null },
    { flag: "--instance-name", dest: "instance_name", kind: "value", default: "" },
    { flag: "--purchase-count", dest: "purchase_count", kind: "value", default: 1, parse: integerRange(1, 50, "购买台数") },
    { flag: "--auto-renew", dest: "auto_renew", kind: "flag", default: false },
    { flag: "--admin-pass", dest: "admin_pass", kind: "value", default: "" },
    { flag: "--payment-timing", dest: "payment_timing", kind: "value", default: "prepay", choices: ["prepay"] },
    { flag: "--reservation-length", dest: "reservation_length", kind: "value", default: 1, parse: integer("购买时长") },
  ],
  "rename": [
    { flag: "--ls-id", dest: "ls_id", kind: "append", default: null },
    { flag: "--name", dest: "name", kind: "value", default: null },
  ],
  "rebuild": [
    { flag: "--ls-id", dest: "ls_id", kind: "append", default: null },
    { flag: "--image-id", dest: "image_id", kind: "value", default: null },
  ],
  "stop": [{ flag: "--ls-id", dest: "ls_id", kind: "append", default: null }],
  "start": [{ flag: "--ls-id", dest: "ls_id", kind: "append", default: null }],
  "describe": [{ flag: "--ls-id", dest: "ls_id", kind: "value", default: null }],
  "list": paging(),
  "change-password": [
    { flag: "--ls-id", dest: "ls_id", kind: "append", default: null },
    { flag: "--password", dest: "password", kind: "value", default: null },
  ],
  "renew": [
    { flag: "--instance-id", dest: "instance_id", kind: "append", default: null },
    { flag: "--duration", dest: "duration", kind: "value", default: null, parse: integerRange(1, 120, "续费时长") },
  ],
  "resize": [
    { flag: "--instance-id", dest: "instance_id", kind: "value", default: null },
    { flag: "--spec", dest: "spec", kind: "value", default: null },
  ],
  "assign-tags": [
    { flag: "--ls-id", dest: "ls_id", kind: "value", default: null },
    { flag: "--tag", dest: "tag", kind: "append", default: [] },
  ],
  "list-specs": [],
  "remote-auth": [
    { flag: "--ls-id", dest: "ls_id", kind: "append", default: null },
    { flag: "--username", dest: "username", kind: "value", default: null },
    { flag: "--password", dest: "password", kind: "value", default: null },
    { flag: "--net-conn-method", dest: "net_conn_method", kind: "value", default: "internal" },
  ],
  "quota": [
    { flag: "--ls-id", dest: "ls_id", kind: "value", default: null },
    { flag: "--obj-type", dest: "obj_type", kind: "value", default: "ls" },
  ],
  "order-detail": [
    { flag: "--order-id", dest: "order_id", kind: "value", default: null },
  ],
  "vnc": [{ flag: "--ls-id", dest: "ls_id", kind: "value", default: null }],
  "list-system-volumes": [],
  "list-images": [
    { flag: "--image-types", dest: "image_types", kind: "append", default: null },
    { flag: "--keyword-type", dest: "keyword_type", kind: "value", default: "status" },
    { flag: "--keyword", dest: "keyword", kind: "value", default: "active" },
    { flag: "--order", dest: "order", kind: "value", default: "", choices: ["", "desc", "asc"] },
    { flag: "--order-by", dest: "order_by", kind: "value", default: "" },
  ],
  "create-image": [
    { flag: "--ls-id", dest: "ls_id", kind: "append", default: null },
    { flag: "--name", dest: "name", kind: "value", default: null },
  ],
  "list-custom-images": [
    ...paging(),
    { flag: "--keyword-type", dest: "keyword_type", kind: "value", default: "status" },
    { flag: "--keyword", dest: "keyword", kind: "value", default: "active" },
    { flag: "--image-types", dest: "image_types", kind: "append", default: null },
  ],
  "delete-image": [
    { flag: "--image-id", dest: "image_id", kind: "append", default: null },
  ],
  "create-snapshot": [
    { flag: "--ls-id", dest: "ls_id", kind: "value", default: null },
    { flag: "--name", dest: "name", kind: "value", default: null },
  ],
  "rollback-snapshot": [
    { flag: "--snapshot-id", dest: "snapshot_id", kind: "value", default: null },
    { flag: "--ls-id", dest: "ls_id", kind: "value", default: null },
  ],
  "delete-snapshots": [
    { flag: "--vm-snapshot", dest: "vm_snapshot", kind: "append", default: [] },
  ],
  "list-snapshots": paging(),
};

function parseArgs(argv) {
  const tokens = argv || [];
  if (tokens.length === 0) {
    throw new LsArgumentError("缺少子命令");
  }
  const operation = tokens[0];
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, operation)) {
    throw new LsArgumentError(`未知子命令：${operation}`);
  }
  const defs = [...commonOptions(), ...OPERATIONS[operation]];
  const byFlag = new Map(defs.map((def) => [def.flag, def]));
  const args = { operation };
  for (const def of defs) {
    args[def.dest] = Array.isArray(def.default) ? [...def.default] : def.default;
  }
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    const def = byFlag.get(token);
    if (!def) {
      throw new LsArgumentError(`未知参数：${token}`);
    }
    if (def.kind === "flag") {
      args[def.dest] = true;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= tokens.length) {
      throw new LsArgumentError(`${token} 需要一个取值`);
    }
    let value = tokens[i];
    i += 1;
    if (def.choices && !def.choices.includes(value)) {
      throw new LsArgumentError(`${token} 取值无效：${value}`);
    }
    if (def.parse) {
      value = def.parse(value);
    }
    if (def.kind === "append") {
      if (args[def.dest] == null) {
        args[def.dest] = [];
      }
      args[def.dest].push(value);
    } else {
      args[def.dest] = value;
    }
  }
  return args;
}

function applyDefaults(args) {
  if (args.operation === "list-images" && args.image_types == null) {
    args.image_types = ["ls_application"];
  }
  if (args.operation === "list-custom-images" && args.image_types == null) {
    args.image_types = ["lsCustom"];
  }
  return args;
}

async function main(argv) {
  let args;
  try {
    args = applyDefaults(parseArgs(argv));
  } catch (err) {
    if (err instanceof LsArgumentError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (!READ_ONLY.has(args.operation) && !args.confirm) {
    process.stderr.write(`${args.operation} 是写操作，需要 --confirm\n`);
    return 2;
  }
  try {
    checkRequired(args);
    const [method, urlPath, body] = build(args);
    const result = await call(args, method, urlPath, body);
    // vnc / remote-auth intentionally return a login URL / connection token that
    // must be relayed verbatim; redacting it would replace the value the user needs.
    const rendered = args.operation === "vnc" || args.operation === "remote-auth"
      ? JSON.stringify(result, null, 2)
      : redact(JSON.stringify(result, null, 2));
    process.stdout.write(`${rendered}\n`);
  } catch (err) {
    if (err instanceof LsApiError) {
      process.stderr.write(`错误：${redact(err.message)}\n`);
      return 1;
    }
    throw err;
  }
  return 0;
}

export {
  LsApiError,
  LsArgumentError,
  Credentials,
  REGIONS,
  READ_ONLY,
  REQUIRED_FIELDS,
  ERROR_HINTS,
  redact,
  sensitiveName,
  checkRequired,
  resolveEndpoint,
  loadCredentials,
  buildAuthorization,
  canonicalQuery,
  canonicalUri,
  call,
  build,
  parseTags,
  parseSnapshotPairs,
  pageBody,
  parseArgs,
  applyDefaults,
  quote,
  main,
  internals,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
