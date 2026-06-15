# AI Operator Guide

This file is for AI assistants, coding agents, and automation tools.

## Goal

Help the user keep historical Codex threads visible after switching `model_provider`, including provider metadata alignment and recovery from managed backups.

For normal Windows users, prefer the GUI app when it is available. Use the CLI when:

- the user explicitly wants commands
- the task is automated
- the GUI EXE is unavailable

The tool primarily works by updating both:

- rollout metadata under `~/.codex/sessions` and `~/.codex/archived_sessions`
- SQLite thread metadata in `~/.codex/sqlite/state_5.sqlite` (legacy fallback: `~/.codex/state_5.sqlite`)

The CLI may also repair missing sidebar project roots from recorded thread metadata when the current global state indicates they should still exist.

Do not solve this by manually editing rollout files only unless the user explicitly asks for manual intervention.

## Important Diagnostic Lesson

If history appears briefly and then disappears again, do not assume it is only a cache problem or that `.codex` is simply too messy.

First verify which SQLite database Codex App is actually reading:

- modern path: `~/.codex/sqlite/state_5.sqlite`
- legacy fallback: `~/.codex/state_5.sqlite`

The modern path is authoritative when it exists. A common failure mode is:

- rollout files already show the target provider
- the legacy root `state_5.sqlite` already shows the target provider
- the modern `sqlite/state_5.sqlite` still has stale provider/cwd/user-event metadata

In that case Codex App will keep rendering from the stale modern SQLite index, so history can still be hidden even after rollout files look correct.

An effective sync should be able to repair these together:

- rollout `model_provider`
- SQLite `threads.model_provider`
- SQLite `threads.cwd`, including `\\?\` extended-length Windows prefixes
- SQLite `threads.has_user_event`
- `.codex-global-state.json` `thread-workspace-root-hints`

When diagnosing, compare rollout counts and SQLite counts from `codex-threadkeeper status`. After a successful repair, they should align under the current provider. Treat nonzero `Normalized SQLite cwd rows`, `Repaired SQLite user-event rows`, or `Added thread workspace hints` as useful signs that the command repaired the index Codex App actually uses.

## Preferred Flow

Use this order by default:

1. If the GUI is available and the user is not asking for terminal commands, open `CodexThreadkeeper.exe`
2. Refresh and inspect the current provider plus rollout/SQLite distribution
3. Decide whether the user needs sync, switch-like behavior, or restore
4. Execute the action
5. Report whether the result is complete or partially skipped due to locked files

CLI fallback flow:

1. Run `codex-threadkeeper status`
2. Read `Current provider` and compare rollout/SQLite distribution
3. Decide whether the user needs `sync`, `switch`, or `restore`
4. Run the command
5. Report whether the result is complete or partially skipped due to locked files

## Command Selection

Use `codex-threadkeeper sync` when:

- the user already switched auth/provider using another tool
- the current `config.toml` root `model_provider` is already correct
- the user says things like:
  - "make my old sessions visible again"
  - "resync my Codex history"
  - "I already switched provider"

Use `codex-threadkeeper switch <provider-id>` when:

- the user wants to change the root `model_provider`
- the user wants one command to both switch provider and resync history

Use `codex-threadkeeper restore <backup-dir>` when:

- the user wants to roll back a previous sync
- the user synced to the wrong provider

Use `codex-threadkeeper status` only when:

- the user asks for inspection only
- you need a safe first step before deciding what to do

## GUI Selection

Use the GUI app when:

- the user wants a double-click tool
- the user does not want to install Node/npm
- the user wants to visually inspect providers and backups

GUI mapping:

- `Refresh` = inspect current status
- `Execute` without config checkbox = `sync --provider <selected>`
- `Execute` with config checkbox = switch-like behavior
- `Restore Backup` = restore a previous backup
- backup retention defaults to 5 and can be customized in the GUI
- `Clean Old Backups` = prune managed backups down to the selected retention count

## Important Behavior

- `sync` uses the current root `model_provider` from `~/.codex/config.toml`
- if root `model_provider` is missing, `sync` falls back to `openai`
- `switch` changes root `model_provider`, then runs a sync
- built-in `openai` is always valid
- custom providers must already exist in `config.toml`
- the tool does not log the user in and does not manage `auth.json`
- sync and switch create a backup first, then automatically prune older managed backups
- backup pruning only touches backups created by this tool under `backups_state/threadkeeper`

## Error Handling

If the output says `state_5.sqlite is currently in use`:

- tell the user to close Codex, Codex App, and app-server
- then rerun the same command

If sync reports `Skipped locked rollout files`:

- treat the sync as mostly successful
- explain that the active session still holds one or more rollout files open
- tell the user to rerun `codex-threadkeeper sync` after that session ends if they want a full rewrite

If `switch <provider-id>` fails because the provider is missing:

- tell the user to define it in `config.toml` or switch via their existing provider tool first
- then run `codex-threadkeeper sync`

## Safe Defaults

- default Codex home: `~/.codex`
- prefer `status` before destructive-looking operations, even though this tool only edits metadata
- by default the tool keeps the most recent 5 managed backups
- use GUI retention settings or CLI `--keep <n>` when the user wants a different retention count
- do not edit `state_5.sqlite` or rollout files manually if the tool can do it
- GUI settings live in `%AppData%\codex-threadkeeper\settings.json`

## Recommended Commands

```bash
codex-threadkeeper status
codex-threadkeeper sync
codex-threadkeeper sync --keep 5
codex-threadkeeper sync --provider openai
codex-threadkeeper switch apigather
codex-threadkeeper prune-backups --keep 5
codex-threadkeeper restore C:\Users\you\.codex\backups_state\threadkeeper\20260319T042708906Z
```

With an explicit Codex home:

```bash
codex-threadkeeper status --codex-home C:\Users\you\.codex
codex-threadkeeper sync --codex-home C:\Users\you\.codex
codex-threadkeeper switch openai --codex-home C:\Users\you\.codex
```

## One-Shot Prompt Template

Use this prompt in another AI tool if the user wants one-step handling:

```text
I use codex-threadkeeper. Please help me fix Codex session visibility under my current provider.

Steps:
1. Run `codex-threadkeeper status`.
2. If my current provider is already correct, run `codex-threadkeeper sync`.
3. If I explicitly tell you to switch provider, run `codex-threadkeeper switch <provider-id>` instead.
4. If SQLite is locked, tell me to close Codex / Codex App / app-server and retry.
5. If rollout files are skipped because they are locked, tell me which ones were skipped and remind me to rerun sync later.
6. Summarize the final state of rollout files and SQLite after the command finishes.
```

## User-Facing Summary Style

When reporting results back to the user:

- state the current provider
- state whether rollout files and SQLite are aligned
- mention backup location if a sync or switch was executed
- call out partial success clearly if locked rollout files were skipped
