/**
 * DevJack's runtime for one VS Code window (plan §4):
 * inbox → router → session tracker → table controller, fed also by the session registry and transcripts.
 */
import * as os from 'os';
import * as vscode from 'vscode';
import { applyToSettings, decideAutoConnect, has, inspect, readState, updateState, type ApplyResult } from './claude/connection';
import { Heartbeat } from './claude/heartbeat';
import { desiredHooks, flavorFor, MIN_CLAUDE_VERSION_EXEC_FORM, type DesiredHooks, type Flavor, type HookEntry } from './claude/hookCommand';
import { Inbox, type InboxEvent } from './claude/inbox';
import { claudeConfigDir, devjackHome, heartbeatFile, inboxDir, panelConfigDirFromSetting, sessionsDir, settingsFile } from './claude/paths';
import { RegistryWatcher, type RegistryEvent } from './claude/registry';
import { Router } from './claude/router';
import { SessionTracker, type TrackerInput, type WindowStateInfo } from './claude/sessionTracker';
import { simulateRun } from './claude/simulate';
import { ourEntries } from './claude/settingsEditor';
import { TranscriptWatcher } from './claude/transcript';
import { belowMinimum, cliVersion, parseVersion, type VersionInfo } from './claude/versions';
import { findGitBash, renderReport, runEntry, SELFTEST_PREFIX, type ConnectionLine, type SelfTestResult } from './diagnostics';
import { Log, short } from './log';
import { StatusBar, type ConnectionSummary } from './statusBar';
import { ClaudeFocus } from './table/claudeFocus';
import { TablePanel } from './table/tablePanel';
import { TableController, type CloseBehavior, type ControllerSettings } from './table/tableController';
import { randomHex, readTextIfExists } from './util/fsx';
import * as path from 'path';

const LIVE_MS = 10_000;
const TICK_MS = 60_000;
const TOAST_THROTTLE_MS = 15_000;

type ConnStatus = { status: string; result?: ApplyResult };

export interface DevJackApi {
  windowId: string;
  devjackHome: string;
  windowState(): WindowStateInfo;
  isTableOpen(): boolean;
  isPaused(): boolean;
  setPaused(until: number | 'restart' | undefined): void;
  connectionStatus(): Record<string, string>;
}

