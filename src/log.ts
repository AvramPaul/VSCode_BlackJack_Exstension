import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Output channel "DevJack" (plan §5.10). Logs event types, sessions and routing decisions,
 * never prompt or tool content. `debug` lines appear only with `devjack.debugLog`.
 */
export class Log implements vscode.Disposable {
  readonly channel: vscode.LogOutputChannel;
  private debugOn: boolean;

  constructor() {
    this.channel = vscode.window.createOutputChannel('DevJack', { log: true });
    this.debugOn = this.readSetting();
  }

  private readSetting() {
    return vscode.workspace.getConfiguration('devjack').get<boolean>('debugLog', false) || !!process.env.DEVJACK_LOG_FILE;
  }

  refresh() {
    this.debugOn = this.readSetting();
  }

  /** Tests and CI: DEVJACK_LOG_FILE mirrors the channel (with debug lines) into a file. */
  private mirror(level: string, msg: string) {
    const f = process.env.DEVJACK_LOG_FILE;
    if (!f) return;
    try {
      fs.appendFileSync(f, `${new Date().toISOString()} ${level} ${msg}\n`);
    } catch {
      /* ignore */
    }
  }

  info(msg: string) {
    this.channel.info(msg);
    this.mirror('info', msg);
  }
  warn(msg: string) {
    this.channel.warn(msg);
    this.mirror('warn', msg);
  }
  error(msg: string) {
    this.channel.error(msg);
    this.mirror('error', msg);
  }
  debug(msg: string) {
    if (!this.debugOn) return;
    this.channel.info(`[debug] ${msg}`);
    this.mirror('debug', msg);
  }

  show() {
    this.channel.show(true);
  }

  dispose() {
    this.channel.dispose();
  }
}

/** First 8 characters of an id, for logs. */
export const short = (id: string | undefined) => (id ? id.slice(0, 8) : '-');
