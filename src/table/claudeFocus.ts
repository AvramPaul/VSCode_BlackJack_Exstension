/**
 * Moving focus back to Claude (plan §5.8): the terminal running `claude`, or the Claude panel.
 * - Terminals: shell integration tells which terminal runs a `claude` command (VS Code 1.93+, feature-detected).
 * - Panel: `claude-vscode.focus` ("Claude Code: Focus input"; spike Q9). It would insert the active editor's
 *   selection as an @-mention, but focus comes from the table, so there is no active text editor.
 */
import * as vscode from 'vscode';
import { isClaudeCommandLine } from '../claude/claudeCommandLine';

export class ClaudeFocus implements vscode.Disposable {
  /** Terminals currently running a claude command, most recent last. */
  private running: vscode.Terminal[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly entrypointOf: (sessionId: string) => string | undefined, private readonly log: (m: string) => void) {
    const w = vscode.window as Partial<typeof vscode.window>;
    if (w.onDidStartTerminalShellExecution && w.onDidEndTerminalShellExecution) {
      this.disposables.push(
        w.onDidStartTerminalShellExecution((e) => {
          if (isClaudeCommandLine(e.execution.commandLine.value)) {
            this.running = [...this.running.filter((t) => t !== e.terminal), e.terminal];
          }
        }),
        w.onDidEndTerminalShellExecution((e) => {
          if (isClaudeCommandLine(e.execution.commandLine.value)) this.running = this.running.filter((t) => t !== e.terminal);
        }),
      );
    }
    this.disposables.push(vscode.window.onDidCloseTerminal((t) => (this.running = this.running.filter((x) => x !== t))));
  }

  private claudeTerminal(): vscode.Terminal | undefined {
    const live = this.running.filter((t) => vscode.window.terminals.includes(t));
    return live[live.length - 1] ?? vscode.window.terminals.find((t) => /claude/i.test(t.name));
  }

  async focus(sessionId?: string): Promise<void> {
    const entry = sessionId ? this.entrypointOf(sessionId) : undefined;
    const term = this.claudeTerminal();
    const hasPanel = !!vscode.extensions.getExtension('anthropic.claude-code');
    // The registry says which kind of session it is; without it, prefer a terminal known to run claude.
    const wantPanel = entry === 'claude-vscode' || (entry === undefined && !term);
    if (wantPanel && hasPanel) {
      for (const cmd of ['claude-vscode.focus', 'claude-vscode.sidebar.open']) {
        try {
          await vscode.commands.executeCommand(cmd);
          this.log(`focus: ${cmd}`);
          return;
        } catch {
          /* try the next one */
        }
      }
    }
    // A terminal session whose start DevJack didn't see (claude started before DevJack was installed):
    // the active terminal is the best guess.
    const target = term ?? (entry === 'cli' ? vscode.window.activeTerminal : undefined);
    if (target) {
      target.show(false);
      this.log(`focus: terminal "${target.name}"${term ? '' : ' (active terminal)'}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
