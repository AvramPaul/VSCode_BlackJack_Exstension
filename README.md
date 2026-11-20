# DevJack

A Blackjack table that opens beside the editor while Claude Code works on a prompt, and closes when Claude is done. Works with the Claude Code VS Code extension and with `claude` in the integrated terminal.

> Pre-release. Not affiliated with or endorsed by Anthropic. Play money only. No real gambling.

## How it works

1. On first start, DevJack adds a few small hooks to your Claude Code user settings (`~/.claude/settings.json`).
2. When Claude starts working, the hooks drop a note in `~/.devjack/inbox`; DevJack opens the table after a couple of seconds.
3. When Claude finishes, is interrupted or needs you, the table says so, and closes after your current hand.

## What DevJack changes on your machine

- **`~/.claude/settings.json`**: one hook entry per event (`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`). Your own hooks and settings are kept; a one-time backup is saved as `settings.json.devjack-backup`. The hooks do nothing unless a VS Code window with DevJack is running.
- **`~/.devjack/`**: the inbox and a heartbeat file.

**DevJack: Disconnect from Claude Code** removes the hooks. Uninstalling DevJack removes them too, at the next VS Code restart.

## Privacy

No network access and no telemetry. Hook notes are read locally and deleted within seconds; their content (prompts, tool input) is never logged and never shown in the table.

## Commands

- **DevJack: Open Blackjack Table** (free play)
- **DevJack: Simulate Claude Run**
- **DevJack: Check Claude Connection**
- **DevJack: Connect to Claude Code** / **Disconnect from Claude Code**
- **DevJack: Pause Auto-Open** / **Resume Auto-Open**
- **DevJack: Show Log**

## Keys

`Space` deal · `H` hit · `S` stand · `D` double · `P` split · `I` / `N` insurance · `1`–`4` chips · `Backspace` clear bet · `M` mute · `G` go to Claude
