/**
 * Pure edits of Claude Code's settings.json text (plan §5.3). No file system here.
 *
 * Rules: never touch invalid JSON or a `hooks` value that isn't an object; keep every user hook;
 * find our entries by marker; minimal edits (jsonc-parser) that keep indentation, EOL, key order and BOM;
 * no change at all when everything is already current.
 */
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';
import { classifyEntry, jsonEqual, type DesiredHooks } from './hookCommand';

export type SettingsProblem = 'invalidJson' | 'notAnObject' | 'hooksNotObject' | 'hookEventNotArray' | 'verifyFailed';
export type Blocker = 'disableAllHooks' | 'allowManagedHooksOnly';
export type HookState = 'current' | 'outdated' | 'missing';

export interface HookStatus {
  state: HookState;
  /** Our v2 entries found (current or not). */
  ours: number;
  /** v1 entries found (`devjack-hook.cjs`). */
  v1: number;
}

export interface Analysis {
  problem?: SettingsProblem;
  problemDetail?: string;
  blockers: Blocker[];
  hooks: HookStatus;
}

export type PlanResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; text: string }
  | { ok: false; problem: SettingsProblem; detail?: string };

const BOM = '\uFEFF';

interface Parsed {
  body: string; // text without BOM ('{}' when the file is missing or blank)
  bom: boolean;
  root?: Node;
  problem?: SettingsProblem;
  detail?: string;
  hooksValue?: Record<string, unknown>;
}

function parse(text: string | undefined): Parsed {
  const bom = !!text && text.startsWith(BOM);
  let body = bom ? text!.slice(1) : text ?? '';
  if (!body.trim()) body = '{}';
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || !root) return { body, bom, problem: 'invalidJson', detail: errors.length ? `parse error at offset ${errors[0]!.offset}` : 'empty' };
  if (root.type !== 'object') return { body, bom, root, problem: 'notAnObject' };
  const hooksNode = findNodeAtLocation(root, ['hooks']);
  if (hooksNode && hooksNode.type !== 'object') return { body, bom, root, problem: 'hooksNotObject' };
  const hooksValue = hooksNode ? (getNodeValue(hooksNode) as Record<string, unknown>) : undefined;
  if (hooksValue) {
    for (const [event, groups] of Object.entries(hooksValue)) {
      if (!Array.isArray(groups)) return { body, bom, root, problem: 'hookEventNotArray', detail: event };
    }
  }
  return { body, bom, root, hooksValue };
}

/** Where our entries are: event → group index → entry indexes. */
interface OursMap {
  v2: { event: string; group: number; entry: number; value: unknown }[];
  v1: { event: string; group: number; entry: number }[];
}

function findOurs(hooksValue: Record<string, unknown> | undefined): OursMap {
  const out: OursMap = { v2: [], v1: [] };
  if (!hooksValue) return out;
  for (const [event, groups] of Object.entries(hooksValue)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      const entries = group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(entries)) return;
      entries.forEach((entry, ei) => {
        const kind = classifyEntry(entry);
        if (kind === 'v2') out.v2.push({ event, group: gi, entry: ei, value: entry });
        else if (kind === 'v1') out.v1.push({ event, group: gi, entry: ei });
      });
    });
  }
  return out;
}

function hookState(ours: OursMap, desired: DesiredHooks): HookState {
  if (ours.v2.length === 0) return 'missing';
  if (ours.v1.length) return 'outdated';
  const events = Object.keys(desired);
  if (ours.v2.length !== events.length) return 'outdated';
  for (const event of events) {
    const mine = ours.v2.filter((o) => o.event === event);
    if (mine.length !== 1 || !jsonEqual(mine[0]!.value, desired[event])) return 'outdated';
  }
  return 'current';
}

function blockersOf(root: Node | undefined): Blocker[] {
  if (!root) return [];
  const out: Blocker[] = [];
  for (const key of ['disableAllHooks', 'allowManagedHooksOnly'] as const) {
    const n = findNodeAtLocation(root, [key]);
    if (n && getNodeValue(n) === true) out.push(key);
  }
  return out;
}

export function analyze(text: string | undefined, desired: DesiredHooks): Analysis {
  const p = parse(text);
  if (p.problem) return { problem: p.problem, problemDetail: p.detail, blockers: blockersOf(p.root), hooks: { state: 'missing', ours: 0, v1: 0 } };
  const ours = findOurs(p.hooksValue);
  return { blockers: blockersOf(p.root), hooks: { state: hookState(ours, desired), ours: ours.v2.length, v1: ours.v1.length } };
}

