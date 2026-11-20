/**
 * `vscode:uninstall` (plan §5.3): VS Code runs this with its own Node, at the restart after an uninstall.
 * No vscode API. Removes our hook entries first, then deletes ~/.devjack. If it never runs, leftovers are
 * harmless: the hook exits at once without a fresh heartbeat.
 */
import * as fs from 'fs';
import { applyToSettings, readState } from './claude/connection';
import { claudeConfigDir, devjackHome } from './claude/paths';

function main() {
  const home = devjackHome();
  const dirs = new Set([claudeConfigDir(), ...readState(home).connected]);
  for (const dir of dirs) {
    try {
      applyToSettings(dir, null);
    } catch {
      /* keep going: never leave the user's other config dirs untouched because one failed */
    }
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

main();
