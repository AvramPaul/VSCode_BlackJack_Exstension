/**
 * Micro-benchmark of DevJack's idle work (bundled and run by scripts/perf.mjs):
 * one inbox scan and one registry scan per second, one heartbeat touch every 30 s.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Heartbeat } from '../src/claude/heartbeat';
import { Inbox } from '../src/claude/inbox';
import { RegistryWatcher } from '../src/claude/registry';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devjack-bench-'));
const inboxDir = path.join(root, 'inbox');
const sessions = path.join(root, 'sessions');
fs.mkdirSync(inboxDir, { recursive: true });
fs.mkdirSync(sessions, { recursive: true });
for (const pid of [1111, 2222, 3333]) {
  fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: root, status: 'idle', statusUpdatedAt: Date.now() }));
  fs.writeFileSync(path.join(sessions, `${pid}.abcdef.key`), '{"peerToken":"x"}');
}

function cpuPerCall(label: string, n: number, fn: () => void): number {
  for (let i = 0; i < 50; i++) fn(); // warm up
  const c0 = process.cpuUsage();
  for (let i = 0; i < n; i++) fn();
  const c = process.cpuUsage(c0);
  const us = (c.user + c.system) / n;
  console.log(`${label.padEnd(34)} ${us.toFixed(1).padStart(7)} µs CPU per call`);
  return us;
}

const inbox = new Inbox(inboxDir, () => undefined);
const registry = new RegistryWatcher([sessions], () => undefined);
const hb = new Heartbeat(path.join(root, 'heartbeat'));
registry.scan();

const a = cpuPerCall('inbox scan (empty inbox)', 5000, () => inbox.scan());
const b = cpuPerCall('registry scan (3 sessions, unchanged)', 5000, () => registry.scan());
const c = cpuPerCall('heartbeat touch', 2000, () => hb.touch());
const perSecond = a + b + c / 30;
console.log(`\nidle work: ${perSecond.toFixed(0)} µs CPU per second = ${(perSecond / 10_000).toFixed(4)} % of one core`);
fs.rmSync(root, { recursive: true, force: true });
