#!/usr/bin/env node
// 从 BOS 读取官网产品 OpenAPI 清单（manifest）并按产品路由，替代技能内写死的 references。
// 数据源由 bce-openapi-refgen 技能每日巡检生成并上传：
//   https://portal-public.cdn.bcebos.com/baiducloud-skills/openapilist/
//     manifest.json          全量产品 + 三类（bce/nonbce/noapi）处置
//     references/<code>.md   BCE 产品的接口参考
//
// 用法：
//   node scripts/resolve_product.mjs <产品code或名称>   # 路由单个产品
//   node scripts/resolve_product.mjs --list              # 概览
// 环境变量 BCE_OPENAPI_BOS_BASE 可覆盖数据源根地址。
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://portal-public.cdn.bcebos.com/baiducloud-skills/openapilist";
const TIMEOUT_MS = 20000;

const USAGE = `用法：
  node scripts/resolve_product.mjs <产品code或名称>   # 路由单个产品
  node scripts/resolve_product.mjs --list              # 概览
环境变量 BCE_OPENAPI_BOS_BASE 可覆盖数据源根地址。`;

function baseUrl(env = process.env) {
  return (env.BCE_OPENAPI_BOS_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

// 所有请求都追加时间戳参数，避免命中 CDN 或中间层缓存拿到过期的 manifest/reference。
function withCacheBuster(url, now = Date.now()) {
  const u = new URL(url);
  u.searchParams.set("t", String(now));
  return u.toString();
}

async function get(url, asJson = false) {
  const res = await fetch(withCacheBuster(url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return asJson ? res.json() : res.text();
}

function findProduct(manifest, key) {
  const k = String(key).trim().toLowerCase();
  const products = manifest.products || [];
  const exact = products.find((p) => String(p.code).toLowerCase() === k);
  if (exact) {
    return exact;
  }
  // 退回按名称模糊匹配
  return (k && products.find((p) => String(p.name).toLowerCase().includes(k))) || null;
}

async function main(argv, out = (line) => process.stdout.write(line + "\n")) {
  if (argv.length < 1 || argv[0] === "-h" || argv[0] === "--help") {
    out(USAGE);
    return 0;
  }
  const base = baseUrl();
  let manifest;
  try {
    manifest = await get(`${base}/manifest.json`, true);
  } catch (exc) {
    out(`[err] 无法从 BOS 读取 manifest：${exc.message}\n  数据源：${base}/manifest.json`);
    return 1;
  }

  if (argv[0] === "--list") {
    const c = manifest.counts || {};
    out(`官网产品 OpenAPI 清单（来源 ${manifest.source}）`);
    out(`总 ${manifest.total ?? "?"} ｜ 可直接调用(BCE) ${c.bce ?? "?"} ｜ 有API需单独鉴权 ${c.nonbce ?? "?"} ｜ 无API ${c.noapi ?? "?"}`);
    return 0;
  }

  const p = findProduct(manifest, argv[0]);
  if (!p) {
    out(`[not-found] “${argv[0]}” 不在清单内（清单只覆盖文档首页列出的产品）。可先用 --list 查看，或确认产品 code。`);
    return 0;
  }

  out(`# ${p.name}（${p.code}）｜ 分类：${p.class}`);
  if (p.class === "bce") {
    out("✅ 可用本 OpenAPI 运行时直接调用。");
    out(`- 端点：${(p.endpoint_hosts || []).join(", ")}`);
    out(`- 鉴权：${p.auth}`);
    out(`- 接口数：${p.api_count}`);
    if (p.partial_note) {
      out(`- 注意：${p.partial_note}`);
    }
    out(`\n--- 接口参考（${p.reference}）---\n`);
    try {
      out(await get(`${base}/${p.reference}`));
    } catch (exc) {
      out(`[warn] 参考文件拉取失败：${exc.message}；可直接打开 ${p.doc_home}`);
    }
  } else if (p.class === "nonbce") {
    out("⚠️ 该产品有 API，但鉴权非百度云标准 AK/SK，**本运行时不能直接调用**。");
    out(`- 鉴权体系：${p.auth}`);
    out(`- 请告知客户：${p.message}`);
    out(`- 鉴权文档：${p.auth_doc}`);
  } else {
    out("➖ 该产品无可直接调用的公网 OpenAPI。");
    out(`- 请告知客户：${p.message}`);
    out(`- 控制台/文档：${p.console}`);
  }
  return 0;
}

export { findProduct, main, baseUrl, withCacheBuster };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(String((exc && exc.stack) || exc) + "\n");
      process.exit(1);
    });
}