/** Our installed v2 entries, by event (for the self-test). */
export function ourEntries(text: string | undefined): { event: string; entry: unknown }[] {
  const p = parse(text);
  if (p.problem) return [];
  return findOurs(p.hooksValue).v2.map((o) => ({ event: o.event, entry: o.value }));
}

export function detectFormatting(body: string): FormattingOptions {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(body);
  if (m && m[1]!.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  const size = m ? m[1]!.length : 2;
  return { insertSpaces: true, tabSize: size > 0 && size <= 8 ? size : 2, eol };
}

/**
 * Plan the new text. `desired` = the entries to have (connect); `null` = remove ours (disconnect / uninstall).
 * Removes v1 entries and outdated v2 entries, then appends the current ones, one group per event.
 */
export function planUpdate(text: string | undefined, desired: DesiredHooks | null): PlanResult {
  const p = parse(text);
  if (p.problem) return { ok: false, problem: p.problem, detail: p.detail };
  const ours = findOurs(p.hooksValue);
  if (desired && hookState(ours, desired) === 'current') return { ok: true, changed: false };
  if (!desired && ours.v2.length + ours.v1.length === 0) return { ok: true, changed: false };

  const formattingOptions = detectFormatting(p.body);
  const edit = (t: string, path: (string | number)[], value: unknown, isArrayInsertion = false) =>
    applyEdits(t, modify(t, path, value, { formattingOptions, isArrayInsertion }));

  let t = p.body;
  const hooks = p.hooksValue ?? {};

  // 1. Remove ours. Decide per group/event from the original value, then edit from the highest index down.
  const all = [...ours.v2, ...ours.v1];
  const removedEvents = new Set<string>();
  const replacedEvents = new Set<string>();
  for (const event of [...new Set(all.map((o) => o.event))]) {
    const groups = hooks[event] as unknown[];
    const groupsToDrop = new Set<number>();
    const entriesToDrop = new Map<number, number[]>();
    for (const o of all.filter((x) => x.event === event)) {
      const list = entriesToDrop.get(o.group) ?? [];
      list.push(o.entry);
      entriesToDrop.set(o.group, list);
    }
    for (const [gi, eis] of entriesToDrop) {
      const entries = (groups[gi] as { hooks: unknown[] }).hooks;
      if (eis.length === entries.length) groupsToDrop.add(gi);
    }
    if (groupsToDrop.size === groups.length) {
      if (desired?.[event]) {
        // Only our groups here: replace the array in place, so the key keeps its position.
        t = edit(t, ['hooks', event], [{ hooks: [desired[event]] }]);
        replacedEvents.add(event);
      } else {
        t = edit(t, ['hooks', event], undefined);
        removedEvents.add(event);
      }
      continue;
    }
    for (const gi of [...entriesToDrop.keys()].sort((a, b) => b - a)) {
      if (groupsToDrop.has(gi)) t = edit(t, ['hooks', event, gi], undefined);
      else for (const ei of [...entriesToDrop.get(gi)!].sort((a, b) => b - a)) t = edit(t, ['hooks', event, gi, 'hooks', ei], undefined);
    }
  }

  // 2. Add the current entries.
  if (desired) {
    if (!p.hooksValue) {
      const value: Record<string, unknown> = {};
      for (const [event, entry] of Object.entries(desired)) value[event] = [{ hooks: [entry] }];
      t = edit(t, ['hooks'], value);
    } else {
      for (const [event, entry] of Object.entries(desired)) {
        if (replacedEvents.has(event)) continue;
        const exists = event in hooks && !removedEvents.has(event);
        t = exists ? edit(t, ['hooks', event, -1], { hooks: [entry] }, true) : edit(t, ['hooks', event], [{ hooks: [entry] }]);
      }
    }
  } else if (p.hooksValue && Object.keys(p.hooksValue).length > 0 && Object.keys(p.hooksValue).every((e) => removedEvents.has(e))) {
    // The hooks object held only our entries: remove the now-empty key.
    t = edit(t, ['hooks'], undefined);
  }

  // Keep the original's trailing newline (or add one to a new file).
  const eol = formattingOptions.eol ?? '\n';
  const hadText = !!text && !!text.replace(BOM, '').trim();
  const wantsFinalEol = hadText ? /\r?\n$/.test(text!) : true;
  t = t.replace(/\s+$/, '') + (wantsFinalEol ? eol : '');
  const out = (p.bom ? BOM : '') + t;

  // 3. Verify before handing it out.
  const check = parse(out);
  if (check.problem) return { ok: false, problem: 'verifyFailed', detail: check.problem };
  const after = findOurs(check.hooksValue);
  if (desired ? hookState(after, desired) !== 'current' : after.v2.length + after.v1.length !== 0) return { ok: false, problem: 'verifyFailed', detail: 'entries' };
  return { ok: true, changed: true, text: out };
}
