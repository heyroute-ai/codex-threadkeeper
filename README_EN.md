<div align="center">

# codex-threadkeeper

### Fix the “threads still exist, but disappear after switching provider” problem in Codex

[![CI](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/heyroute-ai/codex-threadkeeper/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/heyroute-ai/codex-threadkeeper)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Community](https://img.shields.io/badge/community-LINUX%20DO-2ea043.svg)](https://linux.do/)

English | [中文](README.md)

</div>

## What This Project Fixes

When `model_provider` changes, Codex history often looks "lost" even though the underlying thread data is still there.

In practice, the usual problem is metadata drift:

- rollout files say one thing
- SQLite says another
- the sidebar project list is missing paths that still have threads behind them

Typical symptoms:

- old threads disappear after switching provider
- `codex resume` and Codex App disagree
- threads still exist, but the sidebar project vanishes until you manually use `Add Project`

`codex-threadkeeper` realigns the metadata that drives visibility:

- rollout files in `~/.codex/sessions` and `~/.codex/archived_sessions`
- SQLite thread state in `~/.codex/sqlite/state_5.sqlite` (legacy fallback: `~/.codex/state_5.sqlite`)
- sidebar project state in `.codex-global-state.json`
- managed backups in `~/.codex/backups_state/threadkeeper`

It does not replace Codex itself. It fixes thread visibility and recovery metadata around Codex.

## How It Differs From The Original Provider-Sync Tool

This repo is now maintained as an independent project, not just a lightly renamed provider-sync helper.

The practical differences are:

- it restores missing sidebar projects, not just rollout and SQLite provider fields
- CLI sync shows stage-by-stage progress instead of looking hung
- sync summary reports backup creation time
- Windows lock-directory creation retries transient `EPERM` races
- runtime namespaces now live under `threadkeeper`
  - backups: `backups_state/threadkeeper`
  - lock path: `tmp/threadkeeper.lock`
  - GUI settings: `%AppData%\\codex-threadkeeper`
- old `provider-sync` backups are no longer auto-discovered, but can still be restored by passing the legacy path explicitly
- GUI, CLI, and Windows launcher flows are all still supported

## Daily Usage

These are the only flows most people need day to day.

| Situation | Command | Use it when |
| --- | --- | --- |
| Inspect current state | `codex-threadkeeper status` | you want to see current provider plus rollout/SQLite distribution |
| Repair visibility only | `codex-threadkeeper sync` | you already switched provider elsewhere and only need history to line up |
| Switch provider and sync | `codex-threadkeeper switch <provider-id>` | you want one command to update `config.toml` and sync history |
| Roll back a sync | `codex-threadkeeper restore <backup-dir>` | you synced to the wrong provider or want to undo a run |
| Remove old backups | `codex-threadkeeper prune-backups --keep 5` | you only want to keep the newest managed backups |

For normal Windows users, the GUI is the easiest daily path:

1. Open `CodexThreadkeeper.exe`
2. Click `Refresh`
3. Pick the target provider
4. Click `Execute`

If you prefer CLI, the normal repair flow is:

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper status
```

If you want to switch provider at the same time:

```bash
codex-threadkeeper status
codex-threadkeeper switch openai
codex-threadkeeper status
```

## A Typical End-To-End Run

In most cases, you do not need to close Codex first. Start by running:

```bash
codex-threadkeeper status
codex-threadkeeper sync
```

If the command completes, SQLite was not exclusively locked during that run and Codex App can stay open. Only handle active processes when one of these appears:

- `state_5.sqlite is currently in use`: close Codex / Codex App / `app-server`, then rerun the same command
- `Skipped locked rollout files`: end the active session holding those rollout files, then rerun `codex-threadkeeper sync` later

The most important fields in the sync summary are:

- `Updated rollout files`
- `Added sidebar projects`
- `Updated SQLite rows`

Those three numbers tell you whether the run repaired rollout metadata, sidebar visibility, and SQLite state.

Run `status` again after that. If rollout and SQLite provider counts now agree, the repair is usually complete.

## Key Troubleshooting Lesson: Why `sync` Can Bring History Back

One failure mode is easy to misread: old threads briefly flash in the UI and then disappear again, or early `sync` runs keep reporting `Updated SQLite rows: 0`.

That is usually not a generic cache problem, and it is not caused by `.codex` simply being messy. The first thing to verify is the SQLite database Codex App actually reads today:

```text
~/.codex/sqlite/state_5.sqlite
```

Older Codex builds or older helper tools may also leave this legacy path behind:

```text
~/.codex/state_5.sqlite
```

If the legacy database already has the target provider but the modern database still has the old provider, Codex App will still render from the modern database and the threads can remain hidden. A real repair usually needs to align several fields together:

- rollout `model_provider`
- SQLite `threads.model_provider`
- SQLite `threads.cwd`, especially Windows extended-length paths such as `\\?\E:\repo`
- SQLite `threads.has_user_event`
- `.codex-global-state.json` `thread-workspace-root-hints`

So do not judge a repair by rollout files alone. Check whether `status` shows matching provider counts for rollout and SQLite. If `sync` reports these fields, it usually means the command repaired the index Codex App is actually using:

```text
Updated SQLite rows: ...
Normalized SQLite cwd rows: ...
Repaired SQLite user-event rows: ...
Added thread workspace hints: ...
```

That is why the recommended repair sequence is:

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper status
```

Manual rollout edits alone can make the files look correct while Codex App continues to hide threads based on stale SQLite metadata.

## Install

### CLI

```bash
npm install -g codex-threadkeeper
```

Requirements:

- Node.js `24+`
- standard `~/.codex` layout
- currently tested primarily on Windows

### GUI

If you do not want Node or terminal commands, download `CodexThreadkeeper.exe` from Releases.

GUI-specific notes are in [README_GUI_ZH.md](README_GUI_ZH.md).

## Command Quick Reference

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

With an explicit Codex home:

```bash
codex-threadkeeper status --codex-home C:\Users\you\.codex
codex-threadkeeper sync --codex-home C:\Users\you\.codex
codex-threadkeeper switch openai --codex-home C:\Users\you\.codex
```

## Common Cases

### `state_5.sqlite is currently in use`

This is not data corruption. It usually means SQLite was exclusively locked by Codex / Codex App / `app-server` at that moment. You do not need to close Codex preemptively every time; try `codex-threadkeeper sync` first and close those processes only if this error appears.

Close Codex / Codex App / `app-server`, then rerun the same command.

### `Skipped locked rollout files`

Usually an active session still has one or more rollout files open.

That means:

- SQLite probably already synced
- most rollout files probably already synced
- only the still-locked files were skipped
- if `state_5.sqlite is currently in use` did not appear, you usually do not need to close all of Codex for this case

End that active session and rerun `codex-threadkeeper sync` later if you want a fully clean rewrite.

### I still have old `provider-sync` backups

That is fine. They are no longer auto-discovered, but you can still restore one explicitly:

```bash
codex-threadkeeper restore C:\Users\you\.codex\backups_state\provider-sync\20260319T042708906Z
```

## Safety Boundaries

This tool edits metadata, but it does not replace Codex itself.

It does not:

- manage `auth.json`
- log you into third-party providers
- rewrite message bodies
- rewrite titles or timestamps
- clean up unmanaged legacy backup folders as if they belonged to this tool

Default runtime paths:

```text
~/.codex/backups_state/threadkeeper/<timestamp>
~/.codex/tmp/threadkeeper.lock
```

## For AI Agents

Machine-oriented guidance lives in [AGENTS.md](AGENTS.md).

## Development

```bash
git clone https://github.com/heyroute-ai/codex-threadkeeper.git
cd codex-threadkeeper
npm test
dotnet test desktop/CodexThreadkeeper.Core.Tests/CodexThreadkeeper.Core.Tests.csproj
pwsh ./scripts/publish-gui.ps1
```

## License

MIT
