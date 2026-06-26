import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createBackup,
  getBackupSummary,
  pruneBackups,
  restoreBackup,
  updateSessionBackupManifest
} from "../src/backup.js";
import { writePinnedProjects as persistPinnedProjects } from "../src/pinned-projects.js";
import { getStatus, runRestore, runSwitch, runSync } from "../src/service.js";
import { DEFAULT_BACKUP_RETENTION_COUNT } from "../src/constants.js";
import { applySessionChanges, collectSessionChanges } from "../src/session-files.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-threadkeeper-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(path.join(codexHome, "sessions", "2026", "03", "19"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "archived_sessions", "2026", "03", "18"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "sqlite"), { recursive: true });
  return { root, codexHome };
}

async function writeRollout(filePath, id, provider) {
  const payload = {
    id,
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message: "hi" } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeCustomRollout(filePath, payload, message = "hi") {
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function backupRoot(codexHome) {
  return path.join(codexHome, "backups_state", "threadkeeper");
}

function legacyBackupRoot(codexHome) {
  return path.join(codexHome, "backups_state", "provider-sync");
}

async function writeBackup(codexHome, directoryName, files) {
  const backupDir = path.join(backupRoot(codexHome), directoryName);
  await fs.mkdir(backupDir, { recursive: true });
  let totalBytes = 0;
  if (!files.some(([relativePath]) => relativePath === "metadata.json")) {
    const metadataPath = path.join(backupDir, "metadata.json");
    const metadataContent = JSON.stringify({
      version: 1,
      namespace: "threadkeeper",
      codexHome,
      targetProvider: "openai",
      createdAt: "2026-03-24T00:00:00.000Z",
      dbFiles: [],
      changedSessionFiles: 0
    }, null, 2);
    await fs.writeFile(metadataPath, metadataContent, "utf8");
    const metadataStat = await fs.stat(metadataPath);
    totalBytes += metadataStat.size;
  }
  for (const [relativePath, content] of files) {
    const fullPath = path.join(backupDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    const stat = await fs.stat(fullPath);
    totalBytes += stat.size;
  }
  return totalBytes;
}

async function writeLegacyBackup(codexHome, directoryName, files) {
  const backupDir = path.join(legacyBackupRoot(codexHome), directoryName);
  await fs.mkdir(backupDir, { recursive: true });
  for (const [relativePath, content] of files) {
    const fullPath = path.join(backupDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return backupDir;
}

async function writeConfig(codexHome, modelProviderLine = "") {
  const config = `${modelProviderLine}${modelProviderLine ? "\n" : ""}sandbox_mode = "danger-full-access"\n\n[model_providers.apigather]\nbase_url = "https://example.com"\n`;
  await fs.writeFile(path.join(codexHome, "config.toml"), config, "utf8");
}

async function writeGlobalState(codexHome, state) {
  await fs.writeFile(path.join(codexHome, ".codex-global-state.json"), JSON.stringify(state), "utf8");
}

async function readGlobalState(codexHome) {
  return JSON.parse(await fs.readFile(path.join(codexHome, ".codex-global-state.json"), "utf8"));
}

async function writePinnedProjects(codexHome, projects) {
  await persistPinnedProjects(codexHome, projects);
}

async function writeStateDb(codexHome, rows) {
  const dbPath = path.join(codexHome, "sqlite", "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL DEFAULT '',
        model_provider TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        cwd TEXT,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        first_user_message TEXT NOT NULL DEFAULT ''
      )
    `);
    const stmt = db.prepare("INSERT INTO threads (id, rollout_path, model_provider, archived, cwd, has_user_event, first_user_message) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(
        row.id,
        row.rollout_path ?? "",
        row.model_provider,
        row.archived ? 1 : 0,
        row.cwd ?? null,
        row.has_user_event ? 1 : 0,
        row.first_user_message ?? "hello"
      );
    }
  } finally {
    db.close();
  }
}

async function writeCurrentCodexStateDb(codexHome, rows) {
  const dbPath = path.join(codexHome, "sqlite", "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled',
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT,
        preview TEXT NOT NULL DEFAULT '',
        recency_at INTEGER NOT NULL DEFAULT 0,
        recency_at_ms INTEGER NOT NULL DEFAULT 0
      )
    `);
    const stmt = db.prepare(`
      INSERT INTO threads (
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        has_user_event,
        archived,
        cli_version,
        first_user_message,
        created_at_ms,
        updated_at_ms,
        preview,
        recency_at,
        recency_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, row] of rows.entries()) {
      const createdAt = row.created_at ?? 1773878400 + index;
      const updatedAt = row.updated_at ?? createdAt;
      const createdAtMs = row.created_at_ms ?? createdAt * 1000;
      const updatedAtMs = row.updated_at_ms ?? updatedAt * 1000;
      stmt.run(
        row.id,
        row.rollout_path ?? "",
        createdAt,
        updatedAt,
        row.source ?? "cli",
        row.model_provider,
        row.cwd ?? "C:\\AITemp",
        row.title ?? "hello",
        row.sandbox_policy ?? "workspace-write",
        row.approval_mode ?? "on-request",
        row.has_user_event ? 1 : 0,
        row.archived ? 1 : 0,
        row.cli_version ?? "0.142.0",
        row.first_user_message ?? "hello",
        createdAtMs,
        updatedAtMs,
        row.preview ?? row.first_user_message ?? "hello",
        row.recency_at ?? updatedAt,
        row.recency_at_ms ?? updatedAtMs
      );
    }
  } finally {
    db.close();
  }
}

async function lockRolloutFile(filePath, shareMode = "None") {
  const script = `
& {
  param([string]$path, [string]$shareMode)
  $share = [System.Enum]::Parse([System.IO.FileShare], $shareMode)
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, $share)
  try {
    Write-Output 'locked'
    [Console]::Out.Flush()
    Start-Sleep -Seconds 30
  } finally {
    $stream.Close()
  }
}
`.trim();

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    filePath,
    shareMode
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("locked")) {
        settled = true;
        resolve();
      }
    });

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to acquire rollout file lock. Exit code: ${code ?? "null"}, signal: ${signal ?? "null"}`));
      }
    });
  });

  return child;
}

