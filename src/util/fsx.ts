import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export const exists = (p: string) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

export type WriteOutcome = 'written' | 'conflict';

/**
 * Write `text` to `file` atomically: temp file in the same folder, then rename.
 * With `expected`, the target is re-read right before the rename; if it no longer equals `expected`
 * (someone else wrote it, e.g. Claude Code), nothing is written and 'conflict' is returned.
 * If the rename fails (Windows: file locked by a reader), fall back to a direct write.
 */
export function writeFileAtomic(file: string, text: string, expected?: { text: string | undefined }): WriteOutcome {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.devjack-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (expected && readTextIfExists(file) !== expected.text) return 'conflict';
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      fs.writeFileSync(file, text, 'utf8');
    }
    return 'written';
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* already renamed */
    }
  }
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
