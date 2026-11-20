/**
 * Check Claude Connection (plan §5.10): a Markdown report, plus a self-test that runs the installed
 * hook command with a fake payload and checks that a file arrives in the inbox.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Inspection } from './claude/connection';
import type { HookEntry } from './claude/hookCommand';
import type { RegistryEntry } from './claude/registry';
import type { VersionInfo } from './claude/versions';

export const SELFTEST_PREFIX = 'devjack-selftest-';

export interface ConnectionLine {
  configDir: string;
  role: 'main' | 'panel';
  status: string;
  inspection: Inspection;
}

export interface DiagnosticsInput {
  platform: NodeJS.Platform;
  flavor: string;
  connections: ConnectionLine[];
  versions: VersionInfo[];
  minVersion: string;
  registryDirs: string[];
  registryRecognized: boolean;
  registrySessions: RegistryEntry[];
  mySessionIds: Set<string>;
  heartbeatAgeMs?: number;
  devjackHome: string;
  windowId: string;
  folders: string[];
  lastEvent?: { signal: string; session: string; at: number; rule: string };
  gitBash?: string;
  selfTest?: SelfTestResult;
}

export interface SelfTestResult {
  ok: boolean;
  ms?: number;
  detail: string;
}

const fmtAge = (ms: number | undefined) => (ms === undefined ? 'missing' : ms < 1000 ? 'just now' : `${Math.round(ms / 1000)} s ago`);
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

export function renderReport(d: DiagnosticsInput, now = Date.now()): string {
  const L: string[] = ['# DevJack: Claude connection', ''];
  L.push('## Hooks', '');
  for (const c of d.connections) {
    const a = c.inspection.analysis;
    L.push(`- **${c.role === 'main' ? 'Settings' : 'Panel settings (claudeCode.environmentVariables)'}:** ${code(c.inspection.settingsPath)}${c.inspection.settingsExists ? '' : ' (missing)'}`);
    L.push(`  - Status: **${c.status}**`);
    L.push(`  - DevJack entries: ${a.hooks.state}${a.hooks.v1 ? `, v1 entries found: ${a.hooks.v1}` : ''}`);
    if (a.problem) L.push(`  - ⚠️ File problem: ${a.problem}${a.problemDetail ? ` (${a.problemDetail})` : ''}. DevJack changes nothing until it is fixed.`);
    const blockers = [...a.blockers, ...c.inspection.managedBlockers.map((b) => `${b} (managed settings)`)];
    if (blockers.length) L.push(`  - ⚠️ Hooks are switched off by: ${blockers.join(', ')}. DevJack doesn't override this.`);
  }
  L.push(`- Hook form: ${d.flavor === 'powershell-exec' ? 'powershell.exe, exec form (no shell needed)' : 'POSIX sh'}`);
  if (d.platform === 'win32') L.push(`- Git Bash: ${d.gitBash ?? 'not found'} (informational: exec form doesn't use it)`);
  L.push('');
  L.push('## Claude Code', '');
  if (!d.versions.length) L.push('- Versions: none found');
  for (const v of d.versions) L.push(`- ${v.source}: ${v.version}`);
  if (d.flavor === 'powershell-exec') L.push(`- Minimum for DevJack on Windows: ${d.minVersion}`);
  L.push(`- Session registry: ${d.registryDirs.map(code).join(', ')} — ${d.registryRecognized ? 'readable' : 'not available or format not recognized (transcript fallback)'}`);
  const mine = d.registrySessions.filter((s) => d.mySessionIds.has(s.sessionId));
  L.push(`- Live sessions: ${d.registrySessions.length} (${mine.length} tracked by this window)`);
  for (const s of mine) L.push(`  - ${s.sessionId.slice(0, 8)} · ${s.entrypoint ?? '?'} · ${s.status ?? '?'}${s.waitingFor ? ` (${s.waitingFor})` : ''}`);
  L.push('');
  L.push('## This window', '');
  L.push(`- DevJack folder: ${code(d.devjackHome)}`);
  L.push(`- Heartbeat: ${fmtAge(d.heartbeatAgeMs)}`);
  L.push(`- Window id: ${code(d.windowId)}`);
  L.push(`- Folders: ${d.folders.length ? d.folders.map(code).join(', ') : '(none: sessions are matched by window id only)'}`);
  L.push(`- Last event: ${d.lastEvent ? `${d.lastEvent.signal} · session ${d.lastEvent.session} · ${fmtAge(now - d.lastEvent.at)} · routed by ${d.lastEvent.rule}` : 'none yet'}`);
  L.push('');
  L.push('## Self-test', '');
  L.push(d.selfTest ? `- ${d.selfTest.ok ? '✅' : '❌'} ${d.selfTest.detail}` : '- not run');
  L.push('');
  return L.join('\n');
}

/** Run a hook entry the way Claude Code does (exec form: spawn with args; shell form: sh -c). */
export function runEntry(entry: HookEntry, stdin: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = entry.args ? spawn(entry.command, entry.args, { env, windowsHide: true }) : spawn('/bin/sh', ['-c', entry.command], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr: String(e) });
    });
    child.on('close', (c) => {
      clearTimeout(t);
      resolve({ code: c, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

/** Where Claude Code looks for Git Bash on Windows (informational). */
export function findGitBash(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH, env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')];
  return candidates.find((c): c is string => !!c && fs.existsSync(c));
}