async function runCli(args) {
  const cliPath = path.resolve("src", "cli.js");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("runSync rewrites rollout files and sqlite, then restore reverts both", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\Existing"],
    "project-order": ["E:\\Existing"],
    "active-workspace-roots": ["E:\\Existing"],
    "thread-workspace-root-hints": {
      alpha: "E:\\Alpha",
      beta: "E:\\Beta"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "newapi");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\Alpha" },
    { id: "thread-b", model_provider: "newapi", archived: true, cwd: "\\\\?\\E:\\Beta" }
  ]);

  const syncResult = await runSync({ codexHome });
  assert.equal(syncResult.targetProvider, "openai");
  assert.equal(typeof syncResult.backupDurationMs, "number");
  assert.ok(syncResult.backupDurationMs >= 0);
  assert.equal(syncResult.changedSessionFiles, 2);
  assert.equal(syncResult.addedSidebarProjects, 2);
  assert.deepEqual(syncResult.skippedLockedRolloutFiles, []);
  assert.equal(syncResult.sqliteRowsUpdated, 2);

  const syncedSession = await fs.readFile(sessionPath, "utf8");
  const syncedArchived = await fs.readFile(archivedPath, "utf8");
  assert.match(syncedSession, /"model_provider":"openai"/);
  assert.match(syncedArchived, /"model_provider":"openai"/);
  const syncedGlobalState = await readGlobalState(codexHome);
  assert.deepEqual(syncedGlobalState["electron-saved-workspace-roots"], ["E:\\Existing", "E:\\Alpha", "E:\\Beta"]);
  assert.deepEqual(syncedGlobalState["project-order"], ["E:\\Existing", "E:\\Alpha", "E:\\Beta"]);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const providers = db
      .prepare("SELECT id, model_provider FROM threads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(providers, [
      { id: "thread-a", model_provider: "openai" },
      { id: "thread-b", model_provider: "openai" }
    ]);
  } finally {
    db.close();
  }

  await runRestore({ codexHome, backupDir: syncResult.backupDir });

  const restoredSession = await fs.readFile(sessionPath, "utf8");
  const restoredArchived = await fs.readFile(archivedPath, "utf8");
  assert.match(restoredSession, /"model_provider":"apigather"/);
  assert.match(restoredArchived, /"model_provider":"newapi"/);
  const restoredGlobalState = await readGlobalState(codexHome);
  assert.deepEqual(restoredGlobalState, {
    "electron-saved-workspace-roots": ["E:\\Existing"],
    "project-order": ["E:\\Existing"],
    "active-workspace-roots": ["E:\\Existing"],
    "thread-workspace-root-hints": {
      alpha: "E:\\Alpha",
      beta: "E:\\Beta"
    }
  });
});

