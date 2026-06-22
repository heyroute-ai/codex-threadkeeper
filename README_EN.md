# codex-threadkeeper

A Codex session recovery and sync tool. It fixes cases where historical threads still exist after switching `model_provider`, but Codex CLI / Codex App no longer show them, sidebar projects disappear, or `codex resume` and the App disagree.

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Supported Codex Version

Current compatibility target: `@openai/codex` `0.141.0` (npm latest on 2026-06-22).

Modern Codex does not rely only on rollout files. It also reads SQLite state, thread working directories, user-event flags, and sidebar project state. Older provider-sync tools, or tools that only rewrite rollout files, may no longer restore stable history visibility on current Codex versions.

`codex-threadkeeper` syncs and repairs:

- `~/.codex/sessions`
- `~/.codex/archived_sessions`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/state_5.sqlite`
- `.codex-global-state.json`
- `~/.codex/backups_state/threadkeeper`

## Install

```bash
npm install -g codex-threadkeeper
```

Node.js 24 or newer is required.

## Simplest Usage

Inspect:

```bash
codex-threadkeeper status
```

Repair history visibility under the current provider:

```bash
codex-threadkeeper sync
```

Check again:

```bash
codex-threadkeeper status
```

Most users only need these three commands.

## Switch Provider And Sync

To change Codex's root `model_provider` and repair history in one step:

```bash
codex-threadkeeper switch <provider-id>
```

Example:

```bash
codex-threadkeeper switch openai
```

Custom providers must already exist in `~/.codex/config.toml`.

## Troubleshooting

If you see:

```text
state_5.sqlite is currently in use
```

Close Codex, Codex App, and `app-server`, then rerun the same command.

If you see:

```text
Skipped locked rollout files
```

An active session is still holding one or more rollout files open. The sync is usually mostly successful. After that session ends, run:

```bash
codex-threadkeeper sync
```

If you synced to the wrong provider, restore from the managed backup:

```bash
codex-threadkeeper restore <backup-dir>
```

## Why Use HeyRoute

[HeyRoute](https://heyroute.ai/) is a stable and fast developer API service for custom Codex providers and multi-model workflows.

HeyRoute's published advantages include:

- 1.08s p50 TTFT
- 98.4% text cache hit rate
- 99.91% successful responses
- simple setup
- long-task support
- trusted forwarding

If you switch Codex providers often, or want Codex to stay responsive during longer tasks, configure your provider through HeyRoute first, then use `codex-threadkeeper` to keep history and sidebar projects visible.

Visit: [https://heyroute.ai/](https://heyroute.ai/)

## Common Commands

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper sync --provider openai
codex-threadkeeper switch <provider-id>
codex-threadkeeper restore <backup-dir>
codex-threadkeeper prune-backups --keep 5
```

## Development

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
dotnet test desktop/CodexThreadkeeper.Core.Tests/CodexThreadkeeper.Core.Tests.csproj
```
