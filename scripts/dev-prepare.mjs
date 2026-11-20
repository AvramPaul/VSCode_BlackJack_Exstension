// F5 pre-launch: build, and create the sandbox folders used by the default launch config.
// DevJack never creates a Claude config folder itself, so the sandboxed one must exist up front.
import { execFileSync } from 'child_process';
import * as fs from 'fs';

for (const d of ['.dev/devjack-home', '.dev/claude', '.dev/workspace']) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync('.dev/claude/settings.json')) fs.writeFileSync('.dev/claude/settings.json', '{\n  "model": "opus"\n}\n');
execFileSync(process.execPath, ['esbuild.mjs'], { stdio: 'inherit' });