test("runSync reports stage progress and backup duration", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\SidebarProject"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\SidebarProject" }
  ]);

  const progressEvents = [];
  const result = await runSync({
    codexHome,
    onProgress(event) {
      progressEvents.push(event);
    }
  });

  assert.ok(result.backupDurationMs >= 0);
  assert.deepEqual(
    progressEvents
      .filter((event) => event.status === "start")
      .map((event) => event.stage),
    [
      "scan_rollout_files",
      "check_locked_rollout_files",
      "create_backup",
      "update_sqlite",
      "rewrite_rollout_files",
      "sync_sidebar_projects",
      "clean_backups"
    ]
  );

  const backupCompleteEvent = progressEvents.find((event) => event.stage === "create_backup" && event.status === "complete");
  assert.ok(backupCompleteEvent);
  assert.equal(backupCompleteEvent.backupDir, result.backupDir);
  assert.ok(backupCompleteEvent.durationMs >= 0);
  const sidebarCompleteEvent = progressEvents.find((event) => event.stage === "sync_sidebar_projects" && event.status === "complete");
  assert.ok(sidebarCompleteEvent);
  assert.equal(sidebarCompleteEvent.addedCount, 1);
});

test("runSwitch updates config and syncs provider metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\SwitchSidebar"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: "E:\\SwitchSidebar" }
  ]);

  const result = await runSwitch({ codexHome, provider: "apigather" });
  assert.equal(result.targetProvider, "apigather");
  assert.equal(result.addedSidebarProjects, 1);

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "apigather"/m);
  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState["electron-saved-workspace-roots"], ["E:\\SwitchSidebar"]);
  assert.deepEqual(globalState["project-order"], ["E:\\SwitchSidebar"]);
});

test("status reports implicit default provider and rollout/sqlite counts", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "openai");
  const backupOneBytes = await writeBackup(codexHome, "20260319T000000000Z", [["note.txt", "backup-one"]]);
  const backupTwoBytes = await writeBackup(codexHome, "20260320T000000000Z", [["note.txt", "backup-two"]]);
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "openai", archived: true }
  ]);

  const status = await getStatus({ codexHome });
  assert.equal(status.currentProvider, "openai");
  assert.equal(status.currentProviderImplicit, true);
  assert.deepEqual(status.rolloutCounts.sessions, { apigather: 1 });
  assert.deepEqual(status.sqliteCounts.archived_sessions, { openai: 1 });
  assert.equal(status.backupSummary.count, 2);
  assert.equal(status.backupSummary.totalBytes, backupOneBytes + backupTwoBytes);
});

test("runSwitch rejects unknown custom providers", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await assert.rejects(
    () => runSwitch({ codexHome, provider: "missing" }),
    /Provider "missing" is not available/
  );
});

test("runSync leaves rollout files and sqlite untouched when sqlite is locked", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\LockedProject"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\LockedProject" }
  ]);

  const lockDb = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => runSync({ codexHome, sqliteBusyTimeoutMs: 0 }),
      /state_5\.sqlite is currently in use/
    );
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures in tests.
    }
    lockDb.close();
  }

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }
});

