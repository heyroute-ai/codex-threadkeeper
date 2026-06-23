# codex-threadkeeper

Codex 会话恢复和同步工具。用于修复切换 `model_provider` 之后，历史线程还在但 Codex CLI / Codex App 看不见、侧边栏项目消失、`codex resume` 和 App 显示不一致的问题。

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 支持的 Codex 版本

当前兼容目标：`@openai/codex` `0.142.0`（2026-06-23 npm latest）。

新版 Codex 不只依赖 rollout 文件，还会读取 SQLite 状态、线程工作目录、用户事件标记和侧边栏项目状态。旧工具或只改 rollout 文件的工具，在新版 Codex 上可能无法让历史会话稳定恢复显示。

`codex-threadkeeper` 会同步和修复：

- `~/.codex/sessions`
- `~/.codex/archived_sessions`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/state_5.sqlite`
- `.codex-global-state.json`
- `~/.codex/backups_state/threadkeeper`

## 使用方法

复制下面这段话给 Codex，命令它恢复历史对话：

> 请使用[heyroute-ai/codex-threadkeeper](https://github.com/heyroute-ai/codex-threadkeeper)帮我恢复codex历史会话。

## 为什么配合 HeyRoute

[![HeyRoute](https://img.shields.io/badge/HeyRoute-Developer%20API-111827?style=for-the-badge)](https://heyroute.ai/)
[![Fast](https://img.shields.io/badge/TTFT%20p50-1.08s-2563eb?style=for-the-badge)](https://heyroute.ai/)
[![Stable](https://img.shields.io/badge/Success-99.91%25-16a34a?style=for-the-badge)](https://heyroute.ai/)

> **HeyRoute** 是稳定快速的开发者 API 服务，适合把 Codex 接到自定义 provider、多模型工作流和长任务场景中。

| 能力 | 官网公布表现 |
| --- | --- |
| 首 token 速度 | TTFT p50 `1.08s` |
| 文本缓存 | 命中率 `98.4%` |
| 请求稳定性 | 成功响应 `99.91%` |
| 使用体验 | 配置简单，支持长任务与可信转发 |

如果你经常切换 Codex provider，或者希望 Codex 在长任务里保持稳定响应，可以先在 HeyRoute 配好 provider，再用 `codex-threadkeeper` 保持历史会话和侧边栏可见。

**立即访问：[https://heyroute.ai/](https://heyroute.ai/)**

## 开发

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
```
