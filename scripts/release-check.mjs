// Release gate (plan §10.4), run by .github/workflows/release.yml: node scripts/release-check.mjs v0.1.0
// - the tag must equal package.json's version, and the publisher must be the real one;
// - odd minor = pre-release (0.1.x), even minor = stable (0.2.x);
// - CHANGELOG.md must have a section for the version (it becomes the GitHub Release notes).
// Writes version/pre/flag to $GITHUB_OUTPUT and the notes to release-notes.md.
import * as fs from 'fs';

const tag = process.argv[2] ?? '';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const fail = (msg) => {
  console.error(`release check failed: ${msg}`);
  process.exit(1);
};

const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
if (!m) fail(`tag "${tag}" is not vMAJOR.MINOR.PATCH`);
if (`v${pkg.version}` !== tag) fail(`tag ${tag} does not match package.json version ${pkg.version}`);
if (!pkg.publisher || pkg.publisher === 'todo-publisher') fail('package.json "publisher" is still the placeholder');

const pre = Number(m[2]) % 2 === 1;
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const section = new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
if (!section) fail(`CHANGELOG.md has no "## ${pkg.version}" section`);
fs.writeFileSync('release-notes.md', section[1].trim() + '\n');

const out = process.env.GITHUB_OUTPUT;
const lines = [`version=${pkg.version}`, `pre=${pre}`, `flag=${pre ? '--pre-release' : ''}`];
if (out) fs.appendFileSync(out, lines.join('\n') + '\n');
console.log(`release ${pkg.publisher}.${pkg.name} ${pkg.version} (${pre ? 'pre-release' : 'stable'})`);
