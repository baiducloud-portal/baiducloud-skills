#!/usr/bin/env node
// Small, testable runtime for Baidu Cloud OpenAPI-only services.
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = path.join(os.homedir(), ".bce", "config.json");
const DEFAULT_OAUTH_DIR = path.join(os.homedir(), ".bce", "oauth");
const OAUTH_RENEW_MARGIN = 60; // seconds
const FIXED_OAUTH_PROFILE = "oauth";
const DEFAULT_MAX_RESPONSE = 10 * 1024 * 1024;
const DEFAULT_MAX_REQUEST = 70 * 1024 * 1024;
const BODY_SUMMARY_THRESHOLD = 1024 * 1024;
const DEFAULT_TIMEOUT = 15; // seconds
const ALLOWED_SUFFIXES = ["baidubce.com", "baidu-int.com", "baidu.com"];
const ALLOWED_SCHEMES = ["https", "http"];
const ALLOWED_PORT_MIN = 8000;
const ALLOWED_PORT_MAX = 8999; // allowed high-port range is 8000-8999 inclusive

const SENSITIVE_NAMES = new Set([
  "access_key_id", "access_key", "secret_access_key", "secret_key",
  "client_secret", "password", "security_token", "session_token", "token",
  "secret", "authorization", "signature", "x_bce_security_token",
  "x_bce_session_token",
]);
const SENSITIVE_NAMES_COMPACT = new Set(
  [...SENSITIVE_NAMES].map((item) => item.replace(/_/g, "")),
);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

class RuntimeErrorBase extends Error {}
class CredentialError extends RuntimeErrorBase {}
class RequestPolicyError extends RuntimeErrorBase {}
class OpenAPIError extends RuntimeErrorBase {}

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

function percentEncode(value, keepPercent = false) {
  // Percent-encode UTF-8 bytes per RFC 3986, leaving only A-Za-z0-9 - _ . ~
  // unescaped (and % when keepPercent), with uppercase hex.
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
  // Decode %XX byte sequences; a lone % (not followed by two hex digits) stays
  // literal. When strict, invalid UTF-8 raises; otherwise invalid bytes are
  // replaced with the Unicode replacement character.
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
      quote(segment).replace(/%25([0-9a-fA-F]{2})/g, (_, hex) => "%" + hex.toUpperCase()),
    )
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
      throw new RequestPolicyError("query must use valid UTF-8 percent encoding");
    }
  }
  return pairs;
}

function canonicalQuery(query) {
  const encoded = queryPairs(query)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .sort();
  return encoded.join("&");
}

function normalizeQuery(query) {
  // Complete percent encoding while preserving query order and flag form.
  const items = [];
  for (const item of query.split("&")) {
    if (!item) {
      continue;
    }
    const idx = item.indexOf("=");
    const key = idx === -1 ? item : item.slice(0, idx);
    const hasValue = idx !== -1;
    const value = hasValue ? item.slice(idx + 1) : "";
    const normalizedKey = percentEncode(key, true).replace(/%(?![0-9a-fA-F]{2})/g, "%25");
    const normalizedValue = percentEncode(value, true).replace(/%(?![0-9a-fA-F]{2})/g, "%25");
    items.push(normalizedKey + (hasValue ? "=" + normalizedValue : ""));
  }
  return items.join("&");
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
      throw new RequestPolicyError("signed header is missing: " + name);
    }
    lines.push(`${quote(name)}:${quote(values[name])}`);
  }
  return lines.join("\n");
}

