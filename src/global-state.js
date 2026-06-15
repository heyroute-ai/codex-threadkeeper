import fs from "node:fs/promises";
import path from "node:path";

import { GLOBAL_STATE_FILE_BASENAME } from "./constants.js";

export function globalStatePath(codexHome) {
  return path.join(codexHome, GLOBAL_STATE_FILE_BASENAME);
}

function stripExtendedLengthPrefix(workspaceRoot) {
  return workspaceRoot.startsWith("\\\\?\\")
    ? workspaceRoot.slice(4)
    : workspaceRoot;
}

export function normalizeWorkspaceRootPath(workspaceRoot) {
  if (typeof workspaceRoot !== "string") {
    return null;
  }

  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    return null;
  }

  let normalized = path.win32.normalize(stripExtendedLengthPrefix(trimmed));
  const parsed = path.win32.parse(normalized);
  if (normalized !== parsed.root) {
    normalized = normalized.replace(/[\\/]+$/, "");
  }

  if (/^[a-z]:/.test(normalized)) {
    normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }

  return normalized;
}

export function workspaceRootKey(workspaceRoot) {
  const normalized = normalizeWorkspaceRootPath(workspaceRoot);
  return normalized ? normalized.toLowerCase() : null;
}

function compareWorkspaceRoots(left, right) {
  const leftKey = workspaceRootKey(left) ?? "";
  const rightKey = workspaceRootKey(right) ?? "";
  return leftKey.localeCompare(rightKey) || left.localeCompare(right);
}

function isCodexWorktreePath(workspaceRootKeyValue, codexHomeKey) {
  if (!workspaceRootKeyValue) {
    return false;
  }

  if (codexHomeKey && workspaceRootKeyValue.startsWith(`${codexHomeKey}\\worktrees\\`)) {
    return true;
  }

  return workspaceRootKeyValue.includes("\\.codex\\worktrees\\");
}

export function collectSidebarProjectCandidates(workspaceRoots, codexHome) {
  const normalizedCodexHome = normalizeWorkspaceRootPath(codexHome);
  const codexHomeKey = workspaceRootKey(normalizedCodexHome);
  const uniquePaths = new Map();

  for (const workspaceRoot of workspaceRoots ?? []) {
    const normalized = normalizeWorkspaceRootPath(workspaceRoot);
    if (!normalized) {
      continue;
    }

    const key = workspaceRootKey(normalized);
    if (!key || key === codexHomeKey) {
      continue;
    }
    if (isCodexWorktreePath(key, codexHomeKey)) {
      continue;
    }

    if (!uniquePaths.has(key)) {
      uniquePaths.set(key, normalized);
    }
  }

  return [...uniquePaths.values()].sort(compareWorkspaceRoots);
}

function collectPinnedSidebarProjects(workspaceRoots, codexHome) {
  const normalizedCodexHome = normalizeWorkspaceRootPath(codexHome);
  const codexHomeKey = workspaceRootKey(normalizedCodexHome);
  const uniquePaths = new Map();

  for (const workspaceRoot of workspaceRoots ?? []) {
    const normalized = normalizeWorkspaceRootPath(workspaceRoot);
    if (!normalized) {
      continue;
    }

    const key = workspaceRootKey(normalized);
    if (!key || key === codexHomeKey) {
      continue;
    }
    if (isCodexWorktreePath(key, codexHomeKey)) {
      continue;
    }

    if (!uniquePaths.has(key)) {
      uniquePaths.set(key, normalized);
    }
  }

  return [...uniquePaths.values()];
}

function collectKnownSidebarProjects(globalStateData, codexHome) {
  if (!globalStateData || typeof globalStateData !== "object") {
    return [];
  }

  const hintValues = globalStateData["thread-workspace-root-hints"] && typeof globalStateData["thread-workspace-root-hints"] === "object"
    ? Object.values(globalStateData["thread-workspace-root-hints"])
    : [];

  return collectSidebarProjectCandidates([
    ...(Array.isArray(globalStateData["electron-saved-workspace-roots"]) ? globalStateData["electron-saved-workspace-roots"] : []),
    ...(Array.isArray(globalStateData["project-order"]) ? globalStateData["project-order"] : []),
    ...(Array.isArray(globalStateData["active-workspace-roots"]) ? globalStateData["active-workspace-roots"] : []),
    ...hintValues
  ], codexHome);
}

