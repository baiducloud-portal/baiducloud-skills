#!/usr/bin/env node
// baiducloud-gateway: pre-invocation version check + attribution reporting.
//
// This runtime runs before any baiducloud-* Skill is invoked. It (1) checks
// whether the target Skill has an update available via the generic Skills CLI
// and (2) reports a desensitized attribution event to an independent remote
// endpoint. The report request is signed with the local OAuth/STS credentials
// so the backend resolves the account id (aid) from the signature via IAM; the
// client never sends raw credentials or the account id in the payload.
//
// Zero third-party dependencies. Never spawns through a shell. All reporting is
// fail-open: a reporting or update-check failure never blocks the workflow.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Default reporting endpoint. Override with BAIDUCLOUD_SKILLS_TELEMETRY_ENDPOINT.
// MUST stay on an allowed Baidu Cloud host so request signing and the host
// allowlist below keep working.
const DEFAULT_ENDPOINT = 'https://cloud.baidu.com/api/baiducloud_skill/behavior';
const ALLOWED_SUFFIXES = ['baidubce.com', 'baidu-int.com', 'baidu.com'];
const UA_PRODUCT = 'BaiduCloudSkill/1.0';
const SOURCE_LAYERS = new Set(['bce-cli', 'openapi-runtime', 'qianfan-cli', 'bcecmd']);
const CALLER_TYPES = new Set(['human', 'ai_agent']);

// Coarse request intent and invocation outcome, used for intent-distribution and
// failure-reason analysis. Every value is an enum or a short identifier-like
// token: the report never carries the user's original text, error messages,
// resource ids, IPs, or parameter values.
const INTENTS = new Set([
  'query', // 查询诊断: read-only look-ups and diagnosis, nothing changes
  'operate', // 操作执行: create/update/delete/start/stop/deploy, send/run/ticket/config changes
  'purchase', // 购买交易: selection, pricing, order, renew, pay
  'generate', // 生成创作: content-producing work (picture book/PPT/poster/image/video/copy, translate/OCR/report)
  'consult', // 咨询问答: product/usage/docs questions that touch no resources
  'account', // 账户权限: login, real-name, auth, quota, keys, permissions
  'other', // unclassified; an unknown value is normalized to this
]);
const OUTCOMES = new Set(['success', 'failure']);
const ERROR_CATEGORIES = new Set([
  'auth', 'permission', 'invalid_param', 'not_found', 'conflict', 'quota',
  'throttled', 'network', 'timeout', 'server_error', 'dependency_missing',
  'user_cancelled', 'unknown',
]);
// Free-form fields are limited to short identifier-like tokens so user text
// cannot be smuggled into a report.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const EVENT_ID_RE = /^baiducloud-skills-[0-9a-fA-F-]{8,64}$/;
const HTTP_STATUS_RE = /^\d{3}$/;
// Service-side request id: an opaque identifier (UUID-like), 8-64 chars.
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

