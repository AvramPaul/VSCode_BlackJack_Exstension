# DevJack v2: Project Plan

---

## 1. Goal

**DevJack** is a VS Code extension that opens a Blackjack table beside the editor while Claude Code works on a prompt, and closes it when Claude is done. It is published on the VS Code Marketplace and on Open VSX (for Cursor, Windsurf and VSCodium).

**Plug and play is the main requirement:**

- The user installs DevJack from the Extensions view and does nothing else. There is no "install hooks" button, no new terminal, no restart, no Node.js and no setting to edit.
- The next time Claude Code works on a prompt, the table opens. This must work for:
  - the **Claude Code VS Code extension** (chat panel), and
  - the **`claude` CLI** in a VS Code integrated terminal, including terminals that were already open before DevJack was installed.
- The table closes when Claude finishes, is interrupted (Esc or the Stop button) or fails.
- When Claude needs a permission decision or an answer, the table says so and offers to jump back.

**Not in v2.0:** other AI CLIs (Gemini, Copilot, Ollama…), Claude Desktop, Claude running in external terminals, real money, multiplayer.

---

## 2. Lessons from v1

v1 lives in the old `Claude-Extension/devjack` folder. Its first spec (`BUILD_EXTENSION.md`) watched terminal commands. Claude Code hooks were added later.

### 2.1 Keep: these worked

- **Hooks are the source of truth.** Only Claude Code hooks tell "Claude is working on a prompt" apart from "a Claude session is open". When v1 watched terminal commands instead, the table stayed open for the whole `claude` session.
- **The hook never interferes with Claude.** It prints nothing to stdout and always exits 0. Stdout from `UserPromptSubmit` is added to Claude's context, and any other non-zero exit shows "hook error" to the user.
- **Careful `settings.json` editing:**
  - never touch a file that is not valid JSON;
  - keep every user hook;
  - find our own entries by a marker;
  - make install and remove idempotent;
  - make a one-time backup;
  - write atomically, with a fallback if the rename fails.
- **Stable paths outside the extension folder.** The extension folder changes with every version.
- **Esc detection through the transcript.** The Stop hook does not run when the user interrupts; the docs now confirm this.
- **Focus rules:**
  - open with `preserveFocus`;
  - give focus back to Claude when the table closes;
  - if the user closed the table, don't reopen it until the next prompt.
- **Also keep:** the bankroll in `globalState`, a webview CSP with a nonce, and an uninstall script that removes the hooks before deleting files.

### 2.2 Fix: what failed or blocked plug and play

| # | v1 problem | Effect | v2 approach |
|---|---|---|---|
| 1 | The user had to click **Install hooks** | Not plug and play | Connect automatically on first activation. Show one notification with a **Disconnect** button (§5.3) |
| 2 | Sessions were routed by `DEVJACK_SIGNAL_DIR`, an env var that only terminals receive | The **Claude panel never reported**, and terminals opened before install never reported ("open a NEW terminal") | Route by the `cwd` in the hook payload, matched against the window's workspace folders. The env var is only an extra, more precise signal (§5.5) |
| 3 | The hook command was `node …` | Requires Node on PATH. Native Claude installs and the panel's bundled CLI don't need Node, so many users won't have it | Use only what the OS ships: `/bin/sh` and `powershell.exe` (§5.2) |
| 4 | `PostToolUse` with matcher `*` | Started a Node process on every tool call | Use only rare events. Transcript growth means "back to work" |
| 5 | "Needs you" came only from `Notification` | Arrived about 6 s late, and questions (`AskUserQuestion`) were missed | Use `PermissionRequest` (immediate), `PreToolUse(AskUserQuestion)` and `Notification` |
| 6 | No `StopFailure` handling | An API error left the table open on "working" | Handle `StopFailure`, plus two safety nets: `idle_prompt` and stale sessions |
| 7 | Opened on every prompt | The table flashed for 2-second answers | Open delay, 2.5 s by default |
| 8 | Closed in the middle of a hand | Lost round, abrupt | Show a "Claude is done" banner and close after the hand (configurable) |
| 9 | Toasts on every open and close | Notification spam | Use the status bar. Toast only when Claude needs you |
| 10 | "Simulate" opened the panel directly | Demos never exercised the real path | Simulate writes fake events into the inbox |
| 11 | Keyword fallback (`ai`, `cursor`, `gemini`…) | False positives. Needs shell integration, which cmd.exe doesn't have | Dropped in v2.0 |
| 12 | The game was HTML/CSS/JS inside a TS template string | No tooling, no tests, no way to preview in a browser | A separate `webview/` app bundled by esbuild, a pure rules engine with unit tests, and a browser dev harness |
| 13 | Toy rules: fixed −25/+50, no bets, no double or split, no 3:2, one deck | Not real Blackjack | Full rules (§7.1) |
| 14 | `JSON.stringify` rewrote the whole `settings.json` | Reformatted the user's file | Minimal edits with `jsonc-parser` |
| 15 | No logs or diagnostics | When it didn't work, there was no way to see why | Output channel, **Check Claude Connection** command, status bar item |
| 16 | Not publishable: placeholder publisher, `private: true`, no icon, license, repository, changelog, bundling, tests or CI | Can't ship | §10 |
| 17 | The spec contained full code and no verification step | Wrong assumptions were found late, and the design was rewritten during the build | The Phase 1 spike checks every assumption first |
| 18 | v1's 5 hook entries are still in this machine's `~/.claude/settings.json`, pointing to `~/.devjack/devjack-hook.cjs` | Duplicate events once v2 is installed | Phase 0 removes them, and v2's installer also removes any v1 entries |

---

## 3. Facts this design relies on

- ✅ = stated in the official hooks docs ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)) or the Claude Code changelog, checked 2026-11-19. The dev machine runs Claude Code 2.1.328, installed natively (no Node needed).
- 🧪 = not documented, but observed in the Phase 1 spike (2026-11-19, Claude Code 2.1.328, Windows 11, interactive CLI and VS Code panel; details in §12). Undocumented behavior can change, so code that relies on it must fail safe.
- 🔬 = not documented and not verified yet.

**Where hooks run**
- ✅ The same hook events fire in the terminal, in the IDE extensions (including the VS Code panel) and in Desktop. The VS Code extension and the CLI share `~/.claude/settings.json`.
- ✅ Running sessions reload settings when the file changes, so Claude needs no restart after DevJack connects. 🧪 Confirmed in the panel: hooks added mid-session fired on the next tool call.
- ✅ **Shell form** (no `args`): the `command` string runs with `sh -c` on macOS and Linux. On Windows it runs with Git Bash, or with PowerShell if Git Bash isn't installed.
- ✅ **Exec form** (`args` present): `command` is spawned directly with `args` as the argument vector, with no shell on any platform. Added in v2.1.139.
- ✅ Since v2.1.299, on Windows **without Git Bash**, a shell-form `PreToolUse` or `PermissionRequest` hook that fails or times out **blocks the tool call**. Exec form is not affected.
- 🧪 The panel runs the CLI bundled with the Claude extension (`…/anthropic.claude-code-*/resources/native-binary/claude.exe`), not the `claude` on PATH. The two versions can differ.
- 🧪 Hook processes have no console window when the panel starts them (`GetConsoleWindow()` returns 0, in exec form and under Git Bash), so nothing flashes.

**How hooks behave**
- ✅ Exit codes:
  - 0 means success;
  - 2 blocks the action, so never use it;
  - any other non-zero exit shows "`<event>` hook error" to the user (🧪 the TUI shows "UserPromptSubmit hook failed: `<stderr>`").
