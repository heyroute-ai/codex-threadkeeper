<div align="center">

# codex-threadkeeper

### 修复 Codex 中“线程还在，但切 provider 后看不见了”的问题

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/heyroute-ai/codex-threadkeeper)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Community](https://img.shields.io/badge/community-LINUX%20DO-2ea043.svg)](https://linux.do/)

[English](README_EN.md) | 中文

</div>

## 这个项目解决什么问题

很多人以为自己切换 `model_provider` 之后“历史会话丢了”，但更常见的真实情况是：

- 线程数据其实还在
- 只是不同位置的元数据不一致了
- 于是 Codex CLI、Codex App、侧边栏项目列表显示出来的结果不一样

最常见的症状是：

- 切换 provider 后，之前能看到的历史线程突然不见了
- `codex resume` 和 Codex App 显示不一致
- 线程仍然存在，但左侧项目没了，手动 `Add Project` 之后历史线程又回来

`codex-threadkeeper` 处理的正是这个问题。它会把这些状态重新对齐：

- rollout 文件：`~/.codex/sessions`、`~/.codex/archived_sessions`
- SQLite：`~/.codex/sqlite/state_5.sqlite`（兼容旧版 `~/.codex/state_5.sqlite`）
- 侧边栏项目状态：`.codex-global-state.json`
- 受管备份：`~/.codex/backups_state/threadkeeper`

一句话说，它不是替代官方 Codex，而是修复 Codex 线程可见性的元数据工具。

## 和原来的 provider-sync 工具有什么不同

这个仓库现在已经不是单纯的 `provider sync` 小工具，而是独立维护的 `codex-threadkeeper`。

和早期/原始的实现相比，这一版额外强调了几个实际痛点：

- 不只同步 rollout 和 SQLite，也会补齐缺失的侧边栏项目，解决“线程还在但项目不显示”
- CLI 有明确的阶段进度输出，运行时不会像卡住一样没反应
- summary 会显示备份创建耗时，便于观察性能
- Windows 上对锁目录创建时的瞬时 `EPERM` 做了重试，减少刚执行完立刻重跑时的偶发失败
- 运行时命名空间已经切到 `threadkeeper`
  - 备份目录：`backups_state/threadkeeper`
  - 锁目录：`tmp/threadkeeper.lock`
  - GUI 设置：`%AppData%\codex-threadkeeper`
- 旧的 `provider-sync` 备份不会再被自动扫描，但仍然可以显式传入路径做 `restore`
- 继续保留 GUI、CLI、Windows 双击启动器这几种日常入口

## 日常怎么用

你平时其实只会反复用下面几种场景。

| 场景 | 命令 | 什么时候用 |
| --- | --- | --- |
| 先看当前状态 | `codex-threadkeeper status` | 你还不确定当前 provider、rollout、SQLite 是否一致 |
| 只修复可见性 | `codex-threadkeeper sync` | 你已经在别处切好了 provider，只想把历史线程重新对齐 |
| 切 provider 并同步 | `codex-threadkeeper switch <provider-id>` | 你想一步完成改 `config.toml` 和同步历史 |
| 回滚上一次同步 | `codex-threadkeeper restore <backup-dir>` | 你同步到了错误 provider，或者想撤销这次改动 |
| 清理旧备份 | `codex-threadkeeper prune-backups --keep 5` | 你只想保留最近几份受管备份 |

如果你是普通 Windows 用户，最省事的日常方式是 GUI：

1. 打开 `CodexThreadkeeper.exe`
2. 点击 `Refresh`
3. 选择目标 Provider
4. 点击 `Execute`

如果你更习惯命令行，推荐的日常流程是：

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper status
```

如果你这次不只是修复可见性，而是顺手切 provider：

```bash
codex-threadkeeper status
codex-threadkeeper switch openai
codex-threadkeeper status
```

## 最常见的一次完整使用流程

多数情况下不需要先关闭 Codex。建议先直接执行：

```bash
codex-threadkeeper status
codex-threadkeeper sync
```

如果命令成功完成，就说明这次运行期间 SQLite 没有被独占锁住；Codex App 打开着也可以修复可见性。只有遇到下面两类情况时再处理占用：

- 报 `state_5.sqlite is currently in use`：关闭 Codex / Codex App / `app-server` 后重跑同一个命令
- 输出 `Skipped locked rollout files`：先结束对应活跃会话，之后再补跑一次 `codex-threadkeeper sync`

你通常会在输出里看到这几项：

- `Updated rollout files`
  - 代表有多少个 rollout 文件被改写到了目标 provider
- `Added sidebar projects`
  - 代表这次补回了多少个侧边栏项目
- `Updated SQLite rows`
  - 代表 SQLite 里有多少条线程元数据被更新

如果最后再跑一次：

```bash
codex-threadkeeper status
```

看到 rollout 和 SQLite 的 provider 计数都已经一致，基本就说明修复完成了。

## 关键排障经验：为什么 `sync` 能把历史会话救回来

有一种很容易误判的情况：历史会话在界面里“闪一下又消失”，或者 `sync` 输出里一开始长期显示 `Updated SQLite rows: 0`。

这通常不是普通缓存问题，也不是 `.codex` 目录里垃圾太多。真正要检查的是 Codex App 当前实际读取的 SQLite：

```text
~/.codex/sqlite/state_5.sqlite
```

旧版或旧工具可能还会留下这个兼容路径：

```text
~/.codex/state_5.sqlite
```

如果旧库已经是目标 provider，但现代库仍然是旧 provider，Codex App 还是会按现代库显示，历史就会继续不见。一次有效的修复通常会同时修这几类元数据：

- rollout 里的 `model_provider`
- SQLite `threads.model_provider`
- SQLite `threads.cwd`，尤其是 `\\?\E:\repo` 这种 Windows extended-length 前缀
- SQLite `threads.has_user_event`
- `.codex-global-state.json` 里的 `thread-workspace-root-hints`

所以判断一次修复是否真正命中病根，不只看 rollout，也要看 `status` 里 SQLite 的 provider 计数是否已经和 rollout 一致。如果 `sync` 输出出现这些数字，通常说明它确实修到了 Codex App 正在读的索引：

```text
Updated SQLite rows: ...
Normalized SQLite cwd rows: ...
Repaired SQLite user-event rows: ...
Added thread workspace hints: ...
```

这也是为什么这类问题推荐先跑：

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper status
```

而不是手动只改 rollout 文件。手动只改 rollout 很容易让“文件看起来对了”，但 Codex App 仍然按错误的 SQLite 索引隐藏线程。

## 安装

### CLI

```bash
npm install -g codex-threadkeeper
```

环境要求：

- Node.js `24+`
- 标准 `~/.codex` 目录结构
- 当前主要按 Windows 场景验证

### GUI

如果你不想装 Node，也不想记命令，直接从 Releases 下载 `CodexThreadkeeper.exe` 即可。

GUI 适合：

- 普通 Windows 用户
- 想先看状态、再点按钮执行的人
- 希望直接浏览和恢复备份的人

GUI 专用说明见 [README_GUI_ZH.md](README_GUI_ZH.md)。

## 命令速查

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper sync --keep 5
codex-threadkeeper sync --provider openai
codex-threadkeeper switch openai
codex-threadkeeper switch apigather
codex-threadkeeper prune-backups --keep 5
codex-threadkeeper restore C:\Users\you\.codex\backups_state\threadkeeper\20260319T042708906Z
codex-threadkeeper install-windows-launcher
```

显式指定另一个 `.codex` 目录时：

```bash
codex-threadkeeper status --codex-home C:\Users\you\.codex
codex-threadkeeper sync --codex-home C:\Users\you\.codex
codex-threadkeeper switch openai --codex-home C:\Users\you\.codex
```

## 常见问题

### 1. 提示 `state_5.sqlite is currently in use`

这不是数据损坏，通常只是 SQLite 当时被 Codex / Codex App / `app-server` 独占了。不是每次都需要提前关闭 Codex；可以先直接跑 `codex-threadkeeper sync`，只有出现这个错误时再关闭相关进程。

处理方式：

- 关闭 Codex / Codex App / `app-server`
- 再重跑同一个命令

### 2. 输出里有 `Skipped locked rollout files`

这通常说明某个活跃会话还占着对应 rollout 文件。

这时的语义是：

- SQLite 大概率已经同步成功
- 大部分 rollout 文件也已经改完
- 只有那几个仍被占用的文件被跳过了
- 如果没有 `state_5.sqlite is currently in use`，通常不需要为了这一步关闭整个 Codex

处理方式：

- 先结束那个活跃会话
- 再补跑一次 `codex-threadkeeper sync`

### 3. 我有旧的 `provider-sync` 备份，还能恢复吗

可以，但不会自动扫描。

你需要显式传入旧目录路径，例如：

```bash
codex-threadkeeper restore C:\Users\you\.codex\backups_state\provider-sync\20260319T042708906Z
```

## 安全边界

这个工具会修改元数据，但不会替换官方 Codex。

它明确不会做这些事：

- 不处理 `auth.json`
- 不帮你登录第三方 provider
- 不修改消息历史正文
- 不修改标题、时间戳
- 不把旧的非受管备份目录当成自己的备份去清理

运行时默认会使用：

```text
~/.codex/backups_state/threadkeeper/<timestamp>
~/.codex/tmp/threadkeeper.lock
```

## 给 AI / Agent 的说明

如果你想让 AI 代你执行，机器导向说明见 [AGENTS.md](AGENTS.md)。

## 开发

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
dotnet test desktop/CodexThreadkeeper.Core.Tests/CodexThreadkeeper.Core.Tests.csproj
pwsh ./scripts/publish-gui.ps1
```

## License

MIT
