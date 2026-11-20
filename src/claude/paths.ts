import * as os from 'os';
import * as path from 'path';

export type Env = Record<string, string | undefined>;

/** `~/.devjack`, or `$DEVJACK_HOME` when it is an absolute path (tests and dev launches use this). */
export function devjackHome(env: Env = process.env, home: string = os.homedir()): string {
  const v = env.DEVJACK_HOME;
  return v && path.isAbsolute(v) ? v : path.join(home, '.devjack');
}

/** `$CLAUDE_CONFIG_DIR` when it is absolute, otherwise `~/.claude`. */
export function claudeConfigDir(env: Env = process.env, home: string = os.homedir()): string {
  const v = env.CLAUDE_CONFIG_DIR;
  return v && path.isAbsolute(v) ? v : path.join(home, '.claude');
}

/**
 * The Claude extension can give the panel its own `CLAUDE_CONFIG_DIR` through its
 * `claudeCode.environmentVariables` setting: an array of `{ name, value }`.
 */
export function panelConfigDirFromSetting(setting: unknown): string | undefined {
  if (!Array.isArray(setting)) return undefined;
  for (const item of setting) {
    if (item && typeof item === 'object' && (item as { name?: unknown }).name === 'CLAUDE_CONFIG_DIR') {
      const value = (item as { value?: unknown }).value;
      if (typeof value === 'string' && path.isAbsolute(value)) return value;
    }
  }
  return undefined;
}

export const settingsFile = (configDir: string) => path.join(configDir, 'settings.json');
export const sessionsDir = (configDir: string) => path.join(configDir, 'sessions');
export const inboxDir = (home: string) => path.join(home, 'inbox');
export const heartbeatFile = (home: string) => path.join(home, 'heartbeat');
export const stateFile = (home: string) => path.join(home, 'state.json');

/** Managed settings can switch hooks off (`allowManagedHooksOnly`, `disableAllHooks`). */
export function managedSettingsFile(platform: NodeJS.Platform = process.platform, env: Env = process.env): string {
  if (platform === 'win32') return path.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}