function defaultSignedHeaders(headers) {
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
  // Split a URL into raw components without normalization, preserving the exact
  // bytes needed for signing and policy checks.
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
  const scheme = (m && m[1]) || "";
  const netloc = (m && m[2]) || "";
  const pathPart = (m && m[3]) || "";
  const query = m && m[4] !== undefined ? m[4] : "";
  const fragment = m && m[5] !== undefined ? m[5] : "";

  let hostport = netloc;
  let username = null;
  let password = null;
  const at = netloc.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = netloc.slice(0, at);
    hostport = netloc.slice(at + 1);
    const ci = userinfo.indexOf(":");
    if (ci !== -1) {
      username = userinfo.slice(0, ci);
      password = userinfo.slice(ci + 1);
    } else {
      username = userinfo;
    }
  }

  let hostname = hostport;
  let portRaw = null;
  if (hostport.startsWith("[")) {
    const rb = hostport.indexOf("]");
    hostname = hostport.slice(1, rb);
    const rest = hostport.slice(rb + 1);
    if (rest.startsWith(":")) {
      portRaw = rest.slice(1);
    }
  } else {
    const ci = hostport.lastIndexOf(":");
    if (ci !== -1) {
      hostname = hostport.slice(0, ci);
      portRaw = hostport.slice(ci + 1);
    }
  }
  return {
    scheme, netloc, path: pathPart, query, fragment,
    username, password, hostname: hostname.toLowerCase(), portRaw,
  };
}

function urlunsplit(scheme, netloc, pathValue, query, fragment) {
  let result = "";
  if (scheme) {
    result += scheme + "://";
  } else if (netloc) {
    result += "//";
  }
  result += netloc + pathValue;
  if (query) {
    result += "?" + query;
  }
  if (fragment) {
    result += "#" + fragment;
  }
  return result;
}

function hostAllowed(host, allowedSuffixes = ALLOWED_SUFFIXES) {
  const normalized = host.replace(/\.+$/, "").toLowerCase();
  if (net.isIP(normalized) !== 0) {
    return false;
  }
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith("." + suffix),
  );
}

function parsePort(portRaw) {
  if (portRaw === null || portRaw === "") {
    return null;
  }
  if (!/^\d+$/.test(portRaw)) {
    throw new RequestPolicyError("URL is invalid");
  }
  const port = parseInt(portRaw, 10);
  if (port > 65535) {
    throw new RequestPolicyError("URL is invalid");
  }
  return port;
}

function validateUrl(url, allowedSuffixes = ALLOWED_SUFFIXES) {
  const parsed = urlsplit(url);
  const port = parsePort(parsed.portRaw);
  if (!ALLOWED_SCHEMES.includes(parsed.scheme.toLowerCase())) {
    throw new RequestPolicyError("only HTTP or HTTPS URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new RequestPolicyError("URL user information is not allowed");
  }
  if (parsed.fragment) {
    throw new RequestPolicyError("URL fragments are not allowed");
  }
  if (!parsed.hostname || !hostAllowed(parsed.hostname, allowedSuffixes)) {
    throw new RequestPolicyError("URL host is not an allowed Baidu Cloud endpoint");
  }
  if (port !== null && port !== 443 && port !== 80
    && !(port >= ALLOWED_PORT_MIN && port <= ALLOWED_PORT_MAX)) {
    throw new RequestPolicyError("only standard ports or 8000-9000 are allowed");
  }
  return parsed;
}

function ipv4ToInt(addr) {
  const parts = addr.split(".").map(Number);
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]);
}

function inV4Net(ipInt, baseAddr, prefix) {
  const base = ipv4ToInt(baseAddr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

const V4_PRIVATE_NETS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 29], ["192.0.0.170", 31], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["240.0.0.0", 4], ["255.255.255.255", 32],
];

function isGlobalIp(address) {
  // An address is global when it is not a shared/CGNAT (100.64.0.0/10) address
  // nor otherwise private/reserved.
  const family = net.isIP(address);
  if (family === 4) {
    const ipInt = ipv4ToInt(address);
    if (inV4Net(ipInt, "100.64.0.0", 10)) {
      return false;
    }
    return !V4_PRIVATE_NETS.some(([base, prefix]) => inV4Net(ipInt, base, prefix));
  }
  // IPv6: treat unspecified, loopback, link-local, unique-local, IPv4-mapped
  // (via the embedded IPv4) and the documentation range as non-global.
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") {
    return false;
  }
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) {
      return isGlobalIp(mapped);
    }
  }
  if (/^2001:0*db8:/.test(lower)) {
    return false;
  }
  if (/^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f][0-9a-f]:/.test(lower)) {
    return false;
  }
  return true;
}