export class DevJack implements vscode.Disposable {
  readonly windowId: string;
  readonly home = devjackHome();
  readonly flavor: Flavor = flavorFor(process.platform);
  readonly desired: DesiredHooks = desiredHooks(this.flavor, this.home);
  private readonly tracker = new SessionTracker();
  private readonly router: Router;
  private readonly inbox: Inbox;
  private registry: RegistryWatcher;
  private readonly transcript: TranscriptWatcher;
  private readonly heartbeat = new Heartbeat(heartbeatFile(this.home));
  readonly table: TableController;
  private tickTimer: NodeJS.Timeout | undefined;
  private readonly conn = new Map<string, ConnStatus>();
  private lastEvent: { signal: string; session: string; at: number; rule: string } | undefined;
  private readonly selfTests = new Map<string, (ms: number) => void>();
  private readonly watched = new Set<string>();
  private cliVersionPromise: Promise<string | undefined> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar = new StatusBar();
  private readonly focus: ClaudeFocus;
  private pausedUntil: number | 'restart' | undefined;
  private waitingSession: string | undefined;
  private endedSession: string | undefined;
  private lastToastAt = 0;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: Log) {
    this.windowId = ctx.workspaceState.get<string>('devjack.windowId') ?? randomHex(8);
    void ctx.workspaceState.update('devjack.windowId', this.windowId);
    // Terminals (also ones restored after a reload) and the panel's CLI (it copies process.env when a tab opens).
    ctx.environmentVariableCollection.description = 'Lets DevJack recognize Claude Code sessions started in this window.';
    ctx.environmentVariableCollection.replace('DEVJACK_WINDOW_ID', this.windowId);
    process.env.DEVJACK_WINDOW_ID = this.windowId;

    this.router = new Router(this.windowId, () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    this.inbox = new Inbox(inboxDir(this.home), (evs) => this.onInbox(evs), { log: (m) => this.log.debug(m) });
    this.registry = this.makeRegistry();
    this.transcript = new TranscriptWatcher((e) => this.apply({ kind: 'transcript', sessionId: e.sessionId, what: e.what, at: e.at }, true));
    this.focus = new ClaudeFocus((sid) => this.registry.bySession(sid)?.entrypoint, (m) => this.log.debug(m));
    this.table = new TableController({
      createPanel: (mode, status) => new TablePanel(mode, status, { sound: this.cfg().get<boolean>('sound', true) }),
      settings: () => this.controllerSettings(),
      paused: () => this.isPaused(),
      focusClaude: (reason) => void this.focus.focus(reason === 'close' ? this.endedSession : this.waitingSession ?? this.endedSession),
      needsYou: () => void this.needsYouToast(),
      log: (m) => this.log.info(m),
    });
  }

  private cfg() {
    return vscode.workspace.getConfiguration('devjack');
  }

  private controllerSettings(): ControllerSettings {
    const c = this.cfg();
    const delay = Number(c.get<number>('openDelaySeconds', 2.5));
    const close = c.get<string>('closeBehavior', 'afterHand');
    return {
      autoOpen: c.get<boolean>('autoOpen', true),
      openDelayMs: Number.isFinite(delay) ? Math.min(60, Math.max(0, delay)) * 1000 : 2500,
      closeBehavior: (['afterHand', 'immediately', 'keepOpen'].includes(close) ? close : 'afterHand') as CloseBehavior,
      alertWhenNeedsYou: c.get<boolean>('alertWhenClaudeNeedsYou', true),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const t0 = Date.now();
    this.heartbeat.start();
    this.registry.start();
    this.inbox.start(); // handles files that arrived while the window was loading
    this.tickTimer = setInterval(() => this.apply({ kind: 'tick', at: Date.now() }, true), TICK_MS);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) return;
        this.heartbeat.touch(); // e.g. a laptop waking up just before the user types a prompt
        if ([...this.conn.values()].some((c) => c.status === 'claudeMissing')) void this.autoConnect('focus');
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.router.resetNegative()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devjack.debugLog')) this.log.refresh();
        if (e.affectsConfiguration('claudeCode.environmentVariables')) this.restartRegistry();
      }),
    );
    this.refreshStatus();
    this.log.info(`DevJack started: window ${this.windowId}, home ${this.home}, hooks ${this.flavor}, ${Date.now() - t0} ms`);
    void this.autoConnect('activation');
  }

  dispose(): void {
    this.heartbeat.stop();
    this.inbox.stop();
    this.registry.stop();
    this.transcript.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.table.dispose();
    this.statusBar.dispose();
    this.focus.dispose();
    for (const d of this.disposables) d.dispose();
  }

  api(): DevJackApi {
    return {
      windowId: this.windowId,
      devjackHome: this.home,
      windowState: () => this.tracker.windowState(),
      isTableOpen: () => this.table.isOpen,
      isPaused: () => this.isPaused(),
      setPaused: (until) => this.setPaused(until),
      connectionStatus: () => Object.fromEntries([...this.conn].map(([k, v]) => [k, v.status])),
    };
  }

  // ---------------------------------------------------------------- config dirs and registry

  /** The terminal's config dir, plus the panel's if claudeCode.environmentVariables sets another one. */
  configDirs(): { dir: string; role: 'main' | 'panel' }[] {
    const main = claudeConfigDir();
    const panel = panelConfigDirFromSetting(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'));
    const out: { dir: string; role: 'main' | 'panel' }[] = [{ dir: main, role: 'main' }];
    if (panel && path.resolve(panel).toLowerCase() !== path.resolve(main).toLowerCase()) out.push({ dir: panel, role: 'panel' });
    return out;
  }

  private makeRegistry() {
    return new RegistryWatcher(
      this.configDirs().map((c) => sessionsDir(c.dir)),
      (e) => this.onRegistry(e),
      { log: (m) => this.log.info(m) },
    );
  }

  private restartRegistry() {
    this.registry.stop();
    this.registry = this.makeRegistry();
    this.registry.start();
  }

  // ---------------------------------------------------------------- inputs

  private onInbox(evs: InboxEvent[]) {
    for (const ev of evs) {
      const sid = ev.payload.session_id;
      if (sid.startsWith(SELFTEST_PREFIX)) {
        const done = this.selfTests.get(sid);
        if (done) {
          done(ev.mtimeMs);
          this.inbox.remove(ev.file);
        }
        continue;
      }
      const d = this.router.decide({ sessionId: sid, window: ev.window, cwd: ev.payload.cwd, startCwd: this.registry.bySession(sid)?.cwd });
      const kind = ev.payload.notification_type ? `${ev.signal}/${ev.payload.notification_type}` : ev.signal;
      this.log.debug(`event ${kind} session=${short(sid)} prompt=${short(ev.payload.prompt_id)} → ${d.mine ? 'mine' : 'not mine'} (${d.rule})`);
      if (!d.mine) {
        if (ev.signal === 'end') this.router.forget(sid); // keep the cache small for other windows' sessions too
        continue;
      }
      this.inbox.remove(ev.file);
      this.lastEvent = { signal: kind, session: short(sid), at: ev.mtimeMs, rule: d.rule };
      this.apply({ kind: 'hook', signal: ev.signal, at: ev.mtimeMs, payload: ev.payload }, Date.now() - ev.mtimeMs < LIVE_MS);
      if (ev.signal === 'end') this.router.forget(sid);
    }
  }

  private onRegistry(e: RegistryEvent) {
    if (e.type === 'gone') {
      this.apply({ kind: 'registryGone', sessionId: e.sessionId, at: e.at }, true);
      this.router.forget(e.sessionId);
      return;
    }
    const { entry } = e;
    if (entry.status) this.apply({ kind: 'registry', sessionId: entry.sessionId, status: entry.status, waitingFor: entry.waitingFor, at: entry.statusAt }, true);
  }

  private apply(input: TrackerInput, live: boolean) {
    const before = this.tracker.windowState().state;
    const changes = this.tracker.apply(input);
    if (!changes.length) return;
    for (const c of changes) {
      this.log.debug(`session ${short(c.sessionId)}: ${c.from} → ${c.to} (${c.reason})`);
      if (c.to === 'waiting') this.waitingSession = c.sessionId;
      else if (c.sessionId === this.waitingSession) this.waitingSession = undefined;
      if (c.to === 'idle' && c.from !== 'none') this.endedSession = c.sessionId;
    }
    this.updateTranscriptWatches();
    const after = this.tracker.windowState();
    if (after.state !== before) this.log.info(`Claude: ${before} → ${after.state}${after.working + after.waiting > 1 ? ` (${after.working + after.waiting} sessions)` : ''}`);
    const newTurn = changes.some((c) => c.to === 'working' && c.reason === 'start');
    this.table.update(after, live, newTurn);
    this.refreshStatus();
  }

  // ---------------------------------------------------------------- status bar, pause, needs-you toast

  private connectionSummary(): { summary: ConnectionSummary; detail: string } {
    const all = [...this.conn.values()].map((c) => c.status);
    if (!all.length) return { summary: 'connecting', detail: 'Checking Claude Code…' };
    const problem = all.find((s) => /^(blocked|claudeTooOld|disconnected|failed)/.test(s));
    if (problem) {
      const why = problem.startsWith('disconnected') ? "DevJack's hooks were removed from Claude Code's settings" : problem.startsWith('claudeTooOld') ? `Claude Code is too old (${problem.replace(/^claudeTooOld\s*/, '')})` : problem.startsWith('blocked') ? `settings.json can't be changed: ${problem.replace(/^blocked\s*/, '')}` : problem;
      return { summary: 'problem', detail: why };
    }
    if (all.includes('connected')) return { summary: 'connected', detail: 'Connected to Claude Code.' };
    if (all.includes('userDisconnected')) return { summary: 'off', detail: 'Disconnected from Claude Code (your choice).' };
    if (all.includes('off')) return { summary: 'off', detail: 'Automatic connection is off (devjack.connectToClaudeCode).' };
    return { summary: 'off', detail: 'Claude Code was not found on this machine yet.' };
  }

  private refreshStatus() {
    const { summary, detail } = this.connectionSummary();
    this.statusBar.update({ window: this.tracker.windowState(), paused: this.isPaused() ? (this.pausedUntil === 'restart' ? 'restart' : 'hour') : false, connection: summary, connectionDetail: detail });
  }

  isPaused(): boolean {
    if (typeof this.pausedUntil === 'number' && Date.now() >= this.pausedUntil) {
      this.pausedUntil = undefined;
      this.refreshStatus();
    }
    return this.pausedUntil !== undefined;
  }

  async pause(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'For 1 hour', value: 'hour' as const },
        { label: 'Until VS Code restarts', value: 'restart' as const },
      ],
      { placeHolder: 'Pause opening the table automatically' },
    );
    if (!pick) return;
    this.pausedUntil = pick.value === 'hour' ? Date.now() + 3_600_000 : 'restart';
    this.log.info(`auto-open paused ${pick.value === 'hour' ? 'for 1 hour' : 'until restart'}`);
    this.refreshStatus();
  }

  resume(): void {
    this.pausedUntil = undefined;
    this.log.info('auto-open resumed');
    this.refreshStatus();
  }

  /** For tests and the status bar menu. */
  setPaused(until: number | 'restart' | undefined): void {
    this.pausedUntil = until;
    this.refreshStatus();
  }

  private async needsYouToast() {
    if (Date.now() - this.lastToastAt < TOAST_THROTTLE_MS) return;
    this.lastToastAt = Date.now();
    const pick = await vscode.window.showWarningMessage('Claude needs you.', 'Go to Claude');
    if (pick) void this.focus.focus(this.waitingSession);
  }

  goToClaude(): void {
    void this.focus.focus(this.waitingSession ?? this.endedSession);
  }

  async menu(): Promise<void> {
    type Item = vscode.QuickPickItem & { run: () => unknown };
    const w = this.tracker.windowState();
    const { summary } = this.connectionSummary();
    const items: Item[] = [{ label: '$(play) Open Blackjack Table', run: () => this.openTable() }];
    if (w.state !== 'idle') items.push({ label: '$(arrow-right) Go to Claude', run: () => this.goToClaude() });
    if (this.isPaused()) items.push({ label: '$(debug-continue) Resume auto-open', run: () => this.resume() });
    else
      items.push(
        { label: '$(debug-pause) Pause auto-open for 1 hour', run: () => this.setPaused(Date.now() + 3_600_000) },
        { label: '$(debug-pause) Pause auto-open until restart', run: () => this.setPaused('restart') },
      );
    if (summary === 'connected') items.push({ label: '$(debug-disconnect) Disconnect from Claude Code', run: () => this.disconnectCommand() });
    else items.push({ label: '$(plug) Reconnect to Claude Code', run: () => this.connectCommand() });
    items.push(
      { label: '$(pulse) Check Claude Connection', run: () => this.checkConnection() },
      { label: '$(beaker) Simulate Claude Run', run: () => this.simulate() },
      { label: '$(output) Show Log', run: () => this.log.show() },
    );
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'DevJack' });
    await pick?.run();
  }

  /** Transcript tailing only for working sessions the registry doesn't cover (fallback, plan §5.7). */
  private updateTranscriptWatches() {
    const want = new Set<string>();
    for (const s of this.tracker.sessions()) {
      const covered = this.registry.recognized && !!this.registry.bySession(s.id);
      if (s.state !== 'idle' && s.transcriptPath && !covered) {
        want.add(s.id);
        this.transcript.watch(s.id, s.transcriptPath);
      }
    }
    for (const id of this.watched) if (!want.has(id)) this.transcript.unwatch(id);
    this.watched.clear();
    for (const id of want) this.watched.add(id);
  }

  // ---------------------------------------------------------------- connection

  private async versions(): Promise<VersionInfo[]> {
    const out: VersionInfo[] = [];
    const panel = parseVersion(vscode.extensions.getExtension('anthropic.claude-code')?.packageJSON?.version);
    if (panel) out.push({ source: 'panel', version: panel });
    for (const v of new Set(this.registry.snapshot().map((e) => parseVersion(e.version)).filter((v): v is string => !!v))) out.push({ source: 'registry', version: v });
    this.cliVersionPromise ??= cliVersion();
    const cli = await this.cliVersionPromise;
    if (cli) out.push({ source: 'cli', version: cli });
    return out;
  }

  /** Exec form (Windows) needs a minimum Claude Code version; sh form works with any. */
  private async tooOld(): Promise<VersionInfo[]> {
    if (this.flavor !== 'powershell-exec') return [];
    return belowMinimum(await this.versions(), MIN_CLAUDE_VERSION_EXEC_FORM);
  }

  async autoConnect(trigger: 'activation' | 'focus'): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('devjack').get<boolean>('connectToClaudeCode', true);
    const state = readState(this.home);
    const firstEver = state.autoConnected.length === 0;
    for (const { dir } of this.configDirs()) {
      const insp = inspect(dir, this.desired);
      if (!insp.configDirExists) {
        this.setConn(dir, 'claudeMissing');
        continue;
      }
      const decision = decideAutoConnect(state, dir, insp.analysis, enabled);
      this.log.debug(`connection ${dir}: ${decision} (${trigger})`);
      if (decision === 'none') this.setConn(dir, 'connected');
      else if (decision === 'off') this.setConn(dir, 'off');
      else if (decision === 'userDisconnected') this.setConn(dir, 'userDisconnected');
      else if (decision === 'removedAfterConnect') this.setConn(dir, 'disconnected');
      else {
        const r = await this.write(dir, decision);
        if (r?.outcome === 'connected' && decision === 'connect' && firstEver && !has(readState(this.home).autoConnected, dir)) void this.firstTimeNotice();
        if (r?.outcome === 'connected' || r?.outcome === 'alreadyCurrent') updateState(this.home, (s) => s.autoConnected.push(dir));
      }
    }
  }

  private async write(dir: string, why: string): Promise<ApplyResult | undefined> {
    const old = await this.tooOld();
    if (old.length) {
      this.setConn(dir, `claudeTooOld (${old.map((o) => `${o.source} ${o.version}`).join(', ')} < ${MIN_CLAUDE_VERSION_EXEC_FORM})`);
      this.log.warn(`not connecting: Claude Code ${old.map((o) => o.version).join(', ')} is older than ${MIN_CLAUDE_VERSION_EXEC_FORM}`);
      return undefined;
    }
    const r = applyToSettings(dir, this.desired);
    this.log.info(`connect (${why}) ${r.settingsPath}: ${r.outcome}${r.problem ? ` (${r.problem})` : ''}${r.blockers?.length ? ` (${r.blockers.join(', ')})` : ''}${r.detail ? ` – ${r.detail}` : ''}`);
    if (r.outcome === 'connected' || r.outcome === 'alreadyCurrent') {
      this.setConn(dir, 'connected', r);
      updateState(this.home, (s) => s.connected.push(dir));
    } else this.setConn(dir, r.outcome === 'blocked' ? `blocked${r.problem ? ` (${r.problem})` : r.blockers?.length ? ` (${r.blockers.join(', ')})` : ''}` : r.outcome, r);
    return r;
  }

  private setConn(dir: string, status: string, result?: ApplyResult) {
    this.conn.set(dir, { status, result });
    this.refreshStatus();
  }

  private async firstTimeNotice() {
    if (process.env.DEVJACK_NO_WELCOME) return; // integration tests: nothing to click in the test window
    const pick = await vscode.window.showInformationMessage('DevJack is connected to Claude Code. The table opens the next time Claude works on a prompt.', 'Try it', 'Disconnect');
    if (pick === 'Try it') void this.simulate();
    if (pick === 'Disconnect') this.disconnectCommand();
  }

  async connectCommand(): Promise<void> {
    updateState(this.home, (s) => {
      s.manualDisconnect = s.manualDisconnect.filter((d) => !this.configDirs().some((c) => path.resolve(c.dir) === path.resolve(d)));
    });
    const results: string[] = [];
    for (const { dir } of this.configDirs()) {
      if (!inspect(dir, this.desired).configDirExists) {
        this.setConn(dir, 'claudeMissing');
        results.push('Claude Code is not installed yet (no config folder).');
        continue;
      }
      const r = await this.write(dir, 'command');
      if (r?.outcome === 'connected' || r?.outcome === 'alreadyCurrent') updateState(this.home, (s) => s.autoConnected.push(dir));
      results.push(r ? `${r.settingsPath}: ${this.conn.get(dir)?.status}` : `${dir}: ${this.conn.get(dir)?.status}`);
    }
    void vscode.window.showInformationMessage(`DevJack: ${results.join(' · ')}`);
  }

  disconnectCommand(): void {
    const results: string[] = [];
    for (const { dir } of this.configDirs()) {
      const r = applyToSettings(dir, null);
      this.log.info(`disconnect ${r.settingsPath}: ${r.outcome}${r.problem ? ` (${r.problem})` : ''}`);
      if (r.outcome === 'disconnected' || r.outcome === 'alreadyDisconnected') {
        updateState(this.home, (s) => {
          s.manualDisconnect.push(dir);
          s.connected = s.connected.filter((d) => path.resolve(d) !== path.resolve(dir));
        });
        this.setConn(dir, 'userDisconnected', r);
      }
      results.push(`${r.outcome}${r.problem ? ` (${r.problem})` : ''}`);
    }
    void vscode.window.showInformationMessage(`DevJack: ${results.join(' · ')}. Run "DevJack: Connect to Claude Code" to reconnect.`);
  }

  // ---------------------------------------------------------------- commands

  openTable(): void {
    this.table.openFreePlay();
  }

  async simulate(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    this.log.info('simulate: writing fake events into the inbox');
    this.heartbeat.touch();
    await simulateRun(inboxDir(this.home), this.windowId, cwd);
  }

  async checkConnection(): Promise<void> {
    const selfTest = await this.selfTest();
    const connections: ConnectionLine[] = this.configDirs().map(({ dir, role }) => ({ configDir: dir, role, status: this.conn.get(dir)?.status ?? 'unknown', inspection: inspect(dir, this.desired) }));
    const report = renderReport({
      platform: process.platform,
      flavor: this.flavor,
      connections,
      versions: await this.versions(),
      minVersion: MIN_CLAUDE_VERSION_EXEC_FORM,
      registryDirs: this.configDirs().map((c) => sessionsDir(c.dir)),
      registryRecognized: this.registry.recognized,
      registrySessions: this.registry.snapshot(),
      mySessionIds: new Set(this.tracker.sessions().map((s) => s.id)),
      heartbeatAgeMs: this.heartbeat.age(),
      devjackHome: this.home,
      windowId: this.windowId,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      lastEvent: this.lastEvent,
      gitBash: process.platform === 'win32' ? findGitBash() : undefined,
      selfTest,
    });
    const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Run the installed SessionStart command (or the one DevJack would install) with a fake payload. */
  private async selfTest(): Promise<SelfTestResult> {
    const main = this.configDirs()[0]!.dir;
    let text: string | undefined;
    try {
      text = readTextIfExists(settingsFile(main));
    } catch {
      /* reported elsewhere */
    }
    const installed = ourEntries(text).find((e) => e.event === 'SessionStart')?.entry as HookEntry | undefined;
    const entry = installed ?? this.desired.SessionStart!;
    const sid = SELFTEST_PREFIX + randomHex(6);
    this.heartbeat.touch();
    const t0 = Date.now();
    const arrived = new Promise<number>((resolve) => this.selfTests.set(sid, resolve));
    const run = await runEntry(entry, JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', cwd: '/devjack-selftest' }), { ...process.env, DEVJACK_WINDOW_ID: this.windowId });
    this.inbox.scan();
    const got = await Promise.race([arrived, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))]);
    this.selfTests.delete(sid);
    const which = installed ? 'the installed command' : 'the command DevJack would install (not installed)';
    if (run.code !== 0) return { ok: false, detail: `${which} exited with ${run.code}: ${run.stderr.slice(0, 200)}` };
    if (run.stdout) return { ok: false, detail: `${which} printed to stdout (it must print nothing)` };
    if (got === undefined) return { ok: false, detail: `${which} ran, but no file arrived in the inbox within 5 s` };
    return { ok: true, ms: Date.now() - t0, detail: `${which} delivered an event in ${Date.now() - t0} ms` };
  }
}
