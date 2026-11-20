/**
 * Simulate Claude Run (plan §5.9): writes fake hook events into the inbox, so a demo exercises the
 * real pipeline (inbox → router → tracker → table), not a shortcut.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomHex } from '../util/fsx';
import type { Signal } from './hookCommand';

export const SIM_PREFIX = 'devjack-sim-';

export interface SimStep {
  afterMs: number;
  signal: Signal;
  prompt: 1 | 2;
  event: string;
  notification_type?: string;
}

/** start → waiting → start → done, then the session ends. */
export const SIM_STEPS: readonly SimStep[] = [
  { afterMs: 0, signal: 'session', prompt: 1, event: 'SessionStart' },
  { afterMs: 300, signal: 'start', prompt: 1, event: 'UserPromptSubmit' },
  { afterMs: 6000, signal: 'waiting', prompt: 1, event: 'PermissionRequest' },
  { afterMs: 5000, signal: 'start', prompt: 2, event: 'UserPromptSubmit' },
  { afterMs: 6000, signal: 'done', prompt: 2, event: 'Stop' },
  { afterMs: 1500, signal: 'end', prompt: 2, event: 'SessionEnd' },
];

/** Write one envelope exactly like the hook does: .tmp, then rename. */
export function writeInboxEvent(inbox: string, signal: Signal, window: string, payload: Record<string, unknown>): string {
  fs.mkdirSync(inbox, { recursive: true });
  const base = path.join(inbox, `${Date.now()}-${process.pid}${randomHex(2)}-${signal}`);
  fs.writeFileSync(`${base}.tmp`, JSON.stringify({ v: 2, signal, window, payload }), 'utf8');
  fs.renameSync(`${base}.tmp`, `${base}.json`);
  return `${base}.json`;
}

export async function simulateRun(inbox: string, window: string, cwd: string, opts: { speed?: number; isCancelled?: () => boolean } = {}): Promise<void> {
  const session = SIM_PREFIX + randomHex(8);
  const prompts = { 1: `${session}-p1`, 2: `${session}-p2` };
  for (const step of SIM_STEPS) {
    await new Promise((r) => setTimeout(r, step.afterMs / (opts.speed ?? 1)));
    if (opts.isCancelled?.()) return;
    writeInboxEvent(inbox, step.signal, window, {
      session_id: session,
      prompt_id: step.signal === 'session' ? undefined : prompts[step.prompt],
      cwd,
      hook_event_name: step.event,
      ...(step.notification_type ? { notification_type: step.notification_type } : {}),
    });
  }
}