test("runSync skips locked rollout files and still updates sqlite", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\LockedProject"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\LockedProject" }
  ]);

  const lockProcess = await lockRolloutFile(sessionPath);
  let result;
  try {
    result = await runSync({ codexHome, sqliteBusyTimeoutMs: 0 });
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }

  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.addedSidebarProjects, 1);
  assert.equal(result.sqliteRowsUpdated, 1);
  assert.deepEqual(result.skippedLockedRolloutFiles, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "openai");
  } finally {
    db.close();
  }
});

test("runSync adds missing sidebar projects even when rollout and sqlite providers are already aligned", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\MissingSidebar"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: "E:\\MissingSidebar" }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.addedSidebarProjects, 1);
  assert.equal(result.restoredPinnedSidebarProjects, 0);
  assert.equal(result.skippedMissingPinnedSidebarProjects, 0);

  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState["electron-saved-workspace-roots"], ["E:\\MissingSidebar"]);
  assert.deepEqual(globalState["project-order"], ["E:\\MissingSidebar"]);
});

test("runSync normalizes extended-length sqlite cwd paths for visible projects", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\VisibleProject"],
    "project-order": ["E:\\VisibleProject"],
    "thread-workspace-root-hints": {
      alpha: "E:\\VisibleProject"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    {
      id: "thread-a",
      rollout_path: sessionPath,
      model_provider: "openai",
      archived: false,
      cwd: "\\\\?\\E:\\VisibleProject"
    }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.sqliteCwdRowsUpdated, 1);
  assert.equal(result.sqliteUserEventRowsUpdated, 1);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db.prepare("SELECT cwd, has_user_event FROM threads WHERE id = ?").get("thread-a");
    assert.equal(row.cwd, "E:\\VisibleProject");
    assert.equal(row.has_user_event, 1);
  } finally {
    db.close();
  }
});

test("runSync supports current Codex threads schema", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\RealSchemaProject"],
    "project-order": ["E:\\RealSchemaProject"],
    "thread-workspace-root-hints": {}
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-current-schema.jsonl");
  await writeRollout(sessionPath, "thread-current", "apigather");
  await writeCurrentCodexStateDb(codexHome, [
    {
      id: "thread-current",
      rollout_path: sessionPath,
      model_provider: "apigather",
      archived: false,
      cwd: "\\\\?\\E:\\RealSchemaProject",
      has_user_event: false,
      preview: "hello current schema"
    }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 1);
  assert.equal(result.sqliteRowsUpdated, 1);
  assert.equal(result.sqliteCwdRowsUpdated, 1);
  assert.equal(result.sqliteUserEventRowsUpdated, 1);
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.addedThreadWorkspaceHints, 1);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db.prepare(`
      SELECT model_provider, cwd, has_user_event, preview, recency_at, recency_at_ms
      FROM threads
      WHERE id = ?
    `).get("thread-current");
    assert.deepEqual({ ...row }, {
      model_provider: "openai",
      cwd: "E:\\RealSchemaProject",
      has_user_event: 1,
      preview: "hello current schema",
      recency_at: 1773878400,
      recency_at_ms: 1773878400000
    });
  } finally {
    db.close();
  }

  const globalState = await readGlobalState(codexHome);
  assert.equal(globalState["thread-workspace-root-hints"]["thread-current"], "E:\\RealSchemaProject");
});

test("runSync adds missing thread workspace hints for existing sidebar projects", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\VisibleProject"],
    "project-order": ["E:\\VisibleProject"],
    "thread-workspace-root-hints": {}
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    {
      id: "thread-a",
      rollout_path: sessionPath,
      model_provider: "openai",
      archived: false,
      cwd: "E:\\VisibleProject",
      has_user_event: true
    }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.addedThreadWorkspaceHints, 1);
  assert.equal(result.normalizedThreadWorkspaceHints, 0);

  const globalState = await readGlobalState(codexHome);
  assert.equal(globalState["thread-workspace-root-hints"]["thread-a"], "E:\\VisibleProject");
  assert.deepEqual(globalState["electron-saved-workspace-roots"], ["E:\\VisibleProject"]);
  assert.deepEqual(globalState["project-order"], ["E:\\VisibleProject"]);
});