- ✅ Stdout from `UserPromptSubmit` and `SessionStart` becomes Claude context, so the hook must print nothing.
- ✅ `UserPromptSubmit` hooks time out after 30 s by default.
- ✅ Every hook receives `session_id`, `transcript_path`, `cwd` and `hook_event_name` on stdin. 🧪 `prompt_id` is missing on `SessionStart`. `permission_mode` is missing on `SessionStart`, `Notification`, `StopFailure` and `SessionEnd`.
- 🧪 `cwd` is the session's **current** directory. It follows `cd` in Claude's Bash tool, so it can move into a subfolder or out of the workspace. The panel sends a lowercase drive letter (`c:\…`), the CLI an uppercase one (`C:\…`).
- 🧪 `prompt_id` identifies a turn: it is the same on every event of the turn and new for the next turn. A message sent while Claude is working fires `UserPromptSubmit` again **with the same `prompt_id`** and joins the running turn (one `Stop` for both).
- 🧪 Project-level hooks (`.claude/settings*.json`) load only after the folder is trusted, and the CLI's trust dialog now defaults to "No". User-level hooks don't depend on trust.

**Events DevJack uses**
- ✅ `UserPromptSubmit` also fires for turns that Claude starts on its own.
- ✅ `PermissionRequest` fires as soon as a tool call needs a permission decision. 🧪 It also fires in the panel (which uses `--permission-prompt-tool=stdio`), 0.07–0.2 s after `PreToolUse`, and also for `AskUserQuestion` and for plan approval (`ExitPlanMode`).
- ✅ `Notification` has a `notification_type` field. Values include:
  - `permission_prompt`: 🧪 6.0 s after `PermissionRequest`, in the CLI and the panel, also for questions and plan approval;
  - `idle_prompt`: 🧪 in the CLI, 60 s after `Stop`, **only if the terminal is unfocused** when the turn ends, and never after an interrupt. 🧪 The panel never sent it, not even after 3 idle hours;
  - `elicitation_dialog`.
- ✅ `Stop` does **not** run when the user interrupts. API errors fire `StopFailure` instead (🧪 with an `error` field such as `model_not_found`; no `Stop` follows). No hook fires for Esc or the Stop button.
- ✅ `SessionEnd` has a short time budget, about 1.5 s.
- 🧪 The panel fires `SessionStart` when a tab opens, before the first prompt. That is also when it starts the CLI process.
- 🧪 The Claude extension also starts short-lived sessions on its own (for example 3 at once on a window reload). Each fires `SessionStart` and, within 0.6 s, `SessionEnd` with reason `other`, and no turn. So `SessionStart` never means "working".

**Interrupts (no hook fires)**
- 🧪 Transcript markers. Esc while text streams, and the panel's Stop button, append a user entry `[Request interrupted by user]`. Esc during a running tool, or at a permission or plan dialog, appends `[Request interrupted by user for tool use]`.
- 🧪 **An Esc before Claude has streamed any output leaves no trace:** no hook, no transcript entry, and the prompt goes back into the input box.
- 🧪 **Session registry.** Each live session keeps `<config dir>/sessions/<pid>.json` with `sessionId`, `cwd` (the start directory), `entrypoint` (`claude-vscode` for the panel), `version`, `status` (`idle`, `busy` or `waiting`) and `waitingFor` (`permission prompt` or `input needed`). `status` changes within about 0.2 s of every transition, **including every kind of interrupt**, in the CLI and in the panel. The file is deleted when the session exits. The same folder holds `<pid>.<hash>.key` files with a secret token: never read them.

**Settings rules**
- ✅ Documented hook entry keys include `type`, `command`, `args` (v2.1.139+), `shell`, `timeout`, `async`, `onFailure` (v2.1.295+), `if`, `statusMessage`, `once` and `asyncRewake`.
- ✅ An unknown **event name** is only a warning, and that entry is skipped. An invalid value is a "Settings Error" for that file.
- 🔬 What happens with unknown keys inside an entry, or with a key that is newer than the running Claude Code, is not documented. Never add a key that the minimum supported version (§5.2) doesn't know.
- ✅ `disableAllHooks`, `allowManagedHooksOnly` and `allowedHttpHookUrls` can switch our hooks off. Detect them and explain; don't fight them.
- 🧪 The Claude extension builds the panel CLI's environment as `{...process.env}` of the extension host, then applies its `claudeCode.environmentVariables` setting. That setting can change `CLAUDE_CONFIG_DIR` for the panel only.

**Rejected alternatives**
- ✅ Claude Code plugins can bundle hooks, but enabling a plugin needs `/plugin install` or folder trust. That is not plug and play. ❌
- ✅ `http` hooks exist, but a failed request shows a non-blocking error, so every event would show an error while VS Code is closed. ❌

