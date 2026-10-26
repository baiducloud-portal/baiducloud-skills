#!/usr/bin/env node
// Search and read Baidu Intelligent Cloud official documentation.
//
// Every command is a read-only, unauthenticated HTTPS request to the public
// documentation site. No credentials are read, sent, or required.
import https from 'node:https';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SITE = 'https://cloud.baidu.com';
const DOC_CDN = 'https://bce.bdstatic.com/p3m/bce-doc/online';
const ALLOWED_HOSTS = new Set(['cloud.baidu.com', 'bce.bdstatic.com']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BACKEND_PAGE_SIZE = 10;
const MAX_PAGES = 5;
const PRODUCT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOC_URL_RE = /^https?:\/\/cloud\.baidu\.com\/doc\/([A-Za-z0-9_-]+)\/s\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const COMMANDS = ['search', 'get', 'tree', 'grep', 'products'];
const UNAVAILABLE_HINT = '文档检索暂不可用。请如实告知用户，不要用模型记忆冒充官方文档内容。';

class DocsArgumentError extends Error {}
class DocsApiError extends Error {}

function httpRequest(url, method, headers, payload, timeout) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error(`响应超过 ${MAX_RESPONSE_BYTES} 字节上限`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', (err) => reject(err));
    request.setTimeout(timeout * 1000, () => {
      request.destroy(new Error('请求超时'));
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

const internals = { httpRequest };

async function fetchText(url, { method = 'GET', body = null, timeout = 15 } = {}) {
  // Send one request to an approved documentation host. Redirects are not
  // followed: the site answers unknown pages with a 302 to a 404 page.
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname) || parsed.port) {
    throw new DocsApiError(`拒绝访问非官方文档地址：${parsed.origin}`);
  }
  const payload = body != null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  const headers = { Accept: 'application/json, text/html;q=0.9' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  let response;
  try {
    response = await internals.httpRequest(url, method, headers, payload, timeout);
  } catch (err) {
    throw new DocsApiError(`网络错误：${err.message}。${UNAVAILABLE_HINT}`);
  }
  return response;
}

async function fetchJson(url, options) {
  const response = await fetchText(url, options);
  if (response.status >= 300) {
    throw new DocsApiError(`HTTP ${response.status}：${url}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new DocsApiError(`文档服务返回了非 JSON 响应：${url}。${UNAVAILABLE_HINT}`);
  }
}

function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function docUrl(product, slug) {
  return `${SITE}/doc/${product}/s/${slug}`;
}

function checkProduct(product) {
  if (!PRODUCT_RE.test(product || '')) {
    throw new DocsArgumentError(`无效的产品代码：${product}。用 products 命令查询产品代码（如 BCC、CFC、BOS）`);
  }
  return product;
}

function parseDocId(value) {
  // Accept "<PRODUCT>/<slug>", a https://cloud.baidu.com/doc/<PRODUCT>/s/<slug>
  // URL, or a bare slug. A bare slug still reads the body but has no metadata.
  const text = String(value || '').trim();
  const urlMatch = DOC_URL_RE.exec(text);
  if (urlMatch) {
    return { product: urlMatch[1], slug: urlMatch[2] };
  }
  const parts = text.split('/');
  if (parts.length === 2 && PRODUCT_RE.test(parts[0]) && SLUG_RE.test(parts[1])) {
    return { product: parts[0], slug: parts[1] };
  }
  if (parts.length === 1 && SLUG_RE.test(text)) {
    return { product: null, slug: text };
  }
  throw new DocsArgumentError(
    `无效的 doc_id：${text}。格式应为 <产品>/<文档ID>（如 CFC/gkwfyd83w）或官网文档 URL`,
  );
}

function docIdFromUrl(url) {
  const match = DOC_URL_RE.exec(String(url || ''));
  return match ? { product: match[1], slug: match[2] } : null;
}

function splitTitle(rawTitle) {
  // Search titles look like "冷热启动机制 - 函数计算CFC | 百度智能云文档".
  const text = stripTags(rawTitle).replace(/\s*\|\s*百度智能云文档\s*$/, '');
  const index = text.lastIndexOf(' - ');
  if (index < 0) {
    return { title: text, productName: null };
  }
  return { title: text.slice(0, index), productName: text.slice(index + 3) };
}

async function search(args) {
  const query = args.positional.join(' ').trim();
  if (!query) {
    throw new DocsArgumentError('search 需要检索词，例如：search 函数计算 冷启动优化');
  }
  const product = args.product ? checkProduct(args.product) : null;
  // Including the product name in the query raises relevance on the site search.
  const effectiveQuery = product && !query.toLowerCase().includes(product.toLowerCase())
    ? `${product} ${query}`
    : query;
  const results = [];
  const seen = new Set();
  const maxPages = product ? MAX_PAGES : Math.ceil(args.limit / BACKEND_PAGE_SIZE);
  for (let page = 1; page <= maxPages && results.length < args.limit; page += 1) {
    const data = await fetchJson(`${SITE}/api/portalsearch`, {
      method: 'POST',
      body: { query: effectiveQuery, type: 'doc', pageNo: String(page), status: 'ONLINE' },
      timeout: args.timeout,
    });
    if (!data.success) {
      throw new DocsApiError(`文档搜索失败：${JSON.stringify(data.error || data.message || data)}`);
    }
    const items = (data.result && data.result.dataList) || [];
    for (const item of items) {
      const id = docIdFromUrl(item.url);
      if (item.type !== 'doc' || !id || seen.has(`${id.product}/${id.slug}`)) {
        continue;
      }
      if (product && id.product.toLowerCase() !== product.toLowerCase()) {
        continue;
      }
      seen.add(`${id.product}/${id.slug}`);
      const { title, productName } = splitTitle(item.title);
      results.push({
        doc_id: `${id.product}/${id.slug}`,
        product: id.product,
        product_name: productName,
        title,
        url: docUrl(id.product, id.slug),
        summary: stripTags(item.content),
        score: item.score ?? null,
      });
      if (results.length >= args.limit) {
        break;
      }
    }
    if (items.length < BACKEND_PAGE_SIZE) {
      break;
    }
  }
  const output = { query, product, results };
  if (results.length === 0) {
    output.hint = product
      ? `未检索到结果。可改用 grep --product ${product} <关键词> 精确匹配，或换用更通用的检索词`
      : '未检索到结果。可指定 --product 并改用 grep 精确匹配，或换用更通用的检索词';
  }
  return output;
}

function markdownHeadings(content) {
  // Locate ATX headings outside fenced code blocks, with their char offsets.
  const headings = [];
  let inFence = false;
  let offset = 0;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) {
        headings.push({ level: match[1].length, title: match[2], offset });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

function sectionEnd(content, headings, start, maxChars) {
  // End a truncated window at the last heading in its second half, if any.
  const hardEnd = start + maxChars;
  if (hardEnd >= content.length) {
    return content.length;
  }
  const boundaries = headings
    .map((h) => h.offset)
    .filter((o) => o > start + maxChars / 2 && o <= hardEnd);
  return boundaries.length ? boundaries[boundaries.length - 1] : hardEnd;
}

async function get(args) {
  if (args.positional.length !== 1) {
    throw new DocsArgumentError('get 需要且只需要一个 doc_id，例如：get CFC/gkwfyd83w');
  }
  const { product, slug } = parseDocId(args.positional[0]);
  const data = await fetchJson(`${SITE}/api/doc/md/${encodeURIComponent(slug)}`, { timeout: args.timeout });
  const content = data && data.success && data.result ? data.result.mdContent : null;
  if (typeof content !== 'string' || content === '') {
    throw new DocsApiError(
      `文档不存在：${args.positional[0]}。请用 search、grep 或 tree 获取有效 doc_id（格式如 CFC/gkwfyd83w）`,
    );
  }
  const output = {
    doc_id: product ? `${product}/${slug}` : slug,
    product,
    title: null,
    updated: null,
    url: product ? docUrl(product, slug) : null,
  };
  if (product) {
    // Gatsby page data carries the published title and last update date.
    const pageData = `${DOC_CDN}/${product}/doc/${product}/s/page-data/${encodeURIComponent(slug)}/page-data.json`;
    try {
      const meta = await fetchJson(pageData, { timeout: args.timeout });
      const remark = meta.result && meta.result.data && meta.result.data.markdownRemark;
      const fields = (remark && remark.fields) || {};
      output.title = fields.title || null;
      output.updated = fields.date || null;
    } catch (err) {
      if (!(err instanceof DocsApiError)) {
        throw err;
      }
      output.warning = '未能读取文档元信息（标题、更新时间）；正文仍来自官网线上版本';
    }
  } else {
    output.warning = '只提供了文档 ID，缺少产品代码，无法返回标题、更新时间与 URL；建议使用 <产品>/<文档ID>';
  }
  const headings = markdownHeadings(content);
  const start = Math.min(args.offset, content.length);
  const end = sectionEnd(content, headings, start, args.max_chars);
  output.total_chars = content.length;
  output.offset = start;
  output.content = content.slice(start, end);
  output.truncated = end < content.length;
  if (output.truncated) {
    output.next_offset = end;
    output.headings = headings;
    output.hint = `正文已按章节截断。用 --offset ${end} 继续读取，或用 headings 中的 offset 跳到指定章节`;
  }
  return output;
}

function treeNode(product, item, depth) {
  const node = {
    title: item.name,
    doc_id: `${product}/${item.path}`,
    url: /\.md$/i.test(item.filePath || '') ? docUrl(product, item.path) : null,
    updated: item.lastMergeTime || null,
  };
  if (item.httpMethod) {
    node.http_method = item.httpMethod;
  }
  const children = (item.children || []).filter((child) => !child.disabled);
  if (children.length) {
    if (depth > 1) {
      node.children = children.map((child) => treeNode(product, child, depth - 1));
    } else {
      node.child_count = children.length;
    }
  }
  return node;
}

function findNode(items, slug) {
  for (const item of items || []) {
    if (item.disabled) {
      continue;
    }
    if (item.path === slug) {
      return item;
    }
    const found = findNode(item.children, slug);
    if (found) {
      return found;
    }
  }
  return null;
}

async function tree(args) {
  if (args.positional.length > 1) {
    throw new DocsArgumentError('tree 最多接受一个目录节点 doc_id');
  }
  let product = args.product ? checkProduct(args.product) : null;
  let slug = null;
  if (args.positional.length === 1) {
    const parsed = parseDocId(args.positional[0]);
    product = parsed.product || product;
    slug = parsed.slug;
  }
  if (!product) {
    throw new DocsArgumentError('tree 需要 --product <产品代码> 或 <产品>/<节点ID>；不知道产品代码时先运行 products');
  }
  const response = await fetchText(`${DOC_CDN}/${product}/config.json`, { timeout: args.timeout });
  if (response.status === 403 || response.status === 404) {
    throw new DocsApiError(`产品文档不存在：${product}（产品代码区分大小写）。请运行 products 查询正确的产品代码`);
  }
  if (response.status >= 300) {
    throw new DocsApiError(`HTTP ${response.status}：读取 ${product} 文档目录失败。${UNAVAILABLE_HINT}`);
  }
  let config;
  try {
    config = JSON.parse(response.body);
  } catch {
    throw new DocsApiError(`${product} 文档目录不是有效 JSON。${UNAVAILABLE_HINT}`);
  }
  const repo = config.repoName || product;
  const output = {
    product: repo,
    product_name: config.description || null,
    updated: config.onlinePublishTime || null,
    url: `${SITE}/doc/${repo}/index.html`,
  };
  if (slug) {
    const item = findNode(config.items, slug);
    if (!item) {
      throw new DocsApiError(`目录节点不存在：${product}/${slug}。请先运行 tree --product ${product} 查看顶层目录`);
    }
    // Expanding a node shows its own children down to --depth levels.
    output.node = treeNode(repo, item, args.depth + 1);
  } else {
    output.children = (config.items || [])
      .filter((item) => !item.disabled)
      .map((item) => treeNode(repo, item, args.depth));
  }
  return output;
}

async function grep(args) {
  const keywords = args.positional.map((k) => k.trim()).filter(Boolean);
  if (!args.product || keywords.length === 0) {
    throw new DocsArgumentError('grep 需要 --product <产品代码> 和至少一个关键词，例如：grep --product CFC 超时时间');
  }
  const product = checkProduct(args.product);
  const needles = keywords.map((k) => k.toLowerCase());
  const exact = [];
  const candidates = [];
  for (let page = 1; page <= MAX_PAGES && exact.length < args.limit; page += 1) {
    const data = await fetchJson(`${SITE}/api/doc/search`, {
      method: 'POST',
      body: {
        orgName: 'bce-doc',
        repoName: product,
        keyWord: keywords.join(' '),
        pageNo: page,
        pageSize: BACKEND_PAGE_SIZE,
      },
      timeout: args.timeout,
    });
    if (!data.success) {
      throw new DocsApiError(`产品内检索失败：${JSON.stringify(data.error || data.message || data)}`);
    }
    const items = (data.page && data.page.result) || [];
    for (const item of items) {
      const slug = item.resourceId;
      if (!SLUG_RE.test(slug || '')) {
        continue;
      }
      const title = stripTags(item.documentName);
      const snippet = stripTags(item.contentText);
      // The backend tokenizes keywords and matches any token, so a hit is
      // exact only when its title or snippet contains every keyword verbatim.
      // Other hits are kept as candidates: the snippet is a fragment, so the
      // keyword may still appear elsewhere in the document.
      const haystack = `${title}\n${snippet}`.toLowerCase();
      const isExact = needles.every((needle) => haystack.includes(needle));
      const hit = {
        doc_id: `${item.repoName || product}/${slug}`,
        title,
        url: docUrl(item.repoName || product, slug),
        snippet,
        exact: isExact,
      };
      if (isExact) {
        if (exact.length < args.limit) {
          exact.push(hit);
        }
      } else {
        candidates.push(hit);
      }
    }
    if (items.length < BACKEND_PAGE_SIZE) {
      break;
    }
  }
  // Fill up to --limit with candidates whose document is not already listed.
  const listed = new Set(exact.map((h) => h.doc_id));
  const hits = [...exact];
  for (const hit of candidates) {
    if (hits.length >= args.limit) {
      break;
    }
    if (!listed.has(hit.doc_id)) {
      listed.add(hit.doc_id);
      hits.push(hit);
    }
  }
  const output = { product, keywords, hits };
  if (hits.length === 0) {
    output.hint = `未命中。请确认产品代码 ${product} 正确（区分大小写，可运行 products 查询），或改用 search`;
  } else if (exact.length === 0) {
    output.hint = '没有片段完整包含全部关键词，以下均为候选（exact: false）。引用前须用 get 读全文确认关键词确实出现';
  } else if (exact.length < hits.length) {
    output.hint = 'exact: false 的结果为候选，片段中未完整出现全部关键词。引用前须用 get 读全文确认';
  }
  return output;
}

async function products(args) {
  // The documentation home page embeds the product navigation as Next.js data.
  const response = await fetchText(`${SITE}/doc/index.html`, { timeout: args.timeout });
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(response.body || '');
  if (response.status >= 300 || !match) {
    throw new DocsApiError(`无法读取文档产品列表（HTTP ${response.status}）。${UNAVAILABLE_HINT}`);
  }
  let categories;
  try {
    categories = JSON.parse(match[1]).props.pageProps.pageData || [];
  } catch {
    throw new DocsApiError(`文档产品列表格式无法解析。${UNAVAILABLE_HINT}`);
  }
  const term = args.positional.join(' ').trim().toLowerCase();
  const seen = new Set();
  const list = [];
  for (const category of categories) {
    for (const item of category.products || []) {
      const code = /\/doc\/([A-Za-z0-9_-]+)\//.exec(item.link || '');
      if (!code || seen.has(code[1])) {
        continue;
      }
      const entry = { product: code[1], name: item.name, category: category.category };
      if (term && ![entry.product, entry.name, entry.category].some((v) => String(v).toLowerCase().includes(term))) {
        continue;
      }
      seen.add(code[1]);
      list.push(entry);
    }
  }
  return { products: list };
}

const OPTIONS = {
  '--product': { dest: 'product', kind: 'string' },
  '--limit': { dest: 'limit', kind: 'int', min: 1, max: 20 },
  '--depth': { dest: 'depth', kind: 'int', min: 1, max: 5 },
  '--offset': { dest: 'offset', kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
  '--max-chars': { dest: 'max_chars', kind: 'int', min: 1000, max: 200000 },
  '--timeout': { dest: 'timeout', kind: 'int', min: 1, max: 120 },
};

const USAGE = `用法：node docs.mjs <command> [参数]
  search <检索词...> [--product P] [--limit N]    全站文档语义检索
  get <产品/文档ID|URL> [--offset N] [--max-chars N] 读取文档 Markdown 正文
  tree --product P [<产品/节点ID>] [--depth N]       浏览产品文档目录树
  grep --product P <关键词...> [--limit N]         产品内关键词命中（多关键词为 AND）
  products [过滤词]                                 列出文档产品与产品代码`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (!COMMANDS.includes(command)) {
    throw new DocsArgumentError(`command 必须是 ${COMMANDS.join('、')} 之一\n${USAGE}`);
  }
  const args = {
    command,
    positional: [],
    product: null,
    limit: 5,
    depth: 1,
    offset: 0,
    max_chars: 12000,
    timeout: 15,
  };
  for (let i = 0; i < rest.length; i += 1) {
    let token = rest[i];
    let value = null;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0) {
      value = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (!token.startsWith('--')) {
      args.positional.push(rest[i]);
      continue;
    }
    const spec = OPTIONS[token];
    if (!spec) {
      throw new DocsArgumentError(`未知参数：${token}`);
    }
    if (value === null) {
      i += 1;
      if (i >= rest.length) {
        throw new DocsArgumentError(`${token} 需要一个取值`);
      }
      value = rest[i];
    }
    if (spec.kind === 'int') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
        throw new DocsArgumentError(`${token} 必须是 ${spec.min}-${spec.max} 之间的整数`);
      }
      args[spec.dest] = number;
    } else {
      args[spec.dest] = value;
    }
  }
  return args;
}

const HANDLERS = { search, get, tree, grep, products };

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof DocsArgumentError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (args.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await HANDLERS[args.command](args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    if (err instanceof DocsArgumentError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 2;
    }
    if (err instanceof DocsApiError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
  return 0;
}

export {
  DocsApiError,
  DocsArgumentError,
  ALLOWED_HOSTS,
  parseArgs,
  parseDocId,
  stripTags,
  splitTitle,
  markdownHeadings,
  sectionEnd,
  fetchText,
  search,
  get,
  tree,
  grep,
  products,
  main,
  internals,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
