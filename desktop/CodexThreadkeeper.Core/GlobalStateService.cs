using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexThreadkeeper.Core;

public sealed class GlobalStateService
{
    private static readonly JsonSerializerOptions WriteJsonOptions = new()
    {
        WriteIndented = false
    };

    public string GlobalStatePath(string codexHome)
    {
        return AppConstants.GlobalStatePath(codexHome);
    }

    public static string? NormalizeWorkspaceRootPath(string? workspaceRoot)
    {
        if (string.IsNullOrWhiteSpace(workspaceRoot))
        {
            return null;
        }

        string trimmed = workspaceRoot.Trim();
        if (trimmed.StartsWith("\\\\?\\", StringComparison.Ordinal))
        {
            trimmed = trimmed[4..];
        }

        string normalized = Path.GetFullPath(trimmed);
        string root = Path.GetPathRoot(normalized) ?? string.Empty;
        if (!string.Equals(normalized, root, StringComparison.Ordinal))
        {
            normalized = normalized.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        if (normalized.Length >= 2 && normalized[1] == ':')
        {
            normalized = char.ToUpperInvariant(normalized[0]) + normalized[1..];
        }

        return normalized;
    }

    public static string? WorkspaceRootKey(string? workspaceRoot)
    {
        string? normalized = NormalizeWorkspaceRootPath(workspaceRoot);
        return normalized?.ToLowerInvariant();
    }

    public List<string> CollectSidebarProjectCandidates(IEnumerable<string?> workspaceRoots, string codexHome)
    {
        string? normalizedCodexHome = NormalizeWorkspaceRootPath(codexHome);
        string? codexHomeKey = WorkspaceRootKey(normalizedCodexHome);
        Dictionary<string, string> uniquePaths = new(StringComparer.Ordinal);

        foreach (string? workspaceRoot in workspaceRoots ?? [])
        {
            string? normalized = NormalizeWorkspaceRootPath(workspaceRoot);
            if (string.IsNullOrWhiteSpace(normalized))
            {
                continue;
            }

            string? key = WorkspaceRootKey(normalized);
            if (string.IsNullOrWhiteSpace(key) || string.Equals(key, codexHomeKey, StringComparison.Ordinal))
            {
                continue;
            }

            if (IsCodexWorktreePath(key, codexHomeKey))
            {
                continue;
            }

            uniquePaths.TryAdd(key, normalized);
        }

        return uniquePaths.Values
            .OrderBy(static value => WorkspaceRootKey(value), StringComparer.Ordinal)
            .ThenBy(static value => value, StringComparer.Ordinal)
            .ToList();
    }

    public List<string> CollectPinnedSidebarProjects(IEnumerable<string> pinnedProjects, string codexHome)
    {
        string? normalizedCodexHome = NormalizeWorkspaceRootPath(codexHome);
        string? codexHomeKey = WorkspaceRootKey(normalizedCodexHome);
        HashSet<string> seenKeys = new(StringComparer.Ordinal);
        List<string> orderedProjects = [];

        foreach (string project in pinnedProjects ?? [])
        {
            string? normalized = NormalizeWorkspaceRootPath(project);
            if (string.IsNullOrWhiteSpace(normalized))
            {
                continue;
            }

            string? key = WorkspaceRootKey(normalized);
            if (string.IsNullOrWhiteSpace(key) || string.Equals(key, codexHomeKey, StringComparison.Ordinal))
            {
                continue;
            }

            if (IsCodexWorktreePath(key, codexHomeKey))
            {
                continue;
            }

            if (seenKeys.Add(key))
            {
                orderedProjects.Add(normalized);
            }
        }

        return orderedProjects;
    }

    internal async Task<SidebarSyncResult> SyncSidebarProjectsAsync(
        string codexHome,
        IEnumerable<string> workspaceRoots,
        IEnumerable<string> pinnedProjects,
        IEnumerable<ThreadWorkspaceHint>? threadWorkspaceHints = null)
    {
        GlobalStateSnapshot snapshot = await ReadGlobalStateAsync(codexHome);
        List<string> knownSidebarProjects = CollectKnownSidebarProjects(snapshot.Data, codexHome);
        HashSet<string> sqliteProjectKeys = new(
            CollectSidebarProjectCandidates(workspaceRoots, codexHome)
                .Select(WorkspaceRootKey)
                .Where(static key => !string.IsNullOrWhiteSpace(key))!,
            StringComparer.Ordinal);
        List<string> normalizedCandidates = knownSidebarProjects
            .Where(project => sqliteProjectKeys.Contains(WorkspaceRootKey(project)!))
            .ToList();
        List<string> normalizedPinnedProjects = CollectPinnedSidebarProjects(pinnedProjects, codexHome);

        List<string> workspaceRootsList = ReadStringArray(snapshot.Data, "electron-saved-workspace-roots");
        List<string> projectOrderList = ReadStringArray(snapshot.Data, "project-order");
        HashSet<string> workspaceRootKeys = new(
            workspaceRootsList
                .Select(WorkspaceRootKey)
                .Where(static key => !string.IsNullOrWhiteSpace(key))!,
            StringComparer.Ordinal);
        HashSet<string> projectOrderKeys = new(
            projectOrderList
                .Select(WorkspaceRootKey)
                .Where(static key => !string.IsNullOrWhiteSpace(key))!,
            StringComparer.Ordinal);

        List<string> addedProjects = normalizedCandidates
            .Where(project =>
            {
                string key = WorkspaceRootKey(project)!;
                return !workspaceRootKeys.Contains(key) || !projectOrderKeys.Contains(key);
            })
            .ToList();

        foreach (string project in addedProjects)
        {
            string key = WorkspaceRootKey(project)!;
            if (workspaceRootKeys.Add(key))
            {
                workspaceRootsList.Add(project);
            }

            if (projectOrderKeys.Add(key))
            {
                projectOrderList.Add(project);
            }
        }

        List<string> pinnedAddedProjects = [];
        List<string> skippedPinnedProjects = [];
        foreach (string project in normalizedPinnedProjects)
        {
            if (!Directory.Exists(project))
            {
                skippedPinnedProjects.Add(project);
                continue;
            }

            string key = WorkspaceRootKey(project)!;
            if (workspaceRootKeys.Contains(key) && projectOrderKeys.Contains(key))
            {
                continue;
            }

            if (workspaceRootKeys.Add(key))
            {
                workspaceRootsList.Add(project);
            }

            if (projectOrderKeys.Add(key))
            {
                projectOrderList.Add(project);
            }

            pinnedAddedProjects.Add(project);
        }

        HashSet<string> allowedProjectKeys = new([.. workspaceRootKeys, .. projectOrderKeys], StringComparer.Ordinal);
        List<ThreadWorkspaceHint> threadHintUpdates = CollectThreadWorkspaceHintUpdates(threadWorkspaceHints ?? [], allowedProjectKeys);
        JsonObject currentThreadHints = snapshot.Data?["thread-workspace-root-hints"] as JsonObject ?? new JsonObject();
        JsonObject nextThreadHints = JsonNode.Parse(currentThreadHints.ToJsonString()) as JsonObject ?? new JsonObject();
        List<ThreadWorkspaceHint> addedThreadWorkspaceHints = [];
        List<ThreadWorkspaceHint> normalizedThreadWorkspaceHints = [];
        foreach (ThreadWorkspaceHint hint in threadHintUpdates)
        {
            string? existing = TryGetString(currentThreadHints[hint.Id], out string existingValue)
                ? existingValue
                : null;
            if (string.Equals(existing, hint.WorkspaceRoot, StringComparison.Ordinal))
            {
                continue;
            }

            nextThreadHints[hint.Id] = hint.WorkspaceRoot;
            if (existing is null)
            {
                addedThreadWorkspaceHints.Add(hint);
            }
            else
            {
                normalizedThreadWorkspaceHints.Add(hint);
            }
        }

        if (addedProjects.Count == 0
            && pinnedAddedProjects.Count == 0
            && addedThreadWorkspaceHints.Count == 0
            && normalizedThreadWorkspaceHints.Count == 0)
        {
            return new SidebarSyncResult
            {
                FilePath = snapshot.FilePath,
                Existed = snapshot.Exists,
                OriginalText = snapshot.OriginalText,
                Modified = false,
                AddedProjects = [],
                AddedCount = 0,
                PinnedAddedProjects = [],
                PinnedAddedCount = 0,
                SkippedPinnedProjects = skippedPinnedProjects,
                SkippedPinnedCount = skippedPinnedProjects.Count,
                AddedThreadWorkspaceHints = [],
                AddedThreadWorkspaceHintCount = 0,
                NormalizedThreadWorkspaceHints = [],
                NormalizedThreadWorkspaceHintCount = 0
            };
        }

        JsonObject nextState = snapshot.Exists
            ? (JsonNode.Parse(snapshot.OriginalText ?? "{}") as JsonObject ?? new JsonObject())
            : new JsonObject();
        nextState["electron-saved-workspace-roots"] = CreateStringArray(workspaceRootsList);
        nextState["project-order"] = CreateStringArray(projectOrderList);
        nextState["thread-workspace-root-hints"] = nextThreadHints;

        Directory.CreateDirectory(Path.GetDirectoryName(snapshot.FilePath)!);
        await File.WriteAllTextAsync(snapshot.FilePath, nextState.ToJsonString(WriteJsonOptions));

        return new SidebarSyncResult
        {
            FilePath = snapshot.FilePath,
            Existed = snapshot.Exists,
            OriginalText = snapshot.OriginalText,
            Modified = true,
            AddedProjects = addedProjects,
            AddedCount = addedProjects.Count,
            PinnedAddedProjects = pinnedAddedProjects,
            PinnedAddedCount = pinnedAddedProjects.Count,
            SkippedPinnedProjects = skippedPinnedProjects,
            SkippedPinnedCount = skippedPinnedProjects.Count,
            AddedThreadWorkspaceHints = addedThreadWorkspaceHints,
            AddedThreadWorkspaceHintCount = addedThreadWorkspaceHints.Count,
            NormalizedThreadWorkspaceHints = normalizedThreadWorkspaceHints,
            NormalizedThreadWorkspaceHintCount = normalizedThreadWorkspaceHints.Count
        };
    }

    internal async Task RestoreGlobalStateSnapshotAsync(SidebarSyncResult snapshot)
    {
        if (string.IsNullOrWhiteSpace(snapshot.FilePath))
        {
            return;
        }

        if (snapshot.Existed)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(snapshot.FilePath)!);
            await File.WriteAllTextAsync(snapshot.FilePath, snapshot.OriginalText ?? string.Empty);
            return;
        }