async function resolveHostname(host, allowedSuffixes = ALLOWED_SUFFIXES) {
  let addresses;
  try {
    addresses = await internals.dnsLookup(host);
  } catch {
    throw new RequestPolicyError("endpoint hostname cannot be resolved");
  }
  const hostLower = host.replace(/\.+$/, "").toLowerCase();
  const privateAllowed = allowedSuffixes.some(
    (suffix) => hostLower === suffix || hostLower.endsWith("." + suffix),
  );
  for (const entry of addresses) {
    if (!isGlobalIp(entry.address) && !privateAllowed) {
      throw new RequestPolicyError("endpoint resolves to a private or reserved address");
    }
  }
}

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
    /(access[_-]?key[_-]?id|secret[_-]?access[_-]?key|security[_-]?token|session[_-]?token|token|secret|signature)\s*([:=])\s*(["']?[^"'\s,;&}]+["']?)/gi,
    "$1$2<redacted>",
  );
  result = result.replace(
    /([?&])([^=&\s]+)=(<[^>\s]*>|[^&\s<]+)/gi,
    (match, sep, key) => (sensitiveName(percentDecode(key, false)) ? sep + key + "=<redacted>" : match),
  );
  const stripped = value.trim();
  if (!/^https?:\/\/\S+$/i.test(stripped)) {
    return result;
  }
  try {
    const parsed = urlsplit(result);
    if (parsed.query) {
      const queryItems = [];
      let changed = false;
      for (const item of parsed.query.split("&")) {
        const idx = item.indexOf("=");
        const key = idx === -1 ? item : item.slice(0, idx);
        let value = idx === -1 ? "" : item.slice(idx + 1);
        if (sensitiveName(percentDecode(key, false))) {
          value = "<redacted>";
          changed = true;
        }
        queryItems.push(key + (idx === -1 ? "" : "=" + value));
      }
      if (changed) {
        result = urlunsplit(parsed.scheme, parsed.netloc, parsed.path, queryItems.join("&"), parsed.fragment);
      }
    }
  } catch {
    // leave result as-is
  }
  return result;
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sensitiveName(key) ? "<redacted>" : redact(item);
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

