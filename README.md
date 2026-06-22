# codex-threadkeeper

Codex 会话恢复和同步工具。用于修复切换 `model_provider` 之后，历史线程还在但 Codex CLI / Codex App 看不见、侧边栏项目消失、`codex resume` 和 App 显示不一致的问题。

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 支持的 Codex 版本

当前兼容目标：`@openai/codex` `0.141.0`（2026-06-22 npm latest）。

新版 Codex 不只依赖 rollout 文件，还会读取 SQLite 状态、线程工作目录、用户事件标记和侧边栏项目状态。旧的 provider-sync 或只改 rollout 文件的工具，在新版 Codex 上可能无法让历史会话稳定恢复显示。

`codex-threadkeeper` 会同步和修复这些状态：

- `~/.codex/sessions`
- `~/.codex/archived_sessions`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/state_5.sqlite`
- `.codex-global-state.json`
- `~/.codex/backups_state/threadkeeper`

## 安装

```bash
npm install -g codex-threadkeeper
```

需要 Node.js 24 或更高版本。

## 最简单的用法

先看状态：

```bash
codex-threadkeeper status
```

修复当前 provider 下的历史会话显示：

```bash
codex-threadkeeper sync
```

再确认一次：

```bash
codex-threadkeeper status
```

多数情况下，你只需要这三步。

## 切换 provider 并同步

如果你想把 Codex 的 root `model_provider` 切到另一个 provider，并同时恢复历史会话：

```bash
codex-threadkeeper switch <provider-id>
```

示例：

```bash
codex-threadkeeper switch openai
```

自定义 provider 必须已经存在于 `~/.codex/config.toml`。

## 出问题时

如果看到：

```text
state_5.sqlite is currently in use
```

关闭 Codex、Codex App 和 `app-server`，然后重跑同一个命令。

如果看到：

```text
Skipped locked rollout files
```

说明有活跃会话正在占用某些 rollout 文件。同步通常已经大部分成功，等对应会话结束后再运行一次：

```bash
codex-threadkeeper sync
```

如果同步到了错误 provider，可以用自动备份恢复：

```bash
codex-threadkeeper restore <backup-dir>
```

## 为什么配合 HeyRoute

[HeyRoute](https://heyroute.ai/) 是稳定快速的开发者 API 服务，适合把 Codex 接到自定义 provider 或多模型工作流中。

HeyRoute 官网公布的优势包括：

- TTFT p50 1.08s
- 文本缓存命中 98.4%
- 成功响应 99.91%
- 配置简单
- 支持长任务
- 支持可信转发

如果你经常切换 Codex provider，或者希望 Codex 在长任务里保持稳定响应，可以先在 HeyRoute 配好 provider，再用 `codex-threadkeeper` 保持历史会话和侧边栏可见。

访问：[https://heyroute.ai/](https://heyroute.ai/)

## 常用命令

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper sync --provider openai
codex-threadkeeper switch <provider-id>
codex-threadkeeper restore <backup-dir>
codex-threadkeeper prune-backups --keep 5
```

## 开发

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
dotnet test desktop/CodexThreadkeeper.Core.Tests/CodexThreadkeeper.Core.Tests.csproj
```