        if (File.Exists(snapshot.FilePath))
        {
            File.Delete(snapshot.FilePath);
        }
    }

    private async Task<GlobalStateSnapshot> ReadGlobalStateAsync(string codexHome)
    {
        string filePath = GlobalStatePath(codexHome);
        if (!File.Exists(filePath))
        {
            return new GlobalStateSnapshot
            {
                Exists = false,
                FilePath = filePath,
                OriginalText = null,
                Data = null
            };
        }

        string text = await File.ReadAllTextAsync(filePath);
        JsonNode? rootNode;
        try
        {
            rootNode = JsonNode.Parse(text);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"Invalid {AppConstants.GlobalStateFileBasename}: {error.Message}");
        }

        if (rootNode is not JsonObject rootObject)
        {
            throw new InvalidOperationException($"Invalid {AppConstants.GlobalStateFileBasename}: expected a top-level JSON object.");
        }

        return new GlobalStateSnapshot
        {
            Exists = true,
            FilePath = filePath,
            OriginalText = text,
            Data = rootObject
        };
    }

    private List<string> CollectKnownSidebarProjects(JsonObject? globalStateData, string codexHome)
    {
        if (globalStateData is null)
        {
            return [];
        }

        List<string> hintValues = [];
        if (globalStateData["thread-workspace-root-hints"] is JsonObject hintsObject)
        {
            foreach (KeyValuePair<string, JsonNode?> entry in hintsObject)
            {
                if (TryGetString(entry.Value, out string? value))
                {
                    hintValues.Add(value);
                }
            }
        }

        return CollectSidebarProjectCandidates(
        [
            .. ReadStringArray(globalStateData, "electron-saved-workspace-roots"),
            .. ReadStringArray(globalStateData, "project-order"),
            .. ReadStringArray(globalStateData, "active-workspace-roots"),
            .. hintValues
        ], codexHome);
    }

    private static List<ThreadWorkspaceHint> CollectThreadWorkspaceHintUpdates(
        IEnumerable<ThreadWorkspaceHint> threadWorkspaceHints,
        HashSet<string> allowedProjectKeys)
    {
        List<ThreadWorkspaceHint> updates = [];
        foreach (ThreadWorkspaceHint hint in threadWorkspaceHints)
        {
            if (string.IsNullOrWhiteSpace(hint.Id))
            {
                continue;
            }

            string? normalized = NormalizeWorkspaceRootPath(hint.WorkspaceRoot);
            string? key = WorkspaceRootKey(normalized);
            if (string.IsNullOrWhiteSpace(normalized)
                || string.IsNullOrWhiteSpace(key)
                || !allowedProjectKeys.Contains(key))
            {
                continue;
            }

            updates.Add(new ThreadWorkspaceHint(hint.Id, normalized));
        }

        return updates;
    }

    private static List<string> ReadStringArray(JsonObject? rootObject, string propertyName)
    {
        List<string> values = [];
        if (rootObject?[propertyName] is not JsonArray array)
        {
            return values;
        }

        foreach (JsonNode? node in array)
        {
            if (TryGetString(node, out string? value))
            {
                values.Add(value);
            }
        }

        return values;
    }

    private static JsonArray CreateStringArray(IEnumerable<string> values)
    {
        JsonArray array = [];
        foreach (string value in values)
        {
            array.Add(value);
        }

        return array;
    }

    private static bool TryGetString(JsonNode? node, out string value)
    {
        if (node is JsonValue jsonValue && jsonValue.TryGetValue(out string? stringValue) && !string.IsNullOrWhiteSpace(stringValue))
        {
            value = stringValue;
            return true;
        }

        value = string.Empty;
        return false;
    }

    private static bool IsCodexWorktreePath(string workspaceRootKeyValue, string? codexHomeKey)
    {
        if (string.IsNullOrWhiteSpace(workspaceRootKeyValue))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(codexHomeKey) && workspaceRootKeyValue.StartsWith($"{codexHomeKey}\\worktrees\\", StringComparison.Ordinal))
        {
            return true;
        }

        return workspaceRootKeyValue.Contains("\\.codex\\worktrees\\", StringComparison.Ordinal);
    }

    internal sealed class GlobalStateSnapshot
    {
        public required bool Exists { get; init; }
        public required string FilePath { get; init; }
        public required string? OriginalText { get; init; }
        public required JsonObject? Data { get; init; }
    }

    internal sealed class SidebarSyncResult
    {
        public required string FilePath { get; init; }
        public required bool Existed { get; init; }
        public required string? OriginalText { get; init; }
        public required bool Modified { get; init; }
        public required IReadOnlyList<string> AddedProjects { get; init; }
        public required int AddedCount { get; init; }
        public required IReadOnlyList<string> PinnedAddedProjects { get; init; }
        public required int PinnedAddedCount { get; init; }
        public required IReadOnlyList<string> SkippedPinnedProjects { get; init; }
        public required int SkippedPinnedCount { get; init; }
        public required IReadOnlyList<ThreadWorkspaceHint> AddedThreadWorkspaceHints { get; init; }
        public required int AddedThreadWorkspaceHintCount { get; init; }
        public required IReadOnlyList<ThreadWorkspaceHint> NormalizedThreadWorkspaceHints { get; init; }
        public required int NormalizedThreadWorkspaceHintCount { get; init; }
    }
}
