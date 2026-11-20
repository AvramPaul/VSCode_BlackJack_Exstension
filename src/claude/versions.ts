/** Claude Code versions DevJack can see (plan §5.2, rule 8). No vscode API here. */
import { execFile } from 'child_process';

export type VersionSource = 'panel' | 'cli' | 'registry';
export interface VersionInfo {
  source: VersionSource;
  version: string;
}

/** Extract `x.y.z` from strings such as "2.1.328 (Claude Code)". */
export function parseVersion(s: string | undefined): string | undefined {
  const m = s ? /(\d+)\.(\d+)\.(\d+)/.exec(s) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const belowMinimum = (infos: readonly VersionInfo[], min: string) => infos.filter((v) => compareVersions(v.version, min) < 0);

/** `claude --version` from PATH, if any (5 s budget, never throws). */
export function cliVersion(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('claude', ['--version'], { timeout: 5000, windowsHide: true, shell: platform === 'win32' }, (err, stdout) => {
        resolve(err ? undefined : parseVersion(String(stdout)));
      });
    } catch {
      resolve(undefined);
    }
  });
}
