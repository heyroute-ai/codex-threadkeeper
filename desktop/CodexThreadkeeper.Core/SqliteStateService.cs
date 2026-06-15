using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace CodexThreadkeeper.Core;

public sealed class SqliteStateService
{
    private const int DefaultBusyTimeoutMs = 5000;

    static SqliteStateService()
    {
        SQLitePCL.Batteries_V2.Init();
    }

    public string StateDbPath(string codexHome)
    {
        return AppConstants.StateDbPath(codexHome);
    }

    public string LegacyStateDbPath(string codexHome)
    {
        return AppConstants.LegacyStateDbPath(codexHome);
    }

    public string StateDbPathForRead(string codexHome)
    {
        string modernPath = StateDbPath(codexHome);
        if (File.Exists(modernPath))
        {
            return modernPath;
        }

        string legacyPath = LegacyStateDbPath(codexHome);
        return File.Exists(legacyPath) ? legacyPath : modernPath;
    }

    public async Task<ProviderCounts?> ReadSqliteProviderCountsAsync(string codexHome)
    {
        string dbPath = StateDbPathForRead(codexHome);
        if (!File.Exists(dbPath))
        {
            return null;
        }

        await using SqliteConnection connection = OpenConnection(dbPath);
        await connection.OpenAsync();
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
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
            """;

        Dictionary<string, int> sessions = new(StringComparer.Ordinal);
        Dictionary<string, int> archivedSessions = new(StringComparer.Ordinal);
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            string provider = reader.GetString(0);
            bool archived = reader.GetInt64(1) != 0;
            int count = reader.GetInt32(2);
            Dictionary<string, int> bucket = archived ? archivedSessions : sessions;
            bucket[provider] = count;
        }

        return new ProviderCounts
        {
            Sessions = sessions,
            ArchivedSessions = archivedSessions
        };
    }

    public async Task<IReadOnlyList<string>> ReadSqliteProjectPathsAsync(string codexHome)
    {
        string dbPath = StateDbPathForRead(codexHome);
        if (!File.Exists(dbPath))
        {
            return [];
        }

        await using SqliteConnection connection = OpenConnection(dbPath);
        await connection.OpenAsync();
        try
        {
            return await CollectSqliteProjectPathsAsync(connection);
        }
        catch (SqliteException error) when (IsMissingColumn(error, "cwd"))
        {
            return [];
        }
    }

    public async Task<IReadOnlyList<ThreadWorkspaceHint>> ReadSqliteThreadWorkspaceHintsAsync(string codexHome)
    {
        string dbPath = StateDbPathForRead(codexHome);
        if (!File.Exists(dbPath))
        {
            return [];
        }

        await using SqliteConnection connection = OpenConnection(dbPath);
        await connection.OpenAsync();
        try
        {
            return await CollectSqliteThreadWorkspaceHintsAsync(connection);
        }
        catch (SqliteException error) when (IsMissingColumn(error, "cwd") || IsMissingColumn(error, "has_user_event"))
        {
            return [];
        }
    }

    public async Task<bool> AssertSqliteWritableAsync(string codexHome, int? busyTimeoutMs = null)
    {
        string dbPath = StateDbPathForRead(codexHome);
        if (!File.Exists(dbPath))
        {
            return false;
        }

        await using SqliteConnection connection = OpenConnection(dbPath);
        try
        {
            await connection.OpenAsync();
            await SetBusyTimeoutAsync(connection, busyTimeoutMs);
            await ExecuteNonQueryAsync(connection, "BEGIN IMMEDIATE");
            await ExecuteNonQueryAsync(connection, "ROLLBACK");
            return true;
        }
        catch (Exception error)
        {
            throw WrapSqliteBusyError(error, "update session provider metadata");
        }
    }

    public async Task<SqliteUpdateResult> UpdateSqliteProviderAsync(
        string codexHome,
        string targetProvider,
        Func<SqliteUpdateResult, Task>? afterUpdate = null,
        int? busyTimeoutMs = null)
    {
        string dbPath = StateDbPathForRead(codexHome);
        if (!File.Exists(dbPath))
        {
            SqliteUpdateResult missingResult = new()
            {
                UpdatedRows = 0,
                CwdRowsUpdated = 0,
                UserEventRowsUpdated = 0,
                DatabasePresent = false,
                ProjectPaths = [],
                ThreadWorkspaceHints = []
            };
            if (afterUpdate is not null)
            {
                await afterUpdate(missingResult);
            }

            return missingResult;
        }

        await using SqliteConnection connection = OpenConnection(dbPath);
        bool transactionOpen = false;
        try
        {
            await connection.OpenAsync();
            await SetBusyTimeoutAsync(connection, busyTimeoutMs);
            await ExecuteNonQueryAsync(connection, "BEGIN IMMEDIATE");
            transactionOpen = true;

            await using SqliteCommand command = connection.CreateCommand();
            command.CommandText = """
                UPDATE threads
                SET model_provider = $provider
                WHERE COALESCE(model_provider, '') <> $provider
                """;
            command.Parameters.AddWithValue("$provider", targetProvider);
            int updatedRows = await command.ExecuteNonQueryAsync();

            int cwdRowsUpdated = await NormalizeSqliteCwdPathsAsync(connection);
            int userEventRowsUpdated = await RepairSqliteHasUserEventRowsAsync(connection);
            SqliteUpdateResult result = new()
            {
                UpdatedRows = updatedRows,
                CwdRowsUpdated = cwdRowsUpdated,
                UserEventRowsUpdated = userEventRowsUpdated,
                DatabasePresent = true,
                ProjectPaths = await CollectSqliteProjectPathsAsync(connection),
                ThreadWorkspaceHints = await CollectSqliteThreadWorkspaceHintsAsync(connection)
            };

            if (afterUpdate is not null)
            {
                await afterUpdate(result);
            }

            await ExecuteNonQueryAsync(connection, "COMMIT");
            transactionOpen = false;
            return result;
        }
        catch (Exception error)
        {
            if (transactionOpen)
            {
                try
                {
                    await ExecuteNonQueryAsync(connection, "ROLLBACK");
                }
                catch
                {
                    // Ignore rollback failures and surface the original error.
                }
            }

            throw WrapSqliteBusyError(error, "update session provider metadata");
        }
    }

    private static async Task<IReadOnlyList<string>> CollectSqliteProjectPathsAsync(SqliteConnection connection)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT DISTINCT cwd
            FROM threads
            WHERE TRIM(COALESCE(cwd, '')) <> ''
            ORDER BY LOWER(cwd), cwd
            """;

        List<string> projectPaths = [];
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            projectPaths.Add(reader.GetString(0));
        }