export async function readGlobalState(codexHome) {
  const filePath = globalStatePath(codexHome);
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        filePath,
        text: null,
        data: null
      };
    }
    throw error;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${GLOBAL_STATE_FILE_BASENAME}: ${error.message}`);
  }

  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error(`Invalid ${GLOBAL_STATE_FILE_BASENAME}: expected a top-level JSON object.`);
  }

  return {
    exists: true,
    filePath,
    text,
    data
  };
}

export async function syncSidebarProjects(codexHome, workspaceRoots) {
  return syncSidebarProjectsWithPinned(codexHome, workspaceRoots, []);
}

function collectThreadWorkspaceHintUpdates(threadWorkspaceHints, allowedProjectKeys) {
  const updates = [];
  for (const hint of threadWorkspaceHints ?? []) {
    if (!hint || typeof hint.id !== "string" || !hint.id.trim()) {
      continue;
    }
    const normalized = normalizeWorkspaceRootPath(hint.workspaceRoot);
    const key = workspaceRootKey(normalized);
    if (!normalized || !key || !allowedProjectKeys.has(key)) {
      continue;
    }
    updates.push({
      id: hint.id,
      workspaceRoot: normalized
    });
  }
  return updates;
}

export async function syncSidebarProjectsWithPinned(codexHome, workspaceRoots, pinnedProjects = [], threadWorkspaceHints = []) {
  const state = await readGlobalState(codexHome);
  const knownSidebarProjects = collectKnownSidebarProjects(state.data, codexHome);
  const sqliteProjectKeys = new Set(
    collectSidebarProjectCandidates(workspaceRoots, codexHome)
      .map((workspaceRoot) => workspaceRootKey(workspaceRoot))
      .filter(Boolean)
  );
  const normalizedCandidates = knownSidebarProjects.filter((workspaceRoot) => sqliteProjectKeys.has(workspaceRootKey(workspaceRoot)));
  const normalizedPinnedProjects = collectPinnedSidebarProjects(pinnedProjects, codexHome);

  const workspaceRootsList = Array.isArray(state.data?.["electron-saved-workspace-roots"])
    ? [...state.data["electron-saved-workspace-roots"]]
    : [];
  const projectOrderList = Array.isArray(state.data?.["project-order"])
    ? [...state.data["project-order"]]
    : [];

  const workspaceRootKeys = new Set(
    workspaceRootsList
      .filter((value) => typeof value === "string")
      .map((value) => workspaceRootKey(value))
      .filter(Boolean)
  );
  const projectOrderKeys = new Set(
    projectOrderList
      .filter((value) => typeof value === "string")
      .map((value) => workspaceRootKey(value))
      .filter(Boolean)
  );

  const addedProjects = normalizedCandidates.filter((workspaceRoot) => {
    const key = workspaceRootKey(workspaceRoot);
    return key && (!workspaceRootKeys.has(key) || !projectOrderKeys.has(key));
  });
  const skippedPinnedProjects = [];
  const pinnedAddedProjects = [];

  for (const workspaceRoot of addedProjects) {
    const key = workspaceRootKey(workspaceRoot);
    if (!workspaceRootKeys.has(key)) {
      workspaceRootsList.push(workspaceRoot);
      workspaceRootKeys.add(key);
    }
    if (!projectOrderKeys.has(key)) {
      projectOrderList.push(workspaceRoot);
      projectOrderKeys.add(key);
    }
  }

  for (const workspaceRoot of normalizedPinnedProjects) {
    try {
      await fs.access(workspaceRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        skippedPinnedProjects.push(workspaceRoot);
        continue;
      }
      throw error;
    }

    const key = workspaceRootKey(workspaceRoot);
    if (!key || (workspaceRootKeys.has(key) && projectOrderKeys.has(key))) {
      continue;
    }

    if (!workspaceRootKeys.has(key)) {
      workspaceRootsList.push(workspaceRoot);
      workspaceRootKeys.add(key);
    }
    if (!projectOrderKeys.has(key)) {
      projectOrderList.push(workspaceRoot);
      projectOrderKeys.add(key);
    }
    pinnedAddedProjects.push(workspaceRoot);
  }

  const allowedProjectKeys = new Set([...workspaceRootKeys, ...projectOrderKeys]);
  const threadHintUpdates = collectThreadWorkspaceHintUpdates(threadWorkspaceHints, allowedProjectKeys);
  const currentThreadHints = state.data?.["thread-workspace-root-hints"] && typeof state.data["thread-workspace-root-hints"] === "object"
    ? state.data["thread-workspace-root-hints"]
    : {};
  const nextThreadHints = { ...currentThreadHints };
  const addedThreadWorkspaceHints = [];
  const normalizedThreadWorkspaceHints = [];
  for (const hint of threadHintUpdates) {
    const existing = currentThreadHints[hint.id];
    if (existing === hint.workspaceRoot) {
      continue;
    }
    nextThreadHints[hint.id] = hint.workspaceRoot;
    if (existing === undefined) {
      addedThreadWorkspaceHints.push(hint);
    } else {
      normalizedThreadWorkspaceHints.push(hint);
    }
  }

  if (
    addedProjects.length === 0
    && pinnedAddedProjects.length === 0
    && addedThreadWorkspaceHints.length === 0
    && normalizedThreadWorkspaceHints.length === 0
  ) {
    return {
      filePath: state.filePath,
      existed: state.exists,
      originalText: state.text,
      modified: false,
      addedProjects: [],
      addedCount: 0,
      pinnedAddedProjects: [],
      pinnedAddedCount: 0,
      skippedPinnedProjects,
      skippedPinnedCount: skippedPinnedProjects.length,
      addedThreadWorkspaceHints: [],
      addedThreadWorkspaceHintCount: 0,
      normalizedThreadWorkspaceHints: [],
      normalizedThreadWorkspaceHintCount: 0
    };
  }

  const nextState = state.exists ? { ...state.data } : {};
  nextState["electron-saved-workspace-roots"] = workspaceRootsList;
  nextState["project-order"] = projectOrderList;
  nextState["thread-workspace-root-hints"] = nextThreadHints;

  await fs.writeFile(state.filePath, JSON.stringify(nextState), "utf8");
  return {
    filePath: state.filePath,
    existed: state.exists,
    originalText: state.text,
    modified: true,
    addedProjects,
    addedCount: addedProjects.length,
    pinnedAddedProjects,
    pinnedAddedCount: pinnedAddedProjects.length,
    skippedPinnedProjects,
    skippedPinnedCount: skippedPinnedProjects.length,
    addedThreadWorkspaceHints,
    addedThreadWorkspaceHintCount: addedThreadWorkspaceHints.length,
    normalizedThreadWorkspaceHints,
    normalizedThreadWorkspaceHintCount: normalizedThreadWorkspaceHints.length
  };
}

export async function restoreGlobalStateSnapshot(snapshot) {
  if (!snapshot?.filePath) {
    return;
  }

  if (snapshot.existed) {
    await fs.writeFile(snapshot.filePath, snapshot.originalText ?? "", "utf8");
    return;
  }

  await fs.rm(snapshot.filePath, { force: true });
}
