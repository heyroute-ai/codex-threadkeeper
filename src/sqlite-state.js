import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_BASENAME } from "./constants.js";
import { normalizeWorkspaceRootPath } from "./global-state.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function stateDbPath(codexHome) {
  return path.join(codexHome, DB_FILE_BASENAME);
}

function openDatabase(dbPath) {
  return new DatabaseSync(dbPath);
}

function normalizeBusyTimeoutMs(busyTimeoutMs) {
  return Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0
    ? busyTimeoutMs
    : DEFAULT_BUSY_TIMEOUT_MS;
}

function setBusyTimeout(db, busyTimeoutMs) {
  db.exec(`PRAGMA busy_timeout = ${normalizeBusyTimeoutMs(busyTimeoutMs)}`);
}

function isSqliteBusyError(error) {
  const message = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy") || message.includes("busy");
}

function wrapSqliteBusyError(error, action) {
  if (!isSqliteBusyError(error)) {
    return error;
  }
  return new Error(
    `Unable to ${action} because state_5.sqlite is currently in use. Close Codex and the Codex app, then retry. Original error: ${error.message}`
  );
}

function isMissingColumnError(error, columnName) {
  const message = `${error?.message ?? ""}`.toLowerCase();
  return message.includes(`no such column: ${columnName.toLowerCase()}`);
}

function normalizeSqliteCwd(cwd) {
  if (typeof cwd !== "string" || !/^\\\\\?\\[a-z]:[\\/]/i.test(cwd)) {
    return null;
  }

  const normalized = normalizeWorkspaceRootPath(cwd);
  return normalized && normalized !== cwd ? normalized : null;
}

function normalizeSqliteCwdPaths(db) {
  const rows = db.prepare(`
    SELECT id, cwd
    FROM threads
    WHERE cwd LIKE '\\\\?\\%'
  `).all();
  if (rows.length === 0) {
    return 0;
  }

  const stmt = db.prepare("UPDATE threads SET cwd = ? WHERE id = ?");
  let updatedRows = 0;
  for (const row of rows) {
    const normalized = normalizeSqliteCwd(row.cwd);
    if (!normalized) {
      continue;
    }
    const result = stmt.run(normalized, row.id);
    updatedRows += result.changes ?? 0;
  }

  return updatedRows;
}

function recordIsUserEvent(record) {
  return record?.type === "event_msg" && record?.payload?.type === "user_message";
}

async function rolloutHasUserEvent(rolloutPath) {
  let text;
  try {
    text = await fs.readFile(rolloutPath, "utf8");
  } catch {
    return false;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      if (recordIsUserEvent(JSON.parse(line))) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

async function repairSqliteHasUserEventRows(db) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, rollout_path
      FROM threads
      WHERE has_user_event = 0
        AND TRIM(COALESCE(rollout_path, '')) <> ''
    `).all();
  } catch (error) {
    if (isMissingColumnError(error, "rollout_path") || isMissingColumnError(error, "has_user_event")) {
      return 0;
    }
    throw error;
  }
  if (rows.length === 0) {
    return 0;
  }

  const stmt = db.prepare("UPDATE threads SET has_user_event = 1 WHERE id = ?");
  let updatedRows = 0;
  for (const row of rows) {
    if (!(await rolloutHasUserEvent(row.rollout_path))) {
      continue;
    }
    const result = stmt.run(row.id);
    updatedRows += result.changes ?? 0;
  }

  return updatedRows;
}

export async function readSqliteProviderCounts(codexHome) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return null;
  }

  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN model_provider IS NULL OR model_provider = '' THEN '(missing)'
          ELSE model_provider
        END AS model_provider,
        archived,
        COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, model_provider
    `).all();
    const result = {
      sessions: {},
      archived_sessions: {}
    };
    for (const row of rows) {
      const bucket = row.archived ? result.archived_sessions : result.sessions;
      bucket[row.model_provider] = row.count;
    }
    return result;
  } finally {
    db.close();
  }
}

export async function readSqliteProjectPaths(codexHome) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT DISTINCT cwd
      FROM threads
      WHERE TRIM(COALESCE(cwd, '')) <> ''
      ORDER BY LOWER(cwd), cwd
    `).all();
    return rows.map((row) => row.cwd);
  } catch (error) {
    if (isMissingColumnError(error, "cwd")) {
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readSqliteThreadWorkspaceHints(codexHome) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return [];
  }

  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT id, cwd
      FROM threads
      WHERE archived = 0
        AND has_user_event = 1
        AND TRIM(COALESCE(id, '')) <> ''
        AND TRIM(COALESCE(cwd, '')) <> ''
      ORDER BY id
    `).all();
    return rows.map((row) => ({ id: row.id, workspaceRoot: row.cwd }));
  } catch (error) {
    if (
      isMissingColumnError(error, "cwd")
      || isMissingColumnError(error, "has_user_event")
    ) {
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function assertSqliteWritable(codexHome, options = {}) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return { databasePresent: false };
  }

  const db = openDatabase(dbPath);
  try {
    setBusyTimeout(db, options.busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { databasePresent: true };
  } catch (error) {
    throw wrapSqliteBusyError(error, "update session provider metadata");
  } finally {
    db.close();
  }
}

export async function updateSqliteProvider(codexHome, targetProvider, afterUpdateOrOptions, maybeOptions) {
  const afterUpdate = typeof afterUpdateOrOptions === "function" ? afterUpdateOrOptions : null;
  const options = typeof afterUpdateOrOptions === "function"
    ? (maybeOptions ?? {})
    : (afterUpdateOrOptions ?? {});

  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    if (afterUpdate) {
      await afterUpdate({
        updatedRows: 0,
        cwdRowsUpdated: 0,
        userEventRowsUpdated: 0,
        databasePresent: false
      });
    }
    return {
      updatedRows: 0,
      cwdRowsUpdated: 0,
      userEventRowsUpdated: 0,
      databasePresent: false
    };
  }

  const db = openDatabase(dbPath);
  let transactionOpen = false;
  try {
    setBusyTimeout(db, options.busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const stmt = db.prepare(`
      UPDATE threads
      SET model_provider = ?
      WHERE COALESCE(model_provider, '') <> ?
    `);
    const result = stmt.run(targetProvider, targetProvider);
    const cwdRowsUpdated = normalizeSqliteCwdPaths(db);
    const userEventRowsUpdated = await repairSqliteHasUserEventRows(db);
    if (afterUpdate) {
      await afterUpdate({
        updatedRows: result.changes ?? 0,
        cwdRowsUpdated,
        userEventRowsUpdated,
        databasePresent: true
      });
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return {
      updatedRows: result.changes ?? 0,
      cwdRowsUpdated,
      userEventRowsUpdated,
      databasePresent: true
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and surface the original error.
      }
    }
    throw wrapSqliteBusyError(error, "update session provider metadata");
  } finally {
    db.close();
  }
}
