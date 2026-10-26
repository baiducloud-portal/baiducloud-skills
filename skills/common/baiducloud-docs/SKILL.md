---
name: baiducloud-docs
description: Search and read Baidu Intelligent Cloud (百度智能云) official documentation from cloud.baidu.com/doc. Prefer this Skill for any documentation lookup — product concepts, feature explanations, parameters, quotas and limits, configuration items, error codes, API reference pages, best practices, and pricing descriptions — instead of answering from memory or hardcoding product descriptions in another Skill. Trigger for 查文档, 官方文档, 帮助文档, 文档搜索, "怎么配置", "这个报错是什么意思", "有什么限制", or any Baidu Cloud question that needs a current, citable official source. No login or cloud credentials are required.
---

# BaiduCloud Docs

Use this Skill as the shared official documentation source for every Baidu
Cloud task. Other Skills orchestrate operations; when they need a product
explanation, parameter meaning, limit, or error explanation, retrieve it here
instead of relying on memory or text copied into a Skill.

All commands are read-only HTTPS requests to the public documentation site
(`cloud.baidu.com` and `bce.bdstatic.com`). They need no login, profile, or
credentials, and output JSON.

## Choose the command

- `search <query...>` — natural-language search across all products. Use it
  when the target document is unknown. Add `--product <code>` to keep only one
  product's documents; including the product name in the query also helps.
- `get <doc_id>` — read one document's full Markdown body plus title, update
  date, and URL. Long documents are cut at a section boundary; continue with
  `--offset <next_offset>` or jump to an offset listed in `headings`.
- `tree --product <code> [<doc_id>]` — browse a product's table of contents.
  `--depth` (default 1) limits expansion; pass a folder node's `doc_id` to
  expand only that branch instead of the whole tree.
- `grep --product <code> <keyword...>` — keyword hits inside one product, for
  configuration items, error codes, and terms. Pass separate words as separate
  arguments (`grep --product BOS Bucket Policy`); each must appear. Quote an
  argument to require it as one contiguous phrase, for example an exact error
  message (`grep --product BCC "does not exist"`). Hits whose snippet contains
  every keyword come first with `exact: true`; remaining slots are filled with
  `exact: false` candidates, whose snippet lacks some keyword.
- `products [term]` — list product codes (for example `函数` → `CFC`). Product
  codes are case-sensitive in `tree` and `grep`.

`doc_id` is `<product>/<id>` (for example `CFC/gkwfyd83w`). `get` also accepts
the document URL `https://cloud.baidu.com/doc/<product>/s/<id>`.

```bash
node scripts/docs.mjs search 函数计算 冷启动优化 --limit 3
node scripts/docs.mjs get CFC/gkwfyd83w
node scripts/docs.mjs tree --product CFC --depth 2
node scripts/docs.mjs grep --product CFC 超时时间
node scripts/docs.mjs products 对象存储
```

Typical flow: `search` (or `products` + `tree`) to locate a document, then
`get` to read it. Use `grep` when the user already named the product and an
exact term or error code.

## Answering rules

- Base the answer on the retrieved text and cite each source with its `url`.
  Mention the document `updated` date when timeliness matters.
- Read the document with `get` before quoting parameters, limits, or steps;
  search summaries are excerpts, not the full context. Treat a `grep` hit with
  `exact: false` as a lead only: cite it after `get` confirms the keyword is in
  the document.
- When the results do not cover the question (no results, or only loosely
  related documents), follow the `hint`, then retry at most twice: rephrase
  with synonyms or the product's own terms (for example "权限控制" instead of
  "Bucket Policy"), use `grep` with the product, or browse with `tree`. Before
  answering, confirm with `get` that the document actually answers the
  question; do not substitute a merely similar document. If nothing fits, say
  that no matching official document was found.
- If a command fails (network error, service unavailable), tell the user that
  documentation retrieval is unavailable. Do not substitute model memory for
  official documentation or invent a source URL.
- This Skill only covers official Baidu Cloud documentation. It does not search
  community articles, blogs, or other clouds' documentation.