**Verified in Phase 1:** see §12. Still open: a clean machine (Windows Sandbox isn't enabled on the dev machine) and macOS. Both move to Phase 5.

---

## 4. Architecture

```
Claude Code (VS Code panel, or `claude` in a terminal)
  │  hook event, JSON on stdin
  ▼
Hook command (sh shell form / powershell.exe exec form, no Node, no script file)
  │  exits at once if no DevJack window is alive (heartbeat)
  │  writes {signal, window, payload} → ~/.devjack/inbox/<time>-<pid>-<signal>.json
  ▼
DevJack (one instance per VS Code window)
  inbox → parser → router ("is this session mine?") → session tracker (state machine)
  session registry (<config dir>/sessions/*.json, best effort) ──┘   (interrupts, approvals)
        → table controller (open delay, close after hand, focus) → game webview
        → status bar · diagnostics · log
```

**Rule:** the hook only passes data along. All logic lives in TypeScript, where it can be tested. Hooks start sessions and turns. The session registry (§5.7) only ends or clears states: it never opens the table.

`~/.devjack/` contains `heartbeat`, `inbox/` and `state.json`. `DEVJACK_HOME` overrides the location; tests use this.

---

## 5. Extension design

### 5.1 Hook events

| Event | Matcher | Signal | Meaning |
|---|---|---|---|
| `SessionStart` | – | `session` | A session exists (used for diagnostics and the routing cache) |
| `UserPromptSubmit` | – | `start` | Claude is working |
| `PermissionRequest` | – | `waiting` | Claude needs a permission decision, an answer to a question (`AskUserQuestion`) or a plan approval (`ExitPlanMode`) |
| `Notification` | – | `notify` | The extension reads `notification_type`: `permission_prompt` or `elicitation_dialog` means waiting, `idle_prompt` means idle |
| `Stop` | – | `done` | The turn finished |
| `StopFailure` | – | `failed` | An API error ended the turn |
| `SessionEnd` | – | `end` | The session is gone |

- **No `PostToolUse`:** it fires too often. After a "waiting", the session registry (or transcript growth) shows that Claude moved on (§5.7).
- **No `PreToolUse(AskUserQuestion)`:** the spike showed that `PermissionRequest` also fires for questions and plan approval, in the CLI and in the panel.
- **`Notification` is a backup:** `permission_prompt` arrives 6 s after `PermissionRequest`, and `idle_prompt` only fires when the terminal is unfocused. Keep it for `elicitation_dialog` and as a second source.
- **Synchronous hooks with `"timeout": 5`:** these events are rare, and synchronous hooks keep the order of events within a session. Phase 1 measured about 0.2 s per event on Windows in exec form (about 0.7 s on a cold first run), so no hook needs `async`.

### 5.2 The hook command

Requirements:

1. **Nothing beyond the OS.** Use `/bin/sh` on macOS and Linux, and Windows PowerShell 5.1 (`powershell.exe`) on Windows. No Node, no Git Bash, and no `bash` from PATH. On Windows, `bash` on PATH can be WSL's `System32\bash.exe`.
2. **Self-contained.** No script file that can go missing. On Windows use `-EncodedCommand`, not `-File`, so the PowerShell execution policy doesn't apply.
3. **Independent of Claude's hook shell.**
   - **Windows uses exec form:** `"command": "powershell.exe"` with the flags in `"args"`. Claude spawns it directly, so it doesn't matter whether Git Bash is installed. There is no quoting layer, and the v2.1.299 rule that blocks a tool call when a shell-form hook fails without Git Bash doesn't apply.
   - **macOS and Linux use shell form,** which is `sh -c` there.
4. **Silent:** prints nothing, exits 0 on every path, and finishes in under 1 s. The Windows script uses .NET calls only, no cmdlets. Cmdlets such as `Test-Path` or `Join-Path` trigger module auto-loading, which writes a CLIXML progress record to stderr on every run and costs about 70 ms. 🧪 No console window flashes (§3).
5. **Exits immediately unless a DevJack window touched `~/.devjack/heartbeat` in the last 2 minutes.** No files pile up while VS Code is closed, or after an uninstall that skipped cleanup.
6. **Writes atomically and in UTF-8:** write `.tmp`, then rename. Paths can contain `ș`, spaces or apostrophes, so escape baked-in paths for the target language (PowerShell: double `'`; sh: `'\''`).
7. **Carries the marker `devjack-hook-v2`.**
   - In sh, it is a trailing ` # devjack-hook-v2` comment.
   - In PowerShell, it is the first line of the encoded script. The installer finds Windows entries by `command` = `powershell.exe` and by decoding the `-EncodedCommand` argument.
8. **Minimum Claude Code version 2.1.139** (exec form). An older version would ignore `args` and run a bare `powershell.exe`. DevJack reads the versions it can see before connecting:
   - the Claude extension's version;
   - `version` in the session registry;
   - `claude --version`.

   Below 2.1.139 it doesn't connect, and **Check Claude Connection** says why. Don't add `onFailure`: exec form doesn't need it, and versions before 2.1.295 don't know it.

🧪 Verified in Phase 1 with real Claude Code, in the CLI and the panel, including a home path `Ana Ștefan's home` and a `cwd` with `ș`, a space and an apostrophe. The installer generates one entry per signal, with absolute paths baked in.

**macOS / Linux** (shell form, the `command` string; verified under dash, bash and Git Bash sh). BSD `find` on macOS rounds `-mmin` up to whole minutes, so the heartbeat window there is 60 s, not 120 s. That is still safe, because every window touches the heartbeat every 30 s.
```sh
d='/home/me/.devjack'; [ -n "$(find "$d/heartbeat" -mmin -2 2>/dev/null)" ] || exit 0; mkdir -p "$d/inbox" && f="$d/inbox/$(date +%s)-$$-start" && { printf '{"v":2,"signal":"start","window":"%s","payload":' "$(printf %s "$DEVJACK_WINDOW_ID" | tr -cd 'a-f0-9')"; cat; printf '}'; } > "$f.tmp" && mv "$f.tmp" "$f.json"; exit 0 # devjack-hook-v2
```

**Windows** (exec form; about 0.2 s per event, about 0.7 s on a cold first run):
```json
{ "type": "command", "command": "powershell.exe", "timeout": 5,
  "args": ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", "<base64 of the UTF-16LE script below>"] }
```
```powershell
# devjack-hook-v2
try {
  $d = 'C:\Users\me\.devjack'; $hb = [IO.Path]::Combine($d, 'heartbeat')
  if (-not [IO.File]::Exists($hb) -or ([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($hb)).TotalSeconds -gt 120) { exit 0 }
  # Read raw stdin bytes as UTF-8; don't rely on the console encoding (there may be no console).
  $ms = [IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($ms)
  $in = [Text.Encoding]::UTF8.GetString($ms.ToArray()); if (-not $in.Trim()) { $in = 'null' }
  $w = [string][Environment]::GetEnvironmentVariable('DEVJACK_WINDOW_ID') -replace '[^a-f0-9]', ''
  $dir = [IO.Path]::Combine($d, 'inbox'); [void][IO.Directory]::CreateDirectory($dir)
  $f = [IO.Path]::Combine($dir, ('{0}-{1}-start' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $PID))
  [IO.File]::WriteAllText("$f.tmp", '{"v":2,"signal":"start","window":"' + $w + '","payload":' + $in + '}', [Text.UTF8Encoding]::new($false))
  [IO.File]::Move("$f.tmp", "$f.json")
} catch {}
exit 0
```

The shell-form Windows string from the first draft (`powershell.exe … -EncodedCommand … # devjack-hook-v2`) also worked: stdin reached the nested `powershell.exe` under Git Bash and under `"shell": "powershell"`. It is slower (0.25–0.6 s) and exposed to the Git Bash rules, so it is not used. v2's installer still recognizes and removes it.

### 5.3 Connecting to Claude Code (writing settings.json)

**When to connect**
- On activation, if `devjack.connectToClaudeCode` is on (the default) and `~/.devjack/state.json` doesn't record a manual disconnect.
- If the Claude config folder doesn't exist yet (Claude isn't installed), don't create it. Check again on the next activation and whenever the window gains focus.

**Which file**
- `$CLAUDE_CONFIG_DIR/settings.json` if that variable is set and absolute, otherwise `~/.claude/settings.json`.
- The panel can use a different folder: the Claude extension's `claudeCode.environmentVariables` setting may set `CLAUDE_CONFIG_DIR` for the panel only (§3). If it does, connect that folder too, and watch its `sessions/` registry.
- User settings only. Never project files.

**How to write it**
- Make minimal edits with `jsonc-parser` (`modify` + `applyEdits`). Keep indentation, line endings, key order and any BOM.
- Re-read the file right before the atomic rename, and retry if it changed (Claude Code also writes this file). Verify the result after writing.
- Remove v1 entries (`devjack-hook.cjs`) and outdated v2 entries, then add the current ones.
- If everything is already current, **don't write at all.** Claude reloads the file on every change.
- Keep v1's rules: never touch invalid JSON or a `hooks` value that isn't an object, keep user hooks, and make a one-time backup `settings.json.devjack-backup`.

**Never fight the user**
- Connect automatically only once per home folder, recorded in `~/.devjack/state.json`.
- If our entries disappear later, show "Disconnected" in the status bar with a **Reconnect** action. Never re-add them silently.
- The first time only, show this notification: *"DevJack is connected to Claude Code. The table opens the next time Claude works on a prompt."* with **Try it** and **Disconnect** buttons.

**When something blocks us**
- Invalid JSON, `disableAllHooks` or `allowManagedHooksOnly`: show a warning in the status bar and an explanation in **Check Claude Connection**. Change nothing.

**Uninstall**
- `vscode:uninstall` runs `dist/uninstall.js`, which removes our entries and then deletes `~/.devjack`.
- VS Code runs it with its own Node, and only at the restart after an uninstall.
- It doesn't always run (the extension folder deleted by hand, some forks, remotes). That is why leftovers must be harmless: see rules 2 and 5 in §5.2.

### 5.4 Inbox

- **Watching:** use `fs.watch` on `~/.devjack/inbox/`, and also poll every 1 s, because `fs.watch` is unreliable on some file systems and in WSL. Ignore `.tmp` files.
- **Reading:** each window reads every new file once, caps the size at 2 MB and parses defensively.
- **Cleanup:** the owning window deletes a file after handling it. Any window deletes files older than 2 minutes.
- **Privacy:** these files contain the prompt and tool input. Delete them quickly and never log their content.
- **Heartbeat:** every window touches `~/.devjack/heartbeat` every 30 s and whenever the window gains focus. That covers a laptop waking from sleep just before the user types a prompt.
- **On activation:** handle files that are already in the inbox (they arrived while the window was loading) to rebuild state. Only open the table for a `start` that is less than about 10 s old.

### 5.5 Routing: which window owns a session

Every window applies the same rules on its own:

