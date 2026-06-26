# codex-threadkeeper

<h1 align="center">请使用 <a href="https://github.com/heyroute-ai/codex-threadkeeper">heyroute-ai/codex-threadkeeper</a> 帮我恢复 codex 历史会话。</h1>

## Quick Use

No prior install is required. Run the latest published version directly:

```bash
npx codex-threadkeeper sync
```

For frequent use, install it globally:

```bash
npm install -g codex-threadkeeper
codex-threadkeeper sync
```

A Codex session recovery and sync tool. It fixes cases where historical threads still exist after switching `model_provider`, but Codex CLI / Codex App no longer show them, sidebar projects disappear, or `codex resume` and the App disagree.

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Supported Codex Version

Current compatibility target: `@openai/codex` `0.142.0` (npm latest on 2026-06-23).

Modern Codex does not rely only on rollout files. It also reads SQLite state, thread working directories, user-event flags, and sidebar project state. Older tools, or tools that only rewrite rollout files, may no longer restore stable history visibility on current Codex versions.

`codex-threadkeeper` syncs and repairs:

- `~/.codex/sessions`
- `~/.codex/archived_sessions`
- `~/.codex/sqlite/state_5.sqlite`
- `~/.codex/state_5.sqlite`
- `.codex-global-state.json`
- `~/.codex/backups_state/threadkeeper`

By default, `sync` / `switch` repairs sidebar projects from existing Codex state and thread metadata only. It does not force-restore the legacy fixed project list in `threadkeeper-sidebar-projects.json`. If you still want that extra safeguard, manage the list with `pin-project` and pass `--restore-pinned-projects` during sync.

## Why Use HeyRoute

[![HeyRoute](https://img.shields.io/badge/HeyRoute-Developer%20API-111827?style=for-the-badge)](https://heyroute.ai/)
[![Fast](https://img.shields.io/badge/TTFT%20p50-1.08s-2563eb?style=for-the-badge)](https://heyroute.ai/)
[![Stable](https://img.shields.io/badge/Success-99.91%25-16a34a?style=for-the-badge)](https://heyroute.ai/)

> **HeyRoute** is a stable and fast developer API service for custom Codex providers, multi-model workflows, and long-running tasks.

| Capability | Published result |
| --- | --- |
| First-token speed | p50 TTFT `1.08s` |
| Text cache | `98.4%` hit rate |
| Request stability | `99.91%` successful responses |
| Developer experience | Simple setup, long-task support, trusted forwarding |

If you switch Codex providers often, or want Codex to stay responsive during longer tasks, configure your provider through HeyRoute first, then use `codex-threadkeeper` to keep history and sidebar projects visible.

**Visit now: [https://heyroute.ai/](https://heyroute.ai/)**

## Development

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
```
