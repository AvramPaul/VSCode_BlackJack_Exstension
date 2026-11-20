/**
 * `~/.devjack/heartbeat`: every window touches it every 30 s and when it gains focus (plan §5.4).
 * The hook command exits at once unless it was touched in the last 2 minutes.
 */
import * as fs from 'fs';
import * as path from 'path';

export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string, private readonly intervalMs = 30_000) {}

  start(): void {
    this.touch();
    this.timer = setInterval(() => this.touch(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  touch(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, String(Date.now()));
    } catch {
      /* best effort; the next tick retries */
    }
  }

  /** Age in ms, or undefined when the file is missing. */
  age(now = Date.now()): number | undefined {
    try {
      return now - fs.statSync(this.file).mtimeMs;
    } catch {
      return undefined;
    }
  }
}