1. If the event's `window` equals this window's id, the session is mine.
2. Otherwise, if the session's **start directory** is inside one of this window's workspace folders, the session is mine. The start directory is the `cwd` of the first event DevJack sees for that session (normally `SessionStart`), or the `cwd` in its registry file (§5.7), which always holds the start directory. Normalize paths first: realpath, `/` vs `\`, drive-letter case (🧪 the panel sends `c:\…`, the CLI `C:\…`), and case-insensitive comparison on Windows and macOS.
3. Otherwise, it is not mine.

- **Cache the owner** per `session_id` on the first match. 🧪 `cwd` in later payloads follows `cd` in Claude's Bash tool (worktrees too), so it can leave the workspace.
- **Window id:** a random hex string kept in `workspaceState`, so terminals restored after a reload keep matching (a v1 lesson). Expose it as `DEVJACK_WINDOW_ID`:
  - through `environmentVariableCollection`, for terminals;
  - through `process.env` in the extension host. 🧪 The panel's CLI inherits it, so rule 1 also covers the panel in windows without a folder. The panel copies `process.env` when a tab opens, so tabs that were opened or restored before DevJack activated don't carry it. Rule 2 covers those.
- **Known limits:**
  - two windows with nested folders;
  - `claude` started outside the workspace, from a terminal that was opened before DevJack was installed.

### 5.6 Session tracker (pure TypeScript, unit tested)

| From | Event | To |
|---|---|---|
| idle / removed | `start` | working |
| working / waiting | `start` with the same `prompt_id` (a message sent mid-turn) | unchanged |
| working / waiting | `start` with a new `prompt_id` | working |
| working | `waiting`, or `notify` with `permission_prompt` / `elicitation_dialog` | waiting |
| waiting | registry `busy`, or transcript grew | working |
| working / waiting | `done`, `failed`, registry `idle`, interrupt marker, or `notify` with `idle_prompt` | idle |
| any | `end`, or its registry file disappeared | removed |
| working / waiting | no event, no registry change and no transcript growth for 30 min | idle (safety net) |

- The **window state** is waiting if any session is waiting, otherwise working if any session is working, otherwise idle.
- Handle files in mtime order. Hooks are synchronous, so the order within a session holds.
- 🧪 `prompt_id` stays the same within a turn, so ignore a `waiting` or `notify` whose `prompt_id` belongs to a turn that is already done.
- Registry input only acts on sessions the tracker already knows from hooks. It moves them to idle or clears waiting, and never starts a turn.

### 5.7 Session registry and transcript (best effort, isolated in `registry.ts` and `transcript.ts`)

No hook fires for an interrupt (§3), so DevJack reads two undocumented sources. Both are optional: if one is missing or its format changes, the next one takes over.

**1. Session registry** (`registry.ts`), the first choice. 🧪 It covers every interrupt, including the early Esc that leaves no other trace.
- Watch `<config dir>/sessions/` with `fs.watch` plus a 1 s poll. Read only files named `<digits>.json`, and **never** the `*.key` files.
- Match files to known sessions by `sessionId`. Map `status`:
  - `idle` → idle;
  - `busy` → clears waiting (🧪 immediately after an approval, before the tool even runs);
  - `waiting` → waiting.
- A file that disappears means the session ended (backup for `SessionEnd`).
- Ignore unknown `status` values. Log "registry format not recognized" once and fall back to the transcript.

**2. Transcript** (`transcript.ts`), the fallback when the registry isn't usable.
- While a session is working or waiting, read the new bytes of its `transcript_path` every second.
- A new user entry whose text starts with `[Request interrupted by user` means the user interrupted. 🧪 This covers Esc mid-stream, Esc during a tool or at a dialog, and the panel's Stop button, but **not** an Esc before any output.
- File size growth alone (no format knowledge needed) clears waiting once the user has answered.

**3. Safety nets:** `idle_prompt` (only when the terminal is unfocused) and the 30-minute stale-session rule (§5.6).

### 5.8 Table behavior

**Opening**
- Open when the window state is working and stays working for `openDelaySeconds` (2.5).
- If Claude asks for permission right away, don't open: the user needs to answer. Once Claude works again after the answer, the open delay starts over.
- Open in the editor area with `ViewColumn.Beside` and `preserveFocus: true`. Never steal focus and never cover Claude's panel.
- There is at most one table per window.

**Status strip at the top of the table**
- Working: elapsed time, plus the number of sessions if there is more than one.
- **Needs you:** an amber pulse, a **Go to Claude** button, an optional sound and a toast (only while the table is open, at most one every 15 s).
- Done.

**When Claude is done**
- If no hand is in progress, show "Done ✓" for about 1 s, then close.
- If a hand is in progress, show the banner "Claude finished, finish your hand" and close when the hand settles (at most 60 s later).
- The `closeBehavior` setting can be `afterHand` (the default), `immediately` or `keepOpen`.

**Focus on close**
- If the table had focus, focus Claude:
  - for a terminal session, the terminal running `claude` (known from shell integration when it's available);
  - for the panel, `claude-vscode.focus` ("Claude Code: Focus input"). 🧪 It focuses the Claude input. If a text editor with a selection is active, it also inserts that selection as an @-mention, which can't happen while the table has focus. `claude-vscode.sidebar.open` and `claude-vscode.editor.openLast` are alternatives. Verify the behavior at runtime in Phase 3.

**User rules**
- If the user closed the table while Claude was working, don't reopen it until the next `start`.
- **Open Blackjack Table** is free play: it never closes automatically.
- The status bar menu has **Pause auto-open** (for 1 hour, or until restart).
- No toasts when the table opens or closes.

### 5.9 Commands and settings

**Commands**
- **Open Blackjack Table**
- **Simulate Claude Run:** writes fake `start → waiting → start → done` events into the inbox, so it tests the real pipeline.
- **Check Claude Connection**
- **Connect to Claude Code** / **Disconnect from Claude Code**
- **Pause / Resume Auto-Open**
- **Show Log**

**Settings**

| Setting | Default |
|---|---|
| `devjack.connectToClaudeCode` | `true` |
| `devjack.autoOpen` | `true` |
| `devjack.openDelaySeconds` | `2.5` |
| `devjack.closeBehavior` | `"afterHand"` |
| `devjack.alertWhenClaudeNeedsYou` | `true` |
| `devjack.sound` | `true` |
| `devjack.debugLog` | `false` |

Game options (number of decks, dealer rule, felt color, four-color deck) live in the in-game menu.

### 5.10 Diagnostics

- **Output channel "DevJack":** logs the type, session and routing decision of each event. Never the content.
- **Check Claude Connection** shows:
  - the settings path;
  - the hook status (current, outdated, missing or v1 found) and any blockers;
  - the Claude Code versions found (panel extension, CLI, registry) against the minimum (§5.2);
  - whether the session registry is readable, and the live sessions it lists for this window;
  - the heartbeat;
  - this window's id and folders;
  - the last event this window received;
  - which shell Claude will use (whether Git Bash was found);
  - a **self-test** that runs the installed command with a fake payload and checks that a file arrives.

---

## 6. Phase 1 spike: verify before building

**Setup**
- Make a throwaway `spike/` workspace with a `.claude/settings.local.json`. Project-level hooks leave the real global settings untouched.
- Register a logger for every event in §5.1, plus `PostToolUse`, `SubagentStop` and `PreToolUse(*)`. Log the payload, the time, `DEVJACK_WINDOW_ID` and `CLAUDE_PROJECT_DIR`.
- Then test the real §5.2 commands, both under Git Bash and under PowerShell. Force PowerShell with `"shell": "powershell"` on a test entry.
- The dev machine has Node, Git Bash and PowerShell 7, so it hides the clean-machine problems. Use **Windows Sandbox** (included in Windows 11 Pro) as a clean machine without Node or Git Bash.

**Questions** (record each answer in §12):

1. Do all §5.1 events fire from the **Claude Code VS Code panel**? Is `cwd` the workspace folder?
2. Does `PermissionRequest` fire in the CLI and in the panel? How late does `Notification(permission_prompt)` arrive?
3. Esc in the CLI, and the Stop button in the panel: is the transcript marker written? Does `idle_prompt` follow?
4. Does the panel's CLI inherit `DEVJACK_WINDOW_ID` when another extension sets it on `process.env`?
5. Windows command:
   - Does it work when Git Bash runs it, and when PowerShell runs it?
   - Does stdin reach the nested `powershell.exe`?
   - Does a `cwd` containing `ș` arrive intact?
   - Does it work with a home path containing a space and an apostrophe?
   - Does any console window flash?
   - How long does each event take? (Target: under 0.5 s.)
6. Does the sh command work on Linux/macOS (at least in CI with fake stdin)?
7. `prompt_id`: is it the same for every event of a turn? Is it new for a message sent while Claude is working?
8. `AskUserQuestion` and plan approval (`ExitPlanMode`): which events fire?
9. Which command ids does the Claude extension register? Use `vscode.commands.getCommands()` filtered by `claude`, and look for one that focuses its panel.
10. Does a failing hook show the "hook error" notice? Does the heartbeat early exit stay silent?

**Gate:** if any answer contradicts §3–§5, update those sections before starting Phase 2.

---

## 7. The game, rebuilt from scratch

**Design brief:** a premium, calm casino table you enjoy for 30 seconds between prompts. It must be readable in a narrow side panel, quick to resume, and never flashy or noisy.

### 7.1 Rules

The rules live in a pure `engine/` module, with no DOM, fully unit tested.

- **Shoe:**
  - 6 decks by default (options: 1, 2, 6, 8);
  - Fisher–Yates shuffle with `crypto.getRandomValues`;
  - cut card at about 75 % penetration, reshuffle between rounds.
- **Dealer:**
  - stands on soft 17 (option: hits soft 17);
  - peeks for blackjack when showing an Ace or a 10-value card.
- **Payouts:**
  - blackjack pays 3:2;
  - a push returns the bet;
  - insurance is offered when the dealer shows an Ace and pays 2:1.
- **Doubling and splitting:**
  - double on any first two cards, including after a split;
  - split up to 4 hands;
  - split aces get one card each;
  - 21 after a split is not a blackjack.
- **Bets:** chips of 5, 25, 100 and 500. Minimum bet 5, maximum 500 (or the whole bankroll if smaller).
- **Bankroll:** starts at 1,000 play chips. A free **Rebuy** is offered when the bankroll drops below the minimum bet, and rebuys are counted in the stats.
- **Stats:** hands played, wins / losses / pushes, blackjacks, biggest win, best streak, net result, with a reset button.
- **Later (v2.1):** surrender, basic-strategy hints.
- **Choices made in Phase 4** (the brief left them open):
  - any two cards of equal value can be split (K+Q too);
  - split aces can't be re-split;
  - insurance is offered only when the bankroll covers it. With a blackjack, it works as even money.
  - The dealer doesn't draw when every hand busted or is a blackjack.
  - 3:2 and insurance can leave halves, so the bankroll can show e.g. 2.50. The pre-filled bet is rounded down to whole chips of 5.

### 7.2 Look and feel

- **Table:**
  - deep felt with a soft vignette and a curved rail at the bottom;
  - the felt print "BLACKJACK PAYS 3 TO 2 · DEALER STANDS ON SOFT 17" along an arc (SVG `textPath`);
  - a bet circle, a shoe at top right, a discard tray at top left;
  - felt colors: green, blue, burgundy.
- **Cards:** SVG generated in code: rounded corners, corner indices, proper pip layouts, original face-card art and a back with a DevJack monogram. Optional four-color deck.
- **Chips:** SVG with edge stripes and a distinct color per denomination. Stacks slide into the bet circle, and payouts slide in from the dealer.
- **Motion:**
  - dealing from the shoe, a 3D flip of the hole card, chip slides;
  - a win glow, a short blackjack shimmer, a shake on bust.
  - Animate only `transform` and `opacity`, and respect `prefers-reduced-motion`.
  - **No CPU use when idle:** no permanent `requestAnimationFrame` loop.
- **Layout:** works from 320 px to 1400 px wide and in short panels, using container queries and `clamp()`. The main target is a side panel 360–700 px wide.
- **Fonts:** local only, because the CSP blocks remote fonts. Use the system font stack or bundle one font under the OFL license.
- **Sound:** short synthesized WebAudio sounds (card, chip, win), only after a user action. In-game mute button; respects `devjack.sound`.
- **Original art only:** no copied card designs, and no Claude or Anthropic logos or look-alikes.

### 7.3 Flow and controls

**Round flow**
1. Betting, with the last bet pre-filled.
2. **Deal.**
3. Insurance, if the dealer shows an Ace.
4. Player actions.
5. Dealer plays.
6. Settlement, then back to Betting.

When the table opens automatically, it waits in Betting, so one key (Space) deals.

**Keys** (every button shows its key)

| Key | Action |
|---|---|
| `Space` | Deal / rebet |
| `H` | Hit |
| `S` | Stand |
| `D` | Double |
| `P` | Split |
| `I` / `N` | Take / decline insurance |
| `1`–`4` | Add a chip |
| `Backspace` | Clear the bet |
| `M` | Mute |
| `G` | Go to Claude (while Claude needs you) |

`Space` also takes the free rebuy when the bankroll is below the minimum bet. A key pressed during an animation fast-forwards it.

**Never lose a bet:** if the panel closes in the middle of a hand, the round is saved and resumes next time. The webview reports `handInProgress` to the extension, so the controller knows when it may close the table (§5.8).

### 7.4 Tech

- **Webview app:** a `webview/` app in TypeScript, no framework.
  - The engine is synchronous and returns a list of events (`cardDealt`, `holeCardRevealed`, `payout`…).
  - The UI plays those events as an **animation timeline**, so logic and animation can't get out of sync.
- **Message protocol:** typed and versioned, defined in `shared/protocol.ts` and used by both bundles.
  - Extension → webview: `init`, `status`, `claudeDone`.
  - Webview → extension: `ready`, `save`, `handState`, `goToClaude`, `close`.
- **Loading and CSP:**
  - load the bundled JS and CSS through `asWebviewUri`;
  - limit `localResourceRoots` to `dist/webview` and `media`;
  - CSP `default-src 'none'`, scripts allowed by nonce, styles, images and fonts only from `cspSource`.
- **No payload text in the webview.** It only ever receives status values and numbers.
- **Browser dev harness:** `npm run dev:game` serves the game in a normal browser with a mock `acquireVsCodeApi` and a debug bar that fakes Claude states. Use it to iterate on the visuals.

### 7.5 Accessibility and persistence

**Accessibility**
- Every action works from the keyboard, with a visible focus ring.
- An `aria-live` region announces what happens ("Dealer shows 10. You have 16.").
- Cards have accessible names ("Queen of hearts").
- Contrast meets AA, and color is never the only cue.

**Persistence**
- The bankroll, stats, options and any saved round are sent to the extension and stored in its `globalState`.
- `setState` covers quick hide and show of the panel.

---

## 8. Project structure and tooling

```
devjack/
├─ package.json            manifest (see §10.2)
├─ esbuild.mjs             builds dist/extension.js (node, cjs, external vscode) + dist/webview/* (browser)
├─ tsconfig*.json          strict
├─ src/                    extension host
│  ├─ extension.ts         wiring only (commands)
│  ├─ devjack.ts           one window's runtime: inbox → router → tracker → table, registry, connection
│  ├─ claude/              settingsEditor.ts · hookCommand.ts · inbox.ts · router.ts · sessionTracker.ts · registry.ts · transcript.ts · connection.ts
│  │                       paths.ts · heartbeat.ts · versions.ts · simulate.ts
│  ├─ table/               tableController.ts · tablePanel.ts
│  ├─ util/fsx.ts          atomic writes
│  ├─ statusBar.ts · diagnostics.ts · log.ts
│  └─ uninstall.ts
├─ scripts/                dev-prepare.mjs (F5: build + sandbox folders in .dev/) · screenshots.mjs (`npm run shots`)
├─ shared/protocol.ts      messages extension ⇄ webview
├─ webview/                game: engine/ (pure rules) · ui/ (art, motion, sound) · styles/ · app.ts · main.ts · dev/ (browser harness)
├─ test/                   unit/ · integration/ · fixtures/ (settings.json samples, hook payloads recorded in the spike)
├─ media/                  icon.png (256×256), screenshots, demo.gif
├─ README.md · CHANGELOG.md · LICENSE (MIT)
└─ .github/workflows/      ci.yml · release.yml
```

**Dependencies**
- Runtime: `jsonc-parser`, bundled.
- Dev:
  - `typescript`, `esbuild`, `vitest`, `eslint`;
  - `@types/vscode` (pinned to the `engines` minimum) and `@types/node`;
  - `@vscode/test-cli` and `@vscode/test-electron`;
  - `@vscode/vsce` and `ovsx`.

**Scripts:** `build`, `watch`, `dev:game`, `test`, `test:integration`, `lint`, `package`.

**Dev safety**
- Tests and the default F5 launch config set `DEVJACK_HOME` and `CLAUDE_CONFIG_DIR` to temporary folders, so the real settings are never touched.
- A second launch config, "real Claude config", is for manual end-to-end runs.
- If the dev host window opens this same project folder, the Claude session that is building DevJack will make the table pop up there.

---

## 9. Testing

**Unit tests (vitest)**
- **Engine:** every rule and payout, split and double edge cases, shoe penetration.
- **`settingsEditor`**, with fixture files:
  - missing, empty, with a BOM, with CRLF, indented with tabs;
  - containing user hooks, v1 entries or outdated v2 entries;
  - invalid JSON, or `hooks` that isn't an object: the file must stay untouched;
  - `disableAllHooks` set: must be detected.
- **`hookCommand` quoting:** paths with spaces, apostrophes and `ș`.
- **Router:** path normalization.
- **Tracker**, with sequences built from payloads recorded in the spike:
  - normal turn, permission prompt, question;
  - interrupt (registry `idle`, transcript marker, and the early Esc that only the registry shows), `StopFailure`, `idle_prompt`;
  - a message sent mid-turn (second `start` with the same `prompt_id`);
  - two sessions at once, files arriving out of order;
  - registry missing, or with unknown `status` values (fallback to the transcript).
- **`registry`**, with fixture files: status mapping, `.key` files ignored, a file disappearing.

**Hook command tests in CI**
- Run on ubuntu, macos and windows.
- Execute the generated commands under sh, Git Bash and `powershell.exe`, with sample stdin and with a fresh and a stale heartbeat.
- Check that each run exits 0, prints nothing and creates the expected file.

**Integration tests (`@vscode/test-cli`)**
- Activate with temporary home folders and drop files into the inbox.
- Check that the panel opens after the delay, closes on `done`, and stays closed after the user dismisses it.

**Game**
- Check the visuals in the browser harness at 360, 700 and 1400 px.
- Play with the keyboard only, and with reduced motion turned on.

**Manual end-to-end:** §13.

---

## 10. Publishing

### 10.1 Accounts (once)

**VS Code Marketplace**
1. Create a publisher at marketplace.visualstudio.com/manage.
2. Create an Azure DevOps Personal Access Token with the scope **Marketplace → Manage** and the organization set to "All accessible organizations".
3. Run `npx @vscode/vsce login <publisher>`.

**Open VSX** (used by Cursor, Windsurf and VSCodium)
1. Create an Eclipse Foundation account.
2. Sign the publisher agreement and create a token.
3. Run `npx ovsx create-namespace <publisher>`.

Re-check both sites' current steps when you get to this phase; they change.

### 10.2 Manifest checklist (`package.json`)

- **Listing fields:**
  - `name` (check that it's free), `displayName`, `description`, `version`, `publisher` (your real publisher id);
  - `license`, `repository`, `bugs`, `homepage`;
  - `icon` (PNG; SVG isn't accepted), `galleryBanner`, `categories` (e.g. `Other`), `keywords`, `pricing: "Free"`.
- **`engines.vscode`:** the lowest version whose APIs you use. If you use the shell-integration events, that is at least 1.93; feature-detect them.
- **Activation:** `activationEvents: ["onStartupFinished"]` and `main: "./dist/extension.js"`.
- **Where it runs:**
  - `extensionKind: ["workspace"]`, so DevJack runs on the same side as Claude (WSL, SSH, containers);
  - `capabilities.untrustedWorkspaces.supported: true`, since DevJack never runs workspace code.
- **Contributions:** `scripts.vscode:uninstall`, `contributes.commands` and `contributes.configuration`.
- **No** `private: true`.
- **Package contents:** ship only `dist/`, `media/`, README, CHANGELOG, LICENSE and `package.json`. Use a `files` allowlist and check the result with `npx @vscode/vsce ls`.

### 10.3 Listing and legal

**README, in this order**
1. Demo GIF.
2. "How it works", in 3 lines.
3. **What DevJack changes on your machine:** hooks in `~/.claude/settings.json` and the `~/.devjack` folder.
4. **Privacy:** no network access, no telemetry. Hook data is read locally and deleted within seconds.
5. Commands and settings.
6. Troubleshooting.
7. Uninstall, including how to remove the hooks by hand.
8. Disclaimer.

Images in the README must be https URLs or repository-relative paths.

**Name and brand**
- Don't put "Claude" in the extension name, and use no Anthropic logos. Describe it as "works with Claude Code".
- Disclaimer: *"Not affiliated with or endorsed by Anthropic."* and *"Play money only. No real gambling."*

### 10.4 Releases

- **Version numbers:** pre-releases use odd minor versions with `vsce publish --pre-release` (0.1.x). Stable releases use even minor versions (0.2.x).
- **CI:** build, lint and test on all 3 OSes, and attach the packaged VSIX as an artifact.
- **Release workflow:** pushing a `v*` tag publishes the same VSIX to both stores, using the `VSCE_PAT` and `OVSX_PAT` secrets.
- **After every release:** install from the Marketplace in a clean Windows Sandbox and run §13 items 1–3.

---

## 11. Phases

- [ ] **Phase 0: clean slate** (2026-11-19; the publisher id is deferred to Phase 6 by decision)
  - [x] Remove v1's hooks from `~/.claude/settings.json`: the 5 entries whose command contains `devjack-hook.cjs`, under `Stop`, `UserPromptSubmit`, `PostToolUse`, `Notification` and `SessionEnd`. *Already gone when Phase 0 started (an earlier session removed them). Verified: the only hook left is the user's own `ntfy.sh` `Stop` hook.*
  - [x] Delete `~/.devjack`. Look at `settings.json.devjack-backup`, then delete or rename it. Never restore it: it is stale. *`~/.devjack` was already absent. The backup (Nov 18, older permissions, no DevJack hooks) was renamed to `settings.json.devjack-v1-backup-STALE`.*
  - [x] Run `git init`, add a `.gitignore` and create a GitHub repo. The Marketplace links and CI need it. *Public repo [AvramPaul/VSCode_BlackJack_Exstension](https://github.com/AvramPaul/VSCode_BlackJack_Exstension), pushed 2026-11-20: `main` and `phases-0-3` at the Phase 4 commit.*
  - [ ] Pick the extension name and publisher id. Check the Marketplace and Open VSX for name conflicts. *Name `devjack` / "DevJack" is free on both stores (checked 2026-11-19). Publisher id: decide later; it must exist on both stores before Phase 6.*
- [x] **Phase 1: spike** (§6), 2026-11-19
  - [x] No product code in this phase. *Throwaway tools in `spike/` (gitignored).*
  - [x] Fill in §12, and update §3–§5 if any answer contradicts them. *Updated §3, §4, §5.1–§5.3, §5.5–§5.8, §5.10.*
  - Moved to Phase 5: a clean-machine run (Windows Sandbox isn't enabled here; enabling it needs admin rights and a reboot) and macOS (CI).
- [x] **Phase 2: pipeline**, 2026-11-20
  - [x] Build the settings editor, hook command builder, inbox, router, tracker, transcript watcher, diagnostics and log, and the Simulate command, each with unit tests. *Also the session registry watcher (§5.7), heartbeat, version gate and `uninstall.ts`. 107 vitest tests, using the spike recordings in `test/fixtures/hooks/`, plus real `powershell.exe` / `sh` runs of the generated commands.*
  - [x] Add a placeholder webview that only shows the status, to prove open and close work end to end. *9 integration tests in VS Code 1.94.0 (the `engines` minimum) with temporary `DEVJACK_HOME` and `CLAUDE_CONFIG_DIR`:*
    - *auto-connect;*
    - *the installed hook commands → table open → close;*
    - *routing by `cwd` and by window id, and "not mine";*
    - *dismissal;*
    - *registry `idle`;*
    - *Simulate;*
    - *disconnect;*
    - *opt-in (`DEVJACK_E2E_CLAUDE=1`): real `claude -p` with DevJack's generated settings.*
- [x] **Phase 3: table behavior** (§5.8), 2026-11-20
  - [x] Open delay, close after the hand, focus return, status bar and pause.
    - *`tableController.ts`, with 14 unit tests on fake timers.*
    - *The placeholder table has a **Go to Claude** button (`G`) and the done banners, plus a "pretend a hand is in progress" toggle until the game exists.*
    - *Focus return uses `claudeFocus.ts`: shell integration for terminals, `claude-vscode.focus` for the panel. Still to check by hand with the Claude extension present (§12 row 9).*
  - [x] Integration tests. *5 Phase 3 cases, on top of the Phase 2 suite:*
    - *a quick answer never shows the table;*
    - *the open delay;*
    - *no open while Claude asks right away;*
    - *`immediately`;*
    - *pause.*

    *14 of 14 pass on VS Code 1.94.0 (including real `claude -p`), 13 of 13 on stable 1.147. Test windows must be left alone while they run: clicking their notifications breaks the run.*
- [x] **Phase 4: game** (§7), 2026-11-20
  - [x] Engine and its tests first. *`webview/engine/`: 43 vitest tests, covering every payout and rule, split and double edge cases, shoe penetration, save/resume, and a 3,000-round property test that checks no chips are created or lost.*
  - [x] Then the visuals, in the browser harness.
    - *`npm run dev:game` serves the harness, with a mock `acquireVsCodeApi`, a debug bar and `?scenario=`.*
    - *`npm run shots` takes headless screenshots at 360, 700 and 1400 px; `?keys=` plays keyboard-only rounds, with or without animations.*
    - *All art is original SVG generated in code.*
  - [x] Then wire the game into the panel.
    - *`dist/webview` loaded through `asWebviewUri` under the strict CSP. The integration test checks that the game says `ready`.*
    - *The game is saved to `globalState` after every action, `handState` drives close-after-hand, and the sound setting is pushed live.*
  - *Found and fixed: the timeline waited on animation frames, which can stall in a hidden document. Every animation now has a timer fallback.*
- [x] **Phase 5: hardening**, 2026-11-21 (manual Mac run skipped by decision; CI covers macOS)
  - [x] Run the §13 checks on Windows Sandbox, on macOS and Linux (CI, plus one manual run if possible), on a WSL remote and in Cursor.
    - **Windows Sandbox, 2026-11-20: works as intended** (user's verdict and DevJack's log).
      - *The kit is `.dev/sandbox/devjack.wsb`. Its setup script installs VS Code, Claude Code and the Claude extension; DevJack is installed from the VSIX by hand.*
      - *A clean machine: no Node, no Git, no Git Bash. Claude Code 2.1.329 native, VS Code 1.147.*
      - *Confirmed in the log:*
        - *it auto-connected at activation, with no clicks (`start()` took 3 ms);*
        - *the panel was routed by window id (§13 item 1);*
        - *a session started before DevJack was installed was routed by `cwd` (item 2);*
        - *the table opened 2.5 s after each prompt and closed after the hand;*
        - *the panel's Stop button closed it about 1.4 s later (item 4); an early Stop never opened it;*
        - *a table closed mid-turn stayed closed until the next prompt (item 7).*
      - *Not seen there:*
        - *a real permission prompt (Claude auto-approved, so only Simulate showed "needs you");*
        - *an answer under 2.5 s;*
        - *two windows, an external terminal, uninstall.*
      - *Fixed afterwards:*
        - *focus for a terminal session whose start DevJack never saw now goes to the active terminal;*
        - *the registry no longer warns about a new session's file before it has a status.*
    - **CI, 2026-11-20 (run 44765704425): green on ubuntu, macos and windows** on the first run.
      - *Each OS ran typecheck, lint, build, the 166 unit tests (including the real hook command: PowerShell exec form, BSD sh, dash) and the integration tests in VS Code 1.94.0. This covers the automated part of macOS and Linux.*
      - *The packaged VSIX is attached to the run.*
    - **Cursor, 2026-11-21 (Windows, VSIX installed from file): works** (user's test).
      - *The table opened while Claude was thinking and closed when it was done.*
      - *A real permission prompt showed "Claude needs you", which closes the Sandbox gap for §13 item 3.*
      - *The automatic connect edited the user's real `~/.claude/settings.json` correctly: the user's own `Stop` hook stayed first, a one-time backup was made, and without DevJack's entries the file is identical to the backup.*
    - **WSL remote, 2026-11-21 (Ubuntu, Claude Code 2.1.330 native, DevJack installed on the WSL side): works** (user's test).
      - *Auto-connect wrote the 7 POSIX sh entries into WSL's `~/.claude/settings.json`.*
      - *The table opened and closed for `claude` in the WSL terminal, including "Claude needs you" and Esc.*
      - *The self-test delivered an event in 22 ms (sh), against about 200 ms for PowerShell on Windows.*
    - *A manual run on a Mac: skipped by the user's decision (2026-11-21). CI covers the automated part.*
  - [x] Performance: about zero CPU when idle, and under 50 ms of work at activation. *2026-11-21, production bundle, Windows:*
    - *`activate()` takes **21.2 ms** in VS Code 1.94.0 (DevJack logs it as "activated in … ms").*
    - *Loading the 68 KB bundle takes 12 ms median in a fresh Node process, an upper bound because VS Code already has Node's built-in modules loaded.*
    - *Idle CPU of the whole extension host, measured over 30 s: **0.16 %**, and **0.21 %** with the table open.*
    - *DevJack's own idle polling (inbox and registry every second, heartbeat every 30 s): **0.023 %** of one core.*
    - *Table idle (headless Chrome, 10 s): **no** timer or animation-frame callbacks and no running animations. While Claude works, the elapsed time ticks once a second; while Claude waits, the amber pulse runs. Both are by design.*
    - *How to rerun: `npm run perf`, and `DEVJACK_PERF=1 npm run test:integration` for the in-VS Code part.*
- [ ] **Phase 6: publish** (§10)
  - [ ] Icon, screenshots, GIF, README, CHANGELOG, CI.
  - [ ] A pre-release first, then a stable release.

---

## 12. Spike results (fill in during Phase 1)

Run on 2026-11-19 with Claude Code 2.1.328 on Windows 11. The interactive CLI was driven through a ConPTY (`spike/tools/drive.cjs`). The panel was observed through this workspace's own panel sessions, with temporary project hooks. Timings are from hook logs and `~/.claude/sessions/` sampled every 100–200 ms.

| # | Question | Answer | Design change? |
|---|---|---|---|
| 1 | Panel events and `cwd` | Yes. Observed in the panel: `SessionStart` (fires when a **tab opens**, before any prompt), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure` (`authentication_failed`) and `SessionEnd`. The extension also starts throwaway sessions (`SessionStart` then `SessionEnd` reason `other` within 0.6 s, no turn). Hooks added mid-session were picked up. `cwd` is the session's **current** directory: the workspace root at `SessionStart`, but it follows `cd` (one session reported `…\vs_extension\spike`). The panel sends a lowercase `c:`, the CLI an uppercase `C:`. Payloads also carry `scratchpad_dir` and `effort`, and `SessionStart` carries `model`. | §5.5: route by the start directory (first event, or the registry), normalize the drive letter. §3: `prompt_id` and `permission_mode` aren't on every event. |
| 2 | `PermissionRequest` / `Notification` timing | `PermissionRequest` fires 0.07–0.2 s after `PreToolUse`, in the CLI and in the panel (despite `--permission-prompt-tool=stdio`). `Notification(permission_prompt)` follows **6.0 s** later in both. The interactive CLI started in `auto` permission mode here, so many tool calls never prompt at all. | §5.1: `Notification` is only a backup. |
| 3 | Interrupt marker (CLI Esc, panel Stop button), `idle_prompt` afterwards | Markers: Esc mid-stream and the panel's Stop button write `[Request interrupted by user]`. Esc during a tool, or at a permission or plan dialog, writes `[Request interrupted by user for tool use]`. **An Esc before any output leaves no trace** (no hook, no transcript entry, the prompt goes back to the input box). `idle_prompt` **never** followed an interrupt (CLI with the terminal unfocused, and the panel, each waited 70–80 s). After a normal `Stop`, it came at +60 s only when the CLI terminal was unfocused. The panel never sent it (3 idle hours after a `Stop`). The **session registry** `~/.claude/sessions/<pid>.json` changed `status` to `idle` within 0.1–0.2 s in every case, including the early Esc and the panel's Stop button (+80 ms). | §5.7: the session registry becomes the first interrupt source, with the transcript marker as the fallback. §5.6: registry transitions. |
| 4 | Panel inherits `process.env` | **Yes.** In static code, the Claude extension spawns the CLI with `{...process.env}` and then applies `claudeCode.environmentVariables`. At runtime, `VSCODE_DOTNET_INSTALL_TOOL_ORIGINAL_HOME`, which the .NET Install Tool extension sets on `process.env`, is present in the panel CLI's environment. The copy is taken when a tab opens. | §5.5: tabs opened before DevJack activated are routed by `cwd`. §5.3: `CLAUDE_CONFIG_DIR` can differ for the panel. |
| 5 | Windows command (Git Bash, PowerShell, stdin, UTF-8, paths, window flash, latency) | All three forms work with real Claude Code: shell form under Git Bash, shell form under `"shell": "powershell"`, and exec form (`args`). stdin reaches the nested `powershell.exe`. A `cwd` with `ș`, a space and an apostrophe, and a payload with emoji, quotes and backslashes, arrive byte-identical. A home path `Ana Ștefan's home` works. A stale or missing heartbeat writes nothing. No console window (`GetConsoleWindow()` = 0 for panel hooks). Latency per event: exec form **0.18–0.25 s** (about 0.7 s cold), Git Bash 0.22–0.27 s (one 1.1 s), PowerShell shell 0.45–0.62 s. Cmdlets wrote a CLIXML progress record to stderr on every run; the .NET-only script doesn't. Not tested: a clean machine (Windows Sandbox isn't enabled). | §5.2: Windows uses **exec form** with a .NET-only script, minimum Claude Code 2.1.139, marker inside the encoded script. |
| 6 | sh command | Works under Ubuntu's `/bin/sh` (dash), bash and Git Bash sh. It is silent, exits 0, and the payload is byte-identical. Heartbeat window: 90 s old → writes, 150 s old → skips. macOS not tested (CI in Phase 5). | None. |
| 7 | `prompt_id` semantics | The same on every event of a turn, including `Notification`, `Stop` and `SessionEnd` (the last turn's). New for each turn, also after an interrupt. Missing on `SessionStart`. A message sent while Claude is working fires `UserPromptSubmit` **immediately with the same `prompt_id`**, and one `Stop` ends both. | §5.6: a `start` with the current `prompt_id` is a no-op. Stale `waiting` is ignored by `prompt_id`. |
| 8 | `AskUserQuestion` / `ExitPlanMode` events | Both fire `PreToolUse`, then **`PermissionRequest`** (`tool_name` `AskUserQuestion` / `ExitPlanMode`), then `Notification(permission_prompt)` at +6 s ("needs your approval for the plan"). No `elicitation_dialog`. Registry `waitingFor`: `input needed` (question) and `permission prompt` (plan). Rejecting a plan with Esc is an interrupt (marker, no `Stop`). Same in the panel for `AskUserQuestion`. | §5.1: drop `PreToolUse(AskUserQuestion)`. |
| 9 | Claude panel focus command id | `claude-vscode.focus` ("Focus input"; inserts the active editor's selection as an @-mention if there is one). Also `claude-vscode.sidebar.open`, `claude-vscode.editor.openLast`, `claude-vscode.focusLastMessage` and `claude-vscode.terminal.open`. Taken from the Claude extension's manifest and code. Implemented in Phase 3 (`claudeFocus.ts`), but not yet checked by hand in a window that has the Claude extension. | §5.8: use `claude-vscode.focus`. Manual check pending. |
| 10 | Hook error notice vs. silent exit | A hook that exits 1 shows "UserPromptSubmit hook failed: `<stderr>`" in the TUI. The DevJack command with a stale heartbeat exits 0 with no notice and creates no files. Docs and changelog: since 2.1.299, a failing **shell-form** `PreToolUse`/`PermissionRequest` hook on Windows without Git Bash blocks the tool call. | §5.2: exec form on Windows. |

---

## 13. Definition of done

All of these must pass:

1. **Clean machine, panel:** in a clean Windows Sandbox (no Node, no Git Bash, Claude Code installed natively), install DevJack from a VSIX, open a folder, open the Claude panel and send a task. The table opens within about 3 s and closes when Claude finishes (after the current hand).
2. **Old terminal:** the same, with `claude` running in an integrated terminal **that was opened before DevJack was installed**.
3. **Permission prompt:** the table shows "Claude needs you" within about 1 s. **Go to Claude** moves focus there, and after approval the status goes back to working.
4. **Interrupt:** after Esc in the CLI or Stop in the panel, the table closes within about 2 s.
5. **Quick answer:** for a question Claude answers in under 2 s, the table never appears.
6. **Two windows** with different folders: the table appears only in the window where Claude is working.
7. **Dismiss:** if the user closes the table in the middle of a turn, it stays closed until the next prompt.
8. **VS Code closed**, `claude` running in an external terminal: no hook errors, and nothing is written to `~/.devjack/inbox`.
9. **Uninstall** and restart VS Code: no DevJack entries remain in `settings.json`, and Claude shows no hook errors.
10. **Blocked:** with an invalid `settings.json` or with `disableAllHooks`, DevJack changes nothing, and **Check Claude Connection** explains why.
11. **Unusual home path:** with a space and non-ASCII characters (e.g. a Sandbox user named `Ana Ștefan`), everything above still works.
12. **Other platforms:** items 1–4 work on macOS or Linux, on a WSL remote and in Cursor (installed from Open VSX).
13. **Game:** all engine tests pass, it looks right at 360 px and at 1400 px, it is playable with the keyboard only, reduced motion works, and it uses about zero CPU when idle.