test("runSync ignores pinned sidebar projects by default", async () => {
  const { codexHome, root } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const pinnedProjects = [
    path.join(root, "Playground"),
    path.join(root, "RedNote-WebOps"),
    path.join(root, "ahe-ai-video-workflow"),
    path.join(root, "Skygarden"),
    path.join(root, "minsy_mvp_frontend_v2"),
    path.join(root, "Astock_Next"),
    path.join(root, "codex-threadkeeper")
  ];
  for (const project of pinnedProjects) {
    await fs.mkdir(project, { recursive: true });
  }
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": [pinnedProjects[5], pinnedProjects[6]],
    "project-order": [pinnedProjects[5], pinnedProjects[6]],
    "active-workspace-roots": [pinnedProjects[6]]
  });
  await writePinnedProjects(codexHome, pinnedProjects);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: pinnedProjects[5] }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.restoredPinnedSidebarProjects, 0);
  assert.equal(result.skippedMissingPinnedSidebarProjects, 0);

  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState["electron-saved-workspace-roots"], pinnedProjects.slice(5));
  assert.deepEqual(globalState["project-order"], pinnedProjects.slice(5));
  assert.deepEqual(globalState["active-workspace-roots"], [pinnedProjects[6]]);
});

test("runSync restores pinned sidebar projects only when explicitly enabled", async () => {
  const { codexHome, root } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const pinnedProjects = [
    path.join(root, "Playground"),
    path.join(root, "RedNote-WebOps"),
    path.join(root, "ahe-ai-video-workflow"),
    path.join(root, "Skygarden"),
    path.join(root, "minsy_mvp_frontend_v2"),
    path.join(root, "Astock_Next"),
    path.join(root, "codex-threadkeeper")
  ];
  for (const project of pinnedProjects) {
    await fs.mkdir(project, { recursive: true });
  }
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": [pinnedProjects[5], pinnedProjects[6]],
    "project-order": [pinnedProjects[5], pinnedProjects[6]],
    "active-workspace-roots": [pinnedProjects[6]]
  });
  await writePinnedProjects(codexHome, pinnedProjects);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: pinnedProjects[5] }
  ]);

  const result = await runSync({ codexHome, restorePinnedProjects: true });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.restoredPinnedSidebarProjects, 5);
  assert.equal(result.skippedMissingPinnedSidebarProjects, 0);

  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState["electron-saved-workspace-roots"], pinnedProjects.slice(5).concat(pinnedProjects.slice(0, 5)));
  assert.deepEqual(globalState["project-order"], pinnedProjects.slice(5).concat(pinnedProjects.slice(0, 5)));
  assert.deepEqual(globalState["active-workspace-roots"], [pinnedProjects[6]]);
});

test("runSync skips missing pinned sidebar projects when explicitly enabled", async () => {
  const { codexHome, root } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {});
  await writePinnedProjects(codexHome, [path.join(root, "DefinitelyMissingPinnedProject")]);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: "E:\\AnotherProject" }
  ]);

  const result = await runSync({ codexHome, restorePinnedProjects: true });
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.restoredPinnedSidebarProjects, 0);
  assert.equal(result.skippedMissingPinnedSidebarProjects, 1);
});

test("runSync does not resurrect projects from bare sqlite cwd history", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\KeepMe"],
    "project-order": ["E:\\KeepMe"]
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false, cwd: "E:\\OldRemovedProject", has_user_event: true }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.addedSidebarProjects, 0);
  assert.equal(result.addedThreadWorkspaceHints, 0);

  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState["electron-saved-workspace-roots"], ["E:\\KeepMe"]);
  assert.deepEqual(globalState["project-order"], ["E:\\KeepMe"]);
});

