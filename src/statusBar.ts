/**
 * Status bar item (plan §5.8, row 9 of §2.2): the quiet place for state. Toasts only when Claude needs you.
 * No timers: it changes only when the state changes.
 */
import * as vscode from 'vscode';
import type { WindowStateInfo } from './claude/sessionTracker';

export type ConnectionSummary = 'connected' | 'connecting' | 'problem' | 'off';

export interface StatusView {
  window: WindowStateInfo;
  paused: false | 'hour' | 'restart';
  connection: ConnectionSummary;
  connectionDetail: string;
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('devjack.status', vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.item.name = 'DevJack';
    this.item.command = 'devjack.menu';
    this.item.text = '♠ DevJack';
    this.item.show();
  }

  update(v: StatusView): void {
    const { window: w } = v;
    let text = '♠ DevJack';
    let bg: vscode.ThemeColor | undefined;
    const tip: string[] = [];
    if (v.connection === 'problem') {
      text = '$(warning) DevJack';
      bg = new vscode.ThemeColor('statusBarItem.warningBackground');
      tip.push(`Not connected to Claude Code: ${v.connectionDetail}`, 'Click for options.');
    } else if (w.state === 'waiting') {
      text = '$(bell) Claude needs you';
      bg = new vscode.ThemeColor('statusBarItem.warningBackground');
      tip.push('Claude Code is waiting for a decision or an answer.');
    } else if (w.state === 'working') {
      text = `$(sync~spin) Claude working${w.working + w.waiting > 1 ? ` (${w.working + w.waiting})` : ''}`;
      tip.push('Claude Code is working on a prompt.');
    } else tip.push(v.connection === 'connected' ? 'Connected to Claude Code. The table opens while Claude works.' : v.connectionDetail);
    if (v.paused && v.connection !== 'problem') {
      text += ' $(debug-pause)';
      tip.push(v.paused === 'hour' ? 'Auto-open is paused for an hour.' : 'Auto-open is paused until VS Code restarts.');
    }
    this.item.text = text;
    this.item.backgroundColor = bg;
    this.item.tooltip = tip.join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
