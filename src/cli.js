#!/usr/bin/env node

import path from "node:path";

import { DEFAULT_BACKUP_RETENTION_COUNT } from "./constants.js";
import { installWindowsLauncher } from "./launcher.js";
import { pinProject, readPinnedProjects, unpinProject } from "./pinned-projects.js";
import {
  getStatus,
  renderStatus,
  runPruneBackups,
  runRestore,
  runSwitch,
  runSync
} from "./service.js";

function printHelp() {
  console.log(`codex-threadkeeper

Usage:
  codex-threadkeeper status [--codex-home PATH]
  codex-threadkeeper sync [--provider ID] [--keep N] [--codex-home PATH]
  codex-threadkeeper switch <provider-id> [--keep N] [--codex-home PATH]
  codex-threadkeeper prune-backups [--keep N] [--codex-home PATH]
  codex-threadkeeper restore <backup-dir> [--codex-home PATH]
  codex-threadkeeper list-pinned-projects [--codex-home PATH]
  codex-threadkeeper pin-project <path> [--codex-home PATH]
  codex-threadkeeper unpin-project <path> [--codex-home PATH]
  codex-threadkeeper install-windows-launcher [--dir PATH] [--codex-home PATH]
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [flagName, inlineValue] = value.split("=", 2);
    const normalizedName = flagName.slice(2);
    if (inlineValue !== undefined) {
      flags[normalizedName] = inlineValue;
      continue;
    }
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      flags[normalizedName] = nextValue;
      index += 1;
    } else {
      flags[normalizedName] = true;
    }
  }

  return { positionals, flags };
}

function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex home: ${result.codexHome}`,
    `Backup: ${result.backupDir}`,
    `Backup creation time: ${formatDuration(result.backupDurationMs ?? 0)}`,
    `Updated rollout files: ${result.changedSessionFiles}`,
    `Added sidebar projects: ${result.addedSidebarProjects ?? 0}`,
    `Restored pinned sidebar projects: ${result.restoredPinnedSidebarProjects ?? 0}`,
    `Skipped missing pinned sidebar projects: ${result.skippedMissingPinnedSidebarProjects ?? 0}`,
    `Updated SQLite rows: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`,
    `Normalized SQLite cwd rows: ${result.sqliteCwdRowsUpdated ?? 0}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`,
    `Repaired SQLite user-event rows: ${result.sqliteUserEventRowsUpdated ?? 0}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`
  ];
  if (result.skippedLockedRolloutFiles?.length) {
    const preview = result.skippedLockedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedLockedRolloutFiles.length - Math.min(result.skippedLockedRolloutFiles.length, 5);
    lines.push(`Skipped locked rollout files: ${result.skippedLockedRolloutFiles.length}`);
    lines.push(`Locked file(s): ${preview}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  if (result.autoPruneResult) {
    lines.push(
      `Backup cleanup: deleted ${result.autoPruneResult.deletedCount}, remaining ${result.autoPruneResult.remainingCount}, freed ${formatBytes(result.autoPruneResult.freedBytes)}`
    );
  }
  if (result.autoPruneWarning) {
    lines.push(`Backup cleanup warning: ${result.autoPruneWarning}`);
  }
  return lines.join("\n");
}

function summarizePrune(result) {
  return [
    `Backup root: ${result.backupRoot}`,
    `Deleted backups: ${result.deletedCount}`,
    `Remaining backups: ${result.remainingCount}`,
    `Freed space: ${formatBytes(result.freedBytes)}`
  ].join("\n");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${bytes} B` : `${value.toFixed(value >= 10 ? 1 : 2).replace(/\.0$/, "")} ${units[unitIndex]}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs ?? 0))} ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0$/, "")} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - (minutes * 60);
  return `${minutes}m ${remainingSeconds.toFixed(remainingSeconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
}

const SYNC_PROGRESS_STAGES = [
  ["scan_rollout_files", "Scanning rollout files..."],
  ["check_locked_rollout_files", "Checking locked rollout files..."],
  ["create_backup", "Creating backup..."],
  ["update_sqlite", "Updating SQLite..."],
  ["rewrite_rollout_files", "Rewriting rollout files..."],
  ["sync_sidebar_projects", "Syncing sidebar projects..."],
  ["clean_backups", "Cleaning backups..."]
];

const SYNC_PROGRESS_STAGE_INDEX = new Map(
  SYNC_PROGRESS_STAGES.map(([stage], index) => [stage, index + 1])
);

function createSyncProgressReporter() {
  return (event) => {
    if (event?.stage === "update_config" && event.status === "start") {
      console.log(`Updating config.toml root model_provider to ${event.provider}...`);
      return;
    }

    const stageIndex = SYNC_PROGRESS_STAGE_INDEX.get(event?.stage);
    if (!stageIndex || event.status !== "start") {
      if (event?.stage === "create_backup" && event.status === "complete") {
        console.log(`     Backup created in ${formatDuration(event.durationMs)}: ${event.backupDir}`);
      }
      return;
    }

    console.log(`[${stageIndex}/${SYNC_PROGRESS_STAGES.length}] ${SYNC_PROGRESS_STAGES[stageIndex - 1][1]}`);
  };
}

function parseKeepCount(rawValue, { allowZero = false } = {}) {
  if (rawValue === undefined) {
    return DEFAULT_BACKUP_RETENTION_COUNT;
  }
  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) {
    const minimum = allowZero ? 0 : 1;
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  const keepCount = Number.parseInt(normalized, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(keepCount) || keepCount < minimum) {
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  return keepCount;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (!command || command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "status") {
    const status = await getStatus({ codexHome: flags["codex-home"] });
    console.log(renderStatus(status));
    return;
  }

  if (command === "sync") {
    const result = await runSync({
      codexHome: flags["codex-home"],
      provider: flags.provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "Synchronized"));
    return;
  }

  if (command === "switch") {
    const provider = positionals[1] ?? flags.provider;
    const result = await runSwitch({
      codexHome: flags["codex-home"],
      provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "Switched to"));
    return;
  }

  if (command === "prune-backups") {
    const result = await runPruneBackups({
      codexHome: flags["codex-home"],
      keepCount: parseKeepCount(flags.keep, { allowZero: true })
    });
    console.log(summarizePrune(result));
    return;
  }

  if (command === "restore") {
    const backupDir = positionals[1] ?? flags.backup;
    const result = await runRestore({
      codexHome: flags["codex-home"],
      backupDir
    });
    console.log(`Restored backup from ${path.resolve(backupDir)}`);
    console.log(`Codex home: ${result.codexHome}`);
    console.log(`Provider at backup time: ${result.targetProvider}`);
    return;
  }

  if (command === "list-pinned-projects") {
    const result = await readPinnedProjects(flags["codex-home"]);
    console.log(`Pinned projects: ${result.projects.length}`);
    if (result.projects.length === 0) {
      console.log("(none)");
    } else {
      for (const project of result.projects) {
        console.log(project);
      }
    }
    return;
  }

  if (command === "pin-project") {
    const projectPath = positionals[1] ?? flags.path;
    const result = await pinProject(flags["codex-home"], projectPath);
    console.log(`${result.added ? "Pinned" : "Already pinned"}: ${result.project}`);
    console.log(`Pinned projects: ${result.projects.length}`);
    return;
  }

  if (command === "unpin-project") {
    const projectPath = positionals[1] ?? flags.path;
    const result = await unpinProject(flags["codex-home"], projectPath);
    console.log(`${result.removed ? "Unpinned" : "Not pinned"}: ${result.project}`);
    console.log(`Pinned projects: ${result.projects.length}`);
    return;
  }

  if (command === "install-windows-launcher") {
    const result = await installWindowsLauncher({
      dir: flags.dir,
      codexHome: flags["codex-home"]
    });
    console.log("Installed Windows launcher files:");
    console.log(`  Hidden double-click launcher: ${result.vbsPath}`);
    console.log(`  Visible console launcher: ${result.cmdPath}`);
    console.log(`  Target directory: ${result.targetDir}`);
    if (result.codexHome) {
      console.log(`  Fixed CODEX_HOME: ${result.codexHome}`);
    } else {
      console.log("  CODEX_HOME: default current environment / ~/.codex");
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