test("runSync ignores worktree-only cwd entries when syncing sidebar projects", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\WorktreeOnly"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    {
      id: "thread-a",
      model_provider: "openai",
      archived: false,
      cwd: path.join(codexHome, "worktrees", "1234", "Project")
    }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 0);
  assert.equal(result.addedSidebarProjects, 0);
  const globalState = await readGlobalState(codexHome);
  assert.deepEqual(globalState, {
    "thread-workspace-root-hints": {
      alpha: "E:\\WorktreeOnly"
    }
  });
});

test("runSync fails on invalid global state json and rolls back rollout/sqlite changes", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await fs.writeFile(path.join(codexHome, ".codex-global-state.json"), "{not valid json", "utf8");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\BrokenState" }
  ]);

  await assert.rejects(
    () => runSync({ codexHome }),
    /Invalid \.codex-global-state\.json/
  );

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }

  const globalStateText = await fs.readFile(path.join(codexHome, ".codex-global-state.json"), "utf8");
  assert.equal(globalStateText, "{not valid json");
});

test("runSync ignores invalid pinned project json by default", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {});
  await fs.writeFile(path.join(codexHome, "threadkeeper-sidebar-projects.json"), "{broken", "utf8");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\BrokenPinned" }
  ]);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 1);
  assert.equal(result.sqliteRowsUpdated, 1);
  assert.equal(result.restoredPinnedSidebarProjects, 0);
  assert.equal(result.skippedMissingPinnedSidebarProjects, 0);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"openai"/);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-a");
    assert.equal(row.model_provider, "openai");
  } finally {
    db.close();
  }
});

test("runSync validates pinned project json when pinned restore is enabled", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {});
  await fs.writeFile(path.join(codexHome, "threadkeeper-sidebar-projects.json"), "{broken", "utf8");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\BrokenPinned" }
  ]);

  await assert.rejects(
    () => runSync({ codexHome, restorePinnedProjects: true }),
    /Invalid threadkeeper-sidebar-projects\.json/
  );

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "sqlite", "state_5.sqlite"));
  try {
    const row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }
});

test("applySessionChanges skips rollout files that changed after collection", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  await fs.appendFile(
    sessionPath,
    '{"timestamp":"2026-03-19T00:00:01.000Z","type":"event_msg","payload":{"type":"assistant_message","message":"later"}}\n',
    "utf8"
  );

  const result = await applySessionChanges(changes);
  assert.equal(result.appliedChanges, 0);
  assert.deepEqual(result.skippedPaths, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
  assert.match(rollout, /"message":"later"/);
});

test("applySessionChanges preserves large UTF-8 session metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-large.jsonl");
  const payload = {
    id: "thread-large",
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp\\中文",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: "apigather",
    title: "中文会话",
    note: "保留 UTF-8 内容",
    large_blob: "数据块".repeat(40000)
  };
  await writeCustomRollout(sessionPath, payload, "你好");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const result = await applySessionChanges(changes);

  assert.equal(result.appliedChanges, 1);
  assert.deepEqual(result.skippedPaths, []);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"openai"/);
  assert.match(rollout, /"title":"中文会话"/);
  assert.match(rollout, /"note":"保留 UTF-8 内容"/);
  assert.match(rollout, /"message":"你好"/);
  assert.match(rollout, /"large_blob":"数据块数据块/);
});

test("applySessionChanges skips only the rollout file that becomes locked on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const lockedPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-locked.jsonl");
  const writablePath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-writable.jsonl");
  await writeRollout(lockedPath, "thread-locked", "apigather");
  await writeRollout(writablePath, "thread-writable", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const lockProcess = await lockRolloutFile(lockedPath);
  let result;
  try {
    result = await applySessionChanges(changes);
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }

  assert.equal(result.appliedChanges, 1);
  assert.deepEqual(result.appliedPaths, [writablePath]);
  assert.deepEqual(result.skippedPaths, [lockedPath]);

  const lockedRollout = await fs.readFile(lockedPath, "utf8");
  const writableRollout = await fs.readFile(writablePath, "utf8");
  assert.match(lockedRollout, /"model_provider":"apigather"/);
  assert.match(writableRollout, /"model_provider":"openai"/);
});

