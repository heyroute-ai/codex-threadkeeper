using System;
using System.IO;

namespace CodexThreadkeeper.Core;

public static class AppConstants
{
    public const string DefaultProvider = "openai";
    public const string BackupNamespace = "threadkeeper";
    public const string DbFileBasename = "state_5.sqlite";
    public const string GlobalStateFileBasename = ".codex-global-state.json";
    public const string PinnedSidebarProjectsFileBasename = "threadkeeper-sidebar-projects.json";
    public const int DefaultBackupRetentionCount = 5;
    public static readonly string[] SessionDirectories = ["sessions", "archived_sessions"];

    public static string DefaultCodexHome()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".codex");
    }

    public static string DefaultBackupRoot(string codexHome)
    {
        return Path.Combine(codexHome, "backups_state", BackupNamespace);
    }

    public static string GlobalStatePath(string codexHome)
    {
        return Path.Combine(codexHome, GlobalStateFileBasename);
    }

    public static string StateDbPath(string codexHome)
    {
        return Path.Combine(codexHome, "sqlite", DbFileBasename);
    }

    public static string LegacyStateDbPath(string codexHome)
    {
        return Path.Combine(codexHome, DbFileBasename);
    }

    public static string PinnedSidebarProjectsPath(string codexHome)
    {
        return Path.Combine(codexHome, PinnedSidebarProjectsFileBasename);
    }

    public static string SettingsDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "codex-threadkeeper");
    }

    public static string SettingsPath()
    {
        return Path.Combine(SettingsDirectory(), "settings.json");
    }

    public static string LockPath(string codexHome)
    {
        return Path.Combine(codexHome, "tmp", "threadkeeper.lock");
    }
}
