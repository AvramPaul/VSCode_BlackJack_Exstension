/**
 * Builds DevJack's hook entries (plan §5.2) and recognizes them in a settings file.
 *
 * - Windows: exec form, `powershell.exe` + `args`, with a .NET-only script passed as -EncodedCommand.
 * - macOS / Linux: shell form, one POSIX sh string.
 *
 * The hook only passes data along: it appends {v, signal, window, payload} to the inbox and exits 0.
 */

export const MARKER = 'devjack-hook-v2';
/** v1 hook commands ran `node …/devjack-hook.cjs`. */
export const V1_MARKER = 'devjack-hook.cjs';
/** Exec form (`args`) needs this Claude Code version (plan §5.2, rule 8). */
export const MIN_CLAUDE_VERSION_EXEC_FORM = '2.1.139';
export const HOOK_TIMEOUT_SECONDS = 5;

export type Signal = 'session' | 'start' | 'waiting' | 'notify' | 'done' | 'failed' | 'end';
export const SIGNALS: readonly Signal[] = ['session', 'start', 'waiting', 'notify', 'done', 'failed', 'end'];

/** Plan §5.1: which Claude Code hook event produces which signal. */
export const HOOK_EVENTS: readonly { event: string; signal: Signal }[] = [
  { event: 'SessionStart', signal: 'session' },
  { event: 'UserPromptSubmit', signal: 'start' },
  { event: 'PermissionRequest', signal: 'waiting' },
  { event: 'Notification', signal: 'notify' },
  { event: 'Stop', signal: 'done' },
  { event: 'StopFailure', signal: 'failed' },
  { event: 'SessionEnd', signal: 'end' },
];

export interface HookEntry {
  type: 'command';
  command: string;
  args?: string[];
  timeout: number;
}

export type Flavor = 'powershell-exec' | 'sh';
export const flavorFor = (platform: NodeJS.Platform): Flavor => (platform === 'win32' ? 'powershell-exec' : 'sh');

// ---------------------------------------------------------------- quoting

/** PowerShell single-quoted string literal. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** POSIX sh single-quoted string literal. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- scripts

/** The PowerShell script (verified in the Phase 1 spike). .NET calls only: no cmdlets, so no module auto-load. */
export function psScript(home: string, signal: Signal): string {
  return [
    `# ${MARKER}`,
    'try {',
    `  $d = ${psQuote(home)}; $hb = [IO.Path]::Combine($d, 'heartbeat')`,
    '  if (-not [IO.File]::Exists($hb) -or ([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($hb)).TotalSeconds -gt 120) { exit 0 }',
    '  $ms = [IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($ms)',
    "  $in = [Text.Encoding]::UTF8.GetString($ms.ToArray()); if (-not $in.Trim()) { $in = 'null' }",
    "  $w = [string][Environment]::GetEnvironmentVariable('DEVJACK_WINDOW_ID') -replace '[^a-f0-9]', ''",
    "  $dir = [IO.Path]::Combine($d, 'inbox'); [void][IO.Directory]::CreateDirectory($dir)",
    `  $f = [IO.Path]::Combine($dir, ('{0}-{1}-${signal}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $PID))`,
    `  [IO.File]::WriteAllText("$f.tmp", '{"v":2,"signal":"${signal}","window":"' + $w + '","payload":' + $in + '}', [Text.UTF8Encoding]::new($false))`,
    '  [IO.File]::Move("$f.tmp", "$f.json")',
    '} catch {}',
    'exit 0',
  ].join('\n');
}

/** The POSIX sh command string (verified under dash, bash and Git Bash sh). */
export function shCommand(home: string, signal: Signal): string {
  return (
    `d=${shQuote(home)}; [ -n "$(find "$d/heartbeat" -mmin -2 2>/dev/null)" ] || exit 0; ` +
    `mkdir -p "$d/inbox" && f="$d/inbox/$(date +%s)-$$-${signal}" && ` +
    `{ printf '{"v":2,"signal":"${signal}","window":"%s","payload":' "$(printf %s "$DEVJACK_WINDOW_ID" | tr -cd 'a-f0-9')"; cat; printf '}'; } > "$f.tmp" && ` +
    `mv "$f.tmp" "$f.json"; exit 0 # ${MARKER}`
  );
}

export const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

export function decodePowerShell(b64: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;
  try {
    return Buffer.from(b64, 'base64').toString('utf16le');
  } catch {
    return undefined;
  }
}

export const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'] as const;

export function buildEntry(flavor: Flavor, home: string, signal: Signal): HookEntry {
  if (flavor === 'powershell-exec') {
    return { type: 'command', command: 'powershell.exe', args: [...POWERSHELL_FLAGS, encodePowerShell(psScript(home, signal))], timeout: HOOK_TIMEOUT_SECONDS };
  }
  return { type: 'command', command: shCommand(home, signal), timeout: HOOK_TIMEOUT_SECONDS };
}

/** The full set DevJack wants: one entry per hook event. */
export type DesiredHooks = Record<string, HookEntry>;
export function desiredHooks(flavor: Flavor, home: string): DesiredHooks {
  const out: DesiredHooks = {};
  for (const { event, signal } of HOOK_EVENTS) out[event] = buildEntry(flavor, home, signal);
  return out;
}

// ---------------------------------------------------------------- recognition

export type Ownership = 'v2' | 'v1';

/** Is this hook entry (any JSON value from a settings file) one of ours, and which generation? */
export function classifyEntry(entry: unknown): Ownership | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== 'string') return undefined;
  if (command.includes(V1_MARKER)) return 'v1';
  if (command.includes(MARKER)) return 'v2'; // sh form, or the first draft's Windows shell-form string
  if (Array.isArray(args)) {
    if (args.some((a) => typeof a === 'string' && a.includes(V1_MARKER))) return 'v1';
    const i = args.findIndex((a) => typeof a === 'string' && a.toLowerCase() === '-encodedcommand');
    const b64 = i >= 0 ? args[i + 1] : undefined;
    if (typeof b64 === 'string' && decodePowerShell(b64)?.includes(MARKER)) return 'v2';
  }
  return undefined;
}

/** Deep equality for plain JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
}