test("restoreBackup only restores rollout files that were actually applied", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const configPath = path.join(codexHome, "config.toml");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const backupDir = await createBackup({
    codexHome,
    targetProvider: "openai",
    sessionChanges: changes,
    configPath
  });

  await updateSessionBackupManifest(backupDir, []);
  await writeRollout(sessionPath, "thread-a", "manual");
  await writeGlobalState(codexHome, {
    "electron-saved-workspace-roots": ["E:\\ShouldBeRemoved"],
    "project-order": ["E:\\ShouldBeRemoved"]
  });

  await restoreBackup(backupDir, codexHome, {
    restoreConfig: false,
    restoreDatabase: false,
    restoreSessions: true
  });

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"manual"/);
  await assert.rejects(fs.access(path.join(codexHome, ".codex-global-state.json")));
});

test("runRestore accepts an explicit legacy provider-sync backup path", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "manual");

  const legacyBackupDir = await writeLegacyBackup(codexHome, "20260319T000000000Z", [
    ["config.toml", 'model_provider = "apigather"\n'],
    ["metadata.json", JSON.stringify({
      version: 1,
      namespace: "provider-sync",
      codexHome,
      targetProvider: "apigather",
      createdAt: "2026-03-19T00:00:00.000Z",
      dbFiles: [],
      changedSessionFiles: 1
    }, null, 2)],
    ["session-meta-backup.json", JSON.stringify({
      version: 1,
      namespace: "provider-sync",
      codexHome,
      targetProvider: "apigather",
      createdAt: "2026-03-19T00:00:00.000Z",
      files: [
        {
          path: sessionPath,
          originalFirstLine: JSON.stringify({
            timestamp: "2026-03-19T00:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread-a",
              timestamp: "2026-03-19T00:00:00.000Z",
              cwd: "C:\\AITemp",
              source: "cli",
              cli_version: "0.115.0",
              model_provider: "apigather"
            }
          }),
          originalSeparator: "\n"
        }
      ]
    }, null, 2)]
  ]);

  const result = await runRestore({ codexHome, backupDir: legacyBackupDir });
  assert.equal(result.targetProvider, "apigather");

  const restoredConfig = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  const restoredRollout = await fs.readFile(sessionPath, "utf8");
  assert.match(restoredConfig, /model_provider = "apigather"/);
  assert.match(restoredRollout, /"model_provider":"apigather"/);
});

test("pruneBackups removes the oldest backup directories", async () => {
  const { codexHome } = await makeTempCodexHome();
  const oldestBytes = await writeBackup(codexHome, "20260319T000000000Z", [
    ["note.txt", "oldest"],
    ["db/state_5.sqlite", "sqlite"]
  ]);
  await writeBackup(codexHome, "20260320T000000000Z", [["note.txt", "middle"]]);
  await writeBackup(codexHome, "20260321T000000000Z", [["note.txt", "newest"]]);

  const result = await pruneBackups(codexHome, 2);

  assert.equal(result.backupRoot, backupRoot(codexHome));
  assert.equal(result.deletedCount, 1);
  assert.equal(result.remainingCount, 2);
  assert.equal(result.freedBytes, oldestBytes);
  await assert.rejects(fs.access(path.join(backupRoot(codexHome), "20260319T000000000Z")));
  await fs.access(path.join(backupRoot(codexHome), "20260320T000000000Z"));
  await fs.access(path.join(backupRoot(codexHome), "20260321T000000000Z"));
});

test("pruneBackups ignores directories without managed backup metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeBackup(codexHome, "20260320T000000000Z", [
    ["metadata.json", JSON.stringify({ namespace: "threadkeeper" })]
  ]);
  const junkDirectory = path.join(backupRoot(codexHome), "manual-notes");
  await fs.mkdir(junkDirectory, { recursive: true });
  await fs.writeFile(path.join(junkDirectory, "readme.txt"), "keep me", "utf8");

  const result = await pruneBackups(codexHome, 0);

  assert.equal(result.deletedCount, 1);
  assert.equal(result.remainingCount, 0);
  await fs.access(junkDirectory);
});