class Credentials {
  constructor(accessKeyId, secretAccessKey, securityToken = null, region = null, profile = null) {
    if (!accessKeyId || !secretAccessKey) {
      throw new CredentialError("access key ID and secret access key are required");
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function profileFromConfig(configPath, profileName = null) {
  let data;
  try {
    data = readJsonFile(configPath);
  } catch {
    throw new CredentialError("cannot read BCE profile configuration");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new CredentialError("BCE profile configuration must be an object");
  }
  const profiles = data.profiles;
  if (!Array.isArray(profiles)) {
    throw new CredentialError("BCE profile configuration has no profiles");
  }
  const selected = profileName || data.current || "default";
  for (const profile of profiles) {
    if (profile && typeof profile === "object" && profile.name === selected) {
      return [profile, selected];
    }
  }
  throw new CredentialError("requested BCE profile was not found");
}

function parseIso8601(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  // Only the RFC3339 `...Z` (or explicit offset) form emitted by the bce STS
  // response is guaranteed to parse; anything else falls back to null and is
  // then treated as expired (triggering a renewal attempt).
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
      throw new CredentialError("OAuth login state not found; run 'bce auth login'");
    }
    throw new CredentialError("cannot read OAuth login state");
  }
  if (data === null || typeof data !== "object" || typeof data.sts !== "object" || data.sts === null) {
    throw new CredentialError("OAuth login state does not contain STS credentials");
  }
  return data.sts;
}

function defaultOauthRenew(name, environ = process.env) {
  const binary = environ.BCE_CLI_BIN || "bce";
  const result = spawnSync(binary, ["auth", "refresh"], { timeout: 30000 });
  if (result.error) {
    throw new CredentialError(
      "could not run bce to renew OAuth credentials; run 'bce auth login'",
    );
  }
}

function expandUser(value) {
  if (value === "~" || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
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
      throw new CredentialError(
        "OAuth credentials are expired; run 'bce auth login' to sign in again",
      );
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
  const envValues = {
    access_key_id: nonempty(environ.BCE_ACCESS_KEY_ID),
    secret_access_key: nonempty(environ.BCE_SECRET_ACCESS_KEY),
    security_token: nonempty(environ.BCE_SECURITY_TOKEN),
    region: nonempty(environ.BCE_REGION),
  };
  const envHasAny = Object.values(envValues).some(Boolean);
  const envHasPair = Boolean(envValues.access_key_id) && Boolean(envValues.secret_access_key);
  if (envHasAny && !envHasPair) {
    throw new CredentialError("BCE_ACCESS_KEY_ID and BCE_SECRET_ACCESS_KEY must be provided together");
  }
  if (envHasPair) {
    return new Credentials(
      envValues.access_key_id, envValues.secret_access_key,
      envValues.security_token, envValues.region, null,
    );
  }
  const [profileData, selected] = profileFromConfig(configPath, profile);
  return credentialsFromProfile(profileData, selected, opts);
}

function whichExecutable(binary) {
  if (path.basename(binary) !== binary) {
    return fs.existsSync(binary) ? binary : null;
  }
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep searching
    }
  }
  return null;
}

function requireBceCli(environ = process.env) {
  const binary = environ.BCE_CLI_BIN || "bce";
  const resolved = whichExecutable(binary);
  if (!resolved) {
    throw new CredentialError(
      "bce-cli is not installed; install it from https://github.com/baidubce/bce-cli first",
    );
  }
  return resolved;
}

function findNamedProfile(configPath, name) {
  let data;
  try {
    data = readJsonFile(configPath);
  } catch (exc) {
    if (exc && exc.code === "ENOENT") {
      return null;
    }
    throw new CredentialError("cannot read BCE profile configuration");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new CredentialError("BCE profile configuration must be an object");
  }
  if (!Array.isArray(data.profiles)) {
    return null;
  }
  for (const profile of data.profiles) {
    if (profile && typeof profile === "object" && profile.name === name) {
      return profile;
    }
  }
  return null;
}

