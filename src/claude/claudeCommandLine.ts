/** Does a shell command line start Claude Code's CLI? (`claude`, `claude -c`, `& "C:\…\claude.exe" …`, `./claude`) */
const CLAUDE_COMMAND = /^\s*(?:&\s*)?["']?(?:[^"'\s]*[\\/])?claude(?:\.exe|\.cmd)?["']?(?:\s|$)/i;

export function isClaudeCommandLine(line: string): boolean {
  return CLAUDE_COMMAND.test(line);
}