test("runSync auto-prunes backups to the default retention count", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\BackupDefault" }
  ]);

  for (let index = 0; index < DEFAULT_BACKUP_RETENTION_COUNT; index += 1) {
    await writeBackup(codexHome, `20240101T0000${String(index).padStart(2, "0")}000Z`, [
      ["note.txt", `backup-${index}`]
    ]);
  }

  const result = await runSync({ codexHome });
  const summary = await getBackupSummary(codexHome);

  assert.equal(summary.count, DEFAULT_BACKUP_RETENTION_COUNT);
  await fs.access(result.backupDir);
  assert.equal(result.autoPruneResult.deletedCount, 1);
  assert.equal(result.autoPruneResult.remainingCount, DEFAULT_BACKUP_RETENTION_COUNT);
  assert.equal(result.autoPruneWarning, null);
});

test("runSync uses a custom automatic backup retention count", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\BackupCustom" }
  ]);

  for (let index = 0; index < 4; index += 1) {
    await writeBackup(codexHome, `20240101T0000${String(index).padStart(2, "0")}000Z`, [
      ["note.txt", `backup-${index}`]
    ]);
  }

  const result = await runSync({ codexHome, keepCount: 2 });
  const summary = await getBackupSummary(codexHome);

  assert.equal(summary.count, 2);
  await fs.access(result.backupDir);
  assert.equal(result.autoPruneResult.deletedCount, 3);
  assert.equal(result.autoPruneResult.remainingCount, 2);
  assert.equal(result.autoPruneWarning, null);
});

test("cli rejects non-integer keep values", async () => {
  const result = await runCli(["prune-backups", "--keep", "1.5"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid --keep value: 1\.5/);
});

test("cli sync prints stage progress and backup timing", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeGlobalState(codexHome, {
    "thread-workspace-root-hints": {
      alpha: "E:\\CliSidebar"
    }
  });
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, cwd: "E:\\CliSidebar" }
  ]);

  const result = await runCli(["sync", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[1\/7\] Scanning rollout files\.\.\./);
  assert.match(result.stdout, /\[2\/7\] Checking locked rollout files\.\.\./);
  assert.match(result.stdout, /\[3\/7\] Creating backup\.\.\./);
  assert.match(result.stdout, /\[4\/7\] Updating SQLite\.\.\./);
  assert.match(result.stdout, /\[5\/7\] Rewriting rollout files\.\.\./);
  assert.match(result.stdout, /\[6\/7\] Syncing sidebar projects\.\.\./);
  assert.match(result.stdout, /\[7\/7\] Cleaning backups\.\.\./);
  assert.match(result.stdout, /Backup created in .*: .+/);
  assert.match(result.stdout, /Backup creation time: /);
  assert.match(result.stdout, /Added sidebar projects: 1/);
  assert.match(result.stdout, /Restored pinned sidebar projects: 0/);
  assert.match(result.stdout, /Skipped missing pinned sidebar projects: 0/);
});

test("cli pin-project, list-pinned-projects, and unpin-project manage pinned projects", async () => {
  const { codexHome } = await makeTempCodexHome();

  let result = await runCli(["pin-project", "E:\\PinnedOne", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pinned: E:\\PinnedOne/);

  result = await runCli(["pin-project", "E:\\PinnedOne", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Already pinned: E:\\PinnedOne/);

  result = await runCli(["list-pinned-projects", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pinned projects: 1/);
  assert.match(result.stdout, /E:\\PinnedOne/);

  result = await runCli(["unpin-project", "E:\\PinnedOne", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Unpinned: E:\\PinnedOne/);

  result = await runCli(["list-pinned-projects", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pinned projects: 0/);
  assert.match(result.stdout, /\(none\)/);
});