        return projectPaths;
    }

    private static async Task<IReadOnlyList<ThreadWorkspaceHint>> CollectSqliteThreadWorkspaceHintsAsync(SqliteConnection connection)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, cwd
            FROM threads
            WHERE archived = 0
              AND has_user_event = 1
              AND TRIM(COALESCE(id, '')) <> ''
              AND TRIM(COALESCE(cwd, '')) <> ''
            ORDER BY id
            """;

        List<ThreadWorkspaceHint> hints = [];
        await using SqliteDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            hints.Add(new ThreadWorkspaceHint(reader.GetString(0), reader.GetString(1)));
        }

        return hints;
    }

    private static async Task<int> NormalizeSqliteCwdPathsAsync(SqliteConnection connection)
    {
        List<(string Id, string Cwd)> rows = [];
        try
        {
            await using SqliteCommand select = connection.CreateCommand();
            select.CommandText = """
                SELECT id, cwd
                FROM threads
                WHERE cwd LIKE $prefix
                """;
            select.Parameters.AddWithValue("$prefix", "\\\\?\\%");
            await using SqliteDataReader reader = await select.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                rows.Add((reader.GetString(0), reader.GetString(1)));
            }
        }
        catch (SqliteException error) when (IsMissingColumn(error, "cwd"))
        {
            return 0;
        }

        int updatedRows = 0;
        foreach ((string id, string cwd) in rows)
        {
            string? normalized = NormalizeSqliteCwd(cwd);
            if (string.IsNullOrWhiteSpace(normalized) || string.Equals(normalized, cwd, StringComparison.Ordinal))
            {
                continue;
            }

            await using SqliteCommand update = connection.CreateCommand();
            update.CommandText = "UPDATE threads SET cwd = $cwd WHERE id = $id";
            update.Parameters.AddWithValue("$cwd", normalized);
            update.Parameters.AddWithValue("$id", id);
            updatedRows += await update.ExecuteNonQueryAsync();
        }

        return updatedRows;
    }

    private static string? NormalizeSqliteCwd(string cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd) || !cwd.StartsWith("\\\\?\\", StringComparison.Ordinal))
        {
            return null;
        }

        return GlobalStateService.NormalizeWorkspaceRootPath(cwd);
    }

    private static async Task<int> RepairSqliteHasUserEventRowsAsync(SqliteConnection connection)
    {
        List<(string Id, string RolloutPath)> rows = [];
        try
        {
            await using SqliteCommand select = connection.CreateCommand();
            select.CommandText = """
                SELECT id, rollout_path
                FROM threads
                WHERE has_user_event = 0
                  AND TRIM(COALESCE(rollout_path, '')) <> ''
                """;
            await using SqliteDataReader reader = await select.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                rows.Add((reader.GetString(0), reader.GetString(1)));
            }
        }
        catch (SqliteException error) when (IsMissingColumn(error, "rollout_path") || IsMissingColumn(error, "has_user_event"))
        {
            return 0;
        }

        int updatedRows = 0;
        foreach ((string id, string rolloutPath) in rows)
        {
            if (!await RolloutHasUserEventAsync(rolloutPath))
            {
                continue;
            }

            await using SqliteCommand update = connection.CreateCommand();
            update.CommandText = "UPDATE threads SET has_user_event = 1 WHERE id = $id";
            update.Parameters.AddWithValue("$id", id);
            updatedRows += await update.ExecuteNonQueryAsync();
        }

        return updatedRows;
    }

    private static async Task<bool> RolloutHasUserEventAsync(string rolloutPath)
    {
        if (!File.Exists(rolloutPath))
        {
            return false;
        }

        try
        {
            await foreach (string line in File.ReadLinesAsync(rolloutPath))
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                try
                {
                    JsonNode? node = JsonNode.Parse(line);
                    if (node?["type"]?.GetValue<string>() == "event_msg"
                        && node["payload"]?["type"]?.GetValue<string>() == "user_message")
                    {
                        return true;
                    }
                }
                catch
                {
                    // Ignore malformed rollout rows and continue scanning.
                }
            }
        }
        catch
        {
            return false;
        }

        return false;
    }

    private static SqliteConnection OpenConnection(string dbPath)
    {
        SqliteConnectionStringBuilder builder = new()
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false
        };
        return new SqliteConnection(builder.ConnectionString);
    }

    private static async Task SetBusyTimeoutAsync(SqliteConnection connection, int? busyTimeoutMs)
    {
        int timeout = busyTimeoutMs is >= 0 ? busyTimeoutMs.Value : DefaultBusyTimeoutMs;
        await ExecuteNonQueryAsync(connection, $"PRAGMA busy_timeout = {timeout}");
    }

    private static async Task ExecuteNonQueryAsync(SqliteConnection connection, string commandText)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = commandText;
        await command.ExecuteNonQueryAsync();
    }

    private static Exception WrapSqliteBusyError(Exception error, string action)
    {
        if (error is not SqliteException sqliteError
            || (sqliteError.SqliteErrorCode != 5 && sqliteError.SqliteErrorCode != 6))
        {
            return error;
        }

        return new InvalidOperationException(
            $"Unable to {action} because state_5.sqlite is currently in use. Close Codex and the Codex app, then retry. Original error: {sqliteError.Message}",
            sqliteError);
    }

    private static bool IsMissingColumn(SqliteException error, string columnName)
    {
        return error.Message.Contains($"no such column: {columnName}", StringComparison.OrdinalIgnoreCase);
    }
}