const OAUTH_DIR = process.env.BCE_IAM_OAUTH_DIR || path.join(os.homedir(), '.bce', 'oauth');
const OAUTH_PROFILE = 'oauth';
const OAUTH_RENEW_MARGIN = 60; // seconds

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function percentEncode(value, keepPercent = false) {
  const bytes = Buffer.from(String(value), 'utf8');
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (UNRESERVED.test(ch) || (keepPercent && ch === '%')) {
      out += ch;
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function percentDecode(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) {
        bytes.push(b);
      }
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function canonicalUri(pathValue) {
  let value = pathValue || '/';
  if (!value.startsWith('/')) {
    value = '/' + value;
  }
  return value
    .split('/')
    .map((segment) =>
      percentEncode(segment).replace(/%25([0-9a-fA-F]{2})/g, (_, hex) => '%' + hex.toUpperCase()),
    )
    .join('/');
}

// Canonicalize the query string the same way as openapi_runtime: decode each
// key/value, re-encode, and sort the resulting pairs. The reporting endpoint
// is operator-overridable and may carry a query, so this must stay correct.
function canonicalQuery(query) {
  if (!query) {
    return '';
  }
  const encoded = [];
  for (const item of query.split('&')) {
    if (!item) {
      continue;
    }
    const idx = item.indexOf('=');
    const key = idx === -1 ? item : item.slice(0, idx);
    const value = idx === -1 ? '' : item.slice(idx + 1);
    encoded.push(`${percentEncode(percentDecode(key))}=${percentEncode(percentDecode(value))}`);
  }
  return encoded.sort().join('&');
}

function urlsplit(url) {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
  const scheme = (m && m[1]) || '';
  const netloc = (m && m[2]) || '';
  const pathPart = (m && m[3]) || '';
  const query = m && m[4] !== undefined ? m[4] : '';
  // Strip userinfo (user:pass@) before deriving host/port. Without this a URL
  // like https://x.baidubce.com:0@attacker.com/ would pass the host allowlist
  // on "x.baidubce.com" while fetch connects to attacker.com — leaking the STS
  // token. Mirrors openapi_runtime's urlsplit.
  let hostport = netloc;
  let username = null;
  let password = null;
  const at = netloc.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = netloc.slice(0, at);
    hostport = netloc.slice(at + 1);
    const ui = userinfo.indexOf(':');
    if (ui !== -1) {
      username = userinfo.slice(0, ui);
      password = userinfo.slice(ui + 1);
    } else {
      username = userinfo;
    }
  }
  const ci = hostport.lastIndexOf(':');
  const hostname = (ci !== -1 ? hostport.slice(0, ci) : hostport).toLowerCase();
  const portRaw = ci !== -1 ? hostport.slice(ci + 1) : null;
  return { scheme, netloc, host: hostport, path: pathPart, query, hostname, portRaw, username, password };
}

function hostAllowed(host) {
  const normalized = host.replace(/\.+$/, '').toLowerCase();
  if (net.isIP(normalized) !== 0) {
    return false; // bare IP endpoints are never allowed
  }
  return ALLOWED_SUFFIXES.some((s) => normalized === s || normalized.endsWith('.' + s));
}

function ipv4ToInt(addr) {
  const parts = addr.split('.').map(Number);
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Net(ipInt, baseAddr, prefix) {
  const base = ipv4ToInt(baseAddr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

const V4_PRIVATE_NETS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['240.0.0.0', 4], ['255.255.255.255', 32],
];

// Reject private/reserved targets so a signed, STS-bearing report cannot be
// steered at an internal address via DNS rebinding on a baidu-suffixed name.
function isGlobalIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const ipInt = ipv4ToInt(address);
    return !V4_PRIVATE_NETS.some(([base, prefix]) => inV4Net(ipInt, base, prefix));
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') {
    return false;
  }
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return isGlobalIp(mapped);
    }
  }
  if (/^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f][0-9a-f]:/.test(lower)) {
    return false;
  }
  return true;
}

// Loopback hosts allowed only in dev mode so the gateway can post to a local
// report_sink.mjs for self-testing (localhost / 127.0.0.0/8 / ::1). Matches the
// literal hostname only (not ::ffff:127.x mapped forms); strips IPv6 brackets
// so a `[::1]` endpoint is recognized.
function isLoopbackHost(host) {
  const h = host.replace(/\.+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') {
    return true;
  }
  return net.isIP(h) === 4 && inV4Net(ipv4ToInt(h), '127.0.0.0', 8);
}

function hmacHex(key, message) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(message, 'utf8').digest('hex');
}

function isoTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function canonicalHeaders(headers, signedNames) {
  const values = {};
  for (const [key, value] of Object.entries(headers)) {
    values[String(key).toLowerCase()] = String(value).trim();
  }
  return signedNames
    .map((name) => `${percentEncode(name)}:${percentEncode(values[name] ?? '')}`)
    .join('\n');
}

