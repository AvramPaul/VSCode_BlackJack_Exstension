import * as vscode from 'vscode';
import { DevJack, type DevJackApi } from './devjack';
import { Log } from './log';

export function activate(context: vscode.ExtensionContext): DevJackApi {
  const t0 = performance.now();
  const log = new Log();
  const dj = new DevJack(context, log);
  context.subscriptions.push(
    log,
    dj,
    vscode.commands.registerCommand('devjack.openTable', () => dj.openTable()),
    vscode.commands.registerCommand('devjack.simulate', () => dj.simulate()),
    vscode.commands.registerCommand('devjack.checkConnection', () => dj.checkConnection()),
    vscode.commands.registerCommand('devjack.connect', () => dj.connectCommand()),
    vscode.commands.registerCommand('devjack.disconnect', () => dj.disconnectCommand()),
    vscode.commands.registerCommand('devjack.pause', () => dj.pause()),
    vscode.commands.registerCommand('devjack.resume', () => dj.resume()),
    vscode.commands.registerCommand('devjack.menu', () => dj.menu()),
    vscode.commands.registerCommand('devjack.goToClaude', () => dj.goToClaude()),
    vscode.commands.registerCommand('devjack.showLog', () => log.show()),
  );
  dj.start();
  // Plan §11 Phase 5: under 50 ms of work at activation (the connect check after it runs async).
  const ms = performance.now() - t0;
  log.info(`activated in ${ms.toFixed(1)} ms`);
  return { ...dj.api(), activationMs: ms };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
