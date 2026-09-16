# Qianfan CLI 官方文档索引

## 概述

千帆（Qianfan）是百度的大模型平台。Qianfan CLI（`qianfan` 命令）把千帆的模型
发现、文本推理、套餐（profile）与默认模型绑定、用量统计和诊断能力封装成 Agent
可调用的工具箱。CLI 本身闭源发布（通过 npm 分发，支持 macOS 与 Windows
x64/arm64），仓库内 `skills/` 目录下的 Agent Skills 文档开放贡献。

本 Skill 只做路由：真正的千帆操作应交给官方 `qianfan` CLI 及其通过
`qianfan +connect` 安装的自带技能包。命令行为以安装的 CLI `--help` 为准，本索引仅
作补充。

## 仓库与安装

- 官方仓库：https://github.com/baidubce/qianfan-cli
- 安装：按仓库 README 操作（npm 发布）。安装完成后确认 `command -v qianfan`。
- 离线环境：`QIANFAN_SKIP_POSTINSTALL=1` 可跳过平台二进制下载。
- 本地状态目录默认 `~/.qianfan`，可用 `QIANFAN_HOME` 指定其他目录；不要读取、
  复制或输出该目录内容。

## 命令入口

- `qianfan auth` —— 浏览器 OAuth 登录、登出、查看登录态（同时只保留一个账号，
  换账号先 `qianfan auth logout`）。
- `qianfan models` —— 列出可绑定模型及其 `modelId`。
- `qianfan profile` —— 套餐切换与默认模型绑定（`profile use`、`profile set-default`）。
- `qianfan +chat` —— 文本推理与流式输出。
- `qianfan service usage` —— 调用量与 token 消耗统计。
- `qianfan doctor` —— 只读体检与连通性诊断。
- `qianfan +connect` —— 安装 / 列出 / 卸载自带 Agent Skills。

## 自带 Agent Skills

`qianfan +connect` 会把千帆自带的 `qianfan-*` 技能包安装到本机 Agent（Comate /
Claude Code 等）。这些技能只编排 `qianfan` 命令，不读取本地凭证、不直接调用千帆
HTTP 接口。本仓不复制其内容，优先使用并保持这些自带技能为最新。

## 全局参数

- `--format text|json`（默认 `text`；`profile use` 与 `profile set-default` 除外）。
  Agent 与脚本解析用 `--format json`。
- 会改动本地状态的命令支持 `--dry-run` 预演与 `-y/--yes` 免交互确认；不要替用户
  加 `-y/--yes`。

## 安全

请勿在 Issue 或任何公开渠道发送 API Key、AK/SK、Token 等敏感信息。上报可复现问题
时可附执行的命令、`--format json` 输出与 `qianfan doctor` 结果，但需脱敏。
