/**
 * Connecting to Claude Code = writing our hook entries into `<config dir>/settings.json` (plan §5.3).
 * File-system side of settingsEditor; no vscode API, so uninstall.ts can use it too.
 */
import * as fs from 'fs';
import * as path from 'path';
import { analyze, planUpdate, type Analysis, type Blocker, type SettingsProblem } from './settingsEditor';
import { managedSettingsFile, settingsFile, stateFile } from './paths';
import { exists, readTextIfExists, writeFileAtomic } from '../util/fsx';
import type { DesiredHooks } from './hookCommand';

export const BACKUP_SUFFIX = '.devjack-backup';

export type ApplyOutcome =
  | 'connected' // entries written
  | 'alreadyCurrent'
  | 'disconnected' // entries removed
  | 'alreadyDisconnected'
  | 'claudeMissing' // config dir doesn't exist: Claude isn't installed; we never create it
  | 'blocked' // invalid file or a blocker: nothing changed
  | 'failed';

export interface ApplyResult {
  outcome: ApplyOutcome;
  settingsPath: string;
  problem?: SettingsProblem;
  blockers?: Blocker[];
  detail?: string;
}

export interface Inspection {
  configDir: string;
  settingsPath: string;
  configDirExists: boolean;
  settingsExists: boolean;
  analysis: Analysis;
  /** Blockers set in managed settings (they win over user settings). */
  managedBlockers: Blocker[];
}

export function inspect(configDir: string, desired: DesiredHooks, managedPath = managedSettingsFile()): Inspection {
  const settingsPath = settingsFile(configDir);
  let text: string | undefined;
  let readError: string | undefined;
  try {
    text = readTextIfExists(settingsPath);
  } catch (e) {
    readError = (e as Error).message;
  }
  const analysis = readError ? { problem: 'invalidJson' as const, problemDetail: readError, blockers: [], hooks: { state: 'missing' as const, ours: 0, v1: 0 } } : analyze(text, desired);
  let managedBlockers: Blocker[] = [];
  try {
    const managed = readTextIfExists(managedPath);
    if (managed !== undefined) managedBlockers = analyze(managed, desired).blockers;
  } catch {
    /* unreadable managed settings: ignore */
  }
  return { configDir, settingsPath, configDirExists: exists(configDir), settingsExists: text !== undefined, analysis, managedBlockers };
}

/**
 * Write (`desired`) or remove (`null`) our entries. Re-reads right before the rename and retries
 * when Claude Code changed the file in between; verifies the result after writing.
 */
export function applyToSettings(configDir: string, desired: DesiredHooks | null, opts: { managedPath?: string; retries?: number } = {}): ApplyResult {
  const settingsPath = settingsFile(configDir);
  if (!exists(configDir)) return { outcome: desired ? 'claudeMissing' : 'alreadyDisconnected', settingsPath };

  if (desired) {
    const insp = inspect(configDir, desired, opts.managedPath);
    const blockers = [...new Set([...insp.analysis.blockers, ...insp.managedBlockers])];
    if (insp.analysis.problem) return { outcome: 'blocked', settingsPath, problem: insp.analysis.problem, detail: insp.analysis.problemDetail };
    if (blockers.length) return { outcome: 'blocked', settingsPath, blockers };
  }

  for (let attempt = 0; attempt <= (opts.retries ?? 3); attempt++) {
    let before: string | undefined;
    try {
      before = readTextIfExists(settingsPath);
    } catch (e) {
      return { outcome: 'failed', settingsPath, detail: (e as Error).message };
    }
    const plan = planUpdate(before, desired);
    if (!plan.ok) return { outcome: 'blocked', settingsPath, problem: plan.problem, detail: plan.detail };
    if (!plan.changed) return { outcome: desired ? 'alreadyCurrent' : 'alreadyDisconnected', settingsPath };

    try {
      if (before !== undefined && !exists(settingsPath + BACKUP_SUFFIX)) fs.copyFileSync(settingsPath, settingsPath + BACKUP_SUFFIX);
      const w = writeFileAtomic(settingsPath, plan.text, { text: before });
      if (w === 'conflict') continue;
    } catch (e) {
      return { outcome: 'failed', settingsPath, detail: (e as Error).message };
    }

    const after = readTextIfExists(settingsPath);
    const verify = planUpdate(after, desired);
    if (verify.ok && !verify.changed) return { outcome: desired ? 'connected' : 'disconnected', settingsPath };
    // Changed again right after our write: loop and re-apply.
  }
  return { outcome: 'failed', settingsPath, detail: 'settings.json kept changing; gave up after retries' };
}

// ---------------------------------------------------------------- ~/.devjack/state.json

export interface DevjackState {
  v: 1;
  /** Config dirs DevJack connected to automatically (once per config dir; never silently again). */
  autoConnected: string[];
  /** Config dirs where the user chose Disconnect. */
  manualDisconnect: string[];
  /** Config dirs that may hold our entries (the uninstall script cleans these). */
  connected: string[];
}

const emptyState = (): DevjackState => ({ v: 1, autoConnected: [], manualDisconnect: [], connected: [] });
const key = (dir: string) => path.resolve(dir);

export function readState(home: string): DevjackState {
  try {
    const j = JSON.parse(readTextIfExists(stateFile(home)) ?? 'null') as Partial<DevjackState> | null;
    if (!j || j.v !== 1) return emptyState();
    const arr = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    return { v: 1, autoConnected: arr(j.autoConnected), manualDisconnect: arr(j.manualDisconnect), connected: arr(j.connected) };
  } catch {
    return emptyState();
  }
}

export function writeState(home: string, s: DevjackState): void {
  writeFileAtomic(stateFile(home), JSON.stringify(s, null, 2) + '\n');
}

export function updateState(home: string, fn: (s: DevjackState) => void): DevjackState {
  const s = readState(home);
  fn(s);
  const uniq = (a: string[]) => [...new Set(a.map(key))];
  s.autoConnected = uniq(s.autoConnected);
  s.manualDisconnect = uniq(s.manualDisconnect);
  s.connected = uniq(s.connected);
  writeState(home, s);
  return s;
}

export const has = (list: string[], dir: string) => list.map(key).includes(key(dir));

export type AutoDecision =
  | 'connect' // first time for this config dir
  | 'upgrade' // our entries are there but outdated (or v1): replace them
  | 'none' // already current
  | 'off' // setting devjack.connectToClaudeCode is false
  | 'userDisconnected'
  | 'removedAfterConnect'; // we connected once, the entries are gone now: show "Disconnected", never re-add silently

/** What to do on activation (pure). */
export function decideAutoConnect(state: DevjackState, configDir: string, analysis: Analysis, settingEnabled: boolean): AutoDecision {
  if (has(state.manualDisconnect, configDir)) return 'userDisconnected';
  const h = analysis.hooks;
  if (h.state === 'current') return 'none';
  if (h.ours > 0 || h.v1 > 0) return 'upgrade';
  if (!settingEnabled) return 'off';
  return has(state.autoConnected, configDir) ? 'removedAfterConnect' : 'connect';
}