function buildAuthorization(method, url, headers, credentials, timestamp, expiration = 1800) {
  const { secretAccessKey, accessKeyId } = credentials;
  const parsed = urlsplit(url);
  const signed = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .filter((n) => n === 'host' || n.startsWith('x-bce-') || n.startsWith('content-'))
    .sort();
  const signedNames = signed.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.path),
    canonicalQuery(parsed.query),
    canonicalHeaders(headers, signed),
  ].join('\n');
  const prefix = `bce-auth-v1/${accessKeyId}/${timestamp}/${expiration}`;
  const signingKey = hmacHex(secretAccessKey, prefix);
  const signature = hmacHex(signingKey, canonicalRequest);
  return `${prefix}/${signedNames}/${signature}`;
}

function parseIso8601(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const text = value.trim();
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(hasTz ? text : text + 'Z');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readStsState() {
  const statePath = path.join(OAUTH_DIR, `${OAUTH_PROFILE}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return data && typeof data === 'object' ? data.sts : null;
  } catch {
    return null;
  }
}

function stsHasKeys(sts) {
  return Boolean(sts && typeof sts === 'object' && sts.accessKeyId && sts.secretAccessKey);
}

// A missing/unparseable expiration is treated as unusable (never sign with a
// token whose validity cannot be confirmed), matching openapi_runtime.
function stsUsable(sts, now) {
  if (!stsHasKeys(sts)) {
    return false;
  }
  const expiration = parseIso8601(sts.expiration);
  return expiration !== null && expiration.getTime() > now.getTime() + OAUTH_RENEW_MARGIN * 1000;
}

// Best-effort STS renewal through the official CLI (`bce auth refresh`). Routes
// renewal to bce-cli instead of maintaining a second OAuth flow. Returns false
// (never throws) when bce is missing or the refresh exits non-zero.
//
// Behavior is intentionally a bit different from openapi_runtime's
// defaultOauthRenew (shorter timeout, stdio ignored, and a cooldown below)
// because preflight runs before every baiducloud-* Skill; keep the two in sync
// if bce's refresh contract changes.
function refreshOauth() {
  const binary = process.env.BCE_CLI_BIN || 'bce';
  const result = spawnSync(binary, ['auth', 'refresh'], { timeout: 15000, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// Cooldown so a stale-but-present token that refresh cannot restore does not
// spawn a (blocking) `bce auth refresh` on every single preflight. The marker
// lives beside the login state (scoped per oauth dir), not among credentials.
const RENEW_BACKOFF_MS = 5 * 60 * 1000;

function renewBackoffPath() {
  return path.join(OAUTH_DIR, '.gateway-renew-backoff');
}

function renewOnCooldown(now) {
  try {
    const stat = fs.statSync(renewBackoffPath());
    return now.getTime() - stat.mtimeMs < RENEW_BACKOFF_MS;
  } catch {
    return false;
  }
}

function noteRenewFailure() {
  try {
    fs.writeFileSync(renewBackoffPath(), 'renew failed');
  } catch {
    // best-effort; a missing marker only means we may retry sooner
  }
}

function clearRenewBackoff() {
  try {
    fs.rmSync(renewBackoffPath(), { force: true });
  } catch {
    // ignore
  }
}

// Load STS credentials from the local OAuth login state. Returns null (never
// throws) when login state is missing or unusable so reporting stays fail-open.
// When a logged-in state exists but the STS token is expired/near-expiry, try a
// single `bce auth refresh` and re-read before giving up — unless a recent
// attempt already failed to produce a usable token (cooldown), in which case
// skip the spawn. The cooldown is keyed on the final outcome (did we end up
// with a usable token?), not on the refresh exit code, so a no-op/0-exit
// refresh that leaves the token still expired also backs off.
function loadOauthCredentials(now = new Date(), { allowRenew = true } = {}) {
  let sts = readStsState();
  if (stsHasKeys(sts) && !stsUsable(sts, now) && allowRenew && !renewOnCooldown(now)) {
    refreshOauth(); // best-effort; judged by re-read below, not by exit code
    sts = readStsState();
    if (stsUsable(sts, now)) {
      clearRenewBackoff();
    } else {
      noteRenewFailure();
    }
  }
  if (!stsUsable(sts, now)) {
    return null;
  }
  return {
    access_key_id: String(sts.accessKeyId),
    secret_access_key: String(sts.secretAccessKey),
    security_token: sts.sessionToken ? String(sts.sessionToken) : null,
  };
}

function generateEventId() {
  return `baiducloud-skills-${crypto.randomUUID()}`;
}

// Accept a value only when it is an identifier-like token; otherwise fall back
// and record the field name so the caller can see what was ignored.
function pickToken(value, fallback, name, ignored) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (TOKEN_RE.test(value)) {
    return value;
  }
  ignored.push(name);
  return fallback;
}

// Resolve the five client-supplied attribution fields from CLI args and env.
// aid is intentionally absent: the backend derives it from the signed request.
// Free-form inputs are restricted to safe tokens/enums so user text cannot be
// smuggled into the report.
function resolveAttribution(opts, ignored = []) {
  const callerType = opts.callerType || process.env.BAIDUCLOUD_SKILL_CALLER_TYPE || 'ai_agent';
  const callerName = pickToken(
    opts.callerName || process.env.BAIDUCLOUD_SKILL_CALLER_NAME, 'unknown', 'caller_name', ignored,
  );
  const skillName = pickToken(
    opts.skill || process.env.BAIDUCLOUD_SKILL_SKILL_NAME, '', 'skill_name', ignored,
  );
  let sourceLayer = opts.sourceLayer || process.env.BAIDUCLOUD_SKILL_SOURCE_LAYER || '';
  if (sourceLayer && !SOURCE_LAYERS.has(sourceLayer)) {
    ignored.push('source_layer');
    sourceLayer = '';
  }
  let eventId = opts.eventId;
  if (eventId !== undefined && !EVENT_ID_RE.test(eventId)) {
    ignored.push('event_id');
    eventId = undefined;
  }
  return {
    caller_type: CALLER_TYPES.has(callerType) ? callerType : 'ai_agent',
    caller_name: callerName,
    skill_name: skillName,
    source_layer: sourceLayer,
    event_id: eventId || generateEventId(),
  };
}

// Resolve the optional intent / operation / outcome detail used for
// intent-distribution and failure-reason analysis. `event` is "result" when an
// outcome is supplied (the post-invocation report, joined to the earlier
// "invoke" event by event_id), otherwise "invoke". Only enums and short tokens
// are accepted; error fields are meaningful only for failures.
function resolveDetail(opts, ignored = []) {
  const detail = {};
  if (opts.intent !== undefined) {
    detail.intent = INTENTS.has(opts.intent) ? opts.intent : 'other';
  }
  if (opts.operation !== undefined) {
    if (OPERATION_RE.test(opts.operation)) {
      detail.operation = opts.operation;
    } else {
      ignored.push('operation');
    }
  }
  if (opts.outcome !== undefined) {
    if (OUTCOMES.has(opts.outcome)) {
      detail.outcome = opts.outcome;
    } else {
      ignored.push('outcome');
    }
  }
  // Error fields are failure-only.
  if (detail.outcome === 'failure') {
    detail.error_category = ERROR_CATEGORIES.has(opts.errorCategory) ? opts.errorCategory : 'unknown';
    if (opts.errorCode !== undefined) {
      if (TOKEN_RE.test(opts.errorCode)) {
        detail.error_code = opts.errorCode;
      } else {
        ignored.push('error_code');
      }
    }
  } else {
    if (opts.errorCategory !== undefined) {
      ignored.push('error_category');
    }
    if (opts.errorCode !== undefined) {
      ignored.push('error_code');
    }
  }
  // HTTP status (integer 100-599) and the service-side request id (opaque
  // identifier) are reported for every result, success or failure: the request
  // id lets the backend join the event to its own server-side logs (and look up
  // the full error on failures), so the client never sends error message text.
  // They only make sense once the call has run, so the pre-invocation "invoke"
  // event (no outcome) ignores them.
  if (detail.outcome) {
    if (opts.httpStatus !== undefined) {
      const status = HTTP_STATUS_RE.test(String(opts.httpStatus)) ? Number(opts.httpStatus) : NaN;
      if (status >= 100 && status <= 599) {
        detail.http_status = status;
      } else {
        ignored.push('http_status');
      }
    }
    if (opts.requestId !== undefined) {
      if (REQUEST_ID_RE.test(opts.requestId)) {
        detail.request_id = opts.requestId;
      } else {
        ignored.push('request_id');
      }
    }
  } else {
    if (opts.httpStatus !== undefined) {
      ignored.push('http_status');
    }
    if (opts.requestId !== undefined) {
      ignored.push('request_id');
    }
  }
  detail.event = detail.outcome ? 'result' : 'invoke';
  return detail;
}

function userAgent() {
  // The User-Agent carries only the product token. Every attribution field
  // (caller_type, caller_name, skill_name, source_layer, event_id, ...) lives in
  // the JSON payload instead.
  return UA_PRODUCT;
}

function endpointOf() {
  return process.env.BAIDUCLOUD_SKILLS_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT;
}

// Strip any user:pass@ userinfo before echoing an endpoint to stdout so a
// password mistakenly placed in the configured URL is never printed.
function safeEndpoint(url) {
  return String(url).replace(/(\/\/)[^/]*@/, '$1');
}

// Dev opt-in: allow posting to a local report_sink.mjs over http on a loopback
// host for self-testing. Off by default; never relaxes anything in normal use.
function reportDev() {
  return process.env.BAIDUCLOUD_SKILL_REPORT_DEV === '1';
}

// Assemble the signed POST for the attribution report. Returns {skipped} when
// the endpoint is unusable or credentials are unavailable (reporting is then
// skipped, never forced).
function buildSignedReport(attr, now = new Date(), { allowRenew = true, detail = {} } = {}) {
  const endpoint = endpointOf();
  const dev = reportDev();
  const parsed = urlsplit(endpoint);
  const scheme = parsed.scheme.toLowerCase();
  // Normal rule: https on an allowlisted Baidu Cloud host. Dev rule: http(s) on
  // a loopback host, only when BAIDUCLOUD_SKILL_REPORT_DEV=1.
  const normalOk = scheme === 'https' && hostAllowed(parsed.hostname);
  const devOk = dev && (scheme === 'http' || scheme === 'https') && isLoopbackHost(parsed.hostname);
  if (parsed.username || parsed.password || (!normalOk && !devOk)) {
    const need = dev
      ? 'endpoint must be an https Baidu Cloud host, or a loopback http(s) host in dev mode, without userinfo'
      : 'endpoint must be an https Baidu Cloud host without userinfo';
    return { skipped: need, endpoint };
  }
  const credentials = loadOauthCredentials(now, { allowRenew });
  if (!credentials) {
    return { skipped: "no usable OAuth/STS credentials (expired or not logged in); run 'bce auth login'", endpoint };
  }
  // Payload carries only non-sensitive attribution fields plus the enumerated
  // intent/operation/outcome detail. aid is resolved server-side from the
  // signature, so it is never placed here; no user text is ever included.
  const payload = JSON.stringify({
    caller_type: attr.caller_type,
    caller_name: attr.caller_name,
    skill_name: attr.skill_name,
    source_layer: attr.source_layer,
    event_id: attr.event_id,
    reported_at: isoTimestamp(now),
    ...detail,
  });
  const body = Buffer.from(payload, 'utf8');
  const timestamp = isoTimestamp(now);
  // Host must equal what undici will send: hostname, plus a port only when it
  // is not the scheme default (443 for https, 80 for http). This keeps the
  // signed `host` header aligned with the actual request.
  const port = parsed.portRaw;
  const defaultPort = scheme === 'http' ? '80' : '443';
  const hostHeader = port && port !== defaultPort ? `${parsed.hostname}:${port}` : parsed.hostname;
  const headers = {
    Host: hostHeader,
    'User-Agent': userAgent(),
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    'x-bce-date': timestamp,
    'x-bce-content-sha256': crypto.createHash('sha256').update(body).digest('hex'),
  };
  if (credentials.security_token) {
    headers['x-bce-security-token'] = credentials.security_token;
  }
  headers.Authorization = buildAuthorization(
    'POST', endpoint, headers,
    { secretAccessKey: credentials.secret_access_key, accessKeyId: credentials.access_key_id },
    timestamp,
  );
  return { endpoint, hostname: parsed.hostname, local: devOk, headers, body, payload };
}

// Fail-closed DNS guard for the credential-bearing report: resolve the host and
// refuse to send if it maps to a private/reserved address (DNS rebinding) or
// cannot be resolved. Injectable lookup keeps it testable without real DNS.
async function assertGlobalEndpoint(hostname, lookup) {
  const resolver = lookup || ((h) => dns.promises.lookup(h, { all: true }));
  const addresses = await resolver(hostname);
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) {
    throw new Error('endpoint did not resolve');
  }
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry.address;
    if (!isGlobalIp(address)) {
      throw new Error('endpoint resolves to a private or reserved address');
    }
  }
}

async function sendReport(signed, { timeoutMs = 5000, lookup = null } = {}) {
  // Fail-closed: never ship the STS-bearing request to a private/reserved or
  // unresolvable target, even if the host passed the suffix allowlist. In dev
  // mode a loopback endpoint (signed.local) is intentionally exempt.
  if (!signed.local) {
    await assertGlobalEndpoint(signed.hostname, lookup);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // undici (Node's fetch) manages Host and Content-Length itself and rejects
  // manual values. They stay in the signed header set (the server recomputes
  // the signature over the same host/length undici sends), but must not be
  // passed to fetch directly.
  const fetchHeaders = {};
  for (const [key, value] of Object.entries(signed.headers)) {
    const lowered = key.toLowerCase();
    if (lowered === 'host' || lowered === 'content-length') {
      continue;
    }
    fetchHeaders[key] = value;
  }
  try {
    const res = await fetch(signed.endpoint, {
      method: 'POST',
      headers: fetchHeaders,
      body: signed.body,
      signal: controller.signal,
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// Check whether the target Skill has an update via the generic Skills CLI.
// Fail-open: any missing subcommand or error yields {available:null}.
//
// NOTE: the exact `skills check` subcommand name and output contract are not
// yet confirmed, so results are marked experimental and parsed heuristically.
// Treat `available:true` as a soft hint, not an authoritative verdict.
function checkUpdate(skill) {
  if (!skill) {
    return { available: null, experimental: true, note: 'no skill name provided' };
  }
  const bin = process.env.GATEWAY_SKILLS_BIN || 'npx';
  const result = spawnSync(bin, ['skills', 'check', '--global', skill], {
    encoding: 'utf-8',
    timeout: 20000,
  });
  if (result.error || typeof result.status !== 'number') {
    return {
      available: null,
      experimental: true,
      note: 'skills check unavailable; update detection skipped',
    };
  }
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  // Heuristic marker match until the CLI output format is confirmed.
  const outdated = /\b(outdated|update available|needs? update|可更新|有更新)\b/i.test(out)
    || (result.status !== 0 && /update/i.test(out));
  return { available: Boolean(outdated), experimental: true, raw: out.trim().slice(0, 400) };
}

function parseArgs(argv) {
  const positional = [];
  const opts = { dryRun: false };
  const map = {
    '--skill': 'skill',
    '--source-layer': 'sourceLayer',
    '--caller-type': 'callerType',
    '--caller-name': 'callerName',
    '--event-id': 'eventId',
    '--intent': 'intent',
    '--operation': 'operation',
    '--outcome': 'outcome',
    '--error-category': 'errorCategory',
    '--error-code': 'errorCode',
    '--http-status': 'httpStatus',
    '--request-id': 'requestId',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') {
      opts.dryRun = true;
    } else if (token in map) {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`${token} requires a value`);
      }
      opts[map[token]] = argv[i];
    } else if (token.startsWith('--') && token.includes('=')) {
      const idx = token.indexOf('=');
      const key = token.slice(0, idx);
      if (!(key in map)) {
        throw new Error(`unknown argument: ${key}`);
      }
      opts[map[key]] = token.slice(idx + 1);
    } else if (token.startsWith('-')) {
      throw new Error(`unknown argument: ${token}`);
    } else {
      positional.push(token);
    }
  }
  opts.action = positional[0];
  return opts;
}

function reportDisabled() {
  return process.env.BAIDUCLOUD_SKILL_REPORT_DISABLE === '1';
}

// Run the attribution report. Always fail-open: returns a result object and
// never throws. When dry-run or disabled, the signed request is assembled (so
// callers/tests can inspect it) but not sent.
async function runReport(opts, now = new Date()) {
  const ignored = [];
  const attribution = resolveAttribution(opts, ignored);
  const detail = resolveDetail(opts, ignored);
  const out = { action: 'report', attribution, detail, user_agent: userAgent() };
  if (ignored.length) {
    // Names only (never values): tells the caller which inputs were rejected.
    out.ignored_fields = [...new Set(ignored)];
  }
  if (reportDisabled()) {
    out.report = { sent: false, reason: 'reporting disabled by BAIDUCLOUD_SKILL_REPORT_DISABLE' };
    return out;
  }
  // dry-run must stay side-effect free: do not renew (which would rotate the
  // local STS state) when only assembling the request for inspection.
  const signed = buildSignedReport(attribution, now, { allowRenew: !opts.dryRun, detail });
  if (signed.skipped) {
    out.report = { sent: false, reason: signed.skipped, endpoint: safeEndpoint(signed.endpoint) };
    return out;
  }
  // Expose the assembled request shape without leaking credential values.
  out.report = {
    sent: false,
    endpoint: safeEndpoint(signed.endpoint),
    signed_headers: Object.keys(signed.headers).sort(),
    payload: JSON.parse(signed.payload),
  };
  if (opts.dryRun) {
    out.report.reason = 'dry-run';
    return out;
  }
  try {
    // Best-effort telemetry: bound the wait so a slow/unreachable endpoint
    // never blocks the downstream Skill for long. Override with
    // BAIDUCLOUD_SKILL_REPORT_TIMEOUT_MS.
    const timeoutMs = Number(process.env.BAIDUCLOUD_SKILL_REPORT_TIMEOUT_MS) || 2000;
    const { status } = await sendReport(signed, { timeoutMs });
    out.report.sent = true;
    out.report.status = status;
  } catch (exc) {
    out.report.sent = false;
    out.report.reason = `report request failed: ${(exc && exc.name) || 'error'}`;
  }
  return out;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(String((exc && exc.message) || exc) + '\n');
    return 2;
  }
  if (!['report', 'preflight', 'check-update'].includes(opts.action)) {
    process.stderr.write('action must be one of: report, preflight, check-update\n');
    return 2;
  }
  if (opts.sourceLayer && !SOURCE_LAYERS.has(opts.sourceLayer)) {
    process.stderr.write(
      `--source-layer must be one of: ${[...SOURCE_LAYERS].join(', ')}\n`,
    );
    return 2;
  }
  let result;
  if (opts.action === 'check-update') {
    result = { action: 'check-update', skill: opts.skill || null, update: checkUpdate(opts.skill) };
  } else if (opts.action === 'report') {
    result = await runReport(opts);
  } else {
    const update = checkUpdate(opts.skill);
    const reported = await runReport(opts);
    result = { action: 'preflight', update, ...reported };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0; // fail-open: never block the workflow on gateway outcomes
}

const internals = {
  buildAuthorization, buildSignedReport, resolveAttribution, resolveDetail, userAgent,
  loadOauthCredentials, checkUpdate, generateEventId, sendReport, main,
};

export { internals, main };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(String((exc && exc.stack) || exc) + '\n');
      process.exit(1);
    });
}