function loadOauthCredentials({ configFile = null, oauthDir = null, now = null,
  oauthRenew = undefined, environ = process.env } = {}) {
  requireBceCli(environ);
  const configPath = configFile ? expandUser(String(configFile)) : DEFAULT_CONFIG;
  const profileData = findNamedProfile(configPath, FIXED_OAUTH_PROFILE);
  if (profileData === null || String(profileData.mode ?? "").trim().toLowerCase() !== "oauth") {
    throw new CredentialError(
      `no '${FIXED_OAUTH_PROFILE}' OAuth profile found; run 'bce auth login' to sign in`,
    );
  }
  return oauthCredentials(FIXED_OAUTH_PROFILE, nonempty(profileData.region), { oauthDir, now, oauthRenew });
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
  { expiration = 1800, signedHeaders = null } = {}) {
  const parsed = urlsplit(url);
  const requestHeaders = { ...headers };
  if (!("host" in requestHeaders)) {
    requestHeaders.host = parsed.netloc;
  }
  if (!("x-bce-date" in requestHeaders)) {
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

// Only true redirect status codes are rejected (mirroring urllib's
// HTTPRedirectHandler). Other 3xx such as 304 Not Modified return normally.
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function classifyResponseStatus(status) {
  if (REDIRECT_STATUS.has(status)) {
    return "redirect";
  }
  if (status >= 400) {
    return "error";
  }
  return "ok";
}

class NoRedirect {
  redirectRequest() {
    throw new RequestPolicyError("redirects are not allowed");
  }
}

class Transport {
  constructor({ timeout = DEFAULT_TIMEOUT, maxResponse = DEFAULT_MAX_RESPONSE } = {}) {
    this.timeout = timeout;
    this.maxResponse = maxResponse;
    this.opener = { open: (request) => this._open(request) };
  }

  async send(method, url, headers, body) {
    try {
      const { status, headers: responseHeaders, payload } = await this.opener.open({
        method, url, headers, body, timeout: this.timeout,
      });
      // Fallback for custom transports; the built-in `_open` already caps the
      // response size during streaming, so this never trips for it.
      if (payload.length > this.maxResponse) {
        throw new OpenAPIError("response exceeds configured size limit");
      }
      return [status, responseHeaders, payload];
    } catch (exc) {
      if (exc instanceof RequestPolicyError || exc instanceof OpenAPIError) {
        throw exc;
      }
      throw new OpenAPIError("HTTPS request failed: " + redact(String((exc && exc.message) || exc)));
    }
  }

  _open({ method, url, headers, body, timeout }) {
    const parsed = urlsplit(url);
    const client = parsed.scheme.toLowerCase() === "http" ? http : https;
    const options = { method, headers, timeout: timeout * 1000 };
    const maxResponse = this.maxResponse;
    return new Promise((resolve, reject) => {
      const req = client.request(url, options, (res) => {
        const chunks = [];
        let total = 0;
        let aborted = false;
        res.on("data", (chunk) => {
          // Bounded read: stop as soon as the response exceeds the limit
          // instead of buffering an arbitrarily large body first.
          total += chunk.length;
          if (total > maxResponse) {
            aborted = true;
            req.destroy();
            reject(new OpenAPIError("response exceeds configured size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) {
            return;
          }
          const payload = Buffer.concat(chunks);
          const status = res.statusCode;
          const kind = classifyResponseStatus(status);
          if (kind === "redirect") {
            reject(new RequestPolicyError("redirects are not allowed"));
          } else if (kind === "error") {
            reject(new OpenAPIError(`HTTP ${status}: ${redact(payload.toString("utf8"))}`));
          } else {
            resolve({ status, headers: res.headers, payload });
          }
        });
      });
      req.on("error", (exc) => reject(exc));
      req.on("timeout", () => req.destroy(new Error("request timed out")));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

const RUNTIME_MANAGED_HEADERS = new Set([
  "authorization", "x-bce-security-token", "x-bce-content-sha256", "host", "x-bce-date",
]);

async function request(method, url, credentials, {
  body = "", headers = null, confirm = false, dryRun = false, transport = null, now = null,
  maxResponse = DEFAULT_MAX_RESPONSE, maxRequest = DEFAULT_MAX_REQUEST, timeout = DEFAULT_TIMEOUT,
  resolveDns = true, bodySummary = false, allowedSuffixes = ALLOWED_SUFFIXES } = {}) {
  method = method.toUpperCase();
  if (!SAFE_METHODS.has(method) && !WRITE_METHODS.has(method)) {
    throw new RequestPolicyError("unsupported HTTP method");
  }
  if (timeout <= 0 || maxResponse <= 0 || maxRequest <= 0) {
    throw new RequestPolicyError("timeout, max response, and max request must be positive");
  }
  let parsed = validateUrl(url, allowedSuffixes);
  if (WRITE_METHODS.has(method) && !confirm) {
    throw new RequestPolicyError("state-changing requests require explicit confirmation");
  }
  const requestHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    requestHeaders[String(key)] = String(value);
  }
  if (Object.keys(requestHeaders).some((key) => RUNTIME_MANAGED_HEADERS.has(key.toLowerCase()))) {
    throw new RequestPolicyError("caller must not provide runtime-managed headers");
  }
  if (url.includes("?") && queryPairs(parsed.query).some(([key]) => sensitiveName(key))) {
    throw new RequestPolicyError("credentials and signatures must not be placed in the query string");
  }
  const currentNow = now || new Date();
  const timestamp = isoTimestamp(currentNow);
  if (!("Host" in requestHeaders)) {
    requestHeaders.Host = parsed.netloc;
  }
  if (!("x-bce-date" in requestHeaders)) {
    requestHeaders["x-bce-date"] = timestamp;
  }
  if (credentials.security_token) {
    requestHeaders["x-bce-security-token"] = credentials.security_token;
  }
  const bodyBuffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (!Buffer.isBuffer(bodyBuffer)) {
    throw new RequestPolicyError("request body must be text or bytes");
  }
  if (bodyBuffer.length > maxRequest) {
    throw new RequestPolicyError("request body exceeds configured size limit");
  }
  const bodySha256 = crypto.createHash("sha256").update(bodyBuffer).digest("hex");
  if (bodyBuffer.length
    && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-length")) {
    requestHeaders["Content-Length"] = String(bodyBuffer.length);
  }
  // Documented BCE POST/PUT operations use this digest as a signed header.
  if (method === "POST" || method === "PUT") {
    requestHeaders["x-bce-content-sha256"] = bodySha256;
  }
  url = normalizedUrl(parsed);
  parsed = validateUrl(url, allowedSuffixes);
  if (resolveDns && !dryRun) {
    await internals.resolveHostname(parsed.hostname, allowedSuffixes);
  }
  requestHeaders.Authorization = buildAuthorization(
    method, url, requestHeaders, credentials.secret_access_key, credentials.access_key_id, timestamp,
  );
  let bodyField = "";
  if (bodyBuffer.length && (bodySummary || bodyBuffer.length > BODY_SUMMARY_THRESHOLD)) {
    bodyField = { omitted: true, length: bodyBuffer.length, sha256: bodySha256 };
  } else if (bodyBuffer.length) {
    bodyField = redact(bodyBuffer.toString("utf8"));
  }
  const result = {
    method,
    url: redact(url),
    headers: redact(requestHeaders),
    body: bodyField,
    profile: credentials.profile,
    region: credentials.region,
    dns_validation: dryRun ? "skipped for dry-run" : (resolveDns ? "passed" : "skipped by caller"),
  };
  if (dryRun) {
    return result;
  }
  const activeTransport = transport || new Transport({ timeout, maxResponse });
  let status; let responseHeaders; let payload;
  try {
    [status, responseHeaders, payload] = await activeTransport.send(
      method, url, requestHeaders, bodyBuffer.length ? bodyBuffer : null,
    );
  } catch (exc) {
    if (exc instanceof RequestPolicyError) {
      throw new RequestPolicyError(redact(exc.message));
    }
    if (exc instanceof RuntimeErrorBase) {
      throw new OpenAPIError(redact(exc.message));
    }
    throw exc;
  }
  return {
    ...result,
    status,
    response_headers: redact(responseHeaders),
    response_body: redact(Buffer.from(payload).toString("utf8")),
  };
}

function normalizedUrl(parsed) {
  return urlunsplit(
    parsed.scheme.toLowerCase(),
    parsed.netloc,
    canonicalUri(parsed.path),
    normalizeQuery(parsed.query),
    "",
  );
}

const CLI_METHODS = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"];

function parseCliArgs(argv) {
  const opts = {
    method: null, url: null, configFile: null, body: null, bodyFile: null,
    header: [], confirm: false, dryRun: false,
    timeout: DEFAULT_TIMEOUT, maxResponse: DEFAULT_MAX_RESPONSE, maxRequest: DEFAULT_MAX_REQUEST,
  };
  const positional = [];
  const intOption = (name, raw) => {
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`argument ${name}: invalid int value: '${raw}'`);
    }
    return parseInt(raw, 10);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const takeValue = (name) => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`argument ${name}: expected one argument`);
      }
      return argv[i];
    };
    if (token === "--config-file") opts.configFile = takeValue(token);
    else if (token === "--body") opts.body = takeValue(token);
    else if (token === "--body-file") opts.bodyFile = takeValue(token);
    else if (token === "--header") opts.header.push(takeValue(token));
    else if (token === "--confirm") opts.confirm = true;
    else if (token === "--dry-run") opts.dryRun = true;
    else if (token === "--timeout") opts.timeout = intOption(token, takeValue(token));
    else if (token === "--max-response") opts.maxResponse = intOption(token, takeValue(token));
    else if (token === "--max-request") opts.maxRequest = intOption(token, takeValue(token));
    else if (token.startsWith("-") && token !== "-") throw new Error(`unrecognized argument: ${token}`);
    else positional.push(token);
  }
  if (opts.body !== null && opts.bodyFile !== null) {
    throw new Error("argument --body-file: not allowed with argument --body");
  }
  if (positional.length !== 2) {
    throw new Error("expected method and url arguments");
  }
  [opts.method, opts.url] = positional;
  if (!CLI_METHODS.includes(opts.method)) {
    throw new Error(`argument method: invalid choice: '${opts.method}'`);
  }
  return opts;
}

async function main(argv) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (exc) {
    process.stderr.write(String((exc && exc.message) || exc) + "\n");
    return 2;
  }
  try {
    if (args.timeout <= 0 || args.maxResponse <= 0 || args.maxRequest <= 0) {
      throw new RequestPolicyError("--timeout, --max-response, and --max-request must be positive");
    }
    const credentials = await internals.loadOauthCredentials({ configFile: args.configFile });
    const headers = {};
    for (const item of args.header) {
      if (!item.includes(":")) {
        throw new RequestPolicyError("--header must use NAME:VALUE format");
      }
      const sep = item.indexOf(":");
      const name = item.slice(0, sep).trim();
      const value = item.slice(sep + 1).trim();
      if (!name) {
        throw new RequestPolicyError("--header name must not be empty");
      }
      headers[name] = value;
    }
    let body = args.body || "";
    if (args.bodyFile !== null) {
      if (!args.bodyFile) {
        throw new RequestPolicyError("--body-file must not be empty");
      }
      const bodyPath = expandUser(args.bodyFile);
      let stat;
      try {
        stat = fs.statSync(bodyPath);
      } catch {
        throw new RequestPolicyError("cannot read request body file");
      }
      if (stat.size > args.maxRequest) {
        throw new RequestPolicyError("request body exceeds configured size limit");
      }
      try {
        body = fs.readFileSync(bodyPath);
      } catch {
        throw new RequestPolicyError("cannot read request body file");
      }
    }
    const result = await internals.request(args.method, args.url, credentials, {
      body, headers, confirm: args.confirm, dryRun: args.dryRun,
      timeout: args.timeout, maxResponse: args.maxResponse, maxRequest: args.maxRequest,
      bodySummary: args.bodyFile !== null,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (exc) {
    if (exc instanceof RuntimeErrorBase) {
      process.stderr.write(redact(String(exc.message)) + "\n");
      return 2;
    }
    throw exc;
  }
}

async function defaultDnsLookup(host) {
  return dns.promises.lookup(host, { all: true });
}

const internals = {
  request,
  loadOauthCredentials,
  resolveHostname,
  dnsLookup: defaultDnsLookup,
};

export {
  Credentials, CredentialError, RequestPolicyError, OpenAPIError, RuntimeErrorBase,
  buildAuthorization, canonicalUri, canonicalQuery, normalizeQuery, normalizedUrl,
  validateUrl, redact, sensitiveName, isGlobalIp, resolveHostname, classifyResponseStatus,
  loadCredentials, loadOauthCredentials, request, main, NoRedirect, Transport,
  BODY_SUMMARY_THRESHOLD, ALLOWED_SUFFIXES, internals,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(String((exc && exc.stack) || exc) + "\n");
      process.exit(1);
    });
}
